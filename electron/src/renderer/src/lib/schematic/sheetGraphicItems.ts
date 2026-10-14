/**
 * The sheet's graphics, buses, bus entries, directive labels, images and
 * tables as agent records (`docs/agent-api.md`): one id and record per item,
 * and the writes `items.create` and `items.update` make to them.
 *
 * Nothing here is a second editor. A new item is written by the drawing tool's
 * own writer (`drawTools.ts`'s `writeDrawItem` targets), a move by the drag's
 * placement (`sheetItemPlacement.ts`), and a restyle by the setters the
 * properties panel calls (`symbol/symbolEdit.ts`, `kicad/schematic.ts`); an
 * agent's record only names what those take.
 */
import { mmToNm, nm, type Nm } from '../kicad/coordinates'
import { hexColorToRgba, rgbaToHexColor, type Rgba } from '../kicad/color'
import {
  addSchematicArcToAST,
  addSchematicBezierToAST,
  addSchematicBusEntryToAST,
  addSchematicCircleToAST,
  addSchematicDirectiveLabelToAST,
  addSchematicImageToAST,
  addSchematicPolylineToAST,
  addSchematicRectangleToAST,
  addSchematicRuleAreaToAST,
  addSchematicTableToAST,
  addSchematicTextBoxToAST,
  parseSheetItemNode,
  setSchematicBusEntryInAST,
  setSchematicDirectiveLabelLength,
  setSchematicDirectiveLabelNetclass,
  setSchematicDirectiveLabelShape,
  setSchematicGraphicInAST,
  setSchematicPropertyValue,
  setSchematicRuleAreaInAST,
  setSchematicShapeCornersInAST,
  setSchematicTableCellText,
  setSchematicTextBoxContent,
  updateSchematicImageInAST,
  updateSchematicTableInAST,
  updateSchematicWireInAST,
  type DirectiveLabelShape,
  type KicadSchematic,
  type KicadTextEffects,
  type Point,
  type SheetItemNodes
} from '../kicad/schematic'
import { findChild, findChildren, type SExprList } from '../kicad/sexpr'
import { setTextEffects, updatePolyline, type TextEffectsPatch } from '../symbol/symbolEdit'
import type { McpSheetGeometry, McpSheetStyle } from '../../../../preload/mcpTypes'
import type { SchematicConnectivity } from './connectivity'
import { arcMidpoint, BUS_ENTRY_SIZE } from './drawTools'
import { asMm, type Box } from './schematicAgent'
import { graphicPoints } from './schematicTools'
import { directiveLabelGlyph, imageSizeNm, pngInfo } from './sheetGraphics'
import {
  placedSheetItem,
  sheetItemAt,
  sheetItemOrigin,
  translation,
  writeSheetItem,
  type SheetItem as PlacedItem,
  type SheetItemType
} from './sheetItemPlacement'

/** The agent's kinds for these items; KiCad's names, `rect` and `directive_label` aside. */
export const GRAPHIC_KINDS = [
  'rect',
  'polyline',
  'circle',
  'arc',
  'bezier',
  'text_box',
  'rule_area',
  'image',
  'table',
  'bus',
  'bus_entry',
  'directive_label'
] as const

export type GraphicKind = (typeof GRAPHIC_KINDS)[number]

export const isGraphicKind = (kind: string): kind is GraphicKind =>
  (GRAPHIC_KINDS as readonly string[]).includes(kind)

/** The editor's name for each kind's items, and the token its node starts with. */
const EDITOR_TYPE: { [K in GraphicKind]: SheetItemType } = {
  rect: 'shape',
  polyline: 'polyline',
  circle: 'circle',
  arc: 'arc',
  bezier: 'bezier',
  text_box: 'text_box',
  rule_area: 'rule_area',
  image: 'image',
  table: 'table',
  bus: 'bus',
  bus_entry: 'bus_entry',
  directive_label: 'netclass_flag'
}
const TOKEN: { [K in GraphicKind]: keyof SheetItemNodes } = {
  rect: 'rectangle',
  polyline: 'polyline',
  circle: 'circle',
  arc: 'arc',
  bezier: 'bezier',
  text_box: 'text_box',
  rule_area: 'rule_area',
  image: 'image',
  table: 'table',
  bus: 'bus',
  bus_entry: 'bus_entry',
  directive_label: 'netclass_flag'
}

