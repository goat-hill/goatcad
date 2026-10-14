/**
 * The items of a board as records an agent reads and writes: footprints and
 * their pads, tracks, vias, zones, and the free graphics and texts, in board
 * millimeters, y down, as the file and `board.describe` have them.
 *
 * Pure: every function takes a parsed board and edits its AST through the
 * same `kicad/board.ts` mutators the PCB editor's own commands call, so the
 * caller decides whether the edit lands in a session command or is thrown
 * away (a dry run, a failed batch). A write that replaces a node (a flip, a
 * create, a delete) answers with the board remapped, since the facade it was
 * given no longer lists what the AST holds.
 *
 * Ids follow `agent-api.md`: a footprint is its reference, a pad
 * `<reference>.<number>`, everything else its uuid, or `<kind>@x,y` when the
 * file gave none. A reference or pad number shared by two items falls back to
 * the uuid, since an id must name one thing (KiCad, too, names a repeated pad
 * number's pads only by uuid); `<reference>.<number>` for such a number is
 * refused with the pads' ids. `boardItemIds` is the one id
 * function, which the checks name their findings' items by too; a footprint's
 * own graphic, text or zone, which is no item here, resolves to its footprint
 * by its uuid.
 */
import {
  hasLegacyTeardrops,
  isTeardropZone,
  addGrArcToBoardAST,
  addGrCircleToBoardAST,
  addGrCurveToBoardAST,
  addGrLineToBoardAST,
  addGrPolyToBoardAST,
  addGrRectToBoardAST,
  addGrTextBoxToBoardAST,
  addGrTextToBoardAST,
  addPointToBoardAST,
  addSegmentToBoardAST,
  addViaToBoardAST,
  addZoneToBoardAST,
  footprintZones,
  getNetName,
  moveBoardFootprintInAST,
  remapKicadBoard,
  removeBoardNodeFromAST,
  rotateBoardFootprintInAST,
  setBoardItemLockedInAST,
  setGraphicNetInAST,
  setBoardZoneOutlineInAST,
  updateBoardZoneInAST,
  updateGrTextInAST,
  updateSegmentInAST,
  updateTrackArcInAST,
  updateViaInAST,
  type KicadBoard,
  type KicadBoardFootprint,
  type KicadBoardZone,
  type KicadFpArc,
  type KicadFpCircle,
  type KicadFpLine,
  type KicadFpPoly,
  type KicadFpRect,
  type KicadGrText,
  type KicadTrackArc,
  type KicadTrackSegment,
  type KicadTuningPattern,
  type TuningPatternData,
  type KicadVia,
  type ZonePadConnection,
  type ZoneUpdate
} from '../kicad/board'
import {
  DEFAULT_POINT_SIZE,
  setFootprintFieldText,
  updateArcInAST,
  updateCircleInAST,
  updateCurveInAST,
  updateLineInAST,
  updatePointInAST,
  updatePolyInAST,
  updateRectInAST,
  updateTableInAST,
  type KicadFpCurve,
  type KicadFpTextBox,
  type KicadPad,
  type KicadPoint,
  type KicadTable,
  type ZoneKeepoutRules,
  isSolidFill
} from '../kicad/footprint'
import {
  findChild,
  getFirstAtomValue,
  markNodeDirty,
  type SExprList,
  type SExprNode
} from '../kicad/sexpr'
import { mmToNm, nmToMm, type Nm } from '../kicad/coordinates'
import { isCopperLayer } from '../kicad/layers'
import { measureTextWidth } from '../kicad/newstroke'
import { footprintTransform, tfPoint } from '../schematic/placement'
import { padCopperCenter } from './spatialIndex'
import { teardropRecordOf, teardropsFromRecord, writeTeardropParams } from './teardrop/params'
import { islandsUpdate, mm, zoneRecordFields, zoneRowFields } from './zoneRecord'
import {
  cellsBox,
  fontEffects,
  fontRecord,
  strokeRecord,
  tablePatchOf,
  tableRecord,
  textBoxCorners,
  textBoxRecord,
  updateTextBox,
  writeStroke
} from '../footprint/footprintItems'
import { isSymbolOwned } from './footprintExchange'
import { deletePatternInAST, patternEdit, restorePatternInAST } from './tuningPatterns'
import type { PropertyEditValue } from '../propertyTable'
import { copperRank } from './netLength'
import { footprintExtents, type FootprintExtent } from '../footprint/footprintExtent'
import { flipBoardFootprintInAST, footprintFlippable } from './footprintFlip'
import { graphicDefaults } from './pcbTools'
import { footprintPath } from './boardSync'
import { narrowingsOf, pageOf, tally, tallyBy, type Narrowing, type QueryPage } from '../queryPage'
import {
  BOARD_CREATE_KINDS,
  BOARD_ITEM_KINDS,
  BOARD_READ_ONLY_KEYS,
  KEY_GROUPS,
  VIA_TYPES,
  type BoardCreateKind,
  type BoardItemKind,
  type RecordMode
} from '../../../../shared/itemRecords'
import { checkRecord, isPcbFillOn, isPoint } from '../../../../shared/recordRules'
import { hexColorToRgba } from '../kicad/color'

export { BOARD_CREATE_KINDS, BOARD_ITEM_KINDS, type BoardCreateKind, type BoardItemKind }

type Graphic = KicadFpLine | KicadFpArc | KicadFpCircle | KicadFpRect | KicadFpPoly | KicadFpCurve

/** The drawn shapes: their record is the graphic's, with a net on copper. */
type GraphicKind = 'line' | 'arc' | 'circle' | 'rect' | 'poly' | 'bezier'

/** Board nanometers, y down. */
interface Box {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

interface ItemBase {
  id: string
  /** The top-level node: a pad's is its footprint's. */
  raw: SExprNode
  box: Box | null
}

export type BoardItem = ItemBase &
  (
    | { kind: 'footprint'; footprint: KicadBoardFootprint }
    | { kind: 'pad'; footprint: KicadBoardFootprint; pad: KicadPad; at: Pt }
    | { kind: 'track'; track: KicadTrackSegment | KicadTrackArc }
    | { kind: 'via'; via: KicadVia }
    | { kind: 'zone'; zone: KicadBoardZone }
    | { kind: 'line'; graphic: KicadFpLine }
    | { kind: 'arc'; graphic: KicadFpArc }
    | { kind: 'circle'; graphic: KicadFpCircle }
    | { kind: 'rect'; graphic: KicadFpRect }
    | { kind: 'poly'; graphic: KicadFpPoly }
    | { kind: 'bezier'; graphic: KicadFpCurve }
    | { kind: 'text'; text: KicadGrText }
    | { kind: 'text_box'; textBox: KicadFpTextBox }
    | { kind: 'point'; point: KicadPoint }
    | { kind: 'table'; table: KicadTable }
    | { kind: 'tuning_pattern'; pattern: KicadTuningPattern }
  )

export type ItemFailure = {
  ok: false
  error:
    | 'item-not-found'
    | 'not-applicable'
    | 'invalid-record'
    | 'refused'
    | 'locked'
    | 'net-not-found'
    | 'layer-not-found'
    | 'net-conflict'
    | 'count-mismatch'
    | 'keepout-shape'
    | 'pad-ambiguous'
    | 'reference-taken'
  detail: string
  candidates?: string[]
}

/** Net-class sizes for what a record leaves out, in millimeters (the route and via tools' own). */
export interface NetClassSizes {
  trackWidth: number
  viaDiameter: number
  viaDrill: number
  microviaDiameter: number
  microviaDrill: number
}

export interface BoardEditDefaults {
  /** The net class of a net by name ('' for no net), as Board Setup resolves it. */
  classOf(netName: string): NetClassSizes
}

interface Pt {
  x: number
  y: number
}

const mmXY = (p: Pt): { x: number; y: number } => ({ x: mm(p.x), y: mm(p.y) })
const nmXY = (p: { x: number; y: number }): { x: Nm; y: Nm } => ({
  x: mmToNm(p.x),
  y: mmToNm(p.y)
})

export const mmBox = (box: Box): { x: number; y: number; width: number; height: number } => ({
  x: mm(box.minX),
  y: mm(box.minY),
  width: mm(box.maxX - box.minX),
  height: mm(box.maxY - box.minY)
})

const positional = (kind: string, at: Pt): string => `${kind}@${mm(at.x)},${mm(at.y)}`

const fail = (error: ItemFailure['error'], detail: string, candidates?: string[]): ItemFailure => ({
  ok: false,
  error,
  detail,
  ...(candidates?.length ? { candidates } : {})
})

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

const boxOf = (points: Pt[], grow = 0): Box | null => {
  if (!points.length) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of points) {
    minX = Math.min(minX, p.x)
    minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x)
    maxY = Math.max(maxY, p.y)
  }
  return { minX: minX - grow, minY: minY - grow, maxX: maxX + grow, maxY: maxY + grow }
}

/** A footprint-local point (nm, y down) in board space (nm, y down). */
const onBoard = (bfp: KicadBoardFootprint, x: number, y: number): Pt => {
  const world = tfPoint(footprintTransform(bfp), x as Nm, y as Nm)
  return { x: mmToNm(world.x), y: mmToNm(-world.y) }
}

const extentOnBoard = (bfp: KicadBoardFootprint, extent: FootprintExtent): Box | null =>
  boxOf([
    onBoard(bfp, extent.minX, extent.minY),
    onBoard(bfp, extent.maxX, extent.minY),
    onBoard(bfp, extent.maxX, extent.maxY),
    onBoard(bfp, extent.minX, extent.maxY)
  ])

/** The courtyard's box, else the pads', else the fab outline's: what the part occupies. */
const footprintBox = (bfp: KicadBoardFootprint): Box | null => {
  const extents = footprintExtents(bfp.footprint)
  const extent = extents.courtyard ?? extents.pads ?? extents.fab
  return extent ? extentOnBoard(bfp, extent) : boxOf([bfp.position])
}

/** Where a pad's copper sits on the board: its hole plus the drill offset, turned with it. */
const padCenter = (bfp: KicadBoardFootprint, pad: KicadPad): Pt => {
  const center = tfPoint(footprintTransform(bfp), pad.position.x, pad.position.y)
  const rotation = pad.position.angle ? (pad.position.angle * Math.PI) / 180 : 0
  const copper = padCopperCenter(pad, center, rotation)
  return { x: mmToNm(copper.x), y: mmToNm(-copper.y) }
}

const padBox = (at: Pt, pad: KicadPad): Box => {
  const angle = ((pad.position.angle ?? 0) * Math.PI) / 180
  const w = pad.size.w / 2
  const h = pad.size.h / 2
  const cos = Math.abs(Math.cos(angle))
  const sin = Math.abs(Math.sin(angle))
  const halfX = w * cos + h * sin
  const halfY = w * sin + h * cos
  return { minX: at.x - halfX, minY: at.y - halfY, maxX: at.x + halfX, maxY: at.y + halfY }
}

