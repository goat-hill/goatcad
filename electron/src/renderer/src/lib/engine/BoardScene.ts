// Parts follow KiCad's source, named below: Copyright The KiCad Developers, GPL-3.0-or-later.
import * as THREE from 'three'
import { dimensionGeometry } from '../board/dimensionGeometry'
import { padMaskMargin } from '../board/maskExpansion'
import {
  footprintZonesOf,
  hasLegacyTeardrops,
  isTeardropZone,
  netDisplayNames,
  viaMaskIsOpen,
  KicadBoard,
  KicadBoardFootprint,
  KicadBoardZone,
  KicadGrText,
  KicadTrackArc,
  KicadTrackSegment,
  KicadVia
} from '../kicad/board'
import {
  KicadDimension,
  KicadFontEffects,
  KicadFpArc,
  KicadFpCircle,
  KicadFpLine,
  KicadFpPoly,
  KicadFpRect,
  KicadPad,
  type KicadFpText,
  type KicadProperty,
  footprintTextDrawAngle,
  expandFootprintText,
  footprintTextScope,
  type KicadExtraGraphic
} from '../kicad/footprint'
import {
  extraGraphicDistance,
  extraGraphicDrawing,
  extraGraphicExtent,
  extraGraphicPivot
} from '../board/extraGraphics'
import {
  arcAnchors,
  circleAnchors,
  lineAnchors,
  polyAnchors,
  rectAnchors,
  type AnchorPoint
} from '../moveAnchors'
import {
  BOARD_AREA_ALPHA,
  COPPER_LAYERS,
  DEFAULT_PCB_LAYER,
  DIM_ALPHA_FACTOR,
  DIM_ALPHA_FLOOR_EDGE_CUTS,
  LIFTED_SLOT_OFFSET,
  LayerStack,
  NETNAMES_PSEUDO_LAYER,
  PREVIEW_SLOT,
  PREVIEW_Z,
  VIA_PSEUDO_LAYER,
  ZONE_FILL_ALPHA,
  baseLayerAlpha,
  dimOpacityFor,
  expandLayerToken,
  isCopperLayer,
  layerSlot,
  layerZ,
  SELECTED_BAND,
  zoneHatchRises,
  resolveWildcardLayer,
  type LayerDepth
} from '../kicad/layers'
import { OVERLAY_ORDER, PaintOrder } from '../kicad/paintOrder'
import { currentAppTheme, kicadLayerColorsForTheme, themeColor, type AppTheme } from '../theme'
import { getTextStrokes, strokeOptionsFromEffects } from '../kicad/newstroke'
import type { NonActiveLayerDisplay } from '../board/layerPresets'
import { LayeredLabelBatch, LayeredPrimitiveBatch } from './LayeredBatch'
import { PART_SEPARATOR } from './keyHierarchy'
import { createHatchMaterial, HATCH_PATTERN } from './HatchShader'
import { difference, offset, type ClipRegion } from '../geometry/clip'
import type { HitCandidate } from '../selectionResolve'
import type { FillWorkRequest, FillWorkResponse } from './fillWorker'
import { arcContainsMidCCW, arcPolyline, circumscribedCircle } from './arcGeometry'
import { soleSelection, VertexHandles, type VertexHandleSpec } from './VertexHandles'
import { EDGE_CUTS, buildBoardOutline } from './board3d/boardOutline'
import { boardVertexShape, isVertexItemType, shapeVertices } from '../board/graphicVertices'
import { patternMembers, patternMembership } from '../board/tuningPatterns'
import {
  liftFillMesh,
  placeFillMesh,
  repaintFillMeshes,
  selectionShift,
  setFillLook
} from './selectedBand'
import {
  META,
  copperBit,
  copperMask,
  createBoardViewUniforms,
  metaNetWord,
  dimToward,
  type BatchView
} from './boardView'
import type { CompositeLayerSpec, PreviewLayerSpec, ScreenScaled } from './ViewportEngine'
import { PrimitiveBatch } from './PrimitiveBatch'
import {
  holeAnnulus,
  holePalette,
  holeWallWidth,
  padHoleShape,
  roundHole,
  type HolePalette
} from './holes'
import { nm, NM_PER_MM, nmToMm, type Nm } from '../kicad/coordinates'
import { padCopperPieces, padHasPrimitives, padOutline, padPointDistance } from '../board/padCopper'
import { fractureRegion } from '../board/zoneFill'
import type { SExprNode } from '../kicad/sexpr'
import { OriginMarker } from './OriginMarker'
import { footprintTextLocalBox } from './FootprintScene'
import type { LayerClearanceOutline } from '../board/clearanceOutlines'
import { sampleArc, type CopperShape } from '../board/spatialIndex'

/**
 * One command's exact change, as PcbEditor captures it: the changed top-level
 * AST nodes plus pre-command array snapshots (pointer copies) so old
 * positions survive the in-place writes mutators perform. Input to
 * `BoardScene.applyBoardEdit`.
 */
export interface BoardEditDelta {
  /** Monotonic per-command id so a viewport applies each delta exactly once. */
  id: number
  /** The board this delta transitions FROM — must match the drawn scene. */
  fromBoard: KicadBoard
  /** Top-level AST nodes the command added, removed, or mutated. */
  raws: ReadonlySet<SExprNode>
  prev: {
    segments: readonly KicadTrackSegment[]
    trackArcs: readonly KicadTrackArc[]
    vias: readonly KicadVia[]
    footprints: readonly KicadBoardFootprint[]
    zones: readonly KicadBoardZone[]
  }
}

/** A cache-miss zone fill awaiting triangulation (worker or fallback). */
interface PendingFill {
  anchor: THREE.Object3D
  scenePts: Array<{ x: number; y: number }>
  cacheKey: Array<{ x: number; y: number }>
  color: THREE.Color
  opacity: number
  z: number
  /** The net of the item it fills, for net focus (`FillLook.net`). */
  net: number
  /** fillGeneration at queue time; stale results skip the mesh build */
  generation: number
}

export interface BoardDisplayOptions {
  nonActiveDisplay?: NonActiveLayerDisplay
  /** What 'dim' leaves of a non-active layer's color (`render.board`'s `dim`). Default `DIM_ALPHA_FACTOR`. */
  dimStrength?: number
  /** View the board from the back: mirrors X and stacks back layers on top */
  flipped?: boolean
  /** Draw computed zone fills (default true); off leaves outline + hatch. */
  zoneFills?: boolean
  /** Sketch (outline-only) rendering per copper class — lib/pcbView.ts. */
  sketchTracks?: boolean
  sketchVias?: boolean
  sketchPads?: boolean
  /** Tint the area inside a closed board outline (default true) — lib/pcbView.ts. */
  boardArea?: boolean
  /**
   * While routing: dim everything except this net's copper (tracks, vias,
   * pads, pours), KiCad's routing focus. 0/undefined = no dimming.
   */
  highlightNet?: number
  /**
   * KiCad's footprint-text switches (LAYER_FP_REFERENCES / _VALUES / _TEXT):
   * a footprint's Reference, its Value, and its other fields and texts — each
   * drawn and clickable only while on (default true). `footprintTextClass`.
   */
  fpReferences?: boolean
  fpValues?: boolean
  fpText?: boolean
}

/**
 * What `BoardScene.applyView` shows a built board in: the parts of the display
 * that change without drawing anything again.
 */
export interface BoardViewState {
  activeLayer?: string
  layerVisibility?: Record<string, boolean>
  nonActiveDisplay?: NonActiveLayerDisplay
  /** A live route's or drag's net, lit while the rest sinks (`highlightNet`); 0 for none. */
  focusNet?: number
}

/** What a placed footprint covers as drawn (`BoardScene.footprintBoundsAt`). */
interface FootprintExtent {
  /** Where it is placed, data-scene mm: its box when nothing of it shows. */
  place: { x: number; y: number }
  /** Its pads and zones: the part on any layer. */
  part: Bounds2D
  /** Its drawings and texts' anchors, by the layer each is on. */
  byLayer: Map<string, Bounds2D>
  /** Its texts' glyph boxes, by layer: how far its children reach. */
  reachByLayer: Map<string, Bounds2D>
}

const emptyBounds = (): Bounds2D => ({
  minX: Infinity,
  minY: Infinity,
  maxX: -Infinity,
  maxY: -Infinity
})

function growBounds(b: Bounds2D, x: number, y: number, pad: number): void {
  b.minX = Math.min(b.minX, x - pad)
  b.minY = Math.min(b.minY, y - pad)
  b.maxX = Math.max(b.maxX, x + pad)
  b.maxY = Math.max(b.maxY, y + pad)
}

function unionBounds(into: Bounds2D, b: Bounds2D): void {
  into.minX = Math.min(into.minX, b.minX)
  into.minY = Math.min(into.minY, b.minY)
  into.maxX = Math.max(into.maxX, b.maxX)
  into.maxY = Math.max(into.maxY, b.maxY)
}

/** A layer's box in a per-layer map, made on first use. */
function boundsIn(byLayer: Map<string, Bounds2D>, layer: string): Bounds2D {
  let b = byLayer.get(layer)
  if (!b) byLayer.set(layer, (b = emptyBounds()))
  return b
}

/** What a fill mesh keeps for `paintFill` to decide its look from (`userData`). */
interface FillLook {
  /** Its own color — the diff's tone written over it. */
  defaultColor: THREE.Color
  opacity: number
  net: number
  selected: boolean
}

/** How the visual diff paints a board (`BoardScene.applyDiffPaint`), by element key. */
export interface BoardDiffPaint {
  /** Added, moved or changed: drawn in their own colors. */
  changed: ReadonlySet<string>
  /** Removed items drawn back in where they were: in the error red. */
  removed: ReadonlySet<string>
}

/**
 * Selection item on a board. Types:
 *   footprint | segment | tarc | via | zone |
 *   gr_line | gr_arc | gr_circle | gr_rect | gr_poly | gr_text | pad |
 *   fp_field | fp_text (a footprint's field or text: `index` the footprint, `child` its own)
 */
export interface BoardItemRef {
  type: string
  index: number
  /**
   * Pad index when `type === 'pad'` — `index` is then the owning FOOTPRINT's
   * index, mirroring the paint key `footprint:N/pad:M`. Editors that don't
   * allow pad selection never see one (SELECTABLE_KINDS, selectionResolve.ts).
   */
  pad?: number
  /**
   * A footprint field's (`fp_field`) or text's (`fp_text`) index in its
   * footprint's `properties` or `fpTexts`; `index` is the footprint's, as for a pad.
   */
  child?: number
}

/** A footprint field or text as drawn, kept as a click target (`BoardScene.footprintTextHits`). */
interface FootprintTextHit {
  type: 'fp_field' | 'fp_text'
  child: number
  /** Where it draws, scene mm (y up), and the angle it draws at, radians. */
  x: number
  y: number
  angle: number
  /** Its glyph box in its own frame (`footprintTextLocalBox`). */
  box: { xMin: number; xMax: number; yMin: number; yMax: number }
  layer: string | undefined
  locked: boolean
}

/** A board item that lives inside a footprint: a pad, a field or a text. */
export const isFootprintChild = (type: string): boolean =>
  type === 'pad' || type === 'fp_field' || type === 'fp_text'

/**
 * Which of KiCad's footprint-text switches governs a field or text: Reference
 * and Value have their own, and a text reading `${REFERENCE}` or `${VALUE}`
 * follows them (`PCB_SELECTION_TOOL::Selectable`); everything else is text.
 */
export function footprintTextClass(
  item: { key: string } | { type: 'reference' | 'value' | 'user'; text: string }
): 'reference' | 'value' | 'text' {
  if ('key' in item)
    return item.key === 'Reference' ? 'reference' : item.key === 'Value' ? 'value' : 'text'
  if (item.type !== 'user') return item.type
  return item.text === '${REFERENCE}' ? 'reference' : item.text === '${VALUE}' ? 'value' : 'text'
}

/**
 * The selection-filter kind for a board item type.
 *
 * Coarser than `BoardItemRef.type` on purpose: a user filters "Graphics", not
 * `gr_rect` separately from `gr_poly`, and "Tracks" covers straight segments and
 * arcs alike. `SELECTABLE_KINDS.pcb` (lib/selectionResolve.ts) lists the values
 * this returns, and the panel's checkboxes are that list — so a type added here
 * without a kind would be unfilterable, and a kind listed there that nothing
 * maps to would be a checkbox that does nothing.
 *
 * A keepout zone is KiCad's rule area and filters apart from copper zones, as
 * KiCad's "Rule areas" switch does; `ruleArea` says which a zone is.
 */
/**
 * The key a board item is selected and painted under: `type:index`, and a pad
 * under its footprint's, `footprint:N/pad:M` — the paint key it renders with.
 */
export const boardRefKey = (ref: {
  type: string
  index: number
  pad?: number
  child?: number
}): string =>
  ref.type === 'pad'
    ? `footprint:${ref.index}/pad:${ref.pad}`
    : ref.type === 'fp_field'
      ? `footprint:${ref.index}/field:${ref.child}`
      : ref.type === 'fp_text'
        ? `footprint:${ref.index}/text:${ref.child}`
        : `${ref.type}:${ref.index}`

/**
 * The selection as move, rotate, flip and copy act on it: a pad stands for its
 * footprint, as KiCad's board editor promotes one (`FilterCollectorForFreePads`
 * with free pads off), each footprint once. A field or text stays itself — it
 * moves on its own — unless its footprint is in the selection too, which
 * carries it (`dropKeysCoveredByParent`'s rule: never moved twice).
 */
export function promotePads<
  T extends { type: string; index: number; pad?: number; child?: number }
>(refs: readonly T[]): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const ref of refs) {
    const acted = ref.type === 'pad' ? ({ type: 'footprint', index: ref.index } as T) : ref
    const key = boardRefKey(acted)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(acted)
  }
  const footprints = new Set(out.filter((r) => r.type === 'footprint').map((r) => r.index))
  return out.filter((r) => !(isFootprintChild(r.type) && footprints.has(r.index)))
}

/** The footprint a selection names, for what speaks of parts (cross-probe): a child's is its footprint's. */
export const footprintsOf = (refs: ReadonlyArray<{ type: string; index: number }>): number[] => [
  ...new Set(
    refs.filter((r) => r.type === 'footprint' || isFootprintChild(r.type)).map((r) => r.index)
  )
]

export function boardItemKind(type: string, ruleArea = false): string {
  switch (type) {
    case 'zone':
      return ruleArea ? 'rule_area' : 'zone'
    // A tuning pattern is its tracks, as KiCad's filter takes it.
    case 'segment':
    case 'tarc':
    case 'tuning_pattern':
      return 'track'
    case 'gr_line':
    case 'gr_arc':
    case 'gr_circle':
    case 'gr_rect':
    case 'gr_poly':
    case 'gr_curve':
      return 'graphic'
    // A text box, a table and a footprint's fields and texts are text, as
    // KiCad's filter has them.
    case 'gr_text':
    case 'gr_text_box':
    case 'table':
    case 'fp_field':
    case 'fp_text':
      return 'text'
    default:
      // via, footprint — their type is already the kind.
      return type
  }
}

/**
 * Cross-type priority at equal distance, lowest first.
 *
 * This is the order the hit-test loops run in, made explicit so the ranking
 * survives being sorted. Small things come before the large things they sit
 * on, which is why a via inside a footprint's bounding box wins the tie.
 */
const BOARD_TYPE_RANK: Record<string, number> = {
  via: 0,
  segment: 1,
  tarc: 2,
  gr_line: 3,
  gr_arc: 4,
  gr_circle: 5,
  gr_rect: 6,
  gr_poly: 7,
  gr_curve: 7.2,
  point: 7.4,
  gr_text: 8,
  gr_text_box: 8.2,
  table: 8.4,
  zone: 9,
  // Between zone and footprint: a pad is precise where the footprint's bbox is
  // not, so it must outrank the bare bbox — but every small free-standing item
  // (via, track) still wins a distance tie on top of a pad, as it does today.
  pad: 9.5,
  // A footprint's text outranks its pads at a tie: it is the smaller target,
  // and sits on silkscreen over them.
  fp_field: 9.3,
  fp_text: 9.4,
  footprint: 10
}

/** The `locked` flag behind a board item, for the filter's Locked switch. */
export function boardItemLocked(board: KicadBoard, ref: BoardItemRef): boolean {
  switch (ref.type) {
    case 'footprint':
      return board.footprints[ref.index]?.footprint.locked ?? false
    case 'segment':
      return board.segments[ref.index]?.locked ?? false
    case 'tarc':
      return board.trackArcs[ref.index]?.locked ?? false
    case 'via':
      return board.vias[ref.index]?.locked ?? false
    case 'zone':
      return board.zones[ref.index]?.locked ?? false
    case 'gr_line':
      return board.grLines[ref.index]?.locked ?? false
    case 'gr_arc':
      return board.grArcs[ref.index]?.locked ?? false
    case 'gr_circle':
      return board.grCircles[ref.index]?.locked ?? false
    case 'gr_rect':
      return board.grRects[ref.index]?.locked ?? false
    case 'gr_poly':
      return board.grPolys[ref.index]?.locked ?? false
    case 'gr_text':
      return board.grTexts[ref.index]?.locked ?? false
    case 'gr_curve':
      return board.grCurves[ref.index]?.locked ?? false
    case 'gr_text_box':
      return board.grTextBoxes[ref.index]?.locked ?? false
    case 'table':
      return board.tables[ref.index]?.locked ?? false
    default:
      return false
  }
}

/** One thing the cursor is over, with everything the ranking below sorts on. */
export interface RankedBoardHit {
  hit: BoardItemRef
  kind: string
  locked: boolean
  dist: number
  /** Where its layer paints in the live view (`PaintOrder.rank`): higher is drawn over lower. */
  above: number
  /** `BOARD_TYPE_RANK` for the item's type. */
  rank: number
  /** Registration order, which is the order the hit-test loops run in. */
  order: number
  /**
   * The level this hit resolves UP to when its own kind is disallowed — a
   * pad's owning footprint. Most board items contain nothing and carry none.
   */
  outer?: { kind: string; locked: boolean; ref: BoardItemRef }
}

/**
 * Put the things under the cursor in the order a click should prefer them, as
 * a total order so the whole list survives rather than only the winner:
 *
 *   1. nearest first;
 *   2. then the cross-type priority, so a via inside a footprint's bounding box
 *      still wins their distance-0 tie;
 *   3. then paint rank descending — overlapping SAME-type elements tie on distance
 *      constantly (two texts stacked front/back both contain the click) and file
 *      order would otherwise pick the visually hidden one, so the tie goes to
 *      whatever renders on top;
 *   4. then later-registered first, because equal-depth fragments drawn later
 *      overwrite earlier ones (real boards carry same-layer duplicate texts as
 *      drop shadows).
 *
 * Steps 3 and 4 only ever compare items of one type, step 2 having separated
 * the rest, which is what makes this a total order. Sorts in place and
 * returns the same array.
 */
export function rankBoardHits(found: RankedBoardHit[]): RankedBoardHit[] {
  return found.sort(
    (a, b) => a.dist - b.dist || a.rank - b.rank || b.above - a.above || b.order - a.order
  )
}

/** Scene-space transform of a placed footprint (position + rotation). */
interface FootprintTransform {
  tx: number
  ty: number
  cos: number
  sin: number
}