/** One of these items, with the editor's typed copy a write goes through. */
export interface GraphicItem {
  kind: GraphicKind
  index: number
  entry: PlacedItem
}

/** Every such item on the sheet: kind by kind, file order within each. */
export function graphicItems(doc: KicadSchematic): GraphicItem[] {
  const items: GraphicItem[] = []
  for (const kind of GRAPHIC_KINDS) {
    for (let index = 0; ; index += 1) {
      const entry = sheetItemAt(doc, EDITOR_TYPE[kind], index)
      if (!entry) break
      items.push({ kind, index, entry })
    }
  }
  return items
}

const ORIGIN: Point = { x: nm(0), y: nm(0) }

/** The point a move goes by: the drag's own anchor for the kind. */
export const graphicAnchor = (item: GraphicItem): Point => sheetItemOrigin(item.entry) ?? ORIGIN

/** Its KiCad uuid, else `<kind>@x,y#index` at its anchor. */
export const graphicItemId = (item: GraphicItem): string => {
  const at = graphicAnchor(item)
  return item.entry.item.uuid ?? `${item.kind}@${asMm(at.x)},${asMm(at.y)}#${item.index}`
}

// --- reading ------------------------------------------------------------------

const mm = (point: { x: number; y: number }): { x: number; y: number } => ({
  x: asMm(nm(point.x)),
  y: asMm(nm(point.y))
})

const boxOf = (points: readonly { x: number; y: number }[]): Box => {
  if (!points.length) return { minX: 0, minY: 0, maxX: 0, maxY: 0 }
  const xs = points.map((point) => point.x)
  const ys = points.map((point) => point.y)
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys)
  }
}

const frameOf = (box: Box): { x: number; y: number; width: number; height: number } => ({
  x: asMm(nm(box.minX)),
  y: asMm(nm(box.minY)),
  width: asMm(nm(box.maxX - box.minX)),
  height: asMm(nm(box.maxY - box.minY))
})

const strokeRecord = (stroke: {
  width: Nm
  type?: string
  color?: Rgba
}): Record<string, unknown> => ({
  width: asMm(stroke.width),
  strokeType: stroke.type ?? 'default',
  strokeColor: rgbaToHexColor(stroke.color)
})

const fillRecord = (fill: string, color: Rgba | undefined): Record<string, unknown> => ({
  fill,
  fillColor: rgbaToHexColor(color)
})

/** A text's style as `textEffectsPatch` writes it. */
export const textStyleRecord = (effects: KicadTextEffects): Record<string, unknown> => ({
  size: asMm(effects.fontSize.height),
  bold: effects.bold,
  italic: effects.italic,
  justify: effects.horizontalAlign,
  verticalJustify: effects.verticalAlign,
  color: rgbaToHexColor(effects.color)
})

/** What `sheetItems` lists for one of these items. */
export interface GraphicView {
  at: Point
  angle?: number
  box: Box
  net?: string
  brief: Record<string, unknown>
  record: () => Record<string, unknown>
}

export interface GraphicReadContext {
  schematic: KicadSchematic
  connectivity: SchematicConnectivity | null
  sheetPath: string
}

const samePoints = (a: readonly Point[], b: readonly Point[]): boolean =>
  a.length === b.length &&
  a.every((point, index) => point.x === b[index].x && point.y === b[index].y)

/** The names a bus carries and the member nets they make, as connectivity reads them. */
const busNames = (
  context: GraphicReadContext,
  points: readonly Point[]
): { names: string[]; members: string[] } => {
  const bus = context.connectivity?.buses.find(
    (candidate) =>
      candidate.sheetPath === context.sheetPath &&
      candidate.wires.some((wire) => samePoints(wire.points, points))
  )
  const names = [...new Set(bus?.names.map((name) => name.text) ?? [])]
  const members = [...new Set(bus?.names.flatMap((name) => name.members) ?? [])]
  return { names, members }
}

