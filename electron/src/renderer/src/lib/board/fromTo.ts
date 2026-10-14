/**
 * The custom rules' `fromTo('U1-1', 'U2-*')`: the copper on the path between
 * two pads, as KiCad's `FROM_TO_CACHE` finds it. Each pad answers to two
 * names, `REF-NUM` and `REF`, matched as case-insensitive wildcards. From
 * every pad the first selector names, the path runs to the one pad of its
 * connected copper the second names — none where it names two or more — by
 * breadth-first search over what joins what: pads, tracks, vias and zone
 * islands. An item is on the path when the search's path passes through it;
 * where two paths reach the far pad, the second is the one kept.
 */
import { allZones, type KicadBoard } from '../kicad/board'
import { parseFlag } from '../kicad/footprint'
import { itemTouchesFill, itemsConnect, zoneMayConnect, CONNECT_EPSILON } from './boardConnectivity'
import type { ZoneFill } from './boardConnectivity'
import { zoneFills } from './netPropagation'
import type { BoardSpatialIndex, CopperItem } from './spatialIndex'

/** An item's key, as the rules know it (`RuleItem.itemKey`). */
export const itemKeyOf = (ref: CopperItem['ref']): string =>
  ref.type === 'pad' ? `pad:${ref.index}:${ref.pad}` : `${ref.type}:${ref.index}`
const refKey = itemKeyOf

/** A node of the search: a copper item, or one island of a zone's fill. */
type Node = { item: CopperItem; key: string } | { fill: ZoneFill; key: string }

/** How many partial paths the search may hold before it gives up: a guard against nets KiCad would grind on. */
const SEARCH_LIMIT = 200_000

export interface FromTo {
  /**
   * Whether the item (by its rules key, `refKey` or `zone:<i>`, and its net)
   * is on a from–to path. A path's copper is its pads' net, so only the
   * paths from pads of the item's own net are searched.
   */
  onPath(key: string, net: number, from: string, to: string): boolean
}

