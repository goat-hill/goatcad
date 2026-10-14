/**
 * Whether a set of drawings makes a well-formed outline, and every place it
 * does not — the board's Edge.Cuts (`invalid_outline`) and a footprint side's
 * courtyard (`malformed_courtyard`), reported as KiCad 10 reports them, one
 * finding per problem (design-health-workstream.md):
 *
 *  - **Small**: a segment, rectangle, circle or arc too small to see
 *    (`TestBoardOutlinesGraphicItems`; the board outline only).
 *  - **Meeting contours**: two closed contours — closed drawings, or open ones
 *    chained into a loop — that share any point (the board outline only).
 *  - **Branches and gaps**: open drawings are chained end to end, each step to
 *    the nearest unused end within the chaining distance. A chain that runs into
 *    a drawing another chain already took branches; one that never closes has a
 *    gap at each end, named by the two drawings nearest it, each pair once.
 *  - **Crossing segments**: once every chain closes, the outline's segments
 *    that cross, or lie on one another, pair by pair.
 *
 * Where several ends meet at one point the next drawing is the first in file
 * order, which is the order KiCad meets them in; the counts are held to
 * `kicad-cli` on first-principles fixtures and KiCad's corpus. Millimeters,
 * board frame.
 */

import { mmToNm, nmToMm } from '../kicad/coordinates'

export interface Pt {
  x: number
  y: number
}

export interface OutlineShape {
  /** What a finding names it by: a uuid, or a stand-in. */
  id: string
  kind: 'segment' | 'arc' | 'bezier' | 'rect' | 'circle' | 'poly'
  /** Its two defining points as the file has them: a line's or arc's ends, a rectangle's corners, a circle's center and rim. */
  start: Pt
  end: Pt
  /** An open drawing from start to end; a closed one round, not repeating its first point. */
  path: Pt[]
  /** The extent the small-item test reads; null where it reads none (polygons, curves). */
  size: number | null
}

export type OutlineProblem =
  | { reason: 'small'; shapes: [string]; at: Pt }
  | { reason: 'gap' | 'branch' | 'crossing'; shapes: [string, string]; at: Pt }

export interface OutlineOptions {
  /** How far apart two ends may be and still join, mm. */
  epsilon: number
  /**
   * The board outline's own tests, small drawings and meeting contours, over
   * every Edge.Cuts drawing (`shapes` leaving out a footprint's hole outline).
   */
  board?: { all: readonly OutlineShape[] }
}

/** At or under this, a drawing is too small to be an edge (KiCad: 1 µm). */
export const SMALL_DRAWING_MM = nmToMm(mmToNm(0.001))

const OPEN = new Set<OutlineShape['kind']>(['segment', 'arc', 'bezier'])

const dist2 = (a: Pt, b: Pt): number => (a.x - b.x) ** 2 + (a.y - b.y) ** 2
const same = (a: Pt, b: Pt): boolean => Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9

/** Every drawing's two ends, in order: start then end, binned by the chaining distance. */
interface Ends {
  points: Pt[]
  owner: number[]
  cell: number
  grid: Map<string, number[]>
}

const cellKey = (x: number, y: number): string => `${x},${y}`

const endsOf = (
  shapes: readonly OutlineShape[],
  which: readonly number[],
  epsilon: number
): Ends => {
  const points: Pt[] = []
  const owner: number[] = []
  for (const i of which) {
    points.push(shapes[i].start, shapes[i].end)
    owner.push(i, i)
  }
  const cell = Math.max(epsilon, 1e-6)
  const grid = new Map<string, number[]>()
  points.forEach((p, k) => {
    const key = cellKey(Math.floor(p.x / cell), Math.floor(p.y / cell))
    const bin = grid.get(key)
    if (bin) bin.push(k)
    else grid.set(key, [k])
  })
  return { points, owner, cell, grid }
}

/** The two ends nearest a point, the earlier first where they tie. */
const nearestTwo = (ends: Ends, p: Pt): Array<{ owner: number; d2: number }> => {
  const best: Array<{ owner: number; d2: number }> = []
  ends.points.forEach((q, k) => {
    const entry = { owner: ends.owner[k], d2: dist2(p, q) }
    if (best.length < 2) {
      best.push(entry)
      best.sort((u, v) => u.d2 - v.d2)
    } else if (entry.d2 < best[1].d2) {
      best[1] = entry
      if (best[1].d2 < best[0].d2) best.reverse()
    }
  })
  return best
}

