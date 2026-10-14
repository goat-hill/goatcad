<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, toRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import * as THREE from 'three'
import {
  ViewportEngine,
  type GridSettings,
  STANDARD_GRID_APPEARANCE
} from '../../lib/engine/ViewportEngine'
import {
  SchematicScene,
  applySchematicTheme,
  PIN_CONNECTION_RADIUS,
  LIFT_SPLIT_Z
} from '../../lib/engine/SchematicScene'
import { bezierCurvePoints, shownFieldText } from '../../lib/kicad/schematic'
import type {
  KicadSchematic,
  KicadLibSymbol,
  SchematicProperty,
  SymbolGraphic,
  SymbolPin
} from '../../lib/kicad/schematic'
import { symbolFieldTextAngle } from '../../lib/engine/schematicTextOrientation'
import { symbolPreviewPartKey } from '../../lib/kicad/symbolLibrary'
// `textBoxCorners` is the glyph box of ANY string (the plain-text hit-test);
// `textBoxLayout` is the `(text_box …)` primitive. Similar names, different
// things — the former predates the latter.
import { strokeOptionsFromTextEffects, textBoxCorners } from '../../lib/kicad/newstroke'
import { textBoxLayout } from '../../lib/schematic/textBox'
import { mmToNm, nm, nmToMm, spacingToMm, type Nm } from '../../lib/kicad/coordinates'
import { roleAnchors, roleGrid, type MoveRole } from '../../lib/moveAnchors'
import { measureViewportInsets } from '../../lib/engine/viewportInsets'
import { findingMarkersLayer, type DocumentMarker } from '../../lib/engine/findingMarkersLayer'
import { MARKER_UNIT_MM } from '../../lib/engine/FindingMarkers'
import type { SymbolTool, ToolDefaults } from '../../lib/symbolTools'
import type { ViewCommand } from '../../lib/viewCommands'
import {
  DEFAULT_ORIENTATION,
  setTypedGraphicVertex,
  toolItems,
  type Point2,
  type ToolOrientation
} from '../../lib/symbolTools'
// Extent rules live with the edit helpers, so the selection rectangle and the
// transform pivot can never disagree about how far a primitive reaches.
import {
  addressKey,
  graphicAnchorPoint,
  graphicExtentPoints,
  graphicVertexPoints,
  isFieldOnCanvas,
  pinExtentPoints,
  sameAddress,
  symbolPartGraphic,
  type SymbolPartAddress
} from '../../lib/symbol/symbolEdit'
import { soleSelection, VertexHandles, type VertexHandleSpec } from '../../lib/engine/VertexHandles'
import { graphicHandleSpecs } from '../../lib/symbol/graphicEdit'
import { distanceToArc } from '../../lib/engine/arcGeometry'
import { distanceToSegment } from '../../lib/geometry/distance'
import { loadCamera, retargetCameras, saveCamera } from '../../lib/engine/cameraStore'
import { useSelectionFilter } from '../../lib/selectionFilter'
import { symbolViewState } from '../../lib/symbolView'
import { useAppTheme } from '../../lib/theme'
import SelectionFilterControl from '../shared/SelectionFilterControl.vue'
import GridSettingsControl from '../shared/GridSettingsControl.vue'
import ViewportStatusBar, { type StatusCoords } from '../shared/ViewportStatusBar.vue'
import { symbolItemLabel } from '../../lib/symbol/symbolItemLabel'
import { resolveHit, type HitCandidate } from '../../lib/selectionResolve'
import { useCanvasSelection, type BoxBounds } from '../../lib/canvasSelection'
import { partInBand } from '../../lib/symbol/partBand'
import SelectOtherMenu from '../shared/SelectOtherMenu.vue'
import {
  registerTestProvider,
  type TestElement,
  type TestElementQuery,
  type TestProvider
} from '../../lib/testHooks'

const props = defineProps<{
  /** Single-symbol preview document rendered by SchematicScene. */
  schematic: KicadSchematic | null
  /** The selected symbol's typed view — the hit-test/selection geometry source. */
  symbol: KicadLibSymbol | null
  selectedItems: SymbolPartAddress[]
  readOnly?: boolean
  /** Grid config from the editor; defaults to KiCad's 1.27 mm (50 mil) symbol grid. */
  gridSettings?: GridSettings
  /** Half of the camera-cache key — see cameraStore. */
  filePath?: string | null
  /** Which gate of a multi-unit package is on screen; unit 0 renders with it. */
  renderedUnit?: number
  /** Which body style is on screen; style 0 (common to all styles) renders with it. */
  renderedBodyStyle?: number
  /** Armed insert tool; 'select' is the ordinary pick/drag mode. */
  activeTool?: SymbolTool
  /** How the pending item is turned — rotate/mirror before committing. */
  toolOrientation?: ToolOrientation
  /**
   * Points the armed tool has already collected — a rectangle's first corner, a
   * polyline's vertices so far. The preview is built from these plus the cursor.
   */
  toolDraft?: Point2[]
  /**
   * The armed tool's non-geometric settings, edited in the properties panel.
   * The ghost has to honor them or the preview stops being the thing that lands
   * — a rectangle previewed hairline and committed dashed is the same class of
   * lie this module exists to prevent.
   */
  toolDefaults?: ToolDefaults
  /** The checks' findings to mark on the canvas, library mm, y up. */
  findingMarkers?: readonly DocumentMarker[]
}>()

const DEFAULT_SYMBOL_GRID: GridSettings = { spacing: 50, unit: 'mil', visible: true, snap: true }

const emit = defineEmits<{
  (e: 'update:selectedItems', items: SymbolPartAddress[]): void
  /** A finding's canvas marker was clicked, by its finding's key. */
  (e: 'finding-marker', key: string): void
  /** Cumulative drag offset in domain nanometers. */
  (e: 'drag-move', delta: { x: number; y: number }): void
  (e: 'drag-end'): void
  /** A vertex handle was grabbed — the editor resizes rather than moves. */
  (e: 'vertex-drag-start', info: { address: SymbolPartAddress; vertexIndex: number }): void
  /**
   * Right-click on the canvas. `hit` is whatever sits under the cursor, so the
   * editor can select it before opening the menu — acting on something you did
   * not select is the classic context-menu footgun.
   */
  (
    e: 'context-menu',
    payload: { clientX: number; clientY: number; hit: SymbolPartAddress | null }
  ): void
  /** Armed tool clicked at a grid-snapped point in symbol space. */
  (e: 'tool-click', point: { x: Nm; y: Nm }): void
  /** Right-click or Esc equivalent while a tool is armed. */
  (e: 'tool-cancel'): void
  /**
   * The grid-snapped cursor, so the properties panel can report where an armed
   * tool's item would actually land instead of a placeholder. Snapped rather
   * than raw, so it fires once per grid cell crossed rather than per pixel.
   */
  (e: 'cursor-move', point: { x: Nm; y: Nm }): void
  (e: 'update-grid', settings: Partial<GridSettings>): void
}>()

