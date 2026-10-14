/**
 * Copper drawings as items beside the spatial index's copper, for the checks
 * and connectivity (design-health-workstream.md). The index holds
 * tracks, vias and pads for everything that edits and routes; KiCad's DRC and
 * connectivity read drawings as well, and these are them, one item per KiCad
 * item: a stroked, filled rectangle is one item of five pieces.
 *
 * What each item is, as KiCad 10 takes it:
 * - A board graphic on copper is connected (`PCB_SHAPE::IsConnected`): it has
 *   a net and joins the copper it touches. A footprint's graphic and any text
 *   have no net and join nothing.
 * - A graphic is its strokes and, when filled, its inside; a text is its
 *   glyph strokes (`PCB_TEXT::GetEffectiveShape`), not the box the filler
 *   keeps clear of.
 * - Nets propagate on load (`CN_CONNECTIVITY_ALGO::PropagateNets`): a board
 *   graphic in a cluster of touching copper — tracks, vias, pads and graphics,
 *   whatever their nets, zones left out — takes the net of the cluster's pads
 *   when they have one, else the one net its other copper agrees on. Tracks
 *   and vias keep their file nets here, as they do throughout.
 *
 * Ids continue the index's own, so a check can key both by id. Graphics come
 * before text, so a graphic's id does not depend on how text variables expand.
 */
import type { KicadBoard } from '../kicad/board'
import { PackedRTree } from '../geometry/packedRTree'
import { difference, union } from '../geometry/clip'
import { rotatedRectOutline, shapeOutlines } from './shapeOutline'
import { copperDrawings, type BoardDrawing, type DrawingKind } from './boardDrawings'
import {
  polyShape,
  shapeToShape,
  type BoardSpatialIndex,
  type CopperItem,
  type CopperShape,
  type Pt
} from './spatialIndex'

export interface DrawingItem extends CopperItem {
  ref: { type: 'drawing'; index: number }
  drawing: DrawingKind
  /** A board graphic: it has a net (even 0) and joins what it touches. */
  connected: boolean
  /** DRC reads its net, 0 or not: a board graphic, text box or table cell (`boardDrawings.ts`). */
  netted: boolean
  /** In DRC's copper index; a footprint's table meets only the zones. */
  inCopperTree: boolean
  /** The footprint that draws it; absent for the board's own. */
  fp?: number
  uuid?: string
  /** A knockout text: copper round its glyphs, read by its own rules. */
  knockout: boolean
  /** Where it connects, for the ratsnest; empty for what never connects. */
  anchors: readonly Pt[]
  /** Its net as the file gives it, before propagation. */
  fileNet: number
}

export interface DrawingSet {
  readonly items: readonly DrawingItem[]
  /** The drawings whose boxes meet a box. */
  query(minX: number, minY: number, maxX: number, maxY: number): DrawingItem[]
  /** The item with an id, if it is one of these. */
  byId(id: number): DrawingItem | undefined
}

/** Copper this close touches (mm): the connectivity engine's `CONNECT_EPSILON`. */
const TOUCH = 1e-4

/**
 * A board's copper drawings as items after the index's; cached per index and
 * variables. Without `variables` there is no text: connectivity's view, which
 * reads only the graphics that conduct — whose ids are the same either way.
 */
export function drawingItems(
  board: KicadBoard,
  index: BoardSpatialIndex,
  variables?: Readonly<Record<string, string>>
): DrawingSet {
  let cached = cache.get(index)
  if (!cached) {
    cached = []
    cache.set(index, cached)
  }
  const hit = cached.find((entry) => entry.board === board && entry.variables === variables)
  if (hit) return hit.set
  const set = build(board, index, variables)
  cached.push({ board, variables, set })
  return set
}

const cache = new WeakMap<
  BoardSpatialIndex,
  Array<{
    board: KicadBoard
    variables: Readonly<Record<string, string>> | undefined
    set: DrawingSet
  }>
>()