/** One item's place, extent, net and record, by kind. */
export function graphicView(item: GraphicItem, context: GraphicReadContext): GraphicView {
  const id = graphicItemId(item)
  const at = graphicAnchor(item)
  const head = { id, kind: item.kind }
  const netAt = (point: Point): string | undefined =>
    context.connectivity?.netAt(context.sheetPath, point)?.name
  const { entry } = item
  switch (entry.type) {
    case 'shape': {
      const shape = entry.item
      const box = boxOf([shape.start, shape.end])
      return {
        at,
        box,
        brief: {},
        record: () => ({
          ...head,
          at: mm(shape.start),
          box: frameOf(box),
          ...strokeRecord({
            width: shape.strokeWidth,
            type: shape.strokeType,
            color: shape.strokeColor
          }),
          ...fillRecord(shape.fill, shape.fillColor)
        })
      }
    }
    case 'polyline':
    case 'bezier':
    case 'rule_area': {
      const { graphic } = entry.item
      const box = boxOf(graphic.points)
      return {
        at,
        box,
        brief: { points: graphic.points.map(mm) },
        record: () => ({
          ...head,
          at: mm(at),
          points: graphic.points.map(mm),
          box: frameOf(box),
          ...strokeRecord(graphic.stroke),
          ...(entry.type === 'polyline' ? {} : fillRecord(graphic.fill, graphic.fillColor))
        })
      }
    }
    case 'circle': {
      const { graphic } = entry.item
      const box = boxOf(graphicPoints(graphic))
      return {
        at,
        box,
        brief: { radius: asMm(graphic.radius) },
        record: () => ({
          ...head,
          at: mm(at),
          center: mm(graphic.center),
          radius: asMm(graphic.radius),
          box: frameOf(box),
          ...strokeRecord(graphic.stroke),
          ...fillRecord(graphic.fill, graphic.fillColor)
        })
      }
    }
    case 'arc': {
      const { graphic } = entry.item
      const box = boxOf([graphic.start, graphic.mid, graphic.end])
      return {
        at,
        box,
        brief: {},
        record: () => ({
          ...head,
          at: mm(at),
          start: mm(graphic.start),
          mid: mm(graphic.mid),
          end: mm(graphic.end),
          box: frameOf(box),
          ...strokeRecord(graphic.stroke),
          ...fillRecord(graphic.fill, graphic.fillColor)
        })
      }
    }
    case 'text_box': {
      const { graphic } = entry.item
      const box = boxOf(graphicPoints(graphic))
      return {
        at,
        angle: graphic.position.angle,
        box,
        brief: { text: graphic.text },
        record: () => ({
          ...head,
          text: graphic.text,
          at: mm(graphic.position),
          box: frameOf(box),
          ...textStyleRecord(graphic.effects),
          ...strokeRecord(graphic.stroke),
          ...fillRecord(graphic.fill, graphic.fillColor)
        })
      }
    }
    case 'image': {
      const image = entry.item
      const info = pngInfo(image.data)
      const size = info ? imageSizeNm(info, image.scale, context.schematic.version) : null
      const box = size
        ? {
            minX: image.position.x - size.width / 2,
            minY: image.position.y - size.height / 2,
            maxX: image.position.x + size.width / 2,
            maxY: image.position.y + size.height / 2
          }
        : boxOf([image.position])
      return {
        at,
        box,
        brief: { scale: image.scale },
        record: () => ({
          ...head,
          at: mm(image.position),
          scale: image.scale,
          box: frameOf(box),
          ...(info ? { pixels: { width: info.width, height: info.height } } : {})
        })
      }
    }
    case 'table': {
      const table = entry.item
      const box = boxOf(
        table.cells.flatMap((cell) => [
          cell.position,
          { x: cell.position.x + cell.size.width, y: cell.position.y + cell.size.height }
        ])
      )
      const columns = table.columnCount
      const rows: string[][] = []
      for (let index = 0; index < table.cells.length; index += columns)
        rows.push(table.cells.slice(index, index + columns).map((cell) => cell.text))
      return {
        at,
        box,
        brief: { columns, rows: rows.length },
        record: () => ({
          ...head,
          at: mm(at),
          box: frameOf(box),
          columnWidths: table.cells.slice(0, columns).map((cell) => asMm(cell.size.width)),
          rowHeights: rows.map((_, row) => asMm(table.cells[row * columns].size.height)),
          cells: rows,
          borderExternal: table.border.external,
          borderHeader: table.border.header,
          borderWidth: asMm(table.border.stroke.width),
          separatorRows: table.separators.rows,
          separatorCols: table.separators.cols,
          separatorWidth: asMm(table.separators.stroke.width)
        })
      }
    }
    case 'bus': {
      const bus = entry.item
      const box = boxOf(bus.points)
      return {
        at,
        box,
        brief: { points: bus.points.map(mm) },
        record: () => ({
          ...head,
          at: mm(at),
          points: bus.points.map(mm),
          box: frameOf(box),
          ...busNames(context, bus.points),
          ...strokeRecord({ width: bus.width, type: bus.strokeType, color: bus.strokeColor })
        })
      }
    }
    case 'bus_entry': {
      const busEntry = entry.item
      const end = {
        x: nm(busEntry.position.x + busEntry.size.width),
        y: nm(busEntry.position.y + busEntry.size.height)
      }
      const box = boxOf([busEntry.position, end])
      const net = netAt(end)
      return {
        at,
        box,
        net,
        brief: { end: mm(end) },
        record: () => ({
          ...head,
          at: mm(busEntry.position),
          end: mm(end),
          box: frameOf(box),
          net: net ?? null,
          ...strokeRecord({
            width: busEntry.width,
            type: busEntry.strokeType,
            color: busEntry.strokeColor
          })
        })
      }
    }
    case 'netclass_flag': {
      const label = entry.item
      const glyph = directiveLabelGlyph(label)
      const circle = glyph.circle
      const box = boxOf([
        ...glyph.polyline,
        ...(circle
          ? [
              { x: circle.center.x - circle.radius, y: circle.center.y - circle.radius },
              { x: circle.center.x + circle.radius, y: circle.center.y + circle.radius }
            ]
          : [])
      ])
      const net = netAt(label.position)
      const netClass = label.properties.find((property) => property.key === 'Netclass')?.value
      return {
        at,
        angle: label.position.angle,
        box,
        net,
        brief: { netClass: netClass ?? null },
        record: () => ({
          ...head,
          at: mm(label.position),
          angle: label.position.angle,
          shape: label.shape,
          length: asMm(label.length),
          netClass: netClass ?? null,
          fields: Object.fromEntries(
            label.properties.map((property) => [property.key, property.value])
          ),
          box: frameOf(box),
          net: net ?? null
        })
      }
    }
    default:
      return { at, box: boxOf([at]), brief: {}, record: () => ({ ...head, at: mm(at) }) }
  }
}