const { t } = useI18n()

const container = ref<HTMLDivElement | null>(null)
/**
 * Where the pointer last was, in symbol space (y-up, the file's own orientation). Seeded at the
 * origin rather than left empty so the readout is present from the first frame:
 * a pill that materializes on the first mouse move reads as the panel changing
 * shape, and 0,0 is the honest answer before the pointer has been anywhere.
 */
const cursor = ref({ x: 0, y: 0 })
const statusCoords = computed<StatusCoords>(() => {
  const grid = props.gridSettings ?? DEFAULT_SYMBOL_GRID
  return { ...cursor.value, unit: grid.unit, spacing: grid.snap ? grid.spacing : undefined }
})
/** Last SNAPPED point reported upward — see the `cursor-move` emit. */
let lastSnapped = { x: NaN, y: NaN }
/** A key gesture must not act on a stale point from before the mouse left. */
let pointerInside = false
const onContainerMouseEnter = (): void => {
  pointerInside = true
}
const onContainerMouseLeave = (): void => {
  pointerInside = false
}
/** The snapped cursor as a tool click reports it (domain nanometers), or null
 *  when the pointer is not over the canvas. */
const getCursor = (): { x: Nm; y: Nm } | null =>
  pointerInside && Number.isFinite(lastSnapped.x)
    ? { x: mmToNm(lastSnapped.x), y: mmToNm(lastSnapped.y) }
    : null

let engine: ViewportEngine | null = null
let scene: SchematicScene | null = null
/** Drag handles on the selected graphic; parented to the engine's scene on mount. */
let vertexHandles: VertexHandles | null = null

// mm; a small symbol frames inside this rather than filling the screen.
const FIT_MIN_EXTENT = 25

// A symbol placed at the origin (angle 0, no mirror) maps symbol space to engine
// space by identity — see SchematicScene.transformLocal — so hit-test geometry is
// simply the symbol's own pin/graphic coordinates and world clicks compare directly.
interface HitElement {
  address: SymbolPartAddress
  /** `addressKey` — what the engine and the scene call this part. */
  key: string
  /** `(hide yes)`: drawn gray, and beaten to a click by anything visible. */
  hidden?: boolean
  /** Where a move can grab it (KiCad's `computeAnchors`), and what kind of part that makes it. */
  anchors: Array<{ x: number; y: number }>
  role: MoveRole
  bounds: { minX: number; minY: number; maxX: number; maxY: number }
  distance: (p: THREE.Vector2) => number
}

/** Scene keys for the current selection, in selection order. */
const selectionKeys = (): string[] => props.selectedItems.map(symbolPreviewPartKey)

const distToSegment = (p: THREE.Vector2, ax: number, ay: number, bx: number, by: number): number =>
  distanceToSegment(p, { x: ax, y: ay }, { x: bx, y: by })

/**
 * Distance to a convex quad, **zero inside it**. Used only for text, and that is
 * the difference from every other primitive here: an unfilled rectangle is
 * grabbed by its outline (KiCad's rule, and what its four edge distances give),
 * while a text is grabbed anywhere over its glyphs.
 *
 * Convexity lets the inside test be a sign check on the four edge cross-products,
 * with no winding assumption — `textBoxCorners` returns them in order, but which
 * way round depends on the text's rotation.
 */
const distanceToQuad = (p: THREE.Vector2, corners: Array<{ x: number; y: number }>): number => {
  let positive = 0
  let negative = 0
  for (let i = 0; i < corners.length; i++) {
    const a = corners[i]
    const b = corners[(i + 1) % corners.length]
    const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)
    if (cross > 0) positive++
    else if (cross < 0) negative++
  }
  // Strictly one sign means inside. Testing it this way rather than
  // `positive === 0 || negative === 0` matters for a DEGENERATE quad — an empty
  // string lays out zero-width — where every cross product is 0 and that spelling
  // would report "inside" for every point on the canvas.
  if (positive > 0 !== negative > 0) return 0
  return Math.min(
    ...corners.map((a, i) => {
      const b = corners[(i + 1) % corners.length]
      return distToSegment(p, a.x, a.y, b.x, b.y)
    })
  )
}

const boundsOfPoints = (pts: Array<{ x: number; y: number }>): HitElement['bounds'] => ({
  minX: Math.min(...pts.map((p) => p.x)),
  minY: Math.min(...pts.map((p) => p.y)),
  maxX: Math.max(...pts.map((p) => p.x)),
  maxY: Math.max(...pts.map((p) => p.y))
})

const pinElement = (pin: SymbolPin, address: SymbolPartAddress): HitElement => {
  const a = (pin.position.angle * Math.PI) / 180
  const end = {
    x: pin.position.x + Math.cos(a) * pin.length,
    y: pin.position.y + Math.sin(a) * pin.length
  }
  return {
    address,
    key: addressKey(address),
    hidden: pin.hidden,
    anchors: [pin.position],
    role: 'connectable',
    bounds: boundsOfPoints(pinExtentPoints(pin)),
    // The connection ring the symbol editor draws at the pin's origin is part
    // of what the pin looks like, so a click anywhere on or inside it selects
    // the pin. Also what makes a zero-length pin (ecc83-pp's GND) clickable
    // at all: its line is a single point.
    distance: (p) =>
      Math.min(
        distToSegment(p, pin.position.x, pin.position.y, end.x, end.y),
        Math.max(
          0,
          Math.hypot(p.x - pin.position.x, p.y - pin.position.y) - mmToNm(PIN_CONNECTION_RADIUS)
        )
      )
  }
}

