/**
 * KiCad Footprint domain model and mapper.
 *
 * Maps from the generic S-Expression AST (sexpr.ts) to strongly-typed
 * TypeScript interfaces representing a KiCad .kicad_mod footprint.
 *
 * Key design principles:
 *  - Unknown/unrecognized S-expression nodes are preserved in _unknownNodes
 *  - Version-aware: handles both v5/v6 (fp_text) and v8+ (property) styles
 *  - Round-trip: serializeKicadFootprint(parseKicadFootprint(text)) preserves structure
 */

import {
  parseSExpr,
  serializeSExpr,
  findChild,
  findChildren,
  getToken,
  getFirstAtomValue,
  getAtomValues,
  getNumericValue,
  getNmValue,
  getXYNm,
  getSizeNm,
  type SExprNode,
  type SExprList,
  type SExprAtom,
  markNodeDirty,
  makeAtom,
  makeList,
  findOrCreateChild,
  setNodeValue,
  setScalarChild,
  updateAtom,
  PackedFpLineNode,
  PackedPtsNode
} from './sexpr'
import { parseColorChild, removeColorChild, setColorChild, type Rgba } from './color'
import { migrateToCurrent } from './migrate'
import { formatKicadNumber, formatNmAtom, mmAtomToNm, nm, type Nm } from './coordinates'
import { writeTeardropParams, type TeardropParams } from '../board/teardrop/params'

// ---------------------------------------------------------------------------
// Domain Types
// ---------------------------------------------------------------------------

export interface KicadFootprint {
  name: string
  version?: number
  generator?: string
  generatorVersion?: string
  layer?: string
  description?: string
  /** `(tags …)` — KiCad's Keywords, space-separated. */
  tags?: string
  /** `(solder_mask_margin …)` — absent inherits the board's. */
  solderMaskMargin?: Nm
  /** `(solder_paste_margin …)` — absent inherits the board's. */
  solderPasteMargin?: Nm
  /** `(solder_paste_margin_ratio …)` — a fraction (-0.05 is -5%); absent inherits. */
  solderPasteMarginRatio?: number
  /** `(clearance …)` — local pad-to-copper clearance; absent inherits. */
  clearance?: Nm
  /**
   * `(zone_connect n)` — KiCad's ZONE_CONNECTION: 0 none, 1 thermal reliefs,
   * 2 solid, 3 thermal reliefs for through-hole only; absent uses the zone's.
   */
  zoneConnect?: number
  /** Bare `locked` marker on the footprint node. */
  locked: boolean
  attributes: string[]
  properties: KicadProperty[]
  /**
   * The schematic sheet it was placed from, as a path of sheet names
   * (`(sheetname "/Power/")`, or a legacy `Sheetname` property); the rules'
   * `memberOfSheet` reads it.
   */
  sheetName?: string
  /** `(component_classes (class "…") …)`: the classes its symbol gave it. */
  componentClasses?: string[]
  fpTexts: KicadFpText[]
  pads: KicadPad[]
  fpLines: KicadFpLine[]
  fpArcs: KicadFpArc[]
  fpCircles: KicadFpCircle[]
  fpRects: KicadFpRect[]
  fpPolys: KicadFpPoly[]
  fpCurves: KicadFpCurve[]
  fpTextBoxes: KicadFpTextBox[]
  tables: KicadTable[]
  points: KicadPoint[]
  zones: KicadZone[]
  groups: SExprNode[]
  dimensions: KicadDimension[]
  model?: KicadModel3D
  /** Full AST for round-trip serialization */
  _raw: SExprNode
  /** Unrecognized child nodes, preserved for round-trip fidelity */
  _unknownNodes: SExprNode[]
}

/** What a keepout blocks: true = allowed, false = not_allowed (KiCad's atoms). */
export interface ZoneKeepoutRules {
  tracks: boolean
  vias: boolean
  pads: boolean
  copperpour: boolean
  footprints: boolean
}

/**
 * A rule area's keepout rules; undefined for a copper zone. A `(placement …)`
 * area with no `(keepout …)` is a rule area still, with KiCad's
 * `ZONE_SETTINGS` defaults: tracks, vias and pads kept out.
 */
export function parseKeepoutRules(node: SExprList): ZoneKeepoutRules | undefined {
  const keepoutNode = findChild(node, 'keepout')
  if (!keepoutNode) {
    return findChild(node, 'placement')
      ? { tracks: false, vias: false, pads: false, copperpour: true, footprints: true }
      : undefined
  }
  const allowed = (token: string, fallback: boolean): boolean => {
    const child = findChild(keepoutNode, token)
    return child ? getFirstAtomValue(child) === 'allowed' : fallback
  }
  return {
    tracks: allowed('tracks', false),
    vias: allowed('vias', false),
    pads: allowed('pads', true),
    copperpour: allowed('copperpour', false),
    footprints: allowed('footprints', true)
  }
}

/**
 * A zone inside a footprint. In a `.kicad_mod` its points are footprint-local;
 * in a `.kicad_pcb` they are board-absolute, as KiCad writes them.
 */
export interface KicadZone {
  net?: number
  netName?: string
  /** The first of `layers`, for the footprint editor's single-layer view. */
  layer: string
  /** Every layer the zone lives on, as the file names them (wildcards unresolved). */
  layers: string[]
  tconnect?: string
  hatchStyle?: 'none' | 'edge' | 'full'
  hatchPitch?: Nm
  minThickness?: Nm
  isKeepout: boolean
  keepoutRules?: ZoneKeepoutRules
  points: Array<{ x: Nm; y: Nm }>
  /** Cutouts: every `(polygon …)` after the first. */
  holes?: Array<Array<{ x: Nm; y: Nm }>>
  filledPolys?: Array<Array<{ x: Nm; y: Nm }>>
  uuid?: string
  _raw: SExprNode
}

export interface KicadFontEffects {
  width: Nm
  height: Nm
  thickness: Nm
  bold?: boolean
  italic?: boolean
  mirror?: boolean
  /** Horizontal anchor from (justify ...); center when absent (KiCad default) */
  hAlign?: 'left' | 'right'
  /** Vertical anchor from (justify ...); center when absent (KiCad default) */
  vAlign?: 'top' | 'bottom'
}

export interface KicadProperty {
  key: string
  value: string
  position?: { x: Nm; y: Nm; angle?: number }
  layer?: string
  hide?: boolean
  fontEffects?: KicadFontEffects
  effects?: SExprNode
  uuid?: string
  locked: boolean
  /** See `KicadFpText.keepUpright` — the same `(unlocked …)` token, inverted. */
  keepUpright: boolean
  /** See `KicadFpText.knockout`. */
  knockout: boolean
  _raw: SExprNode
}

export interface KicadFpText {
  type: 'reference' | 'value' | 'user'
  text: string
  position?: { x: Nm; y: Nm; angle?: number }
  layer?: string
  hide?: boolean
  fontEffects?: KicadFontEffects
  effects?: SExprNode
  uuid?: string
  /** `(locked yes)` — the item refuses selection while the Locked filter is off. */
  locked: boolean
  /**
   * KiCad's "Keep upright" — stored INVERTED, as `(unlocked yes)`; absent means
   * upright. Read by `footprintTextDrawAngle` and nothing else: the stored angle
   * stays the truth, this only decides how it draws.
   */
  keepUpright: boolean
  /** `(layer "F.SilkS" knockout)` — drawn as a cut-out of a filled box. */
  knockout: boolean
  _raw: SExprNode
}

/**
 * The angle a footprint text DRAWS at, which is not always the angle it stores.
 *
 * KiCad keeps footprint text readable: unless the item is `(unlocked yes)`, the
 * drawn angle folds into (-90°, 90°]. Text angles in a board file are absolute —
 * they include the footprint's rotation, per `rotateBoardFootprintInAST` — so
 * this is what keeps a rotated part's reference the right way up.
 *
 * Probed with `kicad-cli pcb export svg` / `fp export svg` at 0/90/180/270/45:
 *
 * - 180 → 0 (L→R), 270 → 90 (bottom→top), 90 and 45 unchanged
 * - `(unlocked yes)` plots literally: 180 reads R→L, 270 top→bottom
 * - the same fold applies in the footprint editor, where the parent sits at 0
 * - a board-level `(gr_text …)` at 180 plots R→L: no parent footprint, no fold
 *
 * Not the fold `symbolFieldTextAngle` uses — that one straightens 270 to -90,
 * the opposite quarter turn.
 */
export function footprintTextDrawAngle(angle: number | undefined, keepUpright: boolean): number {
  const stored = (((angle ?? 0) % 360) + 360) % 360
  if (!keepUpright) return stored
  if (stored > 90 && stored <= 270) return stored - 180
  return stored > 270 ? stored - 360 : stored
}

export type KicadPadType = 'smd' | 'thru_hole' | 'np_thru_hole' | 'connect'

/**
 * A hole bored out past its plating after drilling, over a run of copper
 * layers: `(backdrill …)` (KiCad's secondary drill) or `(tertiary_drill …)`.
 */
export interface KicadBackdrill {
  size: Nm
  /** The first and last copper layer it bores, in either order. */
  layers: [string, string]
}

/** `(front_post_machining …)` / `(back_post_machining …)`: a counterbore or countersink milled from one face. */
export interface KicadPostMachining {
  mode: 'counterbore' | 'countersink'
  size?: Nm
  depth?: Nm
  /** A countersink's included angle, degrees. */
  angle?: number
}

/** What a pad's or via's hole is machined with after drilling; absent when it is not. */
export interface KicadHoleMachining {
  backdrill?: KicadBackdrill
  tertiaryDrill?: KicadBackdrill
  frontPostMachining?: KicadPostMachining
  backPostMachining?: KicadPostMachining
}

export type KicadPadShape = 'rect' | 'circle' | 'oval' | 'roundrect' | 'trapezoid' | 'custom'

export interface KicadPad {
  number: string
  type: KicadPadType
  shape: KicadPadShape
  position: { x: Nm; y: Nm; angle?: number }
  size: { w: Nm; h: Nm }
  layers: string[]
  drill?: KicadDrill
  roundrectRatio?: number
  chamferRatio?: number
  chamfer?: string[]
  /** A trapezoid's `(rect_delta dx dy)`: how much wider one end is than the other. */
  rectDelta?: { x: Nm; y: Nm }
  /** (solder_mask_margin …) — blank inherits the board default. */
  solderMaskMargin?: Nm
  /** (solder_paste_margin …) */
  solderPasteMargin?: Nm
  /** (solder_paste_margin_ratio …) — a fraction, e.g. -0.05. */
  solderPasteMarginRatio?: number
  /** (pintype "…") — the schematic pin's electrical type, carried through
   *  sync; "no_connect" and "free" drive KiCad's pad net-label glyphs. */
  pinType?: string
  /** (clearance …) — local pad-to-copper clearance override. */
  clearance?: Nm
  /** Anchor-relative graphic shapes of a custom pad: (primitives (gr_poly ...) ...) */
  primitives?: KicadPadPrimitives
  /**
   * `(options (anchor …))` — the base shape a custom pad's primitives union
   * with, drawn at `size`. Absent means `circle`, verified by plotting a pad
   * with no `(options …)` at all and reading back the aperture macro.
   */
  anchor?: 'rect' | 'circle'
  /**
   * `(padstack …)`: a pad whose copper differs by layer (KiCad 9+). The pad's
   * own fields are its front layer; `padOnLayer` gives it on any other.
   */
  padstack?: KicadPadstack
  /** Backdrills and post-machining (KiCad 10). */
  machining?: KicadHoleMachining
  uuid?: string
  /** Net assignment (only when embedded in a board) */
  net?: { number: number; name: string }
  locked: boolean
  _raw: SExprNode
}

/** One layer's copper in a padstack (`(padstack (layer "…" …))`). */
export interface KicadPadLayer {
  shape: KicadPadShape
  size: { w: Nm; h: Nm }
  /** The copper's offset from the hole on this layer, as the drill's `(offset …)` is on the front. */
  offset?: { x: Nm; y: Nm }
  rectDelta?: { x: Nm; y: Nm }
  roundrectRatio?: number
  chamferRatio?: number
  chamfer?: string[]
  clearance?: Nm
  /** A custom shape's anchor on this layer (`(options (anchor …))`); a circle when unsaid. */
  anchor?: 'rect' | 'circle'
  /** A custom shape's own primitives on this layer: each layer has its own, or none. */
  primitives?: KicadPadPrimitives
}

/**
 * A pad's layers, as KiCad's `PADSTACK` holds them: in `front_inner_back`
 * mode an `Inner` entry for every inner layer and a `B.Cu` one; in `custom`
 * mode an entry per copper layer. The front is the pad's own fields.
 */
export interface KicadPadstack {
  mode: 'front_inner_back' | 'custom'
  layers: Record<string, KicadPadLayer>
}

/**
 * The padstack entry that holds a copper layer (`PADSTACK::EffectiveLayerFor`):
 * front, inner or back in `front_inner_back`; the layer's own in `custom`,
 * else the front. Null for the front, which is the pad's own fields.
 */
export function padstackKey(mode: KicadPadstack['mode'], layer: string): string | null {
  if (mode === 'front_inner_back')
    return layer === 'F.Cu' ? null : layer === 'B.Cu' ? 'B.Cu' : 'Inner'
  return layer === 'F.Cu' ? null : layer
}

const padsOnLayer = new WeakMap<KicadPad, Map<string, KicadPad>>()

/** A pad as it is on one copper layer: its padstack's entry there, else itself. */
export function padOnLayer(pad: KicadPad, layer: string): KicadPad {
  const stack = pad.padstack
  if (!stack) return pad
  const key = padstackKey(stack.mode, layer)
  const props = key !== null ? stack.layers[key] : undefined
  if (!props) return pad
  let cached = padsOnLayer.get(pad)
  if (!cached) {
    cached = new Map()
    padsOnLayer.set(pad, cached)
  }
  let onLayer = cached.get(key!)
  if (!onLayer) {
    onLayer = {
      ...pad,
      shape: props.shape,
      // A negative extent draws the same rectangle, as KiCad's corners do.
      size: { w: Math.abs(props.size.w) as Nm, h: Math.abs(props.size.h) as Nm },
      rectDelta: props.rectDelta,
      roundrectRatio: props.roundrectRatio,
      chamferRatio: props.chamferRatio,
      chamfer: props.chamfer,
      anchor: props.anchor,
      primitives: props.primitives,
      clearance: props.clearance ?? pad.clearance,
      drill: pad.drill && { ...pad.drill, offset: props.offset }
    }
    cached.set(key!, onLayer)
  }
  return onLayer
}

/** A custom pad's `(primitives …)`, the pad's own or one padstack layer's. */
function primitivesOf(node: SExprList): KicadPadPrimitives | undefined {
  const primitivesNode = findChild(node, 'primitives')
  return primitivesNode
    ? {
        lines: findChildren(primitivesNode, 'gr_line').map(parseFpLine),
        arcs: findChildren(primitivesNode, 'gr_arc').map(parseFpArc),
        circles: findChildren(primitivesNode, 'gr_circle').map(parseFpCircle),
        rects: findChildren(primitivesNode, 'gr_rect').map(parseFpRect),
        polys: findChildren(primitivesNode, 'gr_poly').map(parseFpPoly)
      }
    : undefined
}

