import * as THREE from 'three'
import {
  KicadFootprint,
  KicadPad,
  KicadFpLine,
  KicadFpArc,
  KicadFpCircle,
  KicadFpRect,
  KicadFontEffects,
  KicadZone,
  KicadFpPoly,
  KicadProperty,
  KicadFpText,
  footprintTextDrawAngle,
  expandFootprintText,
  footprintTextScope,
  type KicadExtraGraphic,
  isSolidFill
} from '../kicad/footprint'
import {
  extraGraphicDistance,
  extraGraphicDrawing,
  extraGraphicExtent
} from '../board/extraGraphics'
import { arcPolyline } from './arcGeometry'

/**
 * A footprint's Béziers, points, text boxes and tables under their item types,
 * in the order they draw and hit-test in.
 */
export function footprintExtraCollections(
  fp: KicadFootprint
): Array<readonly [string, readonly KicadExtraGraphic[]]> {
  return [
    ['curve', fp.fpCurves],
    ['point', fp.points],
    ['textbox', fp.fpTextBoxes],
    ['table', fp.tables]
  ]
}

/** Footprint file space (nm, y down) → engine space (mm, y up). */
const engineSpace = (p: { x: number; y: number }): { x: number; y: number } => ({
  x: p.x / NM_PER_MM,
  y: -p.y / NM_PER_MM
})
import {
  DEFAULT_PCB_LAYER,
  DIM_ALPHA_FACTOR,
  LayerStack,
  ZONE_FILL_ALPHA,
  baseLayerAlpha,
  expandLayerToken,
  layerSlot,
  resolveWildcardLayer,
  SELECTED_BAND,
  zoneHatchRises,
  type LayerDepth
} from '../kicad/layers'
import { currentAppTheme, kicadLayerColorsForTheme, themeColor, type AppTheme } from '../theme'
import { dimToward } from './boardView'
import { getTextStrokes, strokeOptionsFromEffects } from '../kicad/newstroke'
import { createHatchMaterial, HATCH_PATTERN } from './HatchShader'
import { holeAnnulus, holePalette, holeWallWidth, padHoleShape, type HolePalette } from './holes'
import { LayeredLabelBatch, LayeredPrimitiveBatch } from './LayeredBatch'
import { PaintOrder } from '../kicad/paintOrder'
import { liftFillMesh, placeFillMesh, selectionShift } from './selectedBand'
import { soleSelection, VertexHandles, type VertexHandleSpec } from './VertexHandles'
import type { ScreenScaled } from './ViewportEngine'
import type { NonActiveLayerDisplay } from '../board/layerPresets'
import type { HitCandidate } from '../selectionResolve'
import { nm, NM_PER_MM, nmToMm } from '../kicad/coordinates'
import { padCopperPieces, padHasPrimitives, padOutline, padPointDistance } from '../board/padCopper'
import { fractureRegion } from '../board/zoneFill'

/**
 * The selection-filter kind for a footprint item type.
 *
 * Coarser than the hit-test's type, the same way `boardItemKind` is: a user
 * filters "Graphics", not `rect` separately from `poly`, and both a `property`
 * and an `fp_text` are just text. `SELECTABLE_KINDS.footprint`
 * (lib/selectionResolve.ts) lists the values this returns.
 */
export function footprintItemKind(type: string): string {
  switch (type) {
    case 'line':
    case 'arc':
    case 'circle':
    case 'rect':
    case 'poly':
    case 'curve':
      return 'graphic'
    // A text box and a table are text, as KiCad's filter has them.
    case 'property':
    case 'text':
    case 'textbox':
    case 'table':
      return 'text'
    default:
      // pad, zone — their type is already the kind.
      return type
  }
}

/** The `locked` flag behind a footprint item, for the filter's Locked switch. */
export function footprintItemLocked(
  fp: KicadFootprint,
  ref: { type: string; index: number }
): boolean {
  switch (ref.type) {
    case 'pad':
      return fp.pads[ref.index]?.locked ?? false
    case 'line':
      return fp.fpLines[ref.index]?.locked ?? false
    case 'arc':
      return fp.fpArcs[ref.index]?.locked ?? false
    case 'circle':
      return fp.fpCircles[ref.index]?.locked ?? false
    case 'rect':
      return fp.fpRects[ref.index]?.locked ?? false
    case 'poly':
      return fp.fpPolys[ref.index]?.locked ?? false
    case 'property':
      return fp.properties[ref.index]?.locked ?? false
    case 'text':
      return fp.fpTexts[ref.index]?.locked ?? false
    case 'curve':
      return fp.fpCurves[ref.index]?.locked ?? false
    case 'textbox':
      return fp.fpTextBoxes[ref.index]?.locked ?? false
    case 'table':
      return fp.tables[ref.index]?.locked ?? false
    default:
      // Footprint zones carry no lock flag in the format.
      return false
  }
}

/**
 * Tie-break between items a click is equally near, the board's order
 * (`BOARD_TYPE_RANK`, BoardScene.ts) under the footprint's type names: a
 * graphic before text before a zone before a pad, so a line drawn over a pad
 * is reachable where both are under the cursor.
 */
export const FOOTPRINT_TYPE_RANK: Record<string, number> = {
  line: 3,
  arc: 4,
  circle: 5,
  rect: 6,
  poly: 7,
  curve: 7.2,
  point: 7.4,
  property: 8,
  text: 8,
  textbox: 8.2,
  table: 8.4,
  zone: 9,
  pad: 9.5
}

/** One thing the cursor is over, with what the ranking sorts on. */
export interface RankedFootprintHit {
  ref: { type: string; index: number }
  kind: string
  locked: boolean
  dist: number
  /** `FOOTPRINT_TYPE_RANK` for the item's type. */
  rank: number
  /** Registration order, which is the order the hit-test loops run in. */
  order: number
}

/** Nearest first; at equal distance by type rank, then in registration order. */
export function rankFootprintHits(found: RankedFootprintHit[]): RankedFootprintHit[] {
  return found.sort((a, b) => a.dist - b.dist || a.rank - b.rank || a.order - b.order)
}

/**
 * A footprint text's glyph extent in its own frame (mm), padded by half the
 * stroke — the click test's box and the band's, so the two agree on how big a
 * text is. Null when there is nothing to measure.
 */
export function footprintTextLocalBox(
  text: string,
  fontEffects: KicadFontEffects | undefined
): { xMin: number; xMax: number; yMin: number; yMax: number } | null {
  if (!text) return null
  const thickness = fontEffects?.thickness !== undefined ? nmToMm(fontEffects.thickness) : 0.15
  const { strokes } = getTextStrokes(text, {
    width: fontEffects?.width !== undefined ? nmToMm(fontEffects.width) : 1.27,
    height: fontEffects?.height !== undefined ? nmToMm(fontEffects.height) : 1.27,
    thickness,
    italic: fontEffects?.italic ?? false,
    mirror: fontEffects?.mirror ?? false
  })
  if (strokes.length === 0) return null
  let xMin = Infinity
  let xMax = -Infinity
  let yMin = Infinity
  let yMax = -Infinity
  for (const s of strokes) {
    xMin = Math.min(xMin, s.x1, s.x2)
    xMax = Math.max(xMax, s.x1, s.x2)
    yMin = Math.min(yMin, s.y1, s.y2)
    yMax = Math.max(yMax, s.y1, s.y2)
  }
  const pad = thickness / 2
  return { xMin: xMin - pad, xMax: xMax + pad, yMin: yMin - pad, yMax: yMax + pad }
}

/** What `footprintBoxSelect` needs from a live scene. */
export interface FootprintBoxSelectContext {
  /** Whether items on the layer can be selected (drawn, and not hidden by the layer mode). */
  isLayerVisible: (layer: string | undefined) => boolean
}

/**
 * Everything a band takes, in engine space (mm, y up) as the band arrives —
 * the collections `hitCandidates` walks, under its layer rules, each tested by
 * its extent: a pad by its rotated outline, a text by its rotated glyph box,
 * an arc by its sampled curve. `crossing` takes what the band touches, a
 * window what it contains. Split out of the scene, as `boardBoxSelect` is,
 * because the scene cannot be built without a DOM.
 */
