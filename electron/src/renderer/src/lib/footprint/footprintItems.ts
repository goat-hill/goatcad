/**
 * The items of one footprint as records an agent reads and writes: the
 * footprint itself, pads, graphics, texts, text boxes, tables, points,
 * properties, zones and the 3D model, in the footprint's own frame
 * (millimeters, y down).
 *
 * The flexibility a
 * generated footprint needs (a latch outline, a keep-out, a chamfered pad) is
 * this layer, never more arguments on the create call. Pure: every function
 * takes a parsed footprint and edits its AST through `kicad/footprint.ts`'s
 * helpers, so the caller decides whether the edit lands in a session or is
 * thrown away (a dry run, a failed batch).
 *
 * Ids follow `agent-api.md`: the node's uuid; `<kind>@x,y`
 * for a node the file gave none (`#2` onward when two share a point);
 * `property:<key>` for a property; `model` for the 3D model; `footprint` for
 * the footprint's own properties. A pad is also reachable as `pad:<number>`
 * when the number is unique.
 */
import {
  addFpArcToFootprintAST,
  addFpCircleToFootprintAST,
  addFpCurveToFootprintAST,
  addFpLineToFootprintAST,
  addFpPolyToFootprintAST,
  addFpPropertyToFootprintAST,
  addFpRectToFootprintAST,
  addFpTextBoxToFootprintAST,
  addFpTextToFootprintAST,
  addModelNode,
  addPadToFootprintAST,
  addPointToFootprintAST,
  DEFAULT_POINT_SIZE,
  expandFootprintText,
  findOrCreateChild,
  footprintTextScope,
  parseFootprintNode,
  removeModelNode,
  setFontEffectsChild,
  setScalarChild,
  setStrokeColorChild,
  setStrokeTypeChild,
  setXYChild,
  updateArcInAST,
  updateCircleInAST,
  updateCurveInAST,
  updateFootprintMetaInAST,
  updateLineInAST,
  updateModelInAST,
  updatePadInAST,
  updatePointInAST,
  updatePolyInAST,
  updatePropertyInAST,
  updateRectInAST,
  updateTableInAST,
  updateTextBoxInAST,
  updateTextInAST,
  makeAtom,
  type FootprintMetaPatch,
  type KicadFontEffects,
  type KicadFootprint,
  type KicadFpTextBox,
  type KicadPad,
  type KicadTable,
  type SExprList,
  type TablePatch,
  type SExprNode,
  isSolidFill
} from '../kicad/footprint'
import { findChild, getFirstAtomValue, markNodeDirty } from '../kicad/sexpr'
import { hexColorToRgba, rgbaToHexColor, type Rgba } from '../kicad/color'
import { formatNmAtom, mmToNm, nmToMm, type Nm } from '../kicad/coordinates'
import { measureTextWidth } from '../kicad/newstroke'
import { textBoxMargins } from '../board/extraGraphics'
import { DEFAULT_PAD_LAYERS, roundrectRatio, TEXT_SIZE, TEXT_THICKNESS } from './footprintStyle'
import { rotateLocal, shapeBox, unionBox, type Box, type Point } from './footprintGeometry'
import { arcPolyline, circlePolyline, padClearanceShape, positionalId } from './footprintShapes'
import { narrowingsOf, pageOf, tally, type Narrowing, type QueryPage } from '../queryPage'
import {
  buildZoneNode,
  footprintZonesOf,
  setBoardZoneOutlineInAST,
  updateBoardZoneInAST,
  type ZonePadConnection,
  type ZoneUpdate
} from '../kicad/board'
import { islandsUpdate, mm, zoneRecordFields, zoneRowFields } from '../board/zoneRecord'
import {
  ATTRIBUTE_FLAGS,
  FOOTPRINT_ITEM_KINDS,
  FOOTPRINT_READ_ONLY_KEYS,
  KEY_GROUPS,
  ZONE_CONNECT,
  type FootprintItemKind,
  type RecordMode
} from '../../../../shared/itemRecords'
import { checkRecord, isObject, isPcbFillOn } from '../../../../shared/recordRules'

export { FOOTPRINT_ITEM_KINDS, type FootprintItemKind }

/** The kinds the item ops create: the footprint itself is always there, and a table is the editor's. */
type CreatableKind = Exclude<FootprintItemKind, 'footprint' | 'table'>

export interface MmBox {
  x: number
  y: number
  width: number
  height: number
}

export interface FootprintItem {
  id: string
  kind: FootprintItemKind
  /** The AST node the item is; the footprint's own for `footprint`. */
  node: SExprNode
  record: Record<string, unknown>
  box: Box | null
}

export type ItemFailure = {
  ok: false
  error: 'item-not-found' | 'not-applicable' | 'invalid-record' | 'refused'
  detail: string
  candidates?: string[]
}

const fail = (error: ItemFailure['error'], detail: string): ItemFailure => ({
  ok: false,
  error,
  detail
})

const mmXY = (p: Point): { x: number; y: number } => ({ x: mm(p.x), y: mm(p.y) })
const toNm = (value: number): Nm => mmToNm(value)
const nmXY = (p: { x: number; y: number }): { x: Nm; y: Nm } => ({
  x: toNm(p.x),
  y: toNm(p.y)
})

export const mmBox = (box: Box): MmBox => ({
  x: mm(box.minX),
  y: mm(box.minY),
  width: mm(box.maxX - box.minX),
  height: mm(box.maxY - box.minY)
})

const pathBox = (points: Point[], width: number): Box => ({
  minX: Math.min(...points.map((p) => p.x)) - width / 2,
  minY: Math.min(...points.map((p) => p.y)) - width / 2,
  maxX: Math.max(...points.map((p) => p.x)) + width / 2,
  maxY: Math.max(...points.map((p) => p.y)) + width / 2
})

/** A centered text's box, turned by its angle. */
const textBox = (
  text: string,
  at: { x: number; y: number; angle?: number },
  effects: KicadFontEffects | undefined
): Box => {
  const height = effects?.height ?? TEXT_SIZE
  const width = effects?.width ?? height
  const thickness = effects?.thickness ?? TEXT_THICKNESS
  const lines = text.split('\n')
  const advance =
    measureTextWidth(text, {
      width: nmToMm(width as Nm),
      height: nmToMm(height as Nm),
      thickness: nmToMm(thickness as Nm)
    }) * 1e6
  const halfW = advance / 2
  const halfH = (height * lines.length) / 2
  const corners = [
    rotateLocal(-halfW, -halfH, at.angle ?? 0),
    rotateLocal(halfW, -halfH, at.angle ?? 0),
    rotateLocal(halfW, halfH, at.angle ?? 0),
    rotateLocal(-halfW, halfH, at.angle ?? 0)
  ].map((p) => ({ x: at.x + p.x, y: at.y + p.y }))
  return pathBox(corners, 0)
}

// --- Colors and strokes --------------------------------------------------------

/** A stroke's style and color, each only when the file sets one. */
export const strokeRecord = (item: {
  strokeType?: string
  strokeColor?: Rgba
}): Record<string, unknown> => {
  const strokeColor = rgbaToHexColor(item.strokeColor)
  return {
    ...(item.strokeType && item.strokeType !== 'default' ? { strokeType: item.strokeType } : {}),
    ...(strokeColor ? { strokeColor } : {})
  }
}

export const writeStroke = (node: SExprNode, r: Record<string, unknown>): void => {
  const raw = node as SExprList
  if (r.strokeType === undefined && r.strokeColor === undefined) return
  markNodeDirty(raw)
  if (r.strokeType !== undefined) setStrokeTypeChild(raw, r.strokeType as string)
  if (r.strokeColor !== undefined)
    setStrokeColorChild(raw, hexColorToRgba(r.strokeColor as string | null))
}