/** A custom pad's `(options (anchor rect|circle))`, the pad's own or one padstack layer's. */
function anchorOf(node: SExprList): 'rect' | 'circle' | undefined {
  const optionsNode = findChild(node, 'options')
  const anchor = optionsNode ? childValue(optionsNode, 'anchor') : undefined
  return anchor === 'rect' || anchor === 'circle' ? anchor : undefined
}

function parsePadstack(node: SExprList): KicadPadstack | undefined {
  const mode = childValue(node, 'mode')
  if (mode !== 'front_inner_back' && mode !== 'custom') return undefined
  const layers: Record<string, KicadPadLayer> = {}
  for (const layer of findChildren(node, 'layer')) {
    const name = getAtomValues(layer)[0]
    if (!name) continue
    const deltaNode = findChild(layer, 'rect_delta')
    const delta = deltaNode ? getAtomValues(deltaNode) : []
    const rr = findChild(layer, 'roundrect_rratio')
    const cr = findChild(layer, 'chamfer_ratio')
    const chamfer = findChild(layer, 'chamfer')
    layers[name] = {
      shape: (childValue(layer, 'shape') ?? 'circle') as KicadPadShape,
      size: getSizeNm(layer) ?? { w: nm(0), h: nm(0) },
      offset: getXYNm(layer, 'offset') ?? undefined,
      rectDelta:
        delta.length >= 2 ? { x: mmAtomToNm(delta[0]), y: mmAtomToNm(delta[1]) } : undefined,
      roundrectRatio: rr ? getNumericValue(rr) : undefined,
      chamferRatio: cr ? getNumericValue(cr) : undefined,
      chamfer: chamfer ? getAtomValues(chamfer) : undefined,
      clearance: nmChild(layer, 'clearance'),
      anchor: anchorOf(layer),
      primitives: primitivesOf(layer)
    }
  }
  return { mode, layers }
}

export interface KicadDrill {
  diameter: Nm
  oval?: { width: Nm; height: Nm }
  offset?: { x: Nm; y: Nm }
}

export interface KicadFpLine {
  start: { x: Nm; y: Nm }
  end: { x: Nm; y: Nm }
  layer?: string
  strokeWidth?: Nm
  strokeType?: string
  strokeColor?: Rgba
  /**
   * A board graphic's net, from its `(net …)` (a copper drawing on the board
   * conducts in KiCad); absent on a footprint's, whose net KiCad never reads.
   */
  net?: number
  uuid?: string
  locked: boolean
  _raw: SExprNode
}

export interface KicadFpArc {
  start: { x: Nm; y: Nm }
  mid: { x: Nm; y: Nm }
  end: { x: Nm; y: Nm }
  layer?: string
  strokeWidth?: Nm
  strokeType?: string
  strokeColor?: Rgba
  /**
   * A board graphic's net, from its `(net …)` (a copper drawing on the board
   * conducts in KiCad); absent on a footprint's, whose net KiCad never reads.
   */
  net?: number
  uuid?: string
  locked: boolean
  _raw: SExprNode
}

export interface KicadFpCircle {
  center: { x: Nm; y: Nm }
  end: { x: Nm; y: Nm }
  layer?: string
  strokeWidth?: Nm
  strokeType?: string
  strokeColor?: Rgba
  fill?: string
  /**
   * A board graphic's net, from its `(net …)` (a copper drawing on the board
   * conducts in KiCad); absent on a footprint's, whose net KiCad never reads.
   */
  net?: number
  uuid?: string
  locked: boolean
  _raw: SExprNode
}

export interface KicadFpRect {
  start: { x: Nm; y: Nm }
  end: { x: Nm; y: Nm }
  /** KiCad 10's corner radius, clamped as KiCad clamps it to half the shorter side. */
  radius?: Nm
  layer?: string
  strokeWidth?: Nm
  strokeType?: string
  strokeColor?: Rgba
  fill?: string
  /**
   * A board graphic's net, from its `(net …)` (a copper drawing on the board
   * conducts in KiCad); absent on a footprint's, whose net KiCad never reads.
   */
  net?: number
  uuid?: string
  locked: boolean
  _raw: SExprNode
}

export interface KicadFpPoly {
  points: Array<{ x: Nm; y: Nm }>
  layer?: string
  strokeWidth?: Nm
  strokeType?: string
  strokeColor?: Rgba
  fill?: string
  /**
   * A board graphic's net, from its `(net …)` (a copper drawing on the board
   * conducts in KiCad); absent on a footprint's, whose net KiCad never reads.
   */
  net?: number
  uuid?: string
  locked: boolean
  _raw: SExprNode
}

export interface KicadPadPrimitives {
  lines: KicadFpLine[]
  arcs: KicadFpArc[]
  circles: KicadFpCircle[]
  rects: KicadFpRect[]
  polys: KicadFpPoly[]
}

/**
 * A cubic Bézier: `(fp_curve (pts (xy …) ×4) …)` in a footprint, `gr_curve` on a
 * board. KiCad writes the four points in the order start, first control, second
 * control, end; any other count is kept as the file gave it.
 */
export interface KicadFpCurve {
  points: Array<{ x: Nm; y: Nm }>
  layer?: string
  strokeWidth?: Nm
  strokeType?: string
  strokeColor?: Rgba
  /**
   * A board graphic's net, from its `(net …)` (a copper drawing on the board
   * conducts in KiCad); absent on a footprint's, whose net KiCad never reads.
   */
  net?: number
  uuid?: string
  locked: boolean
  _raw: SExprNode
}

/** `(margins left top right bottom)` of a text box, integer nm. */
export interface KicadTextBoxMargins {
  left: Nm
  top: Nm
  right: Nm
  bottom: Nm
}

/**
 * A text box: `(fp_text_box "text" …)` in a footprint, `gr_text_box` on a board,
 * and each `(table_cell …)` of a table. The box is two corners (`start`/`end`)
 * or, when KiCad turned it off the axes, its corner polygon (`points`). In a
 * footprint every coordinate is footprint-local and the angle is relative to
 * the footprint, as KiCad writes them (`PCB_IO_KICAD_SEXPR::format`).
 */
export interface KicadFpTextBox {
  text: string
  start?: { x: Nm; y: Nm }
  end?: { x: Nm; y: Nm }
  points?: Array<{ x: Nm; y: Nm }>
  /** Absent in files before 20230825: KiCad then derives them (`legacyTextBoxMargin`). */
  margins?: KicadTextBoxMargins
  /** `(angle …)`, degrees; 0 when absent. Turns the text, never the box. */
  angle: number
  layer?: string
  fontEffects?: KicadFontEffects
  /** `(border yes)`; older files meant "border" by a non-negative stroke width. */
  border: boolean
  strokeWidth?: Nm
  strokeType?: string
  knockout: boolean
  uuid?: string
  locked: boolean
  _raw: SExprNode
}

/** One `(table_cell …)`: a text box that knows how many columns and rows it spans. */
export interface KicadTableCell extends KicadFpTextBox {
  /** `(span cols rows)`; a cell covered by a neighbor's span carries 0. */
  colSpan: number
  rowSpan: number
}

/**
 * A table: `(table (column_count n) … (column_widths …) (row_heights …) (cells
 * (table_cell …) …))`, the same token on a board and in a footprint. Cells run
 * row by row; the rules drawn between them follow the border and separator
 * switches, which KiCad defaults on.
 */
export interface KicadTable {
  columnCount: number
  layer?: string
  borderExternal: boolean
  borderHeader: boolean
  borderStrokeWidth?: Nm
  separatorRows: boolean
  separatorCols: boolean
  separatorStrokeWidth?: Nm
  columnWidths: Nm[]
  rowHeights: Nm[]
  cells: KicadTableCell[]
  uuid?: string
  locked: boolean
  _raw: SExprNode
}

/**
 * A point: `(point (at x y) (size s) (layer …) (uuid …))`, KiCad 10's snap and
 * reference marker. It carries no lock flag in the format.
 */
export interface KicadPoint {
  position: { x: Nm; y: Nm }
  /** The marker's extent; KiCad's default is 1 mm. */
  size: Nm
  layer?: string
  uuid?: string
  locked: boolean
  _raw: SExprNode
}

/**
 * A dimension (measurement annotation): (dimension (type ...) (pts ...) ...).
 * Valid at board top level and inside board-embedded footprints; in both
 * cases KiCad stores the coordinates in absolute board space (verified
 * against KiCad 8 output — footprint placement is NOT applied to them).
 */
export interface KicadDimension {
  /** aligned | orthogonal | leader | center | radial */
  dimensionType?: string
  layer?: string
  /** Measured points (start, end) */
  points: Array<{ x: Nm; y: Nm }>
  /** Offset of the dimension line from the measured points */
  height?: Nm
  /** orthogonal only: 0 = measures X (horizontal line), 1 = measures Y */
  orientation?: number
  /** The baked measurement text (a nested gr_text node) */
  text?: {
    text: string
    position?: { x: Nm; y: Nm; angle?: number }
    layer?: string
    fontEffects?: KicadFontEffects
  }
  style?: {
    thickness?: Nm
    arrowLength?: Nm
    extensionHeight?: Nm
    extensionOffset?: Nm
    /** `(arrow_direction inward)`; KiCad's default is outward. */
    arrowDirection?: 'inward' | 'outward'
    /** `(text_position_mode n)`: 0 outside the crossbar, 1 inline on it, 2 placed by hand. */
    textPositionMode?: number
    /** `(text_frame n)`, a leader's: 0 none, 1 rectangle, 2 circle. */
    textFrame?: number
  }
  /** A radial dimension's `(leader_length …)`: how far its leader runs past the measured point. */
  leaderLength?: Nm
  uuid?: string
  locked: boolean
  _raw: SExprNode
}

export interface KicadModel3D {
  path: string
  /** Board-space displacement — the one distance here, integer nanometers. */
  offset?: { x: Nm; y: Nm; z: Nm }
  /** Unitless multiplier — NOT a distance. */
  scale?: { x: number; y: number; z: number }
  /** Degrees — NOT a distance. */
  rotate?: { x: number; y: number; z: number }
  _raw: SExprNode
}

// ---------------------------------------------------------------------------
// Shared parse helpers
// ---------------------------------------------------------------------------

/** First atom value of the (token value) child, or undefined if absent. */
function childValue(node: SExprList, token: string): string | undefined {
  const child = findChild(node, token)
  return child ? getFirstAtomValue(child) : undefined
}

/** An item's identity: `uuid`, or the `tstamp` files before KiCad 8 spelled it. */
function uuidOf(node: SExprList): string | undefined {
  return childValue(node, 'uuid') ?? childValue(node, 'tstamp')
}

/** Numeric value of a `(token value)` child, or undefined when absent. */
function numChild(node: SExprList, token: string): number | undefined {
  const child = findChild(node, token)
  return child ? getNumericValue(child) : undefined
}

/** The distance twin of `numChild`: a millimeter child read as integer nm. */
function nmChild(node: SExprList, token: string): Nm | undefined {
  const child = findChild(node, token)
  return child ? getNmValue(child) : undefined
}

/** A placed footprint's sheet and component classes, where the file gives them. */
function sheetAndClasses(fp: SExprList): Pick<KicadFootprint, 'sheetName' | 'componentClasses'> {
  const sheetNode = findChild(fp, 'sheetname')
  const legacy = findChildren(fp, 'property').find((node) => getAtomValues(node)[0] === 'Sheetname')
  const sheetName = sheetNode
    ? getFirstAtomValue(sheetNode)
    : legacy
      ? getAtomValues(legacy)[1]
      : undefined
  const classesNode = findChild(fp, 'component_classes')
  const componentClasses = classesNode
    ? findChildren(classesNode, 'class').flatMap((node) => getAtomValues(node).slice(0, 1))
    : undefined
  return {
    ...(sheetName !== undefined ? { sheetName } : {}),
    ...(componentClasses?.length ? { componentClasses } : {})
  }
}

/** A pad's or via's `(backdrill …)`, `(tertiary_drill …)` and post-machining children. */
export function parseHoleMachining(node: SExprList): KicadHoleMachining | undefined {
  const drill = (token: string): KicadBackdrill | undefined => {
    const child = findChild(node, token)
    if (!child) return undefined
    const size = nmChild(child, 'size')
    const layers = findChild(child, 'layers')
    const [start, end] = layers ? getAtomValues(layers) : []
    return size !== undefined && start && end ? { size, layers: [start, end] } : undefined
  }
  const post = (token: string): KicadPostMachining | undefined => {
    const child = findChild(node, token)
    const mode = child ? getAtomValues(child)[0] : undefined
    if (!child || (mode !== 'counterbore' && mode !== 'countersink')) return undefined
    return {
      mode,
      size: nmChild(child, 'size'),
      depth: nmChild(child, 'depth'),
      angle: numChild(child, 'angle')
    }
  }
  const machining: KicadHoleMachining = {
    backdrill: drill('backdrill'),
    tertiaryDrill: drill('tertiary_drill'),
    frontPostMachining: post('front_post_machining'),
    backPostMachining: post('back_post_machining')
  }
  return Object.values(machining).some((v) => v !== undefined) ? machining : undefined
}

/** How far a flattened `(arc …)` in a point list may stray from the arc, nm (KiCad's default max error). */
const PTS_ARC_ERROR = 5000

/**
 * A three-point arc as points from just past its start to its end, each chord
 * within `PTS_ARC_ERROR` of it; a straight line when the three are collinear.
 */
function flattenPtsArc(
  a: { x: number; y: number },
  m: { x: number; y: number },
  b: { x: number; y: number }
): Array<{ x: Nm; y: Nm }> {
  const d = 2 * (a.x * (m.y - b.y) + m.x * (b.y - a.y) + b.x * (a.y - m.y))
  if (Math.abs(d) < 1e-9) return [{ x: b.x as Nm, y: b.y as Nm }]
  const sq = (p: { x: number; y: number }): number => p.x * p.x + p.y * p.y
  const cx = (sq(a) * (m.y - b.y) + sq(m) * (b.y - a.y) + sq(b) * (a.y - m.y)) / d
  const cy = (sq(a) * (b.x - m.x) + sq(m) * (a.x - b.x) + sq(b) * (m.x - a.x)) / d
  const r = Math.hypot(a.x - cx, a.y - cy)
  const a0 = Math.atan2(a.y - cy, a.x - cx)
  const turn = (to: number): number => {
    let t = to - a0
    while (t < 0) t += 2 * Math.PI
    return t
  }
  // Sweep the way that passes through the midpoint.
  let sweep = turn(Math.atan2(b.y - cy, b.x - cx))
  if (turn(Math.atan2(m.y - cy, m.x - cx)) > sweep) sweep -= 2 * Math.PI
  const step = r > PTS_ARC_ERROR ? 2 * Math.acos(1 - PTS_ARC_ERROR / r) : Math.PI / 4
  const count = Math.max(2, Math.ceil(Math.abs(sweep) / step))
  const out: Array<{ x: Nm; y: Nm }> = []
  for (let k = 1; k < count; k++) {
    const t = a0 + (sweep * k) / count
    out.push({
      x: Math.round(cx + r * Math.cos(t)) as Nm,
      y: Math.round(cy + r * Math.sin(t)) as Nm
    })
  }
  out.push({ x: b.x as Nm, y: b.y as Nm })
  return out
}

/**
 * Parse a (pts ...) node into integer-nm points: each `(xy X Y)`, and each
 * `(arc (start) (mid) (end))` flattened in place, as KiCad reads an outline
 * with arcs in it (zones and polygons may carry them).
 */