const graphicElement = (graphic: SymbolGraphic, address: SymbolPartAddress): HitElement | null => {
  const key = addressKey(address)
  switch (graphic.type) {
    case 'rectangle': {
      const corners = [
        { x: graphic.start.x, y: graphic.start.y },
        { x: graphic.end.x, y: graphic.start.y },
        { x: graphic.end.x, y: graphic.end.y },
        { x: graphic.start.x, y: graphic.end.y }
      ]
      return {
        address,
        key,
        anchors: [],
        role: 'graphic',
        bounds: boundsOfPoints(graphicExtentPoints(graphic)),
        distance: (p) =>
          Math.min(
            ...corners.map((c, i) => {
              const n = corners[(i + 1) % corners.length]
              return distToSegment(p, c.x, c.y, n.x, n.y)
            })
          )
      }
    }
    case 'line':
    case 'bezier': {
      if (graphic.points.length === 0) return null
      // A bezier is hit against the CURVE, not against its control polygon: a
      // control point can sit well off the curve, so the two are different
      // shapes. Same flattener the renderer draws with, so what you click is
      // what you see. Bounds stay the control points, which enclose the curve.
      const path = graphic.type === 'bezier' ? bezierCurvePoints(graphic.points) : graphic.points
      return {
        address,
        key,
        anchors: [],
        role: 'graphic',
        bounds: boundsOfPoints(graphicExtentPoints(graphic)),
        distance: (p) =>
          Math.min(
            ...path.slice(1).map((pt, i) => distToSegment(p, path[i].x, path[i].y, pt.x, pt.y))
          )
      }
    }
    case 'circle':
      return {
        address,
        key,
        anchors: [],
        role: 'graphic',
        bounds: boundsOfPoints(graphicExtentPoints(graphic)),
        distance: (p) =>
          Math.abs(Math.hypot(p.x - graphic.center.x, p.y - graphic.center.y) - graphic.radius)
      }
    case 'arc':
      return {
        address,
        key,
        anchors: [],
        role: 'graphic',
        bounds: boundsOfPoints(graphicExtentPoints(graphic)),
        // Measured to the CURVE. Its two chords are a different shape — they cut
        // inside the drawing by up to 0.29r — which is the bezier's lesson
        // applied to the other primitive that bends.
        distance: (p) => distanceToArc(p, graphic.start, graphic.mid, graphic.end)
      }
    case 'text': {
      // Not drawn means not selectable — the slice-2a rule that nothing invisible
      // can be picked. Deliberately the same condition `addStrokeText` skips on,
      // so the two cannot disagree about whether a text is on screen.
      if (!graphic.text || graphic.effects.hidden) return null
      // Hit anywhere over the GLYPHS. Measuring to the anchor made a text
      // effectively unclickable: the engine's tolerance is 10 screen pixels, so
      // you had to land within a fraction of a millimeter of its center, and
      // clicking the letters themselves missed. Box select still worked, since
      // that sweeps an area — which is exactly the asymmetry that gave it away.
      const corners = textBoxCorners(
        graphic.text,
        graphic.effects,
        graphic.position,
        graphic.position.angle
      )
      return {
        address,
        key,
        anchors: [graphic.position],
        role: 'text',
        bounds: boundsOfPoints(corners),
        distance: (p) => distanceToQuad(p, corners)
      }
    }
    case 'textBox': {
      // Hit on the BORDER, from the same `textBoxLayout` the renderer strokes —
      // so what you click is what you see, the rule the bezier case established.
      // Unlike a plain text this stays pickable when the string is empty: the
      // box is still drawn, and an empty box you cannot select would be a box
      // you cannot delete.
      const layout = textBoxLayout(
        graphic,
        graphic.text,
        strokeOptionsFromTextEffects(graphic.effects)
      )
      const corners = layout.corners
      return {
        address,
        key,
        anchors: [corners[0], corners[2]],
        role: 'text',
        bounds: boundsOfPoints(corners),
        // Anywhere inside counts, not just the outline: a box is a region, and
        // requiring the user to find its 0.25 mm edge would make a body-sized
        // annotation box the hardest thing on the canvas to select.
        distance: (p) => distanceToQuad(p, corners)
      }
    }
  }
}

/**
 * A field's hit geometry: its glyph box, measured off the string the scene
 * actually draws (`shownFieldText`). `isFieldOnCanvas` mirrors what the scene
 * skips, so nothing invisible is pickable — but a HIDDEN field stays
 * selectable, since it still draws here and must be unhide-able.
 */
const fieldElement = (
  property: SchematicProperty,
  address: SymbolPartAddress
): HitElement | null => {
  if (!isFieldOnCanvas(property)) return null
  const text = shownFieldText(property)
  const corners = textBoxCorners(
    text,
    property.effects,
    property.position,
    // The drawn angle, not the stored one — `symbolFieldTextAngle` flips a
    // field past ±90° so it stays readable, and the box has to turn with it.
    symbolFieldTextAngle(property.position.angle)
  )
  return {
    address,
    key: addressKey(address),
    hidden: property.hidden,
    anchors: [property.position],
    role: 'text',
    bounds: boundsOfPoints(corners),
    distance: (p) => distanceToQuad(p, corners)
  }
}

/**
 * `resolveSymbolGeometry` draws the selected unit and body style, plus the
 * unit-0 / style-0 common parts. Anything else — another gate, another body
 * style — is not on screen, so it must not be selectable either; picking an
 * invisible pin and dragging it was the multi-unit ghost-item bug. Switching
 * either selector re-renders and re-scopes what can be picked.
 */
const isRendered = (part: { unit: number; style: number }): boolean =>
  (part.unit === 0 || part.unit === (props.renderedUnit ?? 1)) &&
  (part.style === 0 || part.style === (props.renderedBodyStyle ?? 1))

/**
 * Selectable elements, each carrying the name the renderer knows it by. Built
 * by walking the variants — a part's name says which unit it lives in and where
 * within that unit, so nothing here counts across units and nothing has to stay
 * aligned with a second enumeration. Unrendered variants are simply skipped.
 */
const hitElements = (): HitElement[] => {
  const symbol = props.symbol
  if (!symbol) return []
  const elements: HitElement[] = []
  for (const variant of symbol.variants) {
    if (!isRendered(variant)) continue
    const { unit, style } = variant
    variant.graphics.forEach((graphic, index) => {
      const element = graphicElement(graphic, { kind: 'graphic', unit, style, index })
      if (element) elements.push(element)
    })
    variant.pins.forEach((pin, index) => {
      if (pin.hidden && !showsHidden('pins')) return
      elements.push(pinElement(pin, { kind: 'pin', unit, style, index }))
    })
  }
  // Fields hang off the top symbol node, so they enumerate outside the variant
  // walk and their address zeroes unit/style, naming the property instead.
  for (const property of symbol.properties) {
    if (property.hidden && !showsHidden('fields')) continue
    const element = fieldElement(property, {
      kind: 'field',
      unit: 0,
      style: 0,
      index: 0,
      field: property.key
    })
    if (element) elements.push(element)
  }
  return elements
}