// --- Text ------------------------------------------------------------------------

/** A text's font as a record: size a number when square, `{width, height}` when not. */
export const fontRecord = (effects: KicadFontEffects | undefined): Record<string, unknown> => {
  const height = effects?.height ?? TEXT_SIZE
  const width = effects?.width ?? height
  return {
    size: width === height ? mm(height) : { width: mm(width), height: mm(height) },
    thickness: mm(effects?.thickness ?? TEXT_THICKNESS),
    ...(effects?.bold ? { bold: true } : {}),
    ...(effects?.italic ? { italic: true } : {}),
    ...(effects?.hAlign ? { justify: effects.hAlign } : {}),
    ...(effects?.vAlign ? { verticalJustify: effects.vAlign } : {}),
    ...(effects?.mirror ? { mirror: true } : {})
  }
}

/** A text's knockout and keep-upright switches, each only when it is not KiCad's default. */
const switchesRecord = (text: {
  knockout: boolean
  keepUpright: boolean
}): Record<string, unknown> => ({
  ...(text.knockout ? { knockout: true } : {}),
  ...(text.keepUpright ? {} : { keepUpright: false })
})

const FONT_KEYS = ['size', 'thickness', 'bold', 'italic', 'justify', 'verticalJustify', 'mirror']

/** The font a record asks for, merged over the text's own; undefined when it asks nothing. */
export const fontEffects = (
  existing: KicadFontEffects | undefined,
  r: Record<string, unknown>
): KicadFontEffects | undefined => {
  if (!FONT_KEYS.some((key) => r[key] !== undefined)) return undefined
  const next: KicadFontEffects = {
    ...(existing ?? { width: TEXT_SIZE, height: TEXT_SIZE, thickness: TEXT_THICKNESS })
  }
  const size = r.size
  if (typeof size === 'number') next.width = next.height = toNm(size)
  else if (isObject(size)) {
    next.width = toNm(size.width as number)
    next.height = toNm(size.height as number)
  }
  if (r.thickness !== undefined) next.thickness = toNm(r.thickness as number)
  if (r.bold !== undefined) next.bold = r.bold as boolean
  if (r.italic !== undefined) next.italic = r.italic as boolean
  if (r.mirror !== undefined) next.mirror = r.mirror as boolean
  if (r.justify !== undefined)
    next.hAlign = r.justify === 'center' ? undefined : (r.justify as 'left' | 'right')
  if (r.verticalJustify !== undefined)
    next.vAlign =
      r.verticalJustify === 'center' ? undefined : (r.verticalJustify as 'top' | 'bottom')
  return next
}

const atRecord = (
  at: { x: number; y: number; angle?: number } | undefined
): {
  at: { x: number; y: number }
  angle: number
} => ({ at: at ? mmXY(at) : { x: 0, y: 0 }, angle: at?.angle ?? 0 })

const numberChild = (node: SExprList, token: string): number | undefined => {
  const child = findChild(node, token)
  const value = child ? getFirstAtomValue(child) : undefined
  return value === undefined ? undefined : Number(value)
}

/** A length that inherits while absent: null then. */
const mmOrNull = (value: Nm | undefined): number | null => (value === undefined ? null : mm(value))

export const padRecord = (pad: KicadPad): Record<string, unknown> => {
  const raw = pad._raw as SExprList
  const bridge = numberChild(raw, 'thermal_bridge_width')
  const gap = numberChild(raw, 'thermal_gap')
  const connect = numberChild(raw, 'zone_connect')
  return {
    number: pad.number,
    type: pad.type,
    shape: pad.shape,
    at: mmXY(pad.position),
    ...(pad.position.angle ? { angle: pad.position.angle } : {}),
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
    ...(pad.roundrectRatio !== undefined ? { roundrectRatio: pad.roundrectRatio } : {}),
    ...(pad.chamferRatio !== undefined || pad.chamfer?.length
      ? { chamfer: { ratio: pad.chamferRatio ?? 0, corners: pad.chamfer ?? [] } }
      : {}),
    ...(pad.rectDelta ? { rectDelta: mmXY(pad.rectDelta) } : {}),
    ...(bridge !== undefined || gap !== undefined || connect !== undefined
      ? {
          thermal: {
            ...(bridge !== undefined ? { bridgeWidth: bridge } : {}),
            ...(gap !== undefined ? { gap } : {}),
            ...(connect !== undefined ? { zoneConnect: ZONE_CONNECT[connect] ?? connect } : {})
          }
        }
      : {}),
    ...(pad.clearance !== undefined ? { clearance: mm(pad.clearance) } : {}),
    ...(pad.solderMaskMargin !== undefined ? { solderMaskMargin: mm(pad.solderMaskMargin) } : {}),
    ...(pad.solderPasteMargin !== undefined
      ? { solderPasteMargin: mm(pad.solderPasteMargin) }
      : {}),
    ...(pad.solderPasteMarginRatio !== undefined ? { pasteRatio: pad.solderPasteMarginRatio } : {})
  }
}

// --- The footprint's own record ------------------------------------------------------

const BRIDGES = 'allow_soldermask_bridges'

/** What Footprint Properties shows: name, text, lock, attributes and the local overrides. */
export const footprintRecord = (fp: KicadFootprint): Record<string, unknown> => ({
  name: fp.name,
  description: fp.description ?? '',
  keywords: fp.tags ?? '',
  locked: fp.locked,
  attributes: {
    type: fp.attributes.includes('smd')
      ? 'smd'
      : fp.attributes.includes('through_hole')
        ? 'through_hole'
        : 'unspecified',
    ...Object.fromEntries(
      ATTRIBUTE_FLAGS.map(([key, token]) => [key, fp.attributes.includes(token)])
    )
  },
  overrides: {
    clearance: mmOrNull(fp.clearance),
    solderMaskMargin: mmOrNull(fp.solderMaskMargin),
    solderPasteMargin: mmOrNull(fp.solderPasteMargin),
    solderPasteRatio: fp.solderPasteMarginRatio ?? null,
    zoneConnect: fp.zoneConnect === undefined ? null : (ZONE_CONNECT[fp.zoneConnect] ?? null),
    allowSolderMaskBridges: fp.attributes.includes(BRIDGES)
  }
})

// --- Reading -------------------------------------------------------------------------

export const cellsBox = (table: KicadTable): Box | null => {
  const corners = table.cells.flatMap((cell) => [
    ...(cell.start ? [cell.start] : []),
    ...(cell.end ? [cell.end] : []),
    ...(cell.points ?? [])
  ])
  return corners.length ? pathBox(corners, 0) : null
}

export const textBoxCorners = (box: KicadFpTextBox): Point[] =>
  box.points?.length ? box.points : box.start && box.end ? [box.start, box.end] : []

/** A text box as an agent reads it, in a footprint or on a board. */
export const textBoxRecord = (box: KicadFpTextBox): Record<string, unknown> => {
  const corners = textBoxCorners(box)
  return {
    text: box.text,
    ...(box.points?.length
      ? { points: box.points.map(mmXY) }
      : { start: mmXY(corners[0]), end: mmXY(corners[1]) }),
    ...(box.angle ? { angle: box.angle } : {}),
    layer: box.layer,
    ...fontRecord(box.fontEffects),
    ...(box.knockout ? { knockout: true } : {}),
    border: box.border,
    width: mm(box.strokeWidth ?? 0),
    ...strokeRecord(box),
    ...(box.margins
      ? {
          margins: {
            left: mm(box.margins.left),
            top: mm(box.margins.top),
            right: mm(box.margins.right),
            bottom: mm(box.margins.bottom)
          }
        }
      : {})
  }
}

