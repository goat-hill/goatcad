/**
 * KiCad's net propagation (`CN_CONNECTIVITY_ALGO::PropagateNets`), which KiCad
 * runs after every edit and writes into the board, so copper takes the net of
 * what it is joined to. The board session applies it round each command
 * (`boardSession.ts`); a file is read with its own nets until an edit reaches
 * them, since opening never touches a file.
 *
 * - Copper that touches — tracks, vias, pads and board graphics, whatever
 *   their nets, zones left out — is one cluster; two pads (or free vias) of
 *   different nets do not join each other directly.
 * - A cluster takes the net of its pads when they agree on one (a free pad,
 *   `unconnected-(…)` of pin type free, does not count); pads of two nets
 *   leave it as it is. With no pads it takes the one net its copper agrees
 *   on, where KiCad takes the first its memory order meets: with two, we
 *   change nothing.
 * - A via joined to nothing but zone fills takes a fill's net: its own if a
 *   fill it touches has it, else the lowest.
 *
 * Tracks and vias take the net; a free via keeps its own. A board graphic's
 * net is propagated where it is read (`drawingItems.ts`).
 */
import {
  allZones,
  updateSegmentInAST,
  updateTrackArcInAST,
  updateViaInAST,
  type KicadBoard
} from '../kicad/board'
import { nmToMm, type Nm } from '../kicad/coordinates'
import { isCopperLayer } from '../kicad/layers'
import { findChild, getFirstAtomValue, getToken, type SExprNode } from '../kicad/sexpr'
import { parseFlag } from '../kicad/footprint'
import {
  CONNECT_EPSILON,
  connectFill,
  itemTouchesFill,
  itemsConnect,
  zoneMayConnect,
  type ZoneFill
} from './boardConnectivity'
import { drawingItems } from './drawingItems'
import type { BoardSpatialIndex, CopperItem } from './spatialIndex'
import type { Box } from '../geometry/polygon'

export interface NetChange {
  ref: { type: 'segment' | 'tarc' | 'via'; index: number }
  net: number
}

/**
 * The tracks and vias whose net propagation changes, over the clusters that
 * hold the items at `seeds` (ids into the index) or meet `boxes`.
 */