const { allows: allowsSymbolKind } = useSelectionFilter('symbol')
const symbolView = symbolViewState()
const appTheme = useAppTheme()

/**
 * Whether a hidden part is on the canvas right now. A part that is not drawn
 * must not be selectable either — the same rule `isRendered` applies to another
 * unit's pins, and for the same reason: picking something invisible and
 * dragging it is an edit made blind.
 */
const showsHidden = (kind: 'pins' | 'fields'): boolean =>
  kind === 'pins' ? symbolView.value.showHiddenPins : symbolView.value.showHiddenFields

/** The same two switches in the shape the scene takes them. */
const hiddenDisplay = (): { pins: boolean; fields: boolean } => ({
  pins: showsHidden('pins'),
  fields: showsHidden('fields')
})

/**
 * Every part within `threshold`, best first, as the shared selection model
 * takes them (lib/selectionResolve.ts): visible parts before hidden ones, each
 * lane nearest first. A symbol part is one level deep — there is no symbol to
 * resolve up to in here — so each candidate carries one level. The engine
 * hands a world-mm point; element geometry is domain nanometers, so the point
 * and the threshold scale up once here and every distance compares nm to nm.
 *
 * A hidden part is drawn UNDER the symbol and takes a click the same way: only
 * when nothing visible is in reach. A stacked pin sits exactly on the visible
 * one it shadows, so without the lanes the ghost wins half those clicks on a
 * distance tie — and the pin you can see is the one you meant. Ties keep
 * enumeration order, so the first wins as it always has.
 */
const hitCandidatesAt = (
  point: THREE.Vector2,
  threshold: number
): Array<HitCandidate<HitElement>> => {
  if (props.readOnly) return []
  const domainPoint = new THREE.Vector2(mmToNm(point.x), mmToNm(point.y))
  const reach = mmToNm(threshold) as number
  const found: Array<{ el: HitElement; d: number }> = []
  for (const el of hitElements()) {
    const d = el.distance(domainPoint)
    if (d < reach) found.push({ el, d })
  }
  found.sort((a, b) => Number(!!a.el.hidden) - Number(!!b.el.hidden) || a.d - b.d)
  return found.map(({ el }) => ({ levels: [{ kind: el.address.kind, ref: el }] }))
}

/** The part a click lands on under the selection filter, or null. */
const hitElementAt = (point: THREE.Vector2, threshold: number): HitElement | null =>
  resolveHit(hitCandidatesAt(point, threshold), allowsSymbolKind.value)

const hitTest = (
  point: THREE.Vector2,
  threshold: number
): { type: string; index: number; key: string } | null => {
  const best = hitElementAt(point, threshold)
  // The engine's `(type, index)` pair is an opaque token here, not a position:
  // it comes back through `onSelect`, which trades it for the address again.
  // `key` is what the engine matches against the selected set.
  return best ? { type: best.key, index: 0, key: best.key } : null
}

/** The selected parts, as a move sees them (lib/moveAnchors.ts). */
const movedElements = (): HitElement[] => {
  const keys = new Set(props.selectedItems.map(addressKey))
  return hitElements().filter((element) => keys.has(element.key))
}

/** The address behind an engine token — see `hitTest`. */
const addressForKey = (key: string): SymbolPartAddress | null =>
  hitElements().find((el) => el.key === key)?.address ?? null

// Click, band, pointer and Select Other: one model for every 2D editor
// (lib/canvasSelection.ts). The candidates above rank; the policy and the
// user's filter resolve. A part's address is what the selection holds.

/** A candidate list with each part as its address. */
const asAddresses = (
  candidates: Array<HitCandidate<HitElement>>
): Array<HitCandidate<SymbolPartAddress>> =>
  candidates.map((c) => ({ levels: c.levels.map((l) => ({ ...l, ref: l.ref.address })) }))

/**
 * Everything a band takes, by bounding box. Only rendered parts are
 * candidates — the rule the click follows, so an invisible unit can't be
 * swept up. The band arrives in world mm; part bounds are domain nm.
 */
const boxCandidates = (world: BoxBounds, crossing: boolean): Array<HitCandidate<HitElement>> => {
  const band = {
    xMin: mmToNm(world.xMin),
    xMax: mmToNm(world.xMax),
    yMin: mmToNm(world.yMin),
    yMax: mmToNm(world.yMax)
  }
  return hitElements()
    .filter((el) => partInBand(el.bounds, band, crossing))
    .map((el) => ({ levels: [{ kind: el.address.kind, ref: el }] }))
}

const selection = useCanvasSelection<SymbolPartAddress>({
  engine: () => engine,
  filterEditor: 'symbol',
  pointCandidates: (point, radius) => asAddresses(hitCandidatesAt(point, radius)),
  boxCandidates: (bounds, crossing) => asAddresses(boxCandidates(bounds, crossing)),
  allows: () => allowsSymbolKind.value,
  key: addressKey,
  selected: () => props.selectedItems,
  select: (items) => emit('update:selectedItems', items),
  active: () => (props.activeTool ?? 'select') === 'select' && !props.readOnly,
  // `type` is the engine token `hitTest` handed out — trade it back for the
  // address rather than parsing it.
  fromEngine: (type) => addressForKey(type)
})
const { selectOther, itemAtCursor } = selection

const onContextMenu = (event: MouseEvent): void => {
  event.preventDefault()
  // With a tool armed, right-click means "put the tool away" — the capture-phase
  // mousedown already emitted that, so the menu must stay shut.
  if ((props.activeTool ?? 'select') !== 'select') return
  emit('context-menu', {
    clientX: event.clientX,
    clientY: event.clientY,
    hit: itemAtCursor()
  })
}

/**
 * Selection highlight, drawn by the scene's own `setSelectedElementKeys` — the
 * same call the schematic editor's selection goes through, so a selected pin
 * here reads exactly like a selected symbol there. Parts of a unit that is not
 * on screen have no strokes in the scene, so they simply contribute no halo.
 */
const drawSelection = (): void => {
  const keys = selectionKeys()
  scene?.setSelectedElementKeys(keys)
  // A selection z-lifts its paint; the split render is what carries the HALO
  // above unselected content along with it.
  engine?.setLiftSplitZ(keys.length > 0 ? LIFT_SPLIT_Z : null)
}