/** A table as an agent reads it, in a footprint or on a board. */
export const tableRecord = (table: KicadTable): Record<string, unknown> => ({
  layer: table.layer,
  columns: table.columnCount,
  rows: table.rowHeights.length,
  columnWidths: table.columnWidths.map(mm),
  rowHeights: table.rowHeights.map(mm),
  cells: table.cells.map((cell) => cell.text),
  borderExternal: table.borderExternal,
  borderHeader: table.borderHeader,
  borderWidth: mm(table.borderStrokeWidth ?? 0),
  separatorRows: table.separatorRows,
  separatorCols: table.separatorCols,
  separatorWidth: mm(table.separatorStrokeWidth ?? 0)
})

/** Every item of a footprint, with its id, record and box. */
export const footprintItems = (fp: KicadFootprint): FootprintItem[] => {
  const out: FootprintItem[] = [
    { id: 'footprint', kind: 'footprint', node: fp._raw, record: footprintRecord(fp), box: null }
  ]
  const numbers = new Map<string, number>()
  for (const pad of fp.pads) numbers.set(pad.number, (numbers.get(pad.number) ?? 0) + 1)
  const positional = new Map<string, number>()
  const idFor = (kind: string, uuid: string | undefined, at: Point): string => {
    if (uuid) return uuid
    const base = positionalId(kind, at)
    const seen = (positional.get(base) ?? 0) + 1
    positional.set(base, seen)
    return seen === 1 ? base : `${base}#${seen}`
  }

  for (const pad of fp.pads) {
    const unique = numbers.get(pad.number) === 1 && pad.number !== ''
    out.push({
      id: pad.uuid ?? (unique ? `pad:${pad.number}` : idFor('pad', undefined, pad.position)),
      kind: 'pad',
      node: pad._raw,
      record: padRecord(pad),
      box: shapeBox(padClearanceShape(pad))
    })
  }
  for (const line of fp.fpLines) {
    const width = line.strokeWidth ?? 0
    out.push({
      id: idFor('line', line.uuid, line.start),
      kind: 'line',
      node: line._raw,
      record: {
        layer: line.layer,
        width: mm(width),
        start: mmXY(line.start),
        end: mmXY(line.end),
        ...strokeRecord(line)
      },
      box: pathBox([line.start, line.end], width)
    })
  }
  for (const arc of fp.fpArcs) {
    const width = arc.strokeWidth ?? 0
    out.push({
      id: idFor('arc', arc.uuid, arc.start),
      kind: 'arc',
      node: arc._raw,
      record: {
        layer: arc.layer,
        width: mm(width),
        start: mmXY(arc.start),
        mid: mmXY(arc.mid),
        end: mmXY(arc.end),
        ...strokeRecord(arc)
      },
      box: pathBox(arcPolyline(arc.start, arc.mid, arc.end), width)
    })
  }
  for (const circle of fp.fpCircles) {
    const width = circle.strokeWidth ?? 0
    const radius = Math.hypot(circle.end.x - circle.center.x, circle.end.y - circle.center.y)
    out.push({
      id: idFor('circle', circle.uuid, circle.center),
      kind: 'circle',
      node: circle._raw,
      record: {
        layer: circle.layer,
        width: mm(width),
        center: mmXY(circle.center),
        end: mmXY(circle.end),
        fill: isSolidFill(circle.fill) ? 'solid' : 'none',
        ...strokeRecord(circle)
      },
      box: pathBox(circlePolyline(circle.center, radius, 4), width)
    })
  }
  for (const rect of fp.fpRects) {
    const width = rect.strokeWidth ?? 0
    out.push({
      id: idFor('rect', rect.uuid, rect.start),
      kind: 'rect',
      node: rect._raw,
      record: {
        layer: rect.layer,
        width: mm(width),
        start: mmXY(rect.start),
        end: mmXY(rect.end),
        ...(rect.radius ? { radius: mm(rect.radius) } : {}),
        fill: isSolidFill(rect.fill) ? 'solid' : 'none',
        ...strokeRecord(rect)
      },
      box: pathBox([rect.start, rect.end], width)
    })
  }
  for (const poly of fp.fpPolys) {
    if (!poly.points.length) continue
    const width = poly.strokeWidth ?? 0
    out.push({
      id: idFor('poly', poly.uuid, poly.points[0]),
      kind: 'poly',
      node: poly._raw,
      record: {
        layer: poly.layer,
        width: mm(width),
        points: poly.points.map(mmXY),
        fill: isSolidFill(poly.fill) ? 'solid' : 'none',
        ...strokeRecord(poly)
      },
      box: pathBox(poly.points, width)
    })
  }
  for (const curve of fp.fpCurves) {
    if (!curve.points.length) continue
    const width = curve.strokeWidth ?? 0
    out.push({
      id: idFor('bezier', curve.uuid, curve.points[0]),
      kind: 'bezier',
      node: curve._raw,
      record: {
        layer: curve.layer,
        width: mm(width),
        points: curve.points.map(mmXY),
        ...strokeRecord(curve)
      },
      // The control points hull the curve, so their box holds it.
      box: pathBox(curve.points, width)
    })
  }
  // Rule areas and copper zones, in the board zone's record shape plus what the
  // footprint editor edits on every zone: its minimum width and outline hatch.
  for (const zone of footprintZonesOf(fp)) {
    if (!zone.points.length) continue
    const { net, ...row } = zoneRowFields(zone, zone.netName ?? '')
    out.push({
      id: idFor('zone', zone.uuid, zone.points[0]),
      kind: 'zone',
      node: zone._raw,
      record: {
        ...(net ? { net } : {}),
        ...row,
        ...zoneRecordFields(zone),
        ...(zone.isKeepout && zone.minThickness !== undefined
          ? { minThickness: mm(zone.minThickness) }
          : {}),
        ...(zone.hatchStyle ? { hatchStyle: zone.hatchStyle } : {}),
        ...(zone.hatchPitch !== undefined ? { hatchPitch: mm(zone.hatchPitch) } : {})
      },
      box: pathBox(zone.points, 0)
    })
  }
  const scope = footprintTextScope(fp)
  for (const text of fp.fpTexts) {
    const at = text.position ?? { x: 0, y: 0 }
    out.push({
      id:
        text.uuid ??
        (text.type === 'user'
          ? idFor('text', undefined, at)
          : `property:${text.type === 'reference' ? 'Reference' : 'Value'}`),
      kind: text.type === 'user' ? 'text' : 'property',
      node: text._raw,
      record: {
        ...(text.type === 'user'
          ? { text: text.text }
          : { key: text.type === 'reference' ? 'Reference' : 'Value', value: text.text }),
        ...atRecord(text.position),
        layer: text.layer,
        ...fontRecord(text.fontEffects),
        ...switchesRecord(text),
        hidden: text.hide === true
      },
      box: text.hide ? null : textBox(expandFootprintText(text.text, scope), at, text.fontEffects)
    })
  }
  for (const box of fp.fpTextBoxes) {
    const corners = textBoxCorners(box)
    if (!corners.length) continue
    out.push({
      id: idFor('text_box', box.uuid, corners[0]),
      kind: 'text_box',
      node: box._raw,
      record: textBoxRecord(box),
      box: pathBox(corners, 0)
    })
  }
  for (const table of fp.tables) {
    const box = cellsBox(table)
    out.push({
      id: idFor('table', table.uuid, box ? { x: box.minX, y: box.minY } : { x: 0, y: 0 }),
      kind: 'table',
      node: table._raw,
      record: tableRecord(table),
      box
    })
  }
  for (const point of fp.points) {
    const half = point.size / 2
    out.push({
      id: idFor('point', point.uuid, point.position),
      kind: 'point',
      node: point._raw,
      record: { at: mmXY(point.position), size: mm(point.size), layer: point.layer },
      box: {
        minX: point.position.x - half,
        minY: point.position.y - half,
        maxX: point.position.x + half,
        maxY: point.position.y + half
      }
    })
  }
  for (const property of fp.properties) {
    const at = property.position ?? { x: 0, y: 0 }
    out.push({
      id: `property:${property.key}`,
      kind: 'property',
      node: property._raw,
      record: {
        key: property.key,
        value: property.value,
        ...atRecord(property.position),
        layer: property.layer,
        ...fontRecord(property.fontEffects),
        ...switchesRecord(property),
        hidden: property.hide === true
      },
      box:
        property.hide || !property.value
          ? null
          : textBox(expandFootprintText(property.value, scope), at, property.fontEffects)
    })
  }
  if (fp.model) {
    out.push({
      id: 'model',
      kind: 'model',
      node: fp.model._raw,
      record: {
        path: fp.model.path,
        offset: fp.model.offset
          ? { x: mm(fp.model.offset.x), y: mm(fp.model.offset.y), z: mm(fp.model.offset.z) }
          : { x: 0, y: 0, z: 0 },
        scale: fp.model.scale ?? { x: 1, y: 1, z: 1 },
        rotate: fp.model.rotate ?? { x: 0, y: 0, z: 0 }
      },
      box: null
    })
  }
  return out
}