export function parsePointList(ptsNode: SExprList | null): Array<{ x: Nm; y: Nm }> {
  const points: Array<{ x: Nm; y: Nm }> = []
  if (!ptsNode) return points
  if (ptsNode instanceof PackedPtsNode) {
    // Packed coords already ARE integer nanometers — a straight copy.
    const coords = ptsNode.packedCoords()
    if (coords) {
      for (let i = 0; i < coords.length; i += 2) {
        points.push({ x: coords[i] as Nm, y: coords[i + 1] as Nm })
      }
      return points
    }
  }
  const pointOf = (node: SExprList | null): { x: Nm; y: Nm } | null => {
    const atoms = node ? getAtomValues(node) : []
    return atoms.length >= 2 ? { x: mmAtomToNm(atoms[0]), y: mmAtomToNm(atoms[1]) } : null
  }
  for (const child of ptsNode.children) {
    if (child.type !== 'list') continue
    const token = getToken(child)
    if (token === 'xy') {
      const p = pointOf(child)
      if (p) points.push(p)
    } else if (token === 'arc') {
      const a = pointOf(findChild(child, 'start'))
      const m = pointOf(findChild(child, 'mid'))
      const b = pointOf(findChild(child, 'end'))
      if (!a || !m || !b) continue
      const last = points[points.length - 1]
      if (!last || last.x !== a.x || last.y !== a.y) points.push(a)
      points.push(...flattenPtsArc(a, m, b))
    }
  }
  // A closing arc that ends where the outline began would repeat the first point.
  const first = points[0]
  const last = points[points.length - 1]
  if (points.length > 2 && first.x === last.x && first.y === last.y) points.pop()
  return points
}

// ---------------------------------------------------------------------------
// Parser: S-Expression AST → KicadFootprint
// ---------------------------------------------------------------------------

export function parseKicadFootprint(source: string): KicadFootprint {
  const root = parseSExpr(source)
  // Library content is read everywhere; every reader sees KiCad 10's (RULES.md §7).
  if (root.type === 'list') migrateToCurrent(root)

  if (root.type !== 'list' || getToken(root) !== 'footprint') {
    throw new Error('Input is not a KiCad footprint (expected top-level "footprint" token)')
  }

  return parseFootprintNode(root as SExprList)
}

/**
 * Parse a (footprint ...) AST node into the domain model. Used both for
 * standalone .kicad_mod files and for footprints embedded in .kicad_pcb
 * boards (where the node additionally carries at/uuid/path placement data
 * that the board mapper reads separately).
 */
export function parseFootprintNode(fp: SExprList): KicadFootprint {
  const name = getFirstAtomValue(fp) ?? 'Untitled'

  // Track which children we've handled (the trailing entries are board-embedded
  // placement/instance tokens read by the board mapper, not "unknown" data)
  const handledTokens = new Set<string>([
    'version',
    'generator',
    'generator_version',
    'layer',
    'descr',
    'tags',
    'solder_mask_margin',
    'solder_paste_margin',
    'solder_paste_margin_ratio',
    'solder_paste_ratio',
    'clearance',
    'zone_connect',
    'attr',
    'property',
    'fp_text',
    'pad',
    'fp_line',
    'fp_arc',
    'fp_circle',
    'fp_rect',
    'fp_poly',
    'fp_curve',
    'fp_text_box',
    'table',
    'point',
    'model',
    'zone',
    'group',
    'dimension',
    'at',
    'uuid',
    'path',
    'sheetname',
    'sheetfile'
  ])

  const unknownNodes: SExprNode[] = []
  for (let i = 1; i < fp.children.length; i++) {
    const child = fp.children[i]
    if (child.type === 'atom') continue // name atom already handled
    if (child.type === 'list') {
      const token = getToken(child)
      if (token && !handledTokens.has(token)) {
        unknownNodes.push(child)
      }
    }
  }

  const versionNode = findChild(fp, 'version')
  const attrNode = findChild(fp, 'attr')
  const modelNode = findChild(fp, 'model')

  return {
    name,
    version: versionNode ? getNumericValue(versionNode) : undefined,
    generator: childValue(fp, 'generator'),
    generatorVersion: childValue(fp, 'generator_version'),
    layer: childValue(fp, 'layer'),
    description: childValue(fp, 'descr'),
    tags: childValue(fp, 'tags'),
    solderMaskMargin: nmChild(fp, 'solder_mask_margin'),
    solderPasteMargin: nmChild(fp, 'solder_paste_margin'),
    solderPasteMarginRatio:
      numChild(fp, 'solder_paste_margin_ratio') ?? numChild(fp, 'solder_paste_ratio'),
    clearance: nmChild(fp, 'clearance'),
    zoneConnect: numChild(fp, 'zone_connect'),
    locked: parseFlag(fp, 'locked'),
    attributes: attrNode ? getAtomValues(attrNode) : [],
    properties: findChildren(fp, 'property').map(parseProperty),
    ...sheetAndClasses(fp),
    fpTexts: findChildren(fp, 'fp_text').map(parseFpText),
    pads: findChildren(fp, 'pad').map(parsePad),
    fpLines: findChildren(fp, 'fp_line').map(parseFpLine),
    fpArcs: findChildren(fp, 'fp_arc').map(parseFpArc),
    fpCircles: findChildren(fp, 'fp_circle').map(parseFpCircle),
    fpRects: findChildren(fp, 'fp_rect').map(parseFpRect),
    fpPolys: findChildren(fp, 'fp_poly').map(parseFpPoly),
    fpCurves: findChildren(fp, 'fp_curve').map(parseFpCurve),
    fpTextBoxes: findChildren(fp, 'fp_text_box').map(parseFpTextBox),
    tables: findChildren(fp, 'table').map(parseTable),
    points: findChildren(fp, 'point').map(parsePoint),
    zones: findChildren(fp, 'zone').map(parseZone),
    groups: findChildren(fp, 'group'),
    dimensions: findChildren(fp, 'dimension').map(parseDimension),
    model: modelNode ? parseModel3D(modelNode) : undefined,
    _raw: fp,
    _unknownNodes: unknownNodes
  }
}

// ---------------------------------------------------------------------------
// Text parsing: property (v8+) and fp_text (v5/v6)
// ---------------------------------------------------------------------------

/**
 * True when NODE carries flag TOKEN, either as a bare atom (v5/v6 style,
 * e.g. `bold` / `hide`) or as a yes/no child list (v7+, e.g. `(bold yes)`).
 */
export function parseFlag(node: SExprList, token: string): boolean {
  // Only unquoted atoms count: quoted strings are values (a text of "hide"
  // must not read as the hide flag)
  for (const child of node.children) {
    if (child.type === 'atom' && !child.quoted && child.value === token) return true
  }
  const child = findChild(node, token)
  if (!child) return false
  return getFirstAtomValue(child) !== 'no'
}

export function parseFontEffects(node: SExprList): KicadFontEffects | undefined {
  const effectsNode = findChild(node, 'effects')
  if (!effectsNode) return undefined
  const fontNode = findChild(effectsNode, 'font')
  if (!fontNode) return undefined

  const sizeNode = findChild(fontNode, 'size')
  const thicknessNode = findChild(fontNode, 'thickness')

  // Font size is (size HEIGHT WIDTH) per the s-expression spec
  const sizeAtoms = sizeNode ? getAtomValues(sizeNode) : []
  const height = sizeAtoms.length >= 1 ? mmAtomToNm(sizeAtoms[0]) : nm(1270000)
  const width = sizeAtoms.length >= 2 ? mmAtomToNm(sizeAtoms[1]) : height

  const bold = parseFlag(fontNode, 'bold')
  const italic = parseFlag(fontNode, 'italic')

  // KiCad pen-width fallback when no explicit thickness: size/5 bold, size/8 normal
  const thickness = thicknessNode
    ? getNmValue(thicknessNode, nm(150000))
    : bold
      ? nm(height / 5)
      : nm(height / 8)

  // (effects (justify [left|right] [top|bottom] [mirror])) — center when absent
  const justifyNode = findChild(effectsNode, 'justify')
  const justifyAtoms = justifyNode ? getAtomValues(justifyNode) : []
  const mirror = justifyAtoms.includes('mirror')
  const hAlign = justifyAtoms.includes('left')
    ? ('left' as const)
    : justifyAtoms.includes('right')
      ? ('right' as const)
      : undefined
  const vAlign = justifyAtoms.includes('top')
    ? ('top' as const)
    : justifyAtoms.includes('bottom')
      ? ('bottom' as const)
      : undefined

  return { width, height, thickness, bold, italic, mirror, hAlign, vAlign }
}

function parseProperty(node: SExprList): KicadProperty {
  const atoms = getAtomValues(node)

  return {
    key: atoms[0] ?? '',
    value: atoms[1] ?? '',
    position: getXYNm(node, 'at') ?? undefined,
    layer: childValue(node, 'layer'),
    hide: parseFlag(node, 'hide'),
    fontEffects: parseFontEffects(node),
    effects: findChild(node, 'effects') ?? undefined,
    uuid: uuidOf(node),
    locked: parseFlag(node, 'locked'),
    keepUpright: keepsUpright(node),
    knockout: parseLayerKnockout(node),
    _raw: node
  }
}

/**
 * KiCad's "Keep upright", stored inverted: `(unlocked yes)` since 20231014,
 * and before that an `unlocked` atom inside the text's `(at x y angle unlocked)`.
 */
function keepsUpright(node: SExprList): boolean {
  if (parseFlag(node, 'unlocked')) return false
  const at = findChild(node, 'at')
  return !(at && parseFlag(at, 'unlocked'))
}

/** The `knockout` atom KiCad writes inside a text's `(layer …)`. */
export function parseLayerKnockout(node: SExprList): boolean {
  const layer = findChild(node, 'layer')
  return !!layer && parseFlag(layer, 'knockout')
}

function parseFpText(node: SExprList): KicadFpText {
  const atoms = getAtomValues(node)
  const typeStr = atoms[0] ?? 'user'

  let type: KicadFpText['type'] = 'user'
  if (typeStr === 'reference') type = 'reference'
  else if (typeStr === 'value') type = 'value'

  return {
    type,
    text: atoms[1] ?? '',
    position: getXYNm(node, 'at') ?? undefined,
    layer: childValue(node, 'layer'),
    hide: parseFlag(node, 'hide'),
    fontEffects: parseFontEffects(node),
    effects: findChild(node, 'effects') ?? undefined,
    uuid: uuidOf(node),
    locked: parseFlag(node, 'locked'),
    keepUpright: keepsUpright(node),
    knockout: parseLayerKnockout(node),
    _raw: node
  }
}

// ---------------------------------------------------------------------------
// Pad parsing
// ---------------------------------------------------------------------------

export function parsePad(node: SExprList): KicadPad {
  const atoms = getAtomValues(node)

  const layersNode = findChild(node, 'layers')
  const drillNode = findChild(node, 'drill')
  const rrNode = findChild(node, 'roundrect_rratio')
  const chamferRatioNode = findChild(node, 'chamfer_ratio')
  const chamferListNode = findChild(node, 'chamfer')
  const deltaNode = findChild(node, 'rect_delta')
  const deltaAtoms = deltaNode ? getAtomValues(deltaNode) : []

  const netNode = findChild(node, 'net')
  let net: KicadPad['net']
  if (netNode) {
    const netAtoms = getAtomValues(netNode)
    const first = netAtoms[0] ?? '0'
    // KiCad ≤9 writes (net N "NAME"); KiCad 10 writes (net "NAME") with no
    // numeric table in the file. A name-only ref parses as NaN + the name,
    // and the board parse resolves the number (board.ts net resolver).
    net = /^-?\d+$/.test(first)
      ? { number: parseInt(first), name: netAtoms[1] ?? '' }
      : { number: NaN, name: first }
  }

  const primitives = primitivesOf(node)
  const padstackNode = findChild(node, 'padstack')

  // The pad as KiCad loads it (`PCB_IO_KICAD_SEXPR_PARSER::parsePAD`): a
  // through-hole pad with no drill has a 1 nm one, an SMD or edge-connector
  // pad no hole whatever its file says, and a pad of no size is 1 µm square.
  // The file's own text is kept (`_raw`); these are what is read from it.
  const type = (atoms[1] ?? 'smd') as KicadPadType
  let drill = drillNode ? parseDrill(drillNode) : undefined
  if (type === 'thru_hole' && !drill) drill = { diameter: nm(1) }
  if (type === 'smd' || type === 'connect') drill = undefined
  const parsedSize = getSizeNm(node) ?? { w: nm(1000000), h: nm(1000000) }
  const size = parsedSize.w <= 0 || parsedSize.h <= 0 ? { w: nm(1000), h: nm(1000) } : parsedSize

  return {
    number: atoms[0] ?? '?',
    type,
    shape: (atoms[2] ?? 'rect') as KicadPadShape,
    position: getXYNm(node, 'at') ?? { x: nm(0), y: nm(0) },
    size,
    layers: layersNode ? getAtomValues(layersNode) : [],
    drill,
    roundrectRatio: rrNode ? getNumericValue(rrNode) : undefined,
    chamferRatio: chamferRatioNode ? getNumericValue(chamferRatioNode) : undefined,
    chamfer: chamferListNode ? getAtomValues(chamferListNode) : undefined,
    rectDelta:
      deltaAtoms.length >= 2
        ? { x: mmAtomToNm(deltaAtoms[0]), y: mmAtomToNm(deltaAtoms[1]) }
        : undefined,
    solderMaskMargin: nmChild(node, 'solder_mask_margin'),
    solderPasteMargin: nmChild(node, 'solder_paste_margin'),
    solderPasteMarginRatio: numChild(node, 'solder_paste_margin_ratio'),
    pinType: childValue(node, 'pintype'),
    clearance: nmChild(node, 'clearance'),
    primitives,
    anchor: anchorOf(node),
    padstack: padstackNode ? parsePadstack(padstackNode) : undefined,
    machining: parseHoleMachining(node),
    uuid: uuidOf(node),
    net,
    locked: parseFlag(node, 'locked'),
    _raw: node
  }
}

// ---------------------------------------------------------------------------
// Dimension parsing
// ---------------------------------------------------------------------------

export function parseDimension(node: SExprList): KicadDimension {
  const heightNode = findChild(node, 'height')
  const orientationNode = findChild(node, 'orientation')

  const textNode = findChild(node, 'gr_text')
  const text: KicadDimension['text'] = textNode
    ? {
        text: getAtomValues(textNode)[0] ?? '',
        position: getXYNm(textNode, 'at') ?? undefined,
        layer: childValue(textNode, 'layer'),
        fontEffects: parseFontEffects(textNode)
      }
    : undefined

  const styleNode = findChild(node, 'style')
  const styleChild = (token: string): Nm | undefined => {
    const child = styleNode ? findChild(styleNode, token) : null
    return child ? getNmValue(child) : undefined
  }

  const styleNumber = (token: string): number | undefined => {
    const child = styleNode ? findChild(styleNode, token) : null
    return child ? getNumericValue(child) : undefined
  }
  const arrowDirection = styleNode ? childValue(styleNode, 'arrow_direction') : undefined
  const leaderLengthNode = findChild(node, 'leader_length')

  return {
    dimensionType: childValue(node, 'type'),
    layer: childValue(node, 'layer'),
    points: parsePointList(findChild(node, 'pts')),
    height: heightNode ? getNmValue(heightNode) : undefined,
    orientation: orientationNode ? getNumericValue(orientationNode) : undefined,
    text,
    style: styleNode
      ? {
          thickness: styleChild('thickness'),
          arrowLength: styleChild('arrow_length'),
          extensionHeight: styleChild('extension_height'),
          extensionOffset: styleChild('extension_offset'),
          ...(arrowDirection === 'inward' || arrowDirection === 'outward'
            ? { arrowDirection }
            : {}),
          textPositionMode: styleNumber('text_position_mode'),
          textFrame: styleNumber('text_frame')
        }
      : undefined,
    ...(leaderLengthNode ? { leaderLength: getNmValue(leaderLengthNode) } : {}),
    uuid: uuidOf(node),
    locked: parseFlag(node, 'locked'),
    _raw: node
  }
}