/**
 * The vertex drag in flight, if any. The engine reports the drag KIND once, at
 * mousedown, but the preview is rebuilt on every move — so the kind has to be
 * remembered here or the preview cannot tell a resize from a move.
 */
let vertexDrag: { address: SymbolPartAddress; vertexIndex: number; origin: Point2 } | null = null

/**
 * Scene keys the drag in flight is moving, captured on the first move rather
 * than at mousedown: the engine selects what was clicked and starts the drag in
 * the same synchronous breath, and the selection it just asked for arrives as a
 * prop one tick later. Nothing has moved yet at that point, so the origins are
 * still the untranslated positions.
 */
let dragKeys: string[] | null = null

/**
 * The drag's current offset while one is in flight, or null. Kept because a
 * command can land MID-DRAG — rotate or mirror while holding a pin — and
 * `runCommand` reparses, which rebuilds the scene and throws the drag's
 * translation away. Without this the item snapped back to where it started
 * until the pointer moved again. The committed result was always right: the
 * transforms pivot on the selection's own bounding-box center, which commutes
 * with translating it, so only the picture was wrong.
 */
let liveDragDelta: THREE.Vector2 | null = null

/**
 * Live drag feedback. An ordinary drag moves the REAL geometry through the
 * scene, halo and all — the same `saveOrigins`/`translate` path the schematic
 * and footprint editors use. Until parts had names this editor could only draw
 * a moving copy over a stationary original, because every stroke of a symbol
 * shared one element key.
 *
 * A vertex drag previews the RESIZE, not a translation, and a resize changes
 * the shape rather than offsetting it — so it cannot go through `translate`.
 * The real graphic is hidden and the resized form drawn in its place, which is
 * why the two are never visible at once. The shape comes off
 * `setTypedGraphicVertex`, the typed twin of the `setGraphicVertex` the commit
 * writes through, so preview and result cannot describe different geometry.
 */
const drawDragPreview = (delta: THREE.Vector2): void => {
  if (!scene) return
  if (vertexDrag) {
    const graphic = props.symbol ? symbolPartGraphic(props.symbol, vertexDrag.address) : null
    if (!graphic) return
    // The drag delta is world mm; the grabbed vertex is domain nm.
    const resized = setTypedGraphicVertex(graphic, vertexDrag.vertexIndex, {
      x: nm(vertexDrag.origin.x + mmToNm(delta.x)),
      y: nm(vertexDrag.origin.y + mmToNm(delta.y))
    })
    scene.setSymbolItemPreview({ graphics: [resized], pins: [] })
    // The handles ride the previewed shape, so the one being held tracks the
    // cursor instead of waiting for the commit to redraw it somewhere else.
    vertexHandles?.setPositions(handleSpecs(vertexDrag.address, resized))
    return
  }
  if (!dragKeys) {
    dragKeys = selectionKeys()
    scene.saveDragOriginKeys(dragKeys)
  }
  scene.translateElementKeys(dragKeys, delta)
}

/** The selected graphic, when exactly one graphic is selected and on screen. */
const soleGraphic = (): { address: SymbolPartAddress; graphic: SymbolGraphic } | null => {
  const only = soleSelection(props.selectedItems)
  if (!only || only.kind !== 'graphic' || !isRendered(only) || !props.symbol) return null
  const graphic = symbolPartGraphic(props.symbol, only)
  return graphic ? { address: only, graphic } : null
}

/** A graphic's handles in engine space: symbol space shares its axes, so only nm→mm differs. */
const handleSpecs = (address: SymbolPartAddress, graphic: SymbolGraphic): VertexHandleSpec[] =>
  graphicHandleSpecs(graphic, (point) => ({ x: nmToMm(nm(point.x)), y: nmToMm(nm(point.y)) }), {
    address
  })

/**
 * Corner/point handles on the selected graphic, so a rectangle can be resized
 * on canvas instead of by typing corners into the panel.
 *
 * Only ever one graphic: see `soleSelection`.
 */
const drawVertexHandles = (): void => {
  const sole = props.readOnly ? null : soleGraphic()
  vertexHandles?.render(sole ? handleSpecs(sole.address, sole.graphic) : null)
}

/**
 * Anchor crosses on every selected text — not just a sole selection, which is
 * a handle's rule. Nothing raycasts a marker, so it cannot turn a group move
 * into something else, and a multi-selection is exactly when several anchors
 * are worth seeing at once.
 *
 * Symbol space and engine space share AXES (no y flip) but not UNITS: item
 * geometry is domain nanometers and the chrome layer positions in engine
 * millimeters, so every point converts on the way out — as the handles do.
 */
const drawTextAnchors = (): void => {
  const symbol = props.symbol
  if (!scene) return
  // A sole selection draws its anchor as a HANDLE instead, so the passive layer
  // steps aside for it — the same cross either way, but only one of them.
  const handled = props.readOnly ? null : soleGraphic()?.address
  // Plain numbers, not the domain-branded `Point2` — the result is engine mm.
  const enginePoint = (point: { x: number; y: number }): { x: number; y: number } => ({
    x: nmToMm(nm(point.x)),
    y: nmToMm(nm(point.y))
  })
  scene.renderTextAnchors(
    symbol && !props.readOnly
      ? props.selectedItems.flatMap((address) => {
          // A field's `(at …)` means different places depending on its
          // justification, so the drawing alone cannot show the stored point.
          if (address.kind === 'field') {
            const property = symbol.properties.find((p) => p.key === address.field)
            return property && isFieldOnCanvas(property) ? [enginePoint(property.position)] : []
          }
          if (address.kind !== 'graphic' || !isRendered(address)) return []
          if (handled && sameAddress(handled, address)) return []
          const graphic = symbolPartGraphic(symbol, address)
          const anchor = graphic ? graphicAnchorPoint(graphic) : null
          return anchor ? [enginePoint(anchor)] : []
        })
      : null
  )
}

/** One symbol's cameras, one key per unit — the prefix a rename carries across. */
const viewSubject = (name: string): string => `${props.filePath ?? ''}::${name}::`

/** Which symbol is on screen; a change here is what earns a re-fit. */
const viewKey = (): string => `${viewSubject(props.symbol?.name ?? '')}${props.renderedUnit ?? 1}`
let lastViewKey: string | null = null

/**
 * A rename changes the key, not the symbol on screen: carry its cameras and
 * `lastViewKey` across so the next rebuild sees the key it already had. Must be
 * called before the new name reaches props, which the editor's synchronous
 * rename satisfies.
 */