/** An item as an agent reads it. */
export const itemRow = (item: FootprintItem): Record<string, unknown> => ({
  id: item.id,
  kind: item.kind,
  ...item.record,
  ...(item.box ? { box: mmBox(item.box) } : {})
})

const nearIds = (wanted: string, ids: string[]): string[] => {
  const needle = wanted.toLowerCase()
  const scored = ids
    .map((id) => {
      const lower = id.toLowerCase()
      const score = lower === needle ? 0 : lower.includes(needle) || needle.includes(lower) ? 1 : 2
      return { id, score }
    })
    .filter((entry) => entry.score < 2)
  const pool = scored.length ? scored.map((entry) => entry.id) : ids
  return pool.slice(0, 8)
}

/** Look an id up, accepting `pad:<number>` for a pad with a uuid. */
export const resolveItem = (
  items: FootprintItem[],
  id: string
): { ok: true; item: FootprintItem } | ItemFailure => {
  const exact = items.find((item) => item.id === id)
  if (exact) return { ok: true, item: exact }
  const padNumber = /^pad:(.*)$/.exec(id)?.[1]
  if (padNumber !== undefined) {
    const pads = items.filter((item) => item.kind === 'pad' && item.record.number === padNumber)
    if (pads.length === 1) return { ok: true, item: pads[0] }
    if (pads.length > 1) {
      return {
        ok: false,
        error: 'item-not-found',
        detail: `${pads.length} pads are numbered ${padNumber}; address one by its id.`,
        candidates: pads.map((pad) => pad.id)
      }
    }
  }
  return {
    ok: false,
    error: 'item-not-found',
    detail: `No item on this footprint has the id "${id}".`,
    candidates: nearIds(
      id,
      items.map((item) => item.id)
    )
  }
}

// --- Locate -------------------------------------------------------------------

/** The editor's selection type per item kind, and the list its `index` counts in. */
const SELECTION_LISTS: Partial<
  Record<FootprintItemKind, [string, (fp: KicadFootprint) => Array<{ _raw: unknown }>]>
> = {
  pad: ['pad', (fp) => fp.pads],
  line: ['line', (fp) => fp.fpLines],
  arc: ['arc', (fp) => fp.fpArcs],
  circle: ['circle', (fp) => fp.fpCircles],
  rect: ['rect', (fp) => fp.fpRects],
  poly: ['poly', (fp) => fp.fpPolys],
  bezier: ['curve', (fp) => fp.fpCurves],
  text: ['text', (fp) => fp.fpTexts],
  text_box: ['textbox', (fp) => fp.fpTextBoxes],
  table: ['table', (fp) => fp.tables],
  point: ['point', (fp) => fp.points],
  property: ['property', (fp) => fp.properties],
  zone: ['zone', (fp) => fp.zones]
}

/** Items by id as the editor selects them, and the box that frames them all. */
export const locateItems = (
  fp: KicadFootprint,
  ids: string[]
): { selection: Array<{ type: string; index: number }>; box: Box | null } => {
  const items = footprintItems(fp)
  const selection: Array<{ type: string; index: number }> = []
  let box: Box | null = null
  for (const id of ids) {
    const resolved = resolveItem(items, id)
    if (!resolved.ok) continue
    const { item } = resolved
    // A v6 file's Reference and Value are fp_text rows, selected as texts.
    const v6Field = item.kind === 'property' && !fp.properties.some((p) => p._raw === item.node)
    const [selected, entries] = SELECTION_LISTS[v6Field ? 'text' : item.kind] ?? []
    const index = entries?.(fp).findIndex((entry) => entry._raw === item.node)
    if (selected && index !== undefined && index >= 0) selection.push({ type: selected, index })
    if (item.box) box = unionBox(box, item.box)
  }
  return { selection, box }
}

// --- Queries ------------------------------------------------------------------

export interface FootprintQuery {
  kind?: FootprintItemKind
  layer?: string
  number?: string
  box?: MmBox
  near?: { x: number; y: number }
  radius?: number
  limit?: number
  /** Matches to skip before the first row. */
  offset?: number
}

const touches = (a: Box, b: Box): boolean =>
  a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY

const layersOf = (item: FootprintItem): string[] =>
  item.kind === 'pad' || item.kind === 'zone'
    ? (item.record.layers as string[])
    : typeof item.record.layer === 'string'
      ? [item.record.layer]
      : []

const layerMatches = (layers: string[], wanted: string): boolean =>
  layers.some(
    (layer) =>
      layer === wanted ||
      (layer.startsWith('*.') && wanted.endsWith(layer.slice(1))) ||
      (layer.startsWith('F&B.') && wanted.endsWith(layer.slice(3)))
  )

export const queryItems = (
  items: FootprintItem[],
  query: FootprintQuery
): QueryPage<FootprintItem> & { matches: FootprintItem[] } => {
  const region = query.box
    ? {
        minX: toNm(query.box.x),
        minY: toNm(query.box.y),
        maxX: toNm(query.box.x + query.box.width),
        maxY: toNm(query.box.y + query.box.height)
      }
    : null
  const radius = toNm(query.radius ?? 1)
  const around = query.near
    ? {
        minX: toNm(query.near.x) - radius,
        minY: toNm(query.near.y) - radius,
        maxX: toNm(query.near.x) + radius,
        maxY: toNm(query.near.y) + radius
      }
    : null
  const matched = items.filter(
    (item) =>
      (!query.kind || item.kind === query.kind) &&
      (!query.layer || layerMatches(layersOf(item), query.layer)) &&
      (query.number === undefined ||
        (item.kind === 'pad' && item.record.number === query.number)) &&
      (!region || (item.box !== null && touches(item.box, region))) &&
      (!around || (item.box !== null && touches(item.box, around)))
  )
  return { ...pageOf(matched, query.offset, query.limit), matches: matched }
}

/** The breakdowns a capped footprint query names: by kind, then by layer. */
export const footprintNarrowings = (
  matches: readonly FootprintItem[],
  query: FootprintQuery
): Narrowing[] =>
  narrowingsOf(matches, query.kind !== undefined, [
    { arg: 'layer', given: query.layer !== undefined, tally: (items) => tally(items, layersOf) }
  ])

// --- Record validation ------------------------------------------------------------