// --- writing ------------------------------------------------------------------

/** What a create or an update hands these writers: the record's keys, in sheet mm. */
export type GraphicChange = McpSheetStyle &
  McpSheetGeometry & {
    at?: { x: number; y: number }
    text?: string
    shape?: string
    size?: number | { width: number; height: number }
    fields?: Record<string, string>
    columnWidths?: number[]
    rowHeights?: number[]
  }

const toPoint = (at: { x: number; y: number }): Point => ({ x: mmToNm(at.x), y: mmToNm(at.y) })

/** The keys that reshape an item, which a move by `at` cannot share a call with. */
const GEOMETRY_KEYS = ['box', 'points', 'center', 'radius', 'start', 'mid', 'end'] as const

/** The text keys of a change as the panel's effects patch. */
export const textEffectsPatch = (change: GraphicChange): TextEffectsPatch => ({
  ...(typeof change.size === 'number'
    ? { fontHeight: mmToNm(change.size), fontWidth: mmToNm(change.size) }
    : {}),
  ...(change.bold !== undefined ? { bold: change.bold } : {}),
  ...(change.italic !== undefined ? { italic: change.italic } : {}),
  ...(change.justify ? { hAlign: change.justify } : {}),
  ...(change.verticalJustify ? { vAlign: change.verticalJustify } : {}),
  ...(change.color !== undefined ? { color: hexColorToRgba(change.color) } : {})
})

/** Write a change's stroke keys onto a wire, bus or bus entry, as the panel's stroke rows do. */
export const writeWireStroke = (
  wire: Parameters<typeof updateSchematicWireInAST>[0],
  change: GraphicChange
): void => {
  const patch = {
    ...(change.width !== undefined ? { width: mmToNm(change.width) } : {}),
    ...(change.strokeType ? { strokeType: change.strokeType } : {}),
    ...(change.strokeColor !== undefined ? { strokeColor: hexColorToRgba(change.strokeColor) } : {})
  }
  if (Object.keys(patch).length) updateSchematicWireInAST(wire, patch)
}

