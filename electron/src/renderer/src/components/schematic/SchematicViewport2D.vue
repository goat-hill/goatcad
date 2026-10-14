<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, toRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { AgentCapture, WorldBox } from '../../lib/schematic/schematicAgent'
import * as THREE from 'three'
import {
  ViewportEngine,
  type DragModifiers,
  type GridSettings,
  STANDARD_GRID_APPEARANCE
} from '../../lib/engine/ViewportEngine'
import { SCHEMATIC_FIT_MIN_EXTENT } from '../../lib/engine/schematicCapture'
import { schematicFitBounds } from '../../lib/schematic/schematicFit'
import { measureViewportInsets } from '../../lib/engine/viewportInsets'
import { findingMarkersLayer, type DocumentMarker } from '../../lib/engine/findingMarkersLayer'
import { MARKER_UNIT_MM } from '../../lib/engine/FindingMarkers'
import {
  agentViewportHandlers,
  agentViewportsFor,
  type ViewportFrame
} from '../../lib/agentViewportView'
import AgentViewportOverlay from '../shared/AgentViewportOverlay.vue'
import {
  SchematicScene,
  applySchematicTheme,
  sameSchematicRef,
  schematicItemKey,
  LIFT_SPLIT_Z,
  type NetHighlightGeometry,
  type SchematicDiffPaint,
  type SchematicItemRef
} from '../../lib/engine/SchematicScene'
import {
  sheetPinLanding,
  type DirectiveLabelShape,
  type KicadSchematic,
  type Point,
  type SchematicItemType,
  type SymbolGraphic
} from '../../lib/kicad/schematic'
import { mmToNm, nm, nmToMm, spacingToMm, type Nm } from '../../lib/kicad/coordinates'
import { roleAnchors, roleGrid } from '../../lib/moveAnchors'
import { schematicMoveParts, type MovePart } from '../../lib/schematic/moveParts'
import {
  buildConnectivity,
  type SchematicConnectivity,
  type SchematicNet
} from '../../lib/schematic/connectivity'
import { classConnectionStyles } from '../../lib/schematic/classConnectionStyles'
import type { NetClass } from '../../lib/kicad/project'
import {
  netChanges,
  planBusVertexDrag,
  planPlacement,
  planVertexDrag,
  previewMovedSchematic,
  turnedSchematic,
  type PlacementStep,
  type MovePlan,
  type VertexTarget
} from '../../lib/schematic/schematicMove'
import type { TransformOp } from '../../lib/schematic/schematicTransform'
import type { ViewCommand } from '../../lib/viewCommands'
import { resolveHit } from '../../lib/selectionResolve'
import { hotkeyLabel } from '../../lib/hotkeys'
import { useCanvasSelection } from '../../lib/canvasSelection'
import { schematicItemLabel } from '../../lib/schematic/schematicItemLabel'
import SelectOtherMenu from '../shared/SelectOtherMenu.vue'
import { SHEET_ITEM_TYPES } from '../../lib/schematic/sheetItemPlacement'
import {
  isSheetGraphicType,
  sheetGraphicOf,
  type SheetGraphicType
} from '../../lib/schematic/sheetGraphicEdit'
import { graphicHandleSpecs } from '../../lib/symbol/graphicEdit'
import { graphicVertexPoints } from '../../lib/symbol/symbolEdit'
import { setTypedGraphicVertex } from '../../lib/symbolTools'
import type { VertexHandleSpec } from '../../lib/engine/VertexHandles'
import { useSelectionFilter } from '../../lib/selectionFilter'
import { useAppTheme } from '../../lib/theme'
import { iconCursor } from '../../lib/icons'
import { loadCamera, saveCamera } from '../../lib/engine/cameraStore'
import SelectionFilterControl from '../shared/SelectionFilterControl.vue'
import GridSettingsControl from '../shared/GridSettingsControl.vue'
import ViewportStatusBar, {
  type StatusCoords,
  type StatusItem
} from '../shared/ViewportStatusBar.vue'
import {
  elbowPoints,
  sheetDraftRect,
  type PlacementGeometry,
  type SchematicTool,
  type WirePosture
} from '../../lib/schematic/schematicTools'
import {
  draftItem,
  draftSheet,
  isDrawTool,
  isRunTool,
  isTwoClickTool,
  sheetPinTarget,
  type DrawItem
} from '../../lib/schematic/drawTools'

// Pencil-tip hotspot at the glyph's lower-left. Handed to the engine rather
// than bound into CSS: the engine owns the cursor, and a container rule loses
// to the inline style it writes on the canvas filling that container.
const drawCursor = iconCursor('pencil', 3, 15)

const props = defineProps<{
  schematic: KicadSchematic
  revision: number
  selectedItems: SchematicItemRef[]
  gridSettings: GridSettings
  /**
   * A non-interactive render of the document (the Component view's panes),
   * as opposed to an editor. Distinct from a read-only FILE, where selecting
   * still works and the filter still earns its place.
   */
  preview?: boolean
  /** A preview a click still picks one item from (the visual diff); nothing moves. */
  pickable?: boolean
  /** No status pills at all — not even the readouts — where the canvas is a thumbnail (the library chooser). */
  bare?: boolean
  /** Project netlist for hover net highlighting (null while unavailable). */
  connectivity?: SchematicConnectivity | null
  /** The net Highlight Net (`) holds lit, by name; null for none. */
  highlightedNet?: string | null
  /** Light the hovered net across the sheet (the view rail's switch); on unless false. */
  netHighlight?: boolean
  /** Draw placed symbols' hidden pins and fields, dimmed (the view rail's switches). */
  showHiddenPins?: boolean
  showHiddenFields?: boolean
  /** This sheet's hierarchical instance path, keying into the connectivity. */
  sheetPath?: string
  /** The project's net classes, which style wires and buses (`classConnectionStyles`); absent, the theme's. */
  netClasses?: { classOf: (net: string) => NetClass; fallback: NetClass } | null
  /**
   * The file on screen, which is what its remembered framing is filed under.
   * Absent for a preview, which is sized to its pane rather than framed.
   */
  filePath?: string | null
  /** Armed placement tool; 'select' hands the canvas back to the engine. */
  activeTool: SchematicTool
  /** Committed wire-draft points (sheet space) while the wire tool draws. */
  wireDraft: Point[]
  /** Elbow orientation for the pending wire segment. */
  wirePosture: WirePosture
  /** Lib-space ghost geometry + rotation while the symbol/power tool is armed. */
  placement?: (PlacementGeometry & { angle: number; mirror?: 'x' | 'y' }) | null
  /** The armed part as it will land, on a one-part sheet: drawn as the ghost, as if selected. */
  placementSheet?: KicadSchematic | null
  /**
   * A drawn-but-not-yet-committed sheet rectangle (sheet space: y0=top,
   * y1=bottom), shown as a preview outline while its name/file are typed in the
   * popover. Null clears the preview.
   */
  pendingSheetRect?: { x0: number; y0: number; x1: number; y1: number } | null
  /**
   * First-click anchor (sheet space) of a two-click sheet draw; the preview
   * rectangle follows the cursor's height from here until the second click.
   */
  sheetDraftStart?: Point | null
  /** A drawing tool's clicks so far (lib/schematic/drawTools.ts). */
  drawDraft?: Point[]
  /** An item drawn and held while its popover asks for text; previewed as is. */
  heldDraft?: DrawItem | null
  busEntrySize?: { width: Nm; height: Nm }
  directiveShape?: DirectiveLabelShape
  /** The grid step a drawn table's cells round to. */
  drawGrid?: Nm
  /** The picture the image tool holds (PNG base64), previewed at the cursor. */
  imageData?: string | null
  /** The visual diff's paint: changes in color, removals red, the rest dimmed (`SchematicScene.setDiffPaint`). */
  diffPaint?: SchematicDiffPaint | null
  /** The checks' findings to mark on the canvas, sheet mm, y down. */
  findingMarkers?: readonly DocumentMarker[]
}>()

const emit = defineEmits<{
  (event: 'update:selectedItems', items: SchematicItemRef[]): void
  /** What the drag in hand would do to the nets where it lands, null while it changes none (§6). */
  (
    event: 'drag-verdict',
    verdict: { kind: 'merges' | 'splits' | 'connects'; text: string } | null
  ): void
  /** A finding's canvas marker was clicked, by its finding's key. */
  (event: 'finding-marker', key: string): void
  (event: 'update-grid', settings: Partial<GridSettings>): void
  /** Drag finished: how far the items moved, in sheet-space nm (y-down),
   *  whether the wires on them follow (Shift held at the drop: they stay), and
   *  the turns pressed mid-drag, each about the cursor as it then stood. */
  (
    event: 'move',
    items: SchematicItemRef[],
    delta: Point,
    options: { wires: boolean; steps: PlacementStep[] }
  ): void
  /** Left click while a tool is armed: snapped sheet point (nm) + container-relative px. */
  (event: 'tool-click', point: Point, screen: { x: number; y: number }): void
  /** Double click / right click while a tool is armed. */
  (event: 'tool-finish'): void
  /** A sheet was resized by dragging a corner handle (sheet-space nm top-left + size). */
  (event: 'resize-sheet', index: number, position: Point, size: { width: Nm; height: Nm }): void
  /** One point of a wire or bus was dragged by its handle, by `delta` (sheet
   *  nm); `wires` is false when Shift left what meets it behind. */
  (event: 'drag-vertex', target: VertexTarget, delta: Point, options: { wires: boolean }): void
  /** A free graphic's vertex was dragged by its handle to `point` (sheet nm). */
  (
    event: 'resize-graphic',
    item: { type: SheetGraphicType; index: number },
    vertexIndex: number,
    point: Point
  ): void
  /** A floating move (`startFloat`) landed: its shift and the turns pressed on the way. */
  (event: 'float-land', delta: Point, steps: PlacementStep[]): void
  /** A floating move was abandoned — Escape or a right click. */
  (event: 'float-cancel'): void
  /** A move or drag let go: dropped, whether or not it moved anything. */
  (event: 'drag-end'): void
  /** A double click with no tool armed, on what it landed on. */
  (event: 'item-dblclick', item: SchematicItemRef): void
  /** A right click with no tool armed: where, and what is under the pointer. */
  (
    event: 'context-menu',
    payload: { clientX: number; clientY: number; hit: SchematicItemRef | null }
  ): void
}>()