interface Bounds2D {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

const ROUTE_PREVIEW_KEY = '__route_preview'
const WHITE = new THREE.Color('#ffffff')
const BLACK = new THREE.Color('#000000')

/** One airwire, world-space y-up endpoints; its net decides its tone under net focus. */
export interface RatsnestWire {
  from: { x: number; y: number }
  to: { x: number; y: number }
  net?: number
}

/** One segment of a route in progress, in data-scene coordinates (mm, y up). */
export interface RoutePreviewSegment {
  x0: number
  y0: number
  x1: number
  y1: number
  width: number
  layer: string
  violation?: boolean
}

/**
 * Opacities of a route in progress. What this pass has placed reads as the
 * track it is about to be — lit like the focused net, nearly solid; the head
 * still following the cursor is fainter, so the two stay apart where they
 * meet. The via's ring is drawn solid: it is a place, not a path.
 */
const ROUTE_PLACED_OPACITY = 0.8
const ROUTE_HEAD_OPACITY = 0.6
/** How much of the selection's lift the head takes; the placed part takes all of it. */
const ROUTE_HEAD_LIFT = 0.5
/**
 * Pushed copper is drawn as KiCad's router draws it, nearly solid; its
 * layers are flattened, so the joints of a pushed line do not stack.
 */
const SHOVED_OPACITY = 0.85
/** The gray halo of the clearance pushed and violated copper keeps. */
const HALO_OPACITY = 0.3
/** The preview's stacking: halos under board copper in motion under the route. */
const PREVIEW_TIER_HALO = 0
const PREVIEW_TIER_COPPER = 1
const PREVIEW_TIER_ROUTE = 2
const SHOVE_PREVIEW_KEY = '__shove_preview'
const VIOLATION_MARKS_KEY = '__violation_marks'
const DRAFT_PREVIEW_KEY = '__draft_preview'
const CLEARANCE_OUTLINES_KEY = '__clearance_outlines'
/** The outlines of copper being dragged: carried along with it (`translateElements`). */
const MOVING_CLEARANCE_KEY = '__clearance_outlines_moving'
/**
 * Which outlines a set is: the board's (the active layer's copper) or the
 * selection's (selected copper on the other visible layers). Each is drawn as
 * parts of the keys above, so a click redraws only the selection's.
 */
type ClearanceOutlineSet = 'board' | 'selected'
const outlineKey = (set: ClearanceOutlineSet, moving: boolean): string =>
  `${moving ? MOVING_CLEARANCE_KEY : CLEARANCE_OUTLINES_KEY}${PART_SEPARATOR}${set}`
const ROUTE_CLEARANCE_KEY = '__route_clearance'
const DRAG_CLEARANCE_KEY = '__drag_clearance'

/**
 * Per-item cost weights behind the build fraction `rebuildSteps` reports. A
 * footprint carries its pads, silk and stroke text, so it is worth tens of
 * track segments; counting items alone would make the bar crawl through the
 * footprints and then leap through everything else.
 */
const FOOTPRINT_WEIGHT = 20
const ZONE_WEIGHT = 5

/** A pad's copper as `ownNetPadFaces` tests it: scene mm, y up, unflipped. */
interface PadArea {
  x: number
  y: number
  cos: number
  sin: number
  halfW: number
  halfH: number
  round: boolean
  layers: Set<string>
}

/** Two ink batches' debug entries as one map, each key marked with its ink. */
const inkedElements = (light: LayeredLabelBatch, dark: LayeredLabelBatch): Map<string, string[]> =>
  new Map([
    ...[...light.debugElements()].map(([key, rows]) => [`light|${key}`, rows] as const),
    ...[...dark.debugElements()].map(([key, rows]) => [`dark|${key}`, rows] as const)
  ])

/** Triangles for filled regions (holes cut out), in the plane of their points. */
const shapeGeometryOf = (regions: readonly ClipRegion[]): THREE.BufferGeometry => {
  const shapes = regions.map((region) => {
    const shape = new THREE.Shape(region.outer.map((p) => new THREE.Vector2(p.x, p.y)))
    for (const hole of region.holes) {
      shape.holes.push(new THREE.Path(hole.map((p) => new THREE.Vector2(p.x, p.y))))
    }
    return shape
  })
  return new THREE.ShapeGeometry(shapes)
}

/** WCAG contrast between two colors: how well one reads on the other. */
const contrastRatio = (a: THREE.Color, b: THREE.Color): number => {
  const luminance = (c: THREE.Color): number => {
    // THREE.Color holds linear channels once color management is on, and sRGB
    // otherwise; getRGB in SRGBColorSpace gives sRGB either way.
    const srgb = { r: 0, g: 0, b: 0 }
    c.getRGB(srgb, THREE.SRGBColorSpace)
    const lin = (v: number): number => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
    return 0.2126 * lin(srgb.r) + 0.7152 * lin(srgb.g) + 0.0722 * lin(srgb.b)
  }
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/** Items rendered between progress yields, sized to keep a chunk cheap. */
const FOOTPRINT_CHUNK = 8
const ITEM_CHUNK = 512

/**
 * The copper layers `*.Cu` expands to on this board, in stack order. Layers
 * past `COPPER_LAYERS` are dropped rather than drawn on a fallback slot — the
 * scene has colors and slots for six, and a deeper board is a gap to close in
 * the stack, not something to paint as silkscreen.
 */
const boardCopperLayers = (board: KicadBoard): string[] => {
  const enabled = new Set(board.layers.map((l) => l.name))
  const copper = COPPER_LAYERS.filter((l) => enabled.has(l))
  return copper.length > 0 ? copper : ['F.Cu', 'B.Cu']
}

/**
 * GPU-batched scene for a KiCad board (.kicad_pcb). Reuses the same engine
 * primitives as the footprint editor (PrimitiveBatch SDF instances, LabelBatch
 * SDF glyphs, NewStroke text) but renders at board granularity: each placed
 * footprint is one selectable/movable unit, plus individual track segments,
 * arcs, vias, zones, and board graphics.
 */
/** Where the held footprint's paint is filed: an index no board footprint has. */
const GHOST_REF = { type: 'footprint', index: -1 } as const
const GHOST_KEY = `${GHOST_REF.type}:${GHOST_REF.index}`

export class BoardScene {
  private scene: THREE.Scene
  private fillGroup: THREE.Group
  /**
   * The board-area tint, as an engine composite layer: those paint straight
   * after the grid, which puts the area under the dimmed layers as well as the
   * document. The scene holds plain coverage; the spec carries the color.
   */
  private readonly boardArea = new THREE.Scene()
  private readonly boardAreaMaterial = new THREE.MeshBasicMaterial({
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide
  })
  private readonly boardAreaLayer: CompositeLayerSpec = {
    scene: this.boardArea,
    color: new THREE.Color('#7f988a'),
    opacity: BOARD_AREA_ALPHA,
    visible: false
  }

  private batch: LayeredPrimitiveBatch
  /**
   * Pad labels, in two inks: light on dark copper, dark on light copper —
   * KiCad's rule (`pcb_painter.cpp`, the netname layer colors), since a label
   * reads against the copper it sits on, not the canvas. The ink is a batch
   * uniform, so each ink is its own batch.
   */
  private labelBatch: LayeredLabelBatch
  private labelBatchDark: LayeredLabelBatch
  /** Net names on tracks/vias — separate from pad ink so it clears cheaply. */
  private trackLabelBatch: LayeredLabelBatch
  private trackLabelBatchDark: LayeredLabelBatch
  private inkOnDark = new THREE.Color('#eef3f0')
  private inkOnLight = new THREE.Color('#121a16')

  private get padLabelBatches(): LayeredLabelBatch[] {
    return [this.labelBatch, this.labelBatchDark]
  }

  private get trackLabelBatches(): LayeredLabelBatch[] {
    return [this.trackLabelBatch, this.trackLabelBatchDark]
  }

  private get labelBatches(): LayeredLabelBatch[] {
    return [...this.padLabelBatches, ...this.trackLabelBatches]
  }

  /**
   * Whether dark ink reads better than light on EVERYTHING a label covers:
   * the ink whose worst contrast across those backgrounds is higher. A label
   * on plain copper reads against that copper alone; one on a drilled pad or a
   * via also crosses the bore at its center, so it must read there too —
   * why KiCad keeps a through-hole pad's net name light even on a copper
   * layer whose own labels go dark (its pad net-name layer).
   */
  private darkInkOn(...backgrounds: THREE.Color[]): boolean {
    const worst = (ink: THREE.Color): number =>
      Math.min(...backgrounds.map((background) => contrastRatio(ink, background)))
    return worst(this.inkOnLight) > worst(this.inkOnDark)
  }

  private layerColors: Record<string, THREE.Color> = {}
  private selectionLighten = true
  private holes: HolePalette = holePalette()

  // Anchor object per element key: userData (type/index) + fill meshes
  private elements: Record<string, THREE.Object3D> = {}
  /**
   * What each placed footprint covers as drawn, by layer (`FootprintExtent`):
   * its box in a view is what of it shows (`footprintBoundsAt`), since a
   * footprint's drawings on a layer switched off are built but not there.
   */
  private footprintExtents: FootprintExtent[] = []
  /** The boxes of the footprints asked about in this view; cleared by a view or an edit. */
  private footprintBoxes = new Map<number, { bounds: Bounds2D; reach: Bounds2D }>()
  /**
   * Each footprint's drawn fields and texts as click targets, recorded where
   * they are drawn: the glyph box in the text's own frame, its center and the
   * angle it draws at. A hit test reads these rather than shaping every text
   * again per pointer move.
   */
  private footprintTextHits: FootprintTextHit[][] = []
  /**
   * The footprint Place Footprint holds: drawn by `renderFootprint` at an index
   * no board footprint has, so nothing picks it, and lifted and shifted with
   * the selection so it reads as a selected footprint does.
   */
  private ghost: { footprint: KicadBoardFootprint; delta: { x: number; y: number } } | null = null

  private currentBoard?: KicadBoard
  /** This board's copper layers, in stack order — what `*.Cu` expands to. */
  private copperLayers: string[] = ['F.Cu', 'B.Cu']
  private currentLayerVisibility?: Record<string, boolean>
  private currentActiveLayer?: string
  private nonActiveDisplay: NonActiveLayerDisplay = 'show'
  private dimStrength = DIM_ALPHA_FACTOR
  private flipped = false
  private zoneFillsVisible = true
  /** The focused net, a live route's or drag's (`BoardDisplayOptions.highlightNet`); 0 for none. */
  private highlightNet = 0
  /** Per-net display names (KiCad short/disambiguated) for pad ink. */
  private netLabels = new Map<number, string>()
  /** The canvas color, which off-net copper sinks toward under net focus. */
  private background = new THREE.Color(themeColor('--vscode-bg-viewport', '#101513'))
  /** What every batch reads of the view (`boardView.ts`); `applyView` writes it. */
  private readonly viewUniforms = createBoardViewUniforms()
  private sketchTracks = false
  /** Tint the area inside the board outline (`BoardDisplayOptions.boardArea`). */
  private boardAreaVisible = true
  /** KiCad's footprint-text switches, by `footprintTextClass`. */
  private fpTextShown = { reference: true, value: true, text: true }
  private sketchVias = false
  private sketchPads = false

  /** Negative alpha = the batch shader's sketch (outline) mode. */
  private static sketchSign(sketch: boolean, alpha: number): number {
    return sketch ? -Math.max(alpha, 0.05) : alpha
  }

  /**
   * How much of off-net content's color survives while a net has routing
   * focus. Darker rather than fainter, as KiCad dims for a highlighted net, so
   * off-net copper stays solid and its overlaps cannot stack into a lattice of
   * joints; the focused net is lit as a selection is.
   */
  private static readonly NET_DIM = 0.3

  /**
   * The meta the next writes carry, on every batch (`boardView.ts`): the item's
   * net, and — for an instance that stands for the whole item, a hole or a
   * multi-layer label — its copper span and the faces its label reads on.
   */
  private setItemMeta(net = 0, flags = 0, span = 0, darkInk = 0, ownPad = 0): void {
    this.itemNet = net
    for (const meta of [this.batch.writeMeta, ...this.labelBatches.map((b) => b.writeMeta)]) {
      meta[0] = metaNetWord(net, flags)
      meta[1] = span
      meta[2] = darkInk
      meta[3] = ownPad
    }
  }

  /** The net of the item being written, for the fills it lands (`FillLook.net`). */
  private itemNet = 0

  /** The item about to be written is on `net` (none for graphics). */
  private setItemNet(net: number | undefined): void {
    this.setItemMeta(net ?? 0)
  }

  /** `PrimitiveBatch.shiftElementColors`' shift, for one color. */
  private shiftedColor(color: THREE.Color, amount: number, out: THREE.Color): THREE.Color {
    return out.copy(color).lerp(amount >= 0 ? WHITE : BLACK, Math.abs(amount))
  }

  constructor(scene: THREE.Scene) {
    this.scene = scene
    this.routePool = new PreviewLayerPool(scene)
    this.shovePool = new PreviewLayerPool(scene)
    this.markPool = new PreviewLayerPool(scene)

    this.fillGroup = new THREE.Group()
    this.scene.add(this.fillGroup)

    this.batch = new LayeredPrimitiveBatch(
      layerSlot,
      (slot) => this.paint.renderOrder(slot, 'stroke'),
      { minStrokePixels: 1 },
      512,
      SELECTED_BAND,
      this.viewUniforms
    )
    this.batch.slotCreated = (slot, batch) => this.viewSlot(slot, batch)
    this.scene.add(this.batch.group)

    const labels = (dark: boolean): LayeredLabelBatch => {
      const batches = new LayeredLabelBatch(
        layerSlot,
        (slot) => this.paint.renderOrder(slot, 'label'),
        128,
        SELECTED_BAND,
        this.viewUniforms
      )
      batches.slotCreated = (slot, batch) => {
        // A label drawn in both inks shows in the one that reads (`META.INK_BY_FACING`).
        batch.view!.slot.uInkDark.value = dark ? 1 : 0
        this.viewSlot(slot, batch)
      }
      return batches
    }
    this.labelBatch = labels(false)
    this.labelBatchDark = labels(true)
    this.trackLabelBatch = labels(false)
    this.trackLabelBatchDark = labels(true)
    for (const labels of this.labelBatches) this.scene.add(labels.group)

    // Airwires draw as true hairlines (constant 1 px at every zoom — they are
    // guidance, not geometry), above all copper and below selection chrome.
    this.ratsnestMaterial = new THREE.LineBasicMaterial({
      transparent: true,
      opacity: 0.75,
      vertexColors: true,
      depthTest: false,
      depthWrite: false
    })
    this.ratsnestLines = new THREE.LineSegments(new THREE.BufferGeometry(), this.ratsnestMaterial)
    this.ratsnestLines.renderOrder = OVERLAY_ORDER.ratsnest
    this.ratsnestLines.frustumCulled = false
    this.scene.add(this.ratsnestLines)
    this.leadLine = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ depthTest: false, depthWrite: false })
    )
    this.leadLine.renderOrder = OVERLAY_ORDER.ratsnest
    this.leadLine.frustumCulled = false
    this.leadLine.visible = false
    this.scene.add(this.leadLine)

    this.vertexHandles = new VertexHandles(scene)
    this.scene.add(this.drillOriginMarker.object)