const textBox = (text: KicadGrText): Box | null => {
  if (!text.position) return null
  const height = text.fontEffects?.height ?? mmToNm(1)
  const width = text.fontEffects?.width ?? height
  const thickness = text.fontEffects?.thickness ?? mmToNm(0.15)
  const lines = text.text.split('\n')
  const advance = mmToNm(
    measureTextWidth(text.text, {
      width: nmToMm(width),
      height: nmToMm(height),
      thickness: nmToMm(thickness)
    })
  )
  const halfW = advance / 2
  const halfH = (height * lines.length) / 2
  const angle = ((text.position.angle ?? 0) * Math.PI) / 180
  const cos = Math.abs(Math.cos(angle))
  const sin = Math.abs(Math.sin(angle))
  const { x, y } = text.position
  const halfX = halfW * cos + halfH * sin
  const halfY = halfW * sin + halfH * cos
  return { minX: x - halfX, minY: y - halfY, maxX: x + halfX, maxY: y + halfY }
}

const graphicBox = (kind: GraphicKind, graphic: Graphic): Box | null => {
  const grow = (graphic.strokeWidth ?? 0) / 2
  switch (kind) {
    case 'line': {
      const line = graphic as KicadFpLine
      return boxOf([line.start, line.end], grow)
    }
    case 'arc': {
      const arc = graphic as KicadFpArc
      return boxOf([arc.start, arc.mid, arc.end], grow)
    }
    case 'circle': {
      const circle = graphic as KicadFpCircle
      const r = Math.hypot(circle.end.x - circle.center.x, circle.end.y - circle.center.y)
      return boxOf([circle.center], r + grow)
    }
    case 'rect': {
      const rect = graphic as KicadFpRect
      return boxOf([rect.start, rect.end], grow)
    }
    default:
      return boxOf((graphic as KicadFpPoly).points, grow)
  }
}

const boxesTouch = (a: Box, b: Box): boolean =>
  a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY

const distanceToBox = (box: Box, p: Pt): number => {
  const dx = Math.max(box.minX - p.x, 0, p.x - box.maxX)
  const dy = Math.max(box.minY - p.y, 0, p.y - box.maxY)
  return Math.hypot(dx, dy)
}

// ---------------------------------------------------------------------------
// The item list
// ---------------------------------------------------------------------------

/**
 * Every item's id, by the parsed object it names (a footprint, pad, track,
 * via, zone, graphic or text), and the board's own graphics and texts also by
 * uuid. The one id function: the items, the checks (`drc/context.ts`) and
 * every answer that names a board item read it.
 */
export interface BoardItemIds {
  readonly byObject: ReadonlyMap<object, string>
  readonly byUuid: ReadonlyMap<string, string>
}

const boardGraphics = (board: KicadBoard): Array<[GraphicKind, Graphic[]]> => [
  ['line', board.grLines],
  ['arc', board.grArcs],
  ['circle', board.grCircles],
  ['rect', board.grRects],
  ['poly', board.grPolys],
  ['bezier', board.grCurves]
]

const ORIGIN: Pt = { x: 0, y: 0 }

/** Where an id falls back to for a node the file gave no uuid: its first corner or point. */
const tableCorner = (table: KicadTable): Pt => {
  const box = cellsBox(table)
  return box ? { x: box.minX, y: box.minY } : ORIGIN
}

const pointBox = (point: KicadPoint): Box => boxOf([point.position], point.size / 2)!

const graphicStart = (graphic: Graphic): Pt =>
  'start' in graphic
    ? graphic.start
    : 'center' in graphic
      ? graphic.center
      : (graphic.points[0] ?? { x: 0, y: 0 })

export function boardItemIds(board: KicadBoard): BoardItemIds {
  const byObject = new Map<object, string>()
  const byUuid = new Map<string, string>()
  const seen = new Map<string, number>()
  const unique = (id: string): string => {
    const count = seen.get(id) ?? 0
    seen.set(id, count + 1)
    return count === 0 ? id : `${id}#${count + 1}`
  }
  const idOf = (kind: string, uuid: string | undefined, at: Pt): string =>
    unique(uuid ?? positional(kind, at))

  const references = new Map<string, number>()
  for (const bfp of board.footprints) {
    if (bfp.reference) references.set(bfp.reference, (references.get(bfp.reference) ?? 0) + 1)
  }
  for (const bfp of board.footprints) {
    const reference = bfp.reference ?? ''
    const byReference = reference && references.get(reference) === 1
    const id = byReference ? unique(reference) : idOf('footprint', bfp.uuid, bfp.position)
    byObject.set(bfp, id)
    const numbers = new Map<string, number>()
    for (const pad of bfp.footprint.pads) {
      if (pad.number) numbers.set(pad.number, (numbers.get(pad.number) ?? 0) + 1)
    }
    for (const pad of bfp.footprint.pads) {
      byObject.set(
        pad,
        pad.number && numbers.get(pad.number) === 1
          ? unique(`${id}.${pad.number}`)
          : idOf(`${id}.pad`, pad.uuid, padCenter(bfp, pad))
      )
    }
  }
  for (const track of board.segments) byObject.set(track, idOf('track', track.uuid, track.start))
  for (const track of board.trackArcs) byObject.set(track, idOf('track', track.uuid, track.start))
  for (const via of board.vias) byObject.set(via, idOf('via', via.uuid, via.position))
  for (const zone of board.zones) byObject.set(zone, zoneKey(zone))
  for (const [kind, list] of boardGraphics(board)) {
    for (const graphic of list) {
      const id = idOf(kind, graphic.uuid, graphicStart(graphic))
      byObject.set(graphic, id)
      if (graphic.uuid && !byUuid.has(graphic.uuid)) byUuid.set(graphic.uuid, id)
    }
  }
  const drawing = (item: { uuid?: string }, kind: string, at: Pt): void => {
    const id = idOf(kind, item.uuid, at)
    byObject.set(item, id)
    if (item.uuid && !byUuid.has(item.uuid)) byUuid.set(item.uuid, id)
  }
  for (const text of board.grTexts) drawing(text, 'text', text.position ?? ORIGIN)
  for (const box of board.grTextBoxes) drawing(box, 'text_box', textBoxCorners(box)[0] ?? ORIGIN)
  for (const point of board.points) drawing(point, 'point', point.position)
  for (const table of board.tables) drawing(table, 'table', tableCorner(table))
  for (const pattern of board.tuningPatterns) drawing(pattern, 'tuning_pattern', pattern.origin)
  return { byObject, byUuid }
}

/** Every item of the board with its id, in the order a query answers them. */
export function boardItems(board: KicadBoard): BoardItem[] {
  const out: BoardItem[] = []
  const { byObject } = boardItemIds(board)
  const idOf = (item: object): string => byObject.get(item)!
  for (const bfp of board.footprints) {
    out.push({
      kind: 'footprint',
      id: idOf(bfp),
      raw: bfp._raw,
      box: footprintBox(bfp),
      footprint: bfp
    })
    for (const pad of bfp.footprint.pads) {
      const at = padCenter(bfp, pad)
      out.push({
        kind: 'pad',
        id: idOf(pad),
        raw: bfp._raw,
        box: padBox(at, pad),
        footprint: bfp,
        pad,
        at
      })
    }
  }
  for (const track of board.segments) {
    out.push({
      kind: 'track',
      id: idOf(track),
      raw: track._raw,
      box: boxOf([track.start, track.end], track.width / 2),
      track
    })
  }
  for (const track of board.trackArcs) {
    out.push({
      kind: 'track',
      id: idOf(track),
      raw: track._raw,
      box: boxOf([track.start, track.mid, track.end], track.width / 2),
      track
    })
  }
  for (const via of board.vias) {
    out.push({
      kind: 'via',
      id: idOf(via),
      raw: via._raw,
      box: boxOf([via.position], via.size / 2),
      via
    })
  }
  // A teardrop is its pad's or via's setting, not an item (KiCad), but on a legacy board.
  const legacyTeardrops = hasLegacyTeardrops(board)
  for (const zone of board.zones) {
    if (!legacyTeardrops && isTeardropZone(zone)) continue
    out.push({ kind: 'zone', id: idOf(zone), raw: zone._raw, box: boxOf(zone.points), zone })
  }
  // A footprint's zones are listed as its pads are: read here, written only with the footprint.
  for (const zone of footprintZones(board)) {
    const owner = board.footprints[zone.footprint ?? -1]
    if (!owner) continue
    out.push({ kind: 'zone', id: zoneKey(zone), raw: owner._raw, box: boxOf(zone.points), zone })
  }
  for (const [kind, list] of boardGraphics(board)) {
    for (const graphic of list) {
      out.push({
        kind,
        id: idOf(graphic),
        raw: graphic._raw,
        box: graphicBox(kind, graphic),
        graphic
      } as BoardItem)
    }
  }
  for (const text of board.grTexts) {
    out.push({ kind: 'text', id: idOf(text), raw: text._raw, box: textBox(text), text })
  }
  for (const textBox of board.grTextBoxes) {
    const box = boxOf(textBoxCorners(textBox))
    out.push({ kind: 'text_box', id: idOf(textBox), raw: textBox._raw, box, textBox })
  }
  for (const point of board.points) {
    out.push({ kind: 'point', id: idOf(point), raw: point._raw, box: pointBox(point), point })
  }
  for (const table of board.tables) {
    out.push({ kind: 'table', id: idOf(table), raw: table._raw, box: cellsBox(table), table })
  }
  for (const pattern of board.tuningPatterns) {
    // The meanders swing at most their amplitude off the run they replaced.
    const run = [...pattern.baseLine, ...(pattern.baseLineCoupled ?? [])]
    const box = boxOf(run, mmToNm(pattern.maxAmplitude))
    out.push({ kind: 'tuning_pattern', id: idOf(pattern), raw: pattern._raw, box, pattern })
  }
  return out
}

/** A zone's id, which also keys it in the session's stale set. */
export const zoneKey = (zone: KicadBoardZone): string =>
  zone.uuid ?? positional('zone', zone.points[0] ?? { x: 0, y: 0 })

/** The item an id names, or the nearest ids when it names none. `child` marks a footprint
 *  reached through one of its own drawings, which a read takes and a write refuses. */