// Every document item. The parts of one — a field, a sheet's pin or field —
// cannot round-trip through `(type, index)` and come back through `hitRefs`.
const ITEM_TYPES: SchematicItemType[] = [
  'symbol',
  'wire',
  'label',
  'junction',
  'no_connect',
  'sheet',
  ...SHEET_ITEM_TYPES
]

const container = ref<HTMLDivElement | null>(null)
/**
 * Where the pointer last was, already in schematic (file) orientation. Seeded at the
 * origin rather than left empty so the readout is present from the first frame:
 * a pill that materializes on the first mouse move reads as the panel changing
 * shape, and 0,0 is the honest answer before the pointer has been anywhere.
 */
const cursor = ref({ x: 0, y: 0 })
const statusCoords = computed<StatusCoords>(() => ({
  ...cursor.value,
  unit: props.gridSettings.unit,
  spacing: props.gridSettings.snap ? props.gridSettings.spacing : undefined
}))
/** What the drag in progress is about to do to the nets, for the status bar. */
const dragHint = ref<StatusItem | null>(null)
const { t } = useI18n()
/**
 * The armed tool's coaching, only where the tool does not explain itself (as
 * the board editor's): a key you could not guess, a click order, how to close
 * a shape, where a sheet pin may go.
 */
const toolHint = computed<string>(() => {
  const drawing = (props.drawDraft?.length ?? 0) > 0
  switch (props.activeTool) {
    case 'wire':
      return props.wireDraft.length ? t('schematicEditor.hints.elbow') : ''
    case 'bus':
      return drawing ? t('schematicEditor.hints.elbow') : ''
    case 'bus_entry':
      return t('schematicEditor.hints.busEntry')
    case 'bezier':
      return t('schematicEditor.hints.bezier')
    case 'rule_area':
      return t('schematicEditor.hints.ruleArea')
    case 'table':
      return t('schematicEditor.hints.table')
    case 'sheet_pin':
      return t('schematicEditor.hints.sheetPin')
  }
  return ''
})
/** Bottom-left carries transient readouts: the highlighted net's name, then the
 *  drag's verdict while one runs, else the armed tool's coaching. A hovered net
 *  lights on the sheet, as KiCad's does, and names itself nowhere else. */
const hintItems = computed<StatusItem[]>(() => [
  ...(props.highlightedNet
    ? [
        {
          id: 'net',
          text: t('shared.netHighlight.status'),
          value: props.highlightedNet,
          accent: true,
          keys: [
            {
              caps: [hotkeyLabel('schematic.clearHighlight')],
              text: t('shared.netHighlight.clear')
            }
          ]
        }
      ]
    : []),
  ...(dragHint.value
    ? [dragHint.value]
    : toolHint.value
      ? [{ id: 'hint', text: toolHint.value }]
      : [])
])

let engine: ViewportEngine | null = null
let schematicScene: SchematicScene | null = null
let dragItems: SchematicItemRef[] = []
let dragDelta = new THREE.Vector2()
let didInitialFit = false
let dragging = false
/** Where a floating move hangs from the cursor (sheet nm), while one runs. */
let floatAnchor: Point | null = null
// In-progress sheet-corner resize (engine space). `orig` is the sheet at drag
// start; `cur` is the live rectangle as the handle drags.
let sheetResize: {
  index: number
  corner: string
  orig: { x0: number; x1: number; yTop: number; yBottom: number }
  cur: { x0: number; x1: number; yTop: number; yBottom: number }
} | null = null
/** In-progress drag of one wire or bus point by its handle. */
let vertexDrag: { target: VertexTarget; delta: Point } | null = null
/**
 * In-progress resize of a free graphic by one of its handles: the grabbed
 * vertex's ORIGINAL position (sheet nm), so the commit is origin + delta and
 * repeated drags cannot compound rounding.
 */
let graphicResize: {
  item: { type: SheetGraphicType; index: number }
  vertexIndex: number
  origin: Point
  point: Point
} | null = null
/**
 * A drag the keyboard started (KiCad's M and G): no button is down, the next
 * click drops it, and which of the two it is — not Shift — says whether the
 * wires follow.
 */
let heldMode: 'move' | 'drag' | null = null
let hoveredNet: SchematicNet | null = null
// Snapped cursor in sheet space, so posture/draft changes can re-run the
// wire preview without waiting for the next mousemove.
let lastCursor: Point | null = null
/** Where the pointer last was over the canvas, in container pixels — what a
 *  tool click reports beside its point, for a key that acts as one. */
let lastScreen = { x: 0, y: 0 }
/** A key gesture must not act on a stale point from before the mouse left. */
let pointerInside = false
const onContainerMouseEnter = (): void => {
  pointerInside = true
}
const onContainerMouseLeave = (): void => {
  pointerInside = false
}
const onContainerMouseMove = (event: MouseEvent): void => {
  const rect = container.value?.getBoundingClientRect()
  lastScreen = { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) }
}
/** The snapped cursor as a tool click would report it, or null when the
 *  pointer is not over the canvas — KiCad's "a hotkey acts at the cursor". */
const getCursor = (): { point: Point; screen: { x: number; y: number } } | null =>
  pointerInside && lastCursor ? { point: { ...lastCursor }, screen: { ...lastScreen } } : null
// The snapped delta (or 'alone') the wires-follow preview was last built for:
// the engine reports every pointer move, the plan only changes on a grid step.
// `dragBefore` is the sheet's own connectivity at the drag's start, the
// baseline the live net verdict is measured against.
let dragPlanKey = ''
let dragBefore: SchematicConnectivity | null = null
let dragCarriedKeys: string[] = []
// Turns pressed mid-drag, in the selection's original coordinates, and the
// sheet as they leave it: the canvas is rebuilt from that so the drag's shift
// stays a plain translation of what is drawn.
let dragSteps: PlacementStep[] = []
let dragTurned: KicadSchematic | null = null
// The net verdict reads the whole sheet's connectivity, which on a big sheet
// costs more than a frame; it runs coalesced on a timer, at once while cheap
// and on pointer-quiet once it has proven slow. The wire preview never waits.
let verdictTimer: ReturnType<typeof setTimeout> | null = null
let verdictMs = 0
let verdictRuns: Point[][] = []
let verdictBusRuns: Point[][] = []
let verdictJunctions: Point[] = []
const SLOW_VERDICT_MS = 16
const QUIET_VERDICT_DELAY_MS = 80

const selectionKeys = (): Set<string> => new Set(props.selectedItems.map(schematicItemKey))

const applySelection = (): void => {
  schematicScene?.setSelection(props.selectedItems)
  engine?.setSelectedKeys(selectionKeys())
  // A selection z-lifts its paint; the split render is what carries the HALO
  // above unselected content along with it.
  engine?.setLiftSplitZ(props.selectedItems.length > 0 ? LIFT_SPLIT_Z : null)
  applyHandles()
  applyTextAnchors()
}

/**
 * An anchor cross on each selected text-like item — every kind of label, a
 * free text, a text box, a field, a sheet pin: its `(at …)` is exactly what its
 * glyphs do not show, which justification puts them left, right or centered
 * of it, and where a label connects.
 */
const applyTextAnchors = (): void => {
  const scene = schematicScene
  if (!scene) return
  // Engine-space (mm) points: the scene answers in its own coordinates.
  const points: Array<{ x: number; y: number }> = []
  for (const item of props.selectedItems) {
    const anchor = scene.textAnchor(item)
    if (anchor) points.push(anchor)
  }
  scene.renderTextAnchors(points)
}

/** The one selected wire or bus, whose points take grab handles. */
const soleLine = (): { type: 'wire' | 'bus'; index: number; points: Point[] } | null => {
  const items = props.selectedItems
  const item = items.length === 1 ? items[0] : null
  if (!item || (item.type !== 'wire' && item.type !== 'bus')) return null
  const line = (item.type === 'wire' ? props.schematic.wires : props.schematic.buses)[item.index]
  return line && line.points.length >= 2
    ? { type: item.type, index: item.index, points: line.points }
    : null
}

const renderLineHandles = (
  line: { type: 'wire' | 'bus'; index: number },
  points: Point[],
  offset = new THREE.Vector2(0, 0)
): void => {
  schematicScene?.renderPointHandles(
    line,
    points.map((point) => enginePointOf(point).add(offset))
  )
}

/** The one selected free graphic, whose vertices take the symbol editor's handles. */
const soleGraphic = (): {
  item: { type: SheetGraphicType; index: number }
  graphic: SymbolGraphic
} | null => {
  const items = props.selectedItems
  const item = items.length === 1 ? items[0] : null
  if (!item || !isSheetGraphicType(item.type)) return null
  const found = sheetGraphicOf(props.schematic, item)
  return found ? { item: { type: item.type, index: item.index }, graphic: found.graphic } : null
}

/**
 * A free graphic's handles, shared with the symbol editor (`graphicHandleSpecs`).
 * Sheet space is y-down, so each point flips into the engine. `graphicOf`, not
 * `type`, names the item: a handle's `type` is the engine's `'vertex'` marker.
 */