const retargetView = (from: string, to: string): void => {
  const [oldSubject, newSubject] = [viewSubject(from), viewSubject(to)]
  retargetCameras(oldSubject, newSubject)
  if (lastViewKey?.startsWith(oldSubject)) {
    lastViewKey = `${newSubject}${lastViewKey.slice(oldSubject.length)}`
  }
}

/**
 * Show what the armed tool would place, at the snapped cursor. The scene draws
 * the REAL primitives through its own emitter, haloed as a selected element, so
 * the preview is the thing itself rather than a separate ghost drawing that
 * could drift from what actually lands.
 */
const drawPreview = (): void => {
  if (!scene || !engine) return
  const tool = props.activeTool ?? 'select'
  if (tool === 'select') {
    scene.setSymbolItemPreview(null)
    return
  }
  // toolItems returns absolute symbol-space geometry — the same coordinates the
  // insert command will write — so the scene draws it as-is. The chain is the
  // clicks committed so far followed by the cursor, exactly what the commit is
  // built from, so a half-spanned rectangle previews the rectangle it will be.
  // The snapped cursor is world mm; the tools speak domain nm, and snapped mm
  // values convert exactly.
  const at = { x: mmToNm(engine.mouseSnapped.x), y: mmToNm(engine.mouseSnapped.y) }
  const points = [...(props.toolDraft ?? []), at]
  scene.setSymbolItemPreview(
    toolItems(tool, points, props.toolOrientation ?? DEFAULT_ORIENTATION, props.toolDefaults ?? {})
  )
}

/**
 * Tool clicks are intercepted in the capture phase so the engine's own mousedown
 * (select / drag) never sees them — the same guard SchematicViewport2D uses.
 * Symbol space maps to engine space by identity, so the snapped point needs no
 * axis flip (unlike the schematic, which is y-down).
 */
const markersLayer = findingMarkersLayer(
  toRef(props, 'findingMarkers'),
  (x, y) => ({ x, y }),
  MARKER_UNIT_MM.schematic
)

const onMouseDownCapture = (event: MouseEvent): void => {
  const tool = props.activeTool ?? 'select'
  if (tool === 'select' && event.button === 0 && !event.ctrlKey && !event.metaKey) {
    const key = markersLayer.hitAt(event)
    if (key) {
      event.stopPropagation()
      event.preventDefault()
      emit('finding-marker', key)
      return
    }
  }
  if (tool === 'select' || !engine || props.readOnly) return
  if (event.button === 1 || ((event.ctrlKey || event.metaKey) && event.button === 0)) return // pan
  event.stopPropagation()
  event.preventDefault()
  if (event.button === 2) {
    emit('tool-cancel')
    return
  }
  if (event.button !== 0) return
  // The nm boundary for tool input: the snapped world-mm cursor becomes an
  // integer-nanometer domain point once, here, and every consumer downstream
  // (draft, preview, commit) sees the same integers.
  emit('tool-click', { x: mmToNm(engine.mouseSnapped.x), y: mmToNm(engine.mouseSnapped.y) })
}

const rebuild = (): void => {
  if (!engine || !scene) return
  if (props.schematic) {
    scene.rebuild(props.schematic)
    const key = viewKey()
    if (key !== lastViewKey) {
      if (lastViewKey) saveCamera(lastViewKey, engine.getCameraState2D())
      // Re-keyed before the restore, not after: restoring moves the camera,
      // and what hears about that must file it under the unit it belongs to.
      lastViewKey = key
      const saved = loadCamera(key)
      if (saved) engine.setCameraState2D(saved)
      else engine.zoomToFit(scene.getBounds(), FIT_MIN_EXTENT)
    }
  }
  drawSelection()
  drawVertexHandles()
  drawTextAnchors()
  // `scene.rebuild` resets every batch — the preview's and any in-flight drag's
  // — so both have to be re-emitted here, or an edit made while one is on screen
  // quietly erases it until the next mouse move. Drag keys are cleared first
  // because the rebuild recreated the elements they name.
  drawPreview()
  if (liveDragDelta) {
    dragKeys = null
    drawDragPreview(liveDragDelta)
  }
  engine.render()
}

const zoomToFit = (): void => {
  if (engine && scene) engine.zoomToFit(scene.getBounds(), FIT_MIN_EXTENT)
}

/** Take keyboard focus — Escape in a property field hands the canvas back. */
const focusCanvas = (): void => container.value?.focus()

/** What floats over the symbol canvas, kept clear by a reveal. */
const SYMBOL_CHROME = ['.viewport-status-corner', '.canvas-floating-toolbar']
/** Half the box a point reveal frames, mm: a few grid steps of context around it. */
const POINT_REVEAL_HALF = 5

/** Reveal a symbol-space point (mm, y up, as the engine's axes are) — a located finding. */
const focusAt = (point: { x: number; y: number }): void => {
  if (!engine) return
  engine.bringIntoView(
    new THREE.Box3(
      new THREE.Vector3(point.x - POINT_REVEAL_HALF, point.y - POINT_REVEAL_HALF, 0),
      new THREE.Vector3(point.x + POINT_REVEAL_HALF, point.y + POINT_REVEAL_HALF, 0)
    ),
    {
      insets: measureViewportInsets(
        container.value,
        SYMBOL_CHROME,
        container.value?.closest<HTMLElement>('.viewport-host-area')
      ),
      minExtent: FIT_MIN_EXTENT
    }
  )
}

/** A picked finding at a symbol point (mm, y up): centered, or with `zoom`, framed close. */
const showFinding = (point: { x: number; y: number }, zoom: boolean): void =>
  engine?.showPoint(point.x, point.y, zoom, 2 * POINT_REVEAL_HALF)

/**
 * Pan by a world offset (mm) without changing the zoom — what keeps the drawing
 * still on screen when the editor shifts every item by the opposite amount
 * (Move Symbol Anchor).
 */
const shiftView = (dx: number, dy: number): void => {
  if (!engine) return
  const state = engine.getCameraState2D()
  engine.setCameraState2D({ ...state, x: state.x + dx, y: state.y + dy })
  engine.render()
}

const labelSymbolPart = (address: SymbolPartAddress): string =>
  props.symbol ? symbolItemLabel(props.symbol, address, t) : address.kind

/** Select All: every part on the canvas that the selection filter allows. */
const selectAll = (): SymbolPartAddress[] => selection.selectAll()

