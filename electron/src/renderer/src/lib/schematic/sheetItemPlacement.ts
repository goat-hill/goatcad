/**
 * Moving, turning and flipping the sheet's annotation and bus items — free
 * text, text boxes, graphics, images, tables, buses, bus entries, directive
 * labels and rule areas — as KiCad does. A placement is computed as a new
 * copy of the item (`placedSheetItem`), which the drag preview draws and
 * `writeSheetItem` then writes into the file, so the two cannot disagree.
 */
import { nm, type Nm } from '../kicad/coordinates'
import {
  setSchematicBusEntryInAST,
  setSchematicBusPointsInAST,
  setSchematicDirectiveLabelInAST,
  setSchematicGraphicInAST,
  setSchematicImagePositionInAST,
  setSchematicRuleAreaInAST,
  setSchematicShapeCornersInAST,
  setSchematicTableCellsInAST,
  setSchematicTextPlacement,
  type KicadBusEntry,
  type KicadDirectiveLabel,
  type KicadRuleArea,
  type KicadSchematic,
  type KicadSchematicImage,
  type KicadSchematicShape,
  type KicadSchematicTable,
  type KicadSchematicText,
  type KicadTextEffects,
  type KicadWire,
  type Point,
  type SchematicItemType
} from '../kicad/schematic'
import { setTextEffects } from '../symbol/symbolEdit'
import { transformAngle, type TransformOp } from './schematicTransform'

export const SHEET_ITEM_TYPES = [
  'text',
  'text_box',
  'shape',
  'polyline',
  'circle',
  'arc',
  'bezier',
  'image',
  'table',
  'bus',
  'bus_entry',
  'netclass_flag',
  'rule_area'
] as const satisfies readonly SchematicItemType[]

export type SheetItemType = (typeof SHEET_ITEM_TYPES)[number]

export const isSheetItemType = (type: string): type is SheetItemType =>
  (SHEET_ITEM_TYPES as readonly string[]).includes(type)

interface SheetItemMap {
  text: KicadSchematicText
  text_box: KicadSchematic['textBoxes'][number]
  shape: KicadSchematicShape
  polyline: KicadSchematic['polylines'][number]
  circle: KicadSchematic['circles'][number]
  arc: KicadSchematic['arcs'][number]
  bezier: KicadSchematic['beziers'][number]
  image: KicadSchematicImage
  table: KicadSchematicTable
  bus: KicadWire
  bus_entry: KicadBusEntry
  netclass_flag: KicadDirectiveLabel
  rule_area: KicadRuleArea
}

/** One sheet item with its kind, so every switch below narrows. */
export type SheetItem = { [K in SheetItemType]: { type: K; item: SheetItemMap[K] } }[SheetItemType]

const arrayOf = <K extends SheetItemType>(doc: KicadSchematic, type: K): SheetItemMap[K][] => {
  const arrays: { [T in SheetItemType]: SheetItemMap[T][] } = {
    text: doc.texts,
    text_box: doc.textBoxes,
    shape: doc.shapes,
    polyline: doc.polylines,
    circle: doc.circles,
    arc: doc.arcs,
    bezier: doc.beziers,
    image: doc.images,
    table: doc.tables,
    bus: doc.buses,
    bus_entry: doc.busEntries,
    netclass_flag: doc.directiveLabels,
    rule_area: doc.ruleAreas
  }
  return arrays[type]
}

export function sheetItemAt(
  doc: KicadSchematic,
  type: SheetItemType,
  index: number
): SheetItem | null {
  const item = arrayOf(doc, type)[index]
  return item ? ({ type, item } as SheetItem) : null
}

