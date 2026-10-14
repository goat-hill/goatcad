/**
 * Auto-complete: route the rest of a connection in one gesture
 * (PNS `ROUTER::Finish` is the reference).
 *
 * KiCad's insight, taken whole: this is NOT a search algorithm. It is a
 * synthetic cursor move to the nearest unconnected ratsnest anchor, iterated
 * to a fixed point (walkaround's partial "hug" answers advance the head a
 * little further each round), then an ordinary commit if the head actually
 * arrived. Five rounds, like PNS — past that the greedy walk is not going
 * to get there and the user keeps the progress made.
 */

import type { KicadBoard } from '../../kicad/board'
import type { BoardSpatialIndex, CopperItem, Pt } from '../spatialIndex'
import { snapPointsOf } from '../spatialIndex'
import { computeConnectivity, spanningPairs } from '../boardConnectivity'
import type { ProposedSegment, RouteProposal } from './engine'

const FINISH_TRIES = 5

const samePt = (a: Pt, b: Pt): boolean => Math.abs(a.x - b.x) <= 1e-6 && Math.abs(a.y - b.y) <= 1e-6

/**
 * The anchor auto-complete should route toward: the nearest connection point
 * of the routed net that is NOT in the cluster the trace departed from, and
 * the copper it is on. `origin` is where the trace started (its cluster is
 * "already connected"); `from` is the tail the distance is measured from;
 * only copper on `layer`, when given, can be arrived at (R30). Null when the
 * net has nothing left to connect.
 */
export function nearestUnconnectedAnchor(
  board: KicadBoard,
  index: BoardSpatialIndex,
  net: number,
  origin: Pt,
  from: Pt,
  layer?: string
): UnconnectedAnchor | null {
  const anchors = routeNetClusters(board, index, net, origin)
    .others.flat()
    .filter((a) => layer === undefined || a.item.layers.includes(layer))
  return nearestAnchor(anchors, from)
}

export interface UnconnectedAnchor {
  point: Pt
  item: CopperItem
}

/**
 * `net`'s copper by cluster, as anchors: the cluster holding the copper at
 * `origin` (the one a route left), and every other. Both empty when the net is
 * whole.
 */
export interface RouteNetClusters {
  origin: UnconnectedAnchor[]
  others: UnconnectedAnchor[][]
}

export function routeNetClusters(
  board: KicadBoard,
  index: BoardSpatialIndex,
  net: number,
  origin: Pt
): RouteNetClusters {
  const conn = computeConnectivity(board, index, new Set([net])).nets.get(net)
  if (!conn || conn.clusterCount < 2) return { origin: [], others: [] }

  // The cluster the trace departed from: the one owning the net item nearest
  // to the origin (the trace's first click snapped onto it).
  const originItem = index
    .near(origin.x, origin.y, 1, { net })
    .map((h) => h.item)
    .find((item) => conn.clusterOfItem.has(item.id))
  const originCluster = originItem ? conn.clusterOfItem.get(originItem.id) : undefined

  const byCluster = new Map<number, UnconnectedAnchor[]>()
  for (const [id, cluster] of conn.clusterOfItem) {
    const item = index.items[id]
    if (!item) continue
    let anchors = byCluster.get(cluster)
    if (!anchors) byCluster.set(cluster, (anchors = []))
    for (const p of snapPointsOf(item)) anchors.push({ point: { ...p }, item })
  }
  const others: UnconnectedAnchor[][] = []
  for (const [cluster, anchors] of byCluster) {
    if (cluster !== originCluster && anchors.length > 0) others.push(anchors)
  }
  return { origin: originCluster === undefined ? [] : (byCluster.get(originCluster) ?? []), others }
}

/**
 * The routed net's ratsnest while a route is in progress, as KiCad's dynamic
 * ratsnest: the route (`joined`, the points of its copper) belongs to the
 * cluster it left; the lead line (F7) runs from the head's end to the nearest
 * anchor of another cluster and stands for the airwire to that cluster; the
 * rest of the net spans from both. So the airwire the route replaces is not
 * drawn beside the line that replaces it.
 */
