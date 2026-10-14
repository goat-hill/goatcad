/**
 * KiCad Board (.kicad_pcb) domain model and mapper.
 *
 * Maps the generic S-Expression AST (sexpr.ts) to strongly-typed interfaces
 * for a KiCad board: layer table, net list, placed footprints, track
 * segments/arcs, vias, copper zones, and board-level graphics (including the
 * Edge.Cuts outline).
 *
 * Follows the same design principles as footprint.ts:
 *  - Unknown/unrecognized nodes (groups, teardrops, ...) are preserved
 *    untouched in the AST, so serialization is format-preserving. `setup` is
 *    only *partly* modeled — the (stackup ...) child maps to KicadStackup and
 *    every sibling (pcbplotparams, aux_axis_origin, ...) rides along in the AST
 *    untouched.
 *  - Embedded (footprint ...) nodes reuse the footprint mapper; the board
 *    mapper adds the placement data (at/layer/uuid) on top.
 *  - All mutations write through to the _raw AST.
 */

import {
  parseSExpr,
  parseSExprAsync,
  type ParseAsyncOptions,
  serializeSExprCached,
  markNodeDirty,
  PackedPtsNode,
  PackedSegmentNode,
  warmSerializeCache,
  findChild,
  findChildren,
  getToken,
  getFirstAtomValue,
  getAtomValues,
  getNumericValue,
  getNmValue,
  getXYNm,
  makeList,
  type SExprNode,
  type SExprList
} from './sexpr'
import {
  parseFootprintNode,
  parseFpLine,
  parseFpArc,
  parseFpCircle,
  parseFpRect,
  parseFpPoly,
  parseFpCurve,
  parseFpTextBox,
  parseTable,
  parsePoint,
  buildCurveNode,
  buildTextBoxNode,
  buildPointNode,
  parseFontEffects,
  parseLayerKnockout,
  parseFlag,
  parseDimension,
  parseKeepoutRules,
  padstackKey,
  parseHoleMachining,
  parsePointList,
  getReference,
  getValue,
  makeAtom,
  findOrCreateChild,
  setScalarChild,
  setXYChild,
  setAtChild,
  setPointsChild,
  setPositionalAtom,
  setBoolFlag,
  setFontEffectsChild,
  setTextSwitchesInAST,
  setZoneHatchChild,
  type KicadFootprint,
  type KicadFpLine,
  type KicadFpArc,
  type KicadFpCircle,
  type KicadFpRect,
  type KicadFpPoly,
  type KicadFpCurve,
  type KicadFpTextBox,
  type KicadTable,
  type KicadPoint,
  type TextBoxData,
  type KicadFontEffects,
  type KicadDimension,
  type ZoneKeepoutRules,
  type KicadHoleMachining
} from './footprint'

export type { ZoneKeepoutRules }
import {
  formatKicadNumber,
  formatNmAtom,
  mmAtomToNm,
  mmToNm,
  nm,
  nmToMm,
  type Nm
} from './coordinates'
import { isCopperLayer } from './layers'
import { markupToPlainText } from './textMarkup'

// ---------------------------------------------------------------------------
// Domain Types
// ---------------------------------------------------------------------------

export interface KicadBoardLayer {
  ordinal: number
  /** Canonical KiCad name, e.g. "F.Cu", "Edge.Cuts" */
  name: string
  /** signal | power | mixed | jumper | user */
  type: string
  /** Optional user-facing rename, e.g. "F.Silkscreen" */
  userName?: string
}

export interface KicadNet {
  number: number
  name: string
}

export interface KicadBoardFootprint {
  /** Library id, e.g. "Resistor_SMD:R_0603_1608Metric" */
  libId: string
  /** Placement on the board. Child coordinates are relative-unrotated;
   *  pad/text angles in the file are absolute (already include this angle). */
  position: { x: Nm; y: Nm; angle?: number }
  /** Side: "F.Cu" or "B.Cu" */
  layer: string
  uuid?: string
  reference?: string
  value?: string
  /** The embedded footprint definition (pads, graphics, texts, ...) */
  footprint: KicadFootprint
  _raw: SExprList
}

export interface KicadTrackSegment {
  start: { x: Nm; y: Nm }
  end: { x: Nm; y: Nm }
  width: Nm
  layer: string
  net: number
  uuid?: string
  /** `(locked yes)` — the item refuses selection while the Locked filter is off. */
  locked: boolean
  /** Opened in the solder mask (`(layers "F.Cu" "F.Mask")`), with its own margin if it names one. */
  mask?: TrackMask
  _raw: SExprList
}

/** A track the mask leaves bare: KiCad's `PCB_TRACK::HasSolderMask` and its `(solder_mask_margin …)`. */
export interface TrackMask {
  margin?: Nm
}

export interface KicadTrackArc {
  start: { x: Nm; y: Nm }
  mid: { x: Nm; y: Nm }
  end: { x: Nm; y: Nm }
  width: Nm
  layer: string
  net: number
  uuid?: string
  locked: boolean
  mask?: TrackMask
  _raw: SExprList
}

/**
 * Solder mask over a via, per outer side. `true` = tented (mask closes over it),
 * which is KiCad's default; `false` opens the mask. A per-via `(tenting …)`
 * overrides the board's `(setup (tenting …))`, and a side the file does not
 * mention inherits it.
 */
export interface ViaTenting {
  front?: boolean
  back?: boolean
}

export interface KicadVia {
  position: { x: Nm; y: Nm }
  size: Nm
  drill: Nm
  layers: string[]
  net: number
  /** blind | micro | undefined (= through) */
  type?: string
  /** Per-via `(tenting …)` override; absent sides fall back to the board. */
  tenting?: ViaTenting
  /**
   * `(padstack …)`: a via whose diameter differs by layer (KiCad 9+), by
   * padstack layer name (`Inner`, `B.Cu`, or each layer in `custom` mode);
   * `size` is its front. `viaSizeOn` gives it on a layer.
   */
  padstack?: { mode: 'front_inner_back' | 'custom'; sizes: Record<string, Nm> }
  /** Backdrills and post-machining (KiCad 10). */
  machining?: KicadHoleMachining
  uuid?: string
  locked: boolean
  _raw: SExprList
}

/** A via's diameter on one copper layer: its padstack's entry there, else its own size. */
export function viaSizeOn(via: KicadVia, layer: string): Nm {
  const stack = via.padstack
  if (!stack) return via.size
  const key = padstackKey(stack.mode, layer)
  return (key !== null ? stack.sizes[key] : undefined) ?? via.size
}

/** KiCad's default: mask closes over vias on both sides. */
export const DEFAULT_VIA_TENTING: Required<ViaTenting> = { front: true, back: true }

/**
 * Whether the mask opens over `via` on the given side — the question the mask
 * plot, the 3D surface split, and the 2D mask layers all ask.
 *
 * Probed against KiCad 10 by plotting F.Mask/B.Mask: `yes` means tented (no
 * opening), a per-via `(tenting (front yes) (back no))` opens only the back, and
 * a board with no `(setup (tenting …))` at all tents both sides.
 */
export function viaMaskIsOpen(
  via: KicadVia,
  side: 'front' | 'back',
  boardTenting: ViaTenting | undefined
): boolean {
  const tented = via.tenting?.[side] ?? boardTenting?.[side] ?? DEFAULT_VIA_TENTING[side]
  return !tented
}

/** How a zone connects to pads of its own net. Absent marker = thermal reliefs. */
export type ZonePadConnection = 'solid' | 'thermal' | 'thru_hole_only' | 'none'

export interface KicadBoardZone {
  /**
   * The footprint it belongs to, by index, for a zone a footprint carries
   * (`footprintZones`); absent for the board's own.
   */
  footprint?: number
  net?: number
  netName?: string
  name?: string
  /** All copper layers the zone lives on (resolves both (layer ..) and (layers ..)) */
  layers: string[]
  hatchStyle?: 'none' | 'edge' | 'full'
  hatchPitch?: Nm
  minThickness?: Nm
  /** Fill priority — higher pours first and carves lower zones. */
  priority?: number
  padConnection?: ZonePadConnection
  /** Copper-to-pad clearance for thermal spokes ((connect_pads (clearance ..))). */
  padClearance?: Nm
  thermalGap?: Nm
  thermalBridgeWidth?: Nm
  /** 0 = remove all islands, 1 = keep all, 2 = below island_area_min. */
  islandRemovalMode?: number
  minIslandArea?: number
  /**
   * `(fill (mode hatch) …)`: a hatched pour, its web and hole widths (mm), the
   * grid's turn (degrees), how its holes' corners are smoothed, and the smallest
   * hole kept as a fraction of a whole one. Absent, the pour is solid.
   */
  hatchFill?: {
    thickness: number
    gap: number
    orientation: number
    smoothingLevel: number
    smoothingValue: number
    minHoleArea: number
  }
  /** `(fill (smoothing chamfer|fillet) (radius r))`: how the outline's corners are cut. */
  smoothing?: 'chamfer' | 'fillet'
  smoothingRadius?: Nm
  isKeepout: boolean
  keepoutRules?: ZoneKeepoutRules
  /** Outline polygon */
  points: Array<{ x: Nm; y: Nm }>
  /** Cutouts: every `(polygon …)` after the first, as KiCad reads them (`ZONE::AddPolygon`). */
  holes?: Array<Array<{ x: Nm; y: Nm }>>
  /** Filled copper polygons, each tagged with its layer */
  filledPolys: Array<{ layer?: string; points: Array<{ x: Nm; y: Nm }> }>
  uuid?: string
  locked: boolean
  _raw: SExprList
}

export interface KicadGrText {
  text: string
  position?: { x: Nm; y: Nm; angle?: number }
  layer?: string
  hide?: boolean
  fontEffects?: KicadFontEffects
  uuid?: string
  locked: boolean
  /** `(layer "F.SilkS" knockout)` — drawn as a cut-out of a filled box. */
  knockout: boolean
  _raw: SExprList
}

/**
 * One row of the physical stackup — either a board layer ("F.Cu", "F.Mask") or
 * a dielectric slot ("dielectric 1"). The row's position in the list is its
 * physical order, top to bottom; `type` carries the role ("copper", "core",
 * "prepreg", "Top Solder Mask", ...).
 */
export interface KicadStackupLayer {
  name: string
  type?: string
  thickness?: Nm
  material?: string
  epsilonR?: number
  lossTangent?: number
  color?: string
  _raw: SExprList
}

/**
 * The board's physical build, from (setup (stackup ...)).
 *
 * Design *rules* are deliberately absent: modern KiCad keeps clearance/track/
 * via minimums and net classes in the .kicad_pro (see project.ts), and only the
 * physical stackup in the board file. The parser in KiCad still reads rule
 * tokens out of `setup`, but that is the pre-6.0 migration path — we target the
 * modern format, where such tokens simply do not appear.
 */
export interface KicadStackup {
  layers: KicadStackupLayer[]
  copperFinish?: string
  dielectricConstraints?: boolean
  castellatedPads?: boolean
  edgePlating?: boolean
  /** The (stackup ...) node. */
  _raw: SExprList
  /**
   * The owning top-level (setup ...) node. Nested edits must mark THIS dirty:
   * serializeSExprCached only consults the root's direct children, so marking
   * a layer (two levels down) would leave stale cached text for `setup`.
   */
  _setup: SExprList
}