/** The document with one sheet item replaced — a preview's copy; nodes are shared. */
export function withSheetItems(
  doc: KicadSchematic,
  placed: Array<SheetItem & { index: number }>
): KicadSchematic {
  if (!placed.length) return doc
  const next: KicadSchematic = {
    ...doc,
    texts: [...doc.texts],
    textBoxes: [...doc.textBoxes],
    shapes: [...doc.shapes],
    polylines: [...doc.polylines],
    circles: [...doc.circles],
    arcs: [...doc.arcs],
    beziers: [...doc.beziers],
    images: [...doc.images],
    tables: [...doc.tables],
    buses: [...doc.buses],
    busEntries: [...doc.busEntries],
    directiveLabels: [...doc.directiveLabels],
    ruleAreas: [...doc.ruleAreas]
  }
  for (const entry of placed) {
    const array = arrayOf(next, entry.type) as unknown[]
    array[entry.index] = entry.item
  }
  return next
}

/**
 * Whether KiCad turns and flips this kind. An image would have to rotate its
 * bitmap and a table its cell grid, which this does not do; in a turned
 * selection those only follow the shift.
 */
export const sheetItemTurns = (type: SheetItemType): boolean => type !== 'image' && type !== 'table'

const endOf = (position: Point, size: { width: Nm; height: Nm }): Point => ({
  x: nm(position.x + size.width),
  y: nm(position.y + size.height)
})

/**
 * The grid point a drag snaps the item by: the point the file positions it at
 * (a text's anchor, a shape's first point), which is on grid when the item was
 * placed on grid.
 */
export function sheetItemOrigin(entry: SheetItem): Point | null {
  switch (entry.type) {
    case 'text':
    case 'netclass_flag':
      return entry.item.position
    case 'text_box':
      return entry.item.graphic.position
    case 'shape':
      return entry.item.start
    case 'polyline':
    case 'bezier':
    case 'rule_area':
      return entry.item.graphic.points[0] ?? null
    case 'circle':
      return entry.item.graphic.center
    case 'arc':
      return entry.item.graphic.start
    case 'image':
    case 'bus_entry':
      return entry.item.position
    case 'table':
      return entry.item.cells[0]?.position ?? null
    case 'bus':
      return entry.item.points[0] ?? null
  }
}

/** Every point that places the item — what a turn's pivot is the middle of. */
export function sheetItemPoints(entry: SheetItem): Point[] {
  switch (entry.type) {
    case 'text':
    case 'image':
    case 'netclass_flag':
      return [entry.item.position]
    case 'text_box': {
      const { position, size } = entry.item.graphic
      return [position, endOf(position, size)]
    }
    case 'shape':
      return [entry.item.start, entry.item.end]
    case 'polyline':
    case 'bezier':
    case 'rule_area':
      return entry.item.graphic.points
    case 'circle':
      return [entry.item.graphic.center]
    case 'arc':
      return [entry.item.graphic.start, entry.item.graphic.mid, entry.item.graphic.end]
    case 'table':
      return entry.item.cells.map((cell) => cell.position)
    case 'bus':
      return entry.item.points
    case 'bus_entry':
      return [entry.item.position, endOf(entry.item.position, entry.item.size)]
  }
}

/** How a placement moves points: the full map, and the shift alone. */
export interface Placement {
  /** Where a point lands: every turn and flip, then the shift. */
  place: (point: Point) => Point
  /** The shift alone, for a kind that does not turn. */
  shift: (point: Point) => Point
  /** The turns and flips, in order; empty for a plain move. */
  ops: readonly TransformOp[]
}

export const translation = (delta: Point): Placement => {
  const shift = (point: Point): Point => ({ x: nm(point.x + delta.x), y: nm(point.y + delta.y) })
  return { place: shift, shift, ops: [] }
}

const vertical = (angle: number): boolean => Math.round(angle / 90) % 2 !== 0
type HAlign = KicadTextEffects['horizontalAlign']
const flipped = (align: HAlign): HAlign =>
  align === 'left' ? 'right' : align === 'right' ? 'left' : align

/**
 * A text's angle and horizontal justification after one turn or flip, by
 * `SCH_TEXT::Rotate90` and `Mirror*`: KiCad text only ever reads horizontally
 * or upward, so a turn toggles between the two and, where the turn would read
 * it backwards, flips which end the anchor is at instead; a flip across the
 * reading axis flips the justification and leaves the angle.
 */