const graphicHandles = (
  item: { type: SheetGraphicType; index: number },
  graphic: SymbolGraphic,
  offset = new THREE.Vector2(0, 0)
): VertexHandleSpec[] =>
  graphicHandleSpecs(
    graphic,
    (point) => enginePointOf({ x: nm(point.x), y: nm(point.y) }).add(offset),
    { graphicOf: item.type, index: item.index }
  )

// Grab handles show only on a single selected item: a sheet's corners resize
// it, a wire's or bus's points drag one point (KiCad's point editor), a free
// graphic's vertices reshape it as in the symbol editor. Re-derived
// on every selection change and rebuild (the doc — hence the points — may
// move), and offset while the item drags so they ride along with it.
const applyHandles = (offset = new THREE.Vector2(0, 0)): void => {
  if (!schematicScene) return
  const items = props.selectedItems
  const line = soleLine()
  if (line) {
    renderLineHandles(line, line.points, offset)
    return
  }
  const sole = props.preview ? null : soleGraphic()
  if (sole) {
    schematicScene.renderGraphicHandles(graphicHandles(sole.item, sole.graphic, offset))
    return
  }
  const sheet =
    items.length === 1 && items[0].type === 'sheet' ? props.schematic.sheets[items[0].index] : null
  if (sheet && items[0]) {
    const yTop = -sheet.position.y + offset.y
    schematicScene.renderSheetHandles({
      index: items[0].index,
      x0: sheet.position.x + offset.x,
      x1: sheet.position.x + sheet.size.width + offset.x,
      yTop,
      yBottom: yTop - sheet.size.height
    })
  } else {
    schematicScene.renderSheetHandles(null)
  }
}

const applyDangling = (connectivity = props.connectivity): void => {
  if (!schematicScene) return
  const sheetPath = props.sheetPath ?? '/'
  schematicScene.setDanglingIndicators(
    connectivity
      ? [...connectivity.dangling, ...connectivity.openAnchors]
          .filter((end) => end.sheetPath === sheetPath)
          .map((end) => ({ position: end.position, kind: end.kind }))
      : []
  )
}

/**
 * What this sheet's framing is filed under, or null when there is none to file:
 * a preview is sized to the pane it sits in, and saving its camera would hand
 * the editor the thumbnail's frame the next time that file is opened.
 */
const cameraKey = (): string | null => (props.preview ? null : (props.filePath ?? null))

const rebuild = (): void => {
  if (!engine || !schematicScene) return
  schematicScene.setHiddenDisplay({
    pins: props.showHiddenPins === true,
    fields: props.showHiddenFields === true
  })
  const classes = props.netClasses
  schematicScene.setConnectionStyles(
    classes && props.connectivity
      ? classConnectionStyles(
          props.schematic,
          props.sheetPath ?? '/',
          props.connectivity,
          classes.classOf,
          classes.fallback
        )
      : null
  )
  schematicScene.rebuild(props.schematic)
  applySelection()
  applyDangling()
  // The rebuild cleared the tool ghost too; a drawing tool's comes back at once.
  draftPreviewKey = STALE_DRAFT
  if (isDrawTool(props.activeTool) || props.heldDraft) refreshDraftPreview()
  // rebuild() cleared the overlay batch; forget the stale net so the next
  // mousemove re-derives it against the fresh connectivity, and draw the
  // highlighted one again.
  hoveredNet = null
  if (props.highlightedNet) applyNetHighlight()
  if (!didInitialFit) {
    // The frame this sheet was last left at, if it has one. Every editor is
    // rebuilt from scratch on a tab switch, so without this a schematic re-fits
    // every time it comes back — see `cameraStore`.
    const key = cameraKey()
    const saved = key ? loadCamera(key) : undefined
    if (saved) {
      engine.setCameraState2D(saved)
      // A remembered camera IS the user's frame — they left the sheet at it —
      // so a cross-select arriving on it preserves it, as it does on a board.
      engine.markViewFramedByUser()
      engine.render()
    } else {
      engine.zoomToFit(fitBounds(), FIT_MIN_EXTENT)
    }
    didInitialFit = true
  } else {
    engine.render()
  }
}

const FIT_MIN_EXTENT = SCHEMATIC_FIT_MIN_EXTENT

/** The drawing, or its paper while the sheet is empty. */
const fitBounds = (): THREE.Box3 =>
  schematicFitBounds(schematicScene?.getBounds() ?? new THREE.Box3(), props.schematic.paper)

const zoomToFit = (): void => {
  if (!engine || !schematicScene) return
  engine.zoomToFit(fitBounds(), FIT_MIN_EXTENT)
  // Asked for by the user, so it is their frame: a cross-select arriving on a
  // whole-sheet fit someone chose leaves it alone (ViewportEngine
  // `viewFramedByUser`). The initial fit in `rebuild` deliberately does not.
  engine.markViewFramedByUser()
}

/** Chrome floating over this canvas — the status pills and their controls. */
const SCHEMATIC_CHROME = ['.viewport-status-corner', '.canvas-floating-toolbar']

// --- The agents' viewports on this sheet (lib/agentViewportView.ts), drawn by
// AgentViewportOverlay. The camera moves only when the person clicks a box's
// edge marker.
const agentViewports = computed(() =>
  props.preview ? [] : agentViewportsFor(props.filePath ?? null)
)

/** Sheet mm (y down) to the engine's space (y up). */
const agentFrameBox = (frame: ViewportFrame): THREE.Box3 =>
  new THREE.Box3(
    new THREE.Vector3(frame.x, -(frame.y + frame.height), 0),
    new THREE.Vector3(frame.x + frame.width, -frame.y, 0)
  )

const agentView = agentViewportHandlers(
  () => engine,
  agentFrameBox,
  () => container.value,
  SCHEMATIC_CHROME
)

/**
 * A picture of the sheet for `render.schematic`: frame the box (or everything) and
 * read the canvas back, leaving the user's view where it was. The engine does
 * the fit, capture and restore in one synchronous step, so nothing on screen
 * moves — an agent auditing a sheet should not be steering the person's view.
 */
const captureForAgent = (box: WorldBox | null, maxPixels: number): AgentCapture | null => {
  if (!engine || !schematicScene) return null
  const bounds = box
    ? new THREE.Box3(
        new THREE.Vector3(box.minX, box.minY, 0),
        new THREE.Vector3(box.maxX, box.maxY, 0)
      )
    : schematicScene.getBounds()
  return engine.captureFramed(bounds, FIT_MIN_EXTENT, maxPixels)
}

/**
 * Reveal these symbols: select-in-place if they are already in sight, pan if
 * not, zoom out only if they cannot fit (`lib/engine/bringIntoView.ts`).
 */
const focusIndices = (indices: number[]): void => {
  if (!engine || !schematicScene) return
  const box = new THREE.Box2()
  for (const index of indices) {
    const bounds = schematicScene.getSymbolBounds(index)
    if (bounds) box.union(bounds)
  }
  if (box.isEmpty()) return

  // The tool pill belongs to SchematicEditor, which wraps this component.
  const chromeRoot = container.value?.closest<HTMLElement>('.viewport-host-area') ?? container.value
  engine.bringIntoView(
    new THREE.Box3(
      new THREE.Vector3(box.min.x, box.min.y, 0),
      new THREE.Vector3(box.max.x, box.max.y, 0)
    ),
    {
      insets: measureViewportInsets(container.value, SCHEMATIC_CHROME, chromeRoot),
      minExtent: FIT_MIN_EXTENT
    }
  )
}

/** Half the box a point reveal frames, mm: a few grid steps of context around it. */
const POINT_REVEAL_HALF = 5

/** Reveal a sheet-space point (mm, y down) — a finding with nothing to select. */
const focusAt = (point: { x: number; y: number }): void => {
  if (!engine) return
  const chromeRoot = container.value?.closest<HTMLElement>('.viewport-host-area') ?? container.value
  engine.bringIntoView(
    new THREE.Box3(
      new THREE.Vector3(point.x - POINT_REVEAL_HALF, -point.y - POINT_REVEAL_HALF, 0),
      new THREE.Vector3(point.x + POINT_REVEAL_HALF, -point.y + POINT_REVEAL_HALF, 0)
    ),
    {
      insets: measureViewportInsets(container.value, SCHEMATIC_CHROME, chromeRoot),
      minExtent: FIT_MIN_EXTENT
    }
  )
}

/** A picked finding at a sheet point (mm, y down): centered, or with `zoom`, framed close. */
const showFinding = (point: { x: number; y: number }, zoom: boolean): void =>
  engine?.showPoint(point.x, -point.y, zoom, 2 * POINT_REVEAL_HALF)

/** Zoom in / out, center on cursor, zoom to selection (`lib/viewCommands.ts`). */
const runViewCommand = (command: ViewCommand): void => {
  if (!engine) return
  if (command === 'zoomIn' || command === 'zoomOut') engine.zoomStep(command === 'zoomIn' ? 1 : -1)
  else if (command === 'centerOnCursor') engine.centerOnCursor()
  else if (schematicScene)
    engine.frameBounds(schematicScene.selectionBounds(), 2 * POINT_REVEAL_HALF)
}

/** Geometry of the net on THIS sheet, in file space, for the overlay. */
const highlightGeometry = (net: SchematicNet): NetHighlightGeometry => {
  const sheetPath = props.sheetPath ?? '/'
  return {
    wireRuns: net.wires
      .filter((wire) => wire.sheetPath === sheetPath)
      .map((wire) => wire.wire.points),
    points: [
      ...net.pins.filter((pin) => pin.sheetPath === sheetPath).map((pin) => pin.position),
      ...net.junctions
        .filter((junction) => junction.sheetPath === sheetPath)
        .map((junction) => junction.position)
    ]
  }
}