export function footprintBoxSelect(
  fp: KicadFootprint,
  bounds: { xMin: number; xMax: number; yMin: number; yMax: number },
  crossing: boolean,
  context: FootprintBoxSelectContext
): Array<{ type: string; index: number }> {
  const { isLayerVisible } = context
  const box = new THREE.Box2(
    new THREE.Vector2(Math.min(bounds.xMin, bounds.xMax), Math.min(bounds.yMin, bounds.yMax)),
    new THREE.Vector2(Math.max(bounds.xMin, bounds.xMax), Math.max(bounds.yMin, bounds.yMax))
  )
  const selected: Array<{ type: string; index: number }> = []
  const scratch = new THREE.Box2()
  const mm = (p: { x: number; y: number }): { x: number; y: number } => ({
    x: p.x / NM_PER_MM,
    y: -p.y / NM_PER_MM
  })
  /** Take the item when its extent — points plus half a stroke — meets the band. */
  const take = (
    type: string,
    index: number,
    points: Array<{ x: number; y: number }>,
    halfWidth = 0
  ): void => {
    if (points.length === 0) return
    scratch.makeEmpty()
    for (const p of points) scratch.expandByPoint(new THREE.Vector2(p.x, p.y))
    if (halfWidth > 0) scratch.expandByScalar(halfWidth)
    if (crossing ? box.intersectsBox(scratch) : box.containsBox(scratch))
      selected.push({ type, index })
  }
  const half = (width: number | undefined, fallback: number): number =>
    (width !== undefined ? width / NM_PER_MM : fallback) / 2
  /** The four corners of a local box about a center, turned by `radians`. */
  const turnedCorners = (
    center: { x: number; y: number },
    local: { xMin: number; xMax: number; yMin: number; yMax: number },
    radians: number
  ): Array<{ x: number; y: number }> => {
    const cos = Math.cos(radians)
    const sin = Math.sin(radians)
    return [
      [local.xMin, local.yMin],
      [local.xMax, local.yMin],
      [local.xMax, local.yMax],
      [local.xMin, local.yMax]
    ].map(([x, y]) => ({ x: center.x + x * cos - y * sin, y: center.y + x * sin + y * cos }))
  }

  fp.pads.forEach((pad, index) => {
    if (!pad.layers.some((l) => isLayerVisible(l))) return
    const w = nmToMm(pad.size.w) / 2
    const h = nmToMm(pad.size.h) / 2
    const corners = turnedCorners(
      mm(pad.position),
      { xMin: -w, xMax: w, yMin: -h, yMax: h },
      THREE.MathUtils.degToRad(pad.position.angle ?? 0)
    )
    take('pad', index, corners)
  })

  fp.fpLines.forEach((line, index) => {
    if (!isLayerVisible(line.layer)) return
    take('line', index, [mm(line.start), mm(line.end)], half(line.strokeWidth, 0.05))
  })

  fp.fpArcs.forEach((arc, index) => {
    if (!isLayerVisible(arc.layer)) return
    take(
      'arc',
      index,
      arcPolyline(mm(arc.start), mm(arc.mid), mm(arc.end)),
      half(arc.strokeWidth, 0.05)
    )
  })

  fp.fpCircles.forEach((circle, index) => {
    if (!isLayerVisible(circle.layer)) return
    const r = Math.hypot(circle.end.x - circle.center.x, circle.end.y - circle.center.y) / NM_PER_MM
    take('circle', index, [mm(circle.center)], r + half(circle.strokeWidth, 0.05))
  })

  fp.fpRects.forEach((rect, index) => {
    if (!isLayerVisible(rect.layer)) return
    take('rect', index, [mm(rect.start), mm(rect.end)], half(rect.strokeWidth, 0.12))
  })

  fp.fpPolys.forEach((poly, index) => {
    if (!isLayerVisible(poly.layer) || poly.points.length < 2) return
    take('poly', index, poly.points.map(mm), half(poly.strokeWidth, 0.05))
  })

  // The outline, as the board takes a zone.
  fp.zones.forEach((zone, index) => {
    if (!isLayerVisible(zone.layer) || zone.points.length < 3) return
    take('zone', index, zone.points.map(mm))
  })

  for (const [type, items] of footprintExtraCollections(fp)) {
    items.forEach((item, index) => {
      if (!isLayerVisible(item.layer)) return
      take(type, index, extraGraphicExtent(item).map(mm))
    })
  }

  const texts: Array<
    readonly [
      string,
      Array<{
        text: string
        position?: { x: number; y: number; angle?: number }
        keepUpright?: boolean
        layer?: string
        hide?: boolean
        fontEffects?: KicadFontEffects
      }>
    ]
  > = [
    ['property', fp.properties.map((p) => ({ ...p, text: p.value }))],
    ['text', fp.fpTexts]
  ]
  for (const [type, items] of texts) {
    items.forEach((item, index) => {
      if (!item.position || item.hide || !isLayerVisible(item.layer)) return
      const local = footprintTextLocalBox(item.text, item.fontEffects)
      if (!local) return
      const angle = footprintTextDrawAngle(item.position.angle, item.keepUpright ?? false)
      take(type, index, turnedCorners(mm(item.position), local, THREE.MathUtils.degToRad(angle)))
    })
  }

  return selected
}

/** Which item classes draw as outlines only (KiCad's sketch display modes). */
export interface FootprintSketch {
  pads: boolean
  graphics: boolean
  text: boolean
}

/** Negative alpha = the batch shader's sketch (outline) mode; see BoardScene. */
function sketchSign(sketch: boolean, alpha: number): number {
  return sketch ? -Math.max(alpha, 0.05) : alpha
}

const DRAFT_PREVIEW_KEY = '__draft_preview'
const DRAFT_PREVIEW_ALPHA = 0.55

export class FootprintScene {
  private scene: THREE.Scene
  private footprintGroup: THREE.Group
  private padMeshGroup: THREE.Group
  private graphicGroup: THREE.Group
  private textGroup: THREE.Group
  private currentActiveLayer?: string

  // All strokes, pads, drills and rings render as SDF instances, one batch per
  // layer slot so the translucent fills between them land in paint order
  private batch: LayeredPrimitiveBatch
  // Pad number labels: instanced quads over a shared SDF glyph atlas
  private labelBatch: LayeredLabelBatch

  // Plating and holes
  private holes: HolePalette = holePalette()

  // Standard KiCad Colors Map
  private layerColors: Record<string, THREE.Color> = {}

  private selectionLighten = true

  /** Every layer's slot; every z the scene emits comes from it. */
  private readonly layers = new LayerStack()
  /** What draws over what for the active layer (ARCHITECTURE.md, Paint order). */
  private paint = new PaintOrder()

  // Selection mapping references
  private padsList: THREE.Object3D[] = []
  private graphicsList: THREE.Object3D[] = []
  private polysList: THREE.Object3D[] = []

  // Anchor objects per element: hold userData (type/index), the drag pivot
  // position, and any non-batched children (pad label sprites, fill meshes)
  private elements: Record<string, THREE.Object3D> = {}
  private vertexHandles: VertexHandles
  private currentFootprint?: KicadFootprint
  private currentLayerVisibility?: Record<string, boolean>
  private nonActiveDisplay: NonActiveLayerDisplay = 'show'
  /** Outline-only drawing per item class — lib/footprintView.ts. */
  private sketch: FootprintSketch = { pads: false, graphics: false, text: false }

  // Material cache for fill meshes (zone/poly/rect solid fills)
  private materialCache: Map<string, THREE.MeshBasicMaterial> = new Map()
  /** The canvas color, which a dimmed layer's color sinks toward. */
  private background = new THREE.Color(themeColor('--vscode-bg-viewport', '#101513'))
  private onRebuilt: (() => void) | null = null

  constructor(scene: THREE.Scene) {
    this.scene = scene

    this.footprintGroup = new THREE.Group()
    this.padMeshGroup = new THREE.Group()
    this.graphicGroup = new THREE.Group()
    this.textGroup = new THREE.Group()
    this.vertexHandles = new VertexHandles(scene)

    this.footprintGroup.add(this.padMeshGroup)
    this.footprintGroup.add(this.graphicGroup)
    this.footprintGroup.add(this.textGroup)

    this.scene.add(this.footprintGroup)

    this.batch = new LayeredPrimitiveBatch(
      layerSlot,
      (slot) => this.paint.renderOrder(slot, 'stroke'),
      { minStrokePixels: 1 },
      512,
      SELECTED_BAND
    )
    this.scene.add(this.batch.group)

    this.labelBatch = new LayeredLabelBatch(
      layerSlot,
      (slot) => this.paint.renderOrder(slot, 'label'),
      128,
      SELECTED_BAND
    )
    this.scene.add(this.labelBatch.group)

    this.applyTheme(currentAppTheme())
  }

  /**
   * Every color the scene draws with, for one theme. One entry point rather
   * than a setter per concern: a viewport applies a theme, it does not manage
   * a palette, a selection direction and a label ink separately.
   */
  public applyTheme(theme: AppTheme): void {
    this.setLayerColors(kicadLayerColorsForTheme(theme))
    this.background.set(themeColor('--vscode-bg-viewport', '#101513'))
    this.selectionLighten = theme === 'dark'
    this.holes = holePalette()
    this.labelBatch.setColor(themeColor('--vscode-canvas-pad-number', '#101513'))
    this.vertexHandles.applyTheme()
  }

  private setLayerColors(colors: Readonly<Record<string, string>>): void {
    this.layerColors = {}
    Object.entries(colors).forEach(([layer, hex]) => {
      this.layerColors[layer] = new THREE.Color(hex)
    })
  }

  public rebuild(
    fp: KicadFootprint,
    layerVisibility?: Record<string, boolean>,
    activeLayer?: string,
    nonActiveDisplay: NonActiveLayerDisplay = 'show'
  ): THREE.Box3 {
    this.currentActiveLayer = activeLayer
    this.currentLayerVisibility = layerVisibility
    this.nonActiveDisplay = nonActiveDisplay
    this.currentFootprint = fp
    this.paint = new PaintOrder({ activeLayer })
    this.batch.reorder((slot) => this.paint.renderOrder(slot, 'stroke'))
    this.labelBatch.reorder((slot) => this.paint.renderOrder(slot, 'label'))
    this.clear()
    this.currentLayerVisibility = layerVisibility

    // 1. Render Pads
    fp.pads.forEach((pad, index) => {
      // Filter to only the layers that are currently visible
      const visibleLayers = pad.layers.filter((l) => this.isLayerVisible(l, layerVisibility))
      if (visibleLayers.length > 0) {
        this.renderPad(pad, index, visibleLayers)
      }
    })

    // 2. Render Graphic Lines (rects render separately via renderRect)
    fp.fpLines.forEach((line, index) => {
      if (this.isLayerVisible(line.layer, layerVisibility)) {
        this.renderLine(line, index)
      }
    })

    // 3. Render Arcs
    fp.fpArcs.forEach((arc, index) => {
      if (this.isLayerVisible(arc.layer, layerVisibility)) {
        this.renderArc(arc, index)
      }
    })

    // 4. Render Circles
    fp.fpCircles.forEach((circle, index) => {
      if (this.isLayerVisible(circle.layer, layerVisibility)) {
        this.renderCircle(circle, index)
      }
    })

    // 4.1 Render Rectangles
    if (fp.fpRects) {
      fp.fpRects.forEach((rect, index) => {
        if (this.isLayerVisible(rect.layer, layerVisibility)) {
          this.renderRect(rect, index)
        }
      })
    }

    // 4.5. Render Zones
    fp.zones.forEach((zone, index) => {
      if (this.isLayerVisible(zone.layer, layerVisibility)) {
        this.renderZone(zone, index)
      }
    })

    // 4.6. Render Polygons (fpPolys)
    fp.fpPolys.forEach((poly, index) => {
      if (this.isLayerVisible(poly.layer, layerVisibility)) {
        this.renderPoly(poly, index)
      }
    })

    // 4.7. Béziers, points, text boxes and tables (lib/board/extraGraphics.ts)
    for (const [type, items] of footprintExtraCollections(fp)) {
      items.forEach((item, index) => {
        if (this.isLayerVisible(item.layer, layerVisibility)) {
          this.renderExtraGraphic(type, index, item)
        }
      })
    }

    // 5. Render Texts. A text can name the footprint's own fields (`${REFERENCE}`
    // on the fab layer is the common one); drawn resolved, as KiCad draws it.
    const textScope = footprintTextScope(fp)
    fp.properties.forEach((prop: KicadProperty, index) => {
      if (prop.position && !prop.hide && this.isLayerVisible(prop.layer, layerVisibility)) {
        this.renderTextLabel(
          'property',
          index,
          expandFootprintText(prop.value, textScope),
          prop.position,
          prop.keepUpright,
          prop.layer ?? 'F.SilkS',
          prop.fontEffects
        )
      }
    })
    fp.fpTexts.forEach((text: KicadFpText, index) => {
      if (text.position && !text.hide && this.isLayerVisible(text.layer, layerVisibility)) {
        this.renderTextLabel(
          'text',
          index,
          expandFootprintText(text.text, textScope),
          text.position,
          text.keepUpright,
          text.layer ?? 'F.SilkS',
          text.fontEffects
        )
      }
    })

    // Sort instances by z so translucent layers (mask/paste) blend correctly
    this.batch.finalizeSorted()

    // Calculate bounding box for zoom-to-fit
    const bbox = new THREE.Box3()
    bbox.setFromObject(this.footprintGroup)
    this.batch.getBounds(bbox)
    this.labelBatch.getBounds(bbox)
    // A rebuild makes new meshes, so whoever is flattening dim layers is now
    // holding meshes for a footprint that no longer exists. Announced here
    // rather than left to eight call sites to remember.
    this.onRebuilt?.()
    return bbox
  }