export function turnedText(
  angle: number,
  align: HAlign,
  op: TransformOp
): { angle: number; align: HAlign } {
  const up = vertical(angle)
  switch (op) {
    case 'rotateCCW':
      return { angle: up ? 0 : 90, align: up ? flipped(align) : align }
    case 'rotateCW':
      return { angle: up ? 0 : 90, align: up ? align : flipped(align) }
    case 'mirrorHorizontal':
      return { angle, align: up ? align : flipped(align) }
    case 'mirrorVertical':
      return { angle, align: up ? flipped(align) : align }
  }
}

/**
 * A text box turns as a rectangle — its corners map, so it stays axis-aligned
 * — and its text toggles between horizontal and vertical (`SCH_TEXTBOX::
 * Rotate`); a flip only flips the justification along the text.
 */
const turnedTextBoxText = (
  angle: number,
  align: HAlign,
  op: TransformOp
): { angle: number; align: HAlign } =>
  op === 'rotateCCW' || op === 'rotateCW'
    ? { angle: vertical(angle) ? 0 : 90, align }
    : turnedText(angle, align, op)

/** A field of a turned directive label keeps reading upright, as KiCad's do. */
const turnedFieldAngle = (angle: number, op: TransformOp): number =>
  op === 'rotateCCW' || op === 'rotateCW' ? (vertical(angle) ? 0 : 90) : angle

/**
 * The item as the placement leaves it: a new object sharing the old one's AST
 * node, nothing written. A kind that does not turn (`sheetItemTurns`) follows
 * only the shift.
 */
export function placedSheetItem(entry: SheetItem, placement: Placement): SheetItem {
  const ops = sheetItemTurns(entry.type) ? placement.ops : []
  const place = sheetItemTurns(entry.type) ? placement.place : placement.shift
  switch (entry.type) {
    case 'text': {
      const text = entry.item
      const turned = ops.reduce((at, op) => turnedText(at.angle, at.align, op), {
        angle: text.position.angle,
        align: text.effects.horizontalAlign
      })
      return {
        type: 'text',
        item: {
          ...text,
          position: { ...place(text.position), angle: turned.angle },
          effects: { ...text.effects, horizontalAlign: turned.align }
        }
      }
    }
    case 'text_box': {
      const graphic = entry.item.graphic
      const start = place(graphic.position)
      const end = place(endOf(graphic.position, graphic.size))
      const turned = ops.reduce((at, op) => turnedTextBoxText(at.angle, at.align, op), {
        angle: graphic.position.angle,
        align: graphic.effects.horizontalAlign
      })
      return {
        type: 'text_box',
        item: {
          ...entry.item,
          graphic: {
            ...graphic,
            position: { ...start, angle: turned.angle },
            size: { width: nm(end.x - start.x), height: nm(end.y - start.y) },
            effects: { ...graphic.effects, horizontalAlign: turned.align }
          }
        }
      }
    }
    case 'shape':
      return {
        type: 'shape',
        item: { ...entry.item, start: place(entry.item.start), end: place(entry.item.end) }
      }
    case 'polyline':
      return {
        type: 'polyline',
        item: {
          ...entry.item,
          graphic: { ...entry.item.graphic, points: entry.item.graphic.points.map(place) }
        }
      }
    case 'bezier':
      return {
        type: 'bezier',
        item: {
          ...entry.item,
          graphic: { ...entry.item.graphic, points: entry.item.graphic.points.map(place) }
        }
      }
    case 'rule_area':
      return {
        type: 'rule_area',
        item: {
          ...entry.item,
          graphic: { ...entry.item.graphic, points: entry.item.graphic.points.map(place) }
        }
      }
    case 'circle':
      return {
        type: 'circle',
        item: {
          ...entry.item,
          graphic: { ...entry.item.graphic, center: place(entry.item.graphic.center) }
        }
      }
    case 'arc': {
      const graphic = entry.item.graphic
      return {
        type: 'arc',
        item: {
          ...entry.item,
          graphic: {
            ...graphic,
            start: place(graphic.start),
            mid: place(graphic.mid),
            end: place(graphic.end)
          }
        }
      }
    }
    case 'image':
      return { type: 'image', item: { ...entry.item, position: place(entry.item.position) } }
    case 'table':
      return {
        type: 'table',
        item: {
          ...entry.item,
          cells: entry.item.cells.map((cell) => ({
            ...cell,
            position: { ...place(cell.position), angle: cell.position.angle }
          }))
        }
      }
    case 'bus':
      return { type: 'bus', item: { ...entry.item, points: entry.item.points.map(place) } }
    case 'bus_entry': {
      const start = place(entry.item.position)
      const end = place(endOf(entry.item.position, entry.item.size))
      return {
        type: 'bus_entry',
        item: {
          ...entry.item,
          position: start,
          size: { width: nm(end.x - start.x), height: nm(end.y - start.y) }
        }
      }
    }
    case 'netclass_flag': {
      const label = entry.item
      return {
        type: 'netclass_flag',
        item: {
          ...label,
          position: {
            ...place(label.position),
            angle: ops.reduce((at, op) => transformAngle(at, op), label.position.angle)
          },
          properties: label.properties.map((property) => ({
            ...property,
            position: {
              ...place(property.position),
              angle: ops.reduce((at, op) => turnedFieldAngle(at, op), property.position.angle)
            }
          }))
        }
      }
    }
  }
}