export function resolveItem(
  items: readonly BoardItem[],
  id: string
): { ok: true; item: BoardItem; child?: true } | ItemFailure {
  const found = items.find((item) => item.id === id)
  if (found) return { ok: true, item: found }
  // A footprint reached by uuid when its reference is its id.
  const byUuid = items.find(
    (item) =>
      (item.kind === 'footprint' && item.footprint.uuid === id) ||
      (item.kind === 'pad' && item.pad.uuid === id)
  )
  if (byUuid) return { ok: true, item: byUuid }
  const repeated = padsNamed(items, id)
  if (repeated.length > 1) {
    const where = repeated.map((pad) => `${pad.id} at ${mm(pad.at.x)},${mm(pad.at.y)}`)
    return fail(
      'pad-ambiguous',
      `${id} names ${repeated.length} pads, since the number repeats in its footprint; each is named by its uuid: ${where.join('; ')}.`,
      repeated.map((pad) => pad.id)
    )
  }
  // A footprint's own graphic, text, field or zone, as a check names it, is
  // its footprint: those are edited through the footprint.
  const owner = items.find((item) => item.kind === 'footprint' && ownsUuid(item.footprint._raw, id))
  if (owner) return { ok: true, item: owner, child: true }
  return fail('item-not-found', `No item on the board has the id ${id}.`, nearestIds(items, id))
}

/** The item a write names: as `resolveItem`, refusing a footprint's own drawing, which would
 *  otherwise move or delete the whole footprint. */
export function resolveWritable(
  items: readonly BoardItem[],
  id: string
): { ok: true; item: BoardItem } | ItemFailure {
  const found = resolveItem(items, id)
  if (!found.ok || !found.child) return found
  return fail(
    'refused',
    `${id} is a drawing of footprint ${found.item.id} and goes with it. Move the footprint (${found.item.id}), or edit the drawing in the footprint editor (Edit footprint…).`
  )
}

/** Whether one of a footprint's own items carries this uuid (or a pre-v8 file's tstamp). */
const ownsUuid = (raw: SExprNode, uuid: string): boolean =>
  raw.type === 'list' &&
  raw.children.some((child) => {
    if (child.type !== 'list') return false
    const node = findChild(child, 'uuid') ?? findChild(child, 'tstamp')
    return !!node && getFirstAtomValue(node) === uuid
  })

/** The pads `<footprint id>.<number>` names: several when the number repeats, which KiCad
 *  names by uuid only, so the id is refused rather than taken as either. */
const padsNamed = (
  items: readonly BoardItem[],
  id: string
): Array<Extract<BoardItem, { kind: 'pad' }>> => {
  const owner = items.find((item) => item.kind === 'footprint' && id.startsWith(`${item.id}.`)) as
    Extract<BoardItem, { kind: 'footprint' }> | undefined
  if (!owner) return []
  const number = id.slice(owner.id.length + 1)
  return items.filter(
    (item): item is Extract<BoardItem, { kind: 'pad' }> =>
      item.kind === 'pad' && item.footprint === owner.footprint && item.pad.number === number
  )
}

const nearestIds = (items: readonly BoardItem[], id: string): string[] => {
  const prefix = id.split('.')[0]
  const footprint = items.find((item) => item.kind === 'footprint' && item.id === prefix)
  // A footprint's pads, under whatever id each has: a repeated number's pads are uuids.
  const sameRoot = items
    .filter(
      (item) =>
        item.id.startsWith(prefix) ||
        (item.kind === 'pad' &&
          footprint?.kind === 'footprint' &&
          item.footprint === footprint.footprint)
    )
    .map((item) => item.id)
  if (sameRoot.length) return sameRoot.slice(0, 8)
  const lower = id.toLowerCase()
  return items
    .map((item) => item.id)
    .filter((candidate) => candidate.toLowerCase().includes(lower.slice(0, 3)))
    .slice(0, 8)
}

// ---------------------------------------------------------------------------
// Rows and records
// ---------------------------------------------------------------------------

const netName = (board: KicadBoard, net: number | undefined): string =>
  net ? getNetName(board, net) : ''

const side = (bfp: KicadBoardFootprint): 'front' | 'back' =>
  bfp.layer === 'B.Cu' ? 'back' : 'front'

const isThroughVia = (via: KicadVia, board: KicadBoard): boolean => {
  const copper = stackCopper(board)
  return (
    via.layers.length === 2 &&
    via.layers[0] === copper[0] &&
    via.layers[1] === copper[copper.length - 1]
  )
}

/** The compact row a query answers with; `itemRecord` has the rest. */
export function itemRow(
  board: KicadBoard,
  item: BoardItem,
  stale?: ReadonlySet<string>
): Record<string, unknown> {
  const base = { id: item.id, kind: item.kind }
  switch (item.kind) {
    case 'footprint': {
      const bfp = item.footprint
      return {
        ...base,
        libId: bfp.libId,
        value: bfp.value ?? '',
        at: mmXY(bfp.position),
        angle: bfp.position.angle ?? 0,
        side: side(bfp),
        ...(bfp.footprint.locked ? { locked: true } : {}),
        ...(item.box ? { box: mmBox(item.box) } : {})
      }
    }
    case 'pad':
      return {
        ...base,
        net: item.pad.net?.name ?? '',
        at: mmXY(item.at),
        angle: item.pad.position.angle ?? 0,
        layers: item.pad.layers,
        box: item.box ? mmBox(item.box) : null
      }
    case 'track': {
      const track = item.track
      return {
        ...base,
        net: netName(board, track.net),
        layer: track.layer,
        width: mm(track.width),
        start: mmXY(track.start),
        ...('mid' in track ? { mid: mmXY(track.mid) } : {}),
        end: mmXY(track.end)
      }
    }
    case 'via': {
      const via = item.via
      return {
        ...base,
        net: netName(board, via.net),
        at: mmXY(via.position),
        size: mm(via.size),
        drill: mm(via.drill),
        ...(isThroughVia(via, board) ? {} : { layers: via.layers })
      }
    }
    case 'zone': {
      const zone = item.zone
      const owner = zone.footprint !== undefined ? board.footprints[zone.footprint] : undefined
      return {
        ...base,
        ...(owner ? { reference: owner.reference ?? '' } : {}),
        ...zoneRowFields(zone, zone.netName ?? netName(board, zone.net)),
        ...(item.box ? { box: mmBox(item.box) } : {}),
        ...(stale?.has(item.id) ? { stale: true } : {})
      }
    }
    case 'text': {
      const text = item.text
      return {
        ...base,
        text: text.text,
        layer: text.layer ?? '',
        at: mmXY(text.position ?? { x: 0, y: 0 }),
        angle: text.position?.angle ?? 0
      }
    }
    case 'text_box':
      return { ...base, ...textBoxRecord(item.textBox) }
    case 'point': {
      const point = item.point
      return { ...base, at: mmXY(point.position), size: mm(point.size), layer: point.layer ?? '' }
    }
    case 'table': {
      const table = item.table
      return {
        ...base,
        layer: table.layer ?? '',
        columns: table.columnCount,
        rows: table.rowHeights.length,
        ...(item.box ? { box: mmBox(item.box) } : {})
      }
    }
    case 'tuning_pattern': {
      const pattern = item.pattern
      return {
        ...base,
        net: pattern.lastNetName,
        layer: pattern.layer,
        mode: pattern.mode,
        length: pattern.lastTuningLength,
        status: pattern.lastStatus
      }
    }
    default:
      return { ...base, ...graphicFields(board, item.kind, item.graphic) }
  }
}

const graphicFields = (
  board: KicadBoard,
  kind: GraphicKind,
  graphic: Graphic
): Record<string, unknown> => {
  const layer = graphic.layer ?? ''
  const common = {
    layer,
    width: mm(graphic.strokeWidth ?? 0),
    // A drawing on copper conducts, so KiCad gives it a net.
    ...(isCopperLayer(layer) ? { net: netName(board, graphic.net) } : {}),
    ...strokeRecord(graphic)
  }
  switch (kind) {
    case 'line': {
      const line = graphic as KicadFpLine
      return { ...common, start: mmXY(line.start), end: mmXY(line.end) }
    }
    case 'arc': {
      const arc = graphic as KicadFpArc
      return { ...common, start: mmXY(arc.start), mid: mmXY(arc.mid), end: mmXY(arc.end) }
    }
    case 'circle': {
      const circle = graphic as KicadFpCircle
      return {
        ...common,
        center: mmXY(circle.center),
        radius: mm(Math.hypot(circle.end.x - circle.center.x, circle.end.y - circle.center.y)),
        fill: isSolidFill(circle.fill) ? 'solid' : 'none'
      }
    }
    case 'rect': {
      const rect = graphic as KicadFpRect
      return {
        ...common,
        start: mmXY(rect.start),
        end: mmXY(rect.end),
        ...(rect.radius ? { radius: mm(rect.radius) } : {}),
        fill: isSolidFill(rect.fill) ? 'solid' : 'none'
      }
    }
    case 'bezier':
      return { ...common, points: (graphic as KicadFpCurve).points.map(mmXY) }
    default: {
      const poly = graphic as KicadFpPoly
      return {
        ...common,
        points: poly.points.map(mmXY),
        fill: isSolidFill(poly.fill) ? 'solid' : 'none'
      }
    }
  }
}