function parseDrill(node: SExprList): KicadDrill {
  const atoms = getAtomValues(node)
  const isOval = atoms[0] === 'oval'
  const startIdx = isOval ? 1 : 0
  const offset = getXYNm(node, 'offset') ?? undefined

  if (isOval && atoms.length >= 3) {
    return {
      diameter: mmAtomToNm(atoms[startIdx]),
      oval: {
        width: mmAtomToNm(atoms[startIdx]),
        height: mmAtomToNm(atoms[startIdx + 1])
      },
      offset
    }
  }

  return {
    diameter: mmAtomToNm(atoms[startIdx] ?? '0'),
    offset
  }
}

// ---------------------------------------------------------------------------
// Graphic item parsing
// ---------------------------------------------------------------------------

export function parseStrokeWidth(node: SExprList): {
  strokeWidth?: Nm
  strokeType?: string
  strokeColor?: Rgba
} {
  // v7+: (stroke (width 0.12) (type default) [(color r g b a)])
  const strokeNode = findChild(node, 'stroke')
  if (strokeNode) {
    const widthNode = findChild(strokeNode, 'width')
    return {
      strokeWidth: widthNode ? getNmValue(widthNode) : undefined,
      strokeType: childValue(strokeNode, 'type'),
      strokeColor: parseColorChild(strokeNode)
    }
  }
  // v6: (width 0.12) directly
  const widthNode = findChild(node, 'width')
  if (widthNode) {
    return { strokeWidth: getNmValue(widthNode) }
  }
  return {}
}

export function parseFpLine(node: SExprList): KicadFpLine {
  if (node instanceof PackedFpLineNode) {
    const rec = node.packedRecord()
    if (rec) {
      // The packed scan requires the node to close right after `uuid`, so a
      // packed line provably carries no `locked` child — false is exact here,
      // not a fast-path approximation.
      return {
        start: { x: rec.x1, y: rec.y1 },
        end: { x: rec.x2, y: rec.y2 },
        layer: rec.layer,
        strokeWidth: rec.width,
        strokeType: rec.strokeType,
        uuid: rec.uuid,
        locked: false,
        _raw: node
      }
    }
  }
  return {
    start: getXYNm(node, 'start') ?? { x: nm(0), y: nm(0) },
    end: getXYNm(node, 'end') ?? { x: nm(0), y: nm(0) },
    layer: childValue(node, 'layer'),
    ...parseStrokeWidth(node),
    uuid: uuidOf(node),
    locked: parseFlag(node, 'locked'),
    _raw: node
  }
}

/**
 * The three points of an arc. Files before KiCad 6 spell an arc as its
 * center (`start`), one end (`end`) and a sweep (`angle`, degrees, turning
 * from that end); the points are derived so every reader sees one form.
 */
type ArcPoint = { x: Nm; y: Nm }

const arcPoints = (node: SExprList): { start: ArcPoint; mid: ArcPoint; end: ArcPoint } => {
  const start = getXYNm(node, 'start') ?? { x: nm(0), y: nm(0) }
  const end = getXYNm(node, 'end') ?? { x: nm(0), y: nm(0) }
  const mid = getXYNm(node, 'mid')
  const angle = numChild(node, 'angle')
  if (mid || angle === undefined) return { start, mid: mid ?? { x: nm(0), y: nm(0) }, end }
  const turned = (degrees: number): ArcPoint => {
    const a = (degrees * Math.PI) / 180
    const dx = end.x - start.x
    const dy = end.y - start.y
    return {
      x: nm(start.x + dx * Math.cos(a) - dy * Math.sin(a)),
      y: nm(start.y + dx * Math.sin(a) + dy * Math.cos(a))
    }
  }
  return { start: end, mid: turned(angle / 2), end: turned(angle) }
}

export function parseFpArc(node: SExprList): KicadFpArc {
  return {
    ...arcPoints(node),
    layer: childValue(node, 'layer'),
    ...parseStrokeWidth(node),
    uuid: uuidOf(node),
    locked: parseFlag(node, 'locked'),
    _raw: node
  }
}

/** Whether a shape's `(fill …)` fills it: KiCad 10 writes yes/no, KiCad 8 solid/none. */
export const isSolidFill = (fill: string | undefined): boolean => fill === 'solid' || fill === 'yes'

/**
 * A shape's fill as KiCad reads it (`parsePCB_SHAPE`): the `(fill …)` token,
 * else — files from before the token — a rectangle or circle of zero width is
 * filled, and so is a polygon anywhere but Edge.Cuts.
 */
function shapeFill(
  node: SExprList,
  kind: 'rect' | 'circle' | 'poly',
  strokeWidth: Nm | undefined
): string | undefined {
  const fill = childValue(node, 'fill')
  if (fill !== undefined || findChild(node, 'fill')) return fill
  if (kind === 'poly') return childValue(node, 'layer') === 'Edge.Cuts' ? undefined : 'solid'
  return strokeWidth === 0 ? 'solid' : undefined
}

export function parseFpCircle(node: SExprList): KicadFpCircle {
  const stroke = parseStrokeWidth(node)
  return {
    center: getXYNm(node, 'center') ?? { x: nm(0), y: nm(0) },
    end: getXYNm(node, 'end') ?? { x: nm(0), y: nm(0) },
    layer: childValue(node, 'layer'),
    strokeWidth: stroke.strokeWidth,
    strokeType: stroke.strokeType,
    strokeColor: stroke.strokeColor,
    fill: shapeFill(node, 'circle', stroke.strokeWidth),
    uuid: uuidOf(node),
    locked: parseFlag(node, 'locked'),
    _raw: node
  }
}

export function parseFpRect(node: SExprList): KicadFpRect {
  const stroke = parseStrokeWidth(node)
  const start = getXYNm(node, 'start') ?? { x: nm(0), y: nm(0) }
  const end = getXYNm(node, 'end') ?? { x: nm(0), y: nm(0) }
  const radiusAtom = childValue(node, 'radius')
  const limit = Math.min(Math.abs(end.x - start.x), Math.abs(end.y - start.y)) / 2
  const radius = radiusAtom ? Math.min(mmAtomToNm(radiusAtom), limit) : 0
  return {
    start,
    end,
    ...(radius > 0 ? { radius: nm(radius) } : {}),
    layer: childValue(node, 'layer'),
    strokeWidth: stroke.strokeWidth,
    strokeType: stroke.strokeType,
    strokeColor: stroke.strokeColor,
    fill: shapeFill(node, 'rect', stroke.strokeWidth),
    uuid: uuidOf(node),
    locked: parseFlag(node, 'locked'),
    _raw: node
  }
}

export function parseFpPoly(node: SExprList): KicadFpPoly {
  const stroke = parseStrokeWidth(node)
  return {
    points: parsePointList(findChild(node, 'pts')),
    layer: childValue(node, 'layer'),
    strokeWidth: stroke.strokeWidth,
    strokeType: stroke.strokeType,
    strokeColor: stroke.strokeColor,
    fill: shapeFill(node, 'poly', stroke.strokeWidth),
    uuid: uuidOf(node),
    locked: parseFlag(node, 'locked'),
    _raw: node
  }
}

export function parseFpCurve(node: SExprList): KicadFpCurve {
  return {
    points: parsePointList(findChild(node, 'pts')),
    layer: childValue(node, 'layer'),
    ...parseStrokeWidth(node),
    uuid: uuidOf(node),
    locked: parseFlag(node, 'locked'),
    _raw: node
  }
}

/**
 * The text a text box holds: its first atom, stepping over the bare `locked`
 * older files wrote before it (`parseTextBoxContent`).
 */
const textBoxText = (node: SExprList): string => {
  for (let i = 1; i < node.children.length; i++) {
    const child = node.children[i]
    if (child.type !== 'atom') continue
    if (!child.quoted && child.value === 'locked') continue
    return child.value
  }
  return ''
}

export function parseFpTextBox(node: SExprList): KicadFpTextBox {
  const stroke = parseStrokeWidth(node)
  const marginsNode = findChild(node, 'margins')
  const m = marginsNode ? getAtomValues(marginsNode) : []
  const borderNode = findChild(node, 'border')
  const ptsNode = findChild(node, 'pts')
  return {
    text: textBoxText(node),
    start: getXYNm(node, 'start') ?? undefined,
    end: getXYNm(node, 'end') ?? undefined,
    points: ptsNode ? parsePointList(ptsNode) : undefined,
    margins:
      m.length >= 4
        ? {
            left: mmAtomToNm(m[0]),
            top: mmAtomToNm(m[1]),
            right: mmAtomToNm(m[2]),
            bottom: mmAtomToNm(m[3])
          }
        : undefined,
    angle: numChild(node, 'angle') ?? 0,
    layer: childValue(node, 'layer'),
    fontEffects: parseFontEffects(node),
    // Before `(border …)` existed a box had one exactly when its stroke had a
    // non-negative width, and no stroke node read as width -1.
    border: borderNode
      ? getFirstAtomValue(borderNode) !== 'no'
      : stroke.strokeWidth !== undefined && stroke.strokeWidth >= 0,
    strokeWidth: stroke.strokeWidth,
    strokeType: stroke.strokeType,
    knockout: parseFlag(node, 'knockout'),
    uuid: uuidOf(node),
    locked: parseFlag(node, 'locked'),
    _raw: node
  }
}

function parseTableCell(node: SExprList): KicadTableCell {
  const span = findChild(node, 'span')
  const atoms = span ? getAtomValues(span) : []
  return {
    ...parseFpTextBox(node),
    colSpan: atoms.length >= 1 ? Number(atoms[0]) : 1,
    rowSpan: atoms.length >= 2 ? Number(atoms[1]) : 1
  }
}

/** A `(border …)` / `(separators …)` switch: KiCad's constructor has them all on. */
const tableSwitch = (node: SExprList | null, token: string): boolean => {
  const child = node ? findChild(node, token) : null
  return child ? getFirstAtomValue(child) !== 'no' : true
}

const tableStrokeWidth = (node: SExprList | null): Nm | undefined =>
  node ? parseStrokeWidth(node).strokeWidth : undefined

export function parseTable(node: SExprList): KicadTable {
  const border = findChild(node, 'border')
  const separators = findChild(node, 'separators')
  const widths = findChild(node, 'column_widths')
  const heights = findChild(node, 'row_heights')
  const cells = findChild(node, 'cells')
  return {
    columnCount: numChild(node, 'column_count') ?? 1,
    layer: childValue(node, 'layer'),
    borderExternal: tableSwitch(border, 'external'),
    borderHeader: tableSwitch(border, 'header'),
    borderStrokeWidth: tableStrokeWidth(border),
    separatorRows: tableSwitch(separators, 'rows'),
    separatorCols: tableSwitch(separators, 'cols'),
    separatorStrokeWidth: tableStrokeWidth(separators),
    columnWidths: widths ? getAtomValues(widths).map(mmAtomToNm) : [],
    rowHeights: heights ? getAtomValues(heights).map(mmAtomToNm) : [],
    cells: cells ? findChildren(cells, 'table_cell').map(parseTableCell) : [],
    uuid: uuidOf(node),
    locked: parseFlag(node, 'locked'),
    _raw: node
  }
}

/** KiCad's `DEFAULT_PT_SIZE_MM`: a point written without `(size …)` is 1 mm. */
export const DEFAULT_POINT_SIZE = nm(1_000_000)

export function parsePoint(node: SExprList): KicadPoint {
  const sizeNode = findChild(node, 'size')
  return {
    position: getXYNm(node, 'at') ?? { x: nm(0), y: nm(0) },
    size: sizeNode ? getNmValue(sizeNode, DEFAULT_POINT_SIZE) : DEFAULT_POINT_SIZE,
    layer: childValue(node, 'layer'),
    uuid: uuidOf(node),
    locked: false,
    _raw: node
  }
}

// ---------------------------------------------------------------------------
// 3D Model parsing
// ---------------------------------------------------------------------------

function parseModel3D(node: SExprList): KicadModel3D {
  const xyzAtoms = (parent: SExprList, token: string): string[] | undefined => {
    const child = findChild(parent, token)
    if (!child) return undefined
    const xyz = findChild(child, 'xyz')
    if (!xyz) return undefined
    const atoms = getAtomValues(xyz)
    return atoms.length < 3 ? undefined : atoms
  }
  // Offset is the one DISTANCE here; scale is a multiplier and rotate degrees,
  // which is why they read through different converters despite one grammar.
  const parseXYZ = (
    parent: SExprList,
    token: string
  ): { x: number; y: number; z: number } | undefined => {
    const atoms = xyzAtoms(parent, token)
    if (!atoms) return undefined
    return { x: parseFloat(atoms[0]), y: parseFloat(atoms[1]), z: parseFloat(atoms[2]) }
  }
  const parseXYZNm = (parent: SExprList, token: string): { x: Nm; y: Nm; z: Nm } | undefined => {
    const atoms = xyzAtoms(parent, token)
    if (!atoms) return undefined
    return { x: mmAtomToNm(atoms[0]), y: mmAtomToNm(atoms[1]), z: mmAtomToNm(atoms[2]) }
  }

  return {
    path: getFirstAtomValue(node) ?? '',
    offset: parseXYZNm(node, 'offset'),
    scale: parseXYZ(node, 'scale'),
    rotate: parseXYZ(node, 'rotate'),
    _raw: node
  }
}

// ---------------------------------------------------------------------------
// Zone parsing
// ---------------------------------------------------------------------------

export function parseZone(node: SExprList): KicadZone {
  const netNode = findChild(node, 'net')
  let net: number | undefined
  let netName: string | undefined
  if (netNode) {
    const netAtoms = getAtomValues(netNode)
    if (netAtoms.length >= 1) {
      net = parseInt(netAtoms[0])
    }
    if (netAtoms.length >= 2) {
      netName = netAtoms[1]
    }
  }
  netName = childValue(node, 'net_name') ?? netName

  const hatchNode = findChild(node, 'hatch')
  let hatchStyle: KicadZone['hatchStyle'] = 'none'
  let hatchPitch: Nm | undefined
  if (hatchNode) {
    const hatchAtoms = getAtomValues(hatchNode)
    const style = hatchAtoms[0]
    if (style === 'edge' || style === 'full' || style === 'none') {
      hatchStyle = style
    }
    if (hatchAtoms.length >= 2) {
      hatchPitch = mmAtomToNm(hatchAtoms[1])
    }
  }

  const minThicknessNode = findChild(node, 'min_thickness')

  const [polyNode, ...cutoutNodes] = findChildren(node, 'polygon')
  const points = parsePointList(polyNode ? findChild(polyNode, 'pts') : null)
  const holes = cutoutNodes
    .map((cutout) => parsePointList(findChild(cutout, 'pts')))
    .filter((hole) => hole.length >= 3)

  const filledPolys: Array<Array<{ x: Nm; y: Nm }>> = []
  for (const fpNode of findChildren(node, 'filled_polygon')) {
    const polyPts = parsePointList(findChild(fpNode, 'pts'))
    if (polyPts.length > 0) {
      filledPolys.push(polyPts)
    }
  }

  const layersNode = findChild(node, 'layers')
  const singleLayer = childValue(node, 'layer')
  const layers = layersNode ? getAtomValues(layersNode) : singleLayer ? [singleLayer] : ['F.Cu']
  const keepoutRules = parseKeepoutRules(node)

  return {
    net,
    netName,
    layer: singleLayer ?? layers[0] ?? 'F.Cu',
    layers,
    tconnect: childValue(node, 'tconnect'),
    hatchStyle,
    hatchPitch,
    minThickness: minThicknessNode ? getNmValue(minThicknessNode) : undefined,
    isKeepout: keepoutRules !== undefined,
    keepoutRules,
    points,
    ...(holes.length ? { holes } : {}),
    filledPolys: filledPolys.length > 0 ? filledPolys : undefined,
    uuid: uuidOf(node),
    _raw: node
  }
}