/**
 * Write `after`'s geometry into the file through `before`'s node — the two
 * must be the same item, `after` from `placedSheetItem`. Only what changed is
 * rewritten.
 */
export function writeSheetItem(before: SheetItem, after: SheetItem): void {
  switch (before.type) {
    case 'text': {
      if (after.type !== 'text') return
      setSchematicTextPlacement(before.item, after.item.position)
      if (after.item.effects.horizontalAlign !== before.item.effects.horizontalAlign) {
        setTextEffects(before.item._node, { hAlign: after.item.effects.horizontalAlign })
        before.item.effects.horizontalAlign = after.item.effects.horizontalAlign
      }
      return
    }
    case 'text_box': {
      if (after.type !== 'text_box') return
      const align = after.item.graphic.effects.horizontalAlign
      const changed = align !== before.item.graphic.effects.horizontalAlign
      setSchematicGraphicInAST(before.item, after.item.graphic)
      if (changed) setTextEffects(before.item._node, { hAlign: align })
      return
    }
    case 'shape':
      if (after.type === 'shape')
        setSchematicShapeCornersInAST(before.item, after.item.start, after.item.end)
      return
    case 'polyline':
      if (after.type === 'polyline') setSchematicGraphicInAST(before.item, after.item.graphic)
      return
    case 'bezier':
      if (after.type === 'bezier') setSchematicGraphicInAST(before.item, after.item.graphic)
      return
    case 'circle':
      if (after.type === 'circle') setSchematicGraphicInAST(before.item, after.item.graphic)
      return
    case 'arc':
      if (after.type === 'arc') setSchematicGraphicInAST(before.item, after.item.graphic)
      return
    case 'rule_area':
      if (after.type === 'rule_area')
        setSchematicRuleAreaInAST(before.item, after.item.graphic.points)
      return
    case 'image':
      if (after.type === 'image') setSchematicImagePositionInAST(before.item, after.item.position)
      return
    case 'table':
      if (after.type === 'table')
        setSchematicTableCellsInAST(
          before.item,
          after.item.cells.map((cell) => cell.position)
        )
      return
    case 'bus':
      if (after.type === 'bus') setSchematicBusPointsInAST(before.item, after.item.points)
      return
    case 'bus_entry':
      if (after.type === 'bus_entry')
        setSchematicBusEntryInAST(before.item, after.item.position, after.item.size)
      return
    case 'netclass_flag':
      if (after.type === 'netclass_flag')
        setSchematicDirectiveLabelInAST(
          before.item,
          after.item.position,
          after.item.properties.map((property) => property.position)
        )
      return
  }
}