/**
 * The two ends nearest a point among those within `epsilon`, ranked as
 * `nearestTwo` ranks them: what it returns, less any end out of reach.
 */
const nearestTwoWithin = (
  ends: Ends,
  p: Pt,
  epsilon: number
): Array<{ owner: number; d2: number }> => {
  const cx = Math.floor(p.x / ends.cell)
  const cy = Math.floor(p.y / ends.cell)
  const reach = epsilon * epsilon
  const found: Array<{ k: number; d2: number }> = []
  for (let dx = -1; dx <= 1; dx++)
    for (let dy = -1; dy <= 1; dy++)
      for (const k of ends.grid.get(cellKey(cx + dx, cy + dy)) ?? []) {
        const d2 = dist2(p, ends.points[k])
        if (d2 <= reach) found.push({ k, d2 })
      }
  found.sort((u, v) => u.d2 - v.d2 || u.k - v.k)
  return found.slice(0, 2).map(({ k, d2 }) => ({ owner: ends.owner[k], d2 }))
}

/** The drawing to chain on to from `shape`'s end at `p`: the nearest other end within reach. */
const findNext = (ends: Ends, shape: number, p: Pt, epsilon: number): number | null => {
  let best: number | null = null
  let bestD2 = epsilon * epsilon
  for (const { owner, d2 } of nearestTwoWithin(ends, p, epsilon)) {
    if (owner === shape) continue
    if (d2 < bestD2) {
      bestD2 = d2
      best = owner
    }
  }
  return best
}

/**
 * A chain's points, each drawing turned to follow the last, and for each point
 * the drawing its segment onward comes from.
 */
const chainPath = (
  shapes: readonly OutlineShape[],
  chain: readonly number[],
  epsilon: number
): { points: Pt[]; owners: number[] } => {
  const first = shapes[chain[0]]
  let at = first.start
  if (chain.length > 1) {
    const second = shapes[chain[1]]
    const near = (a: Pt, b: Pt): boolean => dist2(a, b) <= epsilon * epsilon
    at = near(first.start, second.start) || near(first.start, second.end) ? first.end : first.start
  }
  const points: Pt[] = [at]
  const owners: number[] = []
  for (const index of chain) {
    const shape = shapes[index]
    const forward = dist2(at, shape.start) <= dist2(at, shape.end)
    const path = forward ? shape.path : [...shape.path].reverse()
    for (let k = 1; k < path.length; k++) {
      owners.push(index)
      points.push(path[k])
    }
    at = points[points.length - 1]
  }
  owners.push(chain[chain.length - 1])
  return { points, owners }
}

/** A closed chain as a ring: its last point, at or within reach of its first, dropped. */
const closeRing = (path: { points: Pt[]; owners: number[] }): { ring: Pt[]; owners: number[] } =>
  path.points.length > 2
    ? {
        ring: path.points.slice(0, -1),
        owners: [...path.owners.slice(0, -2), path.owners[path.owners.length - 2]]
      }
    : { ring: path.points, owners: path.owners }