// ---------------------------------------------------------------------------
// Serializer: KicadFootprint → string
// ---------------------------------------------------------------------------

/**
 * Serialize a KicadFootprint back to .kicad_mod format.
 *
 * Strategy: We use the stored _raw AST nodes for round-trip fidelity.
 * If a _raw node exists, serialize it directly. This preserves any
 * formatting, comments, and unknown tokens from the original file.
 */
export function serializeKicadFootprint(fp: KicadFootprint): string {
  return serializeSExpr(fp._raw)
}

// ---------------------------------------------------------------------------
// Convenience: Get reference/value text from either v6 fp_text or v8 property
// ---------------------------------------------------------------------------

/** Get the reference designator text (e.g., "REF**") */
export function getReference(fp: KicadFootprint): string | undefined {
  // v8+ property style
  const refProp = fp.properties.find((p) => p.key === 'Reference')
  if (refProp) return refProp.value

  // v5/v6 fp_text style
  const refText = fp.fpTexts.find((t) => t.type === 'reference')
  if (refText) return refText.text

  return undefined
}

/** Get the value text (e.g., component value) */
export function getValue(fp: KicadFootprint): string | undefined {
  // v8+ property style
  const valProp = fp.properties.find((p) => p.key === 'Value')
  if (valProp) return valProp.value

  // v5/v6 fp_text style
  const valText = fp.fpTexts.find((t) => t.type === 'value')
  if (valText) return valText.text

  return undefined
}

/** Set the reference or value text, in whichever form the footprint carries it. */
export function setFootprintFieldText(
  fp: KicadFootprint,
  which: 'reference' | 'value',
  text: string
): void {
  const prop = fp.properties.find((p) => p.key === (which === 'reference' ? 'Reference' : 'Value'))
  if (prop) {
    updatePropertyInAST(prop, { value: text })
    return
  }
  const fpText = fp.fpTexts.find((t) => t.type === which)
  if (fpText) updateTextInAST(fpText, { text })
}

/** What a footprint's own text can refer to. A library footprint and a board
 *  one both have these, with different shapes for the rest. */
export interface FootprintTextScope {
  name?: string
  layer?: string
  reference?: string
  value?: string
}

/**
 * KiCad's text variables in a footprint's own text, resolved from the
 * footprint: `${REFERENCE}` on the fab layer draws `REF**` in the library and
 * `R5` on a board, `${VALUE}` the value, `${FOOTPRINT_NAME}` the name and
 * `${LAYER}` the side. Anything else — a project variable, a typo — stays as
 * written, which is what KiCad draws for a variable it cannot resolve.
 */
export function expandFootprintText(text: string, scope: FootprintTextScope): string {
  if (!text.includes('${')) return text
  return text.replace(/\$\{([A-Z_]+)\}/g, (whole, name: string) => {
    switch (name) {
      case 'REFERENCE':
        return scope.reference ?? whole
      case 'VALUE':
        return scope.value ?? whole
      case 'FOOTPRINT_NAME':
        return scope.name ?? whole
      case 'LAYER':
        return scope.layer ?? whole
      default:
        return whole
    }
  })
}

/** The scope a library footprint's text resolves in. */
export const footprintTextScope = (fp: KicadFootprint): FootprintTextScope => ({
  name: fp.name,
  layer: fp.layer,
  reference: getReference(fp),
  value: getValue(fp)
})

// ---------------------------------------------------------------------------
// AST edit primitives (Visual -> AST round-trip)
//
// All mutations write through to the _raw AST so that serialization
// preserves formatting and unknown nodes. New atoms inherit the parent
// node's source position (positions are only used for error reporting).
// ---------------------------------------------------------------------------

// The generic builders live with the S-expression core; re-exported for the
// many callers that import them from here.
export { makeAtom, makeList, findOrCreateChild, setNodeValue, setScalarChild } from './sexpr'

/** Update the i-th positional atom of a node (e.g. pad number/type/shape). */
export function setPositionalAtom(
  root: SExprList,
  index: number,
  value: string,
  quoted?: boolean
): void {
  const child = root.children[index]
  if (child && child.type === 'atom') {
    updateAtom(child, value, quoted ?? child.quoted)
  }
}

/** Set a (token X Y) child, creating or resizing it as needed. */
/** Set a (token X Y) child from integer nanometers. */
export function setXYChild(root: SExprList, token: string, x: Nm, y: Nm): void {
  const node = findOrCreateChild(root, token)
  const at = node.start
  if (node.children.length < 3) {
    node.children = [
      makeAtom(token, false, at),
      makeAtom(formatNmAtom(x), false, at),
      makeAtom(formatNmAtom(y), false, at)
    ]
  } else {
    updateAtom(node.children[1], formatNmAtom(x), false)
    updateAtom(node.children[2], formatNmAtom(y), false)
  }
}

/**
 * Set the (at X Y [angle]) child from nm coordinates, adding or dropping the
 * optional angle — which stays degrees through `formatKicadNumber`.
 */
export function setAtChild(root: SExprList, x: Nm, y: Nm, angle?: number): void {
  setXYChild(root, 'at', x, y)
  const node = findChild(root, 'at')!
  if (angle !== undefined) {
    if (node.children.length < 4) {
      node.children.push(makeAtom(formatKicadNumber(angle), false, node.start))
    } else {
      updateAtom(node.children[3], formatKicadNumber(angle), false)
    }
  } else if (node.children.length >= 4) {
    node.children = node.children.slice(0, 3)
  }
}

/** Replace the (pts (xy ..) ...) child of `root` from nm points. */
export function setPointsChild(root: SExprList, points: Array<{ x: Nm; y: Nm }>): void {
  const ptsNode = findOrCreateChild(root, 'pts')
  const at = ptsNode.start
  const children: SExprNode[] = [makeAtom('pts', false, at)]
  for (const pt of points) {
    children.push({
      type: 'list',
      children: [
        makeAtom('xy', false, at),
        makeAtom(formatNmAtom(pt.x), false, at),
        makeAtom(formatNmAtom(pt.y), false, at)
      ],
      start: at,
      end: at
    })
  }
  ptsNode.children = children
}

/**
 * Set the stroke width (nm), handling both v7+ (stroke (width w)) and legacy
 * v6 bare (width w) styles; creates a v7 stroke node when neither exists.
 */
export function setStrokeWidthChild(root: SExprList, width: Nm): void {
  const strokeNode = findChild(root, 'stroke')
  const bareWidthNode = strokeNode ? null : findChild(root, 'width')
  if (bareWidthNode) {
    setNodeValue(bareWidthNode, formatNmAtom(width))
  } else {
    setScalarChild(strokeNode ?? findOrCreateChild(root, 'stroke'), 'width', formatNmAtom(width))
  }
}

// Aliases from the stage-1 migration, when these writers briefly had mm and nm
// twins; the nm behavior is now the only one. Kept so stage-1 call sites need
// no rename — retire with the next pass over their importers.
export const setXYChildNm = setXYChild
export const setAtChildNm = setAtChild
export const setPointsChildNm = setPointsChild
export const setStrokeWidthChildNm = setStrokeWidthChild

/**
 * The `(stroke …)` child, created when absent — migrating a legacy bare
 * `(width w)` into it so stroke type/color have a home in v7+ form.
 */
function ensureStrokeNode(root: SExprList): SExprList {
  let stroke = findChild(root, 'stroke')
  if (stroke) return stroke
  const at = root.start
  stroke = makeList([makeAtom('stroke', false, at)], at)
  const bareWidth = findChild(root, 'width')
  if (bareWidth) {
    root.children = root.children.filter((c) => c !== bareWidth)
    stroke.children.push(bareWidth)
  }
  root.children.push(stroke)
  return stroke
}

/** Set the stroke line style (`default`/`dash`/`dot`/…) on a graphic node. */
export function setStrokeTypeChild(root: SExprList, type: string): void {
  setScalarChild(ensureStrokeNode(root), 'type', type)
}

/** Set the stroke color, or clear the override when `color` is null. */
export function setStrokeColorChild(root: SExprList, color: Rgba | null): void {
  const stroke = ensureStrokeNode(root)
  if (color) setColorChild(stroke, color)
  else removeColorChild(stroke)
}

/** Toggle a bare flag atom (e.g. `locked`) directly on a node. */
export function setFlagAtom(root: SExprList, token: string, value: boolean): void {
  const idx = root.children.findIndex((c) => c.type === 'atom' && !c.quoted && c.value === token)
  if (value) {
    if (idx < 0) root.children.push(makeAtom(token, false, root.start))
  } else if (idx >= 0) {
    root.children.splice(idx, 1)
  }
}

/** Rewrite the `(attr …)` child from a list of attribute tokens (empty removes it). */
/** The order KiCad writes a footprint's `(attr …)` flags in (`PCB_IO_KICAD_SEXPR::format`). */
export const FOOTPRINT_ATTR_ORDER = [
  'smd',
  'through_hole',
  'board_only',
  'exclude_from_pos_files',
  'exclude_from_bom',
  'allow_missing_courtyard',
  'dnp',
  'allow_soldermask_bridges'
]

/** Children a new `(attr …)` follows, as KiCad places it. */
const BEFORE_ATTR = new Set(['sheetfile', 'sheetname', 'path', 'property', 'tags', 'descr'])

/** Rewrite the `(attr …)` flags in KiCad's order, any it does not know kept after. */
export function setAttrChild(root: SExprList, attrs: string[]): void {
  const existing = findChild(root, 'attr')
  if (attrs.length === 0) {
    if (existing) root.children = root.children.filter((c) => c !== existing)
    return
  }
  const ordered = [
    ...FOOTPRINT_ATTR_ORDER.filter((token) => attrs.includes(token)),
    ...attrs.filter((token) => !FOOTPRINT_ATTR_ORDER.includes(token))
  ]
  const at = (existing ?? root).start
  const node = existing ?? makeList([makeAtom('attr', false, at)], at)
  node.children = [makeAtom('attr', false, at), ...ordered.map((a) => makeAtom(a, false, at))]
  if (existing) return
  const after = root.children.findLastIndex((child) => BEFORE_ATTR.has(getToken(child) ?? ''))
  root.children.splice(after >= 0 ? after + 1 : root.children.length, 0, node)
}

/**
 * Toggle a yes/no flag, tolerating both encodings: an existing `(token yes|no)`
 * child is updated in place; otherwise a bare `token` atom is added/removed.
 */
export function setBoolFlag(root: SExprList, token: string, value: boolean): void {
  if (findChild(root, token)) {
    setScalarChild(root, token, value ? 'yes' : 'no')
    return
  }
  setFlagAtom(root, token, value)
}

/** Rewrite the `(justify …)` child of an `(effects …)` node (empty removes it). */
function setJustifyChild(
  effects: SExprList,
  hAlign: 'left' | 'center' | 'right' | undefined,
  vAlign: 'top' | 'center' | 'bottom' | undefined,
  mirror: boolean | undefined
): void {
  const existing = findChild(effects, 'justify')
  const atoms = existing ? getAtomValues(existing) : []
  let h = atoms.find((a) => a === 'left' || a === 'right')
  let v = atoms.find((a) => a === 'top' || a === 'bottom')
  let m = atoms.includes('mirror')
  if (hAlign !== undefined) h = hAlign === 'center' ? undefined : hAlign
  if (vAlign !== undefined) v = vAlign === 'center' ? undefined : vAlign
  if (mirror !== undefined) m = mirror
  const tokens = [h, v, m ? 'mirror' : undefined].filter((t): t is string => Boolean(t))
  if (tokens.length === 0) {
    if (existing) effects.children = effects.children.filter((c) => c !== existing)
    return
  }
  const at = effects.start
  const node = existing ?? makeList([makeAtom('justify', false, at)], at)
  node.children = [makeAtom('justify', false, at), ...tokens.map((t) => makeAtom(t, false, at))]
  if (!existing) effects.children.push(node)
}

/** Write `(effects (font …) (justify …))` fields onto a text/property node. */
export function setFontEffectsChild(root: SExprList, effects: KicadFontEffects): void {
  const eff = findOrCreateChild(root, 'effects')
  const font = findOrCreateChild(eff, 'font')
  const size = findChild(font, 'size')
  const sizeAtoms = size ? getAtomValues(size) : []
  const curH = sizeAtoms.length >= 1 ? mmAtomToNm(sizeAtoms[0]) : nm(1270000)
  const curW = sizeAtoms.length >= 2 ? mmAtomToNm(sizeAtoms[1]) : curH
  setXYChild(font, 'size', effects.height ?? curH, effects.width ?? curW)
  if (effects.thickness !== undefined)
    setScalarChild(font, 'thickness', formatNmAtom(effects.thickness))
  if (effects.bold !== undefined) setBoolFlag(font, 'bold', effects.bold)
  if (effects.italic !== undefined) setBoolFlag(font, 'italic', effects.italic)
  setJustifyChild(eff, effects.hAlign ?? 'center', effects.vAlign ?? 'center', effects.mirror)
}

// ---------------------------------------------------------------------------
// AST synchronization: domain mutations that write through to the AST
// ---------------------------------------------------------------------------

/**
 * The footprint-level children KiCad writes, in its order
 * (`PCB_IO_KICAD_SEXPR::format( FOOTPRINT* )`): a child this module creates goes
 * before the first existing one that KiCad writes after it, so a new row lands
 * where KiCad would have put it rather than after the last pad.
 */
const FOOTPRINT_CHILD_ORDER = [
  'version',
  'generator',
  'generator_version',
  'layer',
  'uuid',
  'at',
  'descr',
  'tags',
  'property',
  'component_classes',
  'path',
  'sheetname',
  'sheetfile',
  'units',
  'solder_mask_margin',
  'solder_paste_margin',
  'solder_paste_margin_ratio',
  'solder_paste_ratio',
  'clearance',
  'zone_connect',
  'attr'
]

/**
 * Set or, with `null`, remove a `(token value)` child of the footprint node,
 * creating it at KiCad's position in the child order.
 */
export function setFootprintChild(
  root: SExprList,
  token: string,
  value: string | null,
  quoted = false
): void {
  const existing = findChild(root, token)
  if (value === null) {
    if (existing) root.children = root.children.filter((c) => c !== existing)
    return
  }
  if (existing) {
    setNodeValue(existing, value, quoted)
    return
  }
  const rank = FOOTPRINT_CHILD_ORDER.indexOf(token)
  const node = makeList(
    [makeAtom(token, false, root.start), makeAtom(value, quoted, root.start)],
    root.start
  )
  const before = root.children.findIndex((child, i) => {
    if (i === 0 || child.type !== 'list') return false
    const other = FOOTPRINT_CHILD_ORDER.indexOf(getToken(child) ?? '')
    // Anything KiCad does not order here (pads, graphics, …) is written after these rows.
    return other < 0 ? true : other > rank
  })
  if (before < 0) root.children.push(node)
  else root.children.splice(before, 0, node)
}