const clearHover = (): void => {
  if (!hoveredNet) return
  hoveredNet = null
  applyNetHighlight()
}

const updateHover = (world: THREE.Vector2): void => {
  if (!engine || !schematicScene || dragging) return
  // Net hover reads as noise under an armed placement tool; the wire preview
  // and the crosshair carry the feedback instead.
  if (props.activeTool !== 'select') {
    clearHover()
    return
  }
  const connectivity = props.connectivity
  if (!connectivity) return
  // Engine space is y-up; sheet space is y-down. 10 px of cursor slack,
  // clamped so deep zoom-out cannot make everything hoverable.
  const tolerance = Math.min(1.5, Math.max(0.1, engine.hitRadius()))
  const net =
    connectivity.netAt(
      props.sheetPath ?? '/',
      { x: mmToNm(world.x), y: mmToNm(-world.y) },
      mmToNm(tolerance)
    ) ?? null
  if (net === hoveredNet) return
  hoveredNet = net
  applyNetHighlight()
}

/** The highlighted net (`), by name over the whole design, or null; one gone since lights nothing. */
const stickyNet = (): SchematicNet | null => {
  const name = props.highlightedNet
  return name ? (props.connectivity?.nets.find((net) => net.name === name) ?? null) : null
}

/**
 * Draw the highlighted net, else the hovered one unless the rail's switch is
 * off. Nothing mid-drag: the geometry goes stale under it.
 */
const applyNetHighlight = (): void => {
  if (!engine || !schematicScene) return
  const net = dragging
    ? null
    : props.highlightedNet
      ? stickyNet()
      : props.netHighlight !== false
        ? hoveredNet
        : null
  schematicScene.setNetHighlight(net ? highlightGeometry(net) : null)
  engine.render()
}

watch(
  [() => props.netHighlight, () => props.highlightedNet, () => props.connectivity],
  applyNetHighlight
)

/** The name of the net under the pointer, for Highlight Net; null off the canvas or off any net. */
const netAtPointer = (): string | null => {
  const at = engine?.pointerWorld()
  if (!engine || !at || !props.connectivity) return null
  const tolerance = Math.min(1.5, Math.max(0.1, engine.hitRadius()))
  return (
    props.connectivity.netAt(
      props.sheetPath ?? '/',
      { x: mmToNm(at.x), y: mmToNm(-at.y) },
      mmToNm(tolerance)
    )?.name ?? null
  )
}

/** Lib-space (y-up) ghost point rotated and dropped at the cursor, in sheet
 *  space — the same transform `transformLocal` applies to placed symbols. */
const ghostPoint = (
  local: Point,
  cursor: Point,
  angleDegrees: number,
  mirror?: 'x' | 'y'
): Point => {
  const angle = (angleDegrees * Math.PI) / 180
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const x = local.x * cos - local.y * sin
  const y = local.x * sin + local.y * cos
  // Turned, then flipped on the sheet, as `placedPoint` places a pin.
  return {
    x: nm(cursor.x + (mirror === 'y' ? -x : x)),
    y: nm(cursor.y + (mirror === 'x' ? y : -y))
  }
}

/** The draft last drawn, so a pointer move inside one grid cell re-parses nothing. */
const STALE_DRAFT = '-'
let draftPreviewKey = STALE_DRAFT

/** The item a drawing tool would make next, drawn through its own writer. */
const refreshDraftPreview = (): void => {
  if (!schematicScene) return
  const tool = props.activeTool
  const item =
    props.heldDraft ??
    (isDrawTool(tool) && lastCursor
      ? draftItem(tool, props.drawDraft ?? [], lastCursor, {
          posture: props.wirePosture,
          busEntrySize: props.busEntrySize ?? { width: nm(0), height: nm(0) },
          directiveShape: props.directiveShape ?? 'round',
          buses: props.schematic.buses.map((bus) => bus.points),
          grid: props.drawGrid,
          image: props.imageData
        })
      : null)
  // A picture is keyed by where it is, not by its (large) data.
  const key = item
    ? JSON.stringify(item.kind === 'image' ? { ...item, data: item.data.length } : item)
    : ''
  if (key === draftPreviewKey) return
  draftPreviewKey = key
  schematicScene.setDraftPreview(item ? draftSheet(item) : null)
}

/**
 * Wire rubber band and placement ghost share one scene batch (the tools are
 * mutually exclusive), so a single router decides what — if anything — the
 * preview shows this frame.
 */
/** The ghost sheet the preview batch holds, so following the cursor only moves it. */
let placementDrawn: KicadSchematic | null = null

const refreshToolPreview = (): void => {
  if (!engine || !schematicScene) return
  const placement = props.placement
  const placing =
    (props.activeTool === 'symbol' || props.activeTool === 'power') && !!props.placementSheet
  // Anything else this frame resets the shared batch.
  if (!placing || !lastCursor) placementDrawn = null
  if (props.heldDraft || isDrawTool(props.activeTool)) {
    refreshDraftPreview()
    engine.render()
    return
  }
  draftPreviewKey = STALE_DRAFT
  if (props.activeTool === 'sheet_pin') {
    // The ring the pin's connection point will be, slid onto the nearest edge.
    const target = lastCursor ? sheetPinTarget(props.schematic.sheets, lastCursor) : null
    schematicScene.setWirePreview(target ? [target.position] : null)
  } else if (props.activeTool === 'wire' && props.wireDraft.length > 0) {
    const points = [...props.wireDraft]
    const last = points[points.length - 1]
    if (lastCursor) points.push(...elbowPoints(last, lastCursor, props.wirePosture))
    schematicScene.setWireDraftPreview(points)
  } else if (placing && props.placementSheet && lastCursor) {
    if (placementDrawn !== props.placementSheet) {
      schematicScene.setSymbolPlacementPreview(props.placementSheet)
      placementDrawn = props.placementSheet
    }
    schematicScene.movePreview(nmToMm(lastCursor.x), -nmToMm(lastCursor.y))
  } else if (
    (props.activeTool === 'symbol' || props.activeTool === 'power') &&
    placement &&
    lastCursor
  ) {
    const cursor = lastCursor
    schematicScene.setPlacementPreview({
      outline: placement.outline.map((point) =>
        ghostPoint(point, cursor, placement.angle, placement.mirror)
      ),
      pins: placement.pins.map((point) =>
        ghostPoint(point, cursor, placement.angle, placement.mirror)
      )
    })
  } else {
    schematicScene.setWirePreview(null)
  }
  engine.render()
}

/** Live preview outline for a two-click sheet draw (fixed width, height to cursor). */
const refreshSheetPreview = (): void => {
  if (!engine || !schematicScene || !props.sheetDraftStart || !lastCursor) return
  const rect = sheetDraftRect(props.sheetDraftStart, lastCursor) // sheet space, nm
  schematicScene.setSheetPreview({
    x0: nmToMm(rect.x0),
    y0: -nmToMm(rect.y0),
    x1: nmToMm(rect.x1),
    y1: -nmToMm(rect.y1)
  })
  engine.render()
}

const labelSchematicItem = (item: SchematicItemRef): string =>
  schematicItemLabel(props.schematic, item, t, props.sheetPath ?? '/')

// Tool clicks are intercepted in the capture phase so the engine's own
// mousedown handler (selection / box select / drag) never sees them.
const markersLayer = findingMarkersLayer(
  toRef(props, 'findingMarkers'),
  (x, y) => ({ x, y: -y }),
  MARKER_UNIT_MM.schematic
)

const onMouseDownCapture = (event: MouseEvent): void => {
  // A right click that puts a tool away or drops a drag is not asking for a menu.
  if (event.button === 2) menuBlocked = dragging || !!floatAnchor || props.activeTool !== 'select'
  if (floatAnchor && onFloatMouseDown(event)) return
  if (
    props.activeTool === 'select' &&
    event.button === 0 &&
    !event.ctrlKey &&
    !event.metaKey &&
    !dragging
  ) {
    const key = markersLayer.hitAt(event)
    if (key) {
      event.stopPropagation()
      event.preventDefault()
      emit('finding-marker', key)
      return
    }
  }
  if (props.activeTool === 'select' || !engine) return
  if (event.button === 1 || ((event.ctrlKey || event.metaKey) && event.button === 0)) return // pan
  event.stopPropagation()
  event.preventDefault()
  if (event.button === 2) {
    emit('tool-finish')
    return
  }
  if (event.button !== 0) return
  const rect = container.value?.getBoundingClientRect()
  // The nm boundary for tool input: snapped world mm → integer-nanometer
  // sheet-space point (y flips into the document's y-down frame).
  emit(
    'tool-click',
    { x: mmToNm(engine.mouseSnapped.x), y: mmToNm(-engine.mouseSnapped.y) },
    { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) }
  )
}

// Minimum sheet extent (100 mil) — the resize clamp floor. A twin of
// MIN_SHEET_EXTENT in lib/schematic/schematicItems.ts, the agent resize's floor.
const MIN_SHEET_EXTENT = 2.54

// Sheet corner resize (engine 'vertex' drag path)

const startSheetResize = (index: number, corner: string): void => {
  const sheet = props.schematic.sheets[index]
  if (!sheet) return
  const yTop = -sheet.position.y
  const orig = {
    x0: sheet.position.x,
    x1: sheet.position.x + sheet.size.width,
    yTop,
    yBottom: yTop - sheet.size.height
  }
  sheetResize = { index, corner, orig, cur: { ...orig } }
}