    this.setView({})
    this.applyTheme(currentAppTheme())
    this.applyViewState()
  }

  /**
   * Every color the scene draws with, for one theme. One entry point rather
   * than a setter per concern: a viewport applies a theme, it does not manage
   * a palette, a selection direction and a label ink separately.
   */
  public applyTheme(theme: AppTheme): void {
    this.setLayerColors(kicadLayerColorsForTheme(theme))
    this.selectionLighten = theme === 'dark'
    this.background = new THREE.Color(themeColor('--vscode-bg-viewport', '#101513'))
    this.holes = holePalette()
    this.inkOnDark = new THREE.Color(themeColor('--vscode-canvas-ink-on-dark', '#eef3f0'))
    this.inkOnLight = new THREE.Color(themeColor('--vscode-canvas-ink-on-light', '#121a16'))
    this.labelBatch.setColor(this.inkOnDark)
    this.trackLabelBatch.setColor(this.inkOnDark)
    this.labelBatchDark.setColor(this.inkOnLight)
    this.trackLabelBatchDark.setColor(this.inkOnLight)
    this.viewUniforms.uBackground.value.copy(this.background)
    this.viewUniforms.uFocusShift.value = this.selectionShift()
    this.ratsnestColor = new THREE.Color(themeColor('--vscode-canvas-ratsnest', '#b8c7be'))
    ;(this.leadLine.material as THREE.LineBasicMaterial).color = this.shiftedColor(
      this.ratsnestColor,
      this.selectionShift(),
      new THREE.Color()
    )
    this.emitRatsnest()
    this.boardAreaLayer.color.set(themeColor('--vscode-canvas-board-area', '#7f988a'))
    this.drillOriginMarker.setColor(themeColor('--vscode-accent', '#cca250'))
  }

  /** KiCad's drill / place file origin mark; hidden at 0,0 (`setDrillOrigin`). */
  private readonly drillOriginMarker = new OriginMarker(PREVIEW_Z)
  private drillOrigin: { x: number; y: number } | null = null

  /**
   * Mark the board's drill / place file origin, in board coordinates (mm, y
   * up), or clear the mark with null. Mirrored with the view like the board.
   */
  public setDrillOrigin(at: { x: number; y: number } | null): void {
    this.drillOrigin = at
    this.drillOriginMarker.place(at && { x: this.sx(at.x), y: at.y })
  }

  private setLayerColors(colors: Readonly<Record<string, string>>): void {
    this.layerColors = {}
    Object.entries(colors).forEach(([layer, hex]) => {
      this.layerColors[layer] = new THREE.Color(hex)
    })
  }

  private vertexHandles: VertexHandles

  private ratsnestLines: THREE.LineSegments
  private ratsnestMaterial: THREE.LineBasicMaterial
  private ratsnestColor = new THREE.Color('#b8c7be')
  private ratsnestWires: RatsnestWire[] = []
  /** The routed net's ratsnest from the head, to where it may connect next (router-behavior.md F7). */
  private leadLine: THREE.LineSegments

  /**
   * Draw the ratsnest: one hairline per airwire, world-space y-up endpoints.
   * The wires are kept and re-emitted on rebuild so a board flip mirrors them
   * with the copper; pass an empty array to clear.
   */
  public setRatsnest(wires: RatsnestWire[]): void {
    this.ratsnestWires = wires
    this.emitRatsnest()
  }

  /**
   * Under net focus the focused net's airwires are lit and every other net's
   * sink toward the canvas, as its copper does (router-behavior.md F8).
   */
  private emitRatsnest(): void {
    const positions = new Float32Array(this.ratsnestWires.length * 6)
    const colors = new Float32Array(this.ratsnestWires.length * 6)
    const lit = this.shiftedColor(this.ratsnestColor, this.selectionShift(), new THREE.Color())
    const sunk = this.ratsnestColor.clone().lerp(this.background, 1 - BoardScene.NET_DIM)
    this.ratsnestWires.forEach((wire, i) => {
      positions[i * 6] = this.sx(wire.from.x)
      positions[i * 6 + 1] = wire.from.y
      positions[i * 6 + 2] = PREVIEW_Z
      positions[i * 6 + 3] = this.sx(wire.to.x)
      positions[i * 6 + 4] = wire.to.y
      positions[i * 6 + 5] = PREVIEW_Z
      const color =
        this.highlightNet <= 0 ? this.ratsnestColor : wire.net === this.highlightNet ? lit : sunk
      for (const o of [i * 6, i * 6 + 3]) {
        colors[o] = color.r
        colors[o + 1] = color.g
        colors[o + 2] = color.b
      }
    })
    this.ratsnestLines.geometry.dispose()
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    this.ratsnestLines.geometry = geometry
  }

  /**
   * Draw the routed net's ratsnest from the head (F7, lit as F8 lights the
   * net's airwires), data-scene mm; [] hides it.
   */
  public setRouteRatsnest(
    lines: ReadonlyArray<{ from: { x: number; y: number }; to: { x: number; y: number } }>
  ): void {
    this.leadLine.visible = lines.length > 0
    if (lines.length === 0) return
    const positions = new Float32Array(lines.length * 6)
    lines.forEach((line, i) => {
      positions.set(
        [this.sx(line.from.x), line.from.y, PREVIEW_Z, this.sx(line.to.x), line.to.y, PREVIEW_Z],
        i * 6
      )
    })
    this.leadLine.geometry.dispose()
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    this.leadLine.geometry = geometry
  }

  /** Targets for `ViewportEngine.registerScreenScaled` (constant pixel size). */
  public screenScaledTargets(): ScreenScaled[] {
    return [this.vertexHandles, this.drillOriginMarker]
  }

  /**
   * Drag handles for the selected item: the points a graphic or a zone outline
   * is reshaped by (`lib/board/graphicVertices.ts` owns which, and what moving
   * one does). Only a sole selection grows handles (`soleSelection`), mirroring
   * the footprint editor.
   */
  public renderVertexHandles(selectedItems: BoardItemRef[]): void {
    const sole = soleSelection(selectedItems)
    const board = this.currentBoard
    const shape =
      sole && board && isVertexItemType(sole.type)
        ? boardVertexShape(board, sole.type, sole.index)
        : null
    if (!sole || !shape) {
      this.vertexHandles.render(null)
      return
    }
    const at = (pt: { x: Nm; y: Nm }): { x: number; y: number } => ({
      x: this.sx(nmToMm(pt.x)),
      y: -nmToMm(pt.y)
    })
    const parent = { parentType: sole.type, parentIndex: sole.index }
    const specs: VertexHandleSpec[] = shapeVertices(shape).map((pt, vertexIndex) => ({
      ...at(pt),
      // A circle's center is where you take hold of the circle, not a point
      // that resizes it.
      ...(shape.kind === 'circle' && vertexIndex === 0 ? { role: 'move' as const } : {}),
      data: { ...parent, vertexIndex }
    }))
    if (shape.kind === 'rect') {
      // Hit-testing measures distance to the outline, so an unfilled rectangle
      // has no interior to grab it by.
      specs.push({
        ...at({
          x: nm((shape.start.x + shape.end.x) / 2),
          y: nm((shape.start.y + shape.end.y) / 2)
        }),
        role: 'move',
        data: parent
      })
    }
    this.vertexHandles.render(specs)
  }

  /** Every layer's slot; every z the scene emits comes from it. */
  private readonly layers = new LayerStack()
  /** What draws over what in this view (ARCHITECTURE.md, Paint order). */
  private paint = new PaintOrder()

  /**
   * Show the built board in another view: the active layer, which layers show,
   * the non-active display, and the focused net (a live route's or drag's).
   * Nothing is drawn again (ARCHITECTURE.md, View state is applied, not
   * built): render orders, per-slot uniforms and visibility, the shared view
   * uniforms and the fills' looks are set.
   */
  public applyView(view: BoardViewState): void {
    this.setView(view)
    this.applyViewState()
  }

  private setView(view: BoardViewState): void {
    this.currentActiveLayer = view.activeLayer
    this.currentLayerVisibility = view.layerVisibility
    this.nonActiveDisplay = view.nonActiveDisplay ?? 'show'
    this.highlightNet = view.focusNet ?? 0
    this.layers.arrange({ flipped: this.flipped })
    this.paint = new PaintOrder({ activeLayer: this.currentActiveLayer, flipped: this.flipped })
  }

  /** Everything `applyView` sets, from the view the scene holds. */
  private applyViewState(): void {
    this.batch.reorder((slot) => this.paint.renderOrder(slot, 'stroke'))
    for (const labels of this.labelBatches)
      labels.reorder((slot) => this.paint.renderOrder(slot, 'label'))

    const u = this.viewUniforms
    const active = this.currentActiveLayer
    const focus = this.highlightNet
    u.uFocusNet.value = focus
    u.uActiveMask.value = active ? copperMask(this.expand(active)) : 0
    u.uVisibleMask.value = copperMask(this.copperLayers.filter((l) => this.isLayerShown(l)))
    u.uFacingMask.value = copperBit(this.paint.facingCopper)
    u.uDimMode.value = this.nonActiveDisplay === 'dim' ? 1 : 0
    u.uHideMode.value = this.nonActiveDisplay === 'hide' ? 1 : 0
    u.uFocusInDim.value = focus > 0 && this.nonActiveDisplay === 'dim' ? 1 : 0
    u.uDimStrength.value = this.dimStrength
    u.uNetDim.value = BoardScene.NET_DIM

    this.footprintBoxes.clear()
    for (const batches of [this.batch, ...this.labelBatches])
      for (const { slot, batch } of batches.slots()) this.viewSlot(slot, batch)
    repaintFillMeshes(this.fillGroup, this.paint)
    this.fillGroup.traverse((object) => {
      if (object instanceof THREE.Mesh) this.paintFill(object)
    })
    this.boardAreaLayer.visible = this.boardArea.children.length > 0 && this.isLayerShown(EDGE_CUTS)
  }

  /** The layer a slot holds — its own, for a slot of the selected band — or null for the preview slot. */
  private slotLayer(slot: number): string | null {
    if (slot >= PREVIEW_SLOT) return null
    return (
      this.layers.layerAt(slot >= LIFTED_SLOT_OFFSET ? slot - LIFTED_SLOT_OFFSET : slot) ?? null
    )
  }

  /**
   * One slot's batch in the view: whether its layer shows, hides for 'hide',
   * dims and is toned by net focus. A pseudo-layer's slot (vias and holes, net
   * names) names no copper:
   * what it holds stands for whole items, and the view reaches them through
   * their span (`META.SPAN`).
   */
  private viewSlot(slot: number, batch: { mesh: THREE.Mesh; view?: BatchView }): void {
    const view = batch.view?.slot
    const layer = this.slotLayer(slot)
    const pseudo = layer === VIA_PSEUDO_LAYER || layer === NETNAMES_PSEUDO_LAYER
    const nonActive = layer !== null && !pseudo && !this.layerMatchesActive(layer)
    const dims = this.nonActiveDisplay === 'dim' && nonActive && this.highlightNet === 0
    batch.mesh.visible = layer === null || pseudo || this.isLayerShown(layer)
    if (!view) return
    view.uTone.value = layer === null ? 0 : 1
    view.uSlotHide.value = this.nonActiveDisplay === 'hide' && nonActive ? 1 : 0
    view.uSlotNonActive.value = nonActive ? 1 : 0
    view.uSlotSurvive.value = dimOpacityFor(layer ?? undefined)
    view.uSlotDim.value = dims ? this.slotDimStrength(layer ?? undefined) : 1
  }

  /**
   * A fill mesh — a pour, a pad's or a shape's fill, a hatch — drawn as the
   * view and the selection have it: the one place its look is decided, from
   * its own color and opacity (`userData`, the diff's tone included), so no
   * two writers can leave it half one thing and half another.
   */
  private paintFill(mesh: THREE.Mesh): void {
    const fill = mesh.userData as Partial<FillLook> & { paintLane?: string }
    if (!fill.paintLane || !fill.defaultColor) return
    const slot = layerSlot(mesh.position.z)
    const layer = this.slotLayer(slot) ?? undefined
    const nonActive = !!layer && !this.layerMatchesActive(layer)
    const focus = this.highlightNet
    const onFocus = focus > 0 && fill.net === focus
    mesh.visible =
      this.isLayerShown(layer) && !(this.nonActiveDisplay === 'hide' && nonActive && !onFocus)
    const color = this.fillColor.copy(fill.defaultColor)
    if (fill.selected) this.shiftedColor(color, this.selectionShift(), color)
    if (focus > 0) {
      if (onFocus) this.shiftedColor(color, this.selectionShift(), color)
      else {
        const survive = this.nonActiveDisplay === 'dim' && nonActive ? dimOpacityFor(layer) : 1
        color.lerp(this.background, 1 - BoardScene.NET_DIM * survive)
      }
    } else if (this.nonActiveDisplay === 'dim' && nonActive) {
      dimToward(color, color, this.background, this.slotDimStrength(layer))
    }
    setFillLook(mesh, color, fill.opacity ?? 1)
  }

  private readonly fillColor = new THREE.Color()

  /** Where a layer paints in the live view, bottom 0: what a hit's tie goes to. */
  private paintRankOf(layer: string | undefined): number {
    return this.paint.rank(this.layers.slotOf(layer))
  }

  /**
   * The z an item's geometry is written at on `layer`: its slot's address at
   * `depth` (`LayerStack`). The view does not enter it — whether the slot is
   * dimmed, hidden or on top is `applyView`'s to say.
   */
  private getLayerZ(layer: string | undefined, depth: LayerDepth = 'body'): number {
    return this.layers.zOf(layer, depth)
  }

  private getLayerColor(layer: string | undefined): THREE.Color {
    const clean = resolveWildcardLayer(layer)
    return this.layerColors[clean] ?? this.layerColors[DEFAULT_PCB_LAYER]
  }

  /** Whether a layer (possibly wildcard) includes the active layer. */
  private layerMatchesActive(layer: string): boolean {
    const active = this.currentActiveLayer
    if (!active) return true
    return this.expand(layer).includes(active)
  }

  /** The concrete layers a token names, `*.Cu` against this board's copper. */
  private expand(layer: string): string[] {
    return expandLayerToken(layer, this.copperLayers)
  }

  /**
   * What 'dim' leaves of a non-active layer's color. The canvas floors the
   * board outline's fade (`dimOpacityFor`); so does this.
   */
  private slotDimStrength(layer: string | undefined): number {
    return layer === 'Edge.Cuts'
      ? Math.max(this.dimStrength, DIM_ALPHA_FLOOR_EDGE_CUTS)
      : this.dimStrength
  }

  /** A layer's own alpha: mask and paste are translucent; the view's fade is applied, not written. */
  private getLayerAlpha(layer: string | undefined): number {
    return baseLayerAlpha(layer)
  }

  /**
   * Whether a layer's items answer to the pointer. Visibility is necessary
   * but not sufficient: in 'dim' mode the non-active layers are still drawn
   * (faded) yet read as background — clicking through a dimmed track to the
   * active layer's copper is the point of dimming.
   */
  public isLayerSelectable(layer: string | undefined): boolean {
    if (!this.isLayerVisible(layer)) return false
    if (this.nonActiveDisplay !== 'dim' || !layer) return true
    return this.layerMatchesActive(layer)
  }

  /**
   * A via answers on every copper layer it passes through, not only the two
   * its file entry names: a through via is under the cursor on In1.Cu too
   * (KiCad's `PCB_VIA::IsOnLayer`).
   */
  private isViaSelectable(via: KicadVia): boolean {
    return this.viaSpan(via).some((layer) => this.isLayerSelectable(layer))
  }

  /**
   * A footprint is a part, not copper on one layer, so it answers wherever it
   * is drawn. It ranks below everything else under the cursor
   * (`BOARD_TYPE_RANK`), so a track, via or pad on the active layer still wins
   * the click; the footprint takes it only where nothing active lies. A hidden
   * side answers through any of its pads the active view shows, as KiCad lets
   * a through-hole part be picked from an inner layer. Under 'dim' a part is
   * background unless something of it is on the active layer — KiCad's
   * high-contrast rule (`PCB_SELECTION_TOOL::Selectable`, by
   * `FOOTPRINT::IsOnLayer`: its pads and drawings, not its fields).
   */
  private isFootprintSelectable(bfp: KicadBoardFootprint): boolean {
    if (this.nonActiveDisplay === 'dim')
      return this.footprintLayers(bfp).some((l) => this.isLayerSelectable(l))
    if (this.isLayerVisible(bfp.layer)) return true
    return bfp.footprint.pads.some((pad) => pad.layers.some((l) => this.isLayerSelectable(l)))
  }

  /** The layers a footprint's pads and drawings are on (`FOOTPRINT::IsOnLayer`). */
  private footprintLayers(bfp: KicadBoardFootprint): string[] {
    const fp = bfp.footprint
    const layers = new Set<string>()
    for (const pad of fp.pads) for (const layer of pad.layers) layers.add(layer)
    for (const items of [fp.fpLines, fp.fpArcs, fp.fpCircles, fp.fpRects, fp.fpPolys, fp.fpTexts])
      for (const item of items) if (item.layer) layers.add(item.layer)
    return [...layers]
  }

  /** Whether the person has a layer switched on; a wildcard while any layer it names is. */
  private isLayerShown(layer: string | undefined): boolean {
    if (!layer) return true
    const visibility = this.currentLayerVisibility
    if (!visibility) return true
    return this.expand(layer).some((l) => visibility[l] ?? true)
  }

  private isLayerVisible(layer: string | undefined): boolean {
    if (!layer) return true

    // 'hide' mode: only the active layer shows (the shader keeps the focused
    // net's copper drawn, `boardView.ts`; picking stays on the active layer).
    if (this.nonActiveDisplay === 'hide' && !this.layerMatchesActive(layer)) return false
    // A wildcard is visible while any layer it names is: the item still has
    // copper (or mask) somewhere the user is looking.
    return this.isLayerShown(layer)
  }

  public rebuild(
    board: KicadBoard,
    layerVisibility?: Record<string, boolean>,
    activeLayer?: string,
    options?: BoardDisplayOptions
  ): THREE.Box3 {
    const steps = this.rebuildSteps(board, layerVisibility, activeLayer, options)
    let step = steps.next()
    while (!step.done) step = steps.next()
    return step.value
  }

  /**
   * Apply one command's delta to the built scene instead of rebuilding it —
   * what makes a trace drag's committed copper appear the same frame on a
   * dense board (a whole-scene rebuild there is ~300 ms of frozen thread).
   *
   * Supported incrementally: segment/track-arc/via adds, removals, and
   * mutations (with key renames for the unchanged tail an array splice
   * shifts), plus IN-PLACE footprint and zone mutations (moves, refills, a
   * node replaced at its index — the set and order unchanged). Anything else — graphics, dimensions, nets,
   * zone/footprint adds or removals, or a raw this method can't attribute —
   * returns false, and the caller falls back to the full rebuild. Display
   * options and visibility are the rebuild path's business and never change
   * mid-apply.
   *
   * Fresh instances land in recycled slots or at the buffer tail; the slots
   * they left out of z order are sorted again, since board batches write no
   * depth and paint order is the stacking (a via's bore over its wall).
   */
  public applyBoardEdit(delta: BoardEditDelta, next: KicadBoard): boolean {
    if (!this.currentBoard || delta.fromBoard !== this.currentBoard) return false
    // An edit mid-drag (a turn, a flip) patches copper at its board position:
    // put the drag back to its start first, for `resumeDrag` to carry again.
    this.parkDrag()
    const raws = delta.raws
    const prev = delta.prev

    // Every changed node must be attributable to a supported collection.
    const claimed = new Set<SExprNode>()
    const claim = (items: ReadonlyArray<{ _raw: SExprNode }>): void => {
      for (const it of items) if (raws.has(it._raw)) claimed.add(it._raw)
    }
    claim(prev.segments)
    claim(next.segments)
    claim(prev.trackArcs)
    claim(next.trackArcs)
    claim(prev.vias)
    claim(next.vias)
    claim(prev.footprints)
    claim(next.footprints)
    claim(prev.zones)
    claim(next.zones)
    for (const r of raws) if (!claimed.has(r)) return false

    // Footprints and zones support only in-place mutation: their keys anchor
    // fill meshes and positional bounds, so set/order changes take the
    // rebuild. A node replaced where it stood (a footprint flip) is in place.
    const sameOrder = (
      a: ReadonlyArray<{ _raw: SExprNode }>,
      b: ReadonlyArray<{ _raw: SExprNode }>
    ): boolean =>
      a.length === b.length &&
      a.every((it, i) => it._raw === b[i]._raw || (raws.has(it._raw) && raws.has(b[i]._raw)))
    if (!sameOrder(prev.footprints, next.footprints)) return false
    if (!sameOrder(prev.zones, next.zones)) return false

    this.currentBoard = next

    // Flat copper collections: remove old keys, rename the shifted unchanged
    // tail, then render changed/added items under their new keys — strictly
    // in that order, so a fresh write can never collide with a pending
    // rename.
    const applyFlat = <T extends { _raw: SExprNode }>(
      type: string,
      prevItems: readonly T[],
      nextItems: readonly T[],
      render: (item: T, index: number) => void
    ): void => {
      prevItems.forEach((it, i) => {
        if (!raws.has(it._raw)) return
        const key = `${type}:${i}`
        this.batch.removeElement(key)
        for (const labels of this.trackLabelBatches) labels.removeElement(key)
      })
      const prevIndexByRaw = new Map(prevItems.map((it, i) => [it._raw, i] as const))
      const renames: Array<readonly [string, string]> = []
      nextItems.forEach((it, i) => {
        if (raws.has(it._raw)) return
        const oldIdx = prevIndexByRaw.get(it._raw)
        if (oldIdx !== undefined && oldIdx !== i)
          renames.push([`${type}:${oldIdx}`, `${type}:${i}`])
      })
      if (renames.length > 0) {
        this.batch.renameElements(renames)
        for (const labels of this.trackLabelBatches) labels.renameElements(renames)
      }
      nextItems.forEach((it, i) => {
        if (raws.has(it._raw)) render(it, i)
      })
    }
    applyFlat('segment', prev.segments, next.segments, (seg, i) => this.renderSegment(seg, i))
    applyFlat('tarc', prev.trackArcs, next.trackArcs, (arc, i) => this.renderTrackArc(arc, i))
    applyFlat('via', prev.vias, next.vias, (via, i) => this.renderVia(via, i))

    // In-place footprint/zone mutations: retire the old paint and anchor,
    // then re-render at the same index.
    const removeAnchor = (key: string): void => {
      const anchor = this.elements[key]
      if (!anchor) return
      anchor.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry.dispose()
          const materials = Array.isArray(obj.material) ? obj.material : [obj.material]
          materials.forEach((m) => m?.dispose())
        }
      })
      this.fillGroup.remove(anchor)
      delete this.elements[key]
    }
    next.footprints.forEach((bfp, i) => {
      if (!raws.has(bfp._raw)) return
      const key = `footprint:${i}`
      this.batch.removeElement(key)
      for (const labels of this.labelBatches) labels.removeElement(key)
      removeAnchor(key)
      this.renderFootprint(bfp, i)
    })
    next.zones.forEach((zone, i) => {
      if (!raws.has(zone._raw)) return
      const key = `zone:${i}`
      this.batch.removeElement(key)
      removeAnchor(key)
      this.renderZone(zone, i)
    })

    this.batch.sortWhereNeeded()
    this.setItemNet(undefined)
    return true
  }

  /**
   * Test-only: normalized batch content plus anchor keys — the equivalence
   * oracle for applyBoardEdit (a patched scene must equal a fresh rebuild).
   */
  /**
   * Test-only: the view as the batches read it — the shared uniforms, and per
   * document slot by its layer, the slot's uniforms and whether it draws.
   */
  public debugView(): {
    shared: Record<string, number>
    slots: Map<string, Record<string, number | boolean>>
  } {
    const shared: Record<string, number> = {}
    for (const [name, uniform] of Object.entries(this.viewUniforms))
      if (typeof uniform.value === 'number') shared[name] = uniform.value
    const slots = new Map<string, Record<string, number | boolean>>()
    for (const { slot, batch } of this.batch.slots()) {
      const layer = this.slotLayer(slot)
      if (layer === null || slot >= LIFTED_SLOT_OFFSET) continue
      const row: Record<string, number | boolean> = { visible: batch.mesh.visible }
      for (const [name, uniform] of Object.entries(batch.view?.slot ?? {}))
        row[name] = uniform.value
      slots.set(layer, row)
    }
    return { shared, slots }
  }

  public debugSnapshot(): {
    batch: Map<string, string[]>
    labels: Map<string, string[]>
    trackLabels: Map<string, string[]>
    anchors: string[]
  } {
    return {
      batch: this.batch.debugElements(),
      // Each ink's entries, marked by ink: a label that changed ink changed.
      labels: inkedElements(this.labelBatch, this.labelBatchDark),
      trackLabels: inkedElements(this.trackLabelBatch, this.trackLabelBatchDark),
      anchors: Object.keys(this.elements).sort()
    }
  }

  /** Test-only: each slot's z values in paint order, for comparing a patch's stacking with a rebuild's. */
  public debugDrawOrder(): Map<number, number[]> {
    return this.batch.debugDrawOrder()
  }

  /**
   * The stepwise rebuild: the same work `rebuild` does, yielded in small
   * chunks with a 0–1 fraction, so a driver can keep the thread painting
   * while a dense board's scene is assembled. Returns the scene bounds.
   */
  public *rebuildSteps(
    board: KicadBoard,
    layerVisibility?: Record<string, boolean>,
    activeLayer?: string,
    options?: BoardDisplayOptions
  ): Generator<number, THREE.Box3> {
    // A rebuild paints from scratch; the diff paints again over it.
    this.diffTone = null
    this.currentBoard = board
    this.copperLayers = boardCopperLayers(board)
    this.dimStrength = options?.dimStrength ?? DIM_ALPHA_FACTOR
    this.flipped = options?.flipped ?? false
    this.setView({
      activeLayer,
      layerVisibility,
      nonActiveDisplay: options?.nonActiveDisplay,
      focusNet: options?.highlightNet
    })
    // The mark mirrors with the view, so it is placed again for a flip.
    this.setDrillOrigin(this.drillOrigin)
    this.zoneFillsVisible = options?.zoneFills ?? true
    this.sketchTracks = options?.sketchTracks ?? false
    this.sketchVias = options?.sketchVias ?? false
    this.sketchPads = options?.sketchPads ?? false
    this.boardAreaVisible = options?.boardArea ?? true
    this.fpTextShown = {
      reference: options?.fpReferences ?? true,
      value: options?.fpValues ?? true,
      text: options?.fpText ?? true
    }
    this.netLabels = netDisplayNames(board.nets)
    this.setItemNet(undefined)
    this.clear()
    this.emitRatsnest()

    const work = {
      done: 0,
      total: Math.max(
        1,
        board.footprints.length * FOOTPRINT_WEIGHT +
          board.zones.length * ZONE_WEIGHT +
          board.segments.length +
          board.trackArcs.length +
          board.vias.length +
          board.grLines.length +
          board.grArcs.length +
          board.grCircles.length +
          board.grRects.length +
          board.grPolys.length +
          board.grTexts.length +
          board.grCurves.length +
          board.grTextBoxes.length +
          board.tables.length +
          board.points.length +
          board.dimensions.length
      )
    }
    const chunked = <T>(
      items: readonly T[],
      weight: number,
      chunk: number,
      render: (item: T, index: number) => void
    ): Generator<number, void> => this.renderChunked(items, weight, chunk, work, render)

    this.renderBoardArea(board)
    yield* chunked(board.footprints, FOOTPRINT_WEIGHT, FOOTPRINT_CHUNK, (bfp, i) =>
      this.renderFootprint(bfp, i)
    )
    yield* chunked(board.segments, 1, ITEM_CHUNK, (seg, i) => this.renderSegment(seg, i))
    yield* chunked(board.trackArcs, 1, ITEM_CHUNK, (arc, i) => this.renderTrackArc(arc, i))
    yield* chunked(board.vias, 1, ITEM_CHUNK, (via, i) => this.renderVia(via, i))
    yield* chunked(board.zones, ZONE_WEIGHT, ITEM_CHUNK, (zone, i) => this.renderZone(zone, i))

    this.setItemNet(undefined) // graphics carry no net
    yield* chunked(board.grLines, 1, ITEM_CHUNK, (line, i) => this.renderGrLine(line, i))
    yield* chunked(board.grArcs, 1, ITEM_CHUNK, (arc, i) => this.renderGrArc(arc, i))
    yield* chunked(board.grCircles, 1, ITEM_CHUNK, (circle, i) => this.renderGrCircle(circle, i))
    yield* chunked(board.grRects, 1, ITEM_CHUNK, (rect, i) => this.renderGrRect(rect, i))
    yield* chunked(board.grPolys, 1, ITEM_CHUNK, (poly, i) => this.renderGrPoly(poly, i))
    yield* chunked(board.grTexts, 1, ITEM_CHUNK, (text, i) => this.renderGrText(text, i))
    for (const [type, items] of BoardScene.extraCollections(board)) {
      yield* chunked(items, 1, ITEM_CHUNK, (item, i) =>
        this.renderExtraGraphic(`${type}:${i}`, item, BoardScene.boardSpace, 0)
      )
    }
    yield* chunked(board.dimensions, 1, ITEM_CHUNK, (dim, i) =>
      this.renderDimension(dim, `dimension:${i}`)
    )

    this.drawClearanceOutlines('board')
    this.drawClearanceOutlines('selected')

    // The sort is one indivisible pass over everything written above; report
    // the geometry as finished before it takes its slice.
    yield 1
    this.batch.finalizeSorted()
    this.applyViewState()

    const bbox = new THREE.Box3()
    bbox.setFromObject(this.fillGroup)
    this.batch.getBounds(bbox)
    for (const labels of this.labelBatches) labels.getBounds(bbox)
    // After the bounds: a held footprint is not the board's extent.
    this.drawFootprintGhost()
    return bbox
  }

  private *renderChunked<T>(
    items: readonly T[],
    weight: number,
    chunk: number,
    work: { done: number; total: number },
    render: (item: T, index: number) => void
  ): Generator<number, void> {
    for (let i = 0; i < items.length; i++) {
      render(items[i], i)
      work.done += weight
      if ((i + 1) % chunk === 0) yield work.done / work.total
    }
  }

  private clear(): void {
    this.cancelPendingFills()
    this.batch.reset()
    for (const labels of this.labelBatches) labels.reset()
    this.vertexHandles.clear()
    // Dispose GPU resources in one traversal, then drop all children at once.
    // Removing children one-by-one from the head is O(n²) in three (indexOf +
    // splice per removal) — with tens of thousands of anchors that alone cost
    // hundreds of ms per rebuild.
    this.fillGroup.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose()
        const materials = Array.isArray(obj.material) ? obj.material : [obj.material]
        materials.forEach((m) => m?.dispose())
      }
    })
    this.fillGroup.clear()
    this.clearBoardArea()
    this.elements = {}
    this.footprintExtents = []
    this.footprintBoxes.clear()
    this.footprintTextHits = []
  }

  private clearBoardArea(): void {
    this.boardArea.traverse((obj) => {
      if (obj instanceof THREE.Mesh) obj.geometry.dispose()
    })
    this.boardArea.clear()
    this.boardAreaLayer.visible = false
  }

  /** For `ViewportEngine.setCompositeLayers`; the scene keeps it current. */
  public compositeLayers(): CompositeLayerSpec[] {
    return [this.boardAreaLayer]
  }

  /**
   * Tint what is board. Only a closed outline has an area: an open one draws
   * nothing, so the tint arriving is also the sign that the outline closed.
   */
  private renderBoardArea(board: KicadBoard): void {
    if (!this.boardAreaVisible) return
    const outline = buildBoardOutline(board)
    if (outline.fallback) return
    for (const region of outline.regions) {
      const ring = (pts: ReadonlyArray<{ x: number; y: number }>): THREE.Vector2[] =>
        pts.map((p) => new THREE.Vector2(this.sx(p.x), p.y))
      const contour = ring(region.outer)
      const holes = region.holes.map(ring)
      // triangulateShape drops a closing duplicate from the rings it is given,
      // so the vertex list is read back from them afterwards.
      const faces = THREE.ShapeUtils.triangulateShape(contour, holes)
      const vertices = [contour, ...holes].flat()
      const positions = new Float32Array(vertices.length * 3)
      vertices.forEach((v, i) => {
        positions[i * 3] = v.x
        positions[i * 3 + 1] = v.y
      })
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
      geometry.setIndex(faces.flat())
      this.boardArea.add(new THREE.Mesh(geometry, this.boardAreaMaterial))
    }
    this.boardAreaLayer.visible =
      this.boardArea.children.length > 0 && this.isLayerVisible(EDGE_CUTS)
  }

  /** Free all GPU resources (viewport unmount). */
  public dispose(): void {
    this.clear()
    this.batch.dispose()
    for (const pool of [this.routePool, this.shovePool, this.markPool]) pool.dispose()
    for (const labels of this.labelBatches) labels.dispose()
    this.vertexHandles.dispose()
    this.ratsnestLines.geometry.dispose()
    this.ratsnestMaterial.dispose()
    this.leadLine.geometry.dispose()
    ;(this.leadLine.material as THREE.LineBasicMaterial).dispose()
    this.scene.remove(this.leadLine)
    this.boardAreaMaterial.dispose()
    this.scene.remove(this.ratsnestLines)
    this.scene.remove(this.drillOriginMarker.object)
    this.drillOriginMarker.dispose()
    this.currentBoard = undefined
  }

  /**
   * Anchors exist only for elements that parent fill meshes (footprints,
   * zones, gr_poly): the Group carries the fill children and their drag
   * offset. Batch-only elements (segments, vias, arcs, plain graphics, text)
   * deliberately get none — highlight/drag/hit paths all guard on absence,
   * and tens of thousands of empty Groups would cost allocation per rebuild
   * plus matrix updates on every rendered frame.
   */
  private makeAnchor(key: string, type: string, index: number): THREE.Group {
    const anchor = new THREE.Group()
    anchor.userData = { type, index }
    this.fillGroup.add(anchor)
    this.elements[key] = anchor
    return anchor
  }

  // ---------------------------------------------------------------------------
  // Flip-aware primitive writes. All rendering code works in data-scene space
  // (KiCad x, y negated); these wrappers mirror X at the last moment when the
  // flipped (view-from-back) mode is on, so hit-testing and drag logic stay in
  // data space and only the presentation mirrors.
  // ---------------------------------------------------------------------------

  /** Data-scene X → world X (mirrored when the board view is flipped). */
  private sx(x: number): number {
    return this.flipped ? -x : x
  }

  private addCapsuleW(
    key: string,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    halfWidth: number,
    color: THREE.Color,
    alpha: number,
    z: number
  ): void {
    const b = this.batch
    b.addCapsule(key, this.sx(x0), y0, this.sx(x1), y1, halfWidth, color, alpha, z)
  }

  private addRoundRectW(
    key: string,
    cx: number,
    cy: number,
    halfW: number,
    halfH: number,
    cornerR: number,
    rotation: number,
    color: THREE.Color,
    alpha: number,
    z: number
  ): void {
    const b = this.batch
    b.addRoundRect(
      key,
      this.sx(cx),
      cy,
      halfW,
      halfH,
      cornerR,
      this.flipped ? -rotation : rotation,
      color,
      alpha,
      z
    )
  }

  private addRingW(
    key: string,
    cx: number,
    cy: number,
    radius: number,
    halfStroke: number,
    color: THREE.Color,
    alpha: number,
    z: number
  ): void {
    const b = this.batch
    b.addRing(key, this.sx(cx), cy, radius, halfStroke, color, alpha, z)
  }

  private addLabelBlockW(
    key: string,
    lines: readonly string[],
    cx: number,
    cy: number,
    z: number,
    boxW: number,
    boxH: number,
    rotation: number,
    alpha = 1,
    darkInk = false
  ): void {
    const lb = darkInk ? this.labelBatchDark : this.labelBatch
    lb.addLabelBlock(
      key,
      lines,
      this.sx(cx),
      cy,
      z,
      boxW,
      boxH,
      this.flipped ? -rotation : rotation,
      alpha
    )
  }

  private setAnchorPos(anchor: THREE.Object3D, x: number, y: number, z: number): void {
    anchor.position.set(this.sx(x), y, z)
  }

  private makeTransform(bfp: KicadBoardFootprint): FootprintTransform {
    const angleRad = THREE.MathUtils.degToRad(bfp.position.angle ?? 0)
    return {
      tx: nmToMm(bfp.position.x),
      ty: -nmToMm(bfp.position.y),
      cos: Math.cos(angleRad),
      sin: Math.sin(angleRad)
    }
  }

  /**
   * Map a footprint-relative KiCad point (integer nm, x right, y down) to
   * scene space (mm, y-up) — the domain→engine boundary, same math as
   * `placement.tfPoint`. Board files store child coordinates
   * relative-unrotated, so the footprint rotation is applied here.
   */
  private tfPoint(tf: FootprintTransform, x: number, y: number): { x: number; y: number } {
    const sx = x / NM_PER_MM
    const sy = -y / NM_PER_MM
    return {
      x: tf.tx + sx * tf.cos - sy * tf.sin,
      y: tf.ty + sx * tf.sin + sy * tf.cos
    }
  }

  private renderFootprint(bfp: KicadBoardFootprint, index: number): void {
    this.setItemNet(undefined)
    const key = `footprint:${index}`
    const tf = this.makeTransform(bfp)
    const fp = bfp.footprint

    const extent: FootprintExtent = {
      place: { x: tf.tx, y: tf.ty },
      part: emptyBounds(),
      byLayer: new Map(),
      reachByLayer: new Map()
    }
    /** Widen the part — by `layer` alone when that is what it is drawn on. */
    const expand = (x: number, y: number, pad = 0, layer?: string): void =>
      growBounds(layer === undefined ? extent.part : boundsIn(extent.byLayer, layer), x, y, pad)

    const anchor = this.makeAnchor(key, 'footprint', index)
    this.setAnchorPos(anchor, tf.tx, tf.ty, 0)

    // Pads. Paint is filed under `footprint:N/pad:M` (KeyHierarchy) so one pad
    // can be recolored or referenced on its own — net highlight and cross-probe
    // address pads, and `footprint:N` still reaches all of it through expand().
    fp.pads.forEach((pad, padIndex) => {
      const center = this.tfPoint(tf, pad.position.x, pad.position.y)
      expand(center.x, center.y, Math.max(nmToMm(pad.size.w), nmToMm(pad.size.h)) / 2)

      if (pad.layers.length === 0) return
      const board = this.currentBoard
      this.renderPad(
        `${key}/pad:${padIndex}`,
        pad,
        center,
        pad.layers,
        anchor,
        { x: tf.tx, y: tf.ty },
        // The mask opening as KiCad computes it: the pad's own margin, else the
        // footprint's, else the board's (`maskExpansion.ts`, which DRC reads).
        (layer) => (board && index >= 0 ? nmToMm(padMaskMargin(board, index, padIndex, layer)) : 0)
      )
    })
    this.setItemNet(undefined)

    // Graphic lines / arcs / circles / rects / polys
    fp.fpLines.forEach((line) => {
      const a = this.tfPoint(tf, line.start.x, line.start.y)
      const b = this.tfPoint(tf, line.end.x, line.end.y)
      const layer = line.layer ?? 'F.SilkS'
      expand(a.x, a.y, 0, layer)
      expand(b.x, b.y, 0, layer)
      this.addCapsuleW(
        key,
        a.x,
        a.y,
        b.x,
        b.y,
        (line.strokeWidth !== undefined ? nmToMm(line.strokeWidth) : 0.12) / 2,
        this.getLayerColor(layer),
        this.getLayerAlpha(layer),
        this.getLayerZ(layer)
      )
    })

    fp.fpArcs.forEach((arc) => {
      const a = this.tfPoint(tf, arc.start.x, arc.start.y)
      const m = this.tfPoint(tf, arc.mid.x, arc.mid.y)
      const b = this.tfPoint(tf, arc.end.x, arc.end.y)
      const layer = arc.layer ?? 'F.SilkS'
      expand(a.x, a.y, 0, layer)
      expand(m.x, m.y, 0, layer)
      expand(b.x, b.y, 0, layer)
      this.addThreePointArc(
        key,
        a,
        m,
        b,
        (arc.strokeWidth !== undefined ? nmToMm(arc.strokeWidth) : 0.12) / 2,
        layer
      )
    })

    fp.fpCircles.forEach((circle) => {
      const c = this.tfPoint(tf, circle.center.x, circle.center.y)
      const e = this.tfPoint(tf, circle.end.x, circle.end.y)
      const r = Math.hypot(e.x - c.x, e.y - c.y)
      const layer = circle.layer ?? 'F.SilkS'
      expand(c.x, c.y, r, layer)
      if (circle.fill === 'solid' || circle.fill === 'yes') {
        this.addRoundRectW(
          key,
          c.x,
          c.y,
          r,
          r,
          r,
          0,
          this.getLayerColor(layer),
          this.getLayerAlpha(layer),
          this.getLayerZ(layer, 'fill')
        )
      }
      this.addRingW(
        key,
        c.x,
        c.y,
        r,
        (circle.strokeWidth !== undefined ? nmToMm(circle.strokeWidth) : 0.12) / 2,
        this.getLayerColor(layer),
        this.getLayerAlpha(layer),
        this.getLayerZ(layer)
      )
    })

    fp.fpRects.forEach((rect) => {
      // Transform all four corners so rotated rectangles stay rectangles
      const p0 = this.tfPoint(tf, rect.start.x, rect.start.y)
      const p1 = this.tfPoint(tf, rect.end.x, rect.start.y)
      const p2 = this.tfPoint(tf, rect.end.x, rect.end.y)
      const p3 = this.tfPoint(tf, rect.start.x, rect.end.y)
      const corners = [p0, p1, p2, p3]
      const layer = rect.layer ?? 'F.SilkS'
      corners.forEach((p) => expand(p.x, p.y, 0, layer))
      const halfW = (rect.strokeWidth !== undefined ? nmToMm(rect.strokeWidth) : 0.12) / 2
      if (rect.fill === 'solid' || rect.fill === 'yes') {
        this.addFilledPolygon(
          anchor,
          corners,
          this.getLayerColor(layer),
          this.getLayerAlpha(layer),
          this.getLayerZ(layer, 'fill'),
          { x: tf.tx, y: tf.ty }
        )
      }
      for (let i = 0; i < 4; i++) {
        const a = corners[i]
        const b = corners[(i + 1) % 4]
        this.addCapsuleW(
          key,
          a.x,
          a.y,
          b.x,
          b.y,
          halfW,
          this.getLayerColor(layer),
          this.getLayerAlpha(layer),
          this.getLayerZ(layer)
        )
      }
    })

    fp.fpPolys.forEach((poly) => {
      if (poly.points.length < 2) return
      const pts = poly.points.map((p) => this.tfPoint(tf, p.x, p.y))
      const layer = poly.layer ?? 'F.SilkS'
      pts.forEach((p) => expand(p.x, p.y, 0, layer))
      const z = this.getLayerZ(layer)
      const halfW = (poly.strokeWidth !== undefined ? nmToMm(poly.strokeWidth) : 0.1) / 2
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i]
        const b = pts[(i + 1) % pts.length]
        this.addCapsuleW(
          key,
          a.x,
          a.y,
          b.x,
          b.y,
          halfW,
          this.getLayerColor(layer),
          this.getLayerAlpha(layer),
          z
        )
      }
      if ((poly.fill === 'solid' || poly.fill === 'yes') && pts.length >= 3) {
        this.addFilledPolygon(
          anchor,
          pts,
          this.getLayerColor(layer),
          this.getLayerAlpha(layer),
          this.getLayerZ(layer, 'fill'),
          { x: tf.tx, y: tf.ty }
        )
      }
    })

    // Texts: properties (Reference/Value) and fp_texts. Stored angles are
    // absolute, so only the position goes through the placement transform; the
    // angle goes through KiCad's keep-upright fold instead.
    // `${REFERENCE}` on the fab layer and the like, resolved from the footprint as KiCad draws them.
    const textScope = footprintTextScope(fp)
    // Each under its own key, so one can be selected and moved apart from the
    // part, and each recorded as a click target (`footprintTextHits`).
    const textHits: FootprintTextHit[] = []
    const drawText = (
      type: 'fp_field' | 'fp_text',
      child: number,
      item: KicadProperty | KicadFpText,
      shownBy: 'reference' | 'value' | 'text',
      raw: string
    ): void => {
      const at = item.position
      if (!at || item.hide) return
      if (!this.fpTextShown[shownBy]) return
      const pos = this.tfPoint(tf, at.x, at.y)
      const textLayer = item.layer ?? 'F.SilkS'
      expand(pos.x, pos.y, 0, textLayer)
      const text = expandFootprintText(raw, textScope)
      const drawAngle = footprintTextDrawAngle(at.angle, item.keepUpright)
      this.renderStrokeText(
        `${key}/${type === 'fp_field' ? 'field' : 'text'}:${child}`,
        text,
        pos,
        drawAngle,
        item.layer ?? 'F.SilkS',
        item.fontEffects
      )
      const box = footprintTextLocalBox(text, item.fontEffects)
      if (!box) return
      const angle = THREE.MathUtils.degToRad(drawAngle)
      textHits.push({
        type,
        child,
        x: pos.x,
        y: pos.y,
        angle,
        box,
        layer: item.layer,
        locked: item.locked
      })
      // The glyph box's corners, turned onto the board, widen the reach.
      for (const [lx, ly] of [
        [box.xMin, box.yMin],
        [box.xMax, box.yMin],
        [box.xMin, box.yMax],
        [box.xMax, box.yMax]
      ]) {
        const wx = pos.x + lx * Math.cos(angle) - ly * Math.sin(angle)
        const wy = pos.y + lx * Math.sin(angle) + ly * Math.cos(angle)
        growBounds(boundsIn(extent.reachByLayer, textLayer), wx, wy, 0)
      }
    }
    fp.properties.forEach((prop, child) =>
      drawText('fp_field', child, prop, footprintTextClass(prop), prop.value)
    )
    fp.fpTexts.forEach((text, child) =>
      drawText('fp_text', child, text, footprintTextClass(text), text.text)
    )

    // Béziers, text boxes, tables and points are footprint-local, their text
    // angles relative to the part, so both go through the placement.
    const place = (p: { x: number; y: number }): { x: number; y: number } =>
      this.tfPoint(tf, p.x, p.y)
    const extras: KicadExtraGraphic[] = [
      ...fp.fpCurves,
      ...fp.points,
      ...fp.fpTextBoxes,
      ...fp.tables
    ]
    for (const item of extras) {
      this.renderExtraGraphic(key, item, place, bfp.position.angle ?? 0, expand)
    }

    // Dimensions carry absolute board coordinates even inside footprints, so
    // no placement transform (and no bounds expansion — they're annotations
    // that usually sit outside the part)
    fp.dimensions.forEach((dim) => this.renderDimension(dim, key))

    // Zones are board-absolute in the file, so no placement transform. They
    // paint under the footprint's key, selecting with it, and widen its box
    // as KiCad's `FOOTPRINT::GetBoundingBox` does.
    for (const zone of footprintZonesOf(fp, this.currentBoard?.nets)) {
      for (const p of zone.points) expand(nmToMm(p.x), -nmToMm(p.y))
      this.setItemNet(zone.net)
      this.paintZone(zone, key, anchor, { x: tf.tx, y: tf.ty })
    }
    this.setItemNet(undefined)

    this.footprintExtents[index] = extent
    this.footprintBoxes.delete(index)
    this.footprintTextHits[index] = textHits
  }

  /**
   * A footprint's box in this view: its pads, zones and place, and its
   * drawings and texts on the layers that show — a hidden fab outline or
   * courtyard does not make a part bigger than what is on screen. A part with
   * nothing shown is a small square at its place, still there to be clicked.
   */
  private footprintBoundsAt(index: number): Bounds2D | undefined {
    return this.footprintBoxAt(index)?.bounds
  }

  /**
   * How far a footprint's children reach in this view: its box widened by
   * its shown texts' glyph boxes. A text moved clear of the part is still
   * tested for; the footprint's own click area stays its box.
   */
  private footprintReachAt(index: number): Bounds2D | undefined {
    return this.footprintBoxAt(index)?.reach
  }

  private footprintBoxAt(index: number): { bounds: Bounds2D; reach: Bounds2D } | undefined {
    const known = this.footprintBoxes.get(index)
    if (known) return known
    const extent = this.footprintExtents[index]
    if (!extent) return undefined
    const bounds = { ...extent.part }
    for (const [layer, box] of extent.byLayer)
      if (this.isLayerVisible(layer)) unionBounds(bounds, box)
    if (bounds.minX === Infinity) growBounds(bounds, extent.place.x, extent.place.y, 0.5)
    const reach = { ...bounds }
    for (const [layer, box] of extent.reachByLayer)
      if (this.isLayerVisible(layer)) unionBounds(reach, box)
    const box = { bounds, reach }
    this.footprintBoxes.set(index, box)
    return box
  }

  private renderPad(
    key: string,
    pad: KicadPad,
    center: { x: number; y: number },
    layers: readonly string[],
    anchor: THREE.Object3D,
    anchorOrigin: { x: number; y: number },
    maskMargin: (layer: string) => number = () => 0
  ): void {
    // A same-net pad stays bright even when its footprint body dims.
    this.setItemNet(pad.net?.number)
    const w = nmToMm(pad.size.w)
    const h = nmToMm(pad.size.h)

    let halfW = w / 2
    let halfH = h / 2
    let cornerR = 0
    // A custom pad's `size` describes its ANCHOR, whose shape comes from
    // `(options (anchor …))` and is a circle when the pad names none.
    if (pad.shape === 'circle' || (pad.shape === 'custom' && pad.anchor !== 'rect')) {
      halfW = w / 2
      halfH = w / 2
      cornerR = w / 2
    } else if (pad.shape === 'oval') {
      cornerR = Math.min(w, h) / 2
    } else if (pad.shape === 'roundrect' || pad.roundrectRatio) {
      cornerR = Math.min(w, h) * (pad.roundrectRatio ?? 0.25)
    }

    // Pad angles in board files are absolute (they already include the
    // footprint rotation); KiCad positive angles map to CCW in scene space.
    const rotation = pad.position.angle ? THREE.MathUtils.degToRad(pad.position.angle) : 0

    const resolved: string[] = []
    for (const l of layers) {
      for (const concrete of this.expand(l))
        if (!resolved.includes(concrete)) resolved.push(concrete)
    }

    // The drill and the pad number belong to the pad as a whole, not to any
    // one of its layers (ARCHITECTURE.md, Board drawing): the hole sits in the
    // via-and-hole slot above all copper, and the label in its copper's label
    // lane, or the net-name slot when the pad is on several copper layers.
    const copper = resolved.filter(isCopperLayer)
    const net = pad.net?.number ?? 0
    // What stands for the pad as a whole — its hole, a multi-layer label — is
    // shown, faded and lit by its copper (`META.SPAN`); a hole with no copper
    // round it (an unplated one) bores through whatever is shown.
    const span = copperMask(copper)
    const whole = span !== 0 ? META.SPAN : 0

    // A custom pad is drawn as ONE merged outline when the boolean engine can
    // give us one: its anchor and its primitives abut exactly as often as not
    // (a SOT-89's tab shares an edge with its anchor), and two shapes composited
    // over the background each owe half the coverage of that shared edge, so a
    // hairline of background survives between them. Merged, there is no shared
    // edge left to survive in. Sketch mode keeps the pieces — an outline pass
    // has nothing to merge — and so does a board whose engine never loaded.
    const merged =
      !this.sketchPads && padHasPrimitives(pad)
        ? padOutline(padCopperPieces(pad, center, rotation))
        : null

    for (const layer of resolved) {
      // A thru-hole pad is copper on every layer it lists, so it takes those
      // layers' colors like any other pad; the wall around its bore is what
      // says it is drilled.
      const color = this.getLayerColor(layer)
      if (merged) {
        for (const region of merged) {
          this.addFilledPolygon(
            anchor,
            fractureRegion(region),
            color,
            this.getLayerAlpha(layer),
            this.getLayerZ(layer),
            anchorOrigin
          )
        }
      } else {
        // On a mask layer the paint is the OPENING, the pad grown by its mask
        // margin — drawn at the copper's size it hid exactly under the pad.
        // A rectangle grows square-cornered, as KiCad inflates it.
        const grow = layer === 'F.Mask' || layer === 'B.Mask' ? maskMargin(layer) : 0
        this.addRoundRectW(
          key,
          center.x,
          center.y,
          Math.max(0, halfW + grow),
          Math.max(0, halfH + grow),
          cornerR > 0 ? Math.max(0, cornerR + grow) : 0,
          rotation,
          color,
          BoardScene.sketchSign(this.sketchPads, this.getLayerAlpha(layer)),
          this.getLayerZ(layer)
        )
      }
    }

    if (!merged && pad.primitives) {
      this.renderPadPrimitives(key, pad, center, rotation, resolved, anchor, anchorOrigin)
    }

    const hole = padHoleShape(pad, rotation)
    if (hole) {
      // A hole with no copper round it bores the whole board: it shows on
      // whatever copper is shown, and not at all with every copper layer off.
      if (span === 0) this.setItemMeta(net, META.SPAN, copperMask(this.copperLayers))
      else this.setItemMeta(net, whole, span)
      const wall = holeWallWidth(hole, holeAnnulus(hole, halfW, halfH))
      const wallColor = pad.type === 'np_thru_hole' ? this.holes.unplated : this.holes.plated
      this.addRoundRectW(
        key,
        center.x + hole.dx,
        center.y + hole.dy,
        hole.halfW + wall,
        hole.halfH + wall,
        hole.cornerR + wall,
        rotation,
        wallColor,
        1,
        this.getLayerZ(VIA_PSEUDO_LAYER, 'detail')
      )
      this.addRoundRectW(
        key,
        center.x + hole.dx,
        center.y + hole.dy,
        hole.halfW,
        hole.halfH,
        hole.cornerR,
        rotation,
        this.holes.bore,
        1,
        this.getLayerZ(VIA_PSEUDO_LAYER, 'marker')
      )
    }

    // Pad ink, KiCad's two lines: the number, then the net line — the
    // display netname (short/disambiguated), or the no-connect 'x' /
    // free-pad '*' glyphs pcb_painter draws in its place. A pad on one copper
    // layer is labelled in that layer's label lane, which fades with it and
    // rises to the net-name rank while it faces the viewer, in the ink that
    // reads on its copper. One on several is labelled in the net-name slot,
    // shown and faded as its hole is, in both inks: the shader shows the one
    // that reads on the facing copper (`META.INK_BY_FACING`).
    const lines = [pad.number, this.padNetLabel(pad)]
    const darkOn = (layer: string): boolean =>
      hole
        ? this.darkInkOn(this.getLayerColor(layer), this.holes.bore)
        : this.darkInkOn(this.getLayerColor(layer))
    const label = (z: number, dark: boolean): void =>
      this.addLabelBlockW(key, lines, center.x, center.y, z, w, h, rotation, 1, dark)
    if (copper.length === 1) {
      this.setItemNet(net)
      label(this.getLayerZ(copper[0], 'label'), darkOn(copper[0]))
    } else {
      const darkInk = copperMask(copper.filter(darkOn))
      this.setItemMeta(net, whole | META.INK_BY_FACING, span, darkInk)
      const z = this.getLayerZ(NETNAMES_PSEUDO_LAYER, 'label')
      label(z, false)
      label(z, true)
    }
    this.setItemNet(net)
  }

  /** KiCad's pad net line (pcb_painter): 'x' no-connect, '*' free, else the
   *  display netname; empty (no line) for netless pads. */
  private padNetLabel(pad: KicadPad): string {
    if (pad.pinType?.includes('no_connect')) return 'x'
    const netName = pad.net?.name ?? ''
    if (pad.pinType === 'free' && netName.startsWith('unconnected-(')) return '*'
    if (!pad.net || pad.net.number <= 0) return ''
    return this.netLabels.get(pad.net.number) ?? netName
  }

  /**
   * Custom pad shapes: (pad ... custom (primitives ...)). Primitive
   * coordinates are relative to the pad anchor and rotate with the pad.
   */
  private renderPadPrimitives(
    key: string,
    pad: KicadPad,
    center: { x: number; y: number },
    rotation: number,
    layers: string[],
    anchor: THREE.Object3D,
    anchorOrigin: { x: number; y: number }
  ): void {
    const prims = pad.primitives
    if (!prims) return
    const cosR = Math.cos(rotation)
    const sinR = Math.sin(rotation)
    // Pad-relative KiCad point (y down) → scene space
    // Pad-relative domain nm → scene mm.
    const tp = (x: number, y: number): { x: number; y: number } => ({
      x: center.x + (x / NM_PER_MM) * cosR - -(y / NM_PER_MM) * sinR,
      y: center.y + (x / NM_PER_MM) * sinR + -(y / NM_PER_MM) * cosR
    })

    for (const layer of layers) {
      const color = this.getLayerColor(layer)
      const alpha = this.getLayerAlpha(layer)
      const z = this.getLayerZ(layer, 'detail')

      for (const poly of prims.polys) {
        if (poly.points.length < 2) continue
        const pts = poly.points.map((p) => tp(p.x, p.y))
        const halfW = (poly.strokeWidth !== undefined ? nmToMm(poly.strokeWidth) : 0) / 2
        if (halfW > 0) {
          for (let i = 0; i < pts.length; i++) {
            const a = pts[i]
            const b = pts[(i + 1) % pts.length]
            this.addCapsuleW(key, a.x, a.y, b.x, b.y, halfW, color, alpha, z)
          }
        }
        if (poly.fill !== 'none' && pts.length >= 3) {
          this.addFilledPolygon(anchor, pts, color, alpha, z, anchorOrigin)
        }
      }

      for (const line of prims.lines) {
        const a = tp(line.start.x, line.start.y)
        const b = tp(line.end.x, line.end.y)
        this.addCapsuleW(
          key,
          a.x,
          a.y,
          b.x,
          b.y,
          (line.strokeWidth !== undefined ? nmToMm(line.strokeWidth) : 0.1) / 2,
          color,
          alpha,
          z
        )
      }

      for (const circle of prims.circles) {
        const c = tp(circle.center.x, circle.center.y)
        const e = tp(circle.end.x, circle.end.y)
        const r = Math.hypot(e.x - c.x, e.y - c.y)
        if (circle.fill === 'solid' || circle.fill === 'yes') {
          this.addRoundRectW(key, c.x, c.y, r, r, r, 0, color, alpha, z)
        } else {
          this.addRingW(
            key,
            c.x,
            c.y,
            r,
            (circle.strokeWidth !== undefined ? nmToMm(circle.strokeWidth) : 0.1) / 2,
            color,
            alpha,
            z
          )
        }
      }

      for (const rect of prims.rects) {
        const corners = [
          tp(rect.start.x, rect.start.y),
          tp(rect.end.x, rect.start.y),
          tp(rect.end.x, rect.end.y),
          tp(rect.start.x, rect.end.y)
        ]
        if (rect.fill === 'solid' || rect.fill === 'yes') {
          this.addFilledPolygon(anchor, corners, color, alpha, z, anchorOrigin)
        }
        const halfW = (rect.strokeWidth !== undefined ? nmToMm(rect.strokeWidth) : 0) / 2
        if (halfW > 0) {
          for (let i = 0; i < 4; i++) {
            const a = corners[i]
            const b = corners[(i + 1) % 4]
            this.addCapsuleW(key, a.x, a.y, b.x, b.y, halfW, color, alpha, z)
          }
        }
      }

      for (const arc of prims.arcs) {
        const a = tp(arc.start.x, arc.start.y)
        const m = tp(arc.mid.x, arc.mid.y)
        const b = tp(arc.end.x, arc.end.y)
        this.addThreePointArc(
          key,
          a,
          m,
          b,
          (arc.strokeWidth !== undefined ? nmToMm(arc.strokeWidth) : 0.1) / 2,
          layer
        )
      }
    }
  }

  private renderStrokeText(
    key: string,
    text: string,
    scenePos: { x: number; y: number },
    angle: number | undefined,
    layer: string,
    fontEffects?: KicadFontEffects
  ): void {
    if (!text) return

    const options = strokeOptionsFromEffects(fontEffects)
    const thickness = options.thickness
    const { strokes } = getTextStrokes(text, options)

    const z = this.getLayerZ(layer, 'detail')
    const color = this.getLayerColor(layer)
    const alpha = this.getLayerAlpha(layer)
    const angleRad = angle ? THREE.MathUtils.degToRad(angle) : 0
    const cos = Math.cos(angleRad)
    const sin = Math.sin(angleRad)

    for (const stroke of strokes) {
      const wx1 = scenePos.x + stroke.x1 * cos - stroke.y1 * sin
      const wy1 = scenePos.y + stroke.x1 * sin + stroke.y1 * cos
      const wx2 = scenePos.x + stroke.x2 * cos - stroke.y2 * sin
      const wy2 = scenePos.y + stroke.x2 * sin + stroke.y2 * cos
      this.addCapsuleW(key, wx1, wy1, wx2, wy2, thickness / 2, color, alpha, z)
    }
  }

  private renderSegment(seg: KicadTrackSegment, index: number): void {
    this.setItemNet(seg.net)
    const key = `segment:${index}`
    const z = this.getLayerZ(seg.layer)
    this.addCapsuleW(
      key,
      nmToMm(seg.start.x),
      -nmToMm(seg.start.y),
      nmToMm(seg.end.x),
      -nmToMm(seg.end.y),
      nmToMm(seg.width) / 2,
      this.getLayerColor(seg.layer),
      BoardScene.sketchSign(this.sketchTracks, 1),
      z
    )

    // KiCad labels tracks with their net name, oriented along the copper;
    // the batch handles the length gate, repetition, and zoom fade.
    const name = this.netLabels.get(seg.net)
    if (name) {
      const labels = this.darkInkOn(this.getLayerColor(seg.layer))
        ? this.trackLabelBatchDark
        : this.trackLabelBatch
      labels.addLabelAlong(
        key,
        name,
        this.sx(nmToMm(seg.start.x)),
        -nmToMm(seg.start.y),
        this.sx(nmToMm(seg.end.x)),
        -nmToMm(seg.end.y),
        nmToMm(seg.width),
        this.getLayerZ(seg.layer, 'label'),
        1
      )
    }
  }

  private renderTrackArc(arc: KicadTrackArc, index: number): void {
    this.setItemNet(arc.net)
    const key = `tarc:${index}`
    const a = { x: nmToMm(arc.start.x), y: -nmToMm(arc.start.y) }
    const m = { x: nmToMm(arc.mid.x), y: -nmToMm(arc.mid.y) }
    const b = { x: nmToMm(arc.end.x), y: -nmToMm(arc.end.y) }
    this.addThreePointArc(
      key,
      a,
      m,
      b,
      nmToMm(arc.width) / 2,
      arc.layer,
      this.sketchTracks
        ? { alpha: BoardScene.sketchSign(true, this.getLayerAlpha(arc.layer)) }
        : undefined
    )
  }

  private renderVia(via: KicadVia, index: number): void {
    this.setItemNet(via.net)
    // A via shows while any copper layer it passes through shows — an inner
    // one included, which its two end layers do not name: its annulus by its
    // layers' slots, its hole and label by its span (`META.SPAN`).
    const span = this.viaSpan(via)
    if (span.length === 0) return

    const key = `via:${index}`
    const cx = nmToMm(via.position.x)
    const cy = -nmToMm(via.position.y)
    const r = nmToMm(via.size) / 2

    // The hole and the label stand for the via as a whole, in the via-and-hole
    // and net-name slots, which name no copper: they show, fade and light by
    // the via's span (`META.SPAN`) — bright while any layer it spans is active,
    // as KiCad's pcb_painter has it.
    const spanMask = copperMask(span)
    const alpha = BoardScene.sketchSign(this.sketchVias, 1)

    // The annulus IS copper on each layer the via passes through, so it is
    // drawn there, in that layer's slot and color: it joins the pad, track or
    // pour it lands on rather than painting over them (and over a pad's
    // labels), and fades with its layer like any other copper on it. Only the
    // hole, which bores through everything, keeps the via slot above copper.
    for (const layer of span) {
      this.addRoundRectW(
        key,
        cx,
        cy,
        r,
        r,
        r,
        0,
        this.getLayerColor(layer),
        BoardScene.sketchSign(this.sketchVias, this.getLayerAlpha(layer)),
        this.getLayerZ(layer)
      )
    }

    // Where the via is not tented, the mask opens over it: the same paint pads
    // put on F.Mask/B.Mask, so a mask layer shows every opening it really has.
    const maskR = r + nmToMm(this.currentBoard?.padToMaskClearance ?? nm(0))
    for (const [side, maskLayer] of [
      ['front', 'F.Mask'],
      ['back', 'B.Mask']
    ] as const) {
      if (!viaMaskIsOpen(via, side, this.currentBoard?.tenting)) continue
      this.addRoundRectW(
        key,
        cx,
        cy,
        maskR,
        maskR,
        maskR,
        0,
        this.getLayerColor(maskLayer),
        BoardScene.sketchSign(this.sketchPads, this.getLayerAlpha(maskLayer)),
        this.getLayerZ(maskLayer)
      )
    }

    const hole = roundHole(nmToMm(via.drill))
    const wall = holeWallWidth(hole, r - hole.halfW)
    this.setItemMeta(via.net, META.SPAN, spanMask)
    this.addRoundRectW(
      key,
      cx,
      cy,
      hole.halfW + wall,
      hole.halfH + wall,
      hole.cornerR + wall,
      0,
      this.holes.plated,
      alpha,
      this.getLayerZ(VIA_PSEUDO_LAYER, 'detail')
    )
    this.addRoundRectW(
      key,
      cx,
      cy,
      hole.halfW,
      hole.halfH,
      hole.cornerR,
      0,
      this.holes.bore,
      alpha,
      this.getLayerZ(VIA_PSEUDO_LAYER, 'marker')
    )

    // KiCad labels vias with their net name too — upright, fitted to the
    // annulus, and living or dying by the same zoom fade as the tracks. Not a
    // via inside a pad of its own net: the pad's label already names the net,
    // and the drilled dot is what says a via is there. A via in a pad of
    // ANOTHER net keeps its label — that is a short, and should read as one.
    // Which faces that is, and the ink, follow the facing copper, so both are
    // the shader's: the label is drawn in both inks, each shown where it reads
    // on the annulus and the bore (`META.INK_BY_FACING`), and hidden on a face
    // where the via sits in a pad of its own net (`META.OWN_PAD`). It is in the
    // net-name slot, as KiCad's `LAYER_VIA_NETNAMES` is.
    const name = this.netLabels.get(via.net)
    if (name) {
      const darkInk = copperMask(
        span.filter((layer) => this.darkInkOn(this.getLayerColor(layer), this.holes.bore))
      )
      this.setItemMeta(
        via.net,
        META.SPAN | META.INK_BY_FACING | META.OWN_PAD,
        spanMask,
        darkInk,
        this.ownNetPadFaces(via, cx, cy, span)
      )
      for (const labels of [this.trackLabelBatch, this.trackLabelBatchDark]) {
        labels.addLabelBlock(
          `via:${index}`,
          [name],
          this.sx(cx),
          cy,
          this.getLayerZ(NETNAMES_PSEUDO_LAYER, 'label'),
          nmToMm(via.size) * 0.9,
          nmToMm(via.size) * 0.9,
          0,
          1
        )
      }
    }
    this.setItemNet(via.net)
  }

  /** The copper layers a via passes through on this board, front to back. */
  private viaSpan(via: KicadVia): string[] {
    const ends = via.layers
      .flatMap((layer) => this.expand(layer))
      .map((layer) => this.copperLayers.indexOf(layer))
      .filter((at) => at >= 0)
    if (ends.length === 0) return []
    return this.copperLayers.slice(Math.min(...ends), Math.max(...ends) + 1)
  }

  /** Every pad's copper footprint by net, for `ownNetPadFaces`; rebuilt per board. */
  private padsByNet: { board: KicadBoard; byNet: Map<number, PadArea[]> } | null = null

  /**
   * The copper faces on which the via's center lies in a pad of its own net —
   * via-in-pad as a viewer facing that copper sees it, where the pad's label
   * already names the net. On another face that pad is not there (an SMD
   * pad's via seen from In1.Cu stands alone), so the via keeps its label. The
   * pad's anchor shape decides (a custom pad's primitives are not consulted),
   * which is all a label decision needs.
   */
  private ownNetPadFaces(via: KicadVia, cx: number, cy: number, span: string[]): number {
    const board = this.currentBoard
    if (!board || via.net <= 0) return 0
    if (this.padsByNet?.board !== board) this.padsByNet = { board, byNet: this.padAreas(board) }
    let faces = 0
    for (const pad of this.padsByNet.byNet.get(via.net) ?? []) {
      const dx = cx - pad.x
      const dy = cy - pad.y
      let inside: boolean
      if (pad.round) inside = dx * dx + dy * dy <= pad.halfW * pad.halfW
      else {
        const lx = dx * pad.cos + dy * pad.sin
        const ly = -dx * pad.sin + dy * pad.cos
        inside = Math.abs(lx) <= pad.halfW && Math.abs(ly) <= pad.halfH
      }
      if (inside) faces |= copperMask(span.filter((layer) => pad.layers.has(layer)))
    }
    return faces >>> 0
  }

  private padAreas(board: KicadBoard): Map<number, PadArea[]> {
    const byNet = new Map<number, PadArea[]>()
    for (const bfp of board.footprints) {
      const tf = this.makeTransform(bfp)
      for (const pad of bfp.footprint.pads) {
        const net = pad.net?.number ?? 0
        if (net <= 0) continue
        const center = this.tfPoint(tf, pad.position.x, pad.position.y)
        const angle = THREE.MathUtils.degToRad(pad.position.angle ?? 0)
        const round = pad.shape === 'circle' || (pad.shape === 'custom' && pad.anchor !== 'rect')
        const area: PadArea = {
          x: center.x,
          y: center.y,
          cos: Math.cos(angle),
          sin: Math.sin(angle),
          halfW: nmToMm(pad.size.w) / 2,
          halfH: nmToMm(round ? pad.size.w : pad.size.h) / 2,
          round,
          layers: new Set(pad.layers.flatMap((layer) => this.expand(layer)))
        }
        const list = byNet.get(net)
        if (list) list.push(area)
        else byNet.set(net, [area])
      }
    }
    return byNet
  }

  /** Analytic arc instance through three data-scene points (flip-aware). */
  private addThreePointArc(
    key: string,
    pStartData: { x: number; y: number },
    pMidData: { x: number; y: number },
    pEndData: { x: number; y: number },
    halfStroke: number,
    layer: string | undefined,
    /** Preview drawing overrides the layer's own alpha/z (ghost above copper). */
    override?: { alpha: number; z?: number }
  ): void {
    const color = this.getLayerColor(layer)
    const alpha = override?.alpha ?? this.getLayerAlpha(layer)
    const z = override?.z ?? this.getLayerZ(layer)

    // Mirror the three points up front; the circumcircle/bisector math below
    // then produces the correctly mirrored arc without any angle fix-ups.
    const pStart = { x: this.sx(pStartData.x), y: pStartData.y }
    const pMid = { x: this.sx(pMidData.x), y: pMidData.y }
    const pEnd = { x: this.sx(pEndData.x), y: pEndData.y }

    const circle = circumscribedCircle(pStart.x, pStart.y, pMid.x, pMid.y, pEnd.x, pEnd.y)
    if (!circle) {
      // Degenerate (collinear) arc: draw as a straight capsule (points are
      // already mirrored, so write directly to the batch)
      this.batch.addCapsule(key, pStart.x, pStart.y, pEnd.x, pEnd.y, halfStroke, color, alpha, z)
      return
    }

    const { cx, cy, r } = circle
    const aStart = Math.atan2(pStart.y - cy, pStart.x - cx)
    const aEnd = Math.atan2(pEnd.y - cy, pEnd.x - cx)
    const anticlockwise = !arcContainsMidCCW(pStart, pMid, pEnd, cx, cy)

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
    this.batch.addArc(key, cx, cy, r, halfStroke, bisector, aperture, color, alpha, z)
  }

  private renderZone(zone: KicadBoardZone, index: number): void {
    this.setItemNet(zone.net)
    const key = `zone:${index}`
    const anchor = this.makeAnchor(key, 'zone', index)
    this.paintZone(zone, key, anchor, { x: 0, y: 0 })
  }

  /**
   * A zone's outline, hatch and fill, under `key`, its meshes parented to
   * `anchor`, which stands at `origin` (data-scene mm): a board zone's own
   * anchor at 0,0, or a footprint's zones under the footprint's anchor, so
   * they select, highlight and drag with it.
   */
  private paintZone(
    zone: KicadBoardZone,
    key: string,
    anchor: THREE.Object3D,
    origin: { x: number; y: number }
  ): void {
    // Wildcard zone layers resolved against the board's copper.
    const zoneLayers = zone.layers.flatMap((l) => this.expand(l))
    if (zoneLayers.length === 0 && zone.filledPolys.length === 0) return

    // A teardrop is painted as the track it widens, not as a pour (KiCad's
    // `PCB_PAINTER`): solid at the copper's own opacity and depth, whatever the
    // zone display, with no outline or hatch.
    if (isTeardropZone(zone)) {
      for (const fill of zone.filledPolys) {
        const layer = fill.layer ?? zoneLayers[0] ?? zone.layers[0]
        if (fill.points.length < 3) continue
        const pts = fill.points.map((p) => ({ x: nmToMm(p.x), y: -nmToMm(p.y) }))
        this.addFilledPolygon(
          anchor,
          pts,
          this.getLayerColor(layer),
          1,
          this.getLayerZ(layer),
          origin,
          fill.points
        )
      }
      return
    }

    const localPts = zone.points.map((p) => ({ x: nmToMm(p.x), y: -nmToMm(p.y) }))
    // The hatch's triangles, built once for every layer the zone shows on.
    const hatch = this.zoneHatchGeometry(
      zone,
      localPts.map((p) => ({ x: p.x - origin.x, y: p.y - origin.y }))
    )

    for (const layer of zoneLayers) {
      const z = this.getLayerZ(layer)
      const color = this.getLayerColor(layer)

      // The outline is a boundary drawn ABOUT the copper, not copper: a
      // hairline at every zoom (zero width, the batch's one-pixel floor), so
      // it never reads as a track — KiCad's zone outline, `m_outlineWidth`.
      const alpha = 1
      for (let i = 0; i < localPts.length; i++) {
        const p0 = localPts[i]
        const p1 = localPts[(i + 1) % localPts.length]
        this.addCapsuleW(key, p0.x, p0.y, p1.x, p1.y, 0, color, alpha, z)
      }
      if (hatch) this.addZoneHatch(anchor, hatch, zone, layer, color, alpha)
    }

    // Filled copper polygons (each carries its own layer in v7+). Outline-only
    // display mode skips them entirely — the KiCad left-toolbar toggle.
    if (!this.zoneFillsVisible) return
    for (const fill of zone.filledPolys) {
      const layer = fill.layer ?? zoneLayers[0] ?? zone.layers[0]
      if (fill.points.length < 3) continue
      const pts = fill.points.map((p) => ({ x: nmToMm(p.x), y: -nmToMm(p.y) }))
      this.addFilledPolygon(
        anchor,
        pts,
        this.getLayerColor(layer),
        ZONE_FILL_ALPHA,
        this.getLayerZ(layer, 'fill'),
        origin,
        fill.points
      )
    }
  }

  /**
   * The triangles a zone's border hatch is drawn over, by the file's
   * `(hatch <style> <pitch>)`: the whole outline for `full`, a band one pitch
   * deep inside the border for `edge` (KiCad's short ticks, one pitch in from
   * where each diagonal meets the edge), none for `none`. The stripes
   * themselves are the hatch shader's, so they cost nothing on the CPU and
   * stay crisp at every zoom.
   */
  private zoneHatchGeometry(
    zone: KicadBoardZone,
    localPts: Array<{ x: number; y: number }>
  ): { geometry: THREE.BufferGeometry; spacing: number } | null {
    const style = zone.hatchStyle
    const pitch = zone.hatchPitch !== undefined ? nmToMm(zone.hatchPitch) : 0
    if (!style || style === 'none' || !(pitch > 0) || localPts.length < 3) return null
    // Mirrored with the view, as every other mesh on the board is.
    const outer = localPts.map((p) => ({ x: this.sx(p.x), y: p.y }))
    if (style === 'full') {
      // One full diagonal stands for two edge ticks, so KiCad doubles the spacing.
      return { geometry: shapeGeometryOf([{ outer, holes: [] }]), spacing: pitch * 2 }
    }
    const outline: ClipRegion[] = [{ outer, holes: [] }]
    const band = difference(outline, offset(outline, -pitch, { join: 'miter' }))
    return band.length > 0 ? { geometry: shapeGeometryOf(band), spacing: pitch } : null
  }

  /**
   * One layer's hatch: stripes at 45°, sloped by the zone's first layer as
   * KiCad slopes them (`zoneHatchRises`) — the same on every layer the zone
   * covers.
   */
  private addZoneHatch(
    anchor: THREE.Object3D,
    hatch: { geometry: THREE.BufferGeometry; spacing: number },
    zone: KicadBoardZone,
    layer: string,
    color: THREE.Color,
    alpha: number
  ): void {
    // A flipped view mirrors the slope with everything else; the shader's
    // stripes are fixed on screen, so the pattern swaps instead.
    const rising = zoneHatchRises(zone.layers) !== this.flipped
    const pattern = rising ? HATCH_PATTERN.HATCH : HATCH_PATTERN.REVERSE
    // KiCad spaces its lines by their intercept; the shader by the distance
    // across them, which at 45° is that over √2.
    const material = createHatchMaterial(color, alpha, hatch.spacing / Math.SQRT2, 0, pattern)
    const mesh = new THREE.Mesh(hatch.geometry, material)
    const look: FillLook = {
      defaultColor: color.clone(),
      opacity: alpha,
      net: zone.net ?? 0,
      selected: false
    }
    mesh.userData = { ...look }
    // Over its layer's pour, under the layer's strokes.
    placeFillMesh(mesh, this.getLayerZ(layer, 'fill'), 'hatch', this.paint)
    anchor.add(mesh)
    this.paintFill(mesh)
  }

  /**
   * Two-level triangulation cache for filled polygons.
   *
   * L1 keys on the domain points array's identity: remapKicadBoard reuses
   * untouched domain objects across command rebuilds, so layer toggles and
   * post-edit rebuilds hit it for free.
   *
   * L2 keys on the *content* of the points, normalized relative to the first
   * point: undo/redo re-parses the document text, producing brand-new arrays
   * with identical geometry — without L2, every undo would re-earcut 500k+
   * points (~2.3s on dense boards). Normalizing makes the key translation-
   * invariant, so dragged zones rehit it too. Hash collisions are handled by
   * full content verification, never trusted blindly. Triangle indices are
   * translation- and mirror-invariant, so one entry serves every origin and
   * flip combination.
   */
  private fillIndexCache = new WeakMap<Array<{ x: number; y: number }>, Uint32Array>()
  // Static: shared across BoardScene instances so closing/reopening a board
  // tab (each mount constructs a fresh scene) reuses the triangulations too
  private static fillContentCache = new Map<
    number,
    Array<{ pts: Float64Array; index: Uint32Array }>
  >()
  private static fillContentCacheEntries = 0
  private static readonly FILL_CONTENT_CACHE_MAX = 1024

  /** Points packed relative to the first point (translation-invariant). */
  private static packRelative(pts: Array<{ x: number; y: number }>): Float64Array {
    const packed = new Float64Array(pts.length * 2)
    const x0 = pts[0].x
    const y0 = pts[0].y
    for (let i = 0; i < pts.length; i++) {
      packed[i * 2] = pts[i].x - x0
      packed[i * 2 + 1] = pts[i].y - y0
    }
    return packed
  }

  private static hashPacked(packed: Float64Array): number {
    const words = new Uint32Array(packed.buffer, 0, packed.length * 2)
    let h = 0x811c9dc5 // FNV-1a
    for (let i = 0; i < words.length; i++) {
      h ^= words[i]
      h = Math.imul(h, 0x01000193)
    }
    return h >>> 0
  }

  private static samePacked(a: Float64Array, b: Float64Array): boolean {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false
    }
    return true
  }

  /** Cache-only lookup (L1 identity, then L2 content); null on miss. */
  private cachedFillIndex(cacheKey: Array<{ x: number; y: number }>): Uint32Array | null {
    const l1 = this.fillIndexCache.get(cacheKey)
    if (l1) return l1

    const packed = BoardScene.packRelative(cacheKey)
    const hash = BoardScene.hashPacked(packed)
    const bucket = BoardScene.fillContentCache.get(hash)
    if (bucket) {
      for (const entry of bucket) {
        if (BoardScene.samePacked(entry.pts, packed)) {
          this.fillIndexCache.set(cacheKey, entry.index)
          return entry.index
        }
      }
    }
    return null
  }

  private storeFillIndex(cacheKey: Array<{ x: number; y: number }>, index: Uint32Array): void {
    this.fillIndexCache.set(cacheKey, index)
    const packed = BoardScene.packRelative(cacheKey)
    const hash = BoardScene.hashPacked(packed)
    if (BoardScene.fillContentCacheEntries >= BoardScene.FILL_CONTENT_CACHE_MAX) {
      BoardScene.fillContentCache.clear()
      BoardScene.fillContentCacheEntries = 0
    }
    const bucket = BoardScene.fillContentCache.get(hash)
    if (bucket) {
      bucket.push({ pts: packed, index })
    } else {
      BoardScene.fillContentCache.set(hash, [{ pts: packed, index }])
    }
    BoardScene.fillContentCacheEntries++
  }

  private triangulateFill(
    scenePts: Array<{ x: number; y: number }>,
    cacheKey?: Array<{ x: number; y: number }>
  ): Uint32Array {
    if (!cacheKey) return BoardScene.earcutContour(scenePts)
    const cached = this.cachedFillIndex(cacheKey)
    if (cached) return cached
    const index = BoardScene.earcutContour(scenePts)
    this.storeFillIndex(cacheKey, index)
    return index
  }

  private static earcutContour(scenePts: Array<{ x: number; y: number }>): Uint32Array {
    // triangulateShape mutates its input (dup end-point pop) and calls
    // .equals() on the points, so hand it throwaway Vector2s
    const contour = scenePts.map((p) => new THREE.Vector2(p.x, p.y))
    const faces = THREE.ShapeUtils.triangulateShape(contour, [])
    const index = new Uint32Array(faces.length * 3)
    for (let i = 0; i < faces.length; i++) {
      index[i * 3] = faces[i][0]
      index[i * 3 + 1] = faces[i][1]
      index[i * 3 + 2] = faces[i][2]
    }
    return index
  }

  // ---------------------------------------------------------------------------
  // Deferred fill tessellation: on a cold cache (first-ever open of a board),
  // earcutting every zone fill costs seconds. rebuild() renders everything
  // else immediately and hands cache-miss fills to a shared Web Worker
  // (fillWorker.ts); meshes land as results arrive, appearing progressively,
  // and the main thread never earcuts. Where Worker construction fails
  // (jsdom tests), fills fall back to post-paint setTimeout time slices.
  // Cache hits (every later rebuild) stay synchronous.
  // ---------------------------------------------------------------------------

  private pendingFills: PendingFill[] = []
  private fillTimer: ReturnType<typeof setTimeout> | null = null
  private onDeferredGeometryCb?: () => void
  /** Deferred fills requested / landed since the last rebuild — the numbers
   *  behind the viewport's zone-fill progress pill. */
  private fillsQueued = 0
  private fillsSettled = 0
  /**
   * Bumped by cancelPendingFills (each clear/rebuild). A worker result whose
   * job carries an older generation targets anchors that are no longer in the
   * scene: its triangulation is still cached, but no mesh is built.
   */
  private fillGeneration = 0
  /**
   * cacheKey → its in-flight job. A rebuild that re-requests a fill still
   * being computed re-targets the existing job (fresh anchor/color/
   * generation) instead of posting a duplicate.
   */
  private inFlightFills = new Map<Array<{ x: number; y: number }>, PendingFill>()

  // The worker pool and job dispatch table are static: one pool serves every
  // scene instance, and results route back by job id. A pool rather than a
  // single worker because a dense board queues hundreds of independent
  // triangulations at load — serialized, they stream in over many seconds.
  private static fillWorkers: Worker[] | null | undefined
  private static nextFillWorker = 0
  private static nextFillJobId = 1
  private static fillJobById = new Map<number, { scene: BoardScene; job: PendingFill }>()

  /** Sized to the machine but capped: fills are CPU-bound and bursty, and
   *  each extra worker is another copy of the triangulator kept alive. */
  private static readonly FILL_POOL_MAX = 8

  private static getFillWorkers(): Worker[] | null {
    if (BoardScene.fillWorkers !== undefined) return BoardScene.fillWorkers
    const size = Math.min(
      BoardScene.FILL_POOL_MAX,
      Math.max(1, (navigator.hardwareConcurrency || 4) - 1)
    )
    try {
      const workers: Worker[] = []
      for (let i = 0; i < size; i++) {
        const worker = new Worker(new URL('./fillWorker.ts', import.meta.url), { type: 'module' })
        worker.onmessage = (e: MessageEvent<FillWorkResponse>) => {
          const entry = BoardScene.fillJobById.get(e.data.id)
          BoardScene.fillJobById.delete(e.data.id)
          entry?.scene.completeFillJob(entry.job, e.data.index)
        }
        workers.push(worker)
      }
      BoardScene.fillWorkers = workers
    } catch {
      BoardScene.fillWorkers = null
    }
    return BoardScene.fillWorkers
  }

  /** Called after each deferred fill lands (viewport re-renders). */
  public setDeferredGeometryCallback(cb: () => void): void {
    this.onDeferredGeometryCb = cb
  }

  /** Progress of the current rebuild's deferred fills (cache hits never count). */
  public getFillProgress(): { queued: number; settled: number } {
    return { queued: this.fillsQueued, settled: this.fillsSettled }
  }

  /** Told each time a deferred fill lands or a rebuild discards the rest (`finishFills`). */
  private fillWaiters = new Set<() => void>()

  /**
   * Resolves once the fills this scene's current drawing deferred have all
   * landed, with 0, or with how many are still missing when `timeoutMs` passes
   * first or a rebuild discards them. A picture waits on this; the editor
   * never does, it draws fills as they arrive.
   */
  public finishFills(timeoutMs: number): Promise<number> {
    const generation = this.fillGeneration
    const missing = (): number => this.fillsQueued - this.fillsSettled
    if (missing() === 0) return Promise.resolve(0)
    return new Promise((resolve) => {
      let left = missing()
      const done = (count: number): void => {
        clearTimeout(timer)
        this.fillWaiters.delete(check)
        resolve(count)
      }
      const check = (): void => {
        if (generation !== this.fillGeneration) return done(left)
        left = missing()
        if (left === 0) done(0)
      }
      const timer = setTimeout(
        () => done(generation === this.fillGeneration ? missing() : left),
        timeoutMs
      )
      this.fillWaiters.add(check)
    })
  }

  private notifyFillWaiters(): void {
    for (const check of [...this.fillWaiters]) check()
  }

  private cancelPendingFills(): void {
    this.fillGeneration++
    this.pendingFills = []
    this.fillsQueued = 0
    this.fillsSettled = 0
    if (this.fillTimer !== null) {
      clearTimeout(this.fillTimer)
      this.fillTimer = null
    }
    this.notifyFillWaiters()
  }

  private queueFillJob(
    anchor: THREE.Object3D,
    scenePts: Array<{ x: number; y: number }>,
    cacheKey: Array<{ x: number; y: number }>,
    color: THREE.Color,
    opacity: number,
    z: number
  ): void {
    const job: PendingFill = {
      anchor,
      scenePts,
      cacheKey,
      color: color.clone(),
      opacity,
      z,
      net: this.itemNet,
      generation: this.fillGeneration
    }
    this.fillsQueued++

    const workers = BoardScene.getFillWorkers()
    if (!workers) {
      this.pendingFills.push(job)
      this.scheduleFillSlice()
      return
    }

    const inFlight = this.inFlightFills.get(cacheKey)
    if (inFlight) {
      // Same contour already computing (queued by an earlier rebuild):
      // point the pending result at the current scene targets
      Object.assign(inFlight, job)
      return
    }
    this.inFlightFills.set(cacheKey, job)

    const coords = new Float64Array(scenePts.length * 2)
    for (let i = 0; i < scenePts.length; i++) {
      coords[i * 2] = scenePts[i].x
      coords[i * 2 + 1] = scenePts[i].y
    }
    const id = BoardScene.nextFillJobId++
    BoardScene.fillJobById.set(id, { scene: this, job })
    const request: FillWorkRequest = { id, coords }
    const worker = workers[BoardScene.nextFillWorker++ % workers.length]
    worker.postMessage(request, [coords.buffer])
  }

  private completeFillJob(job: PendingFill, index: Uint32Array): void {
    this.inFlightFills.delete(job.cacheKey)
    // The triangulation is valid regardless of what happened to the scene
    // meanwhile — always keep it (L2 survives rebuilds and scene instances)
    if (!this.fillIndexCache.has(job.cacheKey)) {
      this.storeFillIndex(job.cacheKey, index)
    }
    if (job.generation !== this.fillGeneration) return // scene rebuilt since
    this.buildFillMesh(job.anchor, job.scenePts, index, job.color, job.opacity, job.z, job.net)
    this.fillsSettled++
    this.onDeferredGeometryCb?.()
    this.notifyFillWaiters()
  }

  /** Fallback for environments without Worker support: ~12 ms time slices. */
  private scheduleFillSlice(): void {
    if (this.fillTimer !== null) return
    this.fillTimer = setTimeout(() => {
      this.fillTimer = null
      const deadline = performance.now() + 12
      while (this.pendingFills.length > 0 && performance.now() < deadline) {
        const job = this.pendingFills.shift()!
        const index = this.cachedFillIndex(job.cacheKey) ?? BoardScene.earcutContour(job.scenePts)
        if (!this.fillIndexCache.has(job.cacheKey)) {
          this.storeFillIndex(job.cacheKey, index)
        }
        this.buildFillMesh(job.anchor, job.scenePts, index, job.color, job.opacity, job.z, job.net)
        this.fillsSettled++
      }
      if (this.pendingFills.length > 0) this.scheduleFillSlice()
      this.onDeferredGeometryCb?.()
      this.notifyFillWaiters()
    }, 0)
  }

  private buildFillMesh(
    anchor: THREE.Object3D,
    scenePts: Array<{ x: number; y: number }>,
    index: Uint32Array,
    color: THREE.Color,
    opacity: number,
    z: number,
    net: number
  ): void {
    const positions = new Float32Array(scenePts.length * 3)
    for (let i = 0; i < scenePts.length; i++) {
      positions[i * 3] = scenePts[i].x
      positions[i * 3 + 1] = scenePts[i].y
    }
    const geom = new THREE.BufferGeometry()
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geom.setIndex(new THREE.BufferAttribute(index, 1))

    // Transparent even at full opacity, and never writing depth: a fill has to
    // sit in the one paint order the whole board shares, and three.js draws the
    // opaque queue before all of it. Its look is `paintFill`'s.
    const mesh = new THREE.Mesh(
      geom,
      new THREE.MeshBasicMaterial({
        side: THREE.DoubleSide,
        // Double-sided for the flipped view's mirrored winding; without this
        // three.js draws every double-sided translucent mesh twice, a side a pass.
        forceSinglePass: true,
        transparent: true,
        depthWrite: false
      })
    )
    const look: FillLook = { defaultColor: color.clone(), opacity, net, selected: false }
    mesh.userData = { ...look }
    placeFillMesh(mesh, z, 'fill', this.paint)
    anchor.add(mesh)
    // A fill landing after the diff paint or highlightSelection ran (deferred
    // slices) takes them as they stand: the tone, then its place in the
    // selected band.
    const ud = anchor.userData as { type?: string; index?: number }
    if (ud.type !== undefined && this.diffTone) this.toneFills(`${ud.type}:${ud.index}`, mesh)
    if (ud.type !== undefined && this.selectedFillKeys.has(`${ud.type}:${ud.index}`)) {
      mesh.userData.selected = true
      liftFillMesh(mesh, true, this.paint)
    }
    this.paintFill(mesh)
  }

  private addFilledPolygon(
    anchor: THREE.Object3D,
    dataPts: Array<{ x: number; y: number }>,
    color: THREE.Color,
    opacity: number,
    z: number,
    // Data-space position of the anchor; must be subtracted because the mesh
    // is parented to the anchor (pass it whenever the anchor is not at 0,0)
    origin: { x: number; y: number } = { x: 0, y: 0 },
    // Stable identity for the triangulation cache (see fillIndexCache)
    cacheKey?: Array<{ x: number; y: number }>
  ): void {
    // Its own copy: a cold-cache fill is built later, after the scratch has moved on.
    const scenePts = dataPts.map((p) => ({ x: this.sx(p.x - origin.x), y: p.y - origin.y }))

    if (cacheKey) {
      const cached = this.cachedFillIndex(cacheKey)
      if (cached) {
        this.buildFillMesh(anchor, scenePts, cached, color, opacity, z, this.itemNet)
      } else {
        // Cold cache: triangulate off the main thread (worker or fallback)
        this.queueFillJob(anchor, scenePts, cacheKey, color, opacity, z)
      }
      return
    }

    const index = this.triangulateFill(scenePts, cacheKey)
    this.buildFillMesh(anchor, scenePts, index, color, opacity, z, this.itemNet)
  }

  private renderGrLine(line: KicadFpLine, index: number): void {
    const key = `gr_line:${index}`
    const layer = line.layer ?? 'Edge.Cuts'
    this.addCapsuleW(
      key,
      nmToMm(line.start.x),
      -nmToMm(line.start.y),
      nmToMm(line.end.x),
      -nmToMm(line.end.y),
      (line.strokeWidth !== undefined ? nmToMm(line.strokeWidth) : 0.1) / 2,
      this.getLayerColor(layer),
      this.getLayerAlpha(layer),
      this.getLayerZ(layer)
    )
  }

  private renderGrArc(arc: KicadFpArc, index: number): void {
    const key = `gr_arc:${index}`
    this.addThreePointArc(
      key,
      { x: nmToMm(arc.start.x), y: -nmToMm(arc.start.y) },
      { x: nmToMm(arc.mid.x), y: -nmToMm(arc.mid.y) },
      { x: nmToMm(arc.end.x), y: -nmToMm(arc.end.y) },
      (arc.strokeWidth !== undefined ? nmToMm(arc.strokeWidth) : 0.1) / 2,
      arc.layer ?? 'Edge.Cuts'
    )
  }

  private renderGrCircle(circle: KicadFpCircle, index: number): void {
    const key = `gr_circle:${index}`
    const layer = circle.layer ?? 'Edge.Cuts'
    const r = Math.hypot(circle.end.x - circle.center.x, circle.end.y - circle.center.y) / NM_PER_MM
    if (circle.fill === 'solid' || circle.fill === 'yes') {
      this.addRoundRectW(
        key,
        nmToMm(circle.center.x),
        -nmToMm(circle.center.y),
        r,
        r,
        r,
        0,
        this.getLayerColor(layer),
        this.getLayerAlpha(layer),
        this.getLayerZ(layer, 'fill')
      )
    }
    this.addRingW(
      key,
      nmToMm(circle.center.x),
      -nmToMm(circle.center.y),
      r,
      (circle.strokeWidth !== undefined ? nmToMm(circle.strokeWidth) : 0.1) / 2,
      this.getLayerColor(layer),
      this.getLayerAlpha(layer),
      this.getLayerZ(layer)
    )
  }

  private renderGrRect(rect: KicadFpRect, index: number): void {
    const key = `gr_rect:${index}`
    const layer = rect.layer ?? 'Edge.Cuts'
    const sx = nmToMm(rect.start.x)
    const sy = -nmToMm(rect.start.y)
    const ex = nmToMm(rect.end.x)
    const ey = -nmToMm(rect.end.y)
    const halfW = (rect.strokeWidth !== undefined ? nmToMm(rect.strokeWidth) : 0.1) / 2
    const color = this.getLayerColor(layer)
    const alpha = this.getLayerAlpha(layer)
    const z = this.getLayerZ(layer)
    if (rect.fill === 'solid' || rect.fill === 'yes') {
      this.addRoundRectW(
        key,
        (sx + ex) / 2,
        (sy + ey) / 2,
        Math.abs(ex - sx) / 2,
        Math.abs(ey - sy) / 2,
        0,
        0,
        color,
        alpha,
        this.getLayerZ(layer, 'fill')
      )
    }
    this.addCapsuleW(key, sx, sy, ex, sy, halfW, color, alpha, z)
    this.addCapsuleW(key, ex, sy, ex, ey, halfW, color, alpha, z)
    this.addCapsuleW(key, ex, ey, sx, ey, halfW, color, alpha, z)
    this.addCapsuleW(key, sx, ey, sx, sy, halfW, color, alpha, z)
  }

  private renderGrPoly(poly: KicadFpPoly, index: number): void {
    if (poly.points.length < 2) return
    const key = `gr_poly:${index}`
    const layer = poly.layer ?? 'Edge.Cuts'
    const pts = poly.points.map((p) => ({ x: nmToMm(p.x), y: -nmToMm(p.y) }))
    const halfW = (poly.strokeWidth !== undefined ? nmToMm(poly.strokeWidth) : 0.1) / 2
    const color = this.getLayerColor(layer)
    const alpha = this.getLayerAlpha(layer)
    const z = this.getLayerZ(layer)

    const anchor = this.makeAnchor(key, 'gr_poly', index)
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i]
      const b = pts[(i + 1) % pts.length]
      this.addCapsuleW(key, a.x, a.y, b.x, b.y, halfW, color, alpha, z)
    }
    if ((poly.fill === 'solid' || poly.fill === 'yes') && pts.length >= 3) {
      this.addFilledPolygon(
        anchor,
        pts,
        color,
        this.getLayerAlpha(layer),
        this.getLayerZ(layer, 'fill')
      )
    }
  }

  private renderGrText(text: KicadGrText, index: number): void {
    if (!text.position || text.hide) return
    const key = `gr_text:${index}`
    const pos = { x: nmToMm(text.position.x), y: -nmToMm(text.position.y) }
    this.renderStrokeText(
      key,
      text.text,
      pos,
      text.position.angle,
      text.layer ?? 'F.SilkS',
      text.fontEffects
    )
  }

  /**
   * The board's Béziers, text boxes, tables and points under their item types,
   * in the order they draw, hit-test and band-select in.
   */
  public static extraCollections(
    board: KicadBoard
  ): Array<readonly [string, readonly KicadExtraGraphic[]]> {
    return [
      ['gr_curve', board.grCurves],
      ['point', board.points],
      ['gr_text_box', board.grTextBoxes],
      ['table', board.tables]
    ]
  }

  /** Board file space (nm, y down) → data-scene space (mm, y up). */
  private static boardSpace = (p: { x: number; y: number }): { x: number; y: number } => ({
    x: p.x / NM_PER_MM,
    y: -p.y / NM_PER_MM
  })

  /**
   * A Bézier, text box, table or point (lib/board/extraGraphics.ts), its file
   * points carried into the scene by `map` — straight for the board's own, and
   * through the placement for a footprint's, whose text angles are relative
   * to it and turn by `angleOffset`. `expand` grows a footprint's bounds.
   */
  private renderExtraGraphic(
    key: string,
    item: KicadExtraGraphic,
    map: (p: { x: number; y: number }) => { x: number; y: number },
    angleOffset: number,
    expand?: (x: number, y: number) => void
  ): void {
    const layer = item.layer ?? 'F.SilkS'
    const drawing = extraGraphicDrawing(item)
    const color = this.getLayerColor(layer)
    const alpha = this.getLayerAlpha(layer)
    const z = this.getLayerZ(layer)
    for (const stroke of drawing.strokes) {
      const pts = stroke.points.map(map)
      pts.forEach((p) => expand?.(p.x, p.y))
      const n = stroke.closed ? pts.length : pts.length - 1
      for (let i = 0; i < n; i++) {
        const a = pts[i]
        const b = pts[(i + 1) % pts.length]
        this.addCapsuleW(key, a.x, a.y, b.x, b.y, stroke.width / NM_PER_MM / 2, color, alpha, z)
      }
    }
    for (const ring of drawing.rings) {
      const c = map(ring.center)
      expand?.(c.x, c.y)
      this.addRingW(
        key,
        c.x,
        c.y,
        ring.radius / NM_PER_MM,
        ring.width / NM_PER_MM / 2,
        color,
        alpha,
        z
      )
    }
    for (const text of drawing.texts) {
      const pos = map(text.anchor)
      expand?.(pos.x, pos.y)
      this.renderStrokeText(key, text.text, pos, text.angle + angleOffset, layer, text.effects)
    }
  }

  /**
   * Dimension annotation: its text (baked into the file as a nested gr_text)
   * and the lines KiCad builds for its kind (`dimensionGeometry.ts`, which DRC
   * measures too) at the style's thickness. All coordinates are board space.
   */
  private renderDimension(dim: KicadDimension, key: string): void {
    const layer = dim.layer ?? 'Dwgs.User'
    const color = this.getLayerColor(layer)
    const alpha = this.getLayerAlpha(layer)
    const z = this.getLayerZ(layer)

    if (dim.text?.position) {
      this.renderStrokeText(
        key,
        dim.text.text,
        { x: nmToMm(dim.text.position.x), y: -nmToMm(dim.text.position.y) },
        dim.text.position.angle,
        dim.text.layer ?? layer,
        dim.text.fontEffects
      )
    }

    const halfW = (dim.style?.thickness !== undefined ? nmToMm(dim.style.thickness) : 0.2) / 2
    const { lines, circles } = dimensionGeometry(dim)
    for (const { a, b } of lines) {
      this.addCapsuleW(
        key,
        a.x / NM_PER_MM,
        -a.y / NM_PER_MM,
        b.x / NM_PER_MM,
        -b.y / NM_PER_MM,
        halfW,
        color,
        alpha,
        z
      )
    }
    for (const { center, radius } of circles) {
      this.addRingW(
        key,
        center.x / NM_PER_MM,
        -center.y / NM_PER_MM,
        radius / NM_PER_MM,
        halfW,
        color,
        alpha,
        z
      )
    }
  }

  /**
   * Draw the route in progress above the document: what this pass has placed
   * (each segment on its own layer — a mid-route via changes layers), the head
   * to the cursor, and the vias. Each part is a layer of its own color that
   * the engine flattens and lays down once (`previewLayerSpecs`), so its
   * joints and caps do not stack their opacity. Placed below head below vias;
   * a segment or via flagged `violation` draws in the violation red, on
   * screen while the track is still rubber-banding. Empty arrays clear it.
   */
  public setRoutePreview(
    placed: readonly RoutePreviewSegment[],
    head: readonly RoutePreviewSegment[],
    vias: ReadonlyArray<{ x: number; y: number; size: number; drill: number; violation?: boolean }>
  ): void {
    this.routePool.begin()
    const shift = this.selectionShift()
    const segmentLayers = (
      segments: readonly RoutePreviewSegment[],
      lift: number,
      opacity: number
    ): void => {
      const byLayer = new Map<string, RoutePreviewSegment[]>()
      for (const s of segments) {
        if (s.violation) continue
        const list = byLayer.get(s.layer)
        if (list) list.push(s)
        else byLayer.set(s.layer, [s])
      }
      for (const [layer, list] of byLayer) {
        const color = this.shiftedColor(this.getLayerColor(layer), lift, new THREE.Color())
        const batch = this.routeLayer(opacity)
        for (const s of list) this.addRouteCapsule(batch, s, color)
      }
    }
    segmentLayers(placed, shift, ROUTE_PLACED_OPACITY)
    segmentLayers(head, shift * ROUTE_HEAD_LIFT, ROUTE_HEAD_OPACITY)

    const violations = [...placed, ...head].filter((s) => s.violation)
    if (violations.length > 0) {
      const batch = this.routeLayer(ROUTE_HEAD_OPACITY)
      for (const s of violations) this.addRouteCapsule(batch, s, BoardScene.VIOLATION_COLOR)
    }

    if (vias.length > 0) {
      // A pending via has no layer span yet, so it is drawn in a neutral via
      // color rather than any layer's copper — the active layer changes under
      // it the moment it is dropped. Only its annular ring, with the hole left
      // open as KiCad leaves it while routing, so the route beneath shows
      // through to the via's center.
      const rings = this.routeLayer(1)
      for (const v of vias) {
        const outer = v.size / 2
        const inner = Math.min(v.drill / 2, outer)
        rings.addRing(
          ROUTE_PREVIEW_KEY,
          this.sx(v.x),
          v.y,
          (outer + inner) / 2,
          (outer - inner) / 2,
          v.violation ? BoardScene.VIOLATION_COLOR : this.holes.pendingVia,
          1,
          PREVIEW_Z
        )
      }
    }

    this.routePool.end()
  }

  /**
   * The preview's layers, bottom first, for `ViewportEngine.setPreviewLayers`:
   * clearance halos, then board copper in motion (pushed, or lit where a route
   * violates it), then the route. Re-issue after any of `setRoutePreview`,
   * `setShovePreview` and `setViolationMarks`: how many layers they need changes.
   */
  public previewLayerSpecs(): PreviewLayerSpec[] {
    return [this.shovePool, this.markPool, this.routePool]
      .flatMap((pool) => pool.layers)
      .sort((a, b) => a.tier - b.tier)
      .map(({ batch, opacity }) => ({ objects: [batch.mesh], opacity }))
  }

  /** Pooled across moves: each preview is redrawn on every one. */
  private readonly routePool: PreviewLayerPool
  private readonly shovePool: PreviewLayerPool
  private readonly markPool: PreviewLayerPool

  private routeLayer(opacity: number): PrimitiveBatch {
    return this.routePool.layer(opacity, PREVIEW_TIER_ROUTE)
  }

  private addRouteCapsule(batch: PrimitiveBatch, s: RoutePreviewSegment, color: THREE.Color): void {
    batch.addCapsule(
      ROUTE_PREVIEW_KEY,
      this.sx(s.x0),
      s.y0,
      this.sx(s.x1),
      s.y1,
      s.width / 2,
      color,
      1,
      PREVIEW_Z
    )
  }

  /** Clearance-violation tint for previews — deliberately loud. */
  private static readonly VIOLATION_COLOR = new THREE.Color('#ff4d4d')
  /**
   * The copper a route or drag violates (F2): a green no copper layer and no
   * net highlight uses, so it reads as in the way, not as lit (KiCad's is green too).
   */
  private static readonly COLLIDING_COLOR = new THREE.Color('#3dff6e')

  private shoveHiddenKeys: string[] = []

  /**
   * Whether a click that hits only a fill's mesh may select its item, by the
   * selection filter: never a teardrop's zone, which is its pad's or via's
   * setting (KiCad), but on a board with KiCad 7's teardrops.
   */
  public raycastSelectable(
    type: string,
    index: number,
    allows: (level: { kind: string; locked?: boolean }) => boolean
  ): boolean {
    const board = this.currentBoard
    if (type === 'zone') {
      const zone = board?.zones[index]
      if (!zone || !board) return false
      if (isTeardropZone(zone) && !hasLegacyTeardrops(board)) return false
      return allows({ kind: boardItemKind('zone', zone.isKeepout), locked: zone.locked })
    }
    return allows({ kind: boardItemKind(type) })
  }

  /**
   * The teardrops on the copper a preview stands in for, which hide with it
   * while it moves, as KiCad's router hides them (`PNS_KICAD_IFACE::HideItem`):
   * the edit's commit builds them again.
   */
  private teardropsUnder(hidden: ReadonlyArray<{ type: string; index: number }>): string[] {
    const board = this.currentBoard
    if (!board || hidden.length === 0) return []
    const boxes: Array<{ minX: number; minY: number; maxX: number; maxY: number }> = []
    for (const ref of hidden) {
      const item =
        ref.type === 'segment'
          ? board.segments[ref.index]
          : ref.type === 'tarc'
            ? board.trackArcs[ref.index]
            : null
      if (item) {
        const r = item.width / 2
        boxes.push({
          minX: Math.min(item.start.x, item.end.x) - r,
          minY: Math.min(item.start.y, item.end.y) - r,
          maxX: Math.max(item.start.x, item.end.x) + r,
          maxY: Math.max(item.start.y, item.end.y) + r
        })
      } else if (ref.type === 'via' && board.vias[ref.index]) {
        const via = board.vias[ref.index]
        const r = via.size / 2
        boxes.push({
          minX: via.position.x - r,
          minY: via.position.y - r,
          maxX: via.position.x + r,
          maxY: via.position.y + r
        })
      }
    }
    const keys: string[] = []
    board.zones.forEach((zone, index) => {
      if (!isTeardropZone(zone)) return
      const xs = zone.points.map((p) => p.x)
      const ys = zone.points.map((p) => p.y)
      const box = {
        minX: Math.min(...xs),
        minY: Math.min(...ys),
        maxX: Math.max(...xs),
        maxY: Math.max(...ys)
      }
      if (
        boxes.some(
          (b) =>
            b.minX <= box.maxX && b.maxX >= box.minX && b.minY <= box.maxY && b.maxY >= box.minY
        )
      )
        keys.push(`zone:${index}`)
    })
    return keys
  }

  /**
   * Shove's displaced-copper preview: suppress the paint of the base items
   * the router has displaced and draw their proposed geometry instead, solid
   * — this copper is real board content in motion, not a ghost — over the
   * halo of the clearance it keeps (`clearance`, mm; none when absent), as
   * KiCad's router shows it. Flattened layers, so a pushed line's joints do
   * not stack. Pass empty arrays to restore everything (spring-back/Esc).
   */
  public setShovePreview(
    hidden: Array<{ type: string; index: number }>,
    segments: Array<{
      x0: number
      y0: number
      x1: number
      y1: number
      width: number
      layer: string
      violation?: boolean
    }>,
    vias: Array<{ x: number; y: number; size: number; drill: number }> = [],
    halo?: { clearance: number; segments?: number; vias?: number }
  ): void {
    // An item the preview stands in for leaves ALL of itself behind: its
    // paint and its net label.
    const setHidden = (key: string, hidden: boolean): void => {
      // A zone's fill is its own meshes, under its anchor.
      if (key.startsWith('zone:')) {
        const anchor = this.elements[key]
        if (anchor) anchor.visible = !hidden
        return
      }
      this.batch.setElementHidden(key, hidden)
      for (const labels of this.trackLabelBatches) labels.setElementHidden(key, hidden)
    }
    const restored = this.shoveHiddenKeys
    for (const key of restored) setHidden(key, false)
    this.shoveHiddenKeys = [
      ...hidden.map((r) => `${r.type}:${r.index}`),
      ...this.teardropsUnder(hidden)
    ]
    for (const key of this.shoveHiddenKeys) setHidden(key, true)
    // A glow re-copied while its item was hidden came out empty (a hidden
    // instance does not copy), so a selected item coming back is re-glowed.
    if (
      restored.some((key) => this.selectedFillKeys.has(key) && !this.shoveHiddenKeys.includes(key))
    )
      this.highlightSelection(this.highlighted)

    const pool = this.shovePool
    pool.begin()
    const ringed = {
      segments: segments.slice(0, halo?.segments ?? segments.length),
      vias: vias.slice(0, halo?.vias ?? vias.length)
    }
    if (halo && halo.clearance > 0 && ringed.segments.length + ringed.vias.length > 0) {
      const batch = pool.layer(HALO_OPACITY, PREVIEW_TIER_HALO)
      const c = halo.clearance
      const gray = this.ratsnestColor
      for (const s of ringed.segments)
        this.addPreviewShape(batch, { kind: 'capsule', ...s, halfWidth: s.width / 2 }, c, gray)
      for (const v of ringed.vias)
        this.addPreviewShape(batch, { kind: 'circle', cx: v.x, cy: v.y, r: v.size / 2 }, c, gray)
    }
    const byLayer = new Map<string, typeof segments>()
    for (const s of segments) {
      const key = s.violation ? '' : s.layer
      const list = byLayer.get(key)
      if (list) list.push(s)
      else byLayer.set(key, [s])
    }
    for (const [layer, list] of byLayer) {
      const color = layer ? this.getLayerColor(layer) : BoardScene.VIOLATION_COLOR
      const batch = pool.layer(SHOVED_OPACITY, PREVIEW_TIER_COPPER)
      for (const s of list)
        this.addPreviewShape(batch, { kind: 'capsule', ...s, halfWidth: s.width / 2 }, 0, color)
    }
    if (vias.length > 0) {
      const copper = pool.layer(SHOVED_OPACITY, PREVIEW_TIER_COPPER)
      const bores = pool.layer(1, PREVIEW_TIER_COPPER)
      const color = this.getLayerColor(this.currentActiveLayer)
      for (const v of vias) {
        this.addPreviewShape(copper, { kind: 'circle', cx: v.x, cy: v.y, r: v.size / 2 }, 0, color)
        const hole = roundHole(v.drill)
        bores.addRoundRect(
          SHOVE_PREVIEW_KEY,
          this.sx(v.x),
          v.y,
          hole.halfW,
          hole.halfH,
          hole.cornerR,
          0,
          this.holes.bore,
          1,
          PREVIEW_Z
        )
      }
    }
    pool.end()
  }

  /**
   * What a route or drag violates, so the person sees what is in the way and
   * how far to keep off it (docs/router-behavior.md F2), as KiCad's router
   * shows it: the copper in the collision green, over the halo of the clearance it asks; a hole
   * by its halo alone; an area (a keepout) by its outline, a line `halfWidth`
   * mm wide. Scene coordinates; [] clears.
   */
  public setViolationMarks(
    marks: ReadonlyArray<{
      shape: CopperShape
      layer: string
      clearance: number
      copper: boolean
    }>,
    halfWidth = 0.02
  ): void {
    this.setItemMeta()
    this.batch.removeElement(VIOLATION_MARKS_KEY)
    const pool = this.markPool
    pool.begin()
    const halos = marks.filter((m) => m.clearance > 0)
    if (halos.length > 0) {
      const halo = pool.layer(HALO_OPACITY, PREVIEW_TIER_HALO)
      for (const m of halos) this.addPreviewShape(halo, m.shape, m.clearance, this.ratsnestColor)
    }
    const struck = marks.filter((m) => m.copper)
    if (struck.length > 0) {
      const batch = pool.layer(1, PREVIEW_TIER_COPPER)
      for (const m of struck)
        this.addPreviewShape(batch, m.shape, 0, BoardScene.COLLIDING_COLOR, halfWidth)
    }
    pool.end()
    for (const m of marks) {
      if (m.copper || m.clearance > 0 || m.shape.kind !== 'poly') continue
      for (const ring of m.shape.rings)
        for (let i = 0; i < ring.length; i++) {
          const a = ring[i]
          const b = ring[(i + 1) % ring.length]
          this.addCapsuleW(
            VIOLATION_MARKS_KEY,
            a.x,
            a.y,
            b.x,
            b.y,
            halfWidth,
            BoardScene.VIOLATION_COLOR,
            0.9,
            layerZ(PREVIEW_SLOT, 'marker')
          )
        }
    }
  }

  /**
   * A copper shape grown by `grow` (mm), into a flattened preview layer. A
   * polygon, which the batch cannot fill, is drawn as its outline, a band of
   * the growth (or of `outline` mm where there is none) round each edge.
   */
  private addPreviewShape(
    batch: PrimitiveBatch,
    shape: CopperShape,
    grow: number,
    color: THREE.Color,
    outline = 0.02
  ): void {
    const key = SHOVE_PREVIEW_KEY
    switch (shape.kind) {
      case 'capsule':
        batch.addCapsule(
          key,
          this.sx(shape.x0),
          shape.y0,
          this.sx(shape.x1),
          shape.y1,
          shape.halfWidth + grow,
          color,
          1,
          PREVIEW_Z
        )
        return
      case 'circle': {
        const r = shape.r + grow
        batch.addRoundRect(key, this.sx(shape.cx), shape.cy, r, r, r, 0, color, 1, PREVIEW_Z)
        return
      }
      case 'rrect':
        batch.addRoundRect(
          key,
          this.sx(shape.cx),
          shape.cy,
          shape.halfW + grow,
          shape.halfH + grow,
          shape.cornerR + grow,
          this.flipped ? -shape.rotation : shape.rotation,
          color,
          1,
          PREVIEW_Z
        )
        return
      case 'arc': {
        const pts = sampleArc(shape.x0, shape.y0, shape.mx, shape.my, shape.x1, shape.y1, 16)
        for (let i = 0; i < pts.length - 1; i++)
          this.addPreviewShape(
            batch,
            {
              kind: 'capsule',
              x0: pts[i].x,
              y0: pts[i].y,
              x1: pts[i + 1].x,
              y1: pts[i + 1].y,
              halfWidth: shape.halfWidth
            },
            grow,
            color
          )
        return
      }
      case 'poly':
        for (const ring of shape.rings)
          for (let i = 0; i < ring.length; i++) {
            const a = ring[i]
            const b = ring[(i + 1) % ring.length]
            this.addPreviewShape(
              batch,
              { kind: 'capsule', x0: a.x, y0: a.y, x1: b.x, y1: b.y, halfWidth: 0 },
              grow > 0 ? grow : outline,
              color
            )
          }
        return
      case 'compound':
        for (const part of shape.parts) this.addPreviewShape(batch, part, grow, color, outline)
    }
  }

  /** What `setClearanceOutlines` was last given, per set: drawn again after every rebuild. */
  private clearanceOutlines: Record<ClearanceOutlineSet, readonly LayerClearanceOutline[]> = {
    board: [],
    selected: []
  }

  /**
   * The clearance outlines of copper (`lib/board/clearanceOutlines.ts`):
   * hairlines in their layer's color on that layer, dimmed with it. The board's
   * set changes with the active layer and the display settings; the selection's
   * with every click, and redrawing it leaves the board's alone.
   */
  public setClearanceOutlines(
    outlines: readonly LayerClearanceOutline[],
    set: ClearanceOutlineSet = 'board'
  ): void {
    // Redrawing the same list mid-drag would drop the drag's offset.
    if (outlines === this.clearanceOutlines[set]) return
    this.clearanceOutlines[set] = outlines
    this.drawClearanceOutlines(set)
    // Redrawn mid-drag, the moving outlines start over from their board position.
    if (this.drag) {
      const moving = outlineKey(set, true)
      this.batch.saveOrigins([moving])
      this.batch.translateElement(moving, this.drag.delta.x, this.drag.delta.y)
    }
  }

  private drawClearanceOutlines(set: ClearanceOutlineSet): void {
    this.batch.removeElement(outlineKey(set, false))
    this.batch.removeElement(outlineKey(set, true))
    for (const { layer, net, outline: o, moving } of this.clearanceOutlines[set]) {
      const key = outlineKey(set, moving === true)
      // Under routing focus an outline fades with its copper.
      this.setItemNet(net)
      const color = this.getLayerColor(layer)
      const alpha = BoardScene.sketchSign(true, this.getLayerAlpha(layer))
      const z = this.getLayerZ(layer, 'marker')
      if (o.kind === 'rrect') {
        this.addRoundRectW(
          key,
          o.cx,
          o.cy,
          o.halfW,
          o.halfH,
          o.cornerR,
          o.rotation,
          color,
          alpha,
          z
        )
      } else if (o.kind === 'capsule') {
        this.addCapsuleW(key, o.x0, o.y0, o.x1, o.y1, o.halfWidth, color, alpha, z)
      } else if (o.kind === 'arc') {
        this.addThreePointArc(
          key,
          { x: o.x0, y: o.y0 },
          { x: o.mx, y: o.my },
          { x: o.x1, y: o.y1 },
          o.halfWidth,
          layer,
          { alpha, z }
        )
      } else {
        // Solid, not sketched: a capsule of no width draws at the batch's
        // 1 px minimum stroke, the sketch band's width.
        for (const ring of o.rings)
          for (let i = 0; i < ring.length; i++) {
            const a = ring[i]
            const b = ring[(i + 1) % ring.length]
            this.addCapsuleW(key, a.x, a.y, b.x, b.y, 0, color, -alpha, z)
          }
      }
    }
    this.setItemNet(undefined)
  }

  /**
   * The clearance a route or drag in progress keeps, outlined round its
   * tracks and vias as KiCad's router shows it — one merged outline
   * (`previewClearanceRings`), drawn as hairlines: `which` keeps the route's
   * and the drag's apart, since each clears only its own. Empty clears it.
   */
  public setPreviewClearance(
    which: 'route' | 'drag',
    rings: ReadonlyArray<ReadonlyArray<{ x: number; y: number }>>
  ): void {
    this.setItemMeta()
    const key = which === 'route' ? ROUTE_CLEARANCE_KEY : DRAG_CLEARANCE_KEY
    this.batch.removeElement(key)
    const z = layerZ(PREVIEW_SLOT, 'marker')
    // Solid, not sketched: a capsule of no width draws at the 1 px minimum stroke.
    const alpha = -BoardScene.sketchSign(true, 0.9)
    for (const ring of rings)
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i]
        const b = ring[(i + 1) % ring.length]
        this.addCapsuleW(key, a.x, a.y, b.x, b.y, 0, this.ratsnestColor, alpha, z)
      }
  }

  /**
   * Ghost of the shape a graphics tool would place — capsule segments, rings
   * and three-point arcs in data-scene coordinates (y up), drawn at the route
   * preview's translucency on the target layer's color. Pass null to clear.
   */
  public setDraftPreview(
    primitives: {
      segments: Array<{ start: { x: number; y: number }; end: { x: number; y: number } }>
      rings: Array<{ center: { x: number; y: number }; radius: number }>
      arcs: Array<{
        start: { x: number; y: number }
        mid: { x: number; y: number }
        end: { x: number; y: number }
      }>
    } | null,
    width: number,
    layer: string
  ): void {
    this.setItemMeta() // a preview: the live action is never toned (`uTone`)
    this.batch.removeElement(DRAFT_PREVIEW_KEY)
    if (!primitives) return
    const color = this.getLayerColor(layer)
    const z = PREVIEW_Z
    const halfW = width / 2
    for (const s of primitives.segments) {
      this.addCapsuleW(
        DRAFT_PREVIEW_KEY,
        s.start.x,
        s.start.y,
        s.end.x,
        s.end.y,
        halfW,
        color,
        0.55,
        z
      )
    }
    for (const r of primitives.rings) {
      this.addRingW(DRAFT_PREVIEW_KEY, r.center.x, r.center.y, r.radius, halfW, color, 0.55, z)
    }
    for (const a of primitives.arcs) {
      this.addThreePointArc(DRAFT_PREVIEW_KEY, a.start, a.mid, a.end, halfW, layer, {
        alpha: 0.55,
        z
      })
    }
  }

  /** Keys of currently selected elements; deferred fill meshes consult it */
  private selectedFillKeys = new Set<string>()

  /** The selection last highlighted, so a preview that ends can restore its glow. */
  private highlighted: BoardItemRef[] = []

  public highlightSelection(selectedItems: BoardItemRef[]): void {
    this.highlighted = selectedItems
    // A held footprint draws as a selected one does: in the band, color-shifted;
    // a tuning pattern as its tracks (T4).
    const board = this.currentBoard
    const tracks =
      board && selectedItems.some((r) => r.type === 'tuning_pattern')
        ? selectedItems.flatMap((r) => {
            const pattern = r.type === 'tuning_pattern' ? board.tuningPatterns[r.index] : undefined
            return pattern ? patternMembers(board, pattern) : []
          })
        : []
    const shown = [...selectedItems, ...tracks, ...(this.ghost ? [GHOST_REF] : [])]
    this.selectedFillKeys = new Set(shown.map(boardRefKey))
    // Fills take the selection in the lift (`paintFill`); strokes by their colors.
    this.liftSelection(this.selectedFillKeys)
    this.batch.resetColors()
    for (const ref of shown) this.batch.shiftElementColors(boardRefKey(ref), this.selectionShift())
  }

  /**
   * Draw exactly the selected elements in the selected band (layers.ts
   * `LIFTED_SLOT_OFFSET`), in front of everything unselected: their strokes
   * and labels move up a band (`LayeredBatch.liftElements`), and so do the
   * fills their anchors hold.
   */
  private liftSelection(keys: ReadonlySet<string>): void {
    this.batch.liftElements(keys)
    for (const labels of this.labelBatches) labels.liftElements(keys)
    for (const [key, anchor] of Object.entries(this.elements)) {
      const selected = keys.has(key)
      anchor.traverse((object) => {
        if (!(object instanceof THREE.Mesh) || !object.userData.paintLane) return
        const moved = liftFillMesh(object, selected, this.paint)
        if (!moved && object.userData.selected === selected) return
        object.userData.selected = selected
        this.paintFill(object)
      })
    }
  }

  /** The diff paint's color rule, kept for fills that land after it (`buildFillMesh`). */
  private diffTone: ((key: string, color: THREE.Color) => THREE.Color | null) | null = null

  /** The diff paint over one item's fills and zone hatches, under `root`: their own colors toned. */
  private toneFills(key: string, root: THREE.Object3D): void {
    const tone = this.diffTone
    if (!tone) return
    root.traverse((object) => {
      const base = object.userData.defaultColor as THREE.Color | undefined
      if (!(object instanceof THREE.Mesh) || !base) return
      const next = tone(key, base)
      if (!next) return
      object.userData.defaultColor = next.clone()
      this.paintFill(object)
    })
  }

  /**
   * The visual diff's paint, over the built scene: items in `changed` keep
   * their colors, items in `removed` turn the error red, and everything else
   * goes gray — hue gone, halfway to the canvas, as the schematic diff dims —
   * so only the changes carry color. A key is painted by its item's entry
   * (`footprint:3` for `footprint:3/pad:0`). Written as default colors, so it
   * lasts until the next rebuild.
   */
  public applyDiffPaint(paint: BoardDiffPaint): void {
    const statusOf = (key: string): 'changed' | 'removed' | 'unchanged' => {
      const item = key.split('/', 1)[0]
      if (paint.changed.has(item)) return 'changed'
      if (paint.removed.has(item)) return 'removed'
      return 'unchanged'
    }
    const red = new THREE.Color(themeColor('--vscode-error', '#f48771'))
    const gray = new THREE.Color()
    const hsl = { h: 0, s: 0, l: 0 }
    const tone = (key: string, color: THREE.Color): THREE.Color | null => {
      const status = statusOf(key)
      if (status === 'changed') return null
      if (status === 'removed') return red
      color.getHSL(hsl)
      return gray.setHSL(hsl.h, 0, hsl.l).lerp(this.background, 0.5)
    }
    this.batch.repaintElements(tone)
    this.diffTone = tone
    for (const [key, anchor] of Object.entries(this.elements)) this.toneFills(key, anchor)
    // A removed part's pad numbers would read as still there.
    for (const key of paint.removed)
      for (const labels of this.labelBatches) labels.setElementHidden(key, true)
  }

  private selectionShift(): number {
    return selectionShift(this.selectionLighten)
  }

  /** World-space bounds of what these items paint, for zoom to selection. */
  public selectionBounds(items: BoardItemRef[]): THREE.Box3 {
    const bounds = new THREE.Box3()
    for (const { type, index } of items) {
      const key = `${type}:${index}`
      this.batch.elementBounds(key, bounds)
      const obj = this.elements[key]
      if (obj) bounds.expandByObject(obj)
    }
    return bounds
  }

  /** Hold `footprint` (placed at the origin) as the ghost, or drop it with null. */
  public setFootprintGhost(footprint: KicadBoardFootprint | null): void {
    this.removeFootprintGhost()
    this.ghost = footprint ? { footprint, delta: { x: 0, y: 0 } } : null
    this.drawFootprintGhost()
    this.highlightSelection(this.highlighted)
  }

  /** Carry the ghost to `delta` (scene mm) from where it was drawn. */
  public moveFootprintGhost(delta: { x: number; y: number }): void {
    if (!this.ghost) return
    this.ghost.delta = delta
    const key = GHOST_KEY
    this.batch.translateElement(key, delta.x, delta.y)
    for (const labels of this.labelBatches) labels.translateElement(key, delta.x, delta.y)
    const anchor = this.elements[key]
    const origin = anchor?.userData._dragOrigin as { x: number; y: number } | undefined
    if (anchor && origin) {
      anchor.position.x = origin.x + delta.x
      anchor.position.y = origin.y + delta.y
    }
  }

  private drawFootprintGhost(): void {
    if (!this.ghost) return
    this.renderFootprint(this.ghost.footprint, GHOST_REF.index)
    delete this.footprintExtents[GHOST_REF.index]
    this.footprintBoxes.delete(GHOST_REF.index)
    delete this.footprintTextHits[GHOST_REF.index]
    const anchor = this.elements[GHOST_KEY]
    if (anchor) anchor.userData._dragOrigin = { x: anchor.position.x, y: anchor.position.y }
    this.batch.saveOrigins([GHOST_KEY])
    for (const labels of this.labelBatches) labels.saveOrigins([GHOST_KEY])
    this.moveFootprintGhost(this.ghost.delta)
  }

  private removeFootprintGhost(): void {
    this.batch.removeElement(GHOST_KEY)
    for (const labels of this.labelBatches) labels.removeElement(GHOST_KEY)
    const anchor = this.elements[GHOST_KEY]
    if (!anchor) return
    anchor.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose()
        const materials = Array.isArray(obj.material) ? obj.material : [obj.material]
        materials.forEach((m) => m?.dispose())
      }
    })
    this.fillGroup.remove(anchor)
    delete this.elements[GHOST_KEY]
  }

  /** What a drag carries and how far, so an edit mid-drag can put it back (`resumeDrag`). */
  private drag: { items: BoardItemRef[]; delta: { x: number; y: number } } | null = null

  /** The drag's copper back at its start, its offset kept for `resumeDrag`. */
  private parkDrag(): void {
    if (!this.drag) return
    const { items, delta } = this.drag
    this.translateElements(items, { x: 0, y: 0 })
    this.drag = { items, delta }
  }

  /**
   * After a redraw mid-drag — a rebuild, or an edit patched in — the drag's
   * copper sits at its board position with no start recorded: record it and
   * move it by the drag's offset again. Call after `highlightSelection`, which
   * moves the selection's instances into the selected band.
   */
  public resumeDrag(): void {
    if (!this.drag) return
    const { items, delta } = this.drag
    this.saveDragOrigins(items)
    this.translateElements(items, delta)
  }

  public saveDragOrigins(items: BoardItemRef[]): void {
    this.drag = { items, delta: { x: 0, y: 0 } }
    const keys: string[] = []
    for (const ref of items) {
      const key = boardRefKey(ref)
      keys.push(key)
      const obj = this.elements[key]
      if (obj) {
        obj.userData._dragOrigin = { x: obj.position.x, y: obj.position.y }
      }
    }
    this.batch.saveOrigins([...keys, MOVING_CLEARANCE_KEY])
    for (const labels of this.labelBatches) labels.saveOrigins(keys)
  }

  public clearDragOrigins(): void {
    this.drag = null
    this.batch.clearOrigins()
    for (const labels of this.labelBatches) labels.clearOrigins()
    for (const obj of Object.values(this.elements)) {
      delete obj.userData._dragOrigin
    }
  }

  public translateElements(items: BoardItemRef[], delta: { x: number; y: number }): void {
    if (this.drag) this.drag.delta = delta
    this.batch.translateElement(MOVING_CLEARANCE_KEY, delta.x, delta.y)
    for (const ref of items) {
      const key = boardRefKey(ref)
      this.batch.translateElement(key, delta.x, delta.y)
      for (const labels of this.labelBatches) labels.translateElement(key, delta.x, delta.y)

      const obj = this.elements[key]
      if (!obj || !obj.userData._dragOrigin) continue
      obj.position.x = obj.userData._dragOrigin.x + delta.x
      obj.position.y = obj.userData._dragOrigin.y + delta.y
    }
  }

  // ---------------------------------------------------------------------------
  // Hit testing (analytic; the batch mesh opts out of raycasting)
  // ---------------------------------------------------------------------------

  /**
   * Where a move can grab these items (KiCad's `computeAnchors(aFrom)`; pads
   * promoted to their footprints): a footprint's origin and pad centers, a track's ends and middle, a drawing's
   * corners and centers. World space.
   */
  public moveAnchors(refs: readonly BoardItemRef[]): THREE.Vector2[] {
    return refs.flatMap((ref) => this.itemAnchors(ref))
  }

  /**
   * What a move snaps to, as KiCad's board defaults have it (magnetic
   * graphics on, pads and tracks only while routing): footprint origins, zone
   * corners, drawings and points on the active layer, the moved items aside.
   */
  public snapTargets(moved: readonly BoardItemRef[]): THREE.Vector2[] {
    const board = this.currentBoard
    if (!board) return []
    const skip = new Set(moved.map(boardRefKey))
    const targets: THREE.Vector2[] = []
    const add = (type: string, index: number, layers: readonly string[]): void => {
      if (!skip.has(boardRefKey({ type, index })) && layers.some((l) => this.isTargetLayer(l)))
        targets.push(...this.itemAnchors({ type, index }))
    }
    board.footprints.forEach((fp, index) => {
      if (this.isFootprintSelectable(fp)) add('footprint', index, this.footprintLayers(fp))
    })
    board.zones.forEach((zone, index) => add('zone', index, zone.layers))
    for (const [type, items] of [
      ['gr_line', board.grLines],
      ['gr_arc', board.grArcs],
      ['gr_circle', board.grCircles],
      ['gr_rect', board.grRects],
      ['gr_poly', board.grPolys]
    ] as const)
      items.forEach((item, index) => add(type, index, item.layer ? [item.layer] : []))
    board.points.forEach((point, index) => add('point', index, point.layer ? [point.layer] : []))
    return targets
  }

  private isTargetLayer(layer: string): boolean {
    return this.layerMatchesActive(layer) && this.isLayerSelectable(layer)
  }

  /** One item's grab anchors, world space; none for what it does not hold. */
  private itemAnchors(ref: BoardItemRef): THREE.Vector2[] {
    const board = this.currentBoard
    if (!board) return []
    const world = (p: AnchorPoint): THREE.Vector2 =>
      new THREE.Vector2(this.sx(p.x / NM_PER_MM), -p.y / NM_PER_MM)
    if (ref.type === 'footprint') {
      const fp = board.footprints[ref.index]
      if (!fp) return []
      const tf = this.makeTransform(fp)
      const pads = fp.footprint.pads.map((pad) => {
        const at = this.tfPoint(tf, pad.position.x, pad.position.y)
        return new THREE.Vector2(this.sx(at.x), at.y)
      })
      return [world(fp.position), ...pads]
    }
    const points = ((): AnchorPoint[] => {
      switch (ref.type) {
        case 'segment':
          return board.segments[ref.index] ? lineAnchors(board.segments[ref.index]) : []
        case 'tarc':
          return board.trackArcs[ref.index] ? arcAnchors(board.trackArcs[ref.index], false) : []
        case 'via':
          return board.vias[ref.index] ? [board.vias[ref.index].position] : []
        case 'gr_line':
          return board.grLines[ref.index] ? lineAnchors(board.grLines[ref.index]) : []
        case 'gr_arc':
          return board.grArcs[ref.index] ? arcAnchors(board.grArcs[ref.index]) : []
        case 'gr_circle':
          return board.grCircles[ref.index] ? circleAnchors(board.grCircles[ref.index]) : []
        case 'gr_rect':
          return board.grRects[ref.index] ? rectAnchors(board.grRects[ref.index]) : []
        case 'gr_poly':
          return board.grPolys[ref.index] ? polyAnchors(board.grPolys[ref.index]) : []
        case 'zone':
          return board.zones[ref.index]?.points ?? []
        case 'gr_text': {
          const position = board.grTexts[ref.index]?.position
          return position ? [position] : []
        }
      }
      const extra = BoardScene.extraCollections(board).find(([type]) => type === ref.type)?.[1][
        ref.index
      ]
      return extra ? [extraGraphicPivot(extra)] : []
    })()
    return points.map(world)
  }

  /** The best thing under the cursor, ignoring any selection policy. */
  public hitTest(worldPoint: THREE.Vector2, threshold: number): BoardItemRef | null {
    return this.hitCandidates(worldPoint, threshold)[0]?.levels[0]?.ref ?? null
  }

  /**
   * Everything under the cursor, best first — what an editor's selection policy
   * resolves against (`resolveHit`, lib/selectionResolve.ts).
   *
   * Returning the whole ranked list rather than only the winner is what lets a
   * filtered-out kind fall through to what sits behind it. With only a winner,
   * switching Footprints off would make a click on a footprint select nothing
   * instead of the track beneath it.
   *
   * Pads are the board's one nested level: a click on a pad yields a
   * `[pad, footprint]` candidate (the schematic's field-inside-symbol shape),
   * so editors that allow pads get the pad and everyone else walks up to the
   * footprint at pad-outline precision. Everything else carries one level.
   */
  public hitCandidates(
    worldPoint: THREE.Vector2,
    threshold: number
  ): Array<HitCandidate<BoardItemRef>> {
    const board = this.currentBoard
    if (!board) return []

    // All comparisons below are in data-scene space; mirror the world-space
    // click once when the view is flipped
    const point = this.flipped ? new THREE.Vector2(-worldPoint.x, worldPoint.y) : worldPoint

    const found: RankedBoardHit[] = []
    // `above` is where its layer paints in the live view.
    const registerHit = (
      type: string,
      index: number,
      dist: number,
      above = 0,
      locked = false,
      kind = boardItemKind(type)
    ): void => {
      if (dist >= threshold) return
      found.push({
        hit: { type, index },
        kind,
        locked,
        dist,
        above,
        rank: BOARD_TYPE_RANK[type] ?? Number.MAX_SAFE_INTEGER,
        order: found.length
      })
    }

    // 1. Vias (small, always on top)
    board.vias.forEach((via, index) => {
      if (!this.isViaSelectable(via)) return
      const d = Math.hypot(point.x - nmToMm(via.position.x), point.y - -nmToMm(via.position.y))
      registerHit(
        'via',
        index,
        Math.max(0, d - nmToMm(via.size) / 2),
        this.paintRankOf(VIA_PSEUDO_LAYER),
        via.locked
      )
    })

    // 2. Track segments
    board.segments.forEach((seg, index) => {
      if (!this.isLayerSelectable(seg.layer)) return
      const d = distToSegment(
        point,
        new THREE.Vector2(nmToMm(seg.start.x), -nmToMm(seg.start.y)),
        new THREE.Vector2(nmToMm(seg.end.x), -nmToMm(seg.end.y))
      )
      registerHit(
        'segment',
        index,
        Math.max(0, d - nmToMm(seg.width) / 2),
        this.paintRankOf(seg.layer),
        seg.locked
      )
    })

    // 3. Track arcs (sampled)
    board.trackArcs.forEach((arc, index) => {
      if (!this.isLayerSelectable(arc.layer)) return
      const d = distToThreePointArc(
        point,
        { x: nmToMm(arc.start.x), y: -nmToMm(arc.start.y) },
        { x: nmToMm(arc.mid.x), y: -nmToMm(arc.mid.y) },
        { x: nmToMm(arc.end.x), y: -nmToMm(arc.end.y) }
      )
      registerHit(
        'tarc',
        index,
        Math.max(0, d - nmToMm(arc.width) / 2),
        this.paintRankOf(arc.layer),
        arc.locked
      )
    })

    // 4. Board graphics
    board.grLines.forEach((line, index) => {
      if (!this.isLayerSelectable(line.layer)) return
      const d = distToSegment(
        point,
        new THREE.Vector2(nmToMm(line.start.x), -nmToMm(line.start.y)),
        new THREE.Vector2(nmToMm(line.end.x), -nmToMm(line.end.y))
      )
      registerHit(
        'gr_line',
        index,
        Math.max(0, d - (line.strokeWidth !== undefined ? nmToMm(line.strokeWidth) : 0.1) / 2),
        this.paintRankOf(line.layer),
        line.locked
      )
    })

    board.grArcs.forEach((arc, index) => {
      if (!this.isLayerSelectable(arc.layer)) return
      const d = distToThreePointArc(
        point,
        { x: nmToMm(arc.start.x), y: -nmToMm(arc.start.y) },
        { x: nmToMm(arc.mid.x), y: -nmToMm(arc.mid.y) },
        { x: nmToMm(arc.end.x), y: -nmToMm(arc.end.y) }
      )
      registerHit(
        'gr_arc',
        index,
        Math.max(0, d - (arc.strokeWidth !== undefined ? nmToMm(arc.strokeWidth) : 0.1) / 2),
        this.paintRankOf(arc.layer),
        arc.locked
      )
    })

    board.grCircles.forEach((circle, index) => {
      if (!this.isLayerSelectable(circle.layer)) return
      const center = new THREE.Vector2(nmToMm(circle.center.x), -nmToMm(circle.center.y))
      const r =
        Math.hypot(circle.end.x - circle.center.x, circle.end.y - circle.center.y) / NM_PER_MM
      const d = Math.abs(point.distanceTo(center) - r)
      registerHit(
        'gr_circle',
        index,
        Math.max(0, d - (circle.strokeWidth !== undefined ? nmToMm(circle.strokeWidth) : 0.1) / 2),
        this.paintRankOf(circle.layer),
        circle.locked
      )
    })

    board.grRects.forEach((rect, index) => {
      if (!this.isLayerSelectable(rect.layer)) return
      const xMin = Math.min(rect.start.x, rect.end.x) / NM_PER_MM
      const xMax = Math.max(rect.start.x, rect.end.x) / NM_PER_MM
      const yMin = Math.min(-rect.start.y, -rect.end.y) / NM_PER_MM
      const yMax = Math.max(-rect.start.y, -rect.end.y) / NM_PER_MM
      const corners = [
        new THREE.Vector2(xMin, yMin),
        new THREE.Vector2(xMax, yMin),
        new THREE.Vector2(xMax, yMax),
        new THREE.Vector2(xMin, yMax)
      ]
      let d = Infinity
      for (let i = 0; i < 4; i++) {
        d = Math.min(d, distToSegment(point, corners[i], corners[(i + 1) % 4]))
      }
      registerHit(
        'gr_rect',
        index,
        Math.max(0, d - (rect.strokeWidth !== undefined ? nmToMm(rect.strokeWidth) : 0.1) / 2),
        this.paintRankOf(rect.layer),
        rect.locked
      )
    })

    board.grPolys.forEach((poly, index) => {
      if (!this.isLayerSelectable(poly.layer) || poly.points.length < 2) return
      const pts = poly.points.map((p) => new THREE.Vector2(nmToMm(p.x), -nmToMm(p.y)))
      let d = Infinity
      for (let i = 0; i < pts.length; i++) {
        d = Math.min(d, distToSegment(point, pts[i], pts[(i + 1) % pts.length]))
      }
      if (poly.fill && poly.fill !== 'none' && pts.length >= 3 && pointInPolygon(point, pts)) {
        d = 0
      }
      registerHit(
        'gr_poly',
        index,
        Math.max(0, d - (poly.strokeWidth !== undefined ? nmToMm(poly.strokeWidth) : 0.1) / 2),
        this.paintRankOf(poly.layer),
        poly.locked
      )
    })

    board.grTexts.forEach((text, index) => {
      if (!text.position || text.hide || !this.isLayerSelectable(text.layer)) return
      const d = distToTextBox(
        point,
        text.text,
        { x: nmToMm(text.position.x), y: -nmToMm(text.position.y) },
        text.position.angle,
        text.fontEffects
      )
      if (d !== null) {
        registerHit('gr_text', index, d, this.paintRankOf(text.layer), text.locked)
      }
    })

    // Béziers, points, text boxes and tables: one geometry for paint and click
    for (const [type, items] of BoardScene.extraCollections(board)) {
      items.forEach((item, index) => {
        if (!this.isLayerSelectable(item.layer)) return
        registerHit(
          type,
          index,
          extraGraphicDistance(item, point, BoardScene.boardSpace, 1 / NM_PER_MM),
          this.paintRankOf(item.layer),
          item.locked
        )
      })
    }

    // 5. Zone outlines (interior clicks intentionally fall through so parts
    //    under a copper pour stay selectable)
    // A teardrop is its pad's or via's setting; its zone is never picked (KiCad).
    const teardropsPick = hasLegacyTeardrops(board)
    board.zones.forEach((zone, index) => {
      if (!teardropsPick && isTeardropZone(zone)) return
      const anyVisible =
        zone.layers.some((l) => this.isLayerSelectable(l)) ||
        zone.filledPolys.some((f) => this.isLayerSelectable(f.layer))
      if (!anyVisible || zone.points.length < 3) return
      const pts = zone.points.map((p) => new THREE.Vector2(nmToMm(p.x), -nmToMm(p.y)))
      let d = Infinity
      for (let i = 0; i < pts.length; i++) {
        d = Math.min(d, distToSegment(point, pts[i], pts[(i + 1) % pts.length]))
      }
      // Zones sharing an edge tie on distance: the one drawn on top wins, as
      // everywhere else — its highest selectable layer in the live stack, so the
      // active layer's zone over one on a layer beneath it.
      const above = Math.max(
        ...zone.layers
          .flatMap((l) => this.expand(l))
          .filter((l) => this.isLayerSelectable(l))
          .map((l) => this.paintRankOf(l)),
        0
      )
      registerHit('zone', index, d, above, zone.locked, boardItemKind('zone', zone.isKeepout))
    })

    // 6. Footprints last: their bbox interior counts as distance 0, so any
    //    smaller element within the threshold wins the tie (strict <)
    board.footprints.forEach((_, index) => {
      const b = this.footprintBoundsAt(index)
      if (!b) return
      const fp = board.footprints[index]
      if (!this.isFootprintSelectable(fp)) return
      const dx = Math.max(b.minX - point.x, point.x - b.maxX, 0)
      const dy = Math.max(b.minY - point.y, point.y - b.maxY, 0)
      const fpDist = Math.hypot(dx, dy)
      registerHit('footprint', index, fpDist, 0, fp.footprint.locked)

      // Pads, as an inner level: [pad, footprint]. Editors that allow pads
      // resolve to the pad; today's editors walk up to the footprint at
      // pad-outline precision instead of bbox precision (selectionResolve).
      // Children are tested within the footprint's reach — its box widened by
      // its texts — so a text moved clear of the part stays clickable.
      const r = this.footprintReachAt(index) ?? b
      const reachDist = Math.hypot(
        Math.max(r.minX - point.x, point.x - r.maxX, 0),
        Math.max(r.minY - point.y, point.y - r.maxY, 0)
      )
      if (reachDist < threshold) {
        const outer: RankedBoardHit['outer'] = {
          kind: 'footprint',
          locked: fp.footprint.locked,
          ref: { type: 'footprint', index }
        }
        const tf = this.makeTransform(fp)
        const firstChild = found.length
        fp.footprint.pads.forEach((pad, padIndex) => {
          if (!pad.layers.some((l) => this.isLayerSelectable(l))) return
          const center = this.tfPoint(tf, pad.position.x, pad.position.y)
          const d = distToPadOutline(point, pad, center)
          if (d >= threshold) return
          found.push({
            hit: { type: 'pad', index, pad: padIndex },
            kind: boardItemKind('pad'),
            // KiCad lets a single pad of a locked footprint be clicked with the
            // Locked switch off: "a lot of operations require this"
            // (`itemPassesFilter`). A band never takes pads, so this is the one case.
            locked: false,
            dist: d,
            above: 0,
            rank: BOARD_TYPE_RANK.pad,
            order: found.length,
            outer
          })
        })

        // Fields and texts, as inner levels too: [text, footprint]. KiCad lets
        // a click land on a visible one whose switch is on, and nothing else
        // inside a footprint but pads (`PCB_SELECTION_TOOL::Selectable`); the
        // drawn ones are recorded with their glyph boxes as they are drawn.
        for (const t of this.footprintTextHits[index] ?? []) {
          if (!this.isLayerSelectable(t.layer)) continue
          const dx = point.x - t.x
          const dy = point.y - t.y
          const lx = dx * Math.cos(-t.angle) - dy * Math.sin(-t.angle)
          const ly = dx * Math.sin(-t.angle) + dy * Math.cos(-t.angle)
          const d = Math.hypot(
            Math.max(t.box.xMin - lx, lx - t.box.xMax, 0),
            Math.max(t.box.yMin - ly, ly - t.box.yMax, 0)
          )
          if (d >= threshold) continue
          found.push({
            hit: { type: t.type, index, child: t.child },
            kind: boardItemKind(t.type),
            locked: t.locked || fp.footprint.locked,
            dist: d,
            above: this.paintRankOf(t.layer),
            rank: BOARD_TYPE_RANK[t.type],
            order: found.length,
            outer
          })
        }
        // A pad or text the pointer is near wins over its own footprint, as in
        // KiCad: the footprint's box is "distance 0" anywhere inside it, which
        // would otherwise beat a pad or text a hair off its outline. The
        // footprint stays a candidate, ranked just behind its nearest child, so
        // Select Other still lists it.
        const children = found.slice(firstChild)
        if (children.length) {
          const own = found.find((h) => h.hit.type === 'footprint' && h.hit.index === index)
          if (own) own.dist = Math.max(own.dist, Math.min(...children.map((h) => h.dist)))
        }
      }
    })

    // A tuning pattern's track is not picked alone: the pattern is (T4), as KiCad's.
    const patterns = this.patternMembership(board)
    const seen = new Set<string>()
    return rankBoardHits(found).flatMap(({ hit, kind, locked, outer }) => {
      const pattern = patterns.get(boardRefKey(hit))
      const ref = pattern === undefined ? hit : { type: 'tuning_pattern', index: pattern }
      const key = boardRefKey(ref)
      if (seen.has(key)) return []
      seen.add(key)
      return [{ levels: outer ? [{ kind, locked, ref }, outer] : [{ kind, locked, ref }] }]
    })
  }

  private patternCache: { board: KicadBoard; members: Map<string, number> } | null = null

  /** Each tuning pattern's tracks, by their keys, to the pattern (router-behavior.md T4). */
  private patternMembership(board: KicadBoard): Map<string, number> {
    if (this.patternCache?.board !== board)
      this.patternCache = { board, members: patternMembership(board) }
    return this.patternCache.members
  }

  /**
   * Everything a rubber band takes — the same collections `hitCandidates`
   * walks, under the same layer-visibility rules, tested as boxes rather than
   * distances. `crossing` is the industry split every tool draws: a band that
   * *touches* an item versus one that *contains* it.
   *
   * **Pads are deliberately absent**, for the reason the schematic's band never
   * takes fields (`SchematicScene.boxSelect`): a band over a footprint covers
   * its pads too, and taking both would move each pad twice on the next drag —
   * once carried by the footprint, once on its own. A pad is something you
   * reach for individually, which is what clicking is for.
   */
  public boxSelect(
    bounds: { xMin: number; xMax: number; yMin: number; yMax: number },
    crossing: boolean
  ): BoardItemRef[] {
    const board = this.currentBoard
    if (!board) return []
    const refs = boardBoxSelect(board, bounds, crossing, {
      flipped: this.flipped,
      isLayerVisible: (layer) => this.isLayerSelectable(layer),
      isViaVisible: (via) => this.isViaSelectable(via),
      isFootprintSelectable: (index) => {
        const fp = board.footprints[index]
        return !!fp && this.isFootprintSelectable(fp)
      },
      footprintBounds: (index) => this.footprintBoundsAt(index)
    })
    // A band over a tuning pattern's tracks takes the pattern (T4).
    const patterns = this.patternMembership(board)
    if (patterns.size === 0) return refs
    const seen = new Set<string>()
    return refs.flatMap((ref) => {
      const pattern = patterns.get(boardRefKey(ref))
      const taken = pattern === undefined ? ref : { type: 'tuning_pattern', index: pattern }
      const key = boardRefKey(taken)
      if (seen.has(key)) return []
      seen.add(key)
      return [taken]
    })
  }

  /**
   * `boxSelect`'s items as candidates, each with the kind and lock state the
   * selection filter asks about — the band's answer in the shape a click's is
   * (`hitCandidates`), so both resolve through the same policy.
   */
  public boxCandidates(
    bounds: { xMin: number; xMax: number; yMin: number; yMax: number },
    crossing: boolean
  ): Array<HitCandidate<BoardItemRef>> {
    const board = this.currentBoard
    if (!board) return []
    return this.boxSelect(bounds, crossing).map((ref) => ({
      levels: [
        {
          kind: boardItemKind(ref.type, ref.type === 'zone' && !!board.zones[ref.index]?.isKeepout),
          locked: boardItemLocked(board, ref),
          ref
        }
      ]
    }))
  }

  /** DATA-space AABB of a placed footprint (valid after rebuild): `sx` mirrors
   *  x at draw time, so a world-space caller mirrors these itself. */
  public getFootprintBounds(index: number): Bounds2D | undefined {
    return this.footprintBoundsAt(index)
  }
}