export interface KicadBoard {
  version?: number
  generator?: string
  generatorVersion?: string
  /** Board thickness from (general (thickness ..)) */
  thickness?: Nm
  paper?: string
  /** Physical stackup from (setup (stackup ..)); absent until one is written. */
  stackup?: KicadStackup
  /** `(setup (tenting …))` — the board default every via inherits. */
  tenting?: ViaTenting
  /** `(setup (pad_to_mask_clearance …))`, the mask expansion; 0 when absent. */
  padToMaskClearance: Nm
  /** `(setup (pad_to_paste_clearance …))`, the paste margin; 0 when absent. */
  padToPasteClearance: Nm
  /** `(setup (pad_to_paste_clearance_ratio …))`, a fraction of the pad's size; 0 when absent. */
  padToPasteClearanceRatio: number
  /** `(setup (grid_origin …))`: where the grid is measured from; absent is 0,0. */
  gridOrigin?: { x: Nm; y: Nm }
  /**
   * `(setup (aux_axis_origin …))`: KiCad's drill / place file origin, the point
   * drill and position files may be written relative to; absent is 0,0.
   */
  auxOrigin?: { x: Nm; y: Nm }
  layers: KicadBoardLayer[]
  /**
   * The net table. For files that declare one (≤ KiCad 9: `(net N "name")`
   * rows) it is read as-is; KiCad 10 dropped the table and references nets by
   * name, so entries are synthesized per name (see the net resolver) — they
   * exist only in the domain model, never in the serialized file.
   */
  nets: KicadNet[]
  /**
   * How this file spells a net reference on copper: `(net 3)` against the
   * declared table, or `(net "GND")` by name (KiCad 10+). Mutators must write
   * the file's own dialect — a numeric ref means nothing to a v10 file.
   */
  netRefStyle: 'number' | 'name'
  footprints: KicadBoardFootprint[]
  segments: KicadTrackSegment[]
  trackArcs: KicadTrackArc[]
  vias: KicadVia[]
  zones: KicadBoardZone[]
  grLines: KicadFpLine[]
  grArcs: KicadFpArc[]
  grCircles: KicadFpCircle[]
  grRects: KicadFpRect[]
  grPolys: KicadFpPoly[]
  grTexts: KicadGrText[]
  /** `(gr_curve …)`: cubic Béziers. */
  grCurves: KicadFpCurve[]
  /** `(gr_text_box …)` */
  grTextBoxes: KicadFpTextBox[]
  /** `(table …)` on the board itself (a footprint's live in its own `tables`). */
  tables: KicadTable[]
  /** `(point …)`, KiCad 10's markers. */
  points: KicadPoint[]
  dimensions: KicadDimension[]
  /** `(generated (type tuning_pattern) …)`: length tuning patterns, their tracks by uuid. */
  tuningPatterns: KicadTuningPattern[]
  /** Full AST for round-trip serialization */
  _raw: SExprNode
  /** Unrecognized top-level nodes, preserved for round-trip fidelity */
  _unknownNodes: SExprNode[]
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

function childValue(node: SExprList, token: string): string | undefined {
  const child = findChild(node, token)
  return child ? getFirstAtomValue(child) : undefined
}

/** An item's identity: `uuid`, or the `tstamp` files before KiCad 8 spelled it. */
function uuidOf(node: SExprList): string | undefined {
  return childValue(node, 'uuid') ?? childValue(node, 'tstamp')
}

function parseBoardLayers(root: SExprList): KicadBoardLayer[] {
  const layersNode = findChild(root, 'layers')
  if (!layersNode) return []

  const layers: KicadBoardLayer[] = []
  for (const child of layersNode.children) {
    if (child.type !== 'list') continue
    const ordinalStr = getToken(child)
    if (ordinalStr === null || isNaN(parseInt(ordinalStr))) continue
    const atoms = getAtomValues(child)
    layers.push({
      ordinal: parseInt(ordinalStr),
      name: atoms[0] ?? '',
      type: atoms[1] ?? 'user',
      userName: atoms[2]
    })
  }
  return layers
}

function parseNet(node: SExprList): KicadNet {
  const atoms = getAtomValues(node)
  return { number: parseInt(atoms[0] ?? '0'), name: atoms[1] ?? '' }
}

const NET_NUMBER_RE = /^-?\d+$/

/**
 * Resolves a `(net …)` reference — numeric or by name — to the domain's net
 * number, synthesizing table entries for names the table lacks (KiCad 10
 * declares none). Seeded from the previous parse on remap so a session's
 * numbers are stable across edits: a held route net must not re-point because
 * an unrelated item was deleted and the encounter order shifted.
 */
interface NetResolver {
  nets: KicadNet[]
  sawNameRef: boolean
  resolve(raw: string | undefined): number
}

function makeNetResolver(declared: KicadNet[], prev?: KicadNet[]): NetResolver {
  const nets = declared.slice()
  const byName = new Map(nets.map((n) => [n.name, n.number]))
  let nextNumber = nets.reduce((m, n) => Math.max(m, n.number), 0) + 1
  if (prev) {
    for (const n of prev) {
      if (!byName.has(n.name)) {
        byName.set(n.name, n.number)
        nets.push(n)
        nextNumber = Math.max(nextNumber, n.number + 1)
      }
    }
  }
  const resolver: NetResolver = {
    nets,
    sawNameRef: false,
    resolve(raw) {
      // An empty name is no net, as KiCad finds it: `(net "")` on a KiCad 10 board.
      if (raw === undefined || raw === '') return 0
      if (NET_NUMBER_RE.test(raw)) return parseInt(raw)
      resolver.sawNameRef = true
      let num = byName.get(raw)
      if (num === undefined) {
        num = nextNumber++
        byName.set(raw, num)
        nets.push({ number: num, name: raw })
      }
      return num
    }
  }
  return resolver
}

function netNumberOf(node: SExprList, nets: NetResolver): number {
  const netNode = findChild(node, 'net')
  if (!netNode) return 0
  return nets.resolve(getFirstAtomValue(netNode) ?? undefined)
}

function parseBoardFootprint(node: SExprList, nets: NetResolver): KicadBoardFootprint {
  const footprint = parseFootprintNode(node)
  // Pads with a name-only net ref (KiCad 10) parsed as NaN + the name;
  // resolve them against the board's table.
  for (const pad of footprint.pads) {
    if (pad.net && Number.isNaN(pad.net.number)) {
      nets.sawNameRef = true
      pad.net = { number: nets.resolve(pad.net.name), name: pad.net.name }
    }
  }
  return {
    libId: footprint.name,
    position: getXYNm(node, 'at') ?? { x: nm(0), y: nm(0) },
    layer: childValue(node, 'layer') ?? 'F.Cu',
    uuid: uuidOf(node),
    reference: getReference(footprint),
    value: getValue(footprint),
    footprint,
    _raw: node
  }
}

function parseSegment(node: SExprList, nets: NetResolver): KicadTrackSegment {
  if (node instanceof PackedSegmentNode) {
    const rec = node.packedRecord()
    if (rec) {
      // The packed scan requires the node to close right after `uuid`, so a
      // packed segment provably carries no `locked` child — false is exact
      // here, not a fast-path approximation.
      return {
        start: { x: rec.x1, y: rec.y1 },
        end: { x: rec.x2, y: rec.y2 },
        width: rec.width,
        layer: rec.layer,
        net: rec.net,
        uuid: rec.uuid,
        locked: false,
        _raw: node
      }
    }
  }
  const widthNode = findChild(node, 'width')
  return {
    start: getXYNm(node, 'start') ?? { x: nm(0), y: nm(0) },
    end: getXYNm(node, 'end') ?? { x: nm(0), y: nm(0) },
    width: widthNode ? getNmValue(widthNode, nm(200000)) : nm(200000),
    ...trackLayers(node),
    net: netNumberOf(node, nets),
    uuid: uuidOf(node),
    locked: parseFlag(node, 'locked'),
    _raw: node
  }
}

/**
 * A track's layer: its `(layer …)`, or the copper of a `(layers "B.Cu" "B.Mask")`
 * list, which marks it opened in the mask on that side.
 */
function trackLayers(node: SExprList): { layer: string; mask?: TrackMask } {
  const single = childValue(node, 'layer')
  if (single) return { layer: single }
  const listed = findChild(node, 'layers')
  const layers = listed ? getAtomValues(listed) : []
  const layer = layers.find(isCopperLayer) ?? 'F.Cu'
  if (!layers.some((l) => l.endsWith('.Mask'))) return { layer }
  const marginNode = findChild(node, 'solder_mask_margin')
  return { layer, mask: marginNode ? { margin: getNmValue(marginNode, nm(0)) } : {} }
}

function parseTrackArc(node: SExprList, nets: NetResolver): KicadTrackArc {
  const widthNode = findChild(node, 'width')
  return {
    start: getXYNm(node, 'start') ?? { x: nm(0), y: nm(0) },
    mid: getXYNm(node, 'mid') ?? { x: nm(0), y: nm(0) },
    end: getXYNm(node, 'end') ?? { x: nm(0), y: nm(0) },
    width: widthNode ? getNmValue(widthNode, nm(200000)) : nm(200000),
    ...trackLayers(node),
    net: netNumberOf(node, nets),
    uuid: uuidOf(node),
    locked: parseFlag(node, 'locked'),
    _raw: node
  }
}

function parseVia(node: SExprList, nets: NetResolver): KicadVia {
  const sizeNode = findChild(node, 'size')
  const drillNode = findChild(node, 'drill')
  const layersNode = findChild(node, 'layers')
  // Type marker is a bare atom right after the token: (via blind ...) / (via micro ...)
  const typeAtom = getAtomValues(node)[0]
  return {
    position: getXYNm(node, 'at') ?? { x: nm(0), y: nm(0) },
    size: sizeNode ? getNmValue(sizeNode, nm(600000)) : nm(600000),
    drill: drillNode ? getNmValue(drillNode, nm(300000)) : nm(300000),
    layers: layersNode ? getAtomValues(layersNode) : ['F.Cu', 'B.Cu'],
    net: netNumberOf(node, nets),
    type:
      typeAtom === 'blind' || typeAtom === 'buried' || typeAtom === 'micro' ? typeAtom : undefined,
    tenting: parseTenting(node),
    padstack: parseViaPadstack(node),
    machining: parseHoleMachining(node),
    uuid: uuidOf(node),
    locked: parseFlag(node, 'locked'),
    _raw: node
  }
}

function parseViaPadstack(node: SExprList): KicadVia['padstack'] {
  const stack = findChild(node, 'padstack')
  const mode = stack ? childValue(stack, 'mode') : undefined
  if (!stack || (mode !== 'front_inner_back' && mode !== 'custom')) return undefined
  const sizes: Record<string, Nm> = {}
  for (const layer of findChildren(stack, 'layer')) {
    const name = getAtomValues(layer)[0]
    const size = findChild(layer, 'size')
    if (name && size) sizes[name] = getNmValue(size, nm(0))
  }
  return { mode, sizes }
}

function parseBoardZone(node: SExprList, nets: NetResolver): KicadBoardZone {
  const netNode = findChild(node, 'net')
  const hatchNode = findChild(node, 'hatch')
  const minThicknessNode = findChild(node, 'min_thickness')
  const priorityNode = findChild(node, 'priority')

  let hatchStyle: KicadBoardZone['hatchStyle']
  let hatchPitch: Nm | undefined
  if (hatchNode) {
    const hatchAtoms = getAtomValues(hatchNode)
    if (hatchAtoms[0] === 'edge' || hatchAtoms[0] === 'full' || hatchAtoms[0] === 'none') {
      hatchStyle = hatchAtoms[0]
    }
    if (hatchAtoms.length >= 2) hatchPitch = mmAtomToNm(hatchAtoms[1])
  }

  // Layers: single (layer "F.Cu") or multi (layers "F.Cu" "B.Cu" / "*.Cu")
  const layersNode = findChild(node, 'layers')
  const singleLayer = childValue(node, 'layer')
  const layers = layersNode ? getAtomValues(layersNode) : singleLayer ? [singleLayer] : ['F.Cu']

  // Pad connection: a bare marker atom on connect_pads — absent means thermal.
  const connectPads = findChild(node, 'connect_pads')
  let padConnection: ZonePadConnection | undefined
  let padClearance: Nm | undefined
  if (connectPads) {
    const marker = getAtomValues(connectPads)[0]
    padConnection =
      marker === 'yes'
        ? 'solid'
        : marker === 'no'
          ? 'none'
          : marker === 'thru_hole_only'
            ? 'thru_hole_only'
            : 'thermal'
    const clearanceNode = findChild(connectPads, 'clearance')
    if (clearanceNode) padClearance = getNmValue(clearanceNode)
  }

  const fillNode = findChild(node, 'fill')
  // Two readers because fill children mix units: thermal gap/bridge are
  // distances; island_removal_mode is an enum and island_area_min mm².
  const fillChildNum = (token: string): number | undefined => {
    const child = fillNode ? findChild(fillNode, token) : null
    return child ? getNumericValue(child) : undefined
  }
  const fillChildNm = (token: string): Nm | undefined => {
    const child = fillNode ? findChild(fillNode, token) : null
    return child ? getNmValue(child) : undefined
  }

  const keepoutRules = parseKeepoutRules(node)

  const [polyNode, ...cutoutNodes] = findChildren(node, 'polygon')
  const points = parsePointList(polyNode ? findChild(polyNode, 'pts') : null)
  const holes = cutoutNodes
    .map((cutout) => parsePointList(findChild(cutout, 'pts')))
    .filter((hole) => hole.length >= 3)

  const filledPolys: KicadBoardZone['filledPolys'] = []
  for (const fpNode of findChildren(node, 'filled_polygon')) {
    const polyPts = parsePointList(findChild(fpNode, 'pts'))
    if (polyPts.length > 0) {
      filledPolys.push({ layer: childValue(fpNode, 'layer'), points: polyPts })
    }
  }

  const rawNet = netNode ? getFirstAtomValue(netNode) : undefined
  const netNameFromRef = rawNet !== undefined && !/^-?\d+$/.test(rawNet) ? rawNet : undefined

  return {
    net: rawNet !== undefined ? nets.resolve(rawNet) : undefined,
    netName: childValue(node, 'net_name') ?? netNameFromRef,
    name: childValue(node, 'name'),
    uuid: uuidOf(node),
    layers,
    hatchStyle,
    hatchPitch,
    minThickness: minThicknessNode ? getNmValue(minThicknessNode) : undefined,
    priority: priorityNode ? getNumericValue(priorityNode) : undefined,
    padConnection,
    padClearance,
    thermalGap: fillChildNm('thermal_gap'),
    thermalBridgeWidth: fillChildNm('thermal_bridge_width'),
    islandRemovalMode: fillChildNum('island_removal_mode'),
    minIslandArea: fillChildNum('island_area_min'),
    ...smoothingOf(fillNode, fillChildNm('radius')),
    ...hatchFillOf(fillNode, fillChildNum),
    isKeepout: keepoutRules !== undefined,
    keepoutRules,
    points,
    ...(holes.length ? { holes } : {}),
    filledPolys,
    locked: parseFlag(node, 'locked'),
    _raw: node
  }
}

/** Read a (token yes|no) child; undefined when the token is absent. */
function boolValue(node: SExprList, token: string): boolean | undefined {
  const child = findChild(node, token)
  if (!child) return undefined
  return getFirstAtomValue(child) !== 'no'
}

function parseStackupLayer(node: SExprList): KicadStackupLayer {
  const thickness = findChild(node, 'thickness')
  const epsilon = findChild(node, 'epsilon_r')
  const loss = findChild(node, 'loss_tangent')
  return {
    name: getAtomValues(node)[0] ?? '',
    type: childValue(node, 'type'),
    thickness: thickness ? getNmValue(thickness) : undefined,
    material: childValue(node, 'material'),
    epsilonR: epsilon ? getNumericValue(epsilon) : undefined,
    lossTangent: loss ? getNumericValue(loss) : undefined,
    color: childValue(node, 'color'),
    _raw: node
  }
}

function parseStackup(setup: SExprList): KicadStackup | undefined {
  const node = findChild(setup, 'stackup')
  if (!node) return undefined
  return {
    layers: findChildren(node, 'layer').map(parseStackupLayer),
    copperFinish: childValue(node, 'copper_finish'),
    dielectricConstraints: boolValue(node, 'dielectric_constraints'),
    castellatedPads: boolValue(node, 'castellated_pads'),
    edgePlating: boolValue(node, 'edge_plating'),
    _raw: node,
    _setup: setup
  }
}

/**
 * `(tenting (front yes) (back no))`, on the board's `setup` or on one via. A
 * side the node omits stays undefined so it can inherit rather than default.
 */
function parseTenting(parent: SExprList): ViaTenting | undefined {
  const node = findChild(parent, 'tenting')
  if (!node) return undefined
  const front = boolValue(node, 'front')
  const back = boolValue(node, 'back')
  return front === undefined && back === undefined ? undefined : { front, back }
}

function parseGrText(node: SExprList): KicadGrText {
  return {
    text: getAtomValues(node)[0] ?? '',
    position: getXYNm(node, 'at') ?? undefined,
    layer: childValue(node, 'layer'),
    hide: parseFlag(node, 'hide'),
    fontEffects: parseFontEffects(node),
    uuid: uuidOf(node),
    locked: parseFlag(node, 'locked'),
    knockout: parseLayerKnockout(node),
    _raw: node
  }
}

export function parseKicadBoard(source: string): KicadBoard {
  const root = parseSExpr(source)

  if (root.type !== 'list' || getToken(root) !== 'kicad_pcb') {
    throw new Error('Input is not a KiCad board (expected top-level "kicad_pcb" token)')
  }

  return buildBoard(root)
}

/**
 * Chunked variant for large boards: parses without blocking the event loop
 * and reports progress in [0, 1]. Throws ParseAbortedError when aborted.
 * The final domain mapping still runs synchronously (~0.2 s on an 85 MB
 * board), after a last progress callback so the UI can show a busy state.
 */
export async function parseKicadBoardAsync(
  source: string,
  options: ParseAsyncOptions = {}
): Promise<KicadBoard> {
  const root = await parseSExprAsync(source, options)

  if (root.type !== 'list' || getToken(root) !== 'kicad_pcb') {
    throw new Error('Input is not a KiCad board (expected top-level "kicad_pcb" token)')
  }

  return buildBoard(root)
}

/**
 * Rebuild the domain-facade arrays from a board's (mutated) in-memory AST
 * without re-parsing text. Domain objects whose _raw node is still present are
 * reused as-is (write-through mutations already updated them); only nodes new
 * to the AST are parsed. Returns a fresh KicadBoard wrapper so watchers on the
 * board reference fire.
 *
 * This is what makes editing large boards viable: a command mutates the AST,
 * then remaps in milliseconds instead of serialize→reparse on 80+ MB of text.
 */
export function remapKicadBoard(board: KicadBoard): KicadBoard {
  return buildBoard(board._raw as SExprList, board)
}

function remapCollection<T extends { _raw: SExprNode }>(
  nodes: SExprList[],
  prev: T[] | undefined,
  parse: (node: SExprList) => T
): T[] {
  if (!prev || prev.length === 0) return nodes.map(parse)
  const byRaw = new Map<SExprNode, T>()
  for (const item of prev) byRaw.set(item._raw, item)
  return nodes.map((n) => byRaw.get(n) ?? parse(n))
}

function buildBoard(root: SExprList, prev?: KicadBoard): KicadBoard {
  const pcb = root

  const handledTokens = new Set<string>([
    'version',
    'generator',
    'generator_version',
    'general',
    'paper',
    'layers',
    'setup',
    'net',
    'footprint',
    'segment',
    'arc',
    'via',
    'zone',
    'gr_line',
    'gr_arc',
    'gr_circle',
    'gr_rect',
    'gr_poly',
    'gr_text',
    'gr_curve',
    'gr_text_box',
    'table',
    'point',
    'dimension'
  ])

  const unknownNodes: SExprNode[] = []
  for (const child of pcb.children) {
    if (child.type !== 'list') continue
    const token = getToken(child)
    if (token && !handledTokens.has(token)) {
      unknownNodes.push(child)
    }
  }

  const versionNode = findChild(pcb, 'version')
  const generalNode = findChild(pcb, 'general')
  const thicknessNode = generalNode ? findChild(generalNode, 'thickness') : null
  const setupNode = findChild(pcb, 'setup')
  const maskClearanceNode = setupNode ? findChild(setupNode, 'pad_to_mask_clearance') : null
  const pasteClearanceNode = setupNode ? findChild(setupNode, 'pad_to_paste_clearance') : null
  const pasteRatioNode = setupNode ? findChild(setupNode, 'pad_to_paste_clearance_ratio') : null

  const version = versionNode ? getNumericValue(versionNode) : undefined
  const declaredNets = findChildren(pcb, 'net').map(parseNet)
  const nets = makeNetResolver(declaredNets, prev?.nets)

  const footprints = remapCollection(findChildren(pcb, 'footprint'), prev?.footprints, (n) =>
    parseBoardFootprint(n, nets)
  )
  const segments = remapCollection(findChildren(pcb, 'segment'), prev?.segments, (n) =>
    parseSegment(n, nets)
  )
  const trackArcs = remapCollection(findChildren(pcb, 'arc'), prev?.trackArcs, (n) =>
    parseTrackArc(n, nets)
  )
  const vias = remapCollection(findChildren(pcb, 'via'), prev?.vias, (n) => parseVia(n, nets))
  const zones = remapCollection(findChildren(pcb, 'zone'), prev?.zones, (n) =>
    parseBoardZone(n, nets)
  )

  // A board graphic's `(net …)`: copper drawn on the board conducts.
  const withNet =
    <T extends { net?: number }>(parse: (node: SExprList) => T) =>
    (node: SExprList): T => {
      const shape = parse(node)
      const net = netNumberOf(node, nets)
      if (net > 0) shape.net = net
      return shape
    }
  const grLines = remapCollection(findChildren(pcb, 'gr_line'), prev?.grLines, withNet(parseFpLine))
  const grArcs = remapCollection(findChildren(pcb, 'gr_arc'), prev?.grArcs, withNet(parseFpArc))
  const grCircles = remapCollection(
    findChildren(pcb, 'gr_circle'),
    prev?.grCircles,
    withNet(parseFpCircle)
  )
  const grRects = remapCollection(findChildren(pcb, 'gr_rect'), prev?.grRects, withNet(parseFpRect))
  const grPolys = remapCollection(findChildren(pcb, 'gr_poly'), prev?.grPolys, withNet(parseFpPoly))
  const grCurves = remapCollection(
    findChildren(pcb, 'gr_curve'),
    prev?.grCurves,
    withNet(parseFpCurve)
  )

  // Name refs are KiCad 10's; a board still declaring numbered nets (an older
  // one, read as KiCad 10 still reads it) keeps numbers, and one with no nets
  // yet writes names.
  const netRefStyle: KicadBoard['netRefStyle'] =
    nets.sawNameRef || (prev ? prev.netRefStyle === 'name' : false) || declaredNets.length === 0
      ? 'name'
      : 'number'

  return {
    version,
    generator: childValue(pcb, 'generator'),
    generatorVersion: childValue(pcb, 'generator_version'),
    thickness: thicknessNode ? getNmValue(thicknessNode) : undefined,
    paper: childValue(pcb, 'paper'),
    stackup: setupNode ? parseStackup(setupNode) : undefined,
    tenting: setupNode ? parseTenting(setupNode) : undefined,
    padToMaskClearance: maskClearanceNode ? getNmValue(maskClearanceNode, nm(0)) : nm(0),
    padToPasteClearance: pasteClearanceNode ? getNmValue(pasteClearanceNode, nm(0)) : nm(0),
    padToPasteClearanceRatio: pasteRatioNode ? getNumericValue(pasteRatioNode) : 0,
    gridOrigin: (setupNode && getXYNm(setupNode, 'grid_origin')) ?? undefined,
    auxOrigin: (setupNode && getXYNm(setupNode, 'aux_axis_origin')) ?? undefined,
    layers: parseBoardLayers(pcb),
    nets: nets.nets,
    netRefStyle,
    footprints,
    segments,
    trackArcs,
    vias,
    zones,
    grLines,
    grArcs,
    grCircles,
    grRects,
    grPolys,
    grTexts: remapCollection(findChildren(pcb, 'gr_text'), prev?.grTexts, parseGrText),
    grCurves,
    grTextBoxes: remapCollection(
      findChildren(pcb, 'gr_text_box'),
      prev?.grTextBoxes,
      parseFpTextBox
    ),
    tables: remapCollection(findChildren(pcb, 'table'), prev?.tables, parseTable),
    points: remapCollection(findChildren(pcb, 'point'), prev?.points, parsePoint),
    dimensions: remapCollection(findChildren(pcb, 'dimension'), prev?.dimensions, parseDimension),
    tuningPatterns: remapCollection(
      findChildren(pcb, 'generated').filter(isTuningPattern),
      prev?.tuningPatterns,
      parseTuningPattern
    ),
    _raw: root,
    _unknownNodes: unknownNodes
  }
}

// ---------------------------------------------------------------------------
// Serializer
// ---------------------------------------------------------------------------

/**
 * Per-document serialization caches, keyed by the AST root (which survives
 * remapKicadBoard, unlike the KicadBoard wrapper object). Every exported AST
 * mutator below marks the touched top-level node dirty via markNodeDirty —
 * a mutation path that skips that contract would serialize stale text, so new
 * mutators must follow it (board.test.ts guards the current surface).
 */
const serializeCaches = new WeakMap<SExprNode, WeakMap<SExprNode, string>>()

export function serializeKicadBoard(board: KicadBoard): string {
  let cache = serializeCaches.get(board._raw)
  if (!cache) {
    cache = new WeakMap()
    serializeCaches.set(board._raw, cache)
  }
  // Trailing newline, as the symbol and schematic writers emit and as KiCad
  // writes — without it a round trip differs from disk by exactly one byte.
  return serializeSExprCached(board._raw, cache, true)
}

/** Cooperative serialize-cache warm for this board (see warmSerializeCache). */
export function* warmBoardSerializeCacheSteps(board: KicadBoard): Generator<number, void> {
  let cache = serializeCaches.get(board._raw)
  if (!cache) {
    cache = new WeakMap()
    serializeCaches.set(board._raw, cache)
  }
  yield* warmSerializeCache(board._raw, cache)
}

/** Resolve a net number to its name ("" for the unconnected net 0). */
/**
 * A zone's hatch settings when it pours hatched, with KiCad's defaults
 * (`ZONE_SETTINGS`) for what the file leaves out: a web of the larger of four
 * minimum widths and 1 mm is the constructor's; files written by KiCad carry
 * every field.
 */
function hatchFillOf(
  fill: SExprList | null,
  num: (token: string) => number | undefined
): Pick<KicadBoardZone, 'hatchFill'> {
  const mode = fill ? findChild(fill, 'mode') : null
  if (!mode || getFirstAtomValue(mode) !== 'hatch') return {}
  return {
    hatchFill: {
      thickness: num('hatch_thickness') ?? 1,
      gap: num('hatch_gap') ?? 1.5,
      orientation: num('hatch_orientation') ?? 0,
      smoothingLevel: num('hatch_smoothing_level') ?? 0,
      smoothingValue: num('hatch_smoothing_value') ?? 0.1,
      minHoleArea: num('hatch_min_hole_area') ?? 0.15
    }
  }
}

/** A zone's corner smoothing, when it has one: KiCad ignores it on rule areas and with no radius. */
function smoothingOf(
  fill: SExprList | null,
  radius: Nm | undefined
): Pick<KicadBoardZone, 'smoothing' | 'smoothingRadius'> {
  const node = fill ? findChild(fill, 'smoothing') : null
  const style = node ? getFirstAtomValue(node) : undefined
  if ((style !== 'chamfer' && style !== 'fillet') || !radius) return {}
  return { smoothing: style, smoothingRadius: radius }
}

/**
 * KiCad 7's teardrops, which KiCad never rebuilds (`BOARD::LegacyTeardrops`):
 * `(legacy_teardrops yes)`, or a file from before 20230517 holding a teardrop
 * zone, since the flag is written only on its first save.
 */
export function hasLegacyTeardrops(board: KicadBoard): boolean {
  const general = findChild(board._raw as SExprList, 'general')
  const flag = general ? findChild(general, 'legacy_teardrops') : null
  if (flag) return getFirstAtomValue(flag) !== 'no'
  return (board.version ?? 0) < 20230517 && board.zones.some(isTeardropZone)
}

/** KiCad's `(attr (teardrop …))`: a zone that widens a track into a pad; DRC reads it as a track. */
export const isTeardropZone = (zone: KicadBoardZone): boolean => {
  // Read per node once: the filler asks it of every zone pair.
  let known = teardropNodes.get(zone._raw)
  if (known === undefined) {
    const attr = findChild(zone._raw, 'attr')
    known = attr !== null && findChild(attr, 'teardrop') !== null
    teardropNodes.set(zone._raw, known)
  }
  return known
}
const teardropNodes = new WeakMap<SExprNode, boolean>()

/**
 * KiCad's text variables in a board's own text, resolved from the board: the
 * title block's (`${TITLE}`, `${ISSUE_DATE}`, `${REVISION}`, `${COMPANY}`,
 * `${COMMENT1}`…`${COMMENT9}`) and `${LAYER}`, then the project's text
 * variables — which also answer a title-block name the block leaves empty. A
 * title-block name nothing answers is empty text; anything else unresolved
 * stays as written, which is what KiCad draws for it.
 */
export function expandBoardText(
  text: string,
  board: KicadBoard,
  layer?: string,
  variables: Readonly<Record<string, string>> = {}
): string {
  if (!text.includes('${')) return text
  // A design-rule marker raises a finding and shows as nothing.
  text = text.replace(/(^|[^\\])\$\{DRC_(?:ERROR|WARNING)\b[^}]*\}/g, '$1')
  const block = board._raw.type === 'list' ? findChild(board._raw, 'title_block') : null
  const field = (token: string): string => {
    const node = block ? findChild(block, token) : null
    return (node && getFirstAtomValue(node)) ?? ''
  }
  const comment = (n: number): string => {
    for (const node of block ? findChildren(block, 'comment') : []) {
      const [index, value] = getAtomValues(node)
      if (Number(index) === n) return value ?? ''
    }
    return ''
  }
  const titled = (name: string): string | null => {
    switch (name) {
      case 'TITLE':
        return field('title')
      case 'ISSUE_DATE':
        return field('date')
      case 'REVISION':
        return field('rev')
      case 'COMPANY':
        return field('company')
      default: {
        const match = /^COMMENT([1-9])$/.exec(name)
        return match ? comment(Number(match[1])) : null
      }
    }
  }
  return text.replace(/\$\{([A-Za-z_0-9]+)\}/g, (whole, name: string) => {
    if (name === 'LAYER' && layer) return layer
    const fromBlock = titled(name)
    if (fromBlock) return fromBlock
    if (Object.hasOwn(variables, name)) return variables[name]
    return fromBlock ?? whole
  })
}