/** The node a graphic's stroke and fill live on: a rule area's is its outline. */
const styleNode = (entry: PlacedItem): SExprList | null => {
  switch (entry.type) {
    case 'shape':
    case 'polyline':
    case 'circle':
    case 'arc':
    case 'bezier':
    case 'text_box':
      return entry.item._node
    case 'rule_area':
      return findChild(entry.item._node, 'polyline')
    default:
      return null
  }
}

/**
 * Why a change cannot be written to this item, or null when it can. The keys
 * and their values were checked against the kind (`shared/recordRules.ts`);
 * this is what the item's own state decides.
 */
export function graphicChangeRefusal(item: GraphicItem, change: GraphicChange): string | null {
  const reshape = GEOMETRY_KEYS.filter((key) => change[key] !== undefined)
  if (change.at && reshape.length)
    return `at moves the ${item.kind} whole and ${reshape.join(', ')} reshape${reshape.length === 1 ? 's' : ''} it; send them in two calls.`
  if (change.box && (change.box.width === 0 || change.box.height === 0))
    return 'box must span something: a width and a height other than 0.'
  const { entry } = item
  if (entry.type === 'netclass_flag' && change.fields) {
    const unknown = Object.keys(change.fields).filter(
      (key) => !entry.item.properties.some((property) => property.key === key)
    )
    if (unknown.length)
      return `${unknown.join(', ')} ${unknown.length === 1 ? 'is not a field' : 'are not fields'} of this directive label, which has ${entry.item.properties.map((property) => property.key).join(', ') || 'none'}; set its net class with netClass.`
  }
  if (entry.type === 'table' && change.cells) {
    const columns = entry.item.columnCount
    const rows = Math.ceil(entry.item.cells.length / columns)
    if (change.cells.length !== rows || change.cells.some((row) => row.length !== columns))
      return `cells must be ${rows} rows of ${columns}, as the table is.`
  }
  return null
}