  /**
   * Set the outline-only modes. Instance data, like dim, so it takes effect on
   * the next rebuild — the viewport rebuilds when these change.
   */
  public setSketch(sketch: FootprintSketch): void {
    this.sketch = { ...sketch }
  }

  /** Called after every rebuild — see the note in `rebuild`. */
  public setRebuiltCallback(cb: () => void): void {
    this.onRebuilt = cb
  }

  /**
   * Whether a layer (possibly wildcard) includes the active layer. A footprint
   * has no stackup of its own, so `*.Cu` is the outer pair here — it is the
   * board a footprint lands on that decides how deep it really goes.
   */
  private layerMatchesActive(layer: string): boolean {
    const active = this.currentActiveLayer
    if (!active) return true
    return expandLayerToken(layer).includes(active)
  }

  /**
   * Whether a layer is dimmed because it is not the one being worked on. Dim
   * is instance data here, written into the layer's color at build
   * (`getLayerColor`); the viewport rebuilds when the mode changes.
   */
  private isDimmed(layer: string | undefined): boolean {
    if (this.nonActiveDisplay !== 'dim' || !layer) return false
    return !this.layerMatchesActive(layer)
  }

  private isLayerVisible(
    layer: string | undefined,
    visibility: Record<string, boolean> | undefined
  ): boolean {
    if (!layer) return true

    // 'hide' mode: only the active layer renders
    if (this.nonActiveDisplay === 'hide' && !this.layerMatchesActive(layer)) return false

    if (!visibility) return true

    return expandLayerToken(layer).some((l) => visibility[l] ?? true)
  }

  private disposeObject(obj: THREE.Object3D): void {
    if (obj instanceof THREE.Mesh) {
      obj.geometry.dispose()
      // Don't dispose cached materials — they are shared, unless they were cloned for highlighting
      const materials = Array.isArray(obj.material) ? obj.material : [obj.material]
      materials.forEach((m) => {
        if (m) {
          const isCloned = m.userData?.isCloned
          const cacheKey = m.userData?.cacheKey
          if (isCloned || !cacheKey || !this.materialCache.has(cacheKey)) {
            m.dispose()
          }
        }
      })
    } else if (obj instanceof THREE.Sprite) {
      obj.material.map?.dispose()
      obj.material.dispose()
    } else if (obj instanceof THREE.Group) {
      // Recursively dispose children of nested groups
      while (obj.children.length > 0) {
        const child = obj.children[0]
        obj.remove(child)
        this.disposeObject(child)
      }
    }
  }

  private disposeChildren(group: THREE.Group): void {
    while (group.children.length > 0) {
      const obj = group.children[0]
      group.remove(obj)
      this.disposeObject(obj)
    }
  }

  private clear(): void {
    this.batch.reset()
    this.labelBatch.reset()
    this.disposeChildren(this.padMeshGroup)
    this.disposeChildren(this.graphicGroup)
    this.disposeChildren(this.textGroup)

    this.vertexHandles.clear()

    this.padsList = []
    this.graphicsList = []
    this.polysList = []
    this.elements = {}
    this.currentLayerVisibility = undefined
  }

  /** Free all GPU resources (viewport unmount). */
  public dispose(): void {
    this.clear()
    this.vertexHandles.dispose()
    this.batch.dispose()
    this.labelBatch.dispose()
  }

  // ---------------------------------------------------------------------------
  // Pad rendering
  // ---------------------------------------------------------------------------

  private getLayerZ(layer: string | undefined, depth: LayerDepth = 'body'): number {
    return this.layers.zOf(layer, depth)
  }

  private getLayerAlpha(layer: string): number {
    return baseLayerAlpha(layer)
  }

  /**
   * The armed tool's ghost: the shape the next click would commit, drawn in
   * the layer's color at preview alpha above the layer's own strokes. Engine
   * space (mm, y-up). Null clears. Lost on `rebuild`, so the viewport sets it
   * again after one.
   */
  public setDraftPreview(
    primitives: {
      segments: Array<{ start: { x: number; y: number }; end: { x: number; y: number } }>
      rings: Array<{ center: { x: number; y: number }; radius: number }>
    } | null,
    width: number,
    layer: string
  ): void {
    this.batch.removeElement(DRAFT_PREVIEW_KEY)
    if (!primitives) return
    const color = this.getLayerColor(layer)
    // Above the layer's own strokes, below the next layer slot.
    const z = this.getLayerZ(layer, 'detail')
    const halfWidth = width / 2
    for (const s of primitives.segments) {
      this.batch.addCapsule(
        DRAFT_PREVIEW_KEY,
        s.start.x,
        s.start.y,
        s.end.x,
        s.end.y,
        halfWidth,
        color,
        DRAFT_PREVIEW_ALPHA,
        z
      )
    }
    for (const r of primitives.rings) {
      this.batch.addRing(
        DRAFT_PREVIEW_KEY,
        r.center.x,
        r.center.y,
        r.radius,
        halfWidth,
        color,
        DRAFT_PREVIEW_ALPHA,
        z
      )
    }
  }

  /** Add a stroked line segment (capsule) to the instanced batch. */
  private addStroke(
    key: string,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    strokeWidth: number,
    layer: string,
    z: number,
    sketch = false
  ): void {
    const color = this.getLayerColor(layer)
    const alpha = sketchSign(sketch, this.getLayerAlpha(layer))
    this.batch.addCapsule(key, x0, y0, x1, y1, strokeWidth / 2, color, alpha, z)
  }

  private renderPad(pad: KicadPad, index: number, visibleLayers: string[]): void {
    const w = nmToMm(pad.size.w)
    const h = nmToMm(pad.size.h)
    const key = 'pad:' + index
    const cx = nmToMm(pad.position.x)
    const cy = -nmToMm(pad.position.y)
    // KiCad angles are counterclockwise on screen, and the scene mirrors y to
    // show the same picture — so the sign carries straight over, as it does
    // for text here and for pads in the board scene.
    const rotation = pad.position.angle ? THREE.MathUtils.degToRad(pad.position.angle) : 0

    // All pad shapes are rounded rects with different corner radii
    let halfW = w / 2
    let halfH = h / 2
    let cornerR = 0
    if (pad.shape === 'circle') {
      halfW = w / 2
      halfH = w / 2
      cornerR = w / 2
    } else if (pad.shape === 'oval') {
      cornerR = Math.min(w, h) / 2
    } else if (pad.shape === 'roundrect' || pad.roundrectRatio) {
      cornerR = Math.min(w, h) * (pad.roundrectRatio ?? 0.25)
    }

    // Anchor group carries the drag pivot position and selection userData
    const padGroup = new THREE.Group()
    padGroup.position.set(cx, cy, 0)
    if (pad.position.angle) {
      padGroup.rotation.z = rotation
    }

    // Resolve wildcard layers to concrete ones for rendering
    const resolvedLayers: string[] = []
    for (const l of visibleLayers) {
      for (const concrete of expandLayerToken(l)) {
        if (
          !resolvedLayers.includes(concrete) &&
          this.isLayerVisible(concrete, this.currentLayerVisibility)
        ) {
          resolvedLayers.push(concrete)
        }
      }
    }

    // Determine the topmost layer color for highlight tracking
    let topColor = this.layerColors['F.Cu']

    // Render an instance for each visible layer
    // The drill and the pad number belong to the pad as a whole, so they ride
    // on the topmost layer it reaches rather than any one of them.
    let topSlot = 0
    let topLayer: string | undefined = resolvedLayers[0]

    // A custom pad is its anchor PLUS its `(primitives …)` — a SOT-89's tab is
    // most of pad 2's copper — and they are drawn as the one merged outline
    // KiCad plots (`lib/board/padCopper.ts`), in the pad's own frame so the
    // group's placement carries them. Without the boolean engine there is no
    // outline to draw and the pad falls back to its anchor, which is what this
    // editor drew before there was one.
    const merged = padHasPrimitives(pad)
      ? padOutline(padCopperPieces(pad, { x: 0, y: 0 }, 0))
      : null

    for (const layer of resolvedLayers) {
      // A thru-hole pad is copper on every layer it lists, so it takes those
      // layers' colors like any other pad; the wall around its bore is what
      // says it is drilled.
      const color = this.getLayerColor(layer)
      const slot = this.layers.slotOf(layer)

      // getLayerZ, not the free layerZ: a pad's slot has to register whether
      // it is dimmed, like every other write. Going straight to the slot
      // skipped that, so a dimmed layer's pads drew at full strength.
      if (merged && this.sketch.pads) {
        // Outline mode traces the merged copper edge with hairlines (a zero
        // width stroke draws at the batch's 1px minimum) instead of filling it.
        // The ring is in the pad's frame; batch instances are in scene space.
        const cos = Math.cos(rotation)
        const sin = Math.sin(rotation)
        const alpha = this.getLayerAlpha(layer)
        const z = this.getLayerZ(layer)
        for (const region of merged) {
          const ring = fractureRegion(region)
          for (let i = 0; i < ring.length; i++) {
            const a = ring[i]
            const b = ring[(i + 1) % ring.length]
            this.batch.addCapsule(
              key,
              cx + a.x * cos - a.y * sin,
              cy + a.x * sin + a.y * cos,
              cx + b.x * cos - b.y * sin,
              cy + b.x * sin + b.y * cos,
              0,
              color,
              alpha,
              z
            )
          }
        }
      } else if (merged) {
        for (const region of merged) {
          const ring = fractureRegion(region)
          if (ring.length < 3) continue
          const outline = new THREE.Shape()
          outline.moveTo(ring[0].x, ring[0].y)
          for (let i = 1; i < ring.length; i++) outline.lineTo(ring[i].x, ring[i].y)
          outline.closePath()
          const mesh = new THREE.Mesh(
            new THREE.ShapeGeometry(outline),
            this.fillMaterial(layer, color, this.getLayerAlpha(layer))
          )
          this.setZAndOrder(mesh, this.getLayerZ(layer))
          mesh.userData = { defaultColor: color }
          padGroup.add(mesh)
        }
      } else {
        this.batch.addRoundRect(
          key,
          cx,
          cy,
          halfW,
          halfH,
          cornerR,
          rotation,
          color,
          sketchSign(this.sketch.pads, this.getLayerAlpha(layer)),
          this.getLayerZ(layer)
        )
      }

      if (slot > topSlot) {
        topSlot = slot
        topLayer = layer
      }

      topColor = color
    }

    // Add drill hole on top of all layers
    const hole = padHoleShape(pad, rotation)
    if (hole) {
      const wall = holeWallWidth(hole, holeAnnulus(hole, halfW, halfH))
      const wallColor = pad.type === 'np_thru_hole' ? this.holes.unplated : this.holes.plated
      this.batch.addRoundRect(
        key,
        cx + hole.dx,
        cy + hole.dy,
        hole.halfW + wall,
        hole.halfH + wall,
        hole.cornerR + wall,
        rotation,
        wallColor,
        1.0,
        this.getLayerZ(topLayer, 'detail')
      )
      this.batch.addRoundRect(
        key,
        cx + hole.dx,
        cy + hole.dy,
        hole.halfW,
        hole.halfH,
        hole.cornerR,
        rotation,
        this.holes.bore,
        1.0,
        this.getLayerZ(topLayer, 'marker')
      )
    }

    // Pad number label on top (SDF glyph batch; stays screen-upright like the
    // legacy sprites, so pad rotation is intentionally not applied).
    // Size relative to the pad: use the smaller dimension, but for very
    // narrow pads allow up to 30% of the longer dimension for legibility.
    const minDim = Math.min(w, h)
    const maxDim = Math.max(w, h)
    const refDim = Math.max(minDim, maxDim * 0.3)
    this.labelBatch.addLabel(key, pad.number, cx, cy, this.getLayerZ(topLayer, 'label'), refDim)

    padGroup.userData = { type: 'pad', index, id: pad.number, defaultColor: topColor }
    this.padMeshGroup.add(padGroup)
    this.padsList[index] = padGroup
    this.elements[key] = padGroup
  }