function build(
  board: KicadBoard,
  index: BoardSpatialIndex,
  variables: Readonly<Record<string, string>> | undefined
): DrawingSet {
  // Pieces by the item they are part of, in the order they were read.
  const bySource = new Map<number, BoardDrawing[]>()
  for (const pieces of copperDrawings(board, variables ?? {}, variables !== undefined).values())
    for (const piece of pieces) {
      const list = bySource.get(piece.source) ?? []
      list.push(piece)
      bySource.set(piece.source, list)
    }
  const groups = [...bySource.entries()].sort(([a], [b]) => a - b).map(([, pieces]) => pieces)
  const ordered = [
    ...groups.filter((pieces) => pieces[0].drawing === 'graphic'),
    ...groups.filter((pieces) => pieces[0].drawing !== 'graphic')
  ]

  const items: DrawingItem[] = []
  for (const pieces of ordered) {
    const first = pieces[0]
    // A text is its glyphs; everything else its pieces, a dimension's text by its glyphs.
    const shapes: CopperShape[] = pieces.flatMap((p) => p.glyphs ?? [p.shape])
    if (shapes.length === 0) continue
    const shape: CopperShape = first.knockout
      ? knockoutShape(first)
      : shapes.length === 1
        ? shapes[0]
        : { kind: 'compound', parts: shapes }
    const grown = first.knockout && first.knockoutMargin ? first.knockoutMargin : 0
    items.push({
      id: index.items.length + items.length,
      ref: { type: 'drawing', index: items.length },
      net: first.net,
      fileNet: first.net,
      layers: [first.layer],
      shape,
      minX: Math.min(...pieces.map((p) => p.minX)) - grown,
      minY: Math.min(...pieces.map((p) => p.minY)) - grown,
      maxX: Math.max(...pieces.map((p) => p.maxX)) + grown,
      maxY: Math.max(...pieces.map((p) => p.maxY)) + grown,
      drawing: first.drawing,
      connected: first.connected,
      netted: first.netted,
      inCopperTree: first.inCopperTree,
      ...(first.fp !== undefined ? { fp: first.fp } : {}),
      ...(first.uuid ? { uuid: first.uuid } : {}),
      knockout: !!first.knockout,
      anchors: first.connected ? (first.anchors ?? []) : []
    })
  }

  const boxes = new Float64Array(items.length * 4)
  items.forEach((item, i) => {
    boxes[i * 4] = item.minX
    boxes[i * 4 + 1] = item.minY
    boxes[i * 4 + 2] = item.maxX
    boxes[i * 4 + 3] = item.maxY
  })
  const tree = new PackedRTree(boxes, items.length)
  const base = index.items.length
  const set: DrawingSet = {
    items,
    query(minX, minY, maxX, maxY) {
      const out: DrawingItem[] = []
      tree.search(minX, minY, maxX, maxY, (i) => out.push(items[i]))
      return out
    },
    byId: (id) => items[id - base]
  }
  propagateNets(set, index)
  return set
}

/**
 * A knockout text's copper (`PCB_TEXT::TransformTextToPolySet`): its box grown
 * by the margin, less its glyphs. Before the geometry engine has loaded, the
 * grown box alone.
 */
function knockoutShape(text: BoardDrawing): CopperShape {
  const box = text.shape
  if (box.kind !== 'rrect') return box
  const margin = text.knockoutMargin ?? 0
  const grown = { ...box, halfW: box.halfW + margin, halfH: box.halfH + margin }
  const glyphs = union(
    (text.glyphs ?? []).flatMap((g) => shapeOutlines(g, 0).map((outer) => ({ outer, holes: [] }))),
    []
  )
  const copper = difference(
    [
      {
        outer: rotatedRectOutline(box.cx, box.cy, grown.halfW, grown.halfH, box.rotation),
        holes: []
      }
    ],
    glyphs
  )
  const parts = copper.map((region) => polyShape([region.outer, ...region.holes]))
  if (parts.length === 0) return grown
  return parts.length === 1 ? parts[0] : { kind: 'compound', parts }
}

/**
 * KiCad's net propagation, for board graphics: each cluster of touching
 * copper that holds one takes its pads' net, if they share one, else the one
 * net its other copper agrees on; a cluster of pads of two nets keeps every
 * net as the file has it.
 */
function propagateNets(set: DrawingSet, index: BoardSpatialIndex): void {
  const done = new Set<number>()
  for (const start of set.items) {
    if (!start.connected || done.has(start.id)) continue
    const seen = new Set<number>([start.id])
    const queue: CopperItem[] = [start]
    const graphics: DrawingItem[] = []
    const padNets = new Set<number>()
    const otherNets = new Set<number>()
    while (queue.length > 0) {
      const item = queue.pop()!
      const drawing = set.byId(item.id)
      if (drawing) {
        graphics.push(drawing)
        done.add(drawing.id)
        if (drawing.fileNet > 0) otherNets.add(drawing.fileNet)
      } else if (item.ref.type === 'pad') {
        if (item.net > 0) padNets.add(item.net)
      } else if (item.net > 0) otherNets.add(item.net)
      const [minX, minY, maxX, maxY] = [
        item.minX - TOUCH,
        item.minY - TOUCH,
        item.maxX + TOUCH,
        item.maxY + TOUCH
      ]
      const near: CopperItem[] = [
        ...index.query(minX, minY, maxX, maxY),
        ...set.query(minX, minY, maxX, maxY).filter((d) => d.connected)
      ]
      for (const other of near) {
        if (seen.has(other.id)) continue
        if (!other.layers.some((layer) => item.layers.includes(layer))) continue
        if (shapeToShape(item.shape, other.shape) > TOUCH) continue
        seen.add(other.id)
        queue.push(other)
      }
    }
    const origin =
      padNets.size === 1
        ? [...padNets][0]
        : padNets.size === 0 && otherNets.size === 1
          ? [...otherNets][0]
          : 0
    if (origin > 0) for (const graphic of graphics) graphic.net = origin
  }
}