/** What `boardBoxSelect` needs from a live scene. */
export interface BoardBoxSelectContext {
  /** The view is mirrored (viewing from the back). */
  flipped: boolean
  isLayerVisible: (layer: string | undefined) => boolean
  /** Whether a via answers, over every layer it passes through; its end layers when absent. */
  isViaVisible?: (via: KicadVia) => boolean
  /** Whether a footprint answers in this view, as a click asks (`isFootprintSelectable`). */
  isFootprintSelectable: (index: number) => boolean
  /** Scene-space AABB of a placed footprint, as the scene measured it. */
  footprintBounds: (index: number) => Bounds2D | undefined
}

/**
 * The band test itself, split out of the method because `BoardScene` cannot be
 * constructed outside a DOM (it rasterizes glyphs) and this is the part worth
 * testing — the same reason `rankBoardHits` and `boardItemKind` are exported.
 */
export function boardBoxSelect(
  board: KicadBoard,
  bounds: { xMin: number; xMax: number; yMin: number; yMax: number },
  crossing: boolean,
  context: BoardBoxSelectContext
): BoardItemRef[] {
  {
    const { flipped, isLayerVisible, isFootprintSelectable, footprintBounds } = context
    const isViaVisible =
      context.isViaVisible ?? ((via: KicadVia) => via.layers.some((l) => isLayerVisible(l)))
    // Comparisons run in data-scene space, so mirror the world-space band once
    // when the view is flipped — swapping the x bounds, since negation reverses
    // which is the minimum (hitCandidates mirrors its point the same way).
    const box = new THREE.Box2(
      new THREE.Vector2(flipped ? -bounds.xMax : bounds.xMin, Math.min(bounds.yMin, bounds.yMax)),
      new THREE.Vector2(flipped ? -bounds.xMin : bounds.xMax, Math.max(bounds.yMin, bounds.yMax))
    )

    const selected: BoardItemRef[] = []
    const scratch = new THREE.Box2()

    /** Test one item's scene-space AABB, built by expanding `scratch`. */
    const take = (type: string, index: number): void => {
      if (crossing ? box.intersectsBox(scratch) : box.containsBox(scratch)) {
        selected.push({ type, index })
      }
    }

    /** An item's AABB from its points plus half its stroke width. */
    const boxOf = (points: Array<{ x: number; y: number }>, halfWidth = 0): THREE.Box2 => {
      scratch.makeEmpty()
      for (const p of points) scratch.expandByPoint(new THREE.Vector2(p.x, p.y))
      if (halfWidth > 0) scratch.expandByScalar(halfWidth)
      return scratch
    }

    board.vias.forEach((via, index) => {
      if (!isViaVisible(via)) return
      boxOf([{ x: nmToMm(via.position.x), y: -nmToMm(via.position.y) }], nmToMm(via.size) / 2)
      take('via', index)
    })

    board.segments.forEach((seg, index) => {
      if (!isLayerVisible(seg.layer)) return
      boxOf(
        [
          { x: nmToMm(seg.start.x), y: -nmToMm(seg.start.y) },
          { x: nmToMm(seg.end.x), y: -nmToMm(seg.end.y) }
        ],
        nmToMm(seg.width) / 2
      )
      take('segment', index)
    })

    // Arcs are sampled rather than bounded by their three defining points: an
    // arc bulges past them, so the cheap box would under-cover the geometry and
    // an enclosing band would claim an arc it does not actually contain.
    board.trackArcs.forEach((arc, index) => {
      if (!isLayerVisible(arc.layer)) return
      boxOf(
        arcPolyline(
          { x: nmToMm(arc.start.x), y: -nmToMm(arc.start.y) },
          { x: nmToMm(arc.mid.x), y: -nmToMm(arc.mid.y) },
          { x: nmToMm(arc.end.x), y: -nmToMm(arc.end.y) }
        ),
        nmToMm(arc.width) / 2
      )
      take('tarc', index)
    })

    board.grLines.forEach((line, index) => {
      if (!isLayerVisible(line.layer)) return
      boxOf(
        [
          { x: nmToMm(line.start.x), y: -nmToMm(line.start.y) },
          { x: nmToMm(line.end.x), y: -nmToMm(line.end.y) }
        ],
        (line.strokeWidth !== undefined ? nmToMm(line.strokeWidth) : 0.1) / 2
      )
      take('gr_line', index)
    })

    board.grArcs.forEach((arc, index) => {
      if (!isLayerVisible(arc.layer)) return
      boxOf(
        arcPolyline(
          { x: nmToMm(arc.start.x), y: -nmToMm(arc.start.y) },
          { x: nmToMm(arc.mid.x), y: -nmToMm(arc.mid.y) },
          { x: nmToMm(arc.end.x), y: -nmToMm(arc.end.y) }
        ),
        (arc.strokeWidth !== undefined ? nmToMm(arc.strokeWidth) : 0.1) / 2
      )
      take('gr_arc', index)
    })

    board.grCircles.forEach((circle, index) => {
      if (!isLayerVisible(circle.layer)) return
      const r =
        Math.hypot(circle.end.x - circle.center.x, circle.end.y - circle.center.y) / NM_PER_MM
      boxOf(
        [{ x: nmToMm(circle.center.x), y: -nmToMm(circle.center.y) }],
        r + (circle.strokeWidth !== undefined ? nmToMm(circle.strokeWidth) : 0.1) / 2
      )
      take('gr_circle', index)
    })

    board.grRects.forEach((rect, index) => {
      if (!isLayerVisible(rect.layer)) return
      boxOf(
        [
          { x: nmToMm(rect.start.x), y: -nmToMm(rect.start.y) },
          { x: nmToMm(rect.end.x), y: -nmToMm(rect.end.y) }
        ],
        (rect.strokeWidth !== undefined ? nmToMm(rect.strokeWidth) : 0.1) / 2
      )
      take('gr_rect', index)
    })

    board.grPolys.forEach((poly, index) => {
      if (!isLayerVisible(poly.layer) || poly.points.length < 2) return
      boxOf(
        poly.points.map((p) => ({ x: nmToMm(p.x), y: -nmToMm(p.y) })),
        (poly.strokeWidth !== undefined ? nmToMm(poly.strokeWidth) : 0.1) / 2
      )
      take('gr_poly', index)
    })

    board.grTexts.forEach((text, index) => {
      if (!text.position || text.hide || !isLayerVisible(text.layer)) return
      const corners = textBoxCorners(
        text.text,
        { x: nmToMm(text.position.x), y: -nmToMm(text.position.y) },
        text.position.angle,
        text.fontEffects
      )
      if (!corners) return
      boxOf(corners)
      take('gr_text', index)
    })

    for (const [type, items] of BoardScene.extraCollections(board)) {
      items.forEach((item, index) => {
        if (!isLayerVisible(item.layer)) return
        boxOf(extraGraphicExtent(item).map((p) => ({ x: p.x / NM_PER_MM, y: -p.y / NM_PER_MM })))
        take(type, index)
      })
    }

    // The outline, not the pour: a zone's fill can blanket half the board, and
    // a band that took every zone it overlapped would be useless on a board
    // with a ground plane — which is every board.
    const teardropsPick = hasLegacyTeardrops(board)
    board.zones.forEach((zone, index) => {
      if (!teardropsPick && isTeardropZone(zone)) return
      const anyVisible =
        zone.layers.some((l) => isLayerVisible(l)) ||
        zone.filledPolys.some((f) => isLayerVisible(f.layer))
      if (!anyVisible || zone.points.length < 3) return
      boxOf(zone.points.map((p) => ({ x: nmToMm(p.x), y: -nmToMm(p.y) })))
      take('zone', index)
    })

    board.footprints.forEach((_, index) => {
      if (!isFootprintSelectable(index)) return
      const b = footprintBounds(index)
      if (!b) return
      scratch.set(new THREE.Vector2(b.minX, b.minY), new THREE.Vector2(b.maxX, b.maxY))
      take('footprint', index)
    })

    return selected
  }
}