const updateSheetResize = (delta: { x: number; y: number }): void => {
  if (!sheetResize || !schematicScene || !engine) return
  const { corner, orig } = sheetResize
  let x0 = orig.x0
  let x1 = orig.x1
  let yTop = orig.yTop
  let yBottom = orig.yBottom
  // corner is `t|b` + `l|r`; only the two edges meeting at it move.
  if (corner[1] === 'l') x0 = orig.x0 + delta.x
  else x1 = orig.x1 + delta.x
  if (corner[0] === 't') yTop = orig.yTop + delta.y
  else yBottom = orig.yBottom + delta.y
  // Clamp the moving edge so the box never collapses past the minimum extent.
  if (x1 - x0 < MIN_SHEET_EXTENT) {
    if (corner[1] === 'l') x0 = x1 - MIN_SHEET_EXTENT
    else x1 = x0 + MIN_SHEET_EXTENT
  }
  if (yTop - yBottom < MIN_SHEET_EXTENT) {
    if (corner[0] === 't') yTop = yBottom + MIN_SHEET_EXTENT
    else yBottom = yTop - MIN_SHEET_EXTENT
  }
  sheetResize.cur = { x0, x1, yTop, yBottom }
  schematicScene.setSheetPreview({ x0, y0: yTop, x1, y1: yBottom })
  schematicScene.renderSheetHandles({ index: sheetResize.index, x0, x1, yTop, yBottom })
  engine.render()
}

const finishSheetResize = (): void => {
  if (!sheetResize || !engine) return
  const { index, cur, orig } = sheetResize
  sheetResize = null
  schematicScene?.setSheetPreview(null)
  // Compare on the nm grid the write lands on: a drag that rounds to the
  // same integers is no edit at all.
  const changed =
    mmToNm(cur.x0) !== mmToNm(orig.x0) ||
    mmToNm(cur.x1) !== mmToNm(orig.x1) ||
    mmToNm(cur.yTop) !== mmToNm(orig.yTop) ||
    mmToNm(cur.yBottom) !== mmToNm(orig.yBottom)
  if (changed) {
    // Engine mm (y-up) → sheet space nm (y-down): top-left is (x0, -yTop).
    emit(
      'resize-sheet',
      index,
      { x: mmToNm(cur.x0), y: mmToNm(-cur.yTop) },
      { width: mmToNm(cur.x1 - cur.x0), height: mmToNm(cur.yTop - cur.yBottom) }
    )
  }
  applyHandles()
  engine.render()
}

const onDblClickCapture = (event: MouseEvent): void => {
  if (props.activeTool === 'select') {
    const hit = event.button === 0 && !props.preview ? hitUnderPointer() : null
    if (hit) emit('item-dblclick', hit)
    return
  }
  event.stopPropagation()
  event.preventDefault()
  emit('tool-finish')
}

let menuBlocked = false

const onContextMenu = (event: MouseEvent): void => {
  event.preventDefault()
  if (props.preview || menuBlocked) return
  emit('context-menu', { clientX: event.clientX, clientY: event.clientY, hit: hitUnderPointer() })
}

/** What a click at the pointer would select — the same hit-test and filter. */
const hitUnderPointer = (): SchematicItemRef | null => selection.itemAtCursor()

/**
 * Which levels a schematic click may land on — the editor's policy narrowed by
 * the user's selection filter. See lib/selectionResolve.ts and
 * lib/selectionFilter.ts.
 */
const { allows: allowsSchematicKind } = useSelectionFilter('schematic')
const appTheme = useAppTheme()

/**
 * Refs the hit-test resolved, by the token it handed the engine. The engine's
 * `(type, index)` pair round-trips a document item exactly, but not a field,
 * which needs the property name too — so the ref is carried rather than
 * reconstructed. Populated on hit, read back on select.
 */
const hitRefs = new Map<string, SchematicItemRef>()

/**
 * The ref behind an engine callback's `(type, index)`.
 *
 * A document item round-trips through that pair exactly; a field cannot, since
 * the pair has nowhere to say WHICH field — so the hit-test stashes the ref and
 * this trades the token back for it.
 *
 * **Every** engine callback carrying a hit must come through here: rebuilding
 * a ref from `(type, index)` alone finds no item type for a field (it isn't
 * in `ITEM_TYPES`), so `itemFromHit` returns null and the drag gets nothing
 * to move.
 */
const refFromEngine = (type: string | null, index: number | null): SchematicItemRef | null =>
  (type !== null ? hitRefs.get(type) : null) ?? itemFromHit(type, index)

const itemFromHit = (type: string | null, index: number | null): SchematicItemRef | null =>
  type !== null && index !== null && (ITEM_TYPES as string[]).includes(type)
    ? { type: type as SchematicItemType, index }
    : null

// Click, band, pointer and Select Other: one model for every 2D editor
// (lib/canvasSelection.ts). The scene ranks and sweeps; the policy and the
// user's filter resolve.
const selection = useCanvasSelection<SchematicItemRef>({
  engine: () => engine,
  filterEditor: 'schematic',
  pointCandidates: (point, radius) => schematicScene?.hitCandidates(point, radius) ?? [],
  boxCandidates: (bounds, crossing) => schematicScene?.boxCandidates(bounds, crossing) ?? [],
  allows: () => allowsSchematicKind.value,
  key: schematicItemKey,
  selected: () => props.selectedItems,
  select: (items) => emit('update:selectedItems', items),
  active: () => props.activeTool === 'select' && !props.preview,
  fromEngine: refFromEngine
})
const { selectOther } = selection

onMounted(() => {
  if (!container.value) return
  engine = new ViewportEngine(container.value)
  engine.setViewOnly(!!props.preview)
  engine.onViewClick(() => {
    if (!props.pickable) return
    const hit = hitUnderPointer()
    emit('update:selectedItems', hit ? [hit] : [])
  })
  container.value.addEventListener('mouseenter', onContainerMouseEnter)
  container.value.addEventListener('mouseleave', onContainerMouseLeave)
  container.value.addEventListener('mousemove', onContainerMouseMove)
  // A viewport can mount with a tool already armed (a tab switch keeps the
  // editor's tool state), so the pointer is set here as well as on change.
  applyDrawMode()
  // Glow/underlay batches render through the engine's flattened overlay layer
  // (uniform translucency regardless of stroke overlap).
  schematicScene = new SchematicScene(engine.scene, engine.overlayScene)
  // Images decode after the rebuild that placed them; draw again when they land.
  schematicScene.onAsyncPaint = () => engine?.render()
  schematicScene.setDiffPaint(props.diffPaint ?? null)
  // The visual diff's removed-items layer; empty and invisible everywhere else.
  engine.setCompositeLayers(schematicScene.diffCompositeLayers())
  // Sheet corner handles are chrome: constant on-screen size, not world size.
  for (const t of schematicScene.screenScaledTargets()) engine.registerScreenScaled(t)
  markersLayer.install(engine)
  // The components panel resizes this viewport from the bottom; anchoring the
  // top edge keeps the visible sheet still while the panel opens and closes.
  engine.setVerticalResizeAnchor('top')
  engine.setGridSettings(props.gridSettings)
  engine.setGridAppearance(STANDARD_GRID_APPEARANCE)
  applySchematicTheme()
  engine.applyTheme()
  // KiCad-style snapped cursor crosshair (a user setting later; on for now).
  engine.setSnapCrosshair(true)
  // What a click lands on is the scene's ranking resolved against this
  // editor's policy — in the schematic everything inside a symbol resolves to
  // the symbol, except its field text. See lib/selectionResolve.ts.
  engine.setCustomHitTest((point, threshold) => {
    const candidates = schematicScene?.hitCandidates(point, threshold) ?? []
    const item = resolveHit(candidates, allowsSchematicKind.value)
    if (!item) return null
    // The ref comes back through `hitRefs`: `(type, index)` cannot say WHICH
    // field or pin.
    const key = schematicItemKey(item)
    hitRefs.set(key, item)
    return { type: key, index: item.index, key }
  })
  selection.install(engine)
  engine.onResetView(zoomToFit)
  // See PcbViewport2D: a window that closes never unmounts its components.
  engine.onViewChanged(() => {
    const key = cameraKey()
    if (key && engine) saveCamera(key, engine.getCameraState2D())
  })
  engine.onMouseMoveCoords((world, snapped) => {
    // Schematic space is y-down against the engine's y-up, so the reported
    // point negates — a readout states FILE coordinates.
    const point = props.gridSettings.snap ? snapped : world
    cursor.value = { x: point.x, y: -point.y }
    lastCursor = { x: mmToNm(snapped.x), y: mmToNm(-snapped.y) }
    if (floatAnchor) followFloat()
    updateHover(world)
    if (props.activeTool === 'sheet' && props.sheetDraftStart) {
      refreshSheetPreview()
    } else if (
      (props.activeTool === 'wire' && props.wireDraft.length > 0) ||
      props.activeTool === 'symbol' ||
      props.activeTool === 'power' ||
      props.activeTool === 'sheet_pin' ||
      isDrawTool(props.activeTool)
    ) {
      refreshToolPreview()
    }
  })
  // Where a move grabs and which grid it takes (lib/schematic/moveParts.ts):
  // engine space is y-up, the sheet y-down.
  const moveParts = (): MovePart[] => schematicMoveParts(props.schematic, props.selectedItems)
  engine.onDragAnchors(() =>
    roleAnchors(moveParts()).map((p) => new THREE.Vector2(nmToMm(p.x), -nmToMm(p.y)))
  )
  engine.onDragGrid(() =>
    roleGrid(
      moveParts().map((part) => part.role),
      spacingToMm(props.gridSettings.spacing, props.gridSettings.unit)
    )
  )
  engine.onDragStart((type, info) => {
    // A corner handle of a selected sheet: start a resize, not a move.
    if (
      type === 'vertex' &&
      typeof info?.sheetIndex === 'number' &&
      typeof info?.corner === 'string'
    ) {
      startSheetResize(info.sheetIndex, info.corner)
      return
    }
    // A point handle of a selected wire or bus: drag that point alone.
    if (
      type === 'vertex' &&
      (info?.vertexOf === 'wire' || info?.vertexOf === 'bus') &&
      typeof info.index === 'number' &&
      typeof info.vertex === 'number'
    ) {
      startVertexDrag({ type: info.vertexOf, index: info.index, vertex: info.vertex })
      return
    }
    // A vertex handle of a selected free graphic: reshape it.
    if (
      type === 'vertex' &&
      isSheetGraphicType(info?.graphicOf) &&
      typeof info.index === 'number' &&
      typeof info.vertexIndex === 'number'
    ) {
      startGraphicResize({ type: info.graphicOf, index: info.index }, info.vertexIndex)
      return
    }
    const hit = info?.held
      ? null
      : refFromEngine(
          // A free graphic's move handle names its item by `graphicOf`.
          isSheetGraphicType(info?.graphicOf)
            ? info.graphicOf
            : typeof info?.type === 'string'
              ? info.type
              : null,
          typeof info?.index === 'number' ? info.index : null
        )
    // A keyboard drag picks up the whole selection.
    dragItems = info?.held
      ? [...props.selectedItems]
      : hit
        ? props.selectedItems.some((selected) => sameSchematicRef(selected, hit))
          ? [...props.selectedItems]
          : [hit]
        : []
    dragDelta.set(0, 0)
    dragging = true
    dragPlanKey = ''
    dragBefore = null
    dragCarriedKeys = []
    dragSteps = []
    dragTurned = null
    // The net's geometry is about to go stale under the drag; drop it.
    hoveredNet = null
    schematicScene?.setNetHighlight(null)
    schematicScene?.saveDragOrigins(dragItems, riderKeys())
  })
  engine.onDragMove((delta, modifiers) => {
    if (sheetResize) {
      updateSheetResize(delta)
      return
    }
    if (vertexDrag) {
      refreshVertexDrag(delta, modifiers)
      return
    }
    if (graphicResize) {
      refreshGraphicResize(delta)
      return
    }
    dragDelta.copy(delta)
    translateDragged(delta)
    refreshDragPlan(delta, modifiers)
  })
  engine.onDragEnd((modifiers) => {
    if (sheetResize) {
      finishSheetResize()
      return
    }
    if (vertexDrag) {
      finishVertexDrag(modifiers)
      return
    }
    if (graphicResize) {
      finishGraphicResize()
      return
    }
    dragging = false
    // Engine mm (y-up) → sheet-space nm (y-down); a drag under half a
    // nanometer rounds to zero and is no move at all.
    const delta = { x: mmToNm(dragDelta.x), y: mmToNm(-dragDelta.y) }
    clearDragPreview()
    schematicScene?.clearDragOrigins()
    const steps = dragSteps
    const follow = wiresFollow(modifiers)
    heldMode = null
    if (dragItems.length && (delta.x !== 0 || delta.y !== 0 || steps.length)) {
      emit('move', dragItems, delta, { wires: follow, steps })
    } else if (dragTurned) {
      // Nothing to commit, but the canvas is showing the turned copy.
      rebuild()
    }
    dragItems = []
    dragSteps = []
    dragTurned = null
    dragDelta.set(0, 0)
    emit('drag-end')
  })
  rebuild()
})