export function routeRatsnest(
  clusters: { origin: readonly Pt[]; others: ReadonlyArray<readonly Pt[]> },
  joined: readonly Pt[],
  head: Pt
): { lead: { from: Pt; to: Pt } | null; airwires: Array<{ from: Pt; to: Pt }> } {
  let target = -1
  let to: Pt | null = null
  let best = Infinity
  clusters.others.forEach((anchors, c) => {
    for (const p of anchors) {
      const d = Math.hypot(p.x - head.x, p.y - head.y)
      if (d < best) {
        best = d
        to = p
        target = c
      }
    }
  })
  if (target < 0) return { lead: null, airwires: [] }
  const wrap = (pts: readonly Pt[]): Array<{ p: Pt }> => pts.map((p) => ({ p }))
  const reached = [
    ...wrap(clusters.origin),
    ...wrap(joined),
    { p: head },
    ...wrap(clusters.others[target])
  ]
  const rest = clusters.others.filter((_, c) => c !== target).map(wrap)
  return {
    lead: best > 1e-6 ? { from: head, to: to! } : null,
    airwires: spanningPairs([reached, ...rest]).map(([a, b]) => ({ from: a.p, to: b.p }))
  }
}

/** The anchor nearest `from`. */
export function nearestAnchor(
  anchors: readonly UnconnectedAnchor[],
  from: Pt
): UnconnectedAnchor | null {
  let best: UnconnectedAnchor | null = null
  let bestDist = Infinity
  for (const anchor of anchors) {
    const d = Math.hypot(anchor.point.x - from.x, anchor.point.y - from.y)
    if (d < bestDist) {
      bestDist = d
      best = anchor
    }
  }
  return best
}

export interface FinishResult {
  /** Everything proposed across the rounds, in commit order. */
  segments: ProposedSegment[]
  /** Where the head ended up. */
  endsAt: Pt
  /** True when the head actually reached the target. */
  arrived: boolean
  /** How many rounds added copper. */
  rounds: number
}

/**
 * Iterate "move the cursor to the target" until the head stops advancing —
 * `propose` is the caller's mode-appropriate engine call (plain walkaround,
 * or the shove session, which then auto-completes THROUGH traffic).
 */
export function attemptFinish(
  tail: Pt,
  target: Pt,
  propose: (tail: Pt, cursor: Pt) => RouteProposal
): FinishResult {
  const segments: ProposedSegment[] = []
  let rounds = 0
  let head = { ...tail }
  for (let round = 0; round < FINISH_TRIES; round++) {
    const p = propose(head, target)
    if (p.blocked || p.segments.length === 0) break
    segments.push(...p.segments)
    rounds++
    const advanced = !samePt(p.endsAt, head)
    head = { ...p.endsAt }
    if (samePt(head, target) || !advanced) break
  }
  return { segments, endsAt: head, arrived: samePt(head, target), rounds }
}

/** A segment a finish laid: straight unless `mid` makes it an arc. */
interface LaidSegment {
  x0: number
  y0: number
  x1: number
  y1: number
  width: number
  mid?: Pt
}

const LAID_EPS = 1e-6

/** The point of segment s nearest p, and how far p is from it. */
const nearestOn = (s: LaidSegment, p: Pt): { at: Pt; dist: number } => {
  const ex = s.x1 - s.x0
  const ey = s.y1 - s.y0
  const len2 = ex * ex + ey * ey
  const t =
    len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - s.x0) * ex + (p.y - s.y0) * ey) / len2))
  const at = { x: s.x0 + t * ex, y: s.y0 + t * ey }
  return { at, dist: Math.hypot(p.x - at.x, p.y - at.y) }
}

/** Where segments a and b properly cross, or null. */
const crossing = (a: LaidSegment, b: LaidSegment): Pt | null => {
  const rx = a.x1 - a.x0
  const ry = a.y1 - a.y0
  const sx = b.x1 - b.x0
  const sy = b.y1 - b.y0
  const denom = rx * sy - ry * sx
  if (Math.abs(denom) < 1e-12) return null
  const qx = b.x0 - a.x0
  const qy = b.y0 - a.y0
  const t = (qx * sy - qy * sx) / denom
  const u = (qx * ry - qy * rx) / denom
  if (t < 0 || t > 1 || u < 0 || u > 1) return null
  return { x: a.x0 + t * rx, y: a.y0 + t * ry }
}