  // ---------------------------------------------------------------------------
  // Graphic Line, Arc, Circle
  // ---------------------------------------------------------------------------

  private renderLine(line: KicadFpLine, index: number): void {
    const sx = nmToMm(line.start.x)
    const sy = -nmToMm(line.start.y)
    const ex = nmToMm(line.end.x)
    const ey = -nmToMm(line.end.y)

    const strokeW = line.strokeWidth !== undefined ? nmToMm(line.strokeWidth) : 0.05
    const layer = line.layer ?? 'F.SilkS'
    const layerColor = this.getLayerColor(layer)
    const z = this.getLayerZ(line.layer)
    const key = 'line:' + index

    this.addStroke(key, sx, sy, ex, ey, strokeW, layer, z, this.sketch.graphics)

    // Anchor at the segment midpoint (drag snap pivot, matches old mesh position)
    const anchor = new THREE.Group()
    anchor.position.set((sx + ex) / 2, (sy + ey) / 2, z)
    anchor.userData = { type: 'line', index, defaultColor: layerColor }

    this.graphicGroup.add(anchor)
    this.graphicsList[index] = anchor
    this.elements[key] = anchor
  }

  private renderArc(arc: KicadFpArc, index: number): void {
    const pStart = new THREE.Vector3(nmToMm(arc.start.x), -nmToMm(arc.start.y), 0)
    const pMid = new THREE.Vector3(nmToMm(arc.mid.x), -nmToMm(arc.mid.y), 0)
    const pEnd = new THREE.Vector3(nmToMm(arc.end.x), -nmToMm(arc.end.y), 0)

    const strokeW = arc.strokeWidth !== undefined ? nmToMm(arc.strokeWidth) : 0.05
    const layer = arc.layer ?? 'F.SilkS'
    const layerColor = this.getLayerColor(layer)
    const z = this.getLayerZ(arc.layer)
    const key = 'arc:' + index

    // Compute the circumscribed circle through start, mid, end
    const { cx, cy, r } = this.circumscribedCircle(
      pStart.x,
      pStart.y,
      pMid.x,
      pMid.y,
      pEnd.x,
      pEnd.y
    )

    // Compute start/end angles and determine arc direction
    const aStart = Math.atan2(pStart.y - cy, pStart.x - cx)
    const aMid = Math.atan2(pMid.y - cy, pMid.x - cx)
    const aEnd = Math.atan2(pEnd.y - cy, pEnd.x - cx)

    // Determine if the arc goes counterclockwise or clockwise
    // by checking if the midpoint angle lies between start and end
    const normalizeAngle = (a: number): number =>
      ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
    const nStart = normalizeAngle(aStart)
    const nMid = normalizeAngle(aMid)
    const nEnd = normalizeAngle(aEnd)

    // Check both winding directions
    const ccwContainsMid =
      nStart <= nEnd ? nMid >= nStart && nMid <= nEnd : nMid >= nStart || nMid <= nEnd
    const anticlockwise = !ccwContainsMid

    // Render as a single analytic arc SDF instance
    let sweep: number
    if (anticlockwise) {
      sweep = aStart - aEnd
      if (sweep <= 0) sweep += 2 * Math.PI
    } else {
      sweep = aEnd - aStart
      if (sweep <= 0) sweep += 2 * Math.PI
    }

    const aperture = sweep / 2
    const bisector = anticlockwise ? aStart - aperture : aStart + aperture
    this.batch.addArc(
      key,
      cx,
      cy,
      r,
      strokeW / 2,
      bisector,
      aperture,
      layerColor,
      sketchSign(this.sketch.graphics, this.getLayerAlpha(layer)),
      z
    )

    const anchor = new THREE.Group()
    anchor.userData = { type: 'arc', index, defaultColor: layerColor }
    this.graphicGroup.add(anchor)
    this.elements[key] = anchor
  }

  /**
   * Compute the circumscribed circle through three points.
   * Returns center (cx, cy) and radius r.
   */
  private circumscribedCircle(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    x3: number,
    y3: number
  ): { cx: number; cy: number; r: number } {
    const A = x1 * (y2 - y3) - y1 * (x2 - x3) + x2 * y3 - x3 * y2
    const B =
      (x1 * x1 + y1 * y1) * (y3 - y2) +
      (x2 * x2 + y2 * y2) * (y1 - y3) +
      (x3 * x3 + y3 * y3) * (y2 - y1)
    const C =
      (x1 * x1 + y1 * y1) * (x2 - x3) +
      (x2 * x2 + y2 * y2) * (x3 - x1) +
      (x3 * x3 + y3 * y3) * (x1 - x2)

    const cx = -B / (2 * A)
    const cy = -C / (2 * A)
    const r = Math.hypot(x1 - cx, y1 - cy)

    return { cx, cy, r }
  }

  private renderCircle(circle: KicadFpCircle, index: number): void {
    const cx = nmToMm(circle.center.x)
    const cy = -nmToMm(circle.center.y)
    const r = Math.hypot(circle.end.x - circle.center.x, circle.end.y - circle.center.y) / NM_PER_MM
    const halfStroke = (circle.strokeWidth !== undefined ? nmToMm(circle.strokeWidth) : 0.05) / 2

    const z = this.getLayerZ(circle.layer)
    const layer = circle.layer ?? 'F.SilkS'
    const layerColor = this.getLayerColor(layer)
    const key = 'circle:' + index

    const alpha = sketchSign(this.sketch.graphics, this.getLayerAlpha(layer))
    this.batch.addRing(key, cx, cy, r, halfStroke, layerColor, alpha, z)

    const anchor = new THREE.Group()
    anchor.position.set(cx, cy, z)
    anchor.userData = { type: 'circle', index, defaultColor: layerColor }
    this.graphicGroup.add(anchor)
    this.elements[key] = anchor
  }