/** Write a change into the item's node, through the editor's own setters. */
export function writeGraphicChange(item: GraphicItem, change: GraphicChange): void {
  const { entry } = item
  if (change.at) {
    const from = graphicAnchor(item)
    const to = toPoint(change.at)
    const delta = { x: nm(to.x - from.x), y: nm(to.y - from.y) }
    writeSheetItem(entry, placedSheetItem(entry, translation(delta)))
  }
  switch (entry.type) {
    case 'shape':
      if (change.box) {
        const { start, end } = boxCorners(change.box)
        setSchematicShapeCornersInAST(entry.item, start, end)
      }
      break
    case 'polyline':
      if (change.points)
        setSchematicGraphicInAST(entry.item, {
          ...entry.item.graphic,
          points: change.points.map(toPoint)
        })
      break
    case 'bezier':
      if (change.points)
        setSchematicGraphicInAST(entry.item, {
          ...entry.item.graphic,
          points: change.points.map(toPoint)
        })
      break
    case 'rule_area':
      if (change.points) setSchematicRuleAreaInAST(entry.item, change.points.map(toPoint))
      break
    case 'circle':
      if (change.center || change.radius !== undefined)
        setSchematicGraphicInAST(entry.item, {
          ...entry.item.graphic,
          ...(change.center ? { center: toPoint(change.center) } : {}),
          ...(change.radius !== undefined ? { radius: mmToNm(change.radius) } : {})
        })
      break
    case 'arc': {
      const { graphic } = entry.item
      if (change.start || change.mid || change.end) {
        const start = change.start ? toPoint(change.start) : graphic.start
        const end = change.end ? toPoint(change.end) : graphic.end
        // A new end without a new middle is the quarter arc the Draw Arcs tool makes.
        const mid = change.mid
          ? toPoint(change.mid)
          : change.start || change.end
            ? arcMidpoint(start, end)
            : graphic.mid
        setSchematicGraphicInAST(entry.item, { ...graphic, start, mid, end })
      }
      break
    }
    case 'text_box': {
      const { graphic } = entry.item
      if (change.box) {
        const { start, end } = boxCorners(change.box)
        setSchematicGraphicInAST(entry.item, {
          ...graphic,
          position: { ...start, angle: graphic.position.angle },
          size: { width: nm(end.x - start.x), height: nm(end.y - start.y) }
        })
      }
      if (change.text !== undefined) setSchematicTextBoxContent(entry.item, change.text)
      setTextEffects(entry.item._node, textEffectsPatch(change))
      break
    }
    case 'image':
      if (change.scale !== undefined) updateSchematicImageInAST(entry.item, { scale: change.scale })
      break
    case 'table': {
      const table = entry.item
      change.cells?.flat().forEach((text, index) => {
        const cell = table.cells[index]
        if (cell && cell.text !== text) setSchematicTableCellText(cell, text)
      })
      updateSchematicTableInAST(table, {
        ...(change.borderExternal !== undefined ? { borderExternal: change.borderExternal } : {}),
        ...(change.borderHeader !== undefined ? { borderHeader: change.borderHeader } : {}),
        ...(change.borderWidth !== undefined ? { borderWidth: mmToNm(change.borderWidth) } : {}),
        ...(change.separatorRows !== undefined ? { separatorRows: change.separatorRows } : {}),
        ...(change.separatorCols !== undefined ? { separatorCols: change.separatorCols } : {}),
        ...(change.separatorWidth !== undefined
          ? { separatorWidth: mmToNm(change.separatorWidth) }
          : {})
      })
      break
    }
    case 'bus':
      writeWireStroke(entry.item, change)
      break
    case 'bus_entry': {
      const busEntry = entry.item
      if (change.end) {
        const end = toPoint(change.end)
        setSchematicBusEntryInAST(busEntry, busEntry.position, {
          width: nm(end.x - busEntry.position.x),
          height: nm(end.y - busEntry.position.y)
        })
      }
      writeWireStroke(busEntry, change)
      break
    }
    case 'netclass_flag': {
      const label = entry.item
      if (change.shape) setSchematicDirectiveLabelShape(label, change.shape as DirectiveLabelShape)
      if (change.length !== undefined)
        setSchematicDirectiveLabelLength(label, mmToNm(change.length))
      if (change.netClass !== undefined) setSchematicDirectiveLabelNetclass(label, change.netClass)
      for (const [key, value] of Object.entries(change.fields ?? {})) {
        const property = label.properties.find((candidate) => candidate.key === key)
        if (property) setSchematicPropertyValue(property, value)
      }
      break
    }
    case 'text':
      break
  }
  const node = styleNode(entry)
  if (node)
    updatePolyline(node, {
      ...(change.width !== undefined ? { strokeWidth: mmToNm(change.width) } : {}),
      ...(change.strokeType ? { strokeType: change.strokeType } : {}),
      ...(change.strokeColor !== undefined
        ? { strokeColor: hexColorToRgba(change.strokeColor) }
        : {}),
      ...(change.fill ? { fill: change.fill } : {}),
      ...(change.fillColor !== undefined ? { fillColor: hexColorToRgba(change.fillColor) } : {})
    })
}

/** A box's top-left and bottom-right corners, whichever way its size runs. */
const boxCorners = (box: {
  x: number
  y: number
  width: number
  height: number
}): { start: Point; end: Point } => {
  const a = toPoint(box)
  const b = toPoint({ x: box.x + box.width, y: box.y + box.height })
  return {
    start: { x: nm(Math.min(a.x, b.x)), y: nm(Math.min(a.y, b.y)) },
    end: { x: nm(Math.max(a.x, b.x)), y: nm(Math.max(a.y, b.y)) }
  }
}

/** What a new item of these kinds needs beyond its record: a picture's PNG. */
export interface GraphicCreateInputs {
  /** The image's PNG, as base64. */
  png?: string
}

/**
 * Write a new item through its drawing tool's writer, then the rest of its
 * record through the setters an edit uses. Returns nothing: the caller reads
 * the new ids off the re-parsed sheet.
 */