export function netChanges(
  board: KicadBoard,
  index: BoardSpatialIndex,
  seeds: Iterable<number>,
  boxes: Iterable<Box> = [],
  lonelyVias: Iterable<number> = []
): NetChange[] {
  const drawings = drawingItems(board, index)
  const item = (id: number): CopperItem => index.items[id] ?? drawings.byId(id)!
  const conducting = drawings.items.some((d) => d.connected)
  const near = (box: Box, grow: number): CopperItem[] => {
    const [minX, minY, maxX, maxY] = [
      box.minX - grow,
      box.minY - grow,
      box.maxX + grow,
      box.maxY + grow
    ]
    const out = index.query(minX, minY, maxX, maxY)
    if (conducting)
      for (const d of drawings.query(minX, minY, maxX, maxY)) if (d.connected) out.push(d)
    return out
  }
  const netOf = (c: CopperItem): number => drawings.byId(c.id)?.fileNet ?? c.net
  const freeVia = (c: CopperItem): boolean =>
    c.ref.type === 'via' && parseFlag(board.vias[c.ref.index]._raw, 'free')
  const fixed = (c: CopperItem): boolean => c.ref.type === 'pad' || freeVia(c)
  const freePad = (c: CopperItem): boolean => {
    if (c.ref.type !== 'pad') return false
    const pad = board.footprints[c.ref.index].footprint.pads[c.ref.pad]
    const name = pad.net?.name ?? ''
    return (
      pad.pinType === 'free' && name.slice(name.lastIndexOf('/') + 1).startsWith('unconnected-(')
    )
  }
  const joined = (a: CopperItem, b: CopperItem): boolean =>
    !(fixed(a) && fixed(b) && netOf(a) !== netOf(b)) && itemsConnect(board, a, b).length > 0

  const start = new Set(seeds)
  for (const box of boxes) for (const c of near(box, CONNECT_EPSILON)) start.add(c.id)

  const changes: NetChange[] = []
  const change = (c: CopperItem, net: number): void => {
    if (netOf(c) === net || freeVia(c)) return
    if (c.ref.type === 'segment' || c.ref.type === 'tarc' || c.ref.type === 'via')
      changes.push({ ref: { type: c.ref.type, index: c.ref.index }, net })
  }
  // Vias a zone change may reach: only one joined to nothing else is the zones' to net.
  for (const id of lonelyVias)
    if (
      !start.has(id) &&
      !near(item(id), CONNECT_EPSILON).some((o) => o.id !== id && joined(item(id), o))
    )
      start.add(id)
  const visited = new Set<number>()
  // The zones' fills, read only once a lone via meets a zone's box.
  const fillsNear = (c: CopperItem): ZoneFill[] => {
    const out: ZoneFill[] = []
    for (const zone of allZones(board)) {
      const box = fillBox(zone)
      if (!box || c.maxX < box.minX || c.minX > box.maxX || c.maxY < box.minY || c.minY > box.maxY)
        continue
      out.push(...zoneFills(zone))
    }
    return out
  }
  for (const seed of start) {
    if (visited.has(seed)) continue
    visited.add(seed)
    const members: CopperItem[] = []
    const queue = [item(seed)]
    while (queue.length > 0) {
      const current = queue.pop()!
      members.push(current)
      for (const other of near(current, CONNECT_EPSILON)) {
        if (visited.has(other.id) || !joined(current, other)) continue
        visited.add(other.id)
        queue.push(other)
      }
    }
    // A via joined to nothing else: its net is the zones' to give.
    const via = members[0]
    if (members.length === 1 && via.ref.type === 'via' && !freeVia(via)) {
      // A zone of no net gives no net: it never takes one from the via either.
      const touched = fillsNear(via)
        .filter(
          (fill) =>
            fill.net > 0 && zoneMayConnect(board, via.ref, fill.layer) && itemTouchesFill(via, fill)
        )
        .map((fill) => fill.net)
      if (touched.length > 0) {
        if (!touched.includes(netOf(via))) change(via, Math.min(...touched))
        continue
      }
    }
    const padNets = new Set<number>()
    const nets = new Set<number>()
    for (const c of members) {
      const net = netOf(c)
      if (net <= 0) continue
      nets.add(net)
      if (c.ref.type === 'pad' && !freePad(c)) padNets.add(net)
    }
    const origin = padNets.size > 0 ? padNets : nets
    if (origin.size === 1) {
      const net = [...origin][0]
      for (const c of members) change(c, net)
    }
  }
  return changes
}

type Zone = KicadBoard['zones'][number]

// By a zone's fill array, which a refill replaces; the zone object outlives it.
const fillsOf = new WeakMap<Zone['filledPolys'], { net: number; fills: ZoneFill[] }>()
const boxOf = new WeakMap<Zone['filledPolys'], Box | null>()

/** A zone's stored fills as connectivity probes them, a zone of no net included. */
export function zoneFills(zone: Zone): ZoneFill[] {
  const net = zone.net ?? 0
  const cached = fillsOf.get(zone.filledPolys)
  if (cached?.net === net) return cached.fills
  const fills = zone.isKeepout
    ? []
    : zone.filledPolys.flatMap((poly, p) => {
        const layer = poly.layer ?? zone.layers[0]
        if (!layer || !isCopperLayer(layer) || poly.points.length < 3) return []
        const points = poly.points.map((pt) => ({ x: nmToMm(pt.x), y: -nmToMm(pt.y) }))
        return [connectFill(points, net, layer, -1, p)]
      })
  fillsOf.set(zone.filledPolys, { net, fills })
  return fills
}