/** The footprint-level fields `updateFootprintMetaInAST` writes; `null` clears an inheriting one. */
export interface FootprintMetaPatch {
  name?: string
  layer?: string
  description?: string
  tags?: string
  locked?: boolean
  attributes?: string[]
  solderMaskMargin?: Nm | null
  solderPasteMargin?: Nm | null
  solderPasteMarginRatio?: number | null
  clearance?: Nm | null
  zoneConnect?: number | null
}

export function updateFootprintMetaInAST(fp: KicadFootprint, data: FootprintMetaPatch): void {
  markNodeDirty(fp._raw)
  const root = fp._raw as SExprList
  if (data.name !== undefined) {
    fp.name = data.name
    setPositionalAtom(root, 1, data.name)
  }
  if (data.layer !== undefined) {
    fp.layer = data.layer
    setScalarChild(root, 'layer', data.layer, true)
  }
  if (data.description !== undefined) {
    fp.description = data.description
    setScalarChild(root, 'descr', data.description, true)
  }
  if (data.locked !== undefined) {
    fp.locked = data.locked
    setFlagAtom(root, 'locked', data.locked)
  }
  if (data.attributes !== undefined) {
    fp.attributes = data.attributes
    setAttrChild(root, data.attributes)
  }
  if (data.tags !== undefined) {
    fp.tags = data.tags || undefined
    setFootprintChild(root, 'tags', data.tags || null, true)
  }
  const distance = (token: string, value: Nm | null): Nm | undefined => {
    setFootprintChild(root, token, value === null ? null : formatNmAtom(value))
    return value ?? undefined
  }
  if (data.solderMaskMargin !== undefined) {
    fp.solderMaskMargin = distance('solder_mask_margin', data.solderMaskMargin)
  }
  if (data.solderPasteMargin !== undefined) {
    fp.solderPasteMargin = distance('solder_paste_margin', data.solderPasteMargin)
  }
  if (data.clearance !== undefined) fp.clearance = distance('clearance', data.clearance)
  if (data.solderPasteMarginRatio !== undefined) {
    const ratio = data.solderPasteMarginRatio
    fp.solderPasteMarginRatio = ratio ?? undefined
    // The legacy spelling goes when the current one is written.
    setFootprintChild(root, 'solder_paste_ratio', null)
    setFootprintChild(
      root,
      'solder_paste_margin_ratio',
      ratio === null ? null : formatKicadNumber(ratio)
    )
  }
  if (data.zoneConnect !== undefined) {
    const connect = data.zoneConnect
    fp.zoneConnect = connect ?? undefined
    setFootprintChild(root, 'zone_connect', connect === null ? null : String(connect))
  }
}

/** A pad edit; an override set to null is removed, inheriting the footprint's or board's. */
export type PadPatch = Omit<
  Partial<KicadPad>,
  'solderMaskMargin' | 'solderPasteMargin' | 'solderPasteMarginRatio' | 'clearance'
> & {
  solderMaskMargin?: Nm | null
  solderPasteMargin?: Nm | null
  solderPasteMarginRatio?: number | null
  clearance?: Nm | null
  /** The pad's `(teardrops …)` settings, written whole. */
  teardrops?: TeardropParams
}

export function updatePadInAST(pad: KicadPad, data: PadPatch): void {
  const root = pad._raw as SExprList
  markNodeDirty(root)

  if (data.teardrops !== undefined) writeTeardropParams(root, data.teardrops, 'pad', root)

  if (data.number !== undefined) {
    pad.number = data.number
    setPositionalAtom(root, 1, data.number)
  }
  if (data.type !== undefined) {
    pad.type = data.type
    setPositionalAtom(root, 2, data.type, false)
  }
  if (data.shape !== undefined) {
    pad.shape = data.shape
    setPositionalAtom(root, 3, data.shape, false)
  }
  if (data.position !== undefined) {
    pad.position = { ...pad.position, ...data.position }
    setAtChild(root, pad.position.x, pad.position.y, pad.position.angle)
  }
  if (data.size !== undefined) {
    pad.size = { ...pad.size, ...data.size }
    setXYChild(root, 'size', pad.size.w, pad.size.h)
  }
  if (data.drill !== undefined) {
    pad.drill = { ...pad.drill, ...data.drill }
    const d = pad.drill
    const drillNode = findOrCreateChild(root, 'drill')
    const at = drillNode.start
    const children: SExprNode[] = [makeAtom('drill', false, at)]
    if (d.oval) {
      children.push(
        makeAtom('oval', false, at),
        makeAtom(formatNmAtom(d.oval.width), false, at),
        makeAtom(formatNmAtom(d.oval.height), false, at)
      )
    } else if (d.diameter !== undefined) {
      children.push(makeAtom(formatNmAtom(d.diameter), false, at))
    }
    if (d.offset) {
      children.push(
        makeList(
          [
            makeAtom('offset', false, at),
            makeAtom(formatNmAtom(d.offset.x), false, at),
            makeAtom(formatNmAtom(d.offset.y), false, at)
          ],
          at
        )
      )
    }
    drillNode.children = children
  }
  if (data.roundrectRatio !== undefined) {
    pad.roundrectRatio = data.roundrectRatio
    setScalarChild(root, 'roundrect_rratio', data.roundrectRatio.toString())
  }
  // The four local overrides: null removes the row, so the board's value applies.
  const override = (
    key: 'solderMaskMargin' | 'solderPasteMargin' | 'solderPasteMarginRatio' | 'clearance',
    token: string,
    format: (v: number) => string
  ): void => {
    const v = data[key]
    if (v === undefined) return
    if (v === null) {
      delete pad[key]
      root.children = root.children.filter((c) => !(c.type === 'list' && getToken(c) === token))
      return
    }
    ;(pad as Record<typeof key, number>)[key] = v
    setScalarChild(root, token, format(v))
  }
  override('solderMaskMargin', 'solder_mask_margin', (v) => formatNmAtom(v as Nm))
  override('solderPasteMargin', 'solder_paste_margin', (v) => formatNmAtom(v as Nm))
  override('solderPasteMarginRatio', 'solder_paste_margin_ratio', (v) => v.toString())
  override('clearance', 'clearance', (v) => formatNmAtom(v as Nm))
}

export function updateLineInAST(line: KicadFpLine, data: Partial<KicadFpLine>): void {
  const root = line._raw as SExprList
  markNodeDirty(root)

  if (data.start !== undefined) {
    line.start = { ...line.start, ...data.start }
    setXYChild(root, 'start', line.start.x, line.start.y)
  }
  if (data.end !== undefined) {
    line.end = { ...line.end, ...data.end }
    setXYChild(root, 'end', line.end.x, line.end.y)
  }
  if (data.layer !== undefined) {
    line.layer = data.layer
    setScalarChild(root, 'layer', data.layer, true)
  }
  if (data.strokeWidth !== undefined) {
    line.strokeWidth = data.strokeWidth
    setStrokeWidthChild(root, data.strokeWidth)
  }
  if (data.strokeType !== undefined) {
    line.strokeType = data.strokeType
    setStrokeTypeChild(root, data.strokeType)
  }
  if (data.strokeColor !== undefined) {
    line.strokeColor = data.strokeColor
    setStrokeColorChild(root, data.strokeColor)
  }
}

export function updatePolyInAST(poly: KicadFpPoly, data: Partial<KicadFpPoly>): void {
  const root = poly._raw as SExprList
  markNodeDirty(root)

  if (data.layer !== undefined) {
    poly.layer = data.layer
    setScalarChild(root, 'layer', data.layer, true)
  }
  if (data.strokeWidth !== undefined) {
    poly.strokeWidth = data.strokeWidth
    setStrokeWidthChild(root, data.strokeWidth)
  }
  if (data.strokeColor !== undefined) {
    poly.strokeColor = data.strokeColor
    setStrokeColorChild(root, data.strokeColor)
  }
  if (data.strokeType !== undefined) {
    poly.strokeType = data.strokeType
    setStrokeTypeChild(root, data.strokeType)
  }
  if (data.fill !== undefined) {
    poly.fill = data.fill
    setScalarChild(root, 'fill', data.fill)
  }
  if (data.points !== undefined) {
    poly.points = data.points
    setPointsChild(root, data.points)
  }
}

export function updateArcInAST(arc: KicadFpArc, data: Partial<KicadFpArc>): void {
  const root = arc._raw as SExprList
  markNodeDirty(root)
  if (data.start !== undefined) {
    arc.start = { ...arc.start, ...data.start }
    setXYChild(root, 'start', arc.start.x, arc.start.y)
  }
  if (data.mid !== undefined) {
    arc.mid = { ...arc.mid, ...data.mid }
    setXYChild(root, 'mid', arc.mid.x, arc.mid.y)
  }
  if (data.end !== undefined) {
    arc.end = { ...arc.end, ...data.end }
    setXYChild(root, 'end', arc.end.x, arc.end.y)
  }
  if (data.layer !== undefined) {
    arc.layer = data.layer
    setScalarChild(root, 'layer', data.layer, true)
  }
  if (data.strokeWidth !== undefined) {
    arc.strokeWidth = data.strokeWidth
    setStrokeWidthChild(root, data.strokeWidth)
  }
  if (data.strokeType !== undefined) {
    arc.strokeType = data.strokeType
    setStrokeTypeChild(root, data.strokeType)
  }
  if (data.strokeColor !== undefined) {
    arc.strokeColor = data.strokeColor
    setStrokeColorChild(root, data.strokeColor)
  }
}

export function updateCircleInAST(circle: KicadFpCircle, data: Partial<KicadFpCircle>): void {
  const root = circle._raw as SExprList
  markNodeDirty(root)
  if (data.center !== undefined) {
    circle.center = { ...circle.center, ...data.center }
    setXYChild(root, 'center', circle.center.x, circle.center.y)
  }
  if (data.end !== undefined) {
    circle.end = { ...circle.end, ...data.end }
    setXYChild(root, 'end', circle.end.x, circle.end.y)
  }
  if (data.layer !== undefined) {
    circle.layer = data.layer
    setScalarChild(root, 'layer', data.layer, true)
  }
  if (data.strokeWidth !== undefined) {
    circle.strokeWidth = data.strokeWidth
    setStrokeWidthChild(root, data.strokeWidth)
  }
  if (data.strokeColor !== undefined) {
    circle.strokeColor = data.strokeColor
    setStrokeColorChild(root, data.strokeColor)
  }
  if (data.strokeType !== undefined) {
    circle.strokeType = data.strokeType
    setStrokeTypeChild(root, data.strokeType)
  }
  if (data.fill !== undefined) {
    circle.fill = data.fill
    setScalarChild(root, 'fill', data.fill)
  }
}

export function updateRectInAST(rect: KicadFpRect, data: Partial<KicadFpRect>): void {
  const root = rect._raw as SExprList
  markNodeDirty(root)
  if (data.start !== undefined) {
    rect.start = { ...rect.start, ...data.start }
    setXYChild(root, 'start', rect.start.x, rect.start.y)
  }
  if (data.end !== undefined) {
    rect.end = { ...rect.end, ...data.end }
    setXYChild(root, 'end', rect.end.x, rect.end.y)
  }
  if (data.layer !== undefined) {
    rect.layer = data.layer
    setScalarChild(root, 'layer', data.layer, true)
  }
  if (data.strokeWidth !== undefined) {
    rect.strokeWidth = data.strokeWidth
    setStrokeWidthChild(root, data.strokeWidth)
  }
  if (data.strokeColor !== undefined) {
    rect.strokeColor = data.strokeColor
    setStrokeColorChild(root, data.strokeColor)
  }
  if (data.strokeType !== undefined) {
    rect.strokeType = data.strokeType
    setStrokeTypeChild(root, data.strokeType)
  }
  if (data.radius !== undefined) {
    // KiCad 10's corner radius; zero is a square corner, written as no token.
    rect.radius = data.radius > 0 ? data.radius : undefined
    if (data.radius > 0) setScalarChild(root, 'radius', formatNmAtom(data.radius))
    else
      root.children = root.children.filter((c) => !(c.type === 'list' && getToken(c) === 'radius'))
  }
  if (data.fill !== undefined) {
    rect.fill = data.fill
    setScalarChild(root, 'fill', data.fill)
  }
}

/**
 * A zone outline's display hatch, `(hatch style [pitch])`, on a board's zone
 * or a footprint's: edge and half a millimeter when either is unset. The node
 * has a variable shape, so it is rebuilt wholesale rather than patched.
 */
export function setZoneHatchChild(
  root: SExprList,
  hatchStyle: 'none' | 'edge' | 'full' | undefined,
  hatchPitch: Nm | undefined
): void {
  const style = hatchStyle ?? 'edge'
  const node = findOrCreateChild(root, 'hatch')
  const at = node.start
  node.children = [makeAtom('hatch', false, at), makeAtom(style, false, at)]
  if (style !== 'none')
    node.children.push(makeAtom(formatNmAtom(hatchPitch ?? nm(500000)), false, at))
}

export function updateZoneInAST(zone: KicadZone, data: Partial<KicadZone>): void {
  const root = zone._raw as SExprList
  markNodeDirty(root)

  if (data.points !== undefined) {
    zone.points = data.points
    setPointsChild(findOrCreateChild(root, 'polygon'), data.points)
  }
  if (data.layer !== undefined) {
    zone.layer = data.layer
    setScalarChild(root, 'layer', data.layer, true)
  }
  if (data.minThickness !== undefined) {
    zone.minThickness = data.minThickness
    setScalarChild(root, 'min_thickness', formatNmAtom(data.minThickness))
  }
  if (data.hatchStyle !== undefined || data.hatchPitch !== undefined) {
    if (data.hatchStyle !== undefined) zone.hatchStyle = data.hatchStyle
    if (data.hatchPitch !== undefined) zone.hatchPitch = data.hatchPitch
    setZoneHatchChild(root, zone.hatchStyle, zone.hatchPitch)
  }
  if (data.keepoutRules !== undefined && zone.keepoutRules) {
    // Only a rule area's existing (keepout …) is edited: a zone does not become one here.
    const keepout = findChild(root, 'keepout')
    if (keepout) {
      zone.keepoutRules = { ...zone.keepoutRules, ...data.keepoutRules }
      for (const [key, allowed] of Object.entries(data.keepoutRules)) {
        if (allowed !== undefined) setScalarChild(keepout, key, allowed ? 'allowed' : 'not_allowed')
      }
    }
  }
}

/**
 * A text's knockout and keep-upright switches, written as KiCad writes them:
 * `knockout` as an atom inside `(layer …)`, and a text that is not kept upright
 * as `(unlocked yes)` right after its `(at …)` (`PCB_IO_KICAD_SEXPR::format`).
 */