watch(
  () => [props.revision, props.showHiddenPins, props.showHiddenFields],
  () => rebuild()
)

/**
 * Move the dragged paint by `delta` — except a sheet pin, which keeps to its
 * sheet's border, landing where the drop would put it (`sheetPinLanding`).
 * A lone pin's anchor cross travels with it; otherwise the crosses follow the
 * drag itself.
 */
const translateDragged = (delta: THREE.Vector2): void => {
  const scene = schematicScene
  if (!scene) return
  const sheets = new Set(
    dragItems.filter((item) => item.type === 'sheet').map((item) => item.index)
  )
  const pins = dragItems.filter(
    (item) => item.type === 'sheet_pin' && item.pin !== undefined && !sheets.has(item.index)
  )
  const free = dragItems.filter((item) => !pins.includes(item))
  if (free.length) scene.translateItems(free, delta)
  const sheetDelta: Point = { x: mmToNm(delta.x), y: mmToNm(-delta.y) }
  for (const item of pins) {
    const sheet = props.schematic.sheets[item.index]
    const pin = item.pin !== undefined ? sheet?.pins[item.pin] : undefined
    if (!sheet || !pin) continue
    const landing = sheetPinLanding(sheet, pin, sheetDelta).position
    const shift = enginePointOf(landing).sub(enginePointOf(pin.position))
    scene.translateElementKeys([schematicItemKey(item)], shift, !free.length)
  }
}

/** Any label or flag may ride a wire that follows, so every one of them gets
 *  a drag origin to be offset from. */
const riderKeys = (): string[] => [
  ...props.schematic.labels.map((_, index) => `label:${index}`),
  ...props.schematic.noConnects.map((_, index) => `no_connect:${index}`)
]

/** Wires follow the drag unless Shift is held: the bare move is the modifier.
 *  A keyboard drag says it by its key instead: G follows, M does not. */
const wiresFollow = (modifiers: DragModifiers): boolean =>
  heldMode ? heldMode === 'drag' : !modifiers.shift

/** The grid step in sheet nanometers — how far a wire leaves a pin before bending. */
const gridStepNm = (): Nm =>
  mmToNm(spacingToMm(props.gridSettings.spacing, props.gridSettings.unit))

const enginePointOf = (point: Point): THREE.Vector2 =>
  new THREE.Vector2(nmToMm(point.x), -nmToMm(point.y))

/** Put every wire and rider the preview stood in for back where it was. */
const clearDragPreview = (): void => {
  const scene = schematicScene
  if (!scene) return
  scene.setDragWirePreview(null)
  scene.showAllHidden()
  const zero = new THREE.Vector2(0, 0)
  for (const key of dragCarriedKeys) scene.translateElementKeys([key], zero, false)
  dragCarriedKeys = []
  dragPlanKey = ''
  dragHint.value = null
  emit('drag-verdict', null)
  if (verdictTimer) clearTimeout(verdictTimer)
  verdictTimer = null
  verdictRuns = []
  verdictBusRuns = []
  verdictJunctions = []
  // The markers and handles were following the preview; a drop that commits
  // rebuilds them anyway, one that does not gets them back here — the
  // highlighted net with them.
  applyDangling()
  if (!dragging) applyNetHighlight()
  applyHandles()
}

/**
 * Recompute the move plan when the snapped delta or the modifier changes, and
 * show it: the reshaped wires drawn over their hidden originals, riders offset
 * to where they land, the unconnected-end markers and sheet handles where they
 * will be, and the status bar saying what the drop would join or break.
 */
const refreshDragPlan = (delta: THREE.Vector2, modifiers: DragModifiers): void => {
  const scene = schematicScene
  if (!scene || !dragItems.length || props.preview) return
  const follow = wiresFollow(modifiers)
  const sheetDelta: Point = { x: mmToNm(delta.x), y: mmToNm(-delta.y) }
  const planKey = `${sheetDelta.x},${sheetDelta.y}:${follow}`
  if (planKey === dragPlanKey) return
  dragPlanKey = planKey
  resetDragPreview()
  applyHandles(delta)
  const doc = props.schematic
  const plan = planPlacement(doc, dragItems, dragSteps, sheetDelta, {
    grid: gridStepNm(),
    wires: follow
  })?.move
  // Nothing on the move connects — a text, a graphic — so there is no verdict.
  if (!plan || !plan.moved.length) return
  showMovePlan(plan, sheetDelta, follow)
}

/**
 * Draw a move plan over the sheet: the reshaped wires over their hidden
 * originals, the dots it adds and removes, riders offset to where they land,
 * and the status bar's verdict once it is in.
 */
const showMovePlan = (plan: MovePlan, sheetDelta: Point, follow: boolean): void => {
  const scene = schematicScene
  if (!scene) return
  const doc = props.schematic
  const runs: Point[][] = []
  for (const edit of plan.reshape.edits) {
    scene.setElementHidden(`wire:${edit.index}`, true)
    if (edit.points.length >= 2) runs.push(edit.points)
  }
  runs.push(...plan.reshape.added)
  // Buses follow on their own layer, drawn as buses.
  const buses = plan.busReshape
  const busRuns: Point[][] = []
  for (const edit of buses?.edits ?? []) {
    scene.setElementHidden(`bus:${edit.index}`, true)
    if (edit.points.length >= 2) busRuns.push(edit.points)
  }
  busRuns.push(...(buses?.added ?? []))
  // Junction dots the drop removes step aside; the ones it adds are previewed.
  const removedDots = new Set(
    [...plan.reshape.junctionsRemoved, ...(buses?.junctionsRemoved ?? [])].map(
      (point) => `${point.x},${point.y}`
    )
  )
  doc.junctions.forEach((junction, index) => {
    if (removedDots.has(`${junction.x},${junction.y}`))
      scene.setElementHidden(`junction:${index}`, true)
  })
  const carry = (key: string, from: Point, to: Point): void => {
    const a = enginePointOf(from)
    const b = enginePointOf(to)
    scene.translateElementKeys([key], b.sub(a), false)
    dragCarriedKeys.push(key)
  }
  for (const move of plan.labelMoves) {
    const label = doc.labels[move.index]
    if (label) carry(`label:${move.index}`, label.position, move.to)
  }
  for (const move of plan.noConnectMoves) {
    const flag = doc.noConnects[move.index]
    if (flag) carry(`no_connect:${move.index}`, flag, move.to)
  }

  verdictRuns = runs
  verdictBusRuns = busRuns
  verdictJunctions = [...plan.reshape.junctionsAdded, ...(buses?.junctionsAdded ?? [])]
  scene.setDragWirePreview(
    runs.length || busRuns.length || verdictJunctions.length ? runs : null,
    false,
    verdictJunctions,
    busRuns
  )
  dragHint.value = {
    id: 'drag',
    text: follow ? t('schematicEditor.drag.follow') : t('schematicEditor.drag.alone')
  }
  scheduleVerdict(plan, sheetDelta, follow)
}