export function fromToPaths(board: KicadBoard, index: BoardSpatialIndex): FromTo {
  const cache = new Map<string, Set<string>>()
  const fillsByNet = new Map<number, Array<{ fill: ZoneFill; zone: number }>>()
  allZones(board).forEach((zone, zoneIndex) => {
    if (zone.isKeepout) return
    for (const fill of zoneFills(zone)) {
      if (fill.net <= 0) continue
      const list = fillsByNet.get(fill.net) ?? []
      list.push({ fill, zone: zoneIndex })
      fillsByNet.set(fill.net, list)
    }
  })
  const fixed = (c: CopperItem): boolean =>
    c.ref.type === 'pad' ||
    (c.ref.type === 'via' && parseFlag(board.vias[c.ref.index]._raw, 'free'))

  // Each node's neighbours, found when first asked for.
  const neighbours = new Map<Node, Node[]>()
  const itemNodes = new Map<number, Node>()
  const fillNodes = new Map<ZoneFill, Node>()
  const itemNode = (item: CopperItem): Node => {
    let node = itemNodes.get(item.id)
    if (!node) itemNodes.set(item.id, (node = { item, key: refKey(item.ref) }))
    return node
  }
  const fillNode = (fill: ZoneFill, zone: number): Node => {
    let node = fillNodes.get(fill)
    if (!node) fillNodes.set(fill, (node = { fill, key: `zone:${zone}` }))
    return node
  }
  const fillZone = new Map<ZoneFill, number>()
  for (const list of fillsByNet.values())
    for (const { fill, zone } of list) fillZone.set(fill, zone)
  const joinedTo = (node: Node): Node[] => {
    let out = neighbours.get(node)
    if (out) return out
    out = []
    if ('item' in node) {
      const a = node.item
      for (const b of index.query(
        a.minX - CONNECT_EPSILON,
        a.minY - CONNECT_EPSILON,
        a.maxX + CONNECT_EPSILON,
        a.maxY + CONNECT_EPSILON
      )) {
        if (b.id === a.id) continue
        // Two items whose nets cannot change join only on one net.
        if (fixed(a) && fixed(b) && a.net !== b.net) continue
        if (itemsConnect(board, a, b).length > 0) out.push(itemNode(b))
      }
      for (const { fill, zone } of fillsByNet.get(a.net) ?? [])
        if (zoneMayConnect(board, a.ref, fill.layer) && itemTouchesFill(a, fill))
          out.push(fillNode(fill, zone))
    } else {
      const fill = node.fill
      for (const b of index.query(fill.minX, fill.minY, fill.maxX, fill.maxY))
        if (
          b.net === fill.net &&
          zoneMayConnect(board, b.ref, fill.layer) &&
          itemTouchesFill(b, fill)
        )
          out.push(itemNode(b))
    }
    out.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0))
    neighbours.set(node, out)
    return out
  }

  // Every pad, by both its names.
  const endpoints: Array<{ name: string; pad: CopperItem }> = []
  for (const item of index.items) {
    if (item.ref.type !== 'pad') continue
    const bfp = board.footprints[item.ref.index]
    const pad = bfp.footprint.pads[item.ref.pad]
    const reference = bfp.reference ?? ''
    endpoints.push({ name: `${reference}-${pad.number}`, pad: item })
    endpoints.push({ name: reference, pad: item })
  }

  /** Every pad joined to a pad by copper, zones included in the joining. */
  const clusterPads = (start: Node): CopperItem[] => {
    const seen = new Set<Node>([start])
    const queue = [start]
    const pads: CopperItem[] = []
    while (queue.length > 0) {
      const node = queue.pop()!
      if ('item' in node && node.item.ref.type === 'pad' && node !== start) pads.push(node.item)
      for (const next of joinedTo(node))
        if (!seen.has(next)) {
          seen.add(next)
          queue.push(next)
        }
    }
    return pads
  }

  /** The search's path from one node to another, the second found where two reach it. */
  const pathBetween = (from: Node, to: Node): Node[] | null => {
    const queue: Node[][] = [[from]]
    // How many queued paths hold each node: a node any of them holds is not
    // queued again, as KiCad's search passes it over.
    const queued = new Map<Node, number>([[from, 1]])
    const hold = (path: Node[], by: number): void => {
      for (const node of path) queued.set(node, (queued.get(node) ?? 0) + by)
    }
    let head = 0
    let found: Node[] | null = null
    while (head < queue.length) {
      const path = queue[head]
      queue[head++] = []
      hold(path, -1)
      const last = path[path.length - 1]
      if (last === to) {
        if (found) return path
        found = path
      }
      for (const next of joinedTo(last)) {
        if (path.includes(next) || (queued.get(next) ?? 0) > 0) continue
        const longer = [...path, next]
        queue.push(longer)
        hold(longer, 1)
        if (queue.length > SEARCH_LIMIT) return found
      }
    }
    return found
  }

  const pathsFor = (from: string, to: string, net: number): Set<string> => {
    const key = `${from}\u0000${to}\u0000${net}`
    let onPath = cache.get(key)
    if (onPath) return onPath
    onPath = new Set()
    const wild = wildcardMatcher
    for (const source of endpoints) {
      if (source.pad.net !== net || !wild(from, source.name)) continue
      let target: CopperItem | null = null
      let count = 0
      for (const pad of clusterPads(itemNode(source.pad)))
        for (const end of endpoints)
          if (end.pad === pad && wild(to, end.name)) {
            count++
            target = pad
          }
      if (count !== 1 || !target) continue
      const path = pathBetween(itemNode(source.pad), itemNode(target))
      for (const node of path ?? []) onPath.add(node.key)
    }
    cache.set(key, onPath)
    return onPath
  }

  return { onPath: (key, net, from, to) => pathsFor(from, to, net).has(key) }
}

/** KiCad's `WildCompareString` without case: `*` and `?` over the whole name. */
function wildcardMatcher(pattern: string, text: string): boolean {
  const p = pattern.toUpperCase()
  const t = text.toUpperCase()
  let i = 0
  let j = 0
  let star = -1
  let mark = 0
  while (j < t.length) {
    if (i < p.length && (p[i] === '?' || p[i] === t[j])) {
      i++
      j++
    } else if (i < p.length && p[i] === '*') {
      star = i++
      mark = j
    } else if (star >= 0) {
      i = star + 1
      j = ++mark
    } else return false
  }
  while (i < p.length && p[i] === '*') i++
  return i === p.length
}