/** Whether two segments share a point; `shared` ignores a vertex both end at. */
const segmentsMeet = (a: Pt, b: Pt, c: Pt, d: Pt, ignoreShared: boolean): boolean => {
  const minMax = (u: number, v: number): [number, number] => (u < v ? [u, v] : [v, u])
  const [ax0, ax1] = minMax(a.x, b.x)
  const [ay0, ay1] = minMax(a.y, b.y)
  const [cx0, cx1] = minMax(c.x, d.x)
  const [cy0, cy1] = minMax(c.y, d.y)
  const tol = 1e-9
  if (ax1 < cx0 - tol || cx1 < ax0 - tol || ay1 < cy0 - tol || cy1 < ay0 - tol) return false
  const d1 = { x: b.x - a.x, y: b.y - a.y }
  const d2 = { x: d.x - c.x, y: d.y - c.y }
  const off = { x: c.x - a.x, y: c.y - a.y }
  const det = d2.x * d1.y - d2.y * d1.x
  const scale = Math.max(1e-12, Math.hypot(d1.x, d1.y) * Math.hypot(d2.x, d2.y))
  if (Math.abs(det) <= 1e-12 * scale) {
    // Parallel: they meet only on one line, overlapping.
    if (Math.abs(d1.x * off.y - d1.y * off.x) > 1e-9 * Math.max(1e-12, Math.hypot(d1.x, d1.y)))
      return false
    if (!ignoreShared) return true
    // On one line, overlapping by more than a shared end.
    const along = (p: Pt): number => (p.x - a.x) * d1.x + (p.y - a.y) * d1.y
    const len = d1.x * d1.x + d1.y * d1.y
    const s = Math.min(along(c), along(d))
    const e = Math.max(along(c), along(d))
    return Math.min(len, e) - Math.max(0, s) > tol * Math.sqrt(len)
  }
  const t = (d2.x * off.y - d2.y * off.x) / det
  const u = (d1.x * off.y - d1.y * off.x) / det
  const eps = 1e-12
  if (t < -eps || t > 1 + eps || u < -eps || u > 1 + eps) return false
  if (ignoreShared) {
    const endT = Math.abs(t) <= eps || Math.abs(t - 1) <= eps
    const endU = Math.abs(u) <= eps || Math.abs(u - 1) <= eps
    if (endT && endU) return false
  }
  return true
}

const ringSegments = (ring: readonly Pt[]): Array<[Pt, Pt]> =>
  ring.map((p, i) => [p, ring[(i + 1) % ring.length]] as [Pt, Pt])

interface Box {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

const TOL = 1e-9
const boxOf = (points: readonly Pt[]): Box => {
  const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
  for (const p of points) {
    box.minX = Math.min(box.minX, p.x)
    box.minY = Math.min(box.minY, p.y)
    box.maxX = Math.max(box.maxX, p.x)
    box.maxY = Math.max(box.maxY, p.y)
  }
  return box
}
const boxesMeet = (a: Box, b: Box): boolean =>
  a.minX <= b.maxX + TOL &&
  b.minX <= a.maxX + TOL &&
  a.minY <= b.maxY + TOL &&
  b.minY <= a.maxY + TOL

/** A closed contour with its segments and their boxes, built once for every pair it is tried in. */
interface Prepared {
  ring: readonly Pt[]
  box: Box
  segments: Array<{ p: Pt; q: Pt; box: Box }>
}

const prepare = (ring: readonly Pt[]): Prepared => ({
  ring,
  box: boxOf(ring),
  segments: ringSegments(ring).map(([p, q]) => ({ p, q, box: boxOf([p, q]) }))
})

/** Whether two closed contours share any point. */
const contoursMeet = (a: Prepared, b: Prepared): boolean => {
  if (!boxesMeet(a.box, b.box)) return false
  const near = b.segments.filter((s) => boxesMeet(s.box, a.box))
  for (const s of a.segments) {
    if (!boxesMeet(s.box, b.box)) continue
    for (const t of near)
      if (boxesMeet(s.box, t.box) && segmentsMeet(s.p, s.q, t.p, t.q, false)) return true
  }
  return false
}

/** Each pair of contours that meet, `i < j`, by a sweep over their boxes. */
const meetingPairs = (contours: readonly Prepared[]): Array<[number, number]> => {
  const order = contours
    .map((_, i) => i)
    .sort((i, j) => contours[i].box.minX - contours[j].box.minX)
  const pairs: Array<[number, number]> = []
  for (let x = 0; x < order.length; x++) {
    const a = contours[order[x]]
    for (let y = x + 1; y < order.length; y++) {
      const b = contours[order[y]]
      if (b.box.minX > a.box.maxX + TOL) break
      if (contoursMeet(a, b))
        pairs.push(order[x] < order[y] ? [order[x], order[y]] : [order[y], order[x]])
    }
  }
  return pairs.sort((p, q) => p[0] - q[0] || p[1] - q[1])
}

/** Whether a point lies strictly inside a ring. */
const inside = (ring: readonly Pt[], p: Pt): boolean => {
  let hit = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]
    const b = ring[j]
    if (segmentsMeet(a, b, p, p, false)) return false
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) hit = !hit
  }
  return hit
}

