// Parts follow KiCad's source, named below: Copyright The KiCad Developers, GPL-3.0-or-later.
/**
 * Align and distribute a multi-selection, after KiCad's schematic align tool
 * (`eeschema/tools/sch_align_tool.cpp`): edges and centers are the items'
 * bounding boxes, the target is the item under the cursor or else the extreme
 * one (the leftmost left edge, the smallest center), and an item that connects
 * lands with its anchor on the grid — KiCad's `adjustDeltaForGrid` — so a
 * symbol aligns by its origin's grid point and its pins stay on grid.
 * Distribute is pcbnew's by gaps: the outer two stay, the rest spread so the
 * gaps between neighbors are equal.
 *
 * Every item moves by its own shift, and the wires follow through the same
 * move plan a drag uses, so the whole thing lands as one command.
 */
import { nm, type Nm } from '../kicad/coordinates'
import type { KicadSchematic, Point } from '../kicad/schematic'
import type { Box } from './schematicAgent'
import { fieldExtent, labelExtent, symbolBox } from './schematicItems'
import {
  applyMovePlan,
  movedPointsForTranslation,
  planMovedPoints,
  selectionOf,
  translateSchematicItems,
  type MoveItem,
  type MovePlan
} from './schematicMove'
import {
  sheetItemAt,
  sheetItemOrigin,
  sheetItemPoints,
  isSheetItemType
} from './sheetItemPlacement'

export type AlignOp = 'left' | 'centerX' | 'right' | 'top' | 'centerY' | 'bottom'
export type DistributeOp = 'horizontal' | 'vertical'

/** What aligning reads of one item. */
export interface AlignBox {
  box: Box
  /** The point the file places it by, which lands on the grid. */
  anchor: Point
  /** Whether it connects, so its anchor snaps (graphics and text do not). */
  snaps: boolean
}

const boxOfPoints = (points: readonly Point[]): Box => ({
  minX: Math.min(...points.map((p) => p.x)),
  minY: Math.min(...points.map((p) => p.y)),
  maxX: Math.max(...points.map((p) => p.x)),
  maxY: Math.max(...points.map((p) => p.y))
})

/** Kinds KiCad's align snaps: the ones on the connection grid. */
const CONNECTABLE = new Set([
  'symbol',
  'wire',
  'bus',
  'label',
  'junction',
  'no_connect',
  'sheet',
  'bus_entry',
  'netclass_flag'
])

/** One item's box and anchor; null for a part (a field, a sheet pin), which moves with its owner. */
export function alignBoxOf(doc: KicadSchematic, item: MoveItem): AlignBox | null {
  const snaps = CONNECTABLE.has(item.type)
  switch (item.type) {
    case 'symbol': {
      const symbol = doc.symbols[item.index]
      return symbol ? { box: symbolBox(doc, symbol), anchor: symbol.position, snaps } : null
    }
    case 'label': {
      const label = doc.labels[item.index]
      return label ? { box: labelExtent(label).box, anchor: label.position, snaps } : null
    }
    case 'wire': {
      const wire = doc.wires[item.index]
      return wire?.points.length
        ? { box: boxOfPoints(wire.points), anchor: wire.points[0], snaps }
        : null
    }
    case 'junction':
    case 'no_connect': {
      const point = (item.type === 'junction' ? doc.junctions : doc.noConnects)[item.index]
      return point ? { box: boxOfPoints([point]), anchor: point, snaps } : null
    }
    case 'sheet': {
      const sheet = doc.sheets[item.index]
      if (!sheet) return null
      const { position, size } = sheet
      return {
        box: boxOfPoints([
          position,
          { x: nm(position.x + size.width), y: nm(position.y + size.height) }
        ]),
        anchor: position,
        snaps
      }
    }
    case 'text': {
      const text = doc.texts[item.index]
      if (!text) return null
      return {
        box: fieldExtent({ value: text.text, position: text.position, effects: text.effects }),
        anchor: text.position,
        snaps
      }
    }
    default: {
      if (!isSheetItemType(item.type)) return null
      const entry = sheetItemAt(doc, item.type, item.index)
      const points = entry ? sheetItemPoints(entry) : []
      if (!entry || !points.length) return null
      return { box: boxOfPoints(points), anchor: sheetItemOrigin(entry) ?? points[0], snaps }
    }
  }
}

/** The shift that puts `anchor` moved by `delta` on the grid, along the moving axis only. */
const snapped = (value: number, anchor: number, grid: Nm): number =>
  grid > 0 ? Math.round((anchor + value) / grid) * grid - anchor : value