/** What to do instead of writing a key the record only reads (`FOOTPRINT_READ_ONLY_KEYS`). */
const READ_ONLY_INSTEAD: Partial<Record<FootprintItemKind, string>> = {
  property: 'delete it and create another',
  text_box: 'turn it in the footprint editor',
  table: 'edit its cells in the footprint editor',
  zone: "draw cutouts in the footprint editor; a footprint's zone takes no net, and its fill is the board's"
}

/** A record held to what its kind takes and to each key's rule (`shared/recordRules.ts`). */
const validate = (
  kind: FootprintItemKind,
  record: Record<string, unknown>,
  mode: RecordMode
): ItemFailure | null => {
  const failure = checkRecord('footprint', kind, record, mode)
  return failure ? fail(failure.error as ItemFailure['error'], failure.detail) : null
}

// --- Writes ---------------------------------------------------------------------

const setLayersChild = (node: SExprList, layers: string[]): void => {
  const child = findOrCreateChild(node, 'layers')
  const at = child.start
  child.children = [
    makeAtom('layers', false, at),
    ...layers.map((layer) => makeAtom(layer, true, at))
  ]
}

const setAtomListChild = (node: SExprList, token: string, values: string[]): void => {
  const child = findOrCreateChild(node, token)
  const at = child.start
  child.children = [
    makeAtom(token, false, at),
    ...values.map((value) => makeAtom(value, false, at))
  ]
}

/** `fill` in the file's own dialect: KiCad 10 writes yes/no, KiCad 8 solid/none. */
const setFill = (node: SExprList, fill: boolean): void => {
  const current = findChild(node, 'fill')
  const value = current ? getFirstAtomValue(current) : undefined
  const modern = value === 'yes' || value === 'no'
  setScalarChild(node, 'fill', fill ? (modern ? 'yes' : 'solid') : modern ? 'no' : 'none')
}

/** A length override as the AST writers take it: integer nm, or null to remove the row. */
const nmOrNull = (value: unknown): Nm | null | undefined =>
  value === undefined ? undefined : value === null ? null : toNm(value as number)

const updatePad = (pad: KicadPad, r: Record<string, unknown>): void => {
  const raw = pad._raw as SExprList
  markNodeDirty(raw)
  const size = r.size as { width: number; height: number } | undefined
  const drill = r.drill as
    | {
        diameter: number
        oval?: { width: number; height: number }
        offset?: { x: number; y: number }
      }
    | undefined
  const overrides = {
    clearance: nmOrNull(r.clearance),
    solderMaskMargin: nmOrNull(r.solderMaskMargin),
    solderPasteMargin: nmOrNull(r.solderPasteMargin),
    solderPasteMarginRatio: r.pasteRatio as number | null | undefined
  }
  updatePadInAST(pad, {
    ...(r.number !== undefined ? { number: r.number as string } : {}),
    ...(r.type !== undefined ? { type: r.type as KicadPad['type'] } : {}),
    ...(r.shape !== undefined ? { shape: r.shape as KicadPad['shape'] } : {}),
    ...(r.at !== undefined || r.angle !== undefined
      ? {
          position: {
            ...(r.at ? nmXY(r.at as Point) : { x: pad.position.x, y: pad.position.y }),
            angle: r.angle !== undefined ? (r.angle as number) || undefined : pad.position.angle
          }
        }
      : {}),
    ...(size ? { size: { w: toNm(size.width), h: toNm(size.height) } } : {}),
    ...(r.roundrectRatio !== undefined ? { roundrectRatio: r.roundrectRatio as number } : {}),
    ...Object.fromEntries(Object.entries(overrides).filter(([, value]) => value !== undefined))
  })
  if (drill) {
    // Replaced whole, so a slot can become a round hole again.
    pad.drill = undefined
    updatePadInAST(pad, {
      drill: {
        diameter: toNm(drill.diameter),
        ...(drill.oval
          ? { oval: { width: toNm(drill.oval.width), height: toNm(drill.oval.height) } }
          : {}),
        ...(drill.offset ? { offset: nmXY(drill.offset) } : {})
      }
    })
  }
  if (r.layers) setLayersChild(raw, r.layers as string[])
  // A pad turned roundrect gets the library's radius unless one was given.
  if (
    r.shape === 'roundrect' &&
    r.roundrectRatio === undefined &&
    pad.roundrectRatio === undefined
  ) {
    updatePadInAST(pad, { roundrectRatio: roundrectRatio(pad.size.w, pad.size.h) })
  }
  const chamfer = r.chamfer as { ratio: number; corners: string[] } | undefined
  if (chamfer) {
    setScalarChild(raw, 'chamfer_ratio', String(chamfer.ratio))
    if (chamfer.corners.length) setAtomListChild(raw, 'chamfer', chamfer.corners)
    else raw.children = raw.children.filter((child) => child !== findChild(raw, 'chamfer'))
  }
  const delta = r.rectDelta as Point | undefined
  if (delta) {
    pad.rectDelta = nmXY(delta)
    setXYChild(raw, 'rect_delta', pad.rectDelta.x, pad.rectDelta.y)
  }
  const thermal = r.thermal as
    { bridgeWidth?: number; gap?: number; zoneConnect?: (typeof ZONE_CONNECT)[number] } | undefined
  if (thermal?.bridgeWidth !== undefined)
    setScalarChild(raw, 'thermal_bridge_width', formatNmAtom(toNm(thermal.bridgeWidth)))
  if (thermal?.gap !== undefined)
    setScalarChild(raw, 'thermal_gap', formatNmAtom(toNm(thermal.gap)))
  if (thermal?.zoneConnect !== undefined)
    setScalarChild(raw, 'zone_connect', String(ZONE_CONNECT.indexOf(thermal.zoneConnect)))
}

/** Footprint Properties: name, text, lock, attributes and overrides. */
const updateFootprint = (fp: KicadFootprint, r: Record<string, unknown>): ItemFailure | null => {
  const attributes = r.attributes as Record<string, unknown> | undefined
  const overrides = r.overrides as Record<string, unknown> | undefined
  const patch: FootprintMetaPatch = {
    ...(r.name !== undefined ? { name: (r.name as string).trim() } : {}),
    ...(r.description !== undefined ? { description: r.description as string } : {}),
    ...(r.keywords !== undefined ? { tags: r.keywords as string } : {}),
    ...(r.locked !== undefined ? { locked: r.locked as boolean } : {})
  }
  let attrs = [...fp.attributes]
  const toggle = (token: string, on: boolean): void => {
    attrs = on ? [...new Set([...attrs, token])] : attrs.filter((attr) => attr !== token)
  }
  if (attributes?.type !== undefined) {
    attrs = attrs.filter((attr) => attr !== 'smd' && attr !== 'through_hole')
    if (attributes.type !== 'unspecified') attrs.unshift(attributes.type as string)
  }
  for (const [key, token] of ATTRIBUTE_FLAGS) {
    if (attributes?.[key] !== undefined) toggle(token, attributes[key] as boolean)
  }
  if (overrides) {
    if (overrides.allowSolderMaskBridges !== undefined)
      toggle(BRIDGES, overrides.allowSolderMaskBridges as boolean)
    const clearance = nmOrNull(overrides.clearance)
    const mask = nmOrNull(overrides.solderMaskMargin)
    const paste = nmOrNull(overrides.solderPasteMargin)
    if (clearance !== undefined) patch.clearance = clearance
    if (mask !== undefined) patch.solderMaskMargin = mask
    if (paste !== undefined) patch.solderPasteMargin = paste
    if (overrides.solderPasteRatio !== undefined)
      patch.solderPasteMarginRatio = overrides.solderPasteRatio as number | null
    if (overrides.zoneConnect !== undefined)
      patch.zoneConnect =
        overrides.zoneConnect === null
          ? null
          : ZONE_CONNECT.indexOf(overrides.zoneConnect as (typeof ZONE_CONNECT)[number])
  }
  if (attrs.join(' ') !== fp.attributes.join(' ')) patch.attributes = attrs
  updateFootprintMetaInAST(fp, patch)
  return null
}