export function writeGraphicCreate(
  doc: KicadSchematic,
  kind: Exclude<GraphicKind, 'bus'>,
  change: GraphicChange,
  inputs: GraphicCreateInputs = {}
): void {
  const token = TOKEN[kind]
  const before = new Set(findChildren(doc._root, token))
  const at = change.at ? toPoint(change.at) : ORIGIN
  const points = (change.points ?? []).map(toPoint)
  switch (kind) {
    case 'rect': {
      const { start, end } = boxCorners(change.box ?? { x: 0, y: 0, width: 0, height: 0 })
      addSchematicRectangleToAST(doc, start, end)
      break
    }
    case 'polyline':
      addSchematicPolylineToAST(doc, points)
      break
    case 'circle':
      addSchematicCircleToAST(
        doc,
        toPoint(change.center ?? { x: 0, y: 0 }),
        mmToNm(change.radius ?? 0)
      )
      break
    case 'arc': {
      const start = toPoint(change.start ?? { x: 0, y: 0 })
      const end = toPoint(change.end ?? { x: 0, y: 0 })
      const mid = change.mid ? toPoint(change.mid) : arcMidpoint(start, end)
      addSchematicArcToAST(doc, { start, mid, end })
      break
    }
    case 'bezier':
      if (points.length === 4) addSchematicBezierToAST(doc, points as [Point, Point, Point, Point])
      break
    case 'text_box': {
      const { start, end } = boxCorners(change.box ?? { x: 0, y: 0, width: 0, height: 0 })
      addSchematicTextBoxToAST(doc, change.text ?? '', start, {
        width: nm(end.x - start.x),
        height: nm(end.y - start.y)
      })
      break
    }
    case 'rule_area':
      addSchematicRuleAreaToAST(doc, points)
      break
    case 'image':
      if (inputs.png) addSchematicImageToAST(doc, at, inputs.png)
      break
    case 'table':
      addSchematicTableToAST(
        doc,
        at,
        (change.columnWidths ?? []).map(mmToNm),
        (change.rowHeights ?? []).map(mmToNm)
      )
      break
    case 'bus_entry': {
      const end = change.end ? toPoint(change.end) : null
      addSchematicBusEntryToAST(
        doc,
        at,
        end ? { width: nm(end.x - at.x), height: nm(end.y - at.y) } : BUS_ENTRY_SIZE
      )
      break
    }
    case 'directive_label':
      addSchematicDirectiveLabelToAST(
        doc,
        at,
        (change.shape as DirectiveLabelShape | undefined) ?? 'round',
        change.netClass ?? ''
      )
      break
  }
  // The writer drew the shape; the rest of the record is an edit of it.
  const rest: GraphicChange = {
    width: change.width,
    strokeType: change.strokeType,
    strokeColor: change.strokeColor,
    fill: change.fill,
    fillColor: change.fillColor,
    size: change.size,
    bold: change.bold,
    italic: change.italic,
    justify: change.justify,
    verticalJustify: change.verticalJustify,
    color: change.color,
    scale: change.scale,
    cells: change.cells,
    length: change.length
  }
  for (const node of findChildren(doc._root, token)) {
    if (before.has(node)) continue
    const made = parseSheetItemNode(token, node)
    if (!made) continue
    const entry = { type: EDITOR_TYPE[kind], item: made } as PlacedItem
    writeGraphicChange({ kind, index: -1, entry }, rest)
  }
}

/** The connection points a change leaves an item with: a bus's run, an entry's ends, a flag's foot. */
export function connectionPointsAfter(item: GraphicItem, change: GraphicChange): Point[] {
  const { entry } = item
  const from = graphicAnchor(item)
  const shift = change.at
    ? { x: nm(toPoint(change.at).x - from.x), y: nm(toPoint(change.at).y - from.y) }
    : { x: nm(0), y: nm(0) }
  const moved = (point: Point): Point => ({ x: nm(point.x + shift.x), y: nm(point.y + shift.y) })
  switch (entry.type) {
    case 'bus':
      return change.at ? entry.item.points.map(moved) : []
    case 'bus_entry': {
      if (!change.at && !change.end) return []
      const start = moved(entry.item.position)
      const end = change.end
        ? toPoint(change.end)
        : moved({
            x: nm(entry.item.position.x + entry.item.size.width),
            y: nm(entry.item.position.y + entry.item.size.height)
          })
      return [start, end]
    }
    case 'netclass_flag':
      return change.at ? [moved(entry.item.position)] : []
    default:
      return []
  }
}

/** Stroke as the record reads it, for the kinds `schematicItems` lists itself (wires). */
export const wireStrokeRecord = (wire: {
  width: Nm
  strokeType?: string
  strokeColor?: Rgba
}): Record<string, unknown> =>
  strokeRecord({ width: wire.width, type: wire.strokeType, color: wire.strokeColor })