  private isPointInPolygon(
    p: { x: number; y: number },
    polygon: Array<{ x: number; y: number }>
  ): boolean {
    let inside = false
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const xi = polygon[i].x
      const yi = polygon[i].y
      const xj = polygon[j].x
      const yj = polygon[j].y
      const intersect = yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi
      if (intersect) inside = !inside
    }
    return inside
  }

  private renderZone(zone: KicadZone, index: number): void {
    if (zone.points.length < 3) return

    const z = this.getLayerZ(zone.layer)
    const layer = zone.layer
    const layerColor = this.getLayerColor(layer)
    const key = 'zone:' + index
    // Default outline stroke thickness to a thin 0.06mm (clamped at max 0.08mm) for clean rendering
    const strokeWidth = Math.min(
      zone.minThickness !== undefined ? nmToMm(zone.minThickness) : 0.06,
      0.08
    )
    const hatchStrokeWidth = strokeWidth * 0.6 // Even thinner hatch stroke

    // 1. Draw outline boundary
    const localPts = zone.points.map((p) => ({ x: nmToMm(p.x), y: -nmToMm(p.y) }))
    const group = new THREE.Group()

    for (let i = 0; i < localPts.length; i++) {
      const p0 = localPts[i]
      const p1 = localPts[(i + 1) % localPts.length]
      this.addStroke(key, p0.x, p0.y, p1.x, p1.y, strokeWidth, layer, z)
    }

    // 2. Draw Hatching based on style
    const hatchPitch = zone.hatchPitch !== undefined ? nmToMm(zone.hatchPitch) : 0.5

    if (zone.hatchStyle === 'edge') {
      // Small diagonal hatch segments pointing inwards (tilted at -45 deg relative to edge normal)
      for (let i = 0; i < localPts.length; i++) {
        const p0 = localPts[i]
        const p1 = localPts[(i + 1) % localPts.length]

        const dx = p1.x - p0.x
        const dy = p1.y - p0.y
        const L = Math.hypot(dx, dy)
        if (L < 1e-6) continue

        const ux = dx / L
        const uy = dy / L

        // Calculate left normal
        const nLeftX = -uy
        const nLeftY = ux

        // Midpoint
        const midX = (p0.x + p1.x) / 2
        const midY = (p0.y + p1.y) / 2

        // Check if left normal points inwards
        const testX = midX + 1e-4 * nLeftX
        const testY = midY + 1e-4 * nLeftY

        const isIn = this.isPointInPolygon({ x: testX, y: testY }, localPts)
        const nInX = isIn ? nLeftX : -nLeftX
        const nInY = isIn ? nLeftY : -nLeftY

        // Hatch direction parallel to a global 45-degree angle (up and right in Three.js space) pointing inwards
        const gDirX = 1 / Math.sqrt(2)
        const gDirY = 1 / Math.sqrt(2)
        const dot = nInX * gDirX + nInY * gDirY
        // If the edge is parallel to the 45-degree line, fall back to a 135-degree line
        const use135 = Math.abs(dot) < 0.1
        const hDirX = use135 ? -gDirX * (nInY >= 0 ? 1 : -1) : gDirX * (dot >= 0 ? 1 : -1)
        const hDirY = use135 ? gDirY * (nInY >= 0 ? 1 : -1) : gDirY * (dot >= 0 ? 1 : -1)
        const hatchLen = hatchPitch * 0.8

        // Space points along the segment
        const numHatches = Math.floor(L / hatchPitch)
        for (let k = 0; k <= numHatches; k++) {
          const t = numHatches > 0 ? k / numHatches : 0.5
          const hStartX = p0.x + t * dx
          const hStartY = p0.y + t * dy
          const hEndX = hStartX + hDirX * hatchLen
          const hEndY = hStartY + hDirY * hatchLen

          // Skip hatch segments that extend outside the polygon boundary
          if (!this.isPointInPolygon({ x: hEndX, y: hEndY }, localPts)) {
            continue
          }

          this.addStroke(key, hStartX, hStartY, hEndX, hEndY, hatchStrokeWidth, layer, z)
        }
      }
    } else if (zone.hatchStyle === 'full') {
      // Full hatching across the entire interior area (procedural, in-shader)
      // Sloped by the layer as KiCad slopes it: rising on copper.
      const pattern = zoneHatchRises([layer]) ? HATCH_PATTERN.HATCH : HATCH_PATTERN.REVERSE
      group.add(this.createHatchMesh(localPts, pattern, hatchPitch, hatchStrokeWidth, layer))
    }

    // 3. Render filled copper polygons if they exist
    if (zone.filledPolys && zone.filledPolys.length > 0) {
      const fillMat = this.fillMaterial(layer, layerColor, ZONE_FILL_ALPHA)

      for (const poly of zone.filledPolys) {
        if (poly.length < 3) continue
        const shape = new THREE.Shape()
        shape.moveTo(poly[0].x, -poly[0].y)
        for (let j = 1; j < poly.length; j++) {
          shape.lineTo(poly[j].x, -poly[j].y)
        }
        shape.closePath()

        const geom = new THREE.ShapeGeometry(shape)
        const mesh = new THREE.Mesh(geom, fillMat)
        this.setZAndOrder(mesh, this.getLayerZ(layer, 'fill'))
        mesh.userData = { defaultColor: layerColor }
        group.add(mesh)
      }
    }

    group.userData = { type: 'zone', index, defaultColor: layerColor }
    this.graphicGroup.add(group)
    this.elements[key] = group
  }

  /**
   * Build a hatch fill mesh: the polygon is triangulated once and the 45°
   * stripe pattern is drawn procedurally by the fragment shader, clipped
   * exactly to the polygon area. Replaces CPU scanline hatch generation.
   */
  private createHatchMesh(
    points: Array<{ x: number; y: number }>,
    pattern: number,
    pitch: number,
    strokeWidth: number,
    layer: string
  ): THREE.Mesh {
    const shape = new THREE.Shape()
    shape.moveTo(points[0].x, points[0].y)
    for (let i = 1; i < points.length; i++) {
      shape.lineTo(points[i].x, points[i].y)
    }
    shape.closePath()

    const layerColor = this.getLayerColor(layer)
    const geom = new THREE.ShapeGeometry(shape)
    const mat = createHatchMaterial(
      layerColor,
      this.getLayerAlpha(layer),
      pitch,
      strokeWidth / 2,
      pattern
    )
    const mesh = new THREE.Mesh(geom, mat)
    this.setZAndOrder(mesh, this.getLayerZ(layer, 'fill'))
    mesh.userData = { defaultColor: layerColor }
    return mesh
  }

  private renderPoly(poly: KicadFpPoly, index: number): void {
    if (poly.points.length < 2) return

    const z = this.getLayerZ(poly.layer)
    const layer = poly.layer ?? 'F.SilkS'
    const layerColor = this.getLayerColor(layer)
    const strokeW = poly.strokeWidth !== undefined ? nmToMm(poly.strokeWidth) : 0.12
    const key = 'poly:' + index

    const group = new THREE.Group()

    // 1. Render Stroke Outline (closed loop if points.length >= 3)
    const numPoints = poly.points.length
    const isClosed = numPoints >= 3
    const limit = isClosed ? numPoints : numPoints - 1
    const localPts = poly.points.map((p) => ({ x: nmToMm(p.x), y: -nmToMm(p.y) }))

    for (let i = 0; i < limit; i++) {
      const p0 = localPts[i]
      const p1 = localPts[(i + 1) % numPoints]
      this.addStroke(key, p0.x, p0.y, p1.x, p1.y, strokeW, layer, z, this.sketch.graphics)
    }

    // 2. Render Solid Fill (outline mode leaves every fill empty)
    const filled = !this.sketch.graphics && numPoints >= 3
    if (isSolidFill(poly.fill) && filled) {
      const shape = new THREE.Shape()
      shape.moveTo(localPts[0].x, localPts[0].y)
      for (let i = 1; i < numPoints; i++) {
        shape.lineTo(localPts[i].x, localPts[i].y)
      }
      shape.closePath()

      const geom = new THREE.ShapeGeometry(shape)
      const mat = this.fillMaterial(layer, layerColor)
      const mesh = new THREE.Mesh(geom, mat)
      this.setZAndOrder(mesh, this.getLayerZ(layer, 'fill'))
      mesh.userData = { defaultColor: layerColor }
      group.add(mesh)
    }

    // 3. Render Hatch / Cross-Hatch Fills
    const hatchStrokeW = strokeW * 0.6
    const hatchPitch = 0.5 // 0.5mm pitch is clean and standard

    if (filled) {
      const isHatch =
        poly.fill === 'hatch' || poly.fill === 'cross_hatch' || poly.fill === 'cross-hatch'
      const isRevHatch =
        poly.fill === 'reverse_hatch' ||
        poly.fill === 'reverse-hatch' ||
        poly.fill === 'cross_hatch' ||
        poly.fill === 'cross-hatch'

      if (isHatch || isRevHatch) {
        const pattern =
          isHatch && isRevHatch
            ? HATCH_PATTERN.CROSS
            : isHatch
              ? HATCH_PATTERN.HATCH
              : HATCH_PATTERN.REVERSE
        group.add(this.createHatchMesh(localPts, pattern, hatchPitch, hatchStrokeW, layer))
      }
    }

    group.userData = { type: 'poly', index, defaultColor: layerColor }
    this.graphicGroup.add(group)
    this.polysList[index] = group
    this.elements[key] = group
  }

  private renderRect(rect: KicadFpRect, index: number): void {
    const sx = nmToMm(rect.start.x)
    const sy = -nmToMm(rect.start.y)
    const ex = nmToMm(rect.end.x)
    const ey = -nmToMm(rect.end.y)

    const strokeW = rect.strokeWidth !== undefined ? nmToMm(rect.strokeWidth) : 0.12
    const layer = rect.layer ?? 'F.SilkS'
    const layerColor = this.getLayerColor(layer)
    const z = this.getLayerZ(rect.layer)
    const key = 'rect:' + index

    const group = new THREE.Group()

    const sketch = this.sketch.graphics
    if (isSolidFill(rect.fill) && !sketch) {
      const shape = new THREE.Shape()
      shape.moveTo(sx, sy)
      shape.lineTo(ex, sy)
      shape.lineTo(ex, ey)
      shape.lineTo(sx, ey)
      shape.closePath()

      const geometry = new THREE.ShapeGeometry(shape)
      const material = this.fillMaterial(layer, layerColor)
      const mesh = new THREE.Mesh(geometry, material)
      this.setZAndOrder(mesh, this.getLayerZ(layer, 'fill'))
      mesh.userData = { defaultColor: layerColor }
      group.add(mesh)
    } else {
      this.addStroke(key, sx, sy, ex, sy, strokeW, layer, z, sketch)
      this.addStroke(key, ex, sy, ex, ey, strokeW, layer, z, sketch)
      this.addStroke(key, ex, ey, sx, ey, strokeW, layer, z, sketch)
      this.addStroke(key, sx, ey, sx, sy, strokeW, layer, z, sketch)
    }

    group.userData = { type: 'rect', index, defaultColor: layerColor }
    this.graphicGroup.add(group)
    this.graphicsList[index] = group
    this.elements[key] = group
  }

  // ---------------------------------------------------------------------------
  // Text labels (stroke font rendered as batched capsules)
  // ---------------------------------------------------------------------------

  private renderTextLabel(
    type: string,
    index: number,
    text: string,
    position: { x: number; y: number; angle?: number },
    keepUpright: boolean,
    layer: string,
    fontEffects?: KicadFontEffects
  ): void {
    if (!text) return

    // Fetch the vector strokes for the text string
    const options = strokeOptionsFromEffects(fontEffects)
    const thickness = options.thickness
    const { strokes } = getTextStrokes(text, options)

    const z = this.getLayerZ(layer, 'detail')
    const layerColor = this.getLayerColor(layer)
    const key = `${type}:${index}`

    // Transform local stroke coordinates by the text rotation + position
    // (KiCAD positive angles are counterclockwise, matching Three.js convention).
    // The drawn angle, not the stored one — keep-upright applies in the editor
    // exactly as it does on the board.
    const angleRad = THREE.MathUtils.degToRad(footprintTextDrawAngle(position.angle, keepUpright))
    const cos = Math.cos(angleRad)
    const sin = Math.sin(angleRad)
    const px = nmToMm(nm(position.x))
    const py = -nmToMm(nm(position.y))

    for (const stroke of strokes) {
      const wx1 = px + stroke.x1 * cos - stroke.y1 * sin
      const wy1 = py + stroke.x1 * sin + stroke.y1 * cos
      const wx2 = px + stroke.x2 * cos - stroke.y2 * sin
      const wy2 = py + stroke.x2 * sin + stroke.y2 * cos
      this.addStroke(key, wx1, wy1, wx2, wy2, thickness, layer, z, this.sketch.text)
    }

    const anchor = new THREE.Group()
    anchor.position.set(px, py, z)
    anchor.userData = { type, index, defaultColor: layerColor }
    this.textGroup.add(anchor)
    this.elements[key] = anchor
  }

  /**
   * A Bézier, point, text box or table: its strokes, rings and laid-out text
   * as batched capsules under `type:index`, with one anchor for the drag pivot.
   * Text draws at its literal angle — a text box has no keep-upright.
   */
  private renderExtraGraphic(type: string, index: number, item: KicadExtraGraphic): void {
    const layer = item.layer ?? 'F.SilkS'
    const key = `${type}:${index}`
    const drawing = extraGraphicDrawing(item)
    const z = this.getLayerZ(layer)
    const textual = type === 'textbox' || type === 'table'
    const sketch = textual ? this.sketch.text : this.sketch.graphics
    for (const stroke of drawing.strokes) {
      const pts = stroke.points.map(engineSpace)
      const n = stroke.closed ? pts.length : pts.length - 1
      for (let i = 0; i < n; i++) {
        const a = pts[i]
        const b = pts[(i + 1) % pts.length]
        this.addStroke(key, a.x, a.y, b.x, b.y, stroke.width / NM_PER_MM, layer, z, sketch)
      }
    }
    for (const ring of drawing.rings) {
      const c = engineSpace(ring.center)
      this.batch.addRing(
        key,
        c.x,
        c.y,
        ring.radius / NM_PER_MM,
        ring.width / NM_PER_MM / 2,
        this.getLayerColor(layer),
        sketchSign(sketch, this.getLayerAlpha(layer)),
        z
      )
    }
    const textZ = this.getLayerZ(layer, 'detail')
    for (const text of drawing.texts) {
      const options = strokeOptionsFromEffects(text.effects)
      const { strokes } = getTextStrokes(text.text, options)
      const at = engineSpace(text.anchor)
      const angle = THREE.MathUtils.degToRad(text.angle)
      const cos = Math.cos(angle)
      const sin = Math.sin(angle)
      for (const s of strokes) {
        this.addStroke(
          key,
          at.x + s.x1 * cos - s.y1 * sin,
          at.y + s.x1 * sin + s.y1 * cos,
          at.x + s.x2 * cos - s.y2 * sin,
          at.y + s.x2 * sin + s.y2 * cos,
          options.thickness,
          layer,
          textZ,
          this.sketch.text
        )
      }
    }
    const pivot = engineSpace(
      drawing.strokes[0]?.points[0] ?? drawing.rings[0]?.center ?? { x: 0, y: 0 }
    )
    const anchor = new THREE.Group()
    anchor.position.set(pivot.x, pivot.y, z)
    anchor.userData = { type, index, defaultColor: this.getLayerColor(layer) }
    ;(textual ? this.textGroup : this.graphicGroup).add(anchor)
    this.elements[key] = anchor
  }

  /** A layer's color as this view draws it: sunk toward the canvas when the layer is dimmed. */
  private getLayerColor(layer: string): THREE.Color {
    const color =
      this.layerColors[resolveWildcardLayer(layer)] ?? this.layerColors[DEFAULT_PCB_LAYER]
    return this.isDimmed(layer)
      ? dimToward(new THREE.Color(), color, this.background, DIM_ALPHA_FACTOR)
      : color
  }

  /** The material a mesh fill draws with; `alpha` is the fill's own weight over the layer's. */
  private fillMaterial(layer: string, color: THREE.Color, alpha?: number): THREE.Material {
    const mat = this.getLayerMaterial(layer, color)
    if (alpha === undefined) return mat
    const owned = mat.clone()
    owned.transparent = true
    owned.opacity = alpha
    // Unique material: highlight mutates it in place, dispose frees it
    owned.userData = {}
    return owned
  }

  private getLayerMaterial(layer: string, color: THREE.Color): THREE.MeshBasicMaterial {
    const cleanLayer = resolveWildcardLayer(layer)
    const base = baseLayerAlpha(layer)
    const translucent = base < 1

    // Cache opaque materials by layer key (dimmed variants cache separately) —
    // transparent mask/paste materials are cloned from cached base because
    // highlight may mutate .color
    const cacheKey = `layer:${cleanLayer}${this.isDimmed(layer) ? ':dim' : ''}`
    const cached = this.materialCache.get(cacheKey)
    if (cached && !translucent) {
      // Return a shared instance; highlight mutates .color directly which is fine
      // since all meshes on the same layer share the same default color
      return cached
    }

    // Transparent even at full opacity, and never writing depth: a fill has to
    // sit in the one paint order the surface shares, and three.js draws the
    // opaque queue before all of it.
    const mat = new THREE.MeshBasicMaterial({
      color,
      side: THREE.DoubleSide,
      // Double-sided for a mirrored footprint's winding; without this three.js
      // draws every double-sided translucent mesh twice, a side a pass.
      forceSinglePass: true,
      transparent: true,
      depthWrite: false,
      opacity: base
    })
    mat.userData = { cacheKey }

    if (!translucent) {
      this.materialCache.set(cacheKey, mat)
    }
    return mat
  }

  // ---------------------------------------------------------------------------
  // Highlight
  // ---------------------------------------------------------------------------

  public highlightSelection(selectedItems: Array<{ type: string; index: number }>): void {
    const keys = new Set(selectedItems.map(({ type, index }) => `${type}:${index}`))
    this.liftSelection(keys)

    // Reset all elements
    this.batch.resetColors()
    Object.values(this.elements).forEach((obj) => {
      this.resetGraphicColor(obj)
    })

    // Highlight selected elements
    for (const key of keys) {
      this.batch.shiftElementColors(key, this.selectionShift())
      const obj = this.elements[key]
      if (obj) {
        this.setSelectedGraphicColor(obj)
      }
    }
  }

  /**
   * Draw exactly the selected elements in the selected band, in front of
   * everything unselected — strokes, labels and fills alike — as the board
   * does (`BoardScene.liftSelection`, layers.ts `LIFTED_SLOT_OFFSET`).
   */
  private liftSelection(keys: ReadonlySet<string>): void {
    this.batch.liftElements(keys)
    this.labelBatch.liftElements(keys)
    for (const [key, anchor] of Object.entries(this.elements)) {
      const lifted = keys.has(key)
      anchor.traverse((object) => {
        if (object instanceof THREE.Mesh) liftFillMesh(object, lifted, this.paint)
      })
    }
  }

  // Fallbacks for backwards compatibility
  public highlightPad(index: number | null): void {
    this.highlightSelection(index !== null ? [{ type: 'pad', index }] : [])
  }
  public highlightGraphic(index: number | null): void {
    this.highlightSelection(index !== null ? [{ type: 'line', index }] : [])
  }
  public highlightPoly(index: number | null): void {
    this.highlightSelection(index !== null ? [{ type: 'poly', index }] : [])
  }

  /**
   * Targets the viewport must hand to `ViewportEngine.registerScreenScaled`, so
   * handles keep a constant on-screen size instead of growing with zoom.
   */
  public screenScaledTargets(): ScreenScaled[] {
    return [this.vertexHandles]
  }

  /**
   * Drag handles for the selected shape. Only ever ONE shape: see
   * `soleSelection`. Footprint space is y-down and engine space y-up, so every
   * position negates y on the way out.
   */
  public renderVertexHandles(selectedItems: Array<{ type: string; index: number }>): void {
    const sole = soleSelection(selectedItems)
    const fp = this.currentFootprint
    if (!sole || !fp) {
      this.vertexHandles.render(null)
      return
    }
    const { type, index } = sole
    const specs: VertexHandleSpec[] = []
    // Domain nm in, scene mm handles out.
    const at = (x: number, y: number, vertexIndex: number): void => {
      specs.push({
        x: x / NM_PER_MM,
        y: -y / NM_PER_MM,
        data: { parentType: type, parentIndex: index, vertexIndex }
      })
    }

    if (type === 'line') {
      const line = fp.fpLines[index]
      if (line) {
        at(line.start.x, line.start.y, 0)
        at(line.end.x, line.end.y, 1)
      }
    } else if (type === 'poly') {
      const poly = fp.fpPolys[index]
      if (poly) poly.points.forEach((pt, idx) => at(pt.x, pt.y, idx))
    } else if (type === 'arc') {
      const arc = fp.fpArcs[index]
      if (arc) {
        at(arc.start.x, arc.start.y, 0)
        at(arc.mid.x, arc.mid.y, 1)
        at(arc.end.x, arc.end.y, 2)
      }
    } else if (type === 'circle') {
      const circle = fp.fpCircles[index]
      if (circle) {
        // Vertex 0 is the center, and writing it moves the whole circle — so a
        // circle already has its translate handle and needs no 'move' one.
        at(circle.center.x, circle.center.y, 0)
        at(circle.end.x, circle.end.y, 1)
      }
    } else if (type === 'rect') {
      const rect = fp.fpRects[index]
      if (rect) {
        at(rect.start.x, rect.start.y, 0)
        at(rect.end.x, rect.end.y, 1)
        // The one primitive with an empty interior and no anchor point of its
        // own: both its vertices are corners, so without a center handle an
        // unfilled rectangle can only be moved by catching its outline.
        specs.push({
          x: (rect.start.x + rect.end.x) / 2 / NM_PER_MM,
          y: -(rect.start.y + rect.end.y) / 2 / NM_PER_MM,
          role: 'move',
          data: { parentType: type, parentIndex: index }
        })
      }
    } else if (type === 'zone') {
      const zone = fp.zones[index]
      if (zone) zone.points.forEach((pt, idx) => at(pt.x, pt.y, idx))
    }

    this.vertexHandles.render(specs)
  }

  private resetGraphicColor(obj: THREE.Object3D): void {
    if (obj instanceof THREE.Sprite) return // Don't color pad sprites

    if (obj instanceof THREE.Mesh) {
      if (obj.material instanceof THREE.ShaderMaterial) {
        // Hatch fill: color lives in the uColor uniform
        if (obj.material.userData?.isHatch && obj.userData.defaultColor) {
          obj.material.uniforms.uColor.value.copy(obj.userData.defaultColor)
        }
        return
      }
      const mat = obj.material as THREE.MeshBasicMaterial
      if (mat) {
        if (mat.userData?.isCloned && mat.userData?.cacheKey) {
          const cached = this.materialCache.get(mat.userData.cacheKey)
          if (cached) {
            obj.material = cached
            mat.dispose()
          }
        } else if (obj.userData.defaultColor) {
          mat.color.copy(obj.userData.defaultColor)
        }
      }
    } else if (obj instanceof THREE.Group) {
      obj.children.forEach((child) => this.resetGraphicColor(child))
    }
  }

  /**
   * Recursively set the color on a graphic object, handling both
   * individual meshes and groups of meshes (e.g. zone fills).
   */
  private setSelectedGraphicColor(obj: THREE.Object3D): void {
    if (obj instanceof THREE.Sprite) return // Don't color pad sprites

    if (obj instanceof THREE.Mesh) {
      const defaultColor = obj.userData.defaultColor as THREE.Color | undefined
      if (!defaultColor) return
      const color = this.selectionColor(defaultColor)
      if (obj.material instanceof THREE.ShaderMaterial) {
        // Hatch fill: color lives in the uColor uniform (material is unique per element)
        if (obj.material.userData?.isHatch) {
          obj.material.uniforms.uColor.value.copy(color)
        }
        return
      }
      let mat = obj.material as THREE.MeshBasicMaterial
      if (mat) {
        if (mat.userData?.cacheKey && !mat.userData.isCloned) {
          const clonedMat = mat.clone()
          clonedMat.userData = { ...mat.userData, isCloned: true }
          obj.material = clonedMat
          mat = clonedMat
        }
        mat.color.copy(color)
      }
    } else if (obj instanceof THREE.Group) {
      obj.children.forEach((child) => this.setSelectedGraphicColor(child))
    }
  }

  private selectionShift(): number {
    return selectionShift(this.selectionLighten)
  }

  private selectionColor(color: THREE.Color): THREE.Color {
    return color
      .clone()
      .lerp(
        this.selectionLighten ? new THREE.Color('#ffffff') : new THREE.Color('#000000'),
        Math.abs(this.selectionShift())
      )
  }

  private setZAndOrder(obj: THREE.Object3D, z: number): void {
    placeFillMesh(obj, z, 'fill', this.paint)
  }

  // ---------------------------------------------------------------------------
  // Drag optimization: position-only moves and targeted rebuilds
  // ---------------------------------------------------------------------------

  /**
   * Snapshot the current positions of elements so translateElements()
   * can compute absolute positions from origin + delta.
   */
  /** Scene-space bounds of what these items paint, for zoom to selection. */
  public selectionBounds(items: Array<{ type: string; index: number }>): THREE.Box3 {
    const bounds = new THREE.Box3()
    for (const { type, index } of items) {
      const key = `${type}:${index}`
      this.batch.elementBounds(key, bounds)
      const obj = this.elements[key]
      if (obj) bounds.expandByObject(obj)
    }
    return bounds
  }

  public saveDragOrigins(items: Array<{ type: string; index: number }>): void {
    const keys: string[] = []
    for (const { type, index } of items) {
      const key = `${type}:${index}`
      keys.push(key)
      const obj = this.elements[key]
      if (obj) {
        obj.userData._dragOrigin = { x: obj.position.x, y: obj.position.y }
      }
    }
    this.batch.saveOrigins(keys)
    this.labelBatch.saveOrigins(keys)
    // Also snapshot vertex handle positions
    this.vertexHandles.saveOrigins()
  }

  /**
   * Clear drag origin snapshots after drag ends.
   */
  public clearDragOrigins(): void {
    this.batch.clearOrigins()
    this.labelBatch.clearOrigins()
    for (const obj of Object.values(this.elements)) {
      delete obj.userData._dragOrigin
    }
    this.vertexHandles.clearOrigins()
  }

  /**
   * Translate selected elements by updating batch instances and anchor
   * positions. Zero geometry/material allocation.
   */
  public translateElements(
    items: Array<{ type: string; index: number }>,
    delta: { x: number; y: number }
  ): void {
    for (const { type, index } of items) {
      const key = `${type}:${index}`
      this.batch.translateElement(key, delta.x, delta.y)
      this.labelBatch.translateElement(key, delta.x, delta.y)

      const obj = this.elements[key]
      if (!obj || !obj.userData._dragOrigin) continue

      obj.position.x = obj.userData._dragOrigin.x + delta.x
      obj.position.y = obj.userData._dragOrigin.y + delta.y
    }
    // Move vertex handles in lockstep
    this.vertexHandles.translate(delta)
  }

  /**
   * Rebuild a single element in-place. Used for vertex drags where the
   * geometry shape itself changes (e.g. polygon outline, fill, hatching).
   * Disposes only the targeted element and re-renders it, leaving
   * all other scene objects untouched.
   */
  public rebuildSingleElement(
    type: string,
    index: number,
    fp: KicadFootprint,
    layerVisibility?: Record<string, boolean>,
    selectedItems?: Array<{ type: string; index: number }>
  ): void {
    const key = `${type}:${index}`
    const existing = this.elements[key]
    if (existing) {
      existing.parent?.remove(existing)
      this.disposeObject(existing)
      delete this.elements[key]
    }
    this.batch.removeElement(key)
    this.labelBatch.removeElement(key)

    // Re-render just this one element using existing render methods
    if (type === 'line') {
      const line = fp.fpLines[index]
      if (line && this.isLayerVisible(line.layer, layerVisibility)) {
        this.renderLine(line, index)
      }
    } else if (type === 'poly') {
      const poly = fp.fpPolys[index]
      if (poly && this.isLayerVisible(poly.layer, layerVisibility)) {
        this.renderPoly(poly, index)
      }
    } else if (type === 'arc') {
      const arc = fp.fpArcs[index]
      if (arc && this.isLayerVisible(arc.layer, layerVisibility)) {
        this.renderArc(arc, index)
      }
    } else if (type === 'circle') {
      const circle = fp.fpCircles[index]
      if (circle && this.isLayerVisible(circle.layer, layerVisibility)) {
        this.renderCircle(circle, index)
      }
    } else if (type === 'rect') {
      const rect = fp.fpRects[index]
      if (rect && this.isLayerVisible(rect.layer, layerVisibility)) {
        this.renderRect(rect, index)
      }
    } else if (type === 'zone') {
      const zone = fp.zones[index]
      if (zone && this.isLayerVisible(zone.layer, layerVisibility)) {
        this.renderZone(zone, index)
      }
    } else if (type === 'pad') {
      const pad = fp.pads[index]
      if (pad) {
        const visibleLayers = pad.layers.filter((l) => this.isLayerVisible(l, layerVisibility))
        if (visibleLayers.length > 0) this.renderPad(pad, index, visibleLayers)
      }
    }

    // Re-apply highlight if this element is selected
    if (selectedItems) {
      const isSelected = selectedItems.some((s) => s.type === type && s.index === index)
      if (isSelected) {
        this.batch.shiftElementColors(key, this.selectionShift())
        const obj = this.elements[key]
        if (obj) this.setSelectedGraphicColor(obj)
      }
    }

    // Rebuild vertex handles for just the affected element
    this.renderVertexHandles(selectedItems ?? [])
    // This path makes new meshes too — the dim flatten must hear about them
    // just as it does after a full rebuild, or a re-rendered element on a
    // dimmed layer draws at full strength.
    this.onRebuilt?.()
  }

  /** The best thing under the cursor, ignoring any selection policy. */
  public hitTest(point: THREE.Vector2, threshold: number): { type: string; index: number } | null {
    return this.hitCandidates(point, threshold)[0]?.levels[0]?.ref ?? null
  }

  /**
   * Everything under the cursor, nearest first — what an editor's selection
   * policy resolves against (`resolveHit`, lib/selectionResolve.ts).
   *
   * Returning the whole list rather than only the winner is what lets a
   * filtered-out kind fall through to what sits behind it. The order is the one
   * the old single-best fold produced: its `dist < bestDist` was strict, so the
   * first registered won a tie, and a stable sort by distance keeps that.
   *
   * Footprint parts nest no deeper than one level, so every candidate carries a
   * single level.
   */
  public hitCandidates(
    point: THREE.Vector2,
    threshold: number
  ): Array<HitCandidate<{ type: string; index: number }>> {
    if (!this.currentFootprint) return []

    const found: RankedFootprintHit[] = []

    const registerHit = (type: string, index: number, dist: number, locked = false): void => {
      if (dist < threshold) {
        found.push({
          ref: { type, index },
          kind: footprintItemKind(type),
          locked,
          dist,
          rank: FOOTPRINT_TYPE_RANK[type] ?? Number.MAX_SAFE_INTEGER,
          order: found.length
        })
      }
    }

    const distToSegment = (p: THREE.Vector2, v: THREE.Vector2, w: THREE.Vector2): number => {
      const l2 = v.distanceToSquared(w)
      if (l2 === 0) return p.distanceTo(v)
      let t = ((p.x - v.x) * (w.x - v.x) + (p.y - v.y) * (w.y - v.y)) / l2
      t = Math.max(0, Math.min(1, t))
      const proj = new THREE.Vector2(v.x + t * (w.x - v.x), v.y + t * (w.y - v.y))
      return p.distanceTo(proj)
    }

    const fp = this.currentFootprint

    // 1. Check Pads
    fp.pads.forEach((pad, index) => {
      const visibleLayers = pad.layers.filter((l) =>
        this.isLayerVisible(l, this.currentLayerVisibility)
      )
      if (visibleLayers.length === 0) return

      const w = nmToMm(pad.size.w)
      const h = nmToMm(pad.size.h)
      const theta = THREE.MathUtils.degToRad(pad.position.angle ?? 0)
      const cx = nmToMm(pad.position.x)
      const cy = -nmToMm(pad.position.y)

      // A custom pad's primitives are copper too — the tab of a SOT-89 is part
      // of the pad you can click. Only that pad pays for the pieces; a plain one
      // is its anchor, and this runs per pad per mouse move.
      if (padHasPrimitives(pad)) {
        const pieces = padCopperPieces(pad, { x: cx, y: cy }, theta)
        registerHit('pad', index, padPointDistance(pieces, point.x, point.y), pad.locked)
        return
      }

      // Into the pad's own frame: the inverse of the rotation it renders with.
      const dx = point.x - cx
      const dy = point.y - cy
      const cos = Math.cos(theta)
      const sin = Math.sin(theta)
      const lx = dx * cos + dy * sin
      const ly = -dx * sin + dy * cos

      const dist = Math.max(0, Math.abs(lx) - w / 2, Math.abs(ly) - h / 2)
      registerHit('pad', index, dist, pad.locked)
    })

    // 2. Check Lines (rect edges are covered by the rect check below)
    fp.fpLines.forEach((line, index) => {
      if (!this.isLayerVisible(line.layer, this.currentLayerVisibility)) return

      const start = new THREE.Vector2(nmToMm(line.start.x), -nmToMm(line.start.y))
      const end = new THREE.Vector2(nmToMm(line.end.x), -nmToMm(line.end.y))
      const strokeWidth = line.strokeWidth !== undefined ? nmToMm(line.strokeWidth) : 0.05
      const dist = Math.max(0, distToSegment(point, start, end) - strokeWidth / 2)
      registerHit('line', index, dist, line.locked)
    })

    // 3. Check Arcs
    fp.fpArcs.forEach((arc, index) => {
      if (!this.isLayerVisible(arc.layer, this.currentLayerVisibility)) return

      const pStart = new THREE.Vector2(nmToMm(arc.start.x), -nmToMm(arc.start.y))
      const pMid = new THREE.Vector2(nmToMm(arc.mid.x), -nmToMm(arc.mid.y))
      const pEnd = new THREE.Vector2(nmToMm(arc.end.x), -nmToMm(arc.end.y))
      const strokeW = arc.strokeWidth !== undefined ? nmToMm(arc.strokeWidth) : 0.05

      const { cx, cy, r } = this.circumscribedCircle(
        pStart.x,
        pStart.y,
        pMid.x,
        pMid.y,
        pEnd.x,
        pEnd.y
      )

      const aStart = Math.atan2(pStart.y - cy, pStart.x - cx)
      const aMid = Math.atan2(pMid.y - cy, pMid.x - cx)
      const aEnd = Math.atan2(pEnd.y - cy, pEnd.x - cx)

      const normalizeAngle = (a: number): number =>
        ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
      const nStart = normalizeAngle(aStart)
      const nMid = normalizeAngle(aMid)
      const nEnd = normalizeAngle(aEnd)

      const ccwContainsMid =
        nStart <= nEnd ? nMid >= nStart && nMid <= nEnd : nMid >= nStart || nMid <= nEnd
      const anticlockwise = !ccwContainsMid

      const segments = 32
      let sweep: number
      if (anticlockwise) {
        sweep = aStart - aEnd
        if (sweep <= 0) sweep += 2 * Math.PI
      } else {
        sweep = aEnd - aStart
        if (sweep <= 0) sweep += 2 * Math.PI
      }

      let minDist = Infinity
      for (let i = 0; i < segments; i++) {
        const t0 = i / segments
        const t1 = (i + 1) / segments
        const a0 = anticlockwise ? aStart - sweep * t0 : aStart + sweep * t0
        const a1 = anticlockwise ? aStart - sweep * t1 : aStart + sweep * t1

        const px0 = cx + r * Math.cos(a0)
        const py0 = cy + r * Math.sin(a0)
        const px1 = cx + r * Math.cos(a1)
        const py1 = cy + r * Math.sin(a1)

        const d = distToSegment(point, new THREE.Vector2(px0, py0), new THREE.Vector2(px1, py1))
        if (d < minDist) minDist = d
      }

      const dist = Math.max(0, minDist - strokeW / 2)
      registerHit('arc', index, dist, arc.locked)
    })

    // 4. Check Circles
    fp.fpCircles.forEach((circle, index) => {
      if (!this.isLayerVisible(circle.layer, this.currentLayerVisibility)) return

      const center = new THREE.Vector2(nmToMm(circle.center.x), -nmToMm(circle.center.y))
      const r =
        Math.hypot(circle.end.x - circle.center.x, circle.end.y - circle.center.y) / NM_PER_MM
      const strokeW = circle.strokeWidth !== undefined ? nmToMm(circle.strokeWidth) : 0.05
      const isFilled = isSolidFill(circle.fill)

      const distToCenter = point.distanceTo(center)
      let dist: number
      if (isFilled && distToCenter <= r) {
        dist = 0
      } else {
        dist = Math.max(0, Math.abs(distToCenter - r) - strokeW / 2)
      }
      registerHit('circle', index, dist, circle.locked)
    })

    // 5. Check Rectangles
    fp.fpRects.forEach((rect, index) => {
      if (!this.isLayerVisible(rect.layer, this.currentLayerVisibility)) return

      const sx = nmToMm(rect.start.x)
      const sy = -nmToMm(rect.start.y)
      const ex = nmToMm(rect.end.x)
      const ey = -nmToMm(rect.end.y)

      const xMin = Math.min(sx, ex)
      const xMax = Math.max(sx, ex)
      const yMin = Math.min(sy, ey)
      const yMax = Math.max(sy, ey)

      const strokeW = rect.strokeWidth !== undefined ? nmToMm(rect.strokeWidth) : 0.12
      const isFilled = isSolidFill(rect.fill)

      let dist: number
      if (isFilled && point.x >= xMin && point.x <= xMax && point.y >= yMin && point.y <= yMax) {
        dist = 0
      } else {
        const d1 = distToSegment(
          point,
          new THREE.Vector2(xMin, yMin),
          new THREE.Vector2(xMax, yMin)
        )
        const d2 = distToSegment(
          point,
          new THREE.Vector2(xMax, yMin),
          new THREE.Vector2(xMax, yMax)
        )
        const d3 = distToSegment(
          point,
          new THREE.Vector2(xMax, yMax),
          new THREE.Vector2(xMin, yMax)
        )
        const d4 = distToSegment(
          point,
          new THREE.Vector2(xMin, yMax),
          new THREE.Vector2(xMin, yMin)
        )
        dist = Math.max(0, Math.min(d1, d2, d3, d4) - strokeW / 2)
      }
      registerHit('rect', index, dist, rect.locked)
    })

    // 6. Check Polygons
    fp.fpPolys.forEach((poly, index) => {
      if (!this.isLayerVisible(poly.layer, this.currentLayerVisibility)) return
      if (poly.points.length < 3) return

      const points = poly.points.map((p) => new THREE.Vector2(nmToMm(p.x), -nmToMm(p.y)))
      const strokeW = poly.strokeWidth !== undefined ? nmToMm(poly.strokeWidth) : 0.05
      const isFilled = isSolidFill(poly.fill)

      let dist: number
      if (isFilled && this.isPointInPolygon({ x: point.x, y: point.y }, points)) {
        dist = 0
      } else {
        let minDist = Infinity
        for (let i = 0; i < points.length; i++) {
          const p0 = points[i]
          const p1 = points[(i + 1) % points.length]
          const d = distToSegment(point, p0, p1)
          if (d < minDist) minDist = d
        }
        dist = Math.max(0, minDist - strokeW / 2)
      }
      registerHit('poly', index, dist, poly.locked)
    })

    // 7. Check Zones (Rule Areas)
    fp.zones.forEach((zone, index) => {
      if (!this.isLayerVisible(zone.layer, this.currentLayerVisibility)) return
      if (zone.points.length < 3) return

      const points = zone.points.map((p) => new THREE.Vector2(nmToMm(p.x), -nmToMm(p.y)))
      const strokeW = Math.min(zone.minThickness ?? 0.06, 0.08)

      let dist: number
      if (this.isPointInPolygon({ x: point.x, y: point.y }, points)) {
        dist = 0
      } else {
        let minDist = Infinity
        for (let i = 0; i < points.length; i++) {
          const p0 = points[i]
          const p1 = points[(i + 1) % points.length]
          const d = distToSegment(point, p0, p1)
          if (d < minDist) minDist = d
        }
        dist = Math.max(0, minDist - strokeW / 2)
      }
      registerHit('zone', index, dist)
    })

    // 7.5. Béziers, points, text boxes and tables: one geometry for paint and click
    for (const [type, items] of footprintExtraCollections(fp)) {
      items.forEach((item, index) => {
        if (!this.isLayerVisible(item.layer, this.currentLayerVisibility)) return
        registerHit(
          type,
          index,
          extraGraphicDistance(item, point, engineSpace, 1 / NM_PER_MM),
          item.locked
        )
      })
    }

    // 8. Check Text Labels (properties and fp_texts). These render as batched
    // stroke instances (nothing raycastable), so hit-test them analytically
    // against the stroke bounding box in the text's local frame.
    const checkText = (
      type: string,
      index: number,
      text: string,
      position: { x: number; y: number; angle?: number } | undefined,
      keepUpright: boolean,
      layer: string | undefined,
      hide: boolean | undefined,
      fontEffects: KicadFontEffects | undefined,
      locked: boolean
    ): void => {
      if (!text || !position || hide) return
      if (!this.isLayerVisible(layer, this.currentLayerVisibility)) return

      const local = footprintTextLocalBox(text, fontEffects)
      if (!local) return

      // Transform the click point into the text's local (unrotated) frame, by
      // the angle it draws at — the hit box has to match the glyphs.
      const angleRad = THREE.MathUtils.degToRad(footprintTextDrawAngle(position.angle, keepUpright))
      const cos = Math.cos(-angleRad)
      const sin = Math.sin(-angleRad)
      const dx = point.x - nmToMm(nm(position.x))
      const dy = point.y - -nmToMm(nm(position.y))
      const lx = dx * cos - dy * sin
      const ly = dx * sin + dy * cos

      const distX = Math.max(local.xMin - lx, lx - local.xMax, 0)
      const distY = Math.max(local.yMin - ly, ly - local.yMax, 0)
      registerHit(type, index, Math.hypot(distX, distY), locked)
    }

    fp.properties.forEach((prop, index) => {
      checkText(
        'property',
        index,
        prop.value,
        prop.position,
        prop.keepUpright,
        prop.layer,
        prop.hide,
        prop.fontEffects,
        prop.locked
      )
    })
    fp.fpTexts.forEach((text, index) => {
      checkText(
        'text',
        index,
        text.text,
        text.position,
        text.keepUpright,
        text.layer,
        text.hide,
        text.fontEffects,
        text.locked
      )
    })

    return rankFootprintHits(found).map(({ ref, kind, locked }) => ({
      levels: [{ kind, locked, ref }]
    }))
  }

  /**
   * Everything a band takes (`footprintBoxSelect`), each with the kind and
   * lock state the selection filter asks about — the band's answer in the
   * shape a click's is, so both resolve through the same policy.
   */
  public boxCandidates(
    bounds: { xMin: number; xMax: number; yMin: number; yMax: number },
    crossing: boolean
  ): Array<HitCandidate<{ type: string; index: number }>> {
    const fp = this.currentFootprint
    if (!fp) return []
    return footprintBoxSelect(fp, bounds, crossing, {
      isLayerVisible: (layer) => this.isLayerVisible(layer, this.currentLayerVisibility)
    }).map((ref) => ({
      levels: [{ kind: footprintItemKind(ref.type), locked: footprintItemLocked(fp, ref), ref }]
    }))
  }
}
