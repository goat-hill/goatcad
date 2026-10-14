// Parts follow KiCad's source, named below: Copyright The KiCad Developers, GPL-3.0-or-later.
/**
 * Necks and slivers in a piece of copper: where its outline pinches narrower
 * than a width with substantial copper on both sides (KiCad's minimum
 * connection width, `drc_test_provider_connection_width.cpp`), and where it
 * ends in an acute spike (its copper sliver, `…_sliver_checker.cpp`). Both
 * read the outline's corners, as KiCad reads its polygons' vertices.
 *
 * A neck is a pair of corners closer than the width: one where the outline
 * turns inward (a reflex corner, where a waist begins), and the nearest other
 * corner the straight cut between them runs into the copper from. The cut
 * counts only when the copper on each side of it spreads further than the
 * width across both axes from each end, so a narrow track's own sides, or a
 * notch in a wide pour, are not necks. World millimeters, y up.
 */
import type { ClipRegion } from '../geometry/clip'
import { PackedRTree } from '../geometry/packedRTree'
import type { Pt } from './spatialIndex'

export interface Neck {
  a: Pt
  b: Pt
  /** The cut's length: how wide the copper is there. */
  width: number
}

interface Corner {
  p: Pt
  ring: number
  index: number
}

/** How far off a corner a probe steps to ask which side is copper. */
const PROBE = 1e-4

/**
 * Every neck of a region narrower than `limit`: at most one per corner, and a
 * corner (with its neighbors) in one neck is in no other.
 */
export function findNecks(region: ClipRegion, limit: number): Neck[] {
  if (limit <= 0) return []
  // Every ring turned so the copper lies to the left of its edges: the outer
  // counterclockwise, the holes clockwise. A corner then tells from its own
  // edges which way is copper, with no point-in-polygon test.
  const rings = [region.outer, ...region.holes]
    .filter((ring) => ring.length >= 3)
    .map((ring, i) => (signedArea(ring) > 0 === (i === 0) ? ring : [...ring].reverse()))
  if (rings.length === 0) return []
  const corners: Corner[] = []
  rings.forEach((ring, r) => ring.forEach((p, index) => corners.push({ p, ring: r, index })))
  const boxes = new Float64Array(corners.length * 4)
  corners.forEach((c, i) => boxes.set([c.p.x, c.p.y, c.p.x, c.p.y], i * 4))
  const tree = new PackedRTree(boxes, corners.length)

  const at = (ring: number, index: number): Pt => {
    const list = rings[ring]
    return list[((index % list.length) + list.length) % list.length]
  }
  /**
   * Whether a step from a corner toward a point enters the copper: the
   * direction lies in the corner's copper wedge, swept counterclockwise from
   * its outgoing edge to its incoming one.
   */
  const entersToward = (c: Corner, to: Pt): boolean => {
    const next = at(c.ring, c.index + 1)
    const prev = at(c.ring, c.index - 1)
    const base = Math.atan2(next.y - c.p.y, next.x - c.p.x)
    const turn = (x: number, y: number): number => {
      const a = Math.atan2(y - c.p.y, x - c.p.x) - base
      return a < 0 ? a + 2 * Math.PI : a
    }
    const d = turn(to.x, to.y)
    return d > 0 && d < turn(prev.x, prev.y)
  }
  /** A corner where the outline turns inward: with the copper on the left, a right turn. */
  const reflex = (c: Corner): boolean => {
    const prev = at(c.ring, c.index - 1)
    const next = at(c.ring, c.index + 1)
    return (c.p.x - prev.x) * (next.y - c.p.y) - (c.p.y - prev.y) * (next.x - c.p.x) < 0
  }
  /**
   * How many corners the outline takes, walked from one corner in one
   * direction, to stray further than `limit` from it across both axes;
   * Infinity when it never does. Asked of a corner many times, so kept.
   */
  const reachCache = new Map<number, number>()
  const reach = (ring: number, from: number, step: 1 | -1): number => {
    const cacheKey = (ring * 0x100000 + from) * 2 + (step > 0 ? 1 : 0)
    const known = reachCache.get(cacheKey)
    if (known !== undefined) return known
    const list = rings[ring]
    const n = list.length
    const ref = list[from]
    let x = false
    let y = false
    let found = Infinity
    for (let k = 1, i = (from + step + n) % n; k < n; k++, i = (i + step + n) % n) {
      const p = list[i]
      if (Math.abs(p.x - ref.x) > limit) x = true
      if (Math.abs(p.y - ref.y) > limit) y = true
      if (x && y) {
        found = k
        break
      }
    }
    reachCache.set(cacheKey, found)
    return found
  }
  /** Whether the outline strays past the width from a corner before it reaches `stop` (or comes round). */
  const spreads = (ring: number, from: number, step: 1 | -1, stop: number | null): boolean => {
    const k = reach(ring, from, step)
    if (k === Infinity) return false
    if (stop === null) return true
    const n = rings[ring].length
    const toStop = step > 0 ? (stop - from + n) % n : (from - stop + n) % n
    return k < toStop
  }
  // Each ring's length along its outline to each corner: a stretch of outline
  // shorter than the width cannot stray past it, so it rules a cut out at once.
  const along = rings.map((ring) => {
    const out = new Float64Array(ring.length + 1)
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]
      const b = ring[(i + 1) % ring.length]
      out[i + 1] = out[i] + Math.hypot(b.x - a.x, b.y - a.y)
    }
    return out
  })
  /** The outline's length walking forward from one corner of a ring to another. */
  const forward = (ring: number, from: number, to: number): number => {
    const sums = along[ring]
    const total = sums[sums.length - 1]
    const d = sums[to] - sums[from]
    return d >= 0 ? d : d + total
  }
  /** Whether the copper each side of the cut from `a` to `b` spreads out past the width from both ends. */
  const substantial = (a: Corner, b: Corner): boolean => {
    if (a.ring === b.ring) {
      if (forward(a.ring, a.index, b.index) <= limit || forward(a.ring, b.index, a.index) <= limit)
        return false
    } else {
      const lengthOf = (ring: number): number => along[ring][along[ring].length - 1]
      if (lengthOf(a.ring) <= limit || lengthOf(b.ring) <= limit) return false
    }
    if (a.ring !== b.ring)
      // A cut between the outline and a hole: each ring must reach out from its own end.
      return (
        spreads(a.ring, a.index, 1, null) &&
        spreads(a.ring, a.index, -1, null) &&
        spreads(b.ring, b.index, 1, null) &&
        spreads(b.ring, b.index, -1, null)
      )
    return (
      spreads(a.ring, a.index, 1, b.index) &&
      spreads(a.ring, a.index, -1, b.index) &&
      spreads(b.ring, b.index, 1, a.index) &&
      spreads(b.ring, b.index, -1, a.index)
    )
  }

  const used = new Set<string>()
  const key = (c: Corner, offset = 0): string =>
    `${c.ring}:${(((c.index + offset) % rings[c.ring].length) + rings[c.ring].length) % rings[c.ring].length}`
  const out: Neck[] = []
  for (const c of corners) {
    if (used.has(key(c)) || !reflex(c)) continue
    let best: Corner | null = null
    let bestDistance = limit
    tree.search(c.p.x - limit, c.p.y - limit, c.p.x + limit, c.p.y + limit, (i) => {
      const o = corners[i]
      if (o.ring === c.ring) {
        const n = rings[c.ring].length
        const apart = Math.abs(o.index - c.index)
        if (Math.min(apart, n - apart) <= 1) return
      }
      const distance = Math.hypot(o.p.x - c.p.x, o.p.y - c.p.y)
      if (distance <= 0 || distance >= bestDistance) return
      if (!substantial(o, c)) return
      if (!entersToward(o, c.p)) return
      best = o
      bestDistance = distance
    })
    const match = best as Corner | null
    if (!match || used.has(key(match))) continue
    for (const corner of [c, match]) for (const offset of [-1, 0, 1]) used.add(key(corner, offset))
    out.push({ a: c.p, b: match.p, width: bestDistance })
  }
  return out
}