export function getNetName(board: KicadBoard, netNumber: number): string {
  return board.nets.find((n) => n.number === netNumber)?.name ?? ''
}

/**
 * Per-net DISPLAY names, KiCad's rules exactly (NETINFO_LIST::
 * RebuildDisplayNetnames): a hierarchical net shows its short name — the part
 * after the last '/' ("/USB/CC2" → "CC2") — and when two nets' short names
 * collide, each shows the minimal distinguishing path suffix instead
 * ("/a/SIG" and "/b/SIG" → "a/SIG" / "b/SIG"; a root-level collision falls
 * back to the full name). Names are grouped raw, as KiCad groups them, and
 * each is then shown as its letters: unescaped, markup dropped
 * (`PCIe_{C1x1}` reads `PCIeC1x1`), since the canvas's label typeface cannot
 * shift a subscript or bar a name (`markupToPlainText`).
 */
export function netDisplayNames(nets: readonly KicadNet[]): Map<number, string> {
  const shortOf = (name: string): string =>
    name.includes('/') ? name.slice(name.lastIndexOf('/') + 1) : name

  const groups = new Map<string, KicadNet[]>()
  for (const net of nets) {
    const short = shortOf(net.name)
    const list = groups.get(short)
    if (list) list.push(net)
    else groups.set(short, [net])
  }

  const out = new Map<number, string>()
  for (const [short, group] of groups) {
    if (group.length === 1) {
      out.set(group[0].number, markupToPlainText(short))
      continue
    }
    const partsOf = group.map((net) => net.name.split('/'))
    for (let g = 0; g < group.length; g++) {
      const parts = partsOf[g]
      let firstNonCommon: number | undefined
      for (let i = 0; i < parts.length && firstNonCommon === undefined; i++) {
        for (const other of partsOf) {
          if (i < other.length && other[i] === parts[i]) continue
          firstNonCommon = i
          break
        }
      }
      const cut = firstNonCommon ?? 0
      out.set(
        group[g].number,
        markupToPlainText(
          cut > 0 && cut < parts.length ? parts.slice(cut).join('/') : group[g].name
        )
      )
    }
  }
  return out
}