/** A footprint zone, written as the board writes its own. It carries no net. */
const updateZone = (
  fp: KicadFootprint,
  node: SExprNode,
  r: Record<string, unknown>
): ItemFailure | null => {
  const zone = footprintZonesOf(fp).find((candidate) => candidate._raw === node)
  if (!zone) return null
  const keepout = (r.keepout as boolean | undefined) ?? zone.isKeepout
  if (r.rules !== undefined && !keepout)
    return fail('not-applicable', 'rules are for a rule area: send "keepout": true with them.')
  const pour = KEY_GROUPS.pour.filter((key) => key !== 'minThickness' && r[key] !== undefined)
  if (keepout && pour.length)
    return fail(
      'not-applicable',
      `A rule area does not pour, so it does not carry ${pour.join(', ')}; it takes rules.`
    )
  const below = r.islands ?? (zone.islandRemovalMode === 2 ? 'below_area' : undefined)
  if (r.minIslandArea !== undefined && below !== 'below_area')
    return fail(
      'not-applicable',
      'minIslandArea is the smallest island kept: send it with islands "below_area".'
    )
  const length = (key: string): Nm | undefined =>
    r[key] === undefined ? undefined : toNm(r[key] as number)
  const update: ZoneUpdate = {
    ...(r.layers !== undefined ? { layers: r.layers as string[] } : {}),
    ...(r.name !== undefined ? { name: r.name as string } : {}),
    ...(r.priority !== undefined ? { priority: (r.priority as number) || null } : {}),
    ...(r.keepout !== undefined ? { keepout: r.keepout as boolean } : {}),
    ...(r.padConnection !== undefined
      ? { padConnection: r.padConnection as ZonePadConnection }
      : {}),
    ...islandsUpdate(zone, r.islands, r.minIslandArea),
    ...(r.rules !== undefined
      ? {
          keepoutRules: Object.fromEntries(
            Object.entries(r.rules as Record<string, string>).map(([key, value]) => [
              key,
              value === 'allowed'
            ])
          )
        }
      : {})
  }
  for (const key of ['minThickness', 'padClearance', 'thermalGap', 'thermalBridgeWidth'] as const) {
    const value = length(key)
    if (value !== undefined) update[key] = value
  }
  if (r.hatchStyle !== undefined) update.hatchStyle = r.hatchStyle as 'none' | 'edge' | 'full'
  if (r.hatchPitch !== undefined) update.hatchPitch = toNm(r.hatchPitch as number)
  if (Object.keys(update).length) updateBoardZoneInAST(zone, update)
  if (r.points) setBoardZoneOutlineInAST(zone, (r.points as Point[]).map(nmXY))
  return null
}

export const updateTextBox = (
  box: KicadFpTextBox,
  r: Record<string, unknown>
): ItemFailure | null => {
  if ((r.start !== undefined || r.end !== undefined) && box.points?.length)
    return fail(
      'not-applicable',
      'This text box is turned, so its corners are a polygon; delete it and create another to place it anew.'
    )
  const raw = box._raw as SExprList
  // A record names the sides that change; the rest keep what the box lays out with.
  const sides = r.margins as
    Partial<Record<'left' | 'top' | 'right' | 'bottom', number>> | undefined
  const current = textBoxMargins(box)
  const margin = (side: 'left' | 'top' | 'right' | 'bottom'): Nm =>
    sides?.[side] === undefined ? (current[side] as Nm) : toNm(sides[side])
  updateTextBoxInAST(box, {
    ...(r.text !== undefined ? { text: r.text as string } : {}),
    ...(r.layer !== undefined ? { layer: r.layer as string } : {}),
    ...(r.border !== undefined ? { border: r.border as boolean } : {}),
    ...(r.width !== undefined ? { strokeWidth: toNm(r.width as number) } : {}),
    ...(r.strokeType !== undefined ? { strokeType: r.strokeType as string } : {}),
    ...(r.knockout !== undefined ? { knockout: r.knockout as boolean } : {}),
    ...(sides
      ? {
          margins: {
            left: margin('left'),
            top: margin('top'),
            right: margin('right'),
            bottom: margin('bottom')
          }
        }
      : {})
  })
  // The facade too: a board keeps it across the edit (`remapKicadBoard`).
  if (r.start) {
    box.start = nmXY(r.start as Point)
    setXYChild(raw, 'start', box.start.x, box.start.y)
  }
  if (r.end) {
    box.end = nmXY(r.end as Point)
    setXYChild(raw, 'end', box.end.x, box.end.y)
  }
  const effects = fontEffects(box.fontEffects, r)
  if (effects) {
    box.fontEffects = effects
    setFontEffectsChild(raw, effects)
  }
  return null
}

/** A table record's border and separator keys as the table writer takes them. */
export const tablePatchOf = (r: Record<string, unknown>): TablePatch => ({
  ...(r.layer !== undefined ? { layer: r.layer as string } : {}),
  ...(r.borderExternal !== undefined ? { borderExternal: r.borderExternal as boolean } : {}),
  ...(r.borderHeader !== undefined ? { borderHeader: r.borderHeader as boolean } : {}),
  ...(r.borderWidth !== undefined ? { borderStrokeWidth: toNm(r.borderWidth as number) } : {}),
  ...(r.separatorRows !== undefined ? { separatorRows: r.separatorRows as boolean } : {}),
  ...(r.separatorCols !== undefined ? { separatorCols: r.separatorCols as boolean } : {}),
  ...(r.separatorWidth !== undefined
    ? { separatorStrokeWidth: toNm(r.separatorWidth as number) }
    : {})
})