/** Zoom in / out, center on cursor, zoom to selection (`lib/viewCommands.ts`). */
const runViewCommand = (command: ViewCommand): void => {
  if (!engine) return
  if (command === 'zoomIn' || command === 'zoomOut') engine.zoomStep(command === 'zoomIn' ? 1 : -1)
  else if (command === 'centerOnCursor') engine.centerOnCursor()
  else if (scene) engine.frameBounds(scene.selectionBounds(), 2 * POINT_REVEAL_HALF)
}

/** Escape on a held move (M): everything goes back where it was, nothing dropped. */
const cancelHeldMove = (): boolean => {
  if (!engine?.cancelDrag()) return false
  const zero = new THREE.Vector2(0, 0)
  if (dragKeys) scene?.translateElementKeys(dragKeys, zero)
  vertexHandles?.translate(zero)
  dragKeys = null
  liveDragDelta = null
  scene?.clearDragOrigins()
  vertexHandles?.clearOrigins()
  engine.render()
  return true
}

defineExpose({
  zoomToFit,
  runViewCommand,
  /** KiCad's Move (M): what the editor picked up follows the pointer until a click drops it. */
  startHeldMove(): boolean {
    return engine?.beginHeldDrag({ held: true }) ?? false
  },
  cancelHeldMove,
  selectOtherAt: selection.selectOtherAt,
  focusCanvas,
  retargetView,
  getCursor,
  focusAt,
  showFinding,
  shiftView,
  selectAll,
  itemAtCursor
})

onMounted(() => {
  if (!container.value) return
  engine = new ViewportEngine(container.value)
  container.value.addEventListener('mouseenter', onContainerMouseEnter)
  container.value.addEventListener('mouseleave', onContainerMouseLeave)
  // A viewport can mount with a tool already armed (a tab switch keeps the
  // editor's tool state), so the pointer is set here as well as on change.
  engine.setDrawMode((props.activeTool ?? 'select') !== 'select')
  scene = new SchematicScene(engine.scene, engine.overlayScene)
  // Authoring affordances the schematic must not show: connection rings, gray
  // hidden pins and fields, and library-space (y-up) field angles.
  scene.setSymbolEditorMode(true)
  scene.setHiddenDisplay(hiddenDisplay())
  vertexHandles = new VertexHandles(engine.scene)
  // Handles and anchor crosses are chrome: constant on-screen size, not world
  // size. The anchor layer belongs to the scene, which is what lets it ride a
  // drag with the paint it marks.
  engine.registerScreenScaled(vertexHandles)
  for (const target of scene.screenScaledTargets()) engine.registerScreenScaled(target)
  markersLayer.install(engine)
  // Snap to KiCad's 1.27 mm (50 mil) symbol grid so drags land on clean pin
  // coordinates (and serialize without long binary-float tails).
  engine.setGridSettings(props.gridSettings ?? DEFAULT_SYMBOL_GRID)
  engine.setGridAppearance(STANDARD_GRID_APPEARANCE)
  applySchematicTheme()
  engine.applyTheme()
  // KiCad-style snapped cursor crosshair (a user setting later; on for now).
  engine.setSnapCrosshair(true)
  engine.onResetView(zoomToFit)
  // See PcbViewport2D: a window that closes never unmounts its components.
  engine.onViewChanged(() => {
    if (lastViewKey && engine) saveCamera(lastViewKey, engine.getCameraState2D())
  })
  engine.setCustomHitTest(hitTest)
  // Symbol space is y-up like the engine's: anchors carry over unflipped.
  engine.onDragAnchors(() =>
    roleAnchors(movedElements()).map((p) => new THREE.Vector2(nmToMm(nm(p.x)), nmToMm(nm(p.y))))
  )
  engine.onDragGrid(() => {
    const grid = props.gridSettings ?? DEFAULT_SYMBOL_GRID
    return roleGrid(
      movedElements().map((element) => element.role),
      spacingToMm(grid.spacing, grid.unit)
    )
  })
  selection.install(engine)
  engine.setSelectedKeys(new Set(props.selectedItems.map(addressKey)))

  disposeTestProvider = registerTestProvider(buildTestProvider())

  engine.onDragStart((type, info) => {
    if (type === 'vertex' && info) {
      const address = info.address as SymbolPartAddress
      const vertexIndex = info.vertexIndex as number
      // Remember the grabbed point's ORIGINAL position and commit origin+delta,
      // so repeated drags cannot compound rounding — the same rule the editor's
      // own commit follows.
      const graphic = props.symbol ? symbolPartGraphic(props.symbol, address) : null
      const origin = graphic ? graphicVertexPoints(graphic)[vertexIndex] : undefined
      vertexDrag = origin
        ? { address, vertexIndex, origin: { x: nm(origin.x), y: nm(origin.y) } }
        : null
      // The real graphic steps aside for the resized preview standing in for it.
      if (vertexDrag) scene?.setElementHidden(symbolPreviewPartKey(address), true)
      emit('vertex-drag-start', { address, vertexIndex })
      return
    }
    if (type === 'object') {
      vertexDrag = null
      dragKeys = null
      // Object drags move the whole shape, so its handles travel with it —
      // notably the center handle, which the cursor is holding. A resize needs
      // no snapshot: its handles are positioned from the previewed shape.
      vertexHandles?.saveOrigins()
    }
  })

  engine.onDragMove((delta) => {
    liveDragDelta = delta.clone()
    drawDragPreview(delta)
    // An object drag moves the whole shape, so every handle rides along by the
    // same offset. A resize positions them from the previewed shape instead —
    // `drawDragPreview` has just done it.
    if (!vertexDrag) vertexHandles?.translate(delta)
    engine!.render()
    // World mm → domain nm; symbol space and engine space share axes.
    emit('drag-move', { x: mmToNm(delta.x), y: mmToNm(delta.y) })
  })
  engine.onDragEnd(() => {
    // The geometry moved for real, so there is nothing to un-draw — but the
    // resize preview and whatever it stood in for both have to be put back
    // before the commit's rebuild redraws everything at its new shape.
    if (vertexDrag) {
      scene?.setSymbolItemPreview(null)
      scene?.showAllHidden()
    }
    vertexDrag = null
    dragKeys = null
    liveDragDelta = null
    scene?.clearDragOrigins()
    vertexHandles?.clearOrigins()
    engine?.render()
    emit('drag-end')
  })

  engine.onMouseMoveCoords((world, snapped) => {
    if (snapped.x !== lastSnapped.x || snapped.y !== lastSnapped.y) {
      lastSnapped = { x: snapped.x, y: snapped.y }
      // Same nm boundary as tool-click: snapped world mm → domain nanometers.
      emit('cursor-move', { x: mmToNm(lastSnapped.x), y: mmToNm(lastSnapped.y) })
    }
    if ((props.activeTool ?? 'select') !== 'select') {
      drawPreview()
      engine?.render()
    }
    // Symbol space is y-up like the engine's, so unlike every other viewport
    // this one reports the point unflipped — a readout states FILE coordinates.
    const grid = props.gridSettings ?? DEFAULT_SYMBOL_GRID
    const point = grid.snap ? snapped : world
    cursor.value = { x: point.x, y: point.y }
  })
  rebuild()
})