/** Undo the preview's offsets and stand-ins, keeping the drag running. */
const resetDragPreview = (): void => {
  const scene = schematicScene
  if (!scene) return
  scene.setDragWirePreview(null)
  scene.showAllHidden()
  const zero = new THREE.Vector2(0, 0)
  for (const key of dragCarriedKeys) scene.translateElementKeys([key], zero, false)
  dragCarriedKeys = []
}

/** Grab a wire's or bus's point: its riders get drag origins to be offset from. */
const startVertexDrag = (target: VertexTarget): void => {
  vertexDrag = { target, delta: { x: nm(0), y: nm(0) } }
  dragging = true
  dragPlanKey = ''
  dragBefore = null
  dragCarriedKeys = []
  hoveredNet = null
  schematicScene?.setNetHighlight(null)
  schematicScene?.saveDragOriginKeys([
    ...riderKeys(),
    ...props.schematic.junctions.map((_, index) => `junction:${index}`)
  ])
}

/**
 * Re-plan a point drag on each grid step: the dragged line redrawn, what meets
 * the point following (a wire reshaped, a dot or label carried), the handles
 * on the new points, and the verdict — the plan the drop commits.
 */
const refreshVertexDrag = (delta: THREE.Vector2, modifiers: DragModifiers): void => {
  const scene = schematicScene
  const drag = vertexDrag
  if (!scene || !drag || props.preview) return
  const follow = wiresFollow(modifiers)
  const sheetDelta: Point = { x: mmToNm(delta.x), y: mmToNm(-delta.y) }
  drag.delta = sheetDelta
  const planKey = `${sheetDelta.x},${sheetDelta.y}:${follow}`
  if (planKey === dragPlanKey) return
  dragPlanKey = planKey
  resetDragPreview()
  const doc = props.schematic
  const { target } = drag
  if (target.type === 'bus') {
    const edits = planBusVertexDrag(doc, target, sheetDelta, follow)
    for (const edit of edits) scene.setElementHidden(`bus:${edit.index}`, true)
    scene.setDragWirePreview(
      [],
      false,
      [],
      edits.map((edit) => edit.points)
    )
    const own = edits.find((edit) => edit.index === target.index)
    if (own) renderLineHandles(target, own.points)
    engine?.render()
    return
  }
  const plan = planVertexDrag(doc, target, sheetDelta, { grid: gridStepNm(), wires: follow })
  if (!plan) return
  // The dot that meets the dragged end travels with it.
  for (const index of plan.selection.junctions) {
    const junction = doc.junctions[index]
    if (!junction) continue
    const key = `junction:${index}`
    scene.translateElementKeys(
      [key],
      enginePointOf({ x: nm(junction.x + sheetDelta.x), y: nm(junction.y + sheetDelta.y) }).sub(
        enginePointOf(junction)
      ),
      false
    )
    dragCarriedKeys.push(key)
  }
  showMovePlan(plan, sheetDelta, follow)
  const own = plan.reshape.edits.find((edit) => edit.index === target.index)
  if (own) renderLineHandles(target, own.points)
  engine?.render()
}

const finishVertexDrag = (modifiers: DragModifiers): void => {
  const drag = vertexDrag
  vertexDrag = null
  dragging = false
  heldMode = null
  clearDragPreview()
  schematicScene?.clearDragOrigins()
  if (!drag) return
  const { delta } = drag
  if (delta.x !== 0 || delta.y !== 0) {
    emit('drag-vertex', drag.target, delta, { wires: wiresFollow(modifiers) })
  } else {
    applyHandles()
    engine?.render()
  }
}

/** Grab a free graphic's vertex: the real shape steps aside for the resized preview. */
const startGraphicResize = (
  item: { type: SheetGraphicType; index: number },
  vertexIndex: number
): void => {
  const found = sheetGraphicOf(props.schematic, item)
  const origin = found ? graphicVertexPoints(found.graphic)[vertexIndex] : undefined
  if (!origin) return
  const start = { x: nm(origin.x), y: nm(origin.y) }
  graphicResize = { item, vertexIndex, origin: start, point: start }
  schematicScene?.setElementHidden(`${item.type}:${item.index}`, true)
}

/**
 * The resized shape comes off `setTypedGraphicVertex`, the typed twin of the
 * `setGraphicVertex` the commit writes through, so preview and result cannot
 * describe different geometry — and the handles ride the previewed shape.
 */
const refreshGraphicResize = (delta: THREE.Vector2): void => {
  const resize = graphicResize
  const scene = schematicScene
  const found = resize ? sheetGraphicOf(props.schematic, resize.item) : null
  if (!resize || !scene || !found) return
  resize.point = {
    x: nm(resize.origin.x + mmToNm(delta.x)),
    y: nm(resize.origin.y + mmToNm(-delta.y))
  }
  const resized = setTypedGraphicVertex(found.graphic, resize.vertexIndex, resize.point)
  scene.setSheetGraphicPreview(resized, resize.item.type === 'rule_area')
  scene.moveGraphicHandles(graphicHandles(resize.item, resized))
  engine?.render()
}

/** Put the real shape back; the commit's rebuild redraws it at its new form. */
const endGraphicResize = (): void => {
  schematicScene?.setSheetGraphicPreview(null)
  schematicScene?.showAllHidden()
}

const finishGraphicResize = (): void => {
  const resize = graphicResize
  graphicResize = null
  endGraphicResize()
  if (!resize) return
  if (resize.point.x !== resize.origin.x || resize.point.y !== resize.origin.y) {
    emit('resize-graphic', resize.item, resize.vertexIndex, resize.point)
  } else {
    applyHandles()
    engine?.render()
  }
}

/**
 * The verdict: this sheet alone, before against after. Names that join or
 * come apart across sheets do so by label, which a move never changes.
 * Coalesced: a step that lands while one is pending replaces it.
 */
const scheduleVerdict = (plan: MovePlan, sheetDelta: Point, follow: boolean): void => {
  if (verdictTimer) clearTimeout(verdictTimer)
  const delay = verdictMs > SLOW_VERDICT_MS ? QUIET_VERDICT_DELAY_MS : 0
  verdictTimer = setTimeout(() => {
    verdictTimer = null
    if (!dragging) return
    const started = performance.now()
    renderVerdict(plan, sheetDelta, follow)
    verdictMs = performance.now() - started
  }, delay)
}

const renderVerdict = (plan: MovePlan, sheetDelta: Point, follow: boolean): void => {
  const scene = schematicScene
  if (!scene) return
  const doc = props.schematic
  const sheetPath = props.sheetPath ?? '/'
  const read = (schematic: KicadSchematic): SchematicConnectivity | null => {
    try {
      return buildConnectivity([{ sheetPath, namePath: '/', schematic }])
    } catch {
      return null
    }
  }
  dragBefore ??= read(doc)
  const after = read(previewMovedSchematic(dragTurned ?? doc, plan, sheetDelta))
  // The open-end rings are a reading of the sheet, so they come from the same
  // reading the verdict does and travel with the pins they mark.
  if (after) applyDangling(after)
  const changes = dragBefore && after ? netChanges(dragBefore, after) : null
  const alert = !!changes && (changes.merges.length > 0 || changes.splits.length > 0)
  scene.setDragWirePreview(
    verdictRuns.length || verdictBusRuns.length || verdictJunctions.length ? verdictRuns : null,
    alert,
    verdictJunctions,
    verdictBusRuns
  )
  const merge = changes?.merges[0]
  const split = changes?.splits[0]
  const connect = changes?.connects[0]
  // The verdict is a readout, Properties' (DESIGN.md §Viewport status strips); the
  // corner keeps the hint.
  emit(
    'drag-verdict',
    merge
      ? { kind: 'merges', text: t('schematicEditor.drag.merges', { a: merge[0], b: merge[1] }) }
      : split
        ? { kind: 'splits', text: t('schematicEditor.drag.splits', { net: split }) }
        : connect
          ? {
              kind: 'connects',
              text: t('schematicEditor.drag.connects', { member: connect.member, net: connect.net })
            }
          : null
  )
  dragHint.value = {
    id: 'drag',
    text: follow ? t('schematicEditor.drag.follow') : t('schematicEditor.drag.alone')
  }
  engine?.render()
}

/**
 * A turn or flip pressed while a drag is in progress: about the cursor, which
 * is the point the user is holding. The step is recorded against the
 * selection's original coordinates, the canvas is rebuilt from the turned
 * sheet, and the drag carries on translating it. Returns false when no drag
 * is running, so the key can mean the in-place turn instead.
 */
const applyDragTransform = (op: TransformOp): boolean => {
  // A point being dragged has nothing to turn; the key is spent all the same,
  // so it cannot turn the selection under the drag.
  if (vertexDrag || graphicResize) return true
  const scene = schematicScene
  if (!dragging || !dragItems.length || !scene || props.preview || sheetResize) return false
  // About the grab anchor under the cursor, as KiCad's; a float has no engine
  // drag, and turns about the cursor it hangs from.
  const anchor = engine?.dragAnchorStart()
  const shift: Point = { x: mmToNm(dragDelta.x), y: mmToNm(-dragDelta.y) }
  const cursor = lastCursor ?? shift
  dragSteps.push({
    op,
    pivot: anchor
      ? { x: mmToNm(anchor.x), y: mmToNm(-anchor.y) }
      : { x: nm(cursor.x - shift.x), y: nm(cursor.y - shift.y) }
  })
  dragTurned = turnedSchematic(props.schematic, dragItems, dragSteps, props.sheetPath)
  clearDragPreview()
  scene.rebuild(dragTurned)
  applySelection()
  scene.saveDragOrigins(dragItems, riderKeys())
  translateDragged(dragDelta)
  if (!floatAnchor) refreshDragPlan(dragDelta, { shift: false, alt: false, ctrl: false })
  engine?.render()
  return true
}