/** Write a partial record onto one item. */
export const updateItem = (
  fp: KicadFootprint,
  item: FootprintItem,
  record: Record<string, unknown>
): { ok: true } | ItemFailure => {
  const readOnly = FOOTPRINT_READ_ONLY_KEYS[item.kind] ?? []
  const blocked = Object.keys(record).filter((key) => readOnly.includes(key))
  if (blocked.length) {
    return fail(
      'not-applicable',
      `A ${item.kind}'s ${blocked.join(', ')} cannot be changed here; ${READ_ONLY_INSTEAD[item.kind]}.`
    )
  }
  const invalid = validate(item.kind, record, 'update')
  if (invalid) return invalid
  if (!Object.keys(record).length) {
    return fail('invalid-record', 'The record changes nothing.')
  }
  const r = record
  const width = r.width !== undefined ? toNm(r.width as number) : undefined
  const common = {
    ...(r.layer !== undefined ? { layer: r.layer as string } : {}),
    ...(width !== undefined ? { strokeWidth: width } : {})
  }
  const same = <T extends { _raw: unknown }>(list: T[]): T | undefined =>
    list.find((candidate) => candidate._raw === item.node)
  switch (item.kind) {
    case 'footprint': {
      const failed = updateFootprint(fp, r)
      if (failed) return failed
      break
    }
    case 'pad': {
      const pad = same(fp.pads)
      if (pad) updatePad(pad, r)
      break
    }
    case 'line': {
      const line = same(fp.fpLines)
      if (line)
        updateLineInAST(line, {
          ...common,
          ...(r.start ? { start: nmXY(r.start as Point) } : {}),
          ...(r.end ? { end: nmXY(r.end as Point) } : {})
        })
      break
    }
    case 'arc': {
      const arc = same(fp.fpArcs)
      if (arc)
        updateArcInAST(arc, {
          ...common,
          ...(r.start ? { start: nmXY(r.start as Point) } : {}),
          ...(r.mid ? { mid: nmXY(r.mid as Point) } : {}),
          ...(r.end ? { end: nmXY(r.end as Point) } : {})
        })
      break
    }
    case 'circle': {
      const circle = same(fp.fpCircles)
      if (circle) {
        updateCircleInAST(circle, {
          ...common,
          ...(r.center ? { center: nmXY(r.center as Point) } : {}),
          ...(r.end ? { end: nmXY(r.end as Point) } : {})
        })
        if (r.fill !== undefined) setFill(circle._raw as SExprList, isPcbFillOn(r.fill))
      }
      break
    }
    case 'rect': {
      const rect = same(fp.fpRects)
      if (rect) {
        updateRectInAST(rect, {
          ...common,
          ...(r.start ? { start: nmXY(r.start as Point) } : {}),
          ...(r.end ? { end: nmXY(r.end as Point) } : {}),
          ...(r.radius !== undefined ? { radius: toNm((r.radius as number | null) ?? 0) } : {})
        })
        if (r.fill !== undefined) setFill(rect._raw as SExprList, isPcbFillOn(r.fill))
      }
      break
    }
    case 'poly': {
      const poly = same(fp.fpPolys)
      if (poly) {
        updatePolyInAST(poly, {
          ...common,
          ...(r.points ? { points: (r.points as Point[]).map(nmXY) } : {})
        })
        if (r.fill !== undefined) setFill(poly._raw as SExprList, isPcbFillOn(r.fill))
      }
      break
    }
    case 'bezier': {
      const curve = same(fp.fpCurves)
      if (curve)
        updateCurveInAST(curve, {
          ...common,
          ...(r.points ? { points: (r.points as Point[]).map(nmXY) } : {})
        })
      break
    }
    case 'text':
    case 'property': {
      const text = same(fp.fpTexts)
      const property = same(fp.properties)
      const current = text ?? property
      if (!current) break
      markNodeDirty(current._raw)
      const position =
        r.at !== undefined || r.angle !== undefined
          ? {
              ...(r.at
                ? nmXY(r.at as Point)
                : { x: current.position?.x ?? 0, y: current.position?.y ?? 0 }),
              angle: r.angle !== undefined ? (r.angle as number) : (current.position?.angle ?? 0)
            }
          : undefined
      const effects = fontEffects(current.fontEffects, r)
      const content = (r.text ?? r.value) as string | undefined
      const data = {
        ...(position ? { position: position as { x: Nm; y: Nm; angle?: number } } : {}),
        ...(r.layer !== undefined ? { layer: r.layer as string } : {}),
        ...(r.hidden !== undefined ? { hide: r.hidden as boolean } : {}),
        ...(effects ? { fontEffects: effects } : {}),
        ...(r.knockout !== undefined ? { knockout: r.knockout as boolean } : {}),
        ...(r.keepUpright !== undefined ? { keepUpright: r.keepUpright as boolean } : {})
      }
      if (text)
        updateTextInAST(text, { ...data, ...(content !== undefined ? { text: content } : {}) })
      if (property)
        updatePropertyInAST(property, {
          ...data,
          ...(content !== undefined ? { value: content } : {})
        })
      break
    }
    case 'text_box': {
      const box = same(fp.fpTextBoxes)
      const failed = box ? updateTextBox(box, r) : null
      if (failed) return failed
      break
    }
    case 'table': {
      const table = same(fp.tables)
      if (table) updateTableInAST(table, tablePatchOf(r))
      break
    }
    case 'point': {
      const point = same(fp.points)
      if (point)
        updatePointInAST(point, {
          ...(r.at ? { position: nmXY(r.at as Point) } : {}),
          ...(r.size !== undefined ? { size: toNm(r.size as number) } : {}),
          ...(r.layer !== undefined ? { layer: r.layer as string } : {})
        })
      break
    }
    case 'zone': {
      const failed = updateZone(fp, item.node, r)
      if (failed) return failed
      break
    }
    case 'model': {
      if (!fp.model) break
      const offset = r.offset as { x: number; y: number; z: number } | undefined
      updateModelInAST(fp.model, {
        ...(r.path !== undefined ? { path: r.path as string } : {}),
        ...(offset ? { offset: { x: toNm(offset.x), y: toNm(offset.y), z: toNm(offset.z) } } : {}),
        ...(r.scale ? { scale: r.scale as { x: number; y: number; z: number } } : {}),
        ...(r.rotate ? { rotate: r.rotate as { x: number; y: number; z: number } } : {})
      })
      break
    }
  }
  if (item.kind !== 'text_box') writeStroke(item.node, r)
  return { ok: true }
}

const REQUIRED: Record<CreatableKind, readonly string[]> = {
  pad: ['number', 'type', 'shape', 'at', 'size'],
  line: ['layer', 'start', 'end'],
  arc: ['layer', 'start', 'mid', 'end'],
  circle: ['layer', 'center', 'end'],
  rect: ['layer', 'start', 'end'],
  poly: ['layer', 'points'],
  bezier: ['layer', 'points'],
  text: ['text', 'at', 'layer'],
  text_box: ['text', 'start', 'end', 'layer'],
  point: ['at', 'layer'],
  property: ['key', 'value', 'layer'],
  model: ['path'],
  zone: ['points', 'layers']
}

/** The keys each create's own writer lays down; the rest go on as an update would write them. */
const CREATE_BASE: Record<CreatableKind, readonly string[]> = {
  pad: ['number', 'type', 'shape', 'at', 'angle', 'size', 'drill', 'layers', 'roundrectRatio'],
  line: ['layer', 'width', 'start', 'end'],
  arc: ['layer', 'width', 'start', 'mid', 'end'],
  circle: ['layer', 'width', 'center', 'end', 'fill'],
  rect: ['layer', 'width', 'start', 'end', 'fill'],
  poly: ['layer', 'width', 'points', 'fill'],
  bezier: ['layer', 'width', 'points'],
  text: ['text', 'at', 'angle', 'layer', 'size', 'thickness', 'hidden'],
  text_box: ['text', 'start', 'end', 'layer', 'size', 'thickness', 'width', 'mirror'],
  point: ['at', 'size', 'layer'],
  property: ['key', 'value', 'at', 'angle', 'layer', 'size', 'thickness', 'hidden'],
  model: ['path'],
  zone: ['points', 'layers', 'keepout']
}

/** A new stroke's width when none is given: the style's for its layer. */
const defaultWidth = (layer: string): Nm =>
  toNm(layer.endsWith('.SilkS') ? 0.12 : layer.endsWith('.CrtYd') ? 0.05 : 0.1)

const lastNode = (fp: KicadFootprint): SExprNode | undefined => {
  const root = fp._raw as SExprList
  return root.children[root.children.length - 1]
}

const lastUuid = (fp: KicadFootprint): string | undefined => {
  const node = lastNode(fp)
  if (node?.type !== 'list') return undefined
  const uuid = findChild(node, 'uuid')
  return uuid ? getFirstAtomValue(uuid) : undefined
}

/** A connector pad's copper and mask, as KiCad's Pad Properties gives one. */
const CONNECT_PAD_LAYERS = ['F.Cu', 'F.Mask']

/** A square text size's glyph height; a width-and-height size goes on as an update. */
const squareSize = (size: unknown): Nm => (typeof size === 'number' ? toNm(size) : TEXT_SIZE)