export function setTextSwitchesInAST(
  root: SExprList,
  data: { knockout?: boolean; keepUpright?: boolean }
): void {
  if (data.knockout !== undefined) {
    const layer = findChild(root, 'layer')
    if (layer) setFlagAtom(layer, 'knockout', data.knockout)
  }
  if (data.keepUpright !== undefined) {
    root.children = root.children.filter(
      (c) =>
        !(c.type === 'atom' && !c.quoted && c.value === 'unlocked') &&
        !(c.type === 'list' && getToken(c) === 'unlocked')
    )
    // A file before 20231014 kept it as an atom inside `(at x y angle unlocked)` (`keepsUpright`).
    const atNode = findChild(root, 'at')
    if (atNode) setFlagAtom(atNode, 'unlocked', false)
    if (!data.keepUpright) {
      const at = findChild(root, 'at')
      const index = at ? root.children.indexOf(at) + 1 : root.children.length
      root.children.splice(
        index,
        0,
        makeList(
          [makeAtom('unlocked', false, root.start), makeAtom('yes', false, root.start)],
          root.start
        )
      )
    }
  }
}

export function updatePropertyInAST(prop: KicadProperty, data: Partial<KicadProperty>): void {
  const root = prop._raw as SExprList
  markNodeDirty(root)
  if (data.value !== undefined) {
    prop.value = data.value
    setPositionalAtom(root, 2, data.value)
  }
  if (data.position !== undefined) {
    prop.position = {
      x: data.position.x ?? prop.position?.x ?? 0,
      y: data.position.y ?? prop.position?.y ?? 0,
      angle: data.position.angle !== undefined ? data.position.angle : prop.position?.angle
    }
    setAtChild(root, prop.position.x, prop.position.y, prop.position.angle)
  }
  if (data.layer !== undefined) {
    prop.layer = data.layer
    setScalarChild(root, 'layer', data.layer, true)
  }
  if (data.hide !== undefined) {
    prop.hide = data.hide
    setBoolFlag(root, 'hide', data.hide)
  }
  if (data.fontEffects !== undefined) {
    prop.fontEffects = data.fontEffects
    setFontEffectsChild(root, data.fontEffects)
  }
  if (data.knockout !== undefined) prop.knockout = data.knockout
  if (data.keepUpright !== undefined) prop.keepUpright = data.keepUpright
  setTextSwitchesInAST(root, data)
}

export function updateTextInAST(text: KicadFpText, data: Partial<KicadFpText>): void {
  const root = text._raw as SExprList
  markNodeDirty(root)
  if (data.text !== undefined) {
    text.text = data.text
    setPositionalAtom(root, 2, data.text)
  }
  if (data.position !== undefined) {
    text.position = {
      x: data.position.x ?? text.position?.x ?? 0,
      y: data.position.y ?? text.position?.y ?? 0,
      angle: data.position.angle !== undefined ? data.position.angle : text.position?.angle
    }
    setAtChild(root, text.position.x, text.position.y, text.position.angle)
  }
  if (data.layer !== undefined) {
    text.layer = data.layer
    setScalarChild(root, 'layer', data.layer, true)
  }
  if (data.hide !== undefined) {
    text.hide = data.hide
    setBoolFlag(root, 'hide', data.hide)
  }
  if (data.fontEffects !== undefined) {
    text.fontEffects = data.fontEffects
    setFontEffectsChild(root, data.fontEffects)
  }
  if (data.knockout !== undefined) text.knockout = data.knockout
  if (data.keepUpright !== undefined) text.keepUpright = data.keepUpright
  setTextSwitchesInAST(root, data)
}

/**
 * Set a (token (xyz X Y Z)) child of `root`, replacing it wholesale — the RAW
 * form for scale (multiplier) and rotate (degrees), which are not distances.
 */
export function setXYZChild(root: SExprList, token: string, x: number, y: number, z: number): void {
  const node = findOrCreateChild(root, token)
  const at = node.start
  node.children = [
    makeAtom(token, false, at),
    {
      type: 'list',
      children: [
        makeAtom('xyz', false, at),
        makeAtom(formatKicadNumber(x), false, at),
        makeAtom(formatKicadNumber(y), false, at),
        makeAtom(formatKicadNumber(z), false, at)
      ],
      start: at,
      end: at
    }
  ]
}

/** `setXYZChild` for the model OFFSET — the one xyz that is a distance (nm). */
export function setXYZChildNm(root: SExprList, token: string, x: Nm, y: Nm, z: Nm): void {
  const node = findOrCreateChild(root, token)
  const at = node.start
  node.children = [
    makeAtom(token, false, at),
    {
      type: 'list',
      children: [
        makeAtom('xyz', false, at),
        makeAtom(formatNmAtom(x), false, at),
        makeAtom(formatNmAtom(y), false, at),
        makeAtom(formatNmAtom(z), false, at)
      ],
      start: at,
      end: at
    }
  ]
}

/** Patch the path / offset / scale / rotate of an existing (model ...) node. */
export function updateModelInAST(
  model: KicadModel3D,
  data: Partial<Pick<KicadModel3D, 'path' | 'offset' | 'scale' | 'rotate'>>
): void {
  const root = model._raw as SExprList
  markNodeDirty(root)

  if (data.path !== undefined) {
    model.path = data.path
    setPositionalAtom(root, 1, data.path, true)
  }
  if (data.offset !== undefined) {
    model.offset = { ...(model.offset ?? { x: nm(0), y: nm(0), z: nm(0) }), ...data.offset }
    setXYZChildNm(root, 'offset', model.offset.x, model.offset.y, model.offset.z)
  }
  if (data.scale !== undefined) {
    model.scale = { ...(model.scale ?? { x: 1, y: 1, z: 1 }), ...data.scale }
    setXYZChild(root, 'scale', model.scale.x, model.scale.y, model.scale.z)
  }
  if (data.rotate !== undefined) {
    model.rotate = { ...(model.rotate ?? { x: 0, y: 0, z: 0 }), ...data.rotate }
    setXYZChild(root, 'rotate', model.rotate.x, model.rotate.y, model.rotate.z)
  }
}

/**
 * Append a new (model "path" (offset ..) (scale ..) (rotate ..)) node with
 * KiCad's default transform, update the domain model, and return it.
 */
export function addModelNode(fp: KicadFootprint, path: string): KicadModel3D {
  const root = fp._raw as SExprList
  markNodeDirty(root)
  const at = root.start
  const modelNode: SExprList = {
    type: 'list',
    children: [makeAtom('model', false, at), makeAtom(path, true, at)],
    start: at,
    end: at
  }
  setXYZChildNm(modelNode, 'offset', nm(0), nm(0), nm(0))
  setXYZChild(modelNode, 'scale', 1, 1, 1)
  setXYZChild(modelNode, 'rotate', 0, 0, 0)
  root.children.push(modelNode)
  const model = parseModel3D(modelNode)
  fp.model = model
  return model
}

// The footprint's own graphic writers. Same shape as the board's gr_* writers
// (`board.ts`), which cannot be shared because board.ts imports this module.
const buildList = (at: number, token: string, ...items: SExprNode[]): SExprList => ({
  type: 'list',
  children: [makeAtom(token, false, at), ...items],
  start: at,
  end: at
})

const buildValueList = (at: number, token: string, values: string[], quoted = false): SExprList =>
  buildList(at, token, ...values.map((value) => makeAtom(value, quoted, at)))

const buildStrokeNode = (at: number, width: Nm): SExprList =>
  buildList(
    at,
    'stroke',
    buildValueList(at, 'width', [formatNmAtom(width)]),
    buildValueList(at, 'type', ['default'])
  )

const buildUuidNode = (at: number): SExprList =>
  buildValueList(at, 'uuid', [crypto.randomUUID()], true)

/** Append an (fp_line ...) node; the parsed arrays refresh on re-parse. */
export function addFpLineToFootprintAST(
  fp: KicadFootprint,
  data: { start: { x: Nm; y: Nm }; end: { x: Nm; y: Nm }; width: Nm; layer: string }
): void {
  const root = fp._raw as SExprList
  markNodeDirty(root)
  const at = root.start
  root.children.push(
    buildList(
      at,
      'fp_line',
      buildValueList(at, 'start', [formatNmAtom(data.start.x), formatNmAtom(data.start.y)]),
      buildValueList(at, 'end', [formatNmAtom(data.end.x), formatNmAtom(data.end.y)]),
      buildStrokeNode(at, data.width),
      buildValueList(at, 'layer', [data.layer], true),
      buildUuidNode(at)
    )
  )
}

/** Append an (fp_poly ...) node; the parsed arrays refresh on re-parse. */
export function addFpPolyToFootprintAST(
  fp: KicadFootprint,
  data: { points: Array<{ x: Nm; y: Nm }>; width: Nm; layer: string; fill?: 'none' | 'solid' }
): void {
  const root = fp._raw as SExprList
  markNodeDirty(root)
  const at = root.start
  root.children.push(
    buildList(
      at,
      'fp_poly',
      buildList(
        at,
        'pts',
        ...data.points.map((p) => buildValueList(at, 'xy', [formatNmAtom(p.x), formatNmAtom(p.y)]))
      ),
      buildStrokeNode(at, data.width),
      buildValueList(at, 'fill', [data.fill ?? 'none']),
      buildValueList(at, 'layer', [data.layer], true),
      buildUuidNode(at)
    )
  )
}

/** Append an (fp_rect ...) node; the parsed arrays refresh on re-parse. */
export function addFpRectToFootprintAST(
  fp: KicadFootprint,
  data: {
    start: { x: Nm; y: Nm }
    end: { x: Nm; y: Nm }
    width: Nm
    layer: string
    fill?: 'none' | 'solid'
  }
): void {
  const root = fp._raw as SExprList
  markNodeDirty(root)
  const at = root.start
  root.children.push(
    buildList(
      at,
      'fp_rect',
      buildValueList(at, 'start', [formatNmAtom(data.start.x), formatNmAtom(data.start.y)]),
      buildValueList(at, 'end', [formatNmAtom(data.end.x), formatNmAtom(data.end.y)]),
      buildStrokeNode(at, data.width),
      buildValueList(at, 'fill', [data.fill ?? 'none']),
      buildValueList(at, 'layer', [data.layer], true),
      buildUuidNode(at)
    )
  )
}

/** Append an (fp_arc ...) node; the parsed arrays refresh on re-parse. */
export function addFpArcToFootprintAST(
  fp: KicadFootprint,
  data: {
    start: { x: Nm; y: Nm }
    mid: { x: Nm; y: Nm }
    end: { x: Nm; y: Nm }
    width: Nm
    layer: string
  }
): void {
  const root = fp._raw as SExprList
  markNodeDirty(root)
  const at = root.start
  const xy = (token: string, point: { x: Nm; y: Nm }): SExprList =>
    buildValueList(at, token, [formatNmAtom(point.x), formatNmAtom(point.y)])
  root.children.push(
    buildList(
      at,
      'fp_arc',
      xy('start', data.start),
      xy('mid', data.mid),
      xy('end', data.end),
      buildStrokeNode(at, data.width),
      buildValueList(at, 'layer', [data.layer], true),
      buildUuidNode(at)
    )
  )
}

/** Append an (fp_circle ...) node; `end` is any point on the circle. */
export function addFpCircleToFootprintAST(
  fp: KicadFootprint,
  data: {
    center: { x: Nm; y: Nm }
    end: { x: Nm; y: Nm }
    width: Nm
    layer: string
    fill?: 'none' | 'solid'
  }
): void {
  const root = fp._raw as SExprList
  markNodeDirty(root)
  const at = root.start
  root.children.push(
    buildList(
      at,
      'fp_circle',
      buildValueList(at, 'center', [formatNmAtom(data.center.x), formatNmAtom(data.center.y)]),
      buildValueList(at, 'end', [formatNmAtom(data.end.x), formatNmAtom(data.end.y)]),
      buildStrokeNode(at, data.width),
      buildValueList(at, 'fill', [data.fill ?? 'none']),
      buildValueList(at, 'layer', [data.layer], true),
      buildUuidNode(at)
    )
  )
}

/** What a footprint text or property is drawn with. */
export interface FootprintTextStyle {
  at: { x: Nm; y: Nm; angle?: number }
  layer: string
  size: Nm
  thickness: Nm
  hide?: boolean
}

const buildEffectsNode = (at: number, style: FootprintTextStyle): SExprList =>
  buildList(
    at,
    'effects',
    buildList(
      at,
      'font',
      buildValueList(at, 'size', [formatNmAtom(style.size), formatNmAtom(style.size)]),
      buildValueList(at, 'thickness', [formatNmAtom(style.thickness)])
    )
  )

const buildTextAt = (at: number, style: FootprintTextStyle): SExprList =>
  buildValueList(at, 'at', [
    formatNmAtom(style.at.x),
    formatNmAtom(style.at.y),
    formatKicadNumber(style.at.angle ?? 0)
  ])

/** Append a `(property "key" "value" …)` node, KiCad 8's form of a field. */
export function addFpPropertyToFootprintAST(
  fp: KicadFootprint,
  key: string,
  value: string,
  style: FootprintTextStyle
): void {
  const root = fp._raw as SExprList
  markNodeDirty(root)
  const at = root.start
  root.children.push(
    buildList(
      at,
      'property',
      makeAtom(key, true, at),
      makeAtom(value, true, at),
      buildTextAt(at, style),
      buildValueList(at, 'layer', [style.layer], true),
      ...(style.hide ? [buildValueList(at, 'hide', ['yes'])] : []),
      buildUuidNode(at),
      buildEffectsNode(at, style)
    )
  )
}

/** Append an `(fp_text user "text" …)` node. */
export function addFpTextToFootprintAST(
  fp: KicadFootprint,
  text: string,
  style: FootprintTextStyle
): void {
  const root = fp._raw as SExprList
  markNodeDirty(root)
  const at = root.start
  root.children.push(
    buildList(
      at,
      'fp_text',
      makeAtom('user', false, at),
      makeAtom(text, true, at),
      buildTextAt(at, style),
      buildValueList(at, 'layer', [style.layer], true),
      ...(style.hide ? [buildValueList(at, 'hide', ['yes'])] : []),
      buildUuidNode(at),
      buildEffectsNode(at, style)
    )
  )
}

/** Whether graphics write `fp_*` (inside a footprint) or `gr_*` (on a board). */
export type GraphicPrefix = 'fp' | 'gr'

/** A fresh Bézier's node: four points in KiCad's order, start, controls, end. */
export function buildCurveNode(
  at: number,
  prefix: GraphicPrefix,
  data: { points: Array<{ x: Nm; y: Nm }>; width: Nm; layer: string }
): SExprList {
  return buildList(
    at,
    `${prefix}_curve`,
    buildList(
      at,
      'pts',
      ...data.points.map((p) => buildValueList(at, 'xy', [formatNmAtom(p.x), formatNmAtom(p.y)]))
    ),
    buildStrokeNode(at, data.width),
    buildValueList(at, 'layer', [data.layer], true),
    buildUuidNode(at)
  )
}

/** What a fresh text box is drawn with (integer nm). */
export interface TextBoxData {
  text: string
  start: { x: Nm; y: Nm }
  end: { x: Nm; y: Nm }
  layer: string
  /** Font height and width. */
  size: Nm
  thickness: Nm
  /** The border's stroke width. */
  width: Nm
  /** Back-layer text reads mirrored, as KiCad places it. */
  mirror?: boolean
}

/**
 * KiCad's margin for a text box that names none (`GetLegacyTextMargin`): half
 * the border's width plus three quarters of the text height, each rounded to
 * KiCad's integer nanometers.
 */
export const legacyTextBoxMargin = (strokeWidth: number, textHeight: number): Nm =>
  nm(Math.round(Math.max(strokeWidth, 0) / 2) + Math.round(textHeight * 0.75))

/**
 * A fresh text box's node, laid out as KiCad's Draw Text Box writes one: text
 * justified left and top, the margins its legacy rule gives, a border.
 */