/** Whether the copper of a stub from p to q, `width` wide, lies inside the copper of a or b. */
const stubCovered = (p: Pt, q: Pt, width: number, a: LaidSegment, b: LaidSegment): boolean => {
  const r = width / 2
  const len = Math.hypot(q.x - p.x, q.y - p.y)
  const ux = len > 0 ? (q.x - p.x) / len : 1
  const uy = len > 0 ? (q.y - p.y) / len : 0
  const within = (pt: Pt): boolean =>
    nearestOn(a, pt).dist <= a.width / 2 + LAID_EPS ||
    nearestOn(b, pt).dist <= b.width / 2 + LAID_EPS
  // The stub's outline: its two sides and its round ends, sampled.
  for (let k = 0; k <= STUB_SAMPLES; k++) {
    const t = (k / STUB_SAMPLES) * len
    const angle = (k / STUB_SAMPLES) * Math.PI
    const c = Math.cos(angle)
    const sn = Math.sin(angle)
    const outline = [
      { x: p.x + ux * t - uy * r, y: p.y + uy * t + ux * r },
      { x: p.x + ux * t + uy * r, y: p.y + uy * t - ux * r },
      { x: p.x - (ux * sn + uy * c) * r, y: p.y - (uy * sn - ux * c) * r },
      { x: q.x + (ux * sn - uy * c) * r, y: q.y + (uy * sn + ux * c) * r }
    ]
    if (!outline.every(within)) return false
  }
  return true
}

const STUB_SAMPLES = 32

/** One cut over the route: the stretch between where it comes back onto its own copper, gone. */
function cutOnce<T extends LaidSegment>(segs: readonly T[]): T[] | null {
  const from = (s: T, p: Pt): T => ({ ...s, x0: p.x, y0: p.y })
  const to = (s: T, p: Pt): T => ({ ...s, x1: p.x, y1: p.y })
  const stub = (s: T, a: Pt, b: Pt): T => ({ ...s, x0: a.x, y0: a.y, x1: b.x, y1: b.y })
  /** Where p, with copper `width` round it, joins `host` by a stub inside a's or b's copper. */
  const joins = (host: T, p: Pt, width: number, a: T, b: T): Pt | null => {
    const near = nearestOn(host, p)
    if (near.dist > Math.max(a.width, b.width)) return null
    return stubCovered(near.at, p, width, a, b) ? near.at : null
  }
  for (let i = 0; i < segs.length; i++) {
    const a = segs[i]
    if (a.mid) continue
    for (let j = segs.length - 1; j > i; j--) {
      const b = segs[j]
      if (b.mid) continue
      const head = segs.slice(0, i)
      const tail = segs.slice(j + 1)
      const bEnd = { x: b.x1, y: b.y1 }
      const aStart = { x: a.x0, y: a.y0 }
      // b ends back on a: a to there, a stub out to b's end, and on.
      const onA = joins(a, bEnd, b.width, a, b)
      if (onA && !(j === i + 1 && samePt(onA, { x: a.x1, y: a.y1 })))
        return [...head, to(a, onA), stub(b, onA, bEnd), ...tail]
      if (j === i + 1) continue
      // a starts on b: a stub from a's start onto b, and on along b.
      const onB = joins(b, aStart, a.width, a, b)
      if (onB) return [...head, stub(a, aStart, onB), from(b, onB), ...tail]
      const x = crossing(a, b)
      if (x) return [...head, to(a, x), from(b, x), ...tail]
    }
  }
  return null
}

/**
 * R26 over Attempt Finish's rounds (R23): a round goes on from where the last
 * stopped short (R39), and may come back the way that one went, so the rounds
 * joined end to end run over their own copper. Wherever the route comes back
 * onto copper it already laid (an end inside another segment's copper, or a
 * crossing), the stretch between is cut out, joined by a stub inside that
 * copper, so nothing is laid that the rounds did not already clear. The ends
 * stay put; arcs are never cut.
 */
export function cutRetraces<T extends LaidSegment>(segments: readonly T[]): T[] {
  let segs = segments.filter((s) => !samePt({ x: s.x0, y: s.y0 }, { x: s.x1, y: s.y1 }))
  for (let guard = 0; guard < 256; guard++) {
    const cut = cutOnce(segs)
    if (!cut) break
    segs = cut.filter((s) => !samePt({ x: s.x0, y: s.y0 }, { x: s.x1, y: s.y1 }))
  }
  return segs
}