/** Add one item; answers with the id it will have once re-parsed. */
export const createItem = (
  fp: KicadFootprint,
  kind: FootprintItemKind,
  record: Record<string, unknown>
): { ok: true; id: string } | ItemFailure => {
  if (kind === 'footprint')
    return fail('refused', 'The footprint is always there; items_update "footprint" edits it.')
  if (kind === 'table')
    return fail('refused', 'A table is drawn in the footprint editor; items_update edits one.')
  const invalid = validate(kind, record, 'create')
  if (invalid) return invalid
  const missing = REQUIRED[kind].filter((key) => record[key] === undefined)
  if (missing.length) return fail('invalid-record', `A new ${kind} needs ${missing.join(', ')}.`)
  const r = record
  const layer = r.layer as string
  const width =
    r.width !== undefined ? toNm(r.width as number) : layer ? defaultWidth(layer) : toNm(0.1)
  const fill = isPcbFillOn(r.fill) ? ('solid' as const) : ('none' as const)
  let id: string | undefined
  switch (kind) {
    case 'pad': {
      const type = r.type as KicadPad['type']
      if (type !== 'smd' && type !== 'connect' && r.drill === undefined) {
        return fail('invalid-record', `A ${type} pad needs drill.`)
      }
      const size = r.size as { width: number; height: number }
      const drill = r.drill as
        { diameter: number; oval?: { width: number; height: number }; offset?: Point } | undefined
      const sizeNm = { w: toNm(size.width), h: toNm(size.height) }
      const shape = r.shape as 'rect' | 'roundrect' | 'circle' | 'oval' | 'trapezoid'
      addPadToFootprintAST(fp, {
        number: r.number as string,
        type,
        shape,
        at: { ...nmXY(r.at as Point), ...(r.angle ? { angle: r.angle as number } : {}) },
        size: sizeNm,
        ...(drill
          ? {
              drill: {
                diameter: toNm(drill.diameter),
                ...(drill.oval
                  ? { oval: { w: toNm(drill.oval.width), h: toNm(drill.oval.height) } }
                  : {}),
                ...(drill.offset ? { offset: nmXY(drill.offset) } : {})
              }
            }
          : {}),
        layers:
          (r.layers as string[] | undefined) ??
          (type === 'connect' ? CONNECT_PAD_LAYERS : DEFAULT_PAD_LAYERS[type]),
        ...(shape === 'roundrect'
          ? {
              roundrectRatio:
                (r.roundrectRatio as number | undefined) ?? roundrectRatio(sizeNm.w, sizeNm.h)
            }
          : {})
      })
      id = lastUuid(fp) ?? `pad:${r.number as string}`
      break
    }
    case 'line':
      addFpLineToFootprintAST(fp, {
        start: nmXY(r.start as Point),
        end: nmXY(r.end as Point),
        width,
        layer
      })
      break
    case 'arc':
      addFpArcToFootprintAST(fp, {
        start: nmXY(r.start as Point),
        mid: nmXY(r.mid as Point),
        end: nmXY(r.end as Point),
        width,
        layer
      })
      break
    case 'circle':
      addFpCircleToFootprintAST(fp, {
        center: nmXY(r.center as Point),
        end: nmXY(r.end as Point),
        width,
        layer,
        fill
      })
      break
    case 'rect':
      addFpRectToFootprintAST(fp, {
        start: nmXY(r.start as Point),
        end: nmXY(r.end as Point),
        width,
        layer,
        fill
      })
      break
    case 'poly':
      addFpPolyToFootprintAST(fp, {
        points: (r.points as Point[]).map(nmXY),
        width,
        layer,
        fill
      })
      break
    case 'bezier':
      addFpCurveToFootprintAST(fp, { points: (r.points as Point[]).map(nmXY), width, layer })
      break
    case 'text_box': {
      const size = squareSize(r.size)
      addFpTextBoxToFootprintAST(fp, {
        text: r.text as string,
        start: nmXY(r.start as Point),
        end: nmXY(r.end as Point),
        layer,
        size,
        thickness:
          r.thickness !== undefined ? toNm(r.thickness as number) : (Math.round(size * 0.15) as Nm),
        width,
        mirror: r.mirror === true
      })
      break
    }
    case 'point':
      addPointToFootprintAST(fp, {
        position: nmXY(r.at as Point),
        size: r.size !== undefined ? toNm(r.size as number) : DEFAULT_POINT_SIZE,
        layer
      })
      break
    case 'zone': {
      const root = fp._raw as SExprList
      markNodeDirty(root)
      // A footprint's zone is on no net, written as KiCad 10 writes that: no (net …).
      root.children.push(
        buildZoneNode(
          root.start,
          {
            points: (r.points as Point[]).map(nmXY),
            layers: r.layers as string[],
            net: 0,
            netName: '',
            keepout: r.keepout === true
          },
          'name'
        )
      )
      break
    }
    case 'text':
    case 'property': {
      const size = squareSize(r.size)
      const style = {
        at: {
          ...nmXY((r.at as Point | undefined) ?? { x: 0, y: 0 }),
          angle: (r.angle as number | undefined) ?? 0
        },
        layer,
        size,
        thickness:
          r.thickness !== undefined ? toNm(r.thickness as number) : (Math.round(size * 0.15) as Nm),
        hide: r.hidden === true
      }
      if (kind === 'text') {
        addFpTextToFootprintAST(fp, r.text as string, style)
        id = lastUuid(fp) ?? positionalId('text', style.at)
        break
      }
      const key = (r.key as string).trim()
      if (fp.properties.some((property) => property.key === key)) {
        return fail(
          'refused',
          `The footprint already has a ${key} property; update property:${key} instead.`
        )
      }
      addFpPropertyToFootprintAST(fp, key, r.value as string, style)
      id = `property:${key}`
      break
    }
    case 'model': {
      if (fp.model) {
        return fail('refused', 'The footprint already has a 3D model; update "model" instead.')
      }
      addModelNode(fp, r.path as string)
      id = 'model'
      break
    }
  }
  // What the writer did not lay down goes on through the same path an update takes.
  const base = CREATE_BASE[kind]
  const extras = Object.fromEntries(
    Object.entries(r).filter(
      ([key, value]) =>
        value !== undefined &&
        (!base.includes(key) || (key === 'size' && kind !== 'pad' && typeof value !== 'number'))
    )
  )
  const node = lastNode(fp)
  if (Object.keys(extras).length && node) {
    Object.assign(fp, parseFootprintNode(fp._raw as SExprList))
    const made = footprintItems(fp).find((item) => item.node === node)
    const written = made ? updateItem(fp, made, extras) : null
    if (written && !written.ok) return written
  }
  return {
    ok: true,
    id:
      id ??
      lastUuid(fp) ??
      positionalId(kind, nmXY((r.start ?? r.center ?? r.at ?? (r.points as Point[])[0]) as Point))
  }
}

/** Every footprint keeps its Reference and Value. */
const KEPT_PROPERTIES = new Set(['property:Reference', 'property:Value'])

/** Remove items by node. Refuses the whole call before removing any. */
export const deleteItems = (
  fp: KicadFootprint,
  items: FootprintItem[]
): { ok: true } | ItemFailure => {
  if (items.some((item) => item.kind === 'footprint'))
    return fail(
      'refused',
      'The footprint itself is not an item to delete; footprint_delete removes a library footprint.'
    )
  const kept = items.filter((item) => KEPT_PROPERTIES.has(item.id))
  if (kept.length) {
    return fail(
      'refused',
      `Every footprint keeps its Reference and Value; hide them or move them instead (${kept
        .map((item) => item.id)
        .join(', ')}).`
    )
  }
  const root = fp._raw as SExprList
  markNodeDirty(root)
  const nodes = new Set(items.filter((item) => item.kind !== 'model').map((item) => item.node))
  root.children = root.children.filter((child) => !nodes.has(child))
  if (items.some((item) => item.kind === 'model')) removeModelNode(fp)
  return { ok: true }
}