/**
 * The atom a `(net …)` ref carries in this board's dialect (netRefStyle):
 * `["3", false]` numeric, or `["GND", true]` quoted-by-name for KiCad 10.
 */
function netRefAtom(board: KicadBoard, net: number): [string, boolean] {
  return board.netRefStyle === 'name' ? [getNetName(board, net), true] : [net.toString(), false]
}

// ---------------------------------------------------------------------------
// AST mutations (write-through, format-preserving)
// ---------------------------------------------------------------------------

/**
 * Stackup arithmetic (a board thickness minus its copper) lands on values like
 * 1.5299999999999998, so these writes need quantizing like every other. Use the
 * one write-side quantizer (coordinates.ts) rather than a local rounder: it
 * snaps to the same 1 nm grid the rest of the file is written on.
 */
const mm = formatKicadNumber

export function updateSegmentInAST(
  seg: KicadTrackSegment,
  data: Partial<Pick<KicadTrackSegment, 'start' | 'end' | 'width' | 'layer' | 'net'>>,
  board?: KicadBoard
): void {
  const root = seg._raw
  markNodeDirty(root)
  if (data.start !== undefined) {
    seg.start = { ...seg.start, ...data.start }
    setXYChild(root, 'start', seg.start.x, seg.start.y)
  }
  if (data.end !== undefined) {
    seg.end = { ...seg.end, ...data.end }
    setXYChild(root, 'end', seg.end.x, seg.end.y)
  }
  if (data.width !== undefined) {
    seg.width = data.width
    setScalarChild(root, 'width', formatNmAtom(data.width))
  }
  if (data.layer !== undefined) {
    seg.layer = data.layer
    setScalarChild(root, 'layer', data.layer, true)
  }
  if (data.net !== undefined) {
    seg.net = data.net
    const [value, quoted] = board ? netRefAtom(board, data.net) : [data.net.toString(), false]
    setScalarChild(root, 'net', value, quoted)
  }
}

export function updateTrackArcInAST(
  arc: KicadTrackArc,
  data: Partial<Pick<KicadTrackArc, 'start' | 'mid' | 'end' | 'width' | 'layer' | 'net'>>,
  board?: KicadBoard
): void {
  const root = arc._raw
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
  if (data.width !== undefined) {
    arc.width = data.width
    setScalarChild(root, 'width', formatNmAtom(data.width))
  }
  if (data.layer !== undefined) {
    arc.layer = data.layer
    setScalarChild(root, 'layer', data.layer, true)
  }
  if (data.net !== undefined) {
    arc.net = data.net
    const [value, quoted] = board ? netRefAtom(board, data.net) : [data.net.toString(), false]
    setScalarChild(root, 'net', value, quoted)
  }
}

/** Set the net of a board drawing on copper, named as the board names its nets. */
export function setGraphicNetInAST(
  item: { _raw: SExprNode; net?: number },
  net: number,
  board: KicadBoard
): void {
  const root = item._raw as SExprList
  markNodeDirty(root)
  item.net = net
  const [value, quoted] = netRefAtom(board, net)
  setScalarChild(root, 'net', value, quoted)
}

export function updateViaInAST(
  via: KicadVia,
  data: Partial<Pick<KicadVia, 'position' | 'size' | 'drill' | 'net' | 'type' | 'layers'>>,
  board?: KicadBoard
): void {
  const root = via._raw
  markNodeDirty(root)
  if (data.position !== undefined) {
    via.position = { ...via.position, ...data.position }
    setXYChild(root, 'at', via.position.x, via.position.y)
  }
  if (data.size !== undefined) {
    via.size = data.size
    setScalarChild(root, 'size', formatNmAtom(data.size))
  }
  if (data.drill !== undefined) {
    via.drill = data.drill
    setScalarChild(root, 'drill', formatNmAtom(data.drill))
  }
  if (data.net !== undefined) {
    via.net = data.net
    const [value, quoted] = board ? netRefAtom(board, data.net) : [data.net.toString(), false]
    setScalarChild(root, 'net', value, quoted)
  }
  if (data.type !== undefined) {
    // Type is a bare atom right after the `via` token: (via blind …) / (via buried …) /
    // (via micro …), KiCad 10's three. Anything else is a plain through via — no marker atom.
    const type =
      data.type === 'blind' || data.type === 'buried' || data.type === 'micro'
        ? data.type
        : undefined
    via.type = type
    root.children = root.children.filter(
      (c) =>
        !(c.type === 'atom' && (c.value === 'blind' || c.value === 'buried' || c.value === 'micro'))
    )
    if (type) root.children.splice(1, 0, makeAtom(type, false, root.start))
  }
  if (data.layers !== undefined) {
    via.layers = data.layers
    const node = findOrCreateChild(root, 'layers')
    const at = node.start
    node.children = [
      makeAtom('layers', false, at),
      ...data.layers.map((l) => makeAtom(l, true, at))
    ]
  }
}

/** Edit board-level meta: thickness ((general (thickness …))) and paper size. */
export function updateBoardMetaInAST(
  board: KicadBoard,
  data: { thickness?: Nm; paper?: string }
): void {
  const root = board._raw as SExprList
  if (data.thickness !== undefined) {
    board.thickness = data.thickness
    const general = findOrCreateChild(root, 'general')
    markNodeDirty(general)
    setScalarChild(general, 'thickness', formatNmAtom(data.thickness))
  }
  if (data.paper !== undefined) {
    board.paper = data.paper
    setScalarChild(root, 'paper', data.paper, true)
    const paperNode = findChild(root, 'paper')
    if (paperNode) markNodeDirty(paperNode)
  }
}

/**
 * Edit one physical stackup row (thickness, material, dielectric constants, ...).
 * Marks the owning `setup` node dirty, not the layer: the serialize cache is
 * keyed on the root's direct children.
 */
export function updateStackupLayerInAST(
  stackup: KicadStackup,
  layer: KicadStackupLayer,
  data: Partial<Omit<KicadStackupLayer, 'name' | '_raw'>>
): void {
  markNodeDirty(stackup._setup)
  const root = layer._raw
  if (data.type !== undefined) {
    layer.type = data.type
    setScalarChild(root, 'type', data.type, true)
  }
  if (data.thickness !== undefined) {
    layer.thickness = data.thickness
    setScalarChild(root, 'thickness', formatNmAtom(data.thickness))
  }
  if (data.material !== undefined) {
    layer.material = data.material
    setScalarChild(root, 'material', data.material, true)
  }
  if (data.epsilonR !== undefined) {
    layer.epsilonR = data.epsilonR
    setScalarChild(root, 'epsilon_r', mm(data.epsilonR))
  }
  if (data.lossTangent !== undefined) {
    layer.lossTangent = data.lossTangent
    setScalarChild(root, 'loss_tangent', mm(data.lossTangent))
  }
  if (data.color !== undefined) {
    layer.color = data.color
    setScalarChild(root, 'color', data.color, true)
  }
}

/** Edit the stackup's board-wide settings (finish, plating flags). */
export function updateStackupSettingsInAST(
  stackup: KicadStackup,
  data: Partial<
    Pick<KicadStackup, 'copperFinish' | 'dielectricConstraints' | 'castellatedPads' | 'edgePlating'>
  >
): void {
  markNodeDirty(stackup._setup)
  const root = stackup._raw
  const yesNo = (v: boolean): string => (v ? 'yes' : 'no')
  if (data.copperFinish !== undefined) {
    stackup.copperFinish = data.copperFinish
    setScalarChild(root, 'copper_finish', data.copperFinish, true)
  }
  if (data.dielectricConstraints !== undefined) {
    stackup.dielectricConstraints = data.dielectricConstraints
    setScalarChild(root, 'dielectric_constraints', yesNo(data.dielectricConstraints))
  }
  if (data.castellatedPads !== undefined) {
    stackup.castellatedPads = data.castellatedPads
    setScalarChild(root, 'castellated_pads', yesNo(data.castellatedPads))
  }
  if (data.edgePlating !== undefined) {
    stackup.edgePlating = data.edgePlating
    setScalarChild(root, 'edge_plating', yesNo(data.edgePlating))
  }
}