/**
 * Escape mid-drag: everything goes back where it was and nothing is
 * committed — the moved items, a mid-drag turn, the wires the preview stood
 * in for, a sheet corner being resized. False when no drag is running.
 */
const cancelDrag = (): boolean => {
  const floating = floatAnchor !== null
  floatAnchor = null
  if (!floating && !engine?.cancelDrag()) return false
  heldMode = null
  if (vertexDrag) {
    vertexDrag = null
    dragging = false
    clearDragPreview()
    schematicScene?.clearDragOrigins()
    engine?.render()
    return true
  }
  if (graphicResize) {
    graphicResize = null
    endGraphicResize()
    applyHandles()
    engine?.render()
    return true
  }
  if (sheetResize) {
    sheetResize = null
    schematicScene?.setSheetPreview(null)
    applyHandles()
    return true
  }
  dragging = false
  clearDragPreview()
  schematicScene?.translateItems(dragItems, new THREE.Vector2(0, 0))
  schematicScene?.clearDragOrigins()
  if (dragTurned) rebuild()
  dragItems = []
  dragSteps = []
  dragTurned = null
  dragDelta.set(0, 0)
  engine?.render()
  if (floating) emit('float-cancel')
  return true
}

// ---- Floating move: a paste or duplicate hangs from the cursor, no button
// held, and a click lands it (KiCad's move after paste). It rides the drag's
// own machinery — origins, translation, turns about the cursor — but plans no
// wires: what floats is new, and nothing already drawn follows it.

/** Hang `items` from the cursor by `anchor` (sheet nm) until a click or Escape. */
const startFloat = (items: SchematicItemRef[], anchor: Point): void => {
  if (!engine || !schematicScene || props.preview) return
  cancelDrag()
  dragItems = [...items]
  dragging = true
  dragSteps = []
  dragTurned = null
  dragDelta.set(0, 0)
  clearHover()
  schematicScene.saveDragOrigins(dragItems, riderKeys())
  floatAnchor = anchor
  followFloat()
}

const followFloat = (): void => {
  if (!floatAnchor || !lastCursor) return
  dragDelta.set(nmToMm(nm(lastCursor.x - floatAnchor.x)), -nmToMm(nm(lastCursor.y - floatAnchor.y)))
  translateDragged(dragDelta)
  engine?.render()
}

/** Pan still pans; a left click lands, a right click abandons. */
const onFloatMouseDown = (event: MouseEvent): boolean => {
  if (event.button === 1 || ((event.ctrlKey || event.metaKey) && event.button === 0)) return false
  event.stopPropagation()
  event.preventDefault()
  if (event.button === 2) {
    cancelDrag()
    return true
  }
  if (event.button !== 0) return true
  const delta: Point = { x: mmToNm(dragDelta.x), y: mmToNm(-dragDelta.y) }
  const steps = dragSteps
  floatAnchor = null
  dragging = false
  clearDragPreview()
  schematicScene?.clearDragOrigins()
  dragItems = []
  dragSteps = []
  dragTurned = null
  dragDelta.set(0, 0)
  emit('float-land', delta, steps)
  return true
}

// The pointer says which mode the editor is in — pick, or place — and wiring
// draws, so it takes the pencil rather than the pick crosshair. One engine
// call, so every editor answers it the same way (ARCHITECTURE, DESIGN.md).
const applyDrawMode = (): void => {
  const tool = props.activeTool
  const draws = tool === 'wire' || tool === 'bezier' || isRunTool(tool) || isTwoClickTool(tool)
  engine?.setDrawMode(tool !== 'select', draws ? drawCursor : undefined)
}

watch(() => props.activeTool, applyDrawMode)

watch(appTheme, () => {
  applySchematicTheme()
  schematicScene?.applyTheme()
  engine?.applyTheme()
  rebuild()
})
watch(
  () => props.selectedItems,
  () => {
    applySelection()
    // A press on an unselected item selects it and starts its drag in one
    // mousedown; the selection lands here a tick later, after the origins
    // were saved, so the fresh halo has none and would stay behind. Nothing
    // has moved yet at this point, so saving again is exact.
    if (dragging && dragDelta.lengthSq() === 0) {
      schematicScene?.saveDragOrigins(dragItems, riderKeys())
    }
    engine?.render()
  },
  { deep: true }
)

watch(
  () => props.gridSettings,
  (settings) => engine?.setGridSettings(settings),
  { deep: true }
)

// The editor owns the sheet preview once the rectangle is fixed (while its
// name/file are typed). Sheet space (y-down) → engine space (y-up) is a y flip.
watch(
  () => props.pendingSheetRect,
  (rect) => {
    if (!schematicScene) return
    schematicScene.setSheetPreview(
      rect ? { x0: rect.x0, y0: -rect.y0, x1: rect.x1, y1: -rect.y1 } : null
    )
    engine?.render()
  }
)

// Two-click draw: show the preview as soon as the first click lands, and clear
// it if the draft is cancelled (Escape) without a rectangle being fixed.
watch(
  () => props.sheetDraftStart,
  (start) => {
    if (start) refreshSheetPreview()
    else if (!props.pendingSheetRect) {
      schematicScene?.setSheetPreview(null)
      engine?.render()
    }
  }
)

// Arm/disarm and draft edits (clicks, backspace-unwind, posture toggle,
// placement rotation) all re-derive the previews; leaving select mode also
// drops any stale net hover.
watch(
  () =>
    [
      props.activeTool,
      props.wireDraft,
      props.wirePosture,
      props.placement,
      props.placementSheet,
      props.drawDraft,
      props.heldDraft,
      props.busEntrySize,
      props.directiveShape,
      props.imageData
    ] as const,
  () => {
    if (props.activeTool !== 'select') clearHover()
    refreshToolPreview()
  },
  { deep: true }
)

onUnmounted(() => {
  container.value?.removeEventListener('mouseenter', onContainerMouseEnter)
  container.value?.removeEventListener('mouseleave', onContainerMouseLeave)
  container.value?.removeEventListener('mousemove', onContainerMouseMove)
  schematicScene?.dispose()
  markersLayer.dispose()
  engine?.destroy()
  schematicScene = null
  engine = null
})

/**
 * KiCad's Move (M) and Drag (G) from the keyboard: the selection picks up at
 * the pointer and follows it until a click drops it, the wires following for
 * a drag and staying for a move; Escape abandons it. False when there is
 * nothing to pick up or a drag is already running.
 */
const startHeldDrag = (mode: 'move' | 'drag'): boolean => {
  if (!engine || props.preview || !props.selectedItems.length || dragging) return false
  heldMode = mode
  if (!engine.beginHeldDrag({ held: true })) {
    heldMode = null
    return false
  }
  // Nothing has moved yet: say which of the two this is.
  dragHint.value = {
    id: 'drag',
    text: mode === 'drag' ? t('schematicEditor.drag.follow') : t('schematicEditor.drag.alone')
  }
  return true
}

/** Take keyboard focus — Escape in a property field hands the canvas back. */
const focusCanvas = (): void => container.value?.focus()

// A new paint arrives with a new sheet (the visual diff's Before / Diff /
// After), so it repaints the sheet in hand. The camera is left where it is:
// all three are the same file, and the point of switching is to compare a place.
watch(
  () => props.diffPaint,
  (paint) => {
    if (!schematicScene) return
    schematicScene.setDiffPaint(paint ?? null)
    rebuild()
  }
)

/**
 * Select All: a band over the whole sheet under the selection filter, so it
 * takes exactly what a sweep could — symbols with their fields, not the fields
 * on their own.
 */
const selectAll = (): SchematicItemRef[] => selection.selectAll()

defineExpose({
  selectAll,
  zoomToFit,
  runViewCommand,
  selectOtherAt: selection.selectOtherAt,
  netAtPointer,
  itemAtCursor: hitUnderPointer,
  focusIndices,
  focusAt,
  showFinding,
  focusCanvas,
  captureForAgent,
  applyDragTransform,
  cancelDrag,
  startHeldDrag,
  getCursor,
  startFloat
})
</script>

<template>
  <div
    ref="container"
    class="schematic-viewport"
    tabindex="-1"
    @mousedown.capture="onMouseDownCapture"
    @dblclick.capture="onDblClickCapture"
    @contextmenu="onContextMenu"
  >
    <AgentViewportOverlay
      v-if="agentViewports.length"
      :viewports="agentViewports"
      :to-screen="agentView.toScreen"
      :marker-insets="agentView.markerInsets"
      @reveal="agentView.reveal"
    />
    <ViewportStatusBar v-if="!bare" side="left" :items="hintItems" />
    <ViewportStatusBar v-if="!bare" :coords="statusCoords">
      <GridSettingsControl
        v-if="!preview"
        editor="schematic"
        :grid-settings="gridSettings"
        @update-grid="(g) => emit('update-grid', g)"
      />
      <SelectionFilterControl v-if="!preview || pickable" editor="schematic" :pinless="preview" />
      <slot v-if="!preview" name="status" />
    </ViewportStatusBar>
    <SelectOtherMenu
      v-if="selectOther"
      :items="selectOther.items"
      :label="labelSchematicItem"
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
.schematic-viewport:focus,
.schematic-viewport:focus-visible {
  outline: none;
}

.schematic-viewport {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
}
</style>