const midpoint = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })

export function outlineProblems(
  shapes: readonly OutlineShape[],
  options: OutlineOptions
): OutlineProblem[] {
  const out: OutlineProblem[] = []
  const { epsilon } = options
  if (options.board) {
    const all = options.board.all
    for (const shape of all)
      if (shape.size !== null && shape.size <= SMALL_DRAWING_MM)
        out.push({ reason: 'small', shapes: [shape.id], at: shape.start })
    meetingContours(all, epsilon, out)
  }

  const { contours, open } = chainContours(shapes, epsilon, out)
  if (open) return out
  selfIntersections(shapes, contours, out)
  return out
}

/**
 * The drawings chained into contours, every drawing a start candidate in
 * order; branches and gaps reported into `out`. `open` when a chain never closed.
 */
export function chainContours(
  shapes: readonly OutlineShape[],
  epsilon: number,
  out: OutlineProblem[] = []
): { contours: Array<{ ring: Pt[]; owners: number[] }>; open: boolean } {
  const all = shapes.map((_, i) => i)
  const ends = endsOf(shapes, all, epsilon)
  const used = new Set<number>()
  /** Each contour's points, and the drawing each segment onward comes from. */
  const contours: Array<{ ring: Pt[]; owners: number[] }> = []
  const reportedGaps = new Set<string>()
  let open = false
  for (const start of all) {
    if (used.has(start)) continue
    used.add(start)
    const shape = shapes[start]
    if (!OPEN.has(shape.kind)) {
      contours.push({ ring: shape.path, owners: shape.path.map(() => start) })
      continue
    }
    const chain = [start]
    let closed = false
    let front = shape.start
    let back = shape.end
    const extend = (forward: boolean): void => {
      let curr = forward ? chain[chain.length - 1] : chain[0]
      let prev = forward ? back : front
      for (;;) {
        const next = findNext(ends, curr, prev, epsilon)
        if (next !== null && !used.has(next)) {
          used.add(next)
          if (forward) chain.push(next)
          else chain.unshift(next)
          const n = shapes[next]
          prev = dist2(prev, n.start) < dist2(prev, n.end) ? n.end : n.start
          curr = next
          continue
        }
        if (next !== null) {
          const chainEnd = forward ? chain[0] : chain[chain.length - 1]
          const chainPt = forward ? front : back
          if (next === chainEnd && dist2(prev, chainPt) <= epsilon * epsilon) closed = true
          else out.push({ reason: 'branch', shapes: [shapes[curr].id, shapes[next].id], at: prev })
        }
        if (forward) back = prev
        else front = prev
        break
      }
    }
    extend(true)
    if (!closed) extend(false)
    const path = chainPath(shapes, chain, epsilon)
    const first = path.points[0]
    const last = path.points[path.points.length - 1]
    if (dist2(first, last) <= epsilon * epsilon) {
      contours.push(closeRing(path))
      continue
    }
    open = true
    for (const p of [first, last]) {
      const [a, b] = nearestTwo(ends, p)
      if (!a || !b) continue
      const pair = [Math.min(a.owner, b.owner), Math.max(a.owner, b.owner)]
      const key = pair.join(':')
      if (reportedGaps.has(key)) continue
      reportedGaps.add(key)
      out.push({
        reason: 'gap',
        shapes: [shapes[pair[0]].id, shapes[pair[1]].id],
        at: p
      })
    }
  }
  return { contours, open }
}