watch(() => props.schematic, rebuild)
watch(() => props.renderedUnit, rebuild)
watch(symbolView, () => {
  scene?.setHiddenDisplay(hiddenDisplay())
  // A part the switch just took off the canvas cannot stay selected, for the
  // reason the unit selector clears its selection (SymbolLibraryEditor): a
  // selected item still takes a drag or a delete, and there would be nothing on
  // screen to say what moved.
  const onCanvas = new Set(hitElements().map((element) => element.key))
  const kept = props.selectedItems.filter((item) => onCanvas.has(addressKey(item)))
  if (kept.length !== props.selectedItems.length) emit('update:selectedItems', kept)
  rebuild()
})
watch(appTheme, () => {
  applySchematicTheme()
  scene?.applyTheme()
  vertexHandles?.applyTheme()
  engine?.applyTheme()
  rebuild()
})
// `toolDraft` is in here so the preview appears the instant a click lands, without
// waiting for the pointer to move.
watch(
  [
    () => props.activeTool,
    () => props.toolOrientation,
    () => props.toolDraft,
    () => props.toolDefaults
  ],
  () => {
    engine?.setDrawMode((props.activeTool ?? 'select') !== 'select')
    drawPreview()
    engine?.render()
  },
  { deep: true }
)
watch(
  () => props.gridSettings,
  (g) => {
    engine?.setGridSettings(g ?? DEFAULT_SYMBOL_GRID)
    engine?.render()
  },
  { deep: true }
)
watch(
  () => props.selectedItems,
  (items) => {
    drawSelection()
    drawVertexHandles()
    drawTextAnchors()
    engine?.setSelectedKeys(new Set(items.map(addressKey)))
    engine?.render()
  },
  { deep: true }
)

onUnmounted(() => {
  container.value?.removeEventListener('mouseenter', onContainerMouseEnter)
  container.value?.removeEventListener('mouseleave', onContainerMouseLeave)
  if (engine && lastViewKey) saveCamera(lastViewKey, engine.getCameraState2D())
  disposeTestProvider?.()
  disposeTestProvider = null
  vertexHandles?.dispose()
  vertexHandles = null
  scene?.dispose()
  markersLayer.dispose()
  engine?.destroy()
  engine = null
  scene = null
})

let disposeTestProvider: (() => void) | null = null

/**
 * Symbol-editor slice of the test-hook bridge (lib/testHooks.ts): pins and
 * graphics come from the same `hitElements()` the click path uses, and FIELDS
 * are served from the scene's own field pivots.
 * Symbol space and engine space share axes; `world` is reported in engine mm,
 * so hit-element pivots (domain nm) convert on the way in.
 */
const listTestElements = (type?: string): TestElement[] => {
  if (!engine) return []
  const out: TestElement[] = []
  const push = (
    etype: string,
    index: number,
    ref: string,
    world: { x: number; y: number }
  ): void => {
    const screenCenter = engine ? engine.worldToScreen(world.x, world.y) : null
    out.push({ type: etype, index, ref, world, screenRect: null, screenCenter })
  }
  if (!type || type === 'pin' || type === 'graphic') {
    hitElements().forEach((el, index) => {
      if (type && el.address.kind !== type) return
      push(el.address.kind, index, el.key, {
        x: nmToMm(nm((el.bounds.minX + el.bounds.maxX) / 2)),
        y: nmToMm(nm((el.bounds.minY + el.bounds.maxY) / 2))
      })
    })
  }
  if (!type || type === 'field') {
    const properties = props.schematic?.symbols[0]?.properties ?? []
    properties.forEach((property, index) => {
      const pivot = scene?.fieldPivot({ type: 'symbol', index: 0, field: property.key })
      if (!pivot) return
      push('field', index, property.key, pivot)
      // Surface what the renderer actually draws with, so a driver can verify
      // stroke parity against KiCad without reverse-engineering pixels.
      out[out.length - 1].value = JSON.stringify({
        effects: property.effects,
        thickness: strokeOptionsFromTextEffects(property.effects).thickness
      })
    })
  }
  return out
}

const buildTestProvider = (): TestProvider => ({
  kind: 'symbol',
  worldToScreen: (x: number, y: number): { x: number; y: number } | null =>
    engine ? engine.worldToScreen(x, y) : null,
  listElements: listTestElements,
  getElement: (query: TestElementQuery): TestElement | null =>
    listTestElements(query.type).find(
      (e) =>
        (query.ref !== undefined && e.ref === query.ref) ||
        (query.index !== undefined &&
          e.index === query.index &&
          (query.type === undefined || e.type === query.type))
    ) ?? null
})
</script>

<template>
  <div
    ref="container"
    class="symbol-viewport"
    tabindex="-1"
    @contextmenu="onContextMenu"
    @mousedown.capture="onMouseDownCapture"
  >
    <ViewportStatusBar :coords="statusCoords">
      <GridSettingsControl
        editor="symbol"
        :grid-settings="gridSettings ?? DEFAULT_SYMBOL_GRID"
        @update-grid="(g) => emit('update-grid', g)"
      />
      <SelectionFilterControl editor="symbol" />
      <slot name="status" />
    </ViewportStatusBar>
    <SelectOtherMenu
      v-if="selectOther"
      :items="selectOther.items"
      :label="labelSymbolPart"
      :x="selectOther.x"
      :y="selectOther.y"
      @preview="selection.previewSelectOther"
      @commit="selection.closeSelectOther"
      @cancel="selection.closeSelectOther()"
    />
  </div>
</template>

<style scoped>
/* Focusable only so Escape can hand the keyboard back from the properties
   panel; the active pane is shown by the selection halo, not by a ring. */
.symbol-viewport:focus,
.symbol-viewport:focus-visible {
  outline: none;
}

.symbol-viewport {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
}
</style>