export function buildTextBoxNode(at: number, prefix: GraphicPrefix, data: TextBoxData): SExprList {
  const margin = formatNmAtom(legacyTextBoxMargin(data.width, data.size))
  return {
    type: 'list',
    children: [
      makeAtom(`${prefix}_text_box`, false, at),
      makeAtom(data.text, true, at),
      buildValueList(at, 'start', [formatNmAtom(data.start.x), formatNmAtom(data.start.y)]),
      buildValueList(at, 'end', [formatNmAtom(data.end.x), formatNmAtom(data.end.y)]),
      buildValueList(at, 'margins', [margin, margin, margin, margin]),
      buildValueList(at, 'layer', [data.layer], true),
      buildUuidNode(at),
      buildList(
        at,
        'effects',
        buildList(
          at,
          'font',
          buildValueList(at, 'size', [formatNmAtom(data.size), formatNmAtom(data.size)]),
          buildValueList(at, 'thickness', [formatNmAtom(data.thickness)])
        ),
        buildValueList(at, 'justify', data.mirror ? ['left', 'top', 'mirror'] : ['left', 'top'])
      ),
      buildValueList(at, 'border', ['yes']),
      buildStrokeNode(at, data.width),
      buildValueList(at, 'knockout', ['no'])
    ],
    start: at,
    end: at
  }
}

/** A fresh point's node: `(point (at x y) (size s) (layer …) (uuid …))`. */
export function buildPointNode(
  at: number,
  data: { position: { x: Nm; y: Nm }; size: Nm; layer: string }
): SExprList {
  return buildList(
    at,
    'point',
    buildValueList(at, 'at', [formatNmAtom(data.position.x), formatNmAtom(data.position.y)]),
    buildValueList(at, 'size', [formatNmAtom(data.size)]),
    buildValueList(at, 'layer', [data.layer], true),
    buildUuidNode(at)
  )
}

/** A Bézier, text box, table or point: the items `translateGraphicInAST` moves. */
export type KicadExtraGraphic = KicadFpCurve | KicadFpTextBox | KicadTable | KicadPoint

/** The `(token x y)` children that name a position; everything else stays. */
const POSITION_TOKENS = new Set(['start', 'end', 'at', 'xy'])
/** The containers a table or a polygon box keeps its positions in. */
const POSITION_CONTAINERS = new Set(['pts', 'cells', 'table_cell'])

const shiftPositions = (node: SExprList, dx: Nm, dy: Nm): void => {
  for (const child of node.children) {
    if (child.type !== 'list') continue
    const token = getToken(child)
    if (token && POSITION_TOKENS.has(token)) {
      const [, x, y] = child.children
      if (x?.type === 'atom') x.value = formatNmAtom(nm(mmAtomToNm(x.value) + dx))
      if (y?.type === 'atom') y.value = formatNmAtom(nm(mmAtomToNm(y.value) + dy))
    } else if (token && POSITION_CONTAINERS.has(token)) {
      shiftPositions(child, dx, dy)
    }
  }
}

/**
 * Move a Bézier, text box, table or point by `(dx, dy)`: every position it
 * writes (a curve's points, a box's corners or polygon, each table cell's
 * corners, a point's `at`) shifts, and nothing else — sizes, widths and
 * margins are not positions. The domain object is re-read from the AST so
 * it stays the write-through view a remap reuses.
 */
export function translateGraphicInAST(item: KicadExtraGraphic, dx: Nm, dy: Nm): void {
  const root = item._raw as SExprList
  markNodeDirty(root)
  shiftPositions(root, dx, dy)
  const token = getToken(root)
  if (token === 'table') Object.assign(item, parseTable(root))
  else if (token === 'point') Object.assign(item, parsePoint(root))
  else if (token === 'gr_curve' || token === 'fp_curve') Object.assign(item, parseFpCurve(root))
  else Object.assign(item, parseFpTextBox(root))
}

/**
 * Edit a text box's string or layer, on a board or in a footprint. The string
 * is the node's first value (after an older file's bare `locked`); an existing
 * atom keeps its place, so nothing else in the node moves.
 */
/** What the properties panel edits on a text box. */
export type TextBoxPatch = Partial<
  Pick<
    KicadFpTextBox,
    'text' | 'layer' | 'border' | 'strokeWidth' | 'strokeType' | 'knockout' | 'margins'
  >
>

export function updateTextBoxInAST(box: KicadFpTextBox, data: TextBoxPatch): void {
  const root = box._raw as SExprList
  markNodeDirty(root)
  if (data.text !== undefined) {
    box.text = data.text
    const at = root.children.findIndex(
      (c, i) => i > 0 && c.type === 'atom' && (c.quoted || c.value !== 'locked')
    )
    if (at > 0) updateAtom(root.children[at], data.text, true)
    else root.children.splice(1, 0, makeAtom(data.text, true, root.start))
  }
  if (data.layer !== undefined) {
    box.layer = data.layer
    setScalarChild(root, 'layer', data.layer, true)
  }
  if (data.border !== undefined) {
    box.border = data.border
    setScalarChild(root, 'border', data.border ? 'yes' : 'no')
  }
  if (data.strokeWidth !== undefined) {
    box.strokeWidth = data.strokeWidth
    setStrokeWidthChild(root, data.strokeWidth)
  }
  if (data.strokeType !== undefined) {
    box.strokeType = data.strokeType
    setStrokeTypeChild(root, data.strokeType)
  }
  if (data.knockout !== undefined) {
    box.knockout = data.knockout
    setScalarChild(root, 'knockout', data.knockout ? 'yes' : 'no')
  }
  if (data.margins !== undefined) {
    box.margins = data.margins
    const { left, top, right, bottom } = data.margins
    const node = findOrCreateChild(root, 'margins')
    node.children = [
      makeAtom('margins', false, node.start),
      ...[left, top, right, bottom].map((v) => makeAtom(formatNmAtom(v), false, node.start))
    ]
  }
}

/** What the properties panel edits on a table: its layer and its border and separator lines. */
export type TablePatch = Partial<
  Pick<
    KicadTable,
    | 'layer'
    | 'borderExternal'
    | 'borderHeader'
    | 'borderStrokeWidth'
    | 'separatorRows'
    | 'separatorCols'
    | 'separatorStrokeWidth'
  >
>

/**
 * Edit a table, on a board or in a footprint. A layer moves every cell with
 * it, as KiCad's `PCB_TABLE::SetLayer` does; the switches and widths live in
 * `(border …)` and `(separators …)`.
 */
export function updateTableInAST(table: KicadTable, data: TablePatch): void {
  const root = table._raw as SExprList
  markNodeDirty(root)
  if (data.layer !== undefined) {
    table.layer = data.layer
    setScalarChild(root, 'layer', data.layer, true)
    for (const cell of table.cells) {
      cell.layer = data.layer
      setScalarChild(cell._raw as SExprList, 'layer', data.layer, true)
    }
  }
  const lines = (token: 'border' | 'separators'): SExprList => findOrCreateChild(root, token)
  const yesNo = (on: boolean): string => (on ? 'yes' : 'no')
  if (data.borderExternal !== undefined) {
    table.borderExternal = data.borderExternal
    setScalarChild(lines('border'), 'external', yesNo(data.borderExternal))
  }
  if (data.borderHeader !== undefined) {
    table.borderHeader = data.borderHeader
    setScalarChild(lines('border'), 'header', yesNo(data.borderHeader))
  }
  if (data.borderStrokeWidth !== undefined) {
    table.borderStrokeWidth = data.borderStrokeWidth
    setStrokeWidthChild(lines('border'), data.borderStrokeWidth)
  }
  if (data.separatorRows !== undefined) {
    table.separatorRows = data.separatorRows
    setScalarChild(lines('separators'), 'rows', yesNo(data.separatorRows))
  }
  if (data.separatorCols !== undefined) {
    table.separatorCols = data.separatorCols
    setScalarChild(lines('separators'), 'cols', yesNo(data.separatorCols))
  }
  if (data.separatorStrokeWidth !== undefined) {
    table.separatorStrokeWidth = data.separatorStrokeWidth
    setStrokeWidthChild(lines('separators'), data.separatorStrokeWidth)
  }
}

/** Edit a Bézier's stroke or layer, on a board or in a footprint. Its points move on the canvas. */
export function updateCurveInAST(
  curve: KicadFpCurve,
  data: Partial<
    Pick<KicadFpCurve, 'points' | 'layer' | 'strokeWidth' | 'strokeType' | 'strokeColor'>
  >
): void {
  const root = curve._raw as SExprList
  markNodeDirty(root)
  if (data.points !== undefined) {
    curve.points = data.points
    setPointsChild(root, data.points)
  }
  if (data.layer !== undefined) {
    curve.layer = data.layer
    setScalarChild(root, 'layer', data.layer, true)
  }
  if (data.strokeWidth !== undefined) {
    curve.strokeWidth = data.strokeWidth
    setStrokeWidthChild(root, data.strokeWidth)
  }
  if (data.strokeType !== undefined) {
    curve.strokeType = data.strokeType
    setStrokeTypeChild(root, data.strokeType)
  }
  if (data.strokeColor !== undefined) {
    curve.strokeColor = data.strokeColor
    setStrokeColorChild(root, data.strokeColor)
  }
}

/** Edit a point's position, size or layer, on a board or in a footprint. */
export function updatePointInAST(
  point: KicadPoint,
  data: { position?: { x?: Nm; y?: Nm }; size?: Nm; layer?: string }
): void {
  const root = point._raw as SExprList
  markNodeDirty(root)
  if (data.position !== undefined) {
    point.position = {
      x: data.position.x ?? point.position.x,
      y: data.position.y ?? point.position.y
    }
    setXYChild(root, 'at', point.position.x, point.position.y)
  }
  if (data.size !== undefined) {
    point.size = data.size
    setScalarChild(root, 'size', formatNmAtom(data.size))
  }
  if (data.layer !== undefined) {
    point.layer = data.layer
    setScalarChild(root, 'layer', data.layer, true)
  }
}

/** Append an `(fp_curve …)` node; the parsed arrays refresh on re-parse. */
export function addFpCurveToFootprintAST(
  fp: KicadFootprint,
  data: { points: Array<{ x: Nm; y: Nm }>; width: Nm; layer: string }
): void {
  const root = fp._raw as SExprList
  markNodeDirty(root)
  root.children.push(buildCurveNode(root.start, 'fp', data))
}

/** Append an `(fp_text_box …)` node. */
export function addFpTextBoxToFootprintAST(fp: KicadFootprint, data: TextBoxData): void {
  const root = fp._raw as SExprList
  markNodeDirty(root)
  root.children.push(buildTextBoxNode(root.start, 'fp', data))
}

/** Append a `(point …)` node. */
export function addPointToFootprintAST(
  fp: KicadFootprint,
  data: { position: { x: Nm; y: Nm }; size: Nm; layer: string }
): void {
  const root = fp._raw as SExprList
  markNodeDirty(root)
  root.children.push(buildPointNode(root.start, data))
}

/** A pad as a writer takes it: integer nanometers, degrees. */
export interface FootprintPadData {
  number: string
  type: KicadPadType
  shape: Exclude<KicadPadShape, 'custom'>
  at: { x: Nm; y: Nm; angle?: number }
  size: { w: Nm; h: Nm }
  drill?: { diameter: Nm; oval?: { w: Nm; h: Nm }; offset?: { x: Nm; y: Nm } }
  layers: string[]
  roundrectRatio?: number
}

/** A `(pad …)` node in KiCad's own child order. */
export function buildPadNode(at: number, pad: FootprintPadData): SExprList {
  const nmAtoms = (...values: Nm[]): SExprAtom[] =>
    values.map((value) => makeAtom(formatNmAtom(value), false, at))
  const drill = pad.drill
    ? buildList(
        at,
        'drill',
        ...(pad.drill.oval
          ? [makeAtom('oval', false, at), ...nmAtoms(pad.drill.oval.w, pad.drill.oval.h)]
          : nmAtoms(pad.drill.diameter)),
        ...(pad.drill.offset
          ? [buildList(at, 'offset', ...nmAtoms(pad.drill.offset.x, pad.drill.offset.y))]
          : [])
      )
    : null
  return buildList(
    at,
    'pad',
    makeAtom(pad.number, true, at),
    makeAtom(pad.type, false, at),
    makeAtom(pad.shape, false, at),
    buildList(
      at,
      'at',
      ...nmAtoms(pad.at.x, pad.at.y),
      ...(pad.at.angle ? [makeAtom(formatKicadNumber(pad.at.angle), false, at)] : [])
    ),
    buildList(at, 'size', ...nmAtoms(pad.size.w, pad.size.h)),
    ...(drill ? [drill] : []),
    buildValueList(at, 'layers', pad.layers, true),
    ...(pad.shape === 'roundrect' && pad.roundrectRatio !== undefined
      ? [buildValueList(at, 'roundrect_rratio', [formatKicadNumber(pad.roundrectRatio)])]
      : []),
    buildUuidNode(at)
  )
}

/** Append a `(pad …)` node; the parsed arrays refresh on re-parse. */
export function addPadToFootprintAST(fp: KicadFootprint, pad: FootprintPadData): void {
  const root = fp._raw as SExprList
  markNodeDirty(root)
  root.children.push(buildPadNode(root.start, pad))
}

/** Drop the footprint's (model ...) node, if any. */
export function removeModelNode(fp: KicadFootprint): void {
  const root = fp._raw as SExprList
  markNodeDirty(root)
  const idx = root.children.findIndex((c) => c.type === 'list' && getToken(c) === 'model')
  if (idx >= 0) root.children.splice(idx, 1)
  fp.model = undefined
}

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export type { SExprNode, SExprList, SExprAtom }

/**
 * A rectangle's outline in its own coordinates: four corners, or, with a
 * corner radius, four quarter arcs (start, mid, end) with the straight sides
 * running between one arc's end and the next one's start.
 */
export function rectOutline(
  rect: Pick<KicadFpRect, 'start' | 'end' | 'radius'>
):
  | { kind: 'corners'; corners: Array<{ x: number; y: number }> }
  | { kind: 'arcs'; arcs: Array<{ start: XY; mid: XY; end: XY }> } {
  const corners = [
    { x: rect.start.x, y: rect.start.y },
    { x: rect.end.x, y: rect.start.y },
    { x: rect.end.x, y: rect.end.y },
    { x: rect.start.x, y: rect.end.y }
  ]
  const r = rect.radius ?? 0
  if (r <= 0) return { kind: 'corners', corners }
  const toward = (from: XY, to: XY): XY => {
    const d = Math.hypot(to.x - from.x, to.y - from.y) || 1
    return { x: (to.x - from.x) / d, y: (to.y - from.y) / d }
  }
  const arcs = corners.map((p, i) => {
    const u = toward(p, corners[(i + 3) % 4])
    const v = toward(p, corners[(i + 1) % 4])
    // The fillet's center is r in along both sides; its mid faces the corner.
    const center = { x: p.x + r * (u.x + v.x), y: p.y + r * (u.y + v.y) }
    const k = r * Math.SQRT1_2
    return {
      start: { x: p.x + r * u.x, y: p.y + r * u.y },
      mid: { x: center.x - k * (u.x + v.x), y: center.y - k * (u.y + v.y) },
      end: { x: p.x + r * v.x, y: p.y + r * v.y }
    }
  })
  return { kind: 'arcs', arcs }
}

type XY = { x: number; y: number }