/** Pairs of closed contours that share a point: closed drawings, and open ones that chain into a loop. */
function meetingContours(
  shapes: readonly OutlineShape[],
  epsilon: number,
  out: OutlineProblem[]
): void {
  const contours: Array<{ ring: Pt[]; owner: number }> = []
  const openShapes: number[] = []
  shapes.forEach((shape, i) => {
    if (OPEN.has(shape.kind)) openShapes.push(i)
    else contours.push({ ring: shape.path, owner: i })
  })
  const ends = endsOf(shapes, openShapes, epsilon)
  const remaining = new Set(openShapes)
  for (const start of openShapes) {
    if (!remaining.has(start)) continue
    const chain = [start]
    const visited = new Set([start])
    let closed = false
    let front = shapes[start].start
    let back = shapes[start].end
    const extend = (forward: boolean): void => {
      let curr = forward ? chain[chain.length - 1] : chain[0]
      let prev = forward ? back : front
      for (;;) {
        let next = findNext(ends, curr, prev, epsilon)
        if (next !== null && !remaining.has(next)) next = null
        if (next !== null && !visited.has(next)) {
          visited.add(next)
          if (forward) chain.push(next)
          else chain.unshift(next)
          const n = shapes[next]
          prev = dist2(prev, n.start) < dist2(prev, n.end) ? n.end : n.start
          curr = next
          continue
        }
        if (next !== null) {
          const chainEnd = forward ? chain[0] : chain[chain.length - 1]
          const chainPt = forward ? front : back
          if (next === chainEnd && dist2(prev, chainPt) <= epsilon * epsilon) closed = true
        }
        if (forward) back = prev
        else front = prev
        break
      }
    }
    extend(true)
    if (!closed) extend(false)
    const path = closed ? chainPath(shapes, chain, epsilon).points : []
    if (!closed || path.length < 3) {
      remaining.delete(start)
      continue
    }
    for (const consumed of chain) remaining.delete(consumed)
    contours.push({ ring: path.slice(0, -1), owner: chain[0] })
  }
  for (const [i, j] of meetingPairs(contours.map((c) => prepare(c.ring))))
    out.push({
      reason: 'crossing',
      shapes: [shapes[contours[i].owner].id, shapes[contours[j].owner].id],
      at: midpoint(contours[i].ring[0], contours[j].ring[0])
    })
}

/**
 * Once every chain closes: the outline's segments that cross or lie on one
 * another. Outlines are the contours inside an even number of others; one
 * nested in another and meeting a contour is a cutout wall, and is left out.
 * Holes join them only when no two contours meet (else they are cut away
 * whole, which leaves nothing to cross).
 */
function selfIntersections(
  shapes: readonly OutlineShape[],
  contours: ReadonlyArray<{ ring: Pt[]; owners: number[] }>,
  out: OutlineProblem[]
): void {
  const prepared = contours.map((c) => prepare(c.ring))
  const parents = contours.map((c, i) => {
    const p = c.ring[0]
    return prepared.filter(
      (other, j) =>
        j !== i &&
        other.ring.length >= 3 &&
        p.x >= other.box.minX &&
        p.x <= other.box.maxX &&
        p.y >= other.box.minY &&
        p.y <= other.box.maxY &&
        inside(other.ring, p)
    ).length
  })
  const meeting = new Set<number>()
  for (const [i, j] of meetingPairs(prepared)) {
    meeting.add(i)
    meeting.add(j)
  }
  const segments: Array<{ a: Pt; b: Pt; owner: number }> = []
  contours.forEach((contour, i) => {
    const depth = parents[i]
    const outline = depth % 2 === 0 && !(depth > 0 && meeting.has(i))
    const hole = depth % 2 === 1 && meeting.size === 0
    if (!outline && !hole) return
    ringSegments(contour.ring).forEach(([p, q], k) => {
      const [a, b] = p.x < q.x || (p.x === q.x && p.y <= q.y) ? [p, q] : [q, p]
      segments.push({ a, b, owner: contour.owners[k] ?? contour.owners[contour.owners.length - 1] })
    })
  })
  segments.sort((s, t) => s.a.x - t.a.x || s.a.y - t.a.y || s.b.x - t.b.x || s.b.y - t.b.y)
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i]
    for (let j = i + 1; j < segments.length; j++) {
      const t = segments[j]
      if (t.a.x > s.b.x + 1e-9) break
      const duplicate = same(s.a, t.a) && same(s.b, t.b)
      if (duplicate || segmentsMeet(s.a, s.b, t.a, t.b, true))
        out.push({
          reason: 'crossing',
          shapes: [shapes[s.owner].id, shapes[t.owner].id],
          at: duplicate ? s.a : midpoint(s.a, s.b)
        })
    }
  }
}