/**
 * Distance from a data-scene point to a pad's outline (0 inside). Every
 * KiCad pad shape resolves to the rotated rounded-rect the renderer draws
 * (`renderPad`'s halfW/halfH/cornerR rules), so this is the exact hit surface
 * of the paint. Custom-pad primitives extend beyond it and are deliberately
 * not included — the anchor pad is the addressable thing.
 */
function distToPadOutline(
  point: THREE.Vector2,
  pad: KicadPad,
  center: { x: number; y: number }
): number {
  // A custom pad is its anchor plus its primitives, so the tab of a SOT-89 is
  // part of the pad you can click. Only that pad pays for the pieces: a plain
  // one is its anchor, and this runs per pad per mouse move.
  if (padHasPrimitives(pad)) {
    const angle = pad.position.angle ? (pad.position.angle * Math.PI) / 180 : 0
    return padPointDistance(padCopperPieces(pad, center, angle), point.x, point.y)
  }
  const halfW = nmToMm(pad.size.w) / 2
  let halfH = nmToMm(pad.size.h) / 2
  let cornerR = 0
  if (pad.shape === 'circle') {
    halfH = halfW
    cornerR = halfW
  } else if (pad.shape === 'oval') {
    cornerR = Math.min(halfW, halfH)
  } else if (pad.shape === 'roundrect' || pad.roundrectRatio) {
    cornerR = 2 * Math.min(halfW, halfH) * (pad.roundrectRatio ?? 0.25)
  }
  // Pad angles are absolute and CCW in scene space (see renderPad); rotate the
  // point into the pad's frame and take the axis-aligned rounded-rect distance.
  const angle = pad.position.angle ? (pad.position.angle * Math.PI) / 180 : 0
  const cos = Math.cos(-angle)
  const sin = Math.sin(-angle)
  const px = point.x - center.x
  const py = point.y - center.y
  const lx = px * cos - py * sin
  const ly = px * sin + py * cos
  const qx = Math.abs(lx) - (halfW - cornerR)
  const qy = Math.abs(ly) - (halfH - cornerR)
  return Math.max(0, Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - cornerR)
}