/** The full record `items.get` answers with: the row, and everything an update can write. */
export function itemRecord(
  board: KicadBoard,
  items: readonly BoardItem[],
  item: BoardItem,
  stale?: ReadonlySet<string>
): Record<string, unknown> {
  const row = itemRow(board, item, stale)
  switch (item.kind) {
    case 'footprint': {
      const bfp = item.footprint
      const path = footprintPath(bfp)
      return {
        ...row,
        reference: bfp.reference ?? '',
        ...(bfp.uuid ? { uuid: bfp.uuid } : {}),
        ...(path ? { path } : {}),
        ...(footprintFlippable(bfp) ? {} : { flippable: false }),
        pads: items.flatMap((entry) =>
          entry.kind === 'pad' && entry.footprint === bfp
            ? [
                {
                  id: entry.id,
                  number: entry.pad.number,
                  net: entry.pad.net?.name ?? '',
                  at: mmXY(entry.at),
                  layers: entry.pad.layers
                }
              ]
            : []
        )
      }
    }
    case 'pad': {
      const pad = item.pad
      return {
        ...row,
        reference: item.footprint.reference ?? '',
        number: pad.number,
        type: pad.type,
        shape: pad.shape,
        size: { width: mm(pad.size.w), height: mm(pad.size.h) },
        layers: pad.layers,
        ...(pad.drill
          ? {
              drill: {
                diameter: mm(pad.drill.diameter),
                ...(pad.drill.oval
                  ? { oval: { width: mm(pad.drill.oval.width), height: mm(pad.drill.oval.height) } }
                  : {}),
                ...(pad.drill.offset ? { offset: mmXY(pad.drill.offset) } : {})
              }
            }
          : {}),
        ...teardropRecordOf(pad._raw as SExprList),
        box: item.box ? mmBox(item.box) : null
      }
    }
    case 'track':
      return {
        ...row,
        ...(item.track.uuid ? { uuid: item.track.uuid } : {}),
        locked: item.track.locked
      }
    case 'via':
      return {
        ...row,
        layers: item.via.layers,
        ...(item.via.type ? { type: item.via.type } : {}),
        ...(item.via.uuid ? { uuid: item.via.uuid } : {}),
        ...teardropRecordOf(item.via._raw),
        locked: item.via.locked
      }
    case 'zone': {
      const zone = item.zone
      const hatch = zone.hatchFill
      return {
        ...row,
        ...zoneRecordFields(zone),
        ...(zone.isKeepout
          ? {}
          : {
              fillMode: hatch ? 'hatch' : 'solid',
              ...(hatch
                ? {
                    hatchThickness: hatch.thickness,
                    hatchGap: hatch.gap,
                    hatchOrientation: hatch.orientation
                  }
                : {})
            }),
        ...(zone.hatchStyle ? { hatchStyle: zone.hatchStyle } : {}),
        ...(zone.hatchPitch !== undefined ? { hatchPitch: mm(zone.hatchPitch) } : {}),
        ...(zone.uuid ? { uuid: zone.uuid } : {}),
        locked: zone.locked
      }
    }
    case 'text': {
      const text = item.text
      return {
        ...row,
        ...fontRecord(text.fontEffects),
        ...(text.knockout ? { knockout: true } : {}),
        ...(text.hide ? { hidden: true } : {}),
        ...(item.box ? { box: mmBox(item.box) } : {}),
        ...(text.uuid ? { uuid: text.uuid } : {}),
        locked: text.locked
      }
    }
    case 'text_box':
    case 'table': {
      const own = item.kind === 'text_box' ? item.textBox : item.table
      return {
        ...row,
        ...(item.kind === 'table' ? tableRecord(item.table) : {}),
        ...(item.box ? { box: mmBox(item.box) } : {}),
        ...(own.uuid ? { uuid: own.uuid } : {}),
        locked: own.locked
      }
    }
    case 'point':
      return {
        ...row,
        ...(item.box ? { box: mmBox(item.box) } : {}),
        ...(item.point.uuid ? { uuid: item.point.uuid } : {})
      }
    case 'tuning_pattern': {
      const pattern = item.pattern
      const target = pattern.mode === 'diff_pair_skew' ? pattern.targetSkew : pattern.targetLength
      const ids = boardItemIds(board).byObject
      const tracks = [...board.segments, ...board.trackArcs]
      const members = new Set(pattern.members)
      return {
        ...row,
        ...(Number.isFinite(target.opt) ? { target: target.opt } : {}),
        minAmplitude: pattern.minAmplitude,
        maxAmplitude: pattern.maxAmplitude,
        spacing: pattern.minSpacing,
        initialSide: pattern.initialSide,
        singleSided: pattern.singleSided,
        rounded: pattern.rounded,
        cornerRadiusPercent: pattern.cornerRadiusPercent,
        overrideCustomRules: pattern.overrideCustomRules,
        origin: mmXY(pattern.origin),
        end: mmXY(pattern.end),
        tracks: tracks.flatMap((track) =>
          track.uuid && members.has(track.uuid) ? [ids.get(track)!] : []
        ),
        ...(item.box ? { box: mmBox(item.box) } : {}),
        uuid: pattern.uuid
      }
    }
    default:
      return {
        ...row,
        ...(item.box ? { box: mmBox(item.box) } : {}),
        ...(item.graphic.uuid ? { uuid: item.graphic.uuid } : {}),
        locked: item.graphic.locked
      }
  }
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

export interface BoardItemQuery {
  kind?: BoardItemKind
  layer?: string
  net?: string
  box?: { x: number; y: number; width: number; height: number }
  near?: { x?: number; y?: number; id?: string }
  radius?: number
  limit?: number
  /** Matches to skip before the first row. */
  offset?: number
}

const NEAR_DEFAULT_RADIUS = 1

const onLayer = (item: BoardItem, layer: string): boolean => {
  switch (item.kind) {
    case 'footprint':
      return item.footprint.layer === layer
    case 'pad':
      return item.pad.layers.some(
        (l) => l === layer || (isCopperLayer(layer) && (l === '*.Cu' || l === 'F&B.Cu'))
      )
    case 'track':
      return item.track.layer === layer
    case 'via':
      return item.via.layers.includes(layer)
    case 'zone':
      return item.zone.layers.includes(layer) || item.zone.layers.includes('*.Cu')
    case 'text':
      return item.text.layer === layer
    case 'text_box':
      return item.textBox.layer === layer
    case 'point':
      return item.point.layer === layer
    case 'table':
      return item.table.layer === layer
    case 'tuning_pattern':
      return item.pattern.layer === layer
    default:
      return item.graphic.layer === layer
  }
}

const netOf = (board: KicadBoard, item: BoardItem): string | null => {
  switch (item.kind) {
    case 'pad':
      return item.pad.net?.name ?? ''
    case 'track':
      return netName(board, item.track.net)
    case 'via':
      return netName(board, item.via.net)
    case 'zone':
      return item.zone.netName ?? netName(board, item.zone.net)
    case 'tuning_pattern':
      return item.pattern.lastNetName
    case 'line':
    case 'arc':
    case 'circle':
    case 'rect':
    case 'poly':
    case 'bezier':
      return isCopperLayer(item.graphic.layer ?? '') ? netName(board, item.graphic.net) : null
    default:
      return null
  }
}

/** Items matching every filter given: every match, and the page from `offset`, capped at `limit`. */
export function queryItems(
  board: KicadBoard,
  items: readonly BoardItem[],
  query: BoardItemQuery
): (QueryPage<BoardItem> & { matches: BoardItem[] }) | ItemFailure {
  let center: Pt | null = null
  if (query.near) {
    if (query.near.id) {
      const found = resolveItem(items, query.near.id)
      if (!found.ok) return found
      const box = found.item.box
      center = box
        ? { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 }
        : found.item.kind === 'pad'
          ? found.item.at
          : null
    } else if (query.near.x !== undefined && query.near.y !== undefined) {
      center = { x: mmToNm(query.near.x), y: mmToNm(query.near.y) }
    }
    if (!center) return fail('invalid-record', 'near needs an id, or both x and y.')
  }
  const region = query.box
    ? {
        minX: mmToNm(query.box.x),
        minY: mmToNm(query.box.y),
        maxX: mmToNm(query.box.x + query.box.width),
        maxY: mmToNm(query.box.y + query.box.height)
      }
    : null
  const reach = mmToNm(query.radius ?? NEAR_DEFAULT_RADIUS)
  const wantNet = query.net?.replace(/^\/+/, '')
  const matches = items.filter((item) => {
    if (query.kind && item.kind !== query.kind) return false
    if (query.layer && !onLayer(item, query.layer)) return false
    if (wantNet !== undefined) {
      const net = netOf(board, item)
      if (net === null || net.replace(/^\/+/, '') !== wantNet) return false
    }
    if (region && (!item.box || !boxesTouch(item.box, region))) return false
    if (center && (!item.box || distanceToBox(item.box, center) > reach)) return false
    return true
  })
  return { ...pageOf(matches, query.offset, query.limit), matches }
}

/** The breakdowns a capped board query names: by kind, then by layer and by net. */
export const boardNarrowings = (
  board: KicadBoard,
  matches: readonly BoardItem[],
  query: BoardItemQuery
): Narrowing[] => {
  const layers = boardLayerNames(board)
  return narrowingsOf(matches, query.kind !== undefined, [
    {
      arg: 'layer',
      given: query.layer !== undefined,
      tally: (items) => tallyBy(items, layers, onLayer)
    },
    {
      arg: 'net',
      given: query.net !== undefined,
      tally: (items) =>
        tally(items, (item) => {
          const net = netOf(board, item)
          return net === null ? [] : [net]
        })
    }
  ])
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export type EditOutcome = { ok: true; board: KicadBoard; id: string } | ItemFailure

type Rec = Record<string, unknown>

/** A record held to what its kind takes and to each key's rule (`shared/recordRules.ts`). */
const validate = (kind: BoardItemKind, record: Rec, mode: RecordMode): ItemFailure | null => {
  const failure = checkRecord('board', kind, record, mode)
  return failure ? fail(failure.error as ItemFailure['error'], failure.detail) : null
}

const resolveNet = (
  board: KicadBoard,
  name: unknown
): { ok: true; number: number; name: string } | ItemFailure => {
  if (typeof name !== 'string') return fail('invalid-record', 'net is a net name, e.g. "GND".')
  const wanted = name.trim()
  if (!wanted) return { ok: true, number: 0, name: '' }
  const bare = (n: string): string => n.replace(/^\/+/, '')
  const found =
    board.nets.find((net) => net.name === wanted) ??
    board.nets.find((net) => bare(net.name) === bare(wanted))
  if (found) return { ok: true, number: found.number, name: found.name }
  const lower = bare(wanted).toLowerCase()
  const candidates = board.nets
    .map((net) => net.name)
    .filter((n) => n && bare(n).toLowerCase().includes(lower.slice(0, 2)))
    .slice(0, 8)
  return fail(
    'net-not-found',
    `No net called ${wanted} is on the board. Nets come from the schematic: board_sync carries a new one over.`,
    candidates
  )
}

const boardLayerNames = (board: KicadBoard): string[] => board.layers.map((l) => l.name)

/** The board's copper front to back, whatever order its file lists the layers in. */
const stackCopper = (board: KicadBoard): string[] =>
  boardLayerNames(board)
    .filter(isCopperLayer)
    .sort((a, b) => copperRank(a) - copperRank(b))

const resolveLayer = (
  board: KicadBoard,
  layer: unknown,
  copper: boolean
): { ok: true; layer: string } | ItemFailure => {
  if (typeof layer !== 'string' || !layer.trim())
    return fail('invalid-record', 'layer is a board layer name, e.g. "F.Cu" or "Edge.Cuts".')
  const names = boardLayerNames(board)
  const wanted = layer.trim()
  const found = names.find((name) => name === wanted)
  const candidates = copper ? names.filter(isCopperLayer) : names
  if (!found)
    return fail('layer-not-found', `The board has no layer ${wanted}.`, candidates.slice(0, 12))
  if (copper && !isCopperLayer(found))
    return fail('invalid-record', `${found} is not a copper layer.`, candidates)
  return { ok: true, layer: found }
}

const isLockedItem = (item: BoardItem): boolean => lockTarget(item)?.locked ?? false

/**
 * The object `setBoardItemLockedInAST` flips: a footprint's is its definition,
 * the same node. A pad is its footprint's; a point and a tuning pattern carry
 * no lock in the format.
 */
const lockTarget = (item: BoardItem): { _raw: SExprNode; locked: boolean } | null => {
  switch (item.kind) {
    case 'footprint':
      return item.footprint.footprint
    case 'pad':
    case 'point':
    case 'tuning_pattern':
      return null
    case 'track':
      return item.track
    case 'via':
      return item.via
    case 'zone':
      return item.zone
    case 'text':
      return item.text
    case 'text_box':
      return item.textBox
    case 'table':
      return item.table
    default:
      return item.graphic
  }
}

/** What a copper zone carries and a rule area does not: the pour settings. */
const POUR_KEYS = [...KEY_GROUPS.pour, ...KEY_GROUPS['hatched pour']]

/** What to do instead of writing a key the record only reads (`BOARD_READ_ONLY_KEYS`). */
const READ_ONLY_INSTEAD: Partial<Record<BoardItemKind, string>> = {
  text_box: 'turn it in the board editor',
  table: 'edit its cells in the board editor',
  tuning_pattern: 'they are what its tune laid; set its target and meander settings instead'
}

/** Keys that leave a locked item where it is: its lock, and what it is not placed by. */
const PLACEMENT_KEYS = new Set([
  'at',
  'angle',
  'side',
  'start',
  'mid',
  'end',
  'center',
  'radius',
  'points',
  'layer',
  'layers'
])

const pointOf = (record: Rec, key: string): { x: Nm; y: Nm } | undefined =>
  record[key] === undefined ? undefined : nmXY(record[key] as Pt)

const pointsOf = (record: Rec, key: string): Array<{ x: Nm; y: Nm }> | undefined =>
  record[key] === undefined ? undefined : (record[key] as Pt[]).map(nmXY)

const lengthOf = (record: Rec, key: string): Nm | undefined =>
  record[key] === undefined ? undefined : mmToNm(record[key] as number)

const fillOf = (record: Rec): 'none' | 'solid' | undefined =>
  record.fill === undefined ? undefined : isPcbFillOn(record.fill) ? 'solid' : 'none'

const isFailure = (value: unknown): value is ItemFailure =>
  typeof value === 'object' && value !== null && (value as ItemFailure).ok === false

/** A zone a footprint carries is read-only: it moves, turns and flips with its footprint. */
const footprintZoneRefusal = (
  board: KicadBoard,
  targets: readonly BoardItem[]
): ItemFailure | null => {
  const owned = targets.find((item) => item.kind === 'zone' && item.zone.footprint !== undefined)
  if (owned?.kind !== 'zone') return null
  const reference = board.footprints[owned.zone.footprint ?? -1]?.reference ?? ''
  return fail(
    'refused',
    `${owned.id} is a zone of footprint ${reference} and goes with it; a footprint's zones are read-only on the board. Move the footprint, or edit the zone in the footprint editor (Edit footprint…).`
  )
}

/** Write a partial record onto one item. */
export function updateItem(board: KicadBoard, item: BoardItem, record: Rec): EditOutcome {
  if (item.kind === 'pad')
    return fail(
      'refused',
      `${item.id} is a pad: its copper is the footprint's. Move the footprint, or change the pad in its library footprint and sync.`
    )
  // The door lays a pattern again with `tuningPatternUpdate`'s settings, over the router.
  if (item.kind === 'tuning_pattern')
    return fail('refused', `${item.id} is a tuning pattern, re-tuned whole by its door.`)
  const owned = footprintZoneRefusal(board, [item])
  if (owned) return owned
  const readOnly = BOARD_READ_ONLY_KEYS[item.kind] ?? []
  const blocked = Object.keys(record).filter((key) => readOnly.includes(key))
  if (blocked.length)
    return fail(
      'not-applicable',
      `A ${item.kind}'s ${blocked.join(', ')} cannot be changed here; ${READ_ONLY_INSTEAD[item.kind]}.`
    )
  const invalid = validate(item.kind, record, 'update')
  if (invalid) return invalid
  if (!Object.keys(record).length) return fail('invalid-record', 'The record changes nothing.')
  const moves = Object.keys(record).filter((key) => PLACEMENT_KEYS.has(key))
  if (moves.length && isLockedItem(item) && record.locked !== false)
    return fail(
      'locked',
      `${item.id} is locked, so ${moves.join(', ')} ${moves.length === 1 ? 'is' : 'are'} refused. Send "locked": false with the change if the user means to move it.`
    )

  const target = lockTarget(item)
  if (record.locked === false && target?.locked) setBoardItemLockedInAST(target, false)
  const written = writeRecord(board, item, record)
  if (isFailure(written)) return written
  // A flip replaced the node: the lock goes on the one now in the board.
  const lockable = written.footprint?.footprint ?? target
  if (record.locked === true && lockable && !lockable.locked)
    setBoardItemLockedInAST(lockable, true)
  // A new reference renames the footprint, and its id with it.
  const id =
    written.footprint && record.reference !== undefined
      ? (boardItemIds(written.board).byObject.get(written.footprint) ?? item.id)
      : item.id
  return { ok: true, board: written.board, id }
}

/**
 * A tuning pattern's settings with a record written over them, as its
 * Properties rows and handles set them (`patternEdit`); the door lays it
 * again with them (`patternRetune.ts`).
 */
export function tuningPatternUpdate(
  pattern: KicadTuningPattern,
  record: Rec
): { ok: true; data: TuningPatternData } | ItemFailure {
  const readOnly = BOARD_READ_ONLY_KEYS.tuning_pattern ?? []
  const blocked = Object.keys(record).filter((key) => readOnly.includes(key))
  if (blocked.length)
    return fail(
      'not-applicable',
      `A tuning_pattern's ${blocked.join(', ')} cannot be changed here; ${READ_ONLY_INSTEAD.tuning_pattern}.`
    )
  const invalid = validate('tuning_pattern', record, 'update')
  if (invalid) return invalid
  if (!Object.keys(record).length) return fail('invalid-record', 'The record changes nothing.')
  const { minAmplitude, maxAmplitude, target } = record
  if (
    typeof minAmplitude === 'number' &&
    typeof maxAmplitude === 'number' &&
    minAmplitude > maxAmplitude
  )
    return fail('invalid-record', 'minAmplitude is more than maxAmplitude.')
  if (typeof target === 'number' && pattern.mode !== 'diff_pair_skew' && target <= 0)
    return fail('invalid-record', 'target is a length here, more than 0 mm.')
  // The least amplitude before the largest, so a pair given together holds as given.
  const order = ['minAmplitude', ...Object.keys(record).filter((key) => key !== 'minAmplitude')]
  let data: TuningPatternData = pattern
  for (const key of order) {
    if (record[key] === undefined) continue
    if (key === 'origin' || key === 'end') data = { ...data, [key]: pointOf(record, key)! }
    else data = patternEdit(data, key, record[key] as PropertyEditValue)
  }
  return { ok: true, data }
}

/** A record's keys written onto the item, its lock aside: an update's, or a create's extras. */
const writeRecord = (
  board: KicadBoard,
  item: BoardItem,
  record: Rec
): { board: KicadBoard; footprint?: KicadBoardFootprint } | ItemFailure => {
  const done = (failure: ItemFailure | null): { board: KicadBoard } | ItemFailure =>
    failure ?? { board }
  switch (item.kind) {
    case 'pad':
    case 'tuning_pattern':
      return fail('refused', `A ${item.kind} is not written here.`)
    case 'footprint':
      return updateFootprint(board, item.footprint, record)
    case 'track':
      return done(updateTrack(board, item.track, record))
    case 'via':
      return done(updateVia(board, item.via, record))
    case 'zone':
      return done(updateZone(board, item.zone, record))
    case 'text':
      return done(updateText(board, item.text, record))
    case 'text_box':
      return done(updateBoardTextBox(board, item.textBox, record))
    case 'point':
      return done(updatePoint(board, item.point, record))
    case 'table':
      return done(updateTable(board, item.table, record))
    default:
      return done(updateGraphic(board, item.kind, item.graphic, record))
  }
}

const updateFootprint = (
  board: KicadBoard,
  bfp: KicadBoardFootprint,
  record: Rec
): { board: KicadBoard; footprint: KicadBoardFootprint } | ItemFailure => {
  const at = pointOf(record, 'at')
  const angle = record.angle
  const wantSide = record.side
  const names = footprintNames(board, bfp, record)
  if (isFailure(names)) return names

  let current = board
  let fp = bfp
  // Side first: KiCad's Side field flips the part about its anchor, and the
  // angle and position that follow are the ones asked for on the new side.
  if (wantSide !== undefined && wantSide !== side(fp)) {
    if (!footprintFlippable(fp))
      return fail(
        'refused',
        `${fp.reference ?? 'This footprint'} holds a table, which the board editor cannot flip either.`
      )
    const index = current.footprints.indexOf(fp)
    flipBoardFootprintInAST(current, fp, fp.position)
    current = remapKicadBoard(current)
    fp = current.footprints[index]
  }
  if (typeof angle === 'number') rotateBoardFootprintInAST(fp, angle)
  if (at) moveBoardFootprintInAST(fp, at.x, at.y)
  for (const [which, text] of names) {
    markNodeDirty(fp.footprint._raw)
    setFootprintFieldText(fp.footprint, which, text)
    fp[which] = text
  }
  return { board: current, footprint: fp }
}

/**
 * The reference and value a record gives, checked as the board editor's
 * Footprint rows take them: only a footprint no symbol owns names itself
 * (`pcbPropertySchema.ts`), and a reference names one footprint.
 */
const footprintNames = (
  board: KicadBoard,
  bfp: KicadBoardFootprint,
  record: Rec
): Array<['reference' | 'value', string]> | ItemFailure => {
  const names: Array<['reference' | 'value', string]> = []
  for (const which of ['reference', 'value'] as const) {
    const text = record[which]
    if (typeof text === 'string') names.push([which, text.trim()])
  }
  if (!names.length) return names
  const owner = bfp.reference ?? 'This footprint'
  if (isSymbolOwned(bfp))
    return fail(
      'refused',
      `${owner}'s reference and value are its schematic symbol's. Change them on the sheet (schematic_annotate renumbers; items_update sets the value), then board_sync.`
    )
  const reference = names.find(([which]) => which === 'reference')?.[1]
  if (
    reference &&
    reference !== bfp.reference &&
    board.footprints.some((f) => f.reference === reference)
  )
    return fail('reference-taken', `${reference} is already on the board; choose a free reference.`)
  return names
}

const updateTrack = (
  board: KicadBoard,
  track: KicadTrackSegment | KicadTrackArc,
  record: Rec
): ItemFailure | null => {
  const start = pointOf(record, 'start')
  const end = pointOf(record, 'end')
  const mid = pointOf(record, 'mid')
  const width = lengthOf(record, 'width')
  const isArc = 'mid' in track
  if (mid && !isArc) return fail('not-applicable', 'A straight track has no mid point.')
  let layer: string | undefined
  if (record.layer !== undefined) {
    const found = resolveLayer(board, record.layer, true)
    if (!found.ok) return found
    layer = found.layer
  }
  let net: number | undefined
  if (record.net !== undefined) {
    if (isArc) return fail('not-applicable', 'An arc track takes its net from what it joins.')
    const found = resolveNet(board, record.net)
    if (!found.ok) return found
    net = found.number
  }
  const patch = {
    ...(start ? { start } : {}),
    ...(end ? { end } : {}),
    ...(width !== undefined ? { width } : {}),
    ...(layer ? { layer } : {})
  }
  if (isArc) updateTrackArcInAST(track, { ...patch, ...(mid ? { mid } : {}) })
  else updateSegmentInAST(track, { ...patch, ...(net !== undefined ? { net } : {}) }, board)
  return null
}

const updateVia = (board: KicadBoard, via: KicadVia, record: Rec): ItemFailure | null => {
  const at = pointOf(record, 'at')
  const size = lengthOf(record, 'size')
  const drill = lengthOf(record, 'drill')
  const finalSize = size ?? via.size
  const finalDrill = drill ?? via.drill
  if (finalDrill >= finalSize)
    return fail('invalid-record', 'A via drill must be smaller than its size.')
  let net: number | undefined
  if (record.net !== undefined) {
    const found = resolveNet(board, record.net)
    if (!found.ok) return found
    net = found.number
  }
  const span =
    record.type !== undefined || record.layers !== undefined
      ? viaSpanOf(board, record, via.type ?? 'through', via.layers)
      : null
  if (isFailure(span)) return span
  if (record.teardrops !== undefined)
    writeTeardropParams(via._raw, teardropsFromRecord(via._raw, record.teardrops), 'via', via._raw)
  updateViaInAST(
    via,
    {
      ...(at ? { position: at } : {}),
      ...(size !== undefined ? { size } : {}),
      ...(drill !== undefined ? { drill } : {}),
      ...(net !== undefined ? { net } : {}),
      ...(span ?? {})
    },
    board
  )
  return null
}

type ViaType = (typeof VIA_TYPES)[number]

const viaLayers = (board: KicadBoard, value: unknown): string[] | ItemFailure => {
  const out: string[] = []
  for (const layer of value as string[]) {
    const found = resolveLayer(board, layer, true)
    if (!found.ok) return found
    out.push(found.layer)
  }
  if (out[0] === out[1]) return fail('invalid-record', 'A via spans two different layers.')
  return out
}

/**
 * A via's type and the two copper layers it joins, top first, held to the
 * layer pair each type takes (`viaPlacement.ts`'s `viaFileForm`): a through
 * via joins the outer layers; a blind via one outer layer to an inner one; a
 * buried via two inner layers; a microvia any pair but the outer one. A
 * through via given no layers spans the outer pair.
 */
const viaSpanOf = (
  board: KicadBoard,
  record: Rec,
  currentType: string,
  currentLayers: readonly string[]
): { type: ViaType; layers: string[] } | ItemFailure => {
  const type = (record.type ?? currentType) as ViaType
  const copper = stackCopper(board)
  const outer = [copper[0] ?? 'F.Cu', copper[copper.length - 1] ?? 'B.Cu']
  let layers: string[]
  if (record.layers !== undefined) {
    const resolved = viaLayers(board, record.layers)
    if (isFailure(resolved)) return resolved
    layers = resolved
  } else if (type === 'through') layers = outer
  else if (record.type !== undefined && currentType === 'through')
    return fail(
      'invalid-record',
      `A ${type} via needs layers: the two copper layers it joins, e.g. ["${outer[0]}", "${copper[1] ?? 'In1.Cu'}"].`
    )
  else layers = [...currentLayers]
  layers.sort((a, b) => copper.indexOf(a) - copper.indexOf(b))
  const [top, bottom] = layers
  const outerEnds = layers.filter((layer) => outer.includes(layer)).length
  const span = `${top} to ${bottom}`
  if (type === 'through' && outerEnds < 2)
    return fail(
      'invalid-record',
      `A through via joins ${outer[0]} and ${outer[1]}; one from ${span} is blind, buried or micro: send its type.`
    )
  if (type !== 'through' && outerEnds === 2)
    return fail(
      'invalid-record',
      `A ${type} via from ${span} joins the outer layers, so it is a through via: send "type": "through".`
    )
  if (type === 'blind' && outerEnds === 0)
    return fail(
      'invalid-record',
      `A via from ${span} reaches no outer layer: send "type": "buried".`
    )
  if (type === 'buried' && outerEnds === 1)
    return fail(
      'invalid-record',
      `A via from ${span} reaches an outer layer: send "type": "blind".`
    )
  return { type, layers }
}

const zoneLayersOf = (board: KicadBoard, value: unknown): string[] | ItemFailure => {
  const list = typeof value === 'string' ? [value] : (value as string[])
  const out: string[] = []
  for (const layer of list) {
    if (layer === '*.Cu') {
      out.push(layer)
      continue
    }
    const found = resolveLayer(board, layer, true)
    if (!found.ok) return found
    out.push(found.layer)
  }
  return out
}

/** Pour settings sent for a rule area, which reads none of them back. */
const pourOnRuleArea = (record: Rec, keepout: boolean): ItemFailure | null => {
  const given = POUR_KEYS.filter((key) => record[key] !== undefined)
  return keepout && given.length
    ? fail(
        'not-applicable',
        `A rule area does not pour, so it does not carry ${given.join(', ')}; it takes rules.`
      )
    : null
}

/** The island keys: the mode, and the smallest island kept (mm²) when it removes those below one. */
const islandsOf = (
  zone: KicadBoardZone | null,
  record: Rec
): Pick<ZoneUpdate, 'islandRemovalMode' | 'minIslandArea'> | ItemFailure => {
  const { islands, minIslandArea } = record
  if (minIslandArea !== undefined) {
    const mode = islands ?? (zone?.islandRemovalMode === 2 ? 'below_area' : undefined)
    if (mode !== 'below_area')
      return fail(
        'not-applicable',
        'minIslandArea is the smallest island kept: send it with islands "below_area".'
      )
  }
  return islandsUpdate(zone, islands, minIslandArea)
}

/** A hatched pour's web, gap and turn, as the GUI's Fill rows set them; null pours solid again. */
const hatchFillOf = (
  zone: KicadBoardZone | null,
  record: Rec
): ZoneUpdate['hatchFill'] | ItemFailure => {
  const { fillMode, hatchThickness, hatchGap, hatchOrientation } = record
  const given = (['hatchThickness', 'hatchGap', 'hatchOrientation'] as const).filter(
    (key) => record[key] !== undefined
  )
  const hatched = fillMode === undefined ? !!zone?.hatchFill : fillMode === 'hatch'
  if (given.length && !hatched)
    return fail(
      'not-applicable',
      `${given.join(', ')} ${given.length === 1 ? 'is' : 'are'} for a hatched pour: send "fillMode": "hatch" with ${given.length === 1 ? 'it' : 'them'}.`
    )
  if (fillMode === 'solid') return null
  if (fillMode === undefined && !given.length) return undefined
  return {
    ...(hatchThickness !== undefined ? { thickness: hatchThickness as number } : {}),
    ...(hatchGap !== undefined ? { gap: hatchGap as number } : {}),
    ...(hatchOrientation !== undefined ? { orientation: hatchOrientation as number } : {})
  }
}

const zoneUpdateOf = (
  board: KicadBoard,
  zone: KicadBoardZone | null,
  record: Rec
): ZoneUpdate | ItemFailure => {
  const update: ZoneUpdate = {}
  if (record.net !== undefined) {
    const net = resolveNet(board, record.net)
    if (!net.ok) return net
    update.net = { number: net.number, name: net.name }
  }
  if (record.layers !== undefined) {
    const layers = zoneLayersOf(board, record.layers)
    if (isFailure(layers)) return layers
    update.layers = layers
  }
  if (typeof record.name === 'string') update.name = record.name
  if (typeof record.priority === 'number')
    update.priority = record.priority === 0 ? null : record.priority
  for (const key of ['minThickness', 'padClearance', 'thermalGap', 'thermalBridgeWidth'] as const) {
    const value = lengthOf(record, key)
    if (value !== undefined) update[key] = value
  }
  if (record.padConnection !== undefined)
    update.padConnection = record.padConnection as ZonePadConnection
  const islands = islandsOf(zone, record)
  if (isFailure(islands)) return islands
  Object.assign(update, islands)
  const fill = hatchFillOf(zone, record)
  if (isFailure(fill)) return fill
  if (fill !== undefined) update.hatchFill = fill
  if (record.hatchStyle !== undefined)
    update.hatchStyle = record.hatchStyle as 'none' | 'edge' | 'full'
  const pitch = lengthOf(record, 'hatchPitch')
  if (pitch !== undefined) update.hatchPitch = pitch
  if (typeof record.keepout === 'boolean') update.keepout = record.keepout
  if (record.rules !== undefined)
    update.keepoutRules = Object.fromEntries(
      Object.entries(record.rules as Record<string, string>).map(([key, value]) => [
        key,
        value === 'allowed'
      ])
    ) as Partial<ZoneKeepoutRules>
  return update
}

const updateZone = (board: KicadBoard, zone: KicadBoardZone, record: Rec): ItemFailure | null => {
  const points = pointsOf(record, 'points')
  const keepout = (record.keepout as boolean | undefined) ?? zone.isKeepout
  if (record.rules !== undefined && !keepout)
    return fail('not-applicable', 'rules are for a rule area: send "keepout": true with them.')
  const pour = pourOnRuleArea(record, keepout)
  if (pour) return pour
  const update = zoneUpdateOf(board, zone, record)
  if (isFailure(update)) return update
  if (Object.keys(update).length) updateBoardZoneInAST(zone, update, board)
  if (points) setBoardZoneOutlineInAST(zone, points)
  return null
}

/** A layer the record names, resolved on the board; undefined when it names none. */
const layerIn = (
  board: KicadBoard,
  record: Rec
): { ok: true; layer: string | undefined } | ItemFailure =>
  record.layer === undefined
    ? { ok: true, layer: undefined }
    : resolveLayer(board, record.layer, false)

const updateText = (board: KicadBoard, text: KicadGrText, record: Rec): ItemFailure | null => {
  const at = pointOf(record, 'at')
  const layer = layerIn(board, record)
  if (!layer.ok) return layer
  const effects = fontEffects(text.fontEffects, record)
  updateGrTextInAST(text, {
    ...(typeof record.text === 'string' ? { text: record.text } : {}),
    ...(at || record.angle !== undefined
      ? {
          position: {
            x: at?.x ?? text.position?.x ?? (0 as Nm),
            y: at?.y ?? text.position?.y ?? (0 as Nm),
            angle: typeof record.angle === 'number' ? record.angle : text.position?.angle
          }
        }
      : {}),
    ...(layer.layer ? { layer: layer.layer } : {}),
    ...(typeof record.hidden === 'boolean' ? { hide: record.hidden } : {}),
    ...(effects ? { fontEffects: effects } : {}),
    ...(typeof record.knockout === 'boolean' ? { knockout: record.knockout } : {})
  })
  return null
}

/** A text box: the footprint door's writer, on a layer of this board. */
const updateBoardTextBox = (
  board: KicadBoard,
  box: KicadFpTextBox,
  record: Rec
): ItemFailure | null => {
  const layer = layerIn(board, record)
  if (!layer.ok) return layer
  return updateTextBox(box, layer.layer ? { ...record, layer: layer.layer } : record)
}

const updatePoint = (board: KicadBoard, point: KicadPoint, record: Rec): ItemFailure | null => {
  const at = pointOf(record, 'at')
  const size = lengthOf(record, 'size')
  const layer = layerIn(board, record)
  if (!layer.ok) return layer
  updatePointInAST(point, {
    ...(at ? { position: at } : {}),
    ...(size !== undefined ? { size } : {}),
    ...(layer.layer ? { layer: layer.layer } : {})
  })
  return null
}

const updateTable = (board: KicadBoard, table: KicadTable, record: Rec): ItemFailure | null => {
  const layer = layerIn(board, record)
  if (!layer.ok) return layer
  updateTableInAST(table, tablePatchOf(layer.layer ? { ...record, layer: layer.layer } : record))
  return null
}

const updateGraphic = (
  board: KicadBoard,
  kind: GraphicKind,
  graphic: Graphic,
  record: Rec
): ItemFailure | null => {
  const start = pointOf(record, 'start')
  const end = pointOf(record, 'end')
  const mid = pointOf(record, 'mid')
  const center = pointOf(record, 'center')
  const points = kind === 'bezier' ? undefined : pointsOf(record, 'points')
  const width = lengthOf(record, 'width')
  const radius = kind === 'circle' ? lengthOf(record, 'radius') : undefined
  const fill = fillOf(record)
  const layer = layerIn(board, record)
  if (!layer.ok) return layer
  let net: number | undefined
  if (record.net !== undefined) {
    const on = layer.layer ?? graphic.layer ?? ''
    if (!isCopperLayer(on))
      return fail(
        'not-applicable',
        `A drawing on ${on} conducts nothing, so it takes no net; only one on copper does.`
      )
    const found = resolveNet(board, record.net)
    if (!found.ok) return found
    net = found.number
  }
  const common = {
    ...(layer.layer ? { layer: layer.layer } : {}),
    ...(width !== undefined ? { strokeWidth: width } : {})
  }
  switch (kind) {
    case 'line':
      updateLineInAST(graphic as KicadFpLine, {
        ...common,
        ...(start ? { start } : {}),
        ...(end ? { end } : {})
      })
      break
    case 'arc':
      updateArcInAST(graphic as KicadFpArc, {
        ...common,
        ...(start ? { start } : {}),
        ...(mid ? { mid } : {}),
        ...(end ? { end } : {})
      })
      break
    case 'circle': {
      const circle = graphic as KicadFpCircle
      const c = center ?? circle.center
      const r = radius ?? Math.hypot(circle.end.x - circle.center.x, circle.end.y - circle.center.y)
      updateCircleInAST(circle, {
        ...common,
        ...(center || radius !== undefined
          ? { center: c, end: { x: (c.x + r) as Nm, y: c.y } }
          : {}),
        ...(fill ? { fill } : {})
      })
      break
    }
    case 'rect':
      updateRectInAST(graphic as KicadFpRect, {
        ...common,
        ...(start ? { start } : {}),
        ...(end ? { end } : {}),
        ...(record.radius !== undefined
          ? { radius: mmToNm((record.radius as number | null) ?? 0) }
          : {}),
        ...(fill ? { fill } : {})
      })
      break
    case 'bezier':
      updateCurveInAST(graphic as KicadFpCurve, {
        ...common,
        ...(record.points ? { points: (record.points as Pt[]).map(nmXY) } : {})
      })
      break
    default:
      updatePolyInAST(graphic as KicadFpPoly, {
        ...common,
        ...(points ? { points } : {}),
        ...(fill ? { fill } : {})
      })
  }
  writeStroke(graphic._raw, record)
  // The facade too: the remapped board keeps this object for the node.
  if (typeof record.strokeType === 'string') graphic.strokeType = record.strokeType
  if (record.strokeColor !== undefined)
    graphic.strokeColor = hexColorToRgba(record.strokeColor as string | null) ?? undefined
  if (net !== undefined) setGraphicNetInAST(graphic, net, board)
  return null
}

/** A delete's outcome, with the tracks a tuning pattern took or gave back beside the targets. */
export type DeleteOutcome =
  { ok: true; board: KicadBoard; id: string; created: string[]; deleted: string[] } | ItemFailure

/**
 * Remove items by their top-level nodes; a pad is refused, being its
 * footprint's. A tuning pattern goes as the board editor deletes one: alone,
 * it gives back the straight track it replaced; beside other items, its
 * tracks go with it.
 */
export function deleteItems(board: KicadBoard, targets: readonly BoardItem[]): DeleteOutcome {
  const pad = targets.find((item) => item.kind === 'pad')
  if (pad)
    return fail(
      'refused',
      `${pad.id} is a pad and goes only with its footprint. Delete the footprint, or change the library footprint and sync.`
    )
  const owned = footprintZoneRefusal(board, targets)
  if (owned) return owned
  const locked = targets.find(isLockedItem)
  if (locked)
    return fail(
      'locked',
      `${locked.id} is locked, so it is not deleted. Unlock it with items_update { "locked": false } first if the user means to remove it.`
    )
  const patterns = targets.flatMap((item) => (item.kind === 'tuning_pattern' ? [item.pattern] : []))
  const named = new Set(targets.map((item) => item.id))
  const before = new Set((board._raw as { children: SExprNode[] }).children)
  const was = boardItemIds(board).byObject
  const members = new Set(patterns.flatMap((pattern) => pattern.members))
  const taken = [...board.segments, ...board.trackArcs].flatMap((track) => {
    const id = was.get(track)
    return track.uuid && members.has(track.uuid) && id && !named.has(id) ? [id] : []
  })
  if (patterns.length === targets.length)
    for (const pattern of patterns) restorePatternInAST(board, pattern)
  else {
    for (const pattern of patterns) deletePatternInAST(board, pattern)
    for (const item of targets)
      if (item.kind !== 'tuning_pattern') removeBoardNodeFromAST(board, item.raw)
  }
  const next = remapKicadBoard(board)
  const now = boardItemIds(next).byObject
  const created = next.segments.flatMap((track) =>
    before.has(track._raw) ? [] : [now.get(track) ?? '']
  )
  return {
    ok: true,
    board: next,
    id: targets.map((t) => t.id).join(','),
    created: created.filter(Boolean),
    deleted: taken
  }
}

// ---------------------------------------------------------------------------
// Creating
// ---------------------------------------------------------------------------

/**
 * The keys each kind's own writer lays down; the rest of a create's record
 * goes on as an update writes it. A text's size is laid down only when square.
 */
const CREATE_BASE: Partial<Record<BoardCreateKind, readonly string[]>> = {
  line: ['start', 'end', 'layer', 'width'],
  arc: ['start', 'mid', 'end', 'layer', 'width'],
  circle: ['center', 'radius', 'layer', 'width', 'fill'],
  rect: ['start', 'end', 'layer', 'width', 'fill'],
  poly: ['points', 'layer', 'width', 'fill'],
  bezier: ['points', 'layer', 'width'],
  text: ['text', 'at', 'angle', 'layer', 'size', 'thickness'],
  text_box: ['text', 'start', 'end', 'layer', 'size', 'thickness', 'width']
}

export type CreateOutcome = { ok: true; board: KicadBoard; ids: string[] } | ItemFailure

/** A point a track or via lands on: coordinates, or a pad or via id it snaps to. */
interface Anchor {
  at: { x: Nm; y: Nm }
  /** The net of the pad or via it names; undefined for a bare point. */
  net?: { number: number; name: string }
  id?: string
  /** A pad's copper layers ('*.Cu' spans all). */
  layers?: string[]
}

const anchorOf = (
  board: KicadBoard,
  items: readonly BoardItem[],
  value: unknown,
  key: string
): Anchor | ItemFailure => {
  if (isPoint(value)) return { at: nmXY(value) }
  if (typeof value !== 'string')
    return fail('invalid-record', `${key} is a point {x, y} in mm, or a pad or via id.`)
  const found = resolveItem(items, value)
  if (!found.ok) return found
  const item = found.item
  if (item.kind === 'pad') {
    const net = item.pad.net
    return {
      at: { x: Math.round(item.at.x) as Nm, y: Math.round(item.at.y) as Nm },
      id: item.id,
      layers: item.pad.layers,
      ...(net ? { net: { number: net.number, name: net.name } } : { net: { number: 0, name: '' } })
    }
  }
  if (item.kind === 'via') {
    const via = item.via
    return {
      at: via.position,
      id: item.id,
      layers: via.layers,
      net: { number: via.net, name: netName(board, via.net) }
    }
  }
  return fail(
    'invalid-record',
    `${key} names ${item.id}, a ${item.kind}; only a pad or a via is a point.`
  )
}

const anchorOnLayer = (board: KicadBoard, anchor: Anchor, layer: string): boolean => {
  if (!anchor.layers) return true
  const copper = stackCopper(board)
  return anchor.layers.some((l) => {
    if (l === layer || l === '*.Cu') return true
    if (l === 'F&B.Cu') return layer === copper[0] || layer === copper[copper.length - 1]
    return false
  })
}

/** One net for everything a new copper item touches, or a conflict. */
const netFor = (
  board: KicadBoard,
  given: unknown,
  anchors: readonly Anchor[]
): { ok: true; number: number; name: string } | ItemFailure => {
  const named = anchors.filter((a) => a.net && a.net.number > 0)
  if (given !== undefined) {
    const net = resolveNet(board, given)
    if (!net.ok) return net
    const clash = named.find((a) => a.net!.number !== net.number)
    if (clash)
      return fail(
        'net-conflict',
        `${clash.id} is on ${clash.net!.name}, not ${net.name || 'no net'}: joining them would short two nets.`
      )
    return net
  }
  const first = named[0]
  const clash = named.find((a) => a.net!.number !== first?.net!.number)
  if (clash && first)
    return fail(
      'net-conflict',
      `${first.id} is on ${first.net!.name} and ${clash.id} on ${clash.net!.name}: a track between them would short two nets.`
    )
  if (first) return { ok: true, number: first.net!.number, name: first.net!.name }
  return fail(
    'invalid-record',
    'Name the net: no end is on a pad or via to take one from. Send "net": "" for copper on no net.'
  )
}

/** Add one item; a track of several points lands as one segment per run. */
export function createItem(
  board: KicadBoard,
  kind: BoardCreateKind,
  record: Rec,
  defaults: BoardEditDefaults
): CreateOutcome {
  const invalid = validate(kind, record, 'create')
  if (invalid) return invalid
  const root = board._raw as { children: SExprNode[] }
  const before = new Set(root.children)
  const outcome = createInto(board, kind, record, defaults)
  if (outcome) return outcome
  const added = root.children.filter((node) => !before.has(node))
  let next = remapKicadBoard(board)
  // What the kind's writer did not lay down goes on as an update writes it.
  const base = CREATE_BASE[kind]
  const extras = base
    ? Object.fromEntries(
        Object.entries(record).filter(
          ([key, value]) => !base.includes(key) || (key === 'size' && typeof value !== 'number')
        )
      )
    : {}
  if (Object.keys(extras).length) {
    const made = boardItems(next).find((item) => item.raw === added[0])
    const written = made ? writeRecord(next, made, extras) : null
    if (written && isFailure(written)) return written
    next = remapKicadBoard(next)
  }
  const byRaw = new Map(boardItems(next).map((item) => [item.raw, item.id]))
  return { ok: true, board: next, ids: added.map((node) => byRaw.get(node) ?? '').filter(Boolean) }
}

const createInto = (
  board: KicadBoard,
  kind: BoardCreateKind,
  record: Rec,
  defaults: BoardEditDefaults
): ItemFailure | null => {
  const layerOf = (
    copper: boolean,
    fallback?: string
  ): { ok: true; layer: string } | ItemFailure =>
    record.layer === undefined && fallback
      ? { ok: true, layer: fallback }
      : resolveLayer(board, record.layer, copper)
  const width = lengthOf(record, 'width')

  switch (kind) {
    case 'track': {
      const layer = layerOf(true)
      if (!layer.ok) return layer
      const raw = record.points
      if (!Array.isArray(raw))
        return fail(
          'invalid-record',
          'A new track needs points: its run, as {x, y} in millimeters or pad and via ids, e.g. ["U1.3", {"x": 10, "y": 20}, "C4.1"].'
        )
      const items = boardItems(board)
      const anchors: Anchor[] = []
      for (const [index, value] of raw.entries()) {
        const anchor = anchorOf(board, items, value, `points[${index}]`)
        if (isFailure(anchor)) return anchor
        if (!anchorOnLayer(board, anchor, layer.layer))
          return fail(
            'refused',
            `${anchor.id} has no copper on ${layer.layer}; route on its layer, or change layer through a via.`
          )
        anchors.push(anchor)
      }
      const net = netFor(board, record.net, anchors)
      if (!net.ok) return net
      const trackWidth = width ?? mmToNm(defaults.classOf(net.name).trackWidth)
      for (let i = 1; i < anchors.length; i += 1) {
        const start = anchors[i - 1].at
        const end = anchors[i].at
        if (start.x === end.x && start.y === end.y) continue
        addSegmentToBoardAST(board, {
          start,
          end,
          width: trackWidth,
          layer: layer.layer,
          net: net.number
        })
      }
      return null
    }
    case 'via': {
      if (record.at === undefined)
        return fail(
          'invalid-record',
          'at is where the via goes: a point {x, y} in mm, or a pad id.'
        )
      const anchor = anchorOf(board, boardItems(board), record.at, 'at')
      if (isFailure(anchor)) return anchor
      const net = netFor(board, record.net, [anchor])
      if (!net.ok) return net
      const cls = defaults.classOf(net.name)
      const size = lengthOf(record, 'size')
      const drill = lengthOf(record, 'drill')
      const span = viaSpanOf(board, record, 'through', [])
      if (isFailure(span)) return span
      // A microvia's size is its net class's microvia, as the router arms one.
      const micro = span.type === 'micro'
      const viaSize = size ?? mmToNm(micro ? cls.microviaDiameter : cls.viaDiameter)
      const viaDrill = drill ?? mmToNm(micro ? cls.microviaDrill : cls.viaDrill)
      if (viaDrill >= viaSize)
        return fail('invalid-record', 'A via drill must be smaller than its size.')
      addViaToBoardAST(board, {
        position: anchor.at,
        size: viaSize,
        drill: viaDrill,
        layers: span.layers,
        net: net.number,
        ...(span.type !== 'through' ? { type: span.type } : {})
      })
      return null
    }
    case 'zone': {
      const points = pointsOf(record, 'points')
      if (!points)
        return fail('invalid-record', 'points is the outline: at least three points {x, y} in mm.')
      if (record.layers === undefined)
        return fail(
          'invalid-record',
          'layers is required: the copper layers it pours on, e.g. ["F.Cu"].'
        )
      const layers = zoneLayersOf(board, record.layers)
      if (isFailure(layers)) return layers
      const keepout = record.keepout === true
      const pour = pourOnRuleArea(record, keepout)
      if (pour) return pour
      if (record.net === undefined && !keepout)
        return fail(
          'invalid-record',
          'net is required for a copper zone, e.g. "GND"; a rule area (keepout) takes none.'
        )
      const net =
        keepout && record.net === undefined
          ? { ok: true as const, number: 0, name: '' }
          : resolveNet(board, record.net)
      if (!net.ok) return net
      const rest: Rec = { ...record }
      delete rest.points
      delete rest.layers
      delete rest.net
      delete rest.keepout
      const update = zoneUpdateOf(board, null, rest)
      if (isFailure(update)) return update
      if (update.keepoutRules && !keepout)
        return fail('not-applicable', 'rules are for a rule area: send "keepout": true with them.')
      const index = addZoneToBoardAST(board, {
        points,
        layers,
        net: net.number,
        netName: net.name,
        keepout
      })
      if (Object.keys(update).length) {
        const zone = remapKicadBoard(board).zones[index]
        if (zone) updateBoardZoneInAST(zone, update, board)
      }
      return null
    }
    case 'text': {
      if (typeof record.text !== 'string')
        return fail('invalid-record', 'A new text needs text, the string to show.')
      const at = pointOf(record, 'at')
      if (!at)
        return fail('invalid-record', 'at is where the text is centered: a point {x, y} in mm.')
      const layer = layerOf(false)
      if (!layer.ok) return layer
      const style = graphicDefaults(layer.layer)
      addGrTextToBoardAST(board, {
        text: record.text,
        position: { ...at, ...(typeof record.angle === 'number' ? { angle: record.angle } : {}) },
        layer: layer.layer,
        size: typeof record.size === 'number' ? mmToNm(record.size) : style.textSize,
        thickness:
          typeof record.thickness === 'number' ? mmToNm(record.thickness) : style.textThickness
      })
      return null
    }
    case 'text_box': {
      if (typeof record.text !== 'string')
        return fail('invalid-record', 'A new text box needs text, the string to show.')
      const start = pointOf(record, 'start')
      const end = pointOf(record, 'end')
      if (!start || !end)
        return fail(
          'invalid-record',
          'start and end are the corners of the box: points {x, y} in mm.'
        )
      const layer = layerOf(false)
      if (!layer.ok) return layer
      const style = graphicDefaults(layer.layer)
      addGrTextBoxToBoardAST(board, {
        text: record.text,
        start,
        end,
        layer: layer.layer,
        size: typeof record.size === 'number' ? mmToNm(record.size) : style.textSize,
        thickness:
          typeof record.thickness === 'number' ? mmToNm(record.thickness) : style.textThickness,
        width: width ?? style.lineWidth,
        // Back-layer text reads mirrored, as the board editor's Text Box tool places it.
        mirror: layer.layer.startsWith('B.')
      })
      return null
    }
    case 'point': {
      const at = pointOf(record, 'at')
      const size = lengthOf(record, 'size')
      if (!at) return fail('invalid-record', 'at is where the point goes: {x, y} in mm.')
      const layer = layerOf(false)
      if (!layer.ok) return layer
      addPointToBoardAST(board, {
        position: at,
        size: size ?? DEFAULT_POINT_SIZE,
        layer: layer.layer
      })
      return null
    }
    default:
      return createGraphic(board, kind, record, width)
  }
}

const createGraphic = (
  board: KicadBoard,
  kind: GraphicKind,
  record: Rec,
  width: Nm | undefined
): ItemFailure | null => {
  const layer = resolveLayer(board, record.layer, false)
  if (!layer.ok) return layer
  const stroke = width ?? graphicDefaults(layer.layer).lineWidth
  const fill = fillOf(record)
  const points = pointsOf(record, 'points')
  const radius = kind === 'circle' ? lengthOf(record, 'radius') : undefined
  const given = {
    start: pointOf(record, 'start'),
    mid: pointOf(record, 'mid'),
    end: pointOf(record, 'end'),
    center: pointOf(record, 'center')
  }
  const required: Record<typeof kind, Array<keyof typeof given>> = {
    line: ['start', 'end'],
    arc: ['start', 'mid', 'end'],
    circle: ['center'],
    rect: ['start', 'end'],
    poly: [],
    bezier: []
  }
  const missing = required[kind].filter((key) => !given[key])
  if (missing.length)
    return fail(
      'invalid-record',
      `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} required: points {x, y} in mm.`
    )
  const at = (key: keyof typeof given): { x: Nm; y: Nm } => given[key] as { x: Nm; y: Nm }
  const style = { width: stroke, layer: layer.layer }
  switch (kind) {
    case 'line':
      addGrLineToBoardAST(board, { start: at('start'), end: at('end'), ...style })
      return null
    case 'arc':
      addGrArcToBoardAST(board, { start: at('start'), mid: at('mid'), end: at('end'), ...style })
      return null
    case 'circle': {
      if (radius === undefined) return fail('invalid-record', 'radius is required, in mm.')
      const center = at('center')
      addGrCircleToBoardAST(board, {
        center,
        end: { x: (center.x + radius) as Nm, y: center.y },
        ...style,
        ...(fill ? { fill } : {})
      })
      return null
    }
    case 'rect':
      addGrRectToBoardAST(board, {
        start: at('start'),
        end: at('end'),
        ...style,
        ...(fill ? { fill } : {})
      })
      return null
    case 'poly':
      if (!points)
        return fail('invalid-record', 'points is required: at least three points {x, y} in mm.')
      addGrPolyToBoardAST(board, { points, ...style, ...(fill ? { fill } : {}) })
      return null
    case 'bezier': {
      if (!points)
        return fail('invalid-record', 'points is required: exactly 4 points {x, y} in mm.')
      addGrCurveToBoardAST(board, { points, ...style })
      return null
    }
  }
}