/** The box of a zone's stored fills (world mm, y up), or null when it has none. */
function fillBox(zone: Zone): Box | null {
  const cached = boxOf.get(zone.filledPolys)
  if (cached !== undefined) return cached
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity]
  for (const poly of zone.filledPolys)
    for (const pt of poly.points) {
      minX = Math.min(minX, pt.x)
      minY = Math.min(minY, pt.y)
      maxX = Math.max(maxX, pt.x)
      maxY = Math.max(maxY, pt.y)
    }
  // y flips: the file's top is the world's bottom.
  const box =
    minX <= maxX
      ? {
          minX: nmToMm(minX as Nm),
          minY: -nmToMm(maxY as Nm),
          maxX: nmToMm(maxX as Nm),
          maxY: -nmToMm(minY as Nm)
        }
      : null
  boxOf.set(zone.filledPolys, box)
  return box
}

/** Write the changes into the board, each item's node marked for the command's undo. */
export function applyNetChanges(board: KicadBoard, changes: readonly NetChange[]): void {
  for (const { ref, net } of changes) {
    if (ref.type === 'segment') updateSegmentInAST(board.segments[ref.index], { net }, board)
    else if (ref.type === 'tarc') updateTrackArcInAST(board.trackArcs[ref.index], { net }, board)
    else updateViaInAST(board.vias[ref.index], { net }, board)
  }
}

/** What a command's changed top-level nodes put in play, read from the board after it. */
const COPPER_TOKENS = new Set(['segment', 'arc', 'via', 'footprint', 'zone'])

type CopperArrays = Parameters<typeof BoardSpatialIndex.buildFrom>[1]

const ownerRaw = (arrays: CopperArrays, ref: CopperItem['ref']): unknown =>
  ref.type === 'segment'
    ? arrays.segments[ref.index]?._raw
    : ref.type === 'tarc'
      ? arrays.trackArcs[ref.index]?._raw
      : ref.type === 'via'
        ? arrays.vias[ref.index]?._raw
        : ref.type === 'pad'
          ? arrays.footprints[ref.index]?._raw
          : undefined

/**
 * The net changes a command calls for (`boardSession.ts`): over the clusters
 * of the copper it added or changed, and of what lay where its changed copper
 * was (`before`, the index and arrays of the board it started from, when
 * there is one); a zone it changed reaches the vias in its fill. Null when it
 * changed no copper.
 */
export function propagationFor(
  board: KicadBoard,
  raws: ReadonlySet<SExprNode>,
  index: () => BoardSpatialIndex,
  before?: { index: BoardSpatialIndex; arrays: CopperArrays }
): NetChange[] | null {
  const tokens = [...raws].map(getToken)
  const graphics = tokens.some((t) => t?.startsWith('gr_'))
  if (!graphics && !tokens.some((t) => t !== null && COPPER_TOKENS.has(t))) return null
  const after = index()
  const seeds = after.items.filter((item) => raws.has(ownerRaw(board, item.ref) as SExprNode))
  const seedIds = seeds.map((item) => item.id)
  if (graphics) {
    const uuids = new Set(
      [...raws].flatMap((raw) => {
        const uuid = raw.type === 'list' ? findChild(raw, 'uuid') : null
        return uuid ? [getFirstAtomValue(uuid)] : []
      })
    )
    for (const d of drawingItems(board, after).items)
      if (d.connected && d.uuid && uuids.has(d.uuid)) seedIds.push(d.id)
  }
  const boxes = before
    ? before.index.items.filter((item) => raws.has(ownerRaw(before.arrays, item.ref) as SExprNode))
    : []
  const vias: number[] = []
  board.zones.forEach((zone) => {
    if (!raws.has(zone._raw)) return
    const box = fillBox(zone)
    if (!box) return
    for (const item of after.query(box.minX, box.minY, box.maxX, box.maxY))
      if (item.ref.type === 'via') vias.push(item.id)
  })
  return netChanges(board, after, seedIds, boxes, vias)
}