const snapDelta = (item: AlignBox, delta: Point, grid: Nm): Point => ({
  x: nm(item.snaps && delta.x !== 0 ? snapped(delta.x, item.anchor.x, grid) : delta.x),
  y: nm(item.snaps && delta.y !== 0 ? snapped(delta.y, item.anchor.y, grid) : delta.y)
})

const EDGE: Record<AlignOp, (box: Box) => number> = {
  left: (box) => box.minX,
  right: (box) => box.maxX,
  top: (box) => box.minY,
  bottom: (box) => box.maxY,
  centerX: (box) => (box.minX + box.maxX) / 2,
  centerY: (box) => (box.minY + box.maxY) / 2
}

/** The target KiCad picks with no locked item and no item under the cursor: the extreme. */
const TARGET: Record<AlignOp, (values: number[]) => number> = {
  left: (values) => Math.min(...values),
  right: (values) => Math.max(...values),
  top: (values) => Math.min(...values),
  bottom: (values) => Math.max(...values),
  centerX: (values) => Math.min(...values),
  centerY: (values) => Math.min(...values)
}

const horizontal = (op: AlignOp): boolean => op === 'left' || op === 'right' || op === 'centerX'

const contains = (box: Box, point: Point): boolean =>
  point.x >= box.minX && point.x <= box.maxX && point.y >= box.minY && point.y <= box.maxY

/**
 * Each item's shift for an align, in the order given. The target is the item
 * under `cursor` when there is one — KiCad's "the item under the cursor" —
 * else the extreme.
 */
export function alignDeltas(items: AlignBox[], op: AlignOp, grid: Nm, cursor?: Point): Point[] {
  if (items.length < 2) return items.map(() => ({ x: nm(0), y: nm(0) }))
  const edge = EDGE[op]
  const under = cursor ? items.find((item) => contains(item.box, cursor)) : undefined
  const target = under ? edge(under.box) : TARGET[op](items.map((item) => edge(item.box)))
  return items.map((item) => {
    const by = Math.round(target - edge(item.box))
    return snapDelta(item, horizontal(op) ? { x: nm(by), y: nm(0) } : { x: nm(0), y: nm(by) }, grid)
  })
}

/** Each item's shift for an even spread by gaps, in the order given; needs three. */
export function distributeDeltas(items: AlignBox[], op: DistributeOp, grid: Nm): Point[] {
  const none = items.map(() => ({ x: nm(0), y: nm(0) }))
  if (items.length < 3) return none
  const across = op === 'horizontal'
  const min = (box: Box): number => (across ? box.minX : box.minY)
  const max = (box: Box): number => (across ? box.maxX : box.maxY)
  const order = items.map((_, index) => index).sort((a, b) => min(items[a].box) - min(items[b].box))
  const first = items[order[0]].box
  const last = items[order[order.length - 1]].box
  const sizes = order.reduce((sum, index) => sum + max(items[index].box) - min(items[index].box), 0)
  const gap = (max(last) - min(first) - sizes) / (order.length - 1)
  const deltas = [...none]
  let at = max(first) + gap
  for (const index of order.slice(1, -1)) {
    const box = items[index].box
    const by = Math.round(at - min(box))
    deltas[index] = snapDelta(
      items[index],
      across ? { x: nm(by), y: nm(0) } : { x: nm(0), y: nm(by) },
      grid
    )
    at += max(box) - min(box) + gap
  }
  return deltas
}

/** Items that can be aligned, with what aligning reads of each. */
export function alignableItems(
  doc: KicadSchematic,
  items: MoveItem[]
): Array<{ item: MoveItem; box: AlignBox }> {
  return items.flatMap((item) => {
    const box = alignBoxOf(doc, item)
    return box ? [{ item, box }] : []
  })
}

export interface ItemShift {
  item: MoveItem
  delta: Point
}

/**
 * The wire plan for items each shifting by its own delta: every moved
 * connection point, planned once over the sheet as it is. Read before writing.
 */
export function planItemShifts(doc: KicadSchematic, shifts: ItemShift[], grid: Nm): MovePlan {
  const moving = shifts.filter(({ delta }) => delta.x !== 0 || delta.y !== 0)
  const moved = moving.flatMap(({ item, delta }) =>
    movedPointsForTranslation(doc, selectionOf([item]), delta)
  )
  return planMovedPoints(doc, moved, selectionOf(moving.map(({ item }) => item)), {
    grid,
    wires: true,
    carryAttached: true
  })
}

/** Write the shifts and the plan made for them. */
export function applyItemShifts(doc: KicadSchematic, shifts: ItemShift[], plan: MovePlan): void {
  for (const { item, delta } of shifts) {
    if (delta.x !== 0 || delta.y !== 0) translateSchematicItems(doc, [item], delta)
  }
  applyMovePlan(doc, plan)
}