/** Twice a ring's signed area: positive when it runs counterclockwise (y up). */
const signedArea = (ring: readonly Pt[]): number => {
  let sum = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++)
    sum += (ring[j].x - ring[i].x) * (ring[j].y + ring[i].y)
  return sum
}

const unit = (x: number, y: number): Pt => {
  const length = Math.hypot(x, y)
  return length > 0 ? { x: x / length, y: y / length } : { x: 0, y: 0 }
}

/**
 * The acute copper spikes of a region's outline: a corner sharper than
 * `angle` degrees whose wedge is copper and whose neighbors stand wider apart
 * than `mouth` — neighbors closer than `merge` to it counting as the corner
 * itself, as a fill's crowded corners do. Only the outer ring is read, as
 * KiCad reads a layer's outlines.
 */
export function findSlivers(
  ring: readonly Pt[],
  isCopper: (p: Pt) => boolean,
  options: { angle: number; mouth: number; merge: number }
): Array<{ tip: Pt; inner: Pt }> {
  const n = ring.length
  if (n <= 5) return []
  const cosLimit = Math.cos((options.angle * Math.PI) / 180)
  const out: Array<{ tip: Pt; inner: Pt }> = []
  for (let k = 0; k < n; k++) {
    const p = ring[k]
    let prev = ring[(k - 1 + n) % n]
    let next = ring[(k + 1) % n]
    // Step past neighbors too close to tell a direction from.
    for (
      let s = 2;
      s < n && Math.abs(prev.x - p.x) < options.merge && Math.abs(prev.y - p.y) < options.merge;
      s++
    )
      prev = ring[(k - s + n) % n]
    for (
      let s = 2;
      s < n && Math.abs(next.x - p.x) < options.merge && Math.abs(next.y - p.y) < options.merge;
      s++
    )
      next = ring[(k + s) % n]
    const u = { x: prev.x - p.x, y: prev.y - p.y }
    const v = { x: next.x - p.x, y: next.y - p.y }
    const lu = Math.hypot(u.x, u.y)
    const lv = Math.hypot(v.x, v.y)
    if (lu === 0 || lv === 0) continue
    const cos = (u.x * v.x + u.y * v.y) / (lu * lv)
    if (cos <= cosLimit || cos >= 1 - 1e-7) continue
    if (Math.hypot(next.x - prev.x, next.y - prev.y) <= options.mouth) continue
    const bisector = unit(u.x / lu + v.x / lv, u.y / lu + v.y / lv)
    if (!isCopper({ x: p.x + bisector.x * PROBE, y: p.y + bisector.y * PROBE })) continue
    // A point well inside the spike: whether other copper covers it says whether the tip is real.
    const depth = Math.min(lu, lv) / 2
    out.push({ tip: p, inner: { x: p.x + bisector.x * depth, y: p.y + bisector.y * depth } })
  }
  return out
}