function distToSegment(p: THREE.Vector2, v: THREE.Vector2, w: THREE.Vector2): number {
  const l2 = v.distanceToSquared(w)
  if (l2 === 0) return p.distanceTo(v)
  let t = ((p.x - v.x) * (w.x - v.x) + (p.y - v.y) * (w.y - v.y)) / l2
  t = Math.max(0, Math.min(1, t))
  return p.distanceTo(new THREE.Vector2(v.x + t * (w.x - v.x), v.y + t * (w.y - v.y)))
}

function pointInPolygon(
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

function distToThreePointArc(
  point: THREE.Vector2,
  pStart: { x: number; y: number },
  pMid: { x: number; y: number },
  pEnd: { x: number; y: number }
): number {
  const circle = circumscribedCircle(pStart.x, pStart.y, pMid.x, pMid.y, pEnd.x, pEnd.y)
  if (!circle) {
    return distToSegment(
      point,
      new THREE.Vector2(pStart.x, pStart.y),
      new THREE.Vector2(pEnd.x, pEnd.y)
    )
  }
  const { cx, cy, r } = circle
  const aStart = Math.atan2(pStart.y - cy, pStart.x - cx)
  const aEnd = Math.atan2(pEnd.y - cy, pEnd.x - cx)
  const anticlockwise = !arcContainsMidCCW(pStart, pMid, pEnd, cx, cy)

  let sweep: number
  if (anticlockwise) {
    sweep = aStart - aEnd
    if (sweep <= 0) sweep += 2 * Math.PI
  } else {
    sweep = aEnd - aStart
    if (sweep <= 0) sweep += 2 * Math.PI
  }

  const segments = 32
  let minDist = Infinity
  for (let i = 0; i < segments; i++) {
    const t0 = i / segments
    const t1 = (i + 1) / segments
    const a0 = anticlockwise ? aStart - sweep * t0 : aStart + sweep * t0
    const a1 = anticlockwise ? aStart - sweep * t1 : aStart + sweep * t1
    const d = distToSegment(
      point,
      new THREE.Vector2(cx + r * Math.cos(a0), cy + r * Math.sin(a0)),
      new THREE.Vector2(cx + r * Math.cos(a1), cy + r * Math.sin(a1))
    )
    if (d < minDist) minDist = d
  }
  return minDist
}

/** Distance to a stroke-text bounding box in the text's local frame. */
/**
 * A text's local (unrotated) glyph extent, padded by half the stroke thickness.
 * Null when there is nothing to measure. Shared by the click test below and the
 * band test in `boxSelect`, so the two agree on how big a text is.
 */
function textLocalBox(
  text: string,
  fontEffects?: KicadFontEffects
): { xMin: number; xMax: number; yMin: number; yMax: number } | null {
  if (!text) return null
  const options = strokeOptionsFromEffects(fontEffects)
  const { strokes } = getTextStrokes(text, options)
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

  const pad = options.thickness / 2
  return { xMin: xMin - pad, xMax: xMax + pad, yMin: yMin - pad, yMax: yMax + pad }
}

/**
 * The four corners of a text's box in scene space, rotation applied. A rotated
 * text's AABB is the box of these corners, which is why the corners rather than
 * a min/max pair are what this returns.
 */
function textBoxCorners(
  text: string,
  scenePos: { x: number; y: number },
  angle: number | undefined,
  fontEffects?: KicadFontEffects
): Array<{ x: number; y: number }> | null {
  const local = textLocalBox(text, fontEffects)
  if (!local) return null

  const angleRad = angle ? THREE.MathUtils.degToRad(angle) : 0
  const cos = Math.cos(angleRad)
  const sin = Math.sin(angleRad)
  return [
    { x: local.xMin, y: local.yMin },
    { x: local.xMax, y: local.yMin },
    { x: local.xMax, y: local.yMax },
    { x: local.xMin, y: local.yMax }
  ].map(({ x, y }) => ({
    x: scenePos.x + x * cos - y * sin,
    y: scenePos.y + x * sin + y * cos
  }))
}

function distToTextBox(
  point: THREE.Vector2,
  text: string,
  scenePos: { x: number; y: number },
  angle: number | undefined,
  fontEffects?: KicadFontEffects
): number | null {
  const local = textLocalBox(text, fontEffects)
  if (!local) return null

  const angleRad = angle ? THREE.MathUtils.degToRad(angle) : 0
  const cos = Math.cos(-angleRad)
  const sin = Math.sin(-angleRad)
  const dx = point.x - scenePos.x
  const dy = point.y - scenePos.y
  const lx = dx * cos - dy * sin
  const ly = dx * sin + dy * cos

  const distX = Math.max(local.xMin - lx, lx - local.xMax, 0)
  const distY = Math.max(local.yMin - ly, ly - local.yMax, 0)
  return Math.hypot(distX, distY)
}

/**
 * A preview's flattened layers (`ViewportEngine.setPreviewLayers`), each a
 * coverage batch of one color, pooled across the redraws of a gesture.
 */
class PreviewLayerPool {
  private readonly batches: PrimitiveBatch[] = []
  layers: Array<{ batch: PrimitiveBatch; opacity: number; tier: number }> = []

  constructor(private readonly scene: THREE.Scene) {}

  begin(): void {
    this.layers = []
  }

  layer(opacity: number, tier: number): PrimitiveBatch {
    let batch = this.batches[this.layers.length]
    if (!batch) {
      batch = new PrimitiveBatch(64, { minStrokePixels: 1, coverage: true, depthWrite: false })
      this.batches.push(batch)
      this.scene.add(batch.mesh)
    }
    batch.reset()
    this.layers.push({ batch, opacity, tier })
    return batch
  }

  dispose(): void {
    for (const batch of this.batches) {
      this.scene.remove(batch.mesh)
      batch.dispose()
    }
  }

  /** Empty what this redraw did not use. */
  end(): void {
    for (const batch of this.batches.slice(this.layers.length)) batch.reset()
  }
}