/** Edit a board gr_text (text/position/layer/hide/font effects). */
export function updateGrTextInAST(text: KicadGrText, data: Partial<KicadGrText>): void {
  const root = text._raw
  markNodeDirty(root)
  if (data.text !== undefined) {
    text.text = data.text
    setPositionalAtom(root, 1, data.text)
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
  if (data.knockout !== undefined) {
    text.knockout = data.knockout
    setTextSwitchesInAST(root, { knockout: data.knockout })
  }
}

/**
 * Move a placed footprint. Only the (at ..) placement changes: child
 * coordinates are relative, so pads/graphics follow automatically.
 */
export function moveBoardFootprintInAST(bfp: KicadBoardFootprint, x: Nm, y: Nm): void {
  markNodeDirty(bfp._raw)
  const dx = x - bfp.position.x
  const dy = y - bfp.position.y
  bfp.position = { ...bfp.position, x, y }
  setAtChild(bfp._raw, x, y, bfp.position.angle)
  mapFootprintZonesInAST(bfp, (p) => ({ x: nm(p.x + dx), y: nm(p.y + dy) }))
}

/** A footprint zone read as a board zone, kept while its outline and fill stand. */
const footprintZoneCache = new WeakMap<
  SExprNode,
  { points: unknown; fills: unknown; zone: KicadBoardZone }
>()

/**
 * The zones footprints carry, read as board zones: copper the checks, the
 * connectivity and the filler meet as KiCad meets it, board-absolute as the
 * file holds them. KiCad never refills them; their stored fill stands. Read
 * from the footprints' own zones, so a footprint moved, turned or flipped
 * reads anew.
 */
export function footprintZones(board: KicadBoard): KicadBoardZone[] {
  let nets: NetResolver | null = null
  const resolver = (): NetResolver => (nets ??= makeNetResolver(board.nets))
  return board.footprints.flatMap((bfp, fp) =>
    zonesAsBoardZones(bfp.footprint, resolver).map((zone) => {
      zone.footprint = fp
      return zone
    })
  )
}

/**
 * One footprint's zones read as board zones, as `footprintZones` reads them:
 * board-absolute on a board, footprint-local in a `.kicad_mod`. Net names
 * resolve against `nets` (a library footprint has none).
 */
export function footprintZonesOf(
  footprint: KicadFootprint,
  nets: KicadNet[] = []
): KicadBoardZone[] {
  let resolver: NetResolver | null = null
  return zonesAsBoardZones(footprint, () => (resolver ??= makeNetResolver(nets)))
}

function zonesAsBoardZones(footprint: KicadFootprint, nets: () => NetResolver): KicadBoardZone[] {
  return footprint.zones.flatMap((own) => {
    if (own._raw.type !== 'list') return []
    const cached = footprintZoneCache.get(own._raw)
    if (cached && cached.points === own.points && cached.fills === own.filledPolys)
      return [cached.zone]
    const zone = parseBoardZone(own._raw, nets())
    footprintZoneCache.set(own._raw, { points: own.points, fills: own.filledPolys, zone })
    return [zone]
  })
}

/**
 * Every zone on the board, its own first and then the footprints' — what the
 * checks and the connectivity index zones by.
 */
export function allZones(board: KicadBoard): KicadBoardZone[] {
  return [...board.zones, ...footprintZones(board)]
}

/**
 * Apply a point map to every zone of a placed footprint — outline and fills.
 * A board file holds a footprint's zones board-absolute, unlike its pads and
 * graphics, so they move with the footprint only when moved explicitly.
 */
export function mapFootprintZonesInAST(
  bfp: KicadBoardFootprint,
  map: (p: { x: Nm; y: Nm }) => { x: Nm; y: Nm }
): void {
  for (const zone of bfp.footprint.zones) {
    const root = zone._raw as SExprList
    zone.points = zone.points.map(map)
    setPointsChild(findOrCreateChild(root, 'polygon'), zone.points)
    if (!zone.filledPolys) continue
    zone.filledPolys = zone.filledPolys.map((points) => points.map(map))
    findChildren(root, 'filled_polygon').forEach((node, i) => {
      const fill = zone.filledPolys?.[i]
      if (fill) setPointsChild(node, fill)
    })
  }
}

/**
 * Rotate a placed footprint to `newAngle` (degrees). Pad and text angles in
 * board files are absolute (they include the footprint rotation), so the
 * rotation delta is applied to every child (at .. angle) as well.
 */
export function rotateBoardFootprintInAST(bfp: KicadBoardFootprint, newAngle: number): void {
  const oldAngle = bfp.position.angle ?? 0
  const delta = newAngle - oldAngle
  if (delta === 0) return

  markNodeDirty(bfp._raw)
  const normalized = ((newAngle % 360) + 360) % 360
  bfp.position = { ...bfp.position, angle: normalized === 0 ? undefined : normalized }
  setAtChild(bfp._raw, bfp.position.x, bfp.position.y, bfp.position.angle)

  const rotateChildAt = (node: SExprNode, pos: { x: Nm; y: Nm; angle?: number }): void => {
    if (node.type !== 'list') return
    const abs = ((((pos.angle ?? 0) + delta) % 360) + 360) % 360
    pos.angle = abs === 0 ? undefined : abs
    setAtChild(node, pos.x, pos.y, pos.angle)
  }

  // Zones are board-absolute: turn their points about the footprint's origin
  // (y down, so a positive angle turns counterclockwise on screen).
  const rad = (delta * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const { x: cx, y: cy } = bfp.position
  mapFootprintZonesInAST(bfp, (p) => ({
    x: nm(cx + (p.x - cx) * cos + (p.y - cy) * sin),
    y: nm(cy - (p.x - cx) * sin + (p.y - cy) * cos)
  }))

  const fp = bfp.footprint
  fp.pads.forEach((pad) => rotateChildAt(pad._raw, pad.position))
  fp.properties.forEach((prop) => {
    if (prop.position) rotateChildAt(prop._raw, prop.position)
  })
  fp.fpTexts.forEach((text) => {
    if (text.position) rotateChildAt(text._raw, text.position)
  })
}

/**
 * Translate a zone: moves both the outline polygon and any filled polygons
 * so the fill visually follows (KiCad would refill on its next DRC pass).
 */
export function translateBoardZoneInAST(zone: KicadBoardZone, dx: Nm, dy: Nm): void {
  markNodeDirty(zone._raw)
  zone.points = zone.points.map((p) => ({ x: nm(p.x + dx), y: nm(p.y + dy) }))
  const polyNode = findOrCreateChild(zone._raw, 'polygon')
  setPointsChild(polyNode, zone.points)

  zone.filledPolys = zone.filledPolys.map((fp) => ({
    layer: fp.layer,
    points: fp.points.map((p) => ({ x: nm(p.x + dx), y: nm(p.y + dy) }))
  }))
  const filledNodes = findChildren(zone._raw, 'filled_polygon')
  filledNodes.forEach((node, i) => {
    const fill = zone.filledPolys[i]
    if (fill) setPointsChild(node, fill.points)
  })
}

// ---------------------------------------------------------------------------
// Node builders (adding new elements to the board)
// ---------------------------------------------------------------------------

function buildList(at: number, token: string, ...items: SExprNode[]): SExprList {
  return {
    type: 'list',
    children: [makeAtom(token, false, at), ...items],
    start: at,
    end: at
  }
}

function buildValueList(
  at: number,
  token: string,
  values: Array<string | number>,
  quoted = false
): SExprList {
  return buildList(
    at,
    token,
    ...values.map((v) =>
      makeAtom(
        typeof v === 'number' ? formatKicadNumber(v) : v,
        quoted && typeof v === 'string',
        at
      )
    )
  )
}

/** Append a (segment ...) node; returns the new segment's index. */
export function addSegmentToBoardAST(
  board: KicadBoard,
  data: {
    start: { x: Nm; y: Nm }
    end: { x: Nm; y: Nm }
    width: Nm
    layer: string
    net: number
    /** Its uuid, where the caller must know it (a tuning pattern's members); else a new one. */
    uuid?: string
  }
): number {
  const root = board._raw as SExprList
  const at = root.start
  const node = buildList(
    at,
    'segment',
    buildValueList(at, 'start', [formatNmAtom(data.start.x), formatNmAtom(data.start.y)]),
    buildValueList(at, 'end', [formatNmAtom(data.end.x), formatNmAtom(data.end.y)]),
    buildValueList(at, 'width', [formatNmAtom(data.width)]),
    buildValueList(at, 'layer', [data.layer], true),
    buildValueList(at, 'net', [netRefAtom(board, data.net)[0]], netRefAtom(board, data.net)[1]),
    buildValueList(at, 'uuid', [data.uuid ?? crypto.randomUUID()], true)
  )
  root.children.push(node)
  return board.segments.length
}

/** Append a track (arc ...) node; returns the new arc's index. */
export function addTrackArcToBoardAST(
  board: KicadBoard,
  data: {
    start: { x: Nm; y: Nm }
    mid: { x: Nm; y: Nm }
    end: { x: Nm; y: Nm }
    width: Nm
    layer: string
    net: number
    /** Its uuid, where the caller must know it; else a new one. */
    uuid?: string
  }
): number {
  const root = board._raw as SExprList
  const at = root.start
  const xy = (key: string, p: { x: Nm; y: Nm }): SExprList =>
    buildValueList(at, key, [formatNmAtom(p.x), formatNmAtom(p.y)])
  const node = buildList(
    at,
    'arc',
    xy('start', data.start),
    xy('mid', data.mid),
    xy('end', data.end),
    buildValueList(at, 'width', [formatNmAtom(data.width)]),
    buildValueList(at, 'layer', [data.layer], true),
    buildValueList(at, 'net', [netRefAtom(board, data.net)[0]], netRefAtom(board, data.net)[1]),
    buildValueList(at, 'uuid', [data.uuid ?? crypto.randomUUID()], true)
  )
  root.children.push(node)
  return board.trackArcs.length
}

/** A length tuning pattern as KiCad 10 writes it (`PCB_TUNING_PATTERN`): what was tuned, how, and its tracks. */
/** A point of a pattern's base line; with `mid`, the arc to it from the point before runs through `mid`. */
export interface BaseLinePoint {
  x: Nm
  y: Nm
  mid?: { x: Nm; y: Nm }
}

export interface TuningPatternData {
  layer: string
  mode: 'single' | 'diff_pair' | 'diff_pair_skew'
  origin: { x: Nm; y: Nm }
  end: { x: Nm; y: Nm }
  baseLine: BaseLinePoint[]
  baseLineCoupled?: BaseLinePoint[]
  initialSide: 'left' | 'right' | 'default'
  /** Millimeters, as the file writes them. */
  minAmplitude: number
  maxAmplitude: number
  minSpacing: number
  cornerRadiusPercent: number
  rounded: boolean
  singleSided: boolean
  targetLength: { min: number; opt: number; max: number }
  targetSkew: { min: number; opt: number; max: number }
  /** A time-domain tune's target, ps (KiCad's `is_time_domain`, `target_delay`); absent tuned in length. */
  targetDelay?: { min: number; opt: number; max: number }
  overrideCustomRules: boolean
  lastNetName: string
  lastStatus: 'tuned' | 'too_short' | 'too_long'
  lastTrackWidth: number
  lastDiffPairGap: number
  lastTuningLength: number
  /** The uuids of its tracks and arcs. */
  members: string[]
}

/** KiCad's "no constraint" for a tuning pattern's lengths: a million millimeters. */
const UNCONSTRAINED = 1000000

/** A tuning pattern on the board: KiCad's `PCB_TUNING_PATTERN`, its tracks by uuid. */
export interface KicadTuningPattern extends TuningPatternData {
  uuid: string
  _raw: SExprList
}

/** The keyed children of a tuning pattern, in the order KiCad writes them (`uuid`, `type` and `name` apart). */
function tuningPatternChildren(at: number, data: TuningPatternData): SExprList[] {
  // Unbounded is KiCad's "no constraint", on the side it is unbounded.
  const mm = (v: number): number =>
    Number.isFinite(v) ? Math.round(v * 1e6) / 1e6 : v < 0 ? -UNCONSTRAINED : UNCONSTRAINED
  const yes = (b: boolean): string => (b ? 'yes' : 'no')
  const coords = (p: { x: Nm; y: Nm }): string[] => [formatNmAtom(p.x), formatNmAtom(p.y)]
  // As KiCad's `formatPolyPts`: an arc as (arc (start …) (mid …) (end …)), its start no xy of its own.
  const pts = (key: string, points: readonly BaseLinePoint[]): SExprList =>
    buildList(
      at,
      key,
      buildList(
        at,
        'pts',
        ...points.flatMap((p, i) => {
          if (points[i + 1]?.mid) return []
          if (!p.mid || i === 0) return [buildValueList(at, 'xy', coords(p))]
          return [
            buildList(
              at,
              'arc',
              buildValueList(at, 'start', coords(points[i - 1])),
              buildValueList(at, 'mid', coords(p.mid)),
              buildValueList(at, 'end', coords(p))
            )
          ]
        })
      )
    )
  const xy = (key: string, p: { x: Nm; y: Nm }): SExprList =>
    buildList(at, key, buildValueList(at, 'xy', [formatNmAtom(p.x), formatNmAtom(p.y)]))
  return [
    buildValueList(at, 'layer', [data.layer], true),
    pts('base_line', data.baseLine),
    ...(data.baseLineCoupled ? [pts('base_line_coupled', data.baseLineCoupled)] : []),
    buildValueList(at, 'corner_radius_percent', [data.cornerRadiusPercent]),
    xy('end', data.end),
    buildValueList(at, 'initial_side', [data.initialSide], true),
    buildValueList(at, 'is_time_domain', [yes(!!data.targetDelay)]),
    buildValueList(at, 'last_diff_pair_gap', [mm(data.lastDiffPairGap)]),
    buildValueList(at, 'last_netname', [data.lastNetName], true),
    buildValueList(at, 'last_status', [data.lastStatus], true),
    buildValueList(at, 'last_track_width', [mm(data.lastTrackWidth)]),
    buildValueList(at, 'last_tuning_length', [mm(data.lastTuningLength)]),
    buildValueList(at, 'max_amplitude', [mm(data.maxAmplitude)]),
    buildValueList(at, 'min_amplitude', [mm(data.minAmplitude)]),
    buildValueList(at, 'min_spacing', [mm(data.minSpacing)]),
    xy('origin', data.origin),
    buildValueList(at, 'override_custom_rules', [yes(data.overrideCustomRules)]),
    buildValueList(at, 'rounded', [yes(data.rounded)]),
    buildValueList(at, 'single_sided', [yes(data.singleSided)]),
    // A delay is ps in the file, as a length is mm: KiCad's same million-to-one scale.
    buildValueList(at, 'target_delay', [
      data.targetDelay ? mm(data.targetDelay.opt) : UNCONSTRAINED
    ]),
    buildValueList(at, 'target_delay_max', [
      data.targetDelay ? mm(data.targetDelay.max) : UNCONSTRAINED
    ]),
    buildValueList(at, 'target_delay_min', [data.targetDelay ? mm(data.targetDelay.min) : 0]),
    buildValueList(at, 'target_length', [mm(data.targetLength.opt)]),
    buildValueList(at, 'target_length_max', [mm(data.targetLength.max)]),
    buildValueList(at, 'target_length_min', [mm(data.targetLength.min)]),
    buildValueList(at, 'target_skew', [mm(data.targetSkew.opt)]),
    buildValueList(at, 'target_skew_max', [mm(data.targetSkew.max)]),
    buildValueList(at, 'target_skew_min', [mm(data.targetSkew.min)]),
    buildValueList(at, 'tuning_mode', [data.mode], true),
    // Sorted, as KiCad writes them, so its next save leaves the line alone.
    buildValueList(at, 'members', [...data.members].sort(), true)
  ]
}

/**
 * Append a tuning pattern (`(generated (type tuning_pattern) …)`), its keys
 * in the order KiCad writes them, so KiCad reads it back and re-tunes it.
 * Returns its uuid.
 */
export function addTuningPatternToBoardAST(board: KicadBoard, data: TuningPatternData): string {
  const root = board._raw as SExprList
  const at = root.start
  const uuid = crypto.randomUUID()
  const node = buildList(
    at,
    'generated',
    buildValueList(at, 'uuid', [uuid], true),
    buildValueList(at, 'type', ['tuning_pattern']),
    buildValueList(at, 'name', ['Tuning Pattern'], true),
    ...tuningPatternChildren(at, data)
  )
  root.children.push(node)
  return uuid
}

/**
 * Re-tune a pattern in place: each key it writes is replaced where it
 * stands, a missing one appended, and any key KiCad wrote that we do not
 * model is left as it was.
 */
export function updateTuningPatternInAST(
  pattern: KicadTuningPattern,
  data: TuningPatternData
): void {
  const root = pattern._raw
  markNodeDirty(root)
  for (const child of tuningPatternChildren(root.start, data)) {
    const token = getToken(child)
    const i = root.children.findIndex((c) => c.type === 'list' && getToken(c) === token)
    if (i >= 0) root.children[i] = child
    else root.children.push(child)
  }
  if (!data.baseLineCoupled) {
    const i = root.children.findIndex(
      (c) => c.type === 'list' && getToken(c) === 'base_line_coupled'
    )
    if (i >= 0) root.children.splice(i, 1)
  }
  Object.assign(pattern, data)
  if (!data.baseLineCoupled) delete pattern.baseLineCoupled
  if (!data.targetDelay) delete pattern.targetDelay
}

/** A pattern's base line as KiCad writes it (`formatPolyPts`): points, and arcs kept whole with their middles. */
function parseBaseLine(ptsNode: SExprList | null): BaseLinePoint[] {
  if (!ptsNode || ptsNode instanceof PackedPtsNode) return parsePointList(ptsNode)
  const pointOf = (n: SExprList | null): { x: Nm; y: Nm } | null => {
    const atoms = n ? getAtomValues(n) : []
    return atoms.length >= 2 ? { x: mmAtomToNm(atoms[0]), y: mmAtomToNm(atoms[1]) } : null
  }
  const out: BaseLinePoint[] = []
  for (const child of ptsNode.children) {
    if (child.type !== 'list') continue
    const token = getToken(child)
    if (token === 'xy') {
      const p = pointOf(child)
      if (p) out.push(p)
    } else if (token === 'arc') {
      const a = pointOf(findChild(child, 'start'))
      const m = pointOf(findChild(child, 'mid'))
      const b = pointOf(findChild(child, 'end'))
      if (!a || !m || !b) continue
      const last = out[out.length - 1]
      if (!last || last.x !== a.x || last.y !== a.y) out.push(a)
      out.push({ ...b, mid: m })
    }
  }
  return out
}

/** The `(generated (type tuning_pattern) …)` nodes of a board; other generators are left as unknown nodes. */
function isTuningPattern(node: SExprList): boolean {
  return childValue(node, 'type') === 'tuning_pattern'
}

function parseTuningPattern(node: SExprList): KicadTuningPattern {
  const num = (key: string, fallback = 0): number => {
    const child = findChild(node, key)
    const v = child ? getNumericValue(child) : NaN
    if (!Number.isFinite(v)) return fallback
    return v >= UNCONSTRAINED ? Infinity : v <= -UNCONSTRAINED ? -Infinity : v
  }
  const flag = (key: string): boolean => childValue(node, key) === 'yes'
  const xy = (key: string): { x: Nm; y: Nm } => {
    const child = findChild(node, key)
    const point = child ? findChild(child, 'xy') : null
    const atoms = point ? getAtomValues(point) : []
    return atoms.length >= 2
      ? { x: mmAtomToNm(atoms[0]), y: mmAtomToNm(atoms[1]) }
      : { x: nm(0), y: nm(0) }
  }
  const pts = (key: string): BaseLinePoint[] | undefined => {
    const child = findChild(node, key)
    return child ? parseBaseLine(findChild(child, 'pts')) : undefined
  }
  const range = (key: string): { min: number; opt: number; max: number } => ({
    min: num(`${key}_min`),
    opt: num(key),
    max: num(`${key}_max`)
  })
  const mode = childValue(node, 'tuning_mode')
  const side = childValue(node, 'initial_side')
  const status = childValue(node, 'last_status')
  const coupled = pts('base_line_coupled')
  const membersNode = findChild(node, 'members')
  return {
    uuid: uuidOf(node) ?? '',
    layer: childValue(node, 'layer') ?? 'F.Cu',
    mode: mode === 'diff_pair' || mode === 'diff_pair_skew' ? mode : 'single',
    origin: xy('origin'),
    end: xy('end'),
    baseLine: pts('base_line') ?? [],
    ...(coupled ? { baseLineCoupled: coupled } : {}),
    initialSide: side === 'left' || side === 'right' ? side : 'default',
    minAmplitude: num('min_amplitude'),
    maxAmplitude: num('max_amplitude'),
    minSpacing: num('min_spacing'),
    cornerRadiusPercent: num('corner_radius_percent', 100),
    rounded: flag('rounded'),
    singleSided: flag('single_sided'),
    targetLength: range('target_length'),
    targetSkew: range('target_skew'),
    ...(flag('is_time_domain') ? { targetDelay: range('target_delay') } : {}),
    overrideCustomRules: flag('override_custom_rules'),
    lastNetName: childValue(node, 'last_netname') ?? '',
    lastStatus: status === 'too_short' || status === 'too_long' ? status : 'tuned',
    lastTrackWidth: num('last_track_width'),
    lastDiffPairGap: num('last_diff_pair_gap'),
    lastTuningLength: num('last_tuning_length'),
    members: membersNode ? getAtomValues(membersNode) : [],
    _raw: node
  }
}

/** Append a (via ...) node; returns the new via's index. */
export function addViaToBoardAST(
  board: KicadBoard,
  data: {
    position: { x: Nm; y: Nm }
    size: Nm
    drill: Nm
    layers: string[]
    net: number
    /** Absent for a through via, which KiCad writes with no marker. */
    type?: 'blind' | 'buried' | 'micro'
  }
): number {
  const root = board._raw as SExprList
  const at = root.start
  const node = buildList(
    at,
    'via',
    ...(data.type ? [makeAtom(data.type, false, at)] : []),
    buildValueList(at, 'at', [formatNmAtom(data.position.x), formatNmAtom(data.position.y)]),
    buildValueList(at, 'size', [formatNmAtom(data.size)]),
    buildValueList(at, 'drill', [formatNmAtom(data.drill)]),
    buildList(at, 'layers', ...data.layers.map((l) => makeAtom(l, true, at))),
    buildValueList(at, 'net', [netRefAtom(board, data.net)[0]], netRefAtom(board, data.net)[1]),
    buildValueList(at, 'uuid', [crypto.randomUUID()], true)
  )
  root.children.push(node)
  return board.vias.length
}

/** (stroke (width w) (type default)) — the v7+ stroke every fresh graphic carries. */
function buildStrokeNode(at: number, width: Nm): SExprList {
  return buildList(
    at,
    'stroke',
    buildValueList(at, 'width', [formatNmAtom(width)]),
    buildValueList(at, 'type', ['default'])
  )
}

function buildUuidNode(at: number): SExprList {
  return buildValueList(at, 'uuid', [crypto.randomUUID()], true)
}

/** Append a (gr_line ...) node; returns the new line's index. */
export function addGrLineToBoardAST(
  board: KicadBoard,
  data: {
    start: { x: Nm; y: Nm }
    end: { x: Nm; y: Nm }
    width: Nm
    layer: string
  }
): number {
  const root = board._raw as SExprList
  const at = root.start
  root.children.push(
    buildList(
      at,
      'gr_line',
      buildValueList(at, 'start', [formatNmAtom(data.start.x), formatNmAtom(data.start.y)]),
      buildValueList(at, 'end', [formatNmAtom(data.end.x), formatNmAtom(data.end.y)]),
      buildStrokeNode(at, data.width),
      buildValueList(at, 'layer', [data.layer], true),
      buildUuidNode(at)
    )
  )
  return board.grLines.length
}

/** Append a (gr_arc ...) node; returns the new arc's index. */
export function addGrArcToBoardAST(
  board: KicadBoard,
  data: {
    start: { x: Nm; y: Nm }
    mid: { x: Nm; y: Nm }
    end: { x: Nm; y: Nm }
    width: Nm
    layer: string
  }
): number {
  const root = board._raw as SExprList
  const at = root.start
  root.children.push(
    buildList(
      at,
      'gr_arc',
      buildValueList(at, 'start', [formatNmAtom(data.start.x), formatNmAtom(data.start.y)]),
      buildValueList(at, 'mid', [formatNmAtom(data.mid.x), formatNmAtom(data.mid.y)]),
      buildValueList(at, 'end', [formatNmAtom(data.end.x), formatNmAtom(data.end.y)]),
      buildStrokeNode(at, data.width),
      buildValueList(at, 'layer', [data.layer], true),
      buildUuidNode(at)
    )
  )
  return board.grArcs.length
}

/** Append a (gr_circle ...) node ((center ..) (end ..) on-rim pair); returns its index. */
export function addGrCircleToBoardAST(
  board: KicadBoard,
  data: {
    center: { x: Nm; y: Nm }
    end: { x: Nm; y: Nm }
    width: Nm
    layer: string
    fill?: 'none' | 'solid'
  }
): number {
  const root = board._raw as SExprList
  const at = root.start
  root.children.push(
    buildList(
      at,
      'gr_circle',
      buildValueList(at, 'center', [formatNmAtom(data.center.x), formatNmAtom(data.center.y)]),
      buildValueList(at, 'end', [formatNmAtom(data.end.x), formatNmAtom(data.end.y)]),
      buildStrokeNode(at, data.width),
      buildValueList(at, 'fill', [data.fill ?? 'none']),
      buildValueList(at, 'layer', [data.layer], true),
      buildUuidNode(at)
    )
  )
  return board.grCircles.length
}

/** Append a (gr_rect ...) node; returns the new rectangle's index. */
export function addGrRectToBoardAST(
  board: KicadBoard,
  data: {
    start: { x: Nm; y: Nm }
    end: { x: Nm; y: Nm }
    width: Nm
    layer: string
    fill?: 'none' | 'solid'
  }
): number {
  const root = board._raw as SExprList
  const at = root.start
  root.children.push(
    buildList(
      at,
      'gr_rect',
      buildValueList(at, 'start', [formatNmAtom(data.start.x), formatNmAtom(data.start.y)]),
      buildValueList(at, 'end', [formatNmAtom(data.end.x), formatNmAtom(data.end.y)]),
      buildStrokeNode(at, data.width),
      buildValueList(at, 'fill', [data.fill ?? 'none']),
      buildValueList(at, 'layer', [data.layer], true),
      buildUuidNode(at)
    )
  )
  return board.grRects.length
}

/** Append a (gr_poly ...) node (implicitly closed outline); returns its index. */
export function addGrPolyToBoardAST(
  board: KicadBoard,
  data: {
    points: Array<{ x: Nm; y: Nm }>
    width: Nm
    layer: string
    fill?: 'none' | 'solid'
  }
): number {
  const root = board._raw as SExprList
  const at = root.start
  root.children.push(
    buildList(
      at,
      'gr_poly',
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
  return board.grPolys.length
}

/** Append a (gr_text ...) node; returns the new text's index. */
export function addGrTextToBoardAST(
  board: KicadBoard,
  data: {
    text: string
    position: { x: Nm; y: Nm; angle?: number }
    layer: string
    /** Font height/width (KiCad text is sized square by default). */
    size: Nm
    thickness: Nm
  }
): number {
  const root = board._raw as SExprList
  const at = root.start
  const atValues =
    data.position.angle !== undefined && data.position.angle !== 0
      ? [formatNmAtom(data.position.x), formatNmAtom(data.position.y), data.position.angle]
      : [formatNmAtom(data.position.x), formatNmAtom(data.position.y)]
  root.children.push({
    type: 'list',
    children: [
      makeAtom('gr_text', false, at),
      makeAtom(data.text, true, at),
      buildValueList(at, 'at', atValues),
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
        )
      )
    ],
    start: at,
    end: at
  })
  return board.grTexts.length
}

/** Append a (gr_curve ...) node; returns the new curve's index. */
export function addGrCurveToBoardAST(
  board: KicadBoard,
  data: { points: Array<{ x: Nm; y: Nm }>; width: Nm; layer: string }
): number {
  const root = board._raw as SExprList
  root.children.push(buildCurveNode(root.start, 'gr', data))
  return board.grCurves.length
}

/** Append a (gr_text_box ...) node; returns the new box's index. */
export function addGrTextBoxToBoardAST(board: KicadBoard, data: TextBoxData): number {
  const root = board._raw as SExprList
  root.children.push(buildTextBoxNode(root.start, 'gr', data))
  return board.grTextBoxes.length
}

/** Append a (point ...) node; returns the new point's index. */
export function addPointToBoardAST(
  board: KicadBoard,
  data: { position: { x: Nm; y: Nm }; size: Nm; layer: string }
): number {
  const root = board._raw as SExprList
  root.children.push(buildPointNode(root.start, data))
  return board.points.length
}

/**
 * KiCad's zone defaults (pcbnew's ZONE_SETTINGS): what a fresh zone carries
 * before its properties are edited.
 */
const ZONE_DEFAULT_HATCH_PITCH = 0.5
const ZONE_DEFAULT_MIN_THICKNESS = 0.25
const ZONE_DEFAULT_PAD_CLEARANCE = 0.5
const ZONE_DEFAULT_THERMAL_GAP = 0.5
const ZONE_DEFAULT_THERMAL_BRIDGE = 0.5

/** (layer "X") for one layer, (layers "A" "B" ...) for several — KiCad's split. */
function buildZoneLayersNode(at: number, layers: readonly string[]): SExprList {
  return layers.length === 1
    ? buildValueList(at, 'layer', [layers[0]], true)
    : buildList(at, 'layers', ...layers.map((l) => makeAtom(l, true, at)))
}

/** What a fresh zone is: its outline, layers and net, and whether it is a rule area. */
export interface NewZone {
  points: Array<{ x: Nm; y: Nm }>
  layers: readonly string[]
  net: number
  netName: string
  keepout?: boolean
}

/**
 * A fresh (zone ...) node — a copper zone, or a keepout ("rule area") when
 * `keepout` is set — with KiCad's defaults, its net written in `netRefStyle`.
 * A footprint's zone is the same node (`footprintItems.ts`).
 */
export function buildZoneNode(
  at: number,
  data: NewZone,
  netRefStyle: KicadBoard['netRefStyle']
): SExprList {
  // KiCad 10 writes a zone on no net with no (net …) at all.
  const netChildren =
    netRefStyle === 'name'
      ? data.net === 0
        ? []
        : [buildValueList(at, 'net', [data.netName], true)]
      : [
          buildValueList(at, 'net', [data.net]),
          buildValueList(at, 'net_name', [data.netName], true)
        ]
  const children: SExprNode[] = [
    ...netChildren,
    buildZoneLayersNode(at, data.layers),
    buildUuidNode(at),
    buildValueList(at, 'hatch', ['edge', ZONE_DEFAULT_HATCH_PITCH]),
    buildList(at, 'connect_pads', buildValueList(at, 'clearance', [ZONE_DEFAULT_PAD_CLEARANCE])),
    buildValueList(at, 'min_thickness', [ZONE_DEFAULT_MIN_THICKNESS]),
    buildValueList(at, 'filled_areas_thickness', ['no'])
  ]
  if (data.keepout) {
    children.push(
      buildList(
        at,
        'keepout',
        buildValueList(at, 'tracks', ['not_allowed']),
        buildValueList(at, 'vias', ['not_allowed']),
        buildValueList(at, 'pads', ['allowed']),
        buildValueList(at, 'copperpour', ['not_allowed']),
        buildValueList(at, 'footprints', ['allowed'])
      )
    )
  }
  children.push(
    buildList(
      at,
      'fill',
      buildValueList(at, 'thermal_gap', [ZONE_DEFAULT_THERMAL_GAP]),
      buildValueList(at, 'thermal_bridge_width', [ZONE_DEFAULT_THERMAL_BRIDGE])
    ),
    buildList(
      at,
      'polygon',
      buildList(
        at,
        'pts',
        ...data.points.map((p) => buildValueList(at, 'xy', [formatNmAtom(p.x), formatNmAtom(p.y)]))
      )
    )
  )
  return buildList(at, 'zone', ...children)
}

/** A teardrop's zone as `TEARDROP_MANAGER` makes it: its copper, or the mask's companion. */
export interface NewTeardropZone {
  type: 'padvia' | 'track_end'
  layer: string
  /** 0 for the mask's companion, which has no net. */
  net: number
  netName: string
  /** Absent for the mask's companion, which keeps the default. */
  priority?: number
  minThickness: Nm
  points: Array<{ x: Nm; y: Nm }>
}

/**
 * A teardrop's (zone ...) node, as KiCad 10 writes one: no uuid or name, its
 * fill its outline until the next refill (`createTeardrop`, `createTeardropMask`).
 */
export function buildTeardropZoneNode(
  at: number,
  data: NewTeardropZone,
  netRefStyle: KicadBoard['netRefStyle']
): SExprList {
  const copper = data.priority !== undefined
  const netChildren =
    data.net === 0
      ? []
      : netRefStyle === 'name'
        ? [buildValueList(at, 'net', [data.netName], true)]
        : [
            buildValueList(at, 'net', [data.net]),
            buildValueList(at, 'net_name', [data.netName], true)
          ]
  const pts = (): SExprList =>
    buildList(
      at,
      'pts',
      ...data.points.map((p) => buildValueList(at, 'xy', [formatNmAtom(p.x), formatNmAtom(p.y)]))
    )
  return buildList(
    at,
    'zone',
    ...netChildren,
    buildValueList(at, 'layer', [data.layer], true),
    buildValueList(at, 'hatch', ['none', '0.1']),
    ...(copper ? [buildValueList(at, 'priority', [String(data.priority)])] : []),
    buildList(at, 'attr', buildList(at, 'teardrop', buildValueList(at, 'type', [data.type]))),
    copper
      ? buildList(
          at,
          'connect_pads',
          makeAtom('yes', false, at),
          buildValueList(at, 'clearance', ['0'])
        )
      : buildList(at, 'connect_pads', buildValueList(at, 'clearance', ['0.5'])),
    buildValueList(at, 'min_thickness', [formatNmAtom(data.minThickness)]),
    buildList(
      at,
      'fill',
      makeAtom('yes', false, at),
      buildValueList(at, 'island_removal_mode', ['1'])
    ),
    buildList(at, 'polygon', pts()),
    buildList(at, 'filled_polygon', buildValueList(at, 'layer', [data.layer], true), pts())
  )
}

/** Append a (zone ...) node (`buildZoneNode`); returns the new zone's index. */
export function addZoneToBoardAST(board: KicadBoard, data: NewZone): number {
  const root = board._raw as SExprList
  root.children.push(buildZoneNode(root.start, data, board.netRefStyle))
  return board.zones.length
}

/**
 * Rewrite a zone's outline polygon. Any stored `filled_polygon`s are left in
 * place — they are stale after this, exactly as after a KiCad outline edit;
 * the fill engine (P0.6) owns recomputing them.
 */
export function setBoardZoneOutlineInAST(
  zone: KicadBoardZone,
  points: Array<{ x: Nm; y: Nm }>
): void {
  markNodeDirty(zone._raw)
  zone.points = points.map((p) => ({ ...p }))
  const polyNode = findOrCreateChild(zone._raw, 'polygon')
  setPointsChild(polyNode, zone.points)
}

/** Zone properties the editor exposes; every write goes through here. */
export interface ZoneUpdate {
  net?: { number: number; name: string }
  layers?: readonly string[]
  name?: string
  /** null removes the (priority ..) node — back to the implicit 0. */
  priority?: number | null
  minThickness?: Nm
  padConnection?: ZonePadConnection
  padClearance?: Nm
  thermalGap?: Nm
  thermalBridgeWidth?: Nm
  /** null removes both island keys — back to KiCad's remove-all default. */
  islandRemovalMode?: number | null
  minIslandArea?: number
  /**
   * Pour hatched with these settings, merged over the zone's own (or KiCad's
   * defaults when it poured solid); null pours solid again.
   */
  hatchFill?: Partial<NonNullable<KicadBoardZone['hatchFill']>> | null
  /** The outline's display hatch (`(hatch style pitch)`), not the pour's. */
  hatchStyle?: 'none' | 'edge' | 'full'
  hatchPitch?: Nm
  keepout?: boolean
  keepoutRules?: Partial<ZoneKeepoutRules>
}

/** The `(fill …)` children a hatched pour writes, KiCad's own and nothing else. */
const HATCH_FILL_TOKENS = new Set([
  'mode',
  'hatch_thickness',
  'hatch_gap',
  'hatch_orientation',
  'hatch_smoothing_level',
  'hatch_smoothing_value',
  'hatch_border_algorithm',
  'hatch_min_hole_area'
])

/**
 * Rewrite a zone's fill mode and hatch settings as KiCad writes them
 * (`formatZone`): `(mode hatch)` after the fill's `yes`, the hatch keys at the
 * end in KiCad's order, smoothing only when there is any. A solid pour has none
 * of them. The border algorithm is kept from the file, `hatch_thickness`
 * (KiCad's default) when it had none.
 */
function writeZoneHatchFill(zone: KicadBoardZone, at: number): void {
  const fill = findOrCreateChild(zone._raw, 'fill')
  const algorithmNode = findChild(fill, 'hatch_border_algorithm')
  const algorithm = (algorithmNode && getFirstAtomValue(algorithmNode)) || 'hatch_thickness'
  fill.children = fill.children.filter(
    (c) => !(c.type === 'list' && HATCH_FILL_TOKENS.has(getToken(c) ?? ''))
  )
  const hatch = zone.hatchFill
  if (!hatch) return
  // After the token and its bare markers (`yes`), before the first keyed child.
  const firstList = fill.children.findIndex((c, i) => i > 0 && c.type === 'list')
  fill.children.splice(
    firstList < 0 ? fill.children.length : firstList,
    0,
    buildValueList(at, 'mode', ['hatch'])
  )
  const keyed: Array<[string, string]> = [
    ['hatch_thickness', mm(hatch.thickness)],
    ['hatch_gap', mm(hatch.gap)],
    ['hatch_orientation', mm(hatch.orientation)],
    ...(hatch.smoothingLevel > 0
      ? ([
          ['hatch_smoothing_level', hatch.smoothingLevel.toString()],
          ['hatch_smoothing_value', mm(hatch.smoothingValue)]
        ] as Array<[string, string]>)
      : []),
    ['hatch_border_algorithm', algorithm],
    ['hatch_min_hole_area', mm(hatch.minHoleArea)]
  ]
  for (const [token, value] of keyed) fill.children.push(buildValueList(at, token, [value]))
}

export function updateBoardZoneInAST(
  zone: KicadBoardZone,
  data: ZoneUpdate,
  board?: KicadBoard
): void {
  const root = zone._raw
  markNodeDirty(root)
  const at = root.start

  if (data.net !== undefined) {
    zone.net = data.net.number
    zone.netName = data.net.name
    if (board?.netRefStyle === 'name') {
      // KiCad 10 writes a zone on no net with no (net …) at all, and a net
      // first after the token.
      const byName = (c: SExprNode): boolean =>
        c.type === 'list' && (getToken(c) === 'net' || getToken(c) === 'net_name')
      if (data.net.number === 0) {
        root.children = root.children.filter((c) => !byName(c))
      } else {
        if (!findChild(root, 'net'))
          root.children.splice(1, 0, buildValueList(at, 'net', [data.net.name], true))
        else setScalarChild(root, 'net', data.net.name, true)
        // v10 zones carry no net_name row; keep one in sync only if present.
        if (findChild(root, 'net_name')) setScalarChild(root, 'net_name', data.net.name, true)
      }
    } else {
      setScalarChild(root, 'net', data.net.number.toString())
      setScalarChild(root, 'net_name', data.net.name, true)
    }
  }
  if (data.layers !== undefined) {
    zone.layers = [...data.layers]
    // Replace whichever spelling the file used, in place, so order holds.
    const existing = findChild(root, 'layers') ?? findChild(root, 'layer')
    const node = buildZoneLayersNode(at, data.layers)
    if (existing) {
      root.children.splice(root.children.indexOf(existing), 1, node)
    } else {
      root.children.push(node)
    }
  }
  if (data.name !== undefined) {
    zone.name = data.name || undefined
    if (data.name) {
      setScalarChild(root, 'name', data.name, true)
    } else {
      const nameNode = findChild(root, 'name')
      if (nameNode) root.children.splice(root.children.indexOf(nameNode), 1)
    }
  }
  if (data.priority !== undefined) {
    zone.priority = data.priority ?? undefined
    const existing = findChild(root, 'priority')
    if (data.priority === null || data.priority === 0) {
      if (existing) root.children.splice(root.children.indexOf(existing), 1)
    } else {
      setScalarChild(root, 'priority', data.priority.toString())
    }
  }
  if (data.minThickness !== undefined) {
    zone.minThickness = data.minThickness
    setScalarChild(root, 'min_thickness', formatNmAtom(data.minThickness))
  }
  if (data.padConnection !== undefined || data.padClearance !== undefined) {
    const connectPads = findOrCreateChild(root, 'connect_pads')
    if (data.padConnection !== undefined) {
      zone.padConnection = data.padConnection
      // The mode is a bare marker atom right after the token; thermal is the
      // unmarked default.
      const marker =
        data.padConnection === 'solid'
          ? 'yes'
          : data.padConnection === 'none'
            ? 'no'
            : data.padConnection === 'thru_hole_only'
              ? 'thru_hole_only'
              : null
      connectPads.children = connectPads.children.filter(
        (c) => !(c.type === 'atom' && ['yes', 'no', 'thru_hole_only'].includes(c.value))
      )
      if (marker) connectPads.children.splice(1, 0, makeAtom(marker, false, at))
    }
    if (data.padClearance !== undefined) {
      zone.padClearance = data.padClearance
      setScalarChild(connectPads, 'clearance', formatNmAtom(data.padClearance))
    }
  }
  if (
    data.thermalGap !== undefined ||
    data.thermalBridgeWidth !== undefined ||
    data.islandRemovalMode !== undefined ||
    data.minIslandArea !== undefined
  ) {
    const fill = findOrCreateChild(root, 'fill')
    if (data.thermalGap !== undefined) {
      zone.thermalGap = data.thermalGap
      setScalarChild(fill, 'thermal_gap', formatNmAtom(data.thermalGap))
    }
    if (data.thermalBridgeWidth !== undefined) {
      zone.thermalBridgeWidth = data.thermalBridgeWidth
      setScalarChild(fill, 'thermal_bridge_width', formatNmAtom(data.thermalBridgeWidth))
    }
    if (data.islandRemovalMode !== undefined) {
      if (data.islandRemovalMode === null || data.islandRemovalMode === 0) {
        zone.islandRemovalMode = undefined
        zone.minIslandArea = undefined
        fill.children = fill.children.filter(
          (c) =>
            !(
              c.type === 'list' &&
              ['island_removal_mode', 'island_area_min'].includes(getToken(c) ?? '')
            )
        )
      } else {
        zone.islandRemovalMode = data.islandRemovalMode
        setScalarChild(fill, 'island_removal_mode', data.islandRemovalMode.toString())
      }
    }
    if (data.minIslandArea !== undefined && zone.islandRemovalMode === 2) {
      zone.minIslandArea = data.minIslandArea
      setScalarChild(fill, 'island_area_min', mm(data.minIslandArea))
    }
  }
  if (data.hatchFill !== undefined) {
    zone.hatchFill =
      data.hatchFill === null
        ? undefined
        : {
            // KiCad's new-zone hatch (`ZONE_SETTINGS`): a web of four minimum
            // widths, at least 1 mm.
            thickness: Math.max(1, 4 * nmToMm(zone.minThickness ?? mmToNm(0.25))),
            gap: 1.5,
            orientation: 0,
            smoothingLevel: 0,
            smoothingValue: 0.1,
            minHoleArea: 0.3,
            ...zone.hatchFill,
            ...data.hatchFill
          }
    writeZoneHatchFill(zone, at)
  }
  if (data.hatchStyle !== undefined || data.hatchPitch !== undefined) {
    if (data.hatchStyle !== undefined) zone.hatchStyle = data.hatchStyle
    if (data.hatchPitch !== undefined) zone.hatchPitch = data.hatchPitch
    setZoneHatchChild(root, zone.hatchStyle, zone.hatchPitch)
  }
  if (data.keepout !== undefined && data.keepout !== zone.isKeepout) {
    zone.isKeepout = data.keepout
    if (data.keepout) {
      zone.keepoutRules = {
        tracks: false,
        vias: false,
        pads: true,
        copperpour: false,
        footprints: true
      }
      root.children.push(
        buildList(
          at,
          'keepout',
          buildValueList(at, 'tracks', ['not_allowed']),
          buildValueList(at, 'vias', ['not_allowed']),
          buildValueList(at, 'pads', ['allowed']),
          buildValueList(at, 'copperpour', ['not_allowed']),
          buildValueList(at, 'footprints', ['allowed'])
        )
      )
    } else {
      zone.keepoutRules = undefined
      const keepoutNode = findChild(root, 'keepout')
      if (keepoutNode) root.children.splice(root.children.indexOf(keepoutNode), 1)
    }
  }
  if (data.keepoutRules !== undefined && zone.keepoutRules) {
    const rules = zone.keepoutRules
    // A placement area keeps out by default with no (keepout …) to edit: write one.
    let keepoutNode = findChild(root, 'keepout')
    if (!keepoutNode) {
      keepoutNode = buildList(
        at,
        'keepout',
        ...(['tracks', 'vias', 'pads', 'copperpour', 'footprints'] as const).map((key) =>
          buildValueList(at, key, [rules[key] ? 'allowed' : 'not_allowed'])
        )
      )
      root.children.push(keepoutNode)
    }
    for (const [key, allowed] of Object.entries(data.keepoutRules)) {
      if (allowed === undefined) continue
      rules[key as keyof ZoneKeepoutRules] = allowed
      setScalarChild(keepoutNode, key, allowed ? 'allowed' : 'not_allowed')
    }
  }
}

/**
 * Replace a zone's stored fills with freshly computed ones — the write half
 * of the fill engine (P0.6). Existing `filled_polygon` nodes go, one per
 * computed polygon comes back, in KiCad's exact shape:
 * `(filled_polygon (layer "F.Cu") (pts (xy …) …))`. Also marks the fill as
 * current by writing `(fill yes …)` the way KiCad does after a refill.
 */
export function setZoneFilledPolysInAST(
  zone: KicadBoardZone,
  fills: Array<{ layer: string; points: Array<{ x: Nm; y: Nm }> }>
): void {
  const root = zone._raw
  markNodeDirty(root)
  const at = root.start
  root.children = root.children.filter(
    (c) => !(c.type === 'list' && getToken(c) === 'filled_polygon')
  )
  for (const fill of fills) {
    // Points land as a PACKED pts node (one Int32Array), not 2·N xy lists:
    // a dense pour is 80k+ points, and the object form would both explode
    // the AST the parser deliberately packed and put per-node cost back into
    // every post-refill serialize.
    const coords = new Int32Array(fill.points.length * 2)
    for (let i = 0; i < fill.points.length; i++) {
      coords[i * 2] = fill.points[i].x
      coords[i * 2 + 1] = fill.points[i].y
    }
    root.children.push(
      buildList(
        at,
        'filled_polygon',
        buildValueList(at, 'layer', [fill.layer], true),
        new PackedPtsNode(coords, at, at)
      )
    )
  }
  zone.filledPolys = fills.map((f) => ({ layer: f.layer, points: f.points.map((p) => ({ ...p })) }))
  // (fill yes ...) — the marker the export audit reads as "fills are computed".
  const fillNode = findOrCreateChild(root, 'fill')
  if (fills.length > 0 && !fillNode.children.some((c) => c.type === 'atom' && c.value === 'yes')) {
    fillNode.children.splice(1, 0, makeAtom('yes', false, at))
  }
}

/**
 * The physical build a manufacturing profile describes. Deliberately a small
 * spec rather than a layer list: a profile says "2-layer, 1.6 mm, 1 oz copper,
 * FR4" and the canonical KiCad row order is derived from it.
 */
export interface StackupSpec {
  /** Even, 2–32 — KiCad's range. Odd counts have a different topology. */
  copperLayers: number
  /** Finished board thickness in mm; dielectrics absorb the remainder. */
  boardThickness: number
  /** Finished outer-copper thickness in mm (0.035 = 1 oz). */
  copperThickness: number
  /**
   * Inner-copper thickness for multilayer builds; defaults to `copperThickness`.
   * Real 4-layer stackups run thinner inner foil (0.0152 = 0.5 oz is what
   * JLCPCB writes), so the dielectric maths must not assume one weight.
   */
  innerCopperThickness?: number
  /**
   * Each prepreg ply's thickness in mm for multilayer builds; defaults to one
   * standard 7628 ply. A fab's catalog builds differ by exactly this (JLCPCB's
   * 7628 against its 3313), and the core absorbs the rest either way.
   */
  prepregThickness?: number
  /** The prepreg's εr where it differs from the core's (`epsilonR`). */
  prepregEpsilonR?: number
  dielectricMaterial: string
  /** The core's εr, and every dielectric's unless `prepregEpsilonR` is set. */
  epsilonR: number
  lossTangent: number
  /** Solder-mask color, e.g. "Green"; omitted when the fab's default is fine. */
  maskColor?: string
  silkColor?: string
  /** Surface finish, e.g. "HASL", "ENIG". */
  copperFinish?: string
}

/** Solder-mask thickness KiCad writes by default; not worth a spec field yet. */
const MASK_THICKNESS = 0.01
/** One standard 7628 ply: the prepreg a spec without its own gets. */
const PREPREG_THICKNESS = 0.2104

type StackupField = [token: string, value: string, quoted: boolean]

function buildStackupLayerNode(at: number, name: string, fields: StackupField[]): SExprList {
  return {
    type: 'list',
    children: [
      makeAtom('layer', false, at),
      makeAtom(name, true, at),
      ...fields.map(([token, value, quoted]) => buildList(at, token, makeAtom(value, quoted, at)))
    ],
    start: at,
    end: at
  }
}

/**
 * Write (setup (stackup ...)) from a profile spec, replacing any existing
 * stackup in place and creating the `setup` node when absent. Every other
 * `setup` child (pcbplotparams, aux_axis_origin, ...) is left untouched.
 *
 * Also syncs (general (thickness ..)) so the two places a board states its
 * thickness cannot disagree.
 */
export function setBoardStackupInAST(board: KicadBoard, spec: StackupSpec): void {
  const root = board._raw as SExprList
  const at = root.start

  const copperCount = Math.max(2, Math.min(32, spec.copperLayers))
  // N copper layers are separated by N-1 dielectrics. A 2-layer build is a
  // single core; above that, cores carry the copper and prepreg bonds them
  // together, so the slots alternate prepreg / core / prepreg / … .
  const dielectricCount = copperCount - 1
  const isCoreSlot = (i: number): boolean => dielectricCount === 1 || i % 2 === 1
  const prepregCount = dielectricCount === 1 ? 0 : Math.ceil(dielectricCount / 2)
  const coreCount = dielectricCount - prepregCount

  const innerThickness = spec.innerCopperThickness ?? spec.copperThickness
  const copperTotal = 2 * spec.copperThickness + (copperCount - 2) * innerThickness
  const dielectricTotal = Math.max(spec.boardThickness - copperTotal, 0)

  // Prepreg is normally a fixed standard ply and the cores absorb the rest. At
  // high layer counts the plies alone can exceed the target thickness (a 1.6 mm
  // 32-layer board is not buildable), and silently clamping the cores to zero
  // would leave a stack that does not add up to its own stated thickness. So
  // fall back to splitting the budget evenly: the build stays self-consistent,
  // and the user sees an implausible ply thickness rather than a wrong total.
  const ply = spec.prepregThickness ?? PREPREG_THICKNESS
  const prepregTotal = prepregCount * ply
  const cramped = prepregTotal >= dielectricTotal
  const prepregThickness = cramped ? dielectricTotal / dielectricCount : ply
  const coreThickness = cramped
    ? dielectricTotal / dielectricCount
    : coreCount > 0
      ? (dielectricTotal - prepregTotal) / coreCount
      : 0

  const dielectric = (index: number): SExprList => {
    const core = isCoreSlot(index - 1)
    return buildStackupLayerNode(at, `dielectric ${index}`, [
      ['type', core ? 'core' : 'prepreg', true],
      ['thickness', mm(core ? coreThickness : prepregThickness), false],
      ['material', spec.dielectricMaterial, true],
      ['epsilon_r', mm(core ? spec.epsilonR : (spec.prepregEpsilonR ?? spec.epsilonR)), false],
      ['loss_tangent', mm(spec.lossTangent), false]
    ])
  }

  const copper = (name: string, thickness = spec.copperThickness): SExprList =>
    buildStackupLayerNode(at, name, [
      ['type', 'copper', true],
      ['thickness', mm(thickness), false]
    ])

  const mask = (name: string, label: string): SExprList => {
    const fields: StackupField[] = [['type', label, true]]
    if (spec.maskColor) fields.push(['color', spec.maskColor, true])
    fields.push(['thickness', mm(MASK_THICKNESS), false])
    return buildStackupLayerNode(at, name, fields)
  }

  const silk = (name: string, label: string): SExprList => {
    const fields: StackupField[] = [['type', label, true]]
    if (spec.silkColor) fields.push(['color', spec.silkColor, true])
    return buildStackupLayerNode(at, name, fields)
  }

  // dielectric, inner copper, dielectric, … — ending on a dielectric before B.Cu.
  const inner: SExprList[] = []
  for (let i = 0; i < dielectricCount; i++) {
    inner.push(dielectric(i + 1))
    if (i < dielectricCount - 1) inner.push(copper(`In${i + 1}.Cu`, innerThickness))
  }

  const stackupNode = buildList(
    at,
    'stackup',
    silk('F.SilkS', 'Top Silk Screen'),
    buildStackupLayerNode(at, 'F.Paste', [['type', 'Top Solder Paste', true]]),
    mask('F.Mask', 'Top Solder Mask'),
    copper('F.Cu'),
    ...inner,
    copper('B.Cu'),
    mask('B.Mask', 'Bottom Solder Mask'),
    buildStackupLayerNode(at, 'B.Paste', [['type', 'Bottom Solder Paste', true]]),
    silk('B.SilkS', 'Bottom Silk Screen'),
    buildList(at, 'copper_finish', makeAtom(spec.copperFinish ?? 'None', true, at)),
    buildList(at, 'dielectric_constraints', makeAtom('no', false, at))
  )

  const setup = findOrCreateChild(root, 'setup')
  markNodeDirty(setup)
  const existing = findChild(setup, 'stackup')
  if (existing) {
    setup.children[setup.children.indexOf(existing)] = stackupNode
  } else {
    // KiCad writes the stackup first, right after the `setup` token.
    setup.children.splice(1, 0, stackupNode)
  }

  syncCopperLayerTable(board, copperCount)
  updateBoardMetaInAST(board, { thickness: mmToNm(spec.boardThickness) })
  board.stackup = parseStackup(setup)
}

/**
 * Rewrite the copper rows of the board's `(layers …)` table for `count` copper
 * layers, leaving every non-copper row untouched. KiCad 10's ids — F.Cu 0,
 * B.Cu 2, In*n*.Cu 2*n*+2 — since an older board's table is renumbered as it
 * is read (lib/kicad/migrate.ts). This is the one place that knows how a layer
 * count becomes a layer table.
 */
function syncCopperLayerTable(board: KicadBoard, count: number): void {
  const root = board._raw as SExprList
  const layersNode = findChild(root, 'layers')
  if (!layersNode) return
  markNodeDirty(layersNode)

  const at = layersNode.start
  const isCopperRow = (node: SExprNode): boolean =>
    node.type === 'list' && (getAtomValues(node)[0] ?? '').endsWith('.Cu')

  const copperRows: SExprList[] = [
    buildValueList(at, '0', ['F.Cu', 'signal'], true),
    ...Array.from({ length: Math.max(0, count - 2) }, (_, i) =>
      buildValueList(at, String(2 * (i + 1) + 2), [`In${i + 1}.Cu`, 'signal'], true)
    ),
    buildValueList(at, '2', ['B.Cu', 'signal'], true)
  ]
  // The ordinal is the token, so re-quote: (0 "F.Cu" signal).
  for (const row of copperRows) {
    const type = row.children[row.children.length - 1]
    if (type.type === 'atom') type.quoted = false
  }

  const keep = layersNode.children.filter((c) => c.type === 'atom' || !isCopperRow(c))
  const token = keep[0]
  layersNode.children = [token, ...copperRows, ...keep.slice(1)]
}

/**
 * Dielectric rows are named positionally ("dielectric 1", "dielectric 2", …),
 * so inserting or removing one renumbers every dielectric after it.
 */
function renumberDielectrics(stackupNode: SExprList): void {
  let n = 0
  for (const layer of findChildren(stackupNode, 'layer')) {
    const name = getAtomValues(layer)[0] ?? ''
    if (!name.startsWith('dielectric')) continue
    n += 1
    setPositionalAtom(layer, 1, `dielectric ${n}`, true)
  }
}

/**
 * Insert a dielectric slot directly after the layer at `afterIndex`. Defaults
 * mirror a standard FR4 core; the caller edits it from there. Returns the new
 * layer's index, or -1 when `afterIndex` is out of range.
 */
export function addStackupDielectricInAST(stackup: KicadStackup, afterIndex: number): number {
  const layers = findChildren(stackup._raw, 'layer')
  const anchor = layers[afterIndex]
  if (!anchor) return -1

  markNodeDirty(stackup._setup)
  const at = stackup._raw.start
  const node = buildStackupLayerNode(at, 'dielectric', [
    ['type', 'core', true],
    ['thickness', mm(0.1), false],
    ['material', 'FR4', true],
    ['epsilon_r', mm(4.5), false],
    ['loss_tangent', mm(0.02), false]
  ])
  stackup._raw.children.splice(stackup._raw.children.indexOf(anchor) + 1, 0, node)
  renumberDielectrics(stackup._raw)
  return afterIndex + 1
}

/**
 * Remove one stackup row. Only dielectrics may go: the copper/mask/silk rows
 * are the board's own layer table and removing one would desync the two.
 */
export function removeStackupLayerInAST(stackup: KicadStackup, index: number): boolean {
  const layers = findChildren(stackup._raw, 'layer')
  const node = layers[index]
  if (!node) return false
  const name = getAtomValues(node)[0] ?? ''
  if (!name.startsWith('dielectric')) return false
  // A build needs at least one dielectric between its copper layers.
  if (layers.filter((l) => (getAtomValues(l)[0] ?? '').startsWith('dielectric')).length <= 1) {
    return false
  }

  markNodeDirty(stackup._setup)
  stackup._raw.children.splice(stackup._raw.children.indexOf(node), 1)
  renumberDielectrics(stackup._raw)
  return true
}

/**
 * Lock or unlock a board item — a track, arc, via, zone, free shape, board
 * text or footprint (its `_raw` is the top-level node, `locked` its flag).
 *
 * KiCad writes `(locked yes)` only when locked, before the item's layer (after
 * the string of a text), and still reads the bare `locked` atom older files
 * carry; an existing marker keeps its spelling, and unlocking removes it.
 */
export function setBoardItemLockedInAST(
  item: { _raw: SExprNode; locked: boolean },
  locked: boolean
): void {
  const root = item._raw as SExprList
  markNodeDirty(root)
  item.locked = locked
  const children = root.children
  const isBare = (c: SExprNode): boolean => c.type === 'atom' && !c.quoted && c.value === 'locked'
  const isListed = (c: SExprNode): boolean => c.type === 'list' && getToken(c) === 'locked'
  if (!locked) {
    root.children = children.filter((c) => !isBare(c) && !isListed(c))
    return
  }
  if (children.some(isBare)) return
  const listed = children.find(isListed)
  if (listed) {
    setScalarChild(root, 'locked', 'yes')
    return
  }
  const at = root.start
  const node = makeList([makeAtom('locked', false, at), makeAtom('yes', false, at)], at)
  const layer = children.findIndex(
    (c) => c.type === 'list' && (getToken(c) === 'layer' || getToken(c) === 'layers')
  )
  // A text's string is its first value; the marker follows it, as KiCad writes.
  const token = getToken(root)
  const afterString =
    (token === 'gr_text' || token === 'gr_text_box') && children[1]?.type === 'atom' ? 2 : -1
  const index = afterString >= 0 ? afterString : layer >= 0 ? layer : children.length
  children.splice(index, 0, node)
}

/** The board's two user origins: the grid's, and the drill / place files' (KiCad's aux origin). */
export type BoardOrigin = 'grid' | 'drill'

const ORIGIN_TOKEN: Record<BoardOrigin, string> = {
  grid: 'grid_origin',
  drill: 'aux_axis_origin'
}

/**
 * Place or reset one of the board's origins in `(setup …)`. KiCad writes an
 * origin only away from 0,0 — `aux_axis_origin` then `grid_origin`, before the
 * plot parameters — so a reset (null, or 0,0) removes the node.
 */
export function setBoardOriginInAST(
  board: KicadBoard,
  which: BoardOrigin,
  at: { x: Nm; y: Nm } | null
): void {
  const root = board._raw as SExprList
  const token = ORIGIN_TOKEN[which]
  const clear = !at || (at.x === 0 && at.y === 0)
  let setup = findChild(root, 'setup')
  if (!setup && clear) return
  setup ??= findOrCreateChild(root, 'setup')
  markNodeDirty(setup)
  const existing = findChild(setup, token)
  if (clear || !at) {
    if (existing) setup.children = setup.children.filter((c) => c !== existing)
  } else if (existing) {
    setXYChild(setup, token, at.x, at.y)
  } else {
    const node = makeList(
      [
        makeAtom(token, false, setup.start),
        makeAtom(formatNmAtom(at.x), false, setup.start),
        makeAtom(formatNmAtom(at.y), false, setup.start)
      ],
      setup.start
    )
    const before = setup.children.findIndex(
      (c) =>
        c.type === 'list' &&
        (getToken(c) === 'pcbplotparams' || (which === 'drill' && getToken(c) === 'grid_origin'))
    )
    setup.children.splice(before >= 0 ? before : setup.children.length, 0, node)
  }
  const value = clear || !at ? undefined : { x: at.x, y: at.y }
  if (which === 'grid') board.gridOrigin = value
  else board.auxOrigin = value
}

/** Remove a top-level element node from the board AST. */
export function removeBoardNodeFromAST(board: KicadBoard, raw: SExprNode): boolean {
  const root = board._raw as SExprList
  const idx = root.children.indexOf(raw)
  if (idx === -1) return false
  root.children.splice(idx, 1)
  return true
}

// ---------------------------------------------------------------------------
// Re-exports for consumers of the board model
// ---------------------------------------------------------------------------

export type {
  KicadFootprint,
  KicadFpLine,
  KicadFpArc,
  KicadFpCircle,
  KicadFpRect,
  KicadFpPoly,
  KicadFpCurve,
  KicadFpTextBox,
  KicadTable,
  KicadPoint
}
