/**
 * Simple-polygon predicates for the board checks: overlap and boundary
 * distance over plain rings, no boolean engine. Rings are closed implicitly
 * (last point joins the first) and may wind either way.
 */
import { distanceToSegment, type Point2 } from './distance'
import { pointInPolygon } from './regionClips'

export interface Box {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export const ringBox = (ring: readonly Point2[]): Box => {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of ring) {
    minX = Math.min(minX, p.x)
    minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x)
    maxY = Math.max(maxY, p.y)
  }
  return { minX, minY, maxX, maxY }
}

export const boxesTouch = (a: Box, b: Box, margin = 0): boolean =>
  a.minX <= b.maxX + margin &&
  b.minX <= a.maxX + margin &&
  a.minY <= b.maxY + margin &&
  b.minY <= a.maxY + margin

/** Distance from a point to the ring's boundary, ignoring which side it is on. */
export const ringBoundaryDistance = (p: Point2, ring: readonly Point2[]): number => {
  let d = Infinity
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    d = Math.min(d, distanceToSegment(p, ring[j], ring[i]))
  }
  return d
}

const cross = (ax: number, ay: number, bx: number, by: number): number => ax * by - ay * bx

/** Whether two segments cross at interior points of both (touching an end does not count). */
export const segmentsCrossProperly = (a: Point2, b: Point2, c: Point2, d: Point2): boolean => {
  const d1 = cross(b.x - a.x, b.y - a.y, c.x - a.x, c.y - a.y)
  const d2 = cross(b.x - a.x, b.y - a.y, d.x - a.x, d.y - a.y)
  const d3 = cross(d.x - c.x, d.y - c.y, a.x - c.x, a.y - c.y)
  const d4 = cross(d.x - c.x, d.y - c.y, b.x - c.x, b.y - c.y)
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
}

/**
 * Where segment `a`→`b` meets segment `c`→`d` at all — crossing, touching at an
 * end, or overlapping along one line (the overlap's middle) — or null. Exact on
 * integer coordinates (nanometers), where a float cross product of board-sized
 * values would round.
 */
export const segmentsMeet = (a: Point2, b: Point2, c: Point2, d: Point2): Point2 | null => {
  if (
    Math.max(a.x, b.x) < Math.min(c.x, d.x) ||
    Math.max(c.x, d.x) < Math.min(a.x, b.x) ||
    Math.max(a.y, b.y) < Math.min(c.y, d.y) ||
    Math.max(c.y, d.y) < Math.min(a.y, b.y)
  )
    return null
  const big = (p: Point2): [bigint, bigint] => [BigInt(p.x), BigInt(p.y)]
  const [ax, ay] = big(a)
  const [bx, by] = big(b)
  const [cx, cy] = big(c)
  const [dx, dy] = big(d)
  const ex = bx - ax
  const ey = by - ay
  const fx = dx - cx
  const fy = dy - cy
  const ox = cx - ax
  const oy = cy - ay
  const denom = ex * fy - ey * fx
  if (denom === 0n) {
    if (ex * oy - ey * ox !== 0n) return null
    // One line: the overlap along the axis `a`→`b` runs farthest on.
    const alongX = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y)
    const axis = (p: Point2): number => (alongX ? p.x : p.y)
    const lo = Math.max(Math.min(axis(a), axis(b)), Math.min(axis(c), axis(d)))
    const hi = Math.min(Math.max(axis(a), axis(b)), Math.max(axis(c), axis(d)))
    if (lo > hi) return null
    const mid = (lo + hi) / 2
    const span = axis(b) - axis(a)
    const t = span === 0 ? 0 : (mid - axis(a)) / span
    return alongX ? { x: mid, y: a.y + t * (b.y - a.y) } : { x: a.x + t * (b.x - a.x), y: mid }
  }
  // t along a→b and u along c→d, each as a numerator over `denom`, both within [0, 1].
  const t = ox * fy - oy * fx
  const u = ox * ey - oy * ex
  const within = (n: bigint): boolean =>
    denom > 0n ? n >= 0n && n <= denom : n <= 0n && n >= denom
  if (!within(t) || !within(u)) return null
  const s = Number(t) / Number(denom)
  return { x: a.x + s * (b.x - a.x), y: a.y + s * (b.y - a.y) }
}

/** The crossing point of two segments known to cross. */
export const segmentsCrossing = (a: Point2, b: Point2, c: Point2, d: Point2): Point2 => {
  const denom = cross(b.x - a.x, b.y - a.y, d.x - c.x, d.y - c.y)
  const t = denom === 0 ? 0.5 : cross(c.x - a.x, c.y - a.y, d.x - c.x, d.y - c.y) / denom
  return { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) }
}

/** Where segment `a`→`b` meets segment `c`→`d`, as a fraction along `a`→`b`; null when parallel or apart. */
const crossingParameter = (a: Point2, b: Point2, c: Point2, d: Point2): number | null => {
  const denom = cross(b.x - a.x, b.y - a.y, d.x - c.x, d.y - c.y)
  if (denom === 0) return null
  const t = cross(c.x - a.x, c.y - a.y, d.x - c.x, d.y - c.y) / denom
  const u = cross(c.x - a.x, c.y - a.y, b.x - a.x, b.y - a.y) / denom
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : null
}

/** A ring with the rings cut out of it: what a courtyard or an outline nests into. */
export interface Region {
  outer: Point2[]
  holes: Point2[][]
}

const ringsOf = (region: Region): Point2[][] => [region.outer, ...region.holes]

/** Whether a point is in the region: inside its outer ring and outside every hole. */
export const pointInRegion = (p: Point2, region: Region): boolean =>
  pointInPolygon(p, region.outer) && !region.holes.some((hole) => pointInPolygon(p, hole))

/** Distance from a point to the nearest of the region's rings. */
export const regionBoundaryDistance = (p: Point2, region: Region): number =>
  Math.min(...ringsOf(region).map((ring) => ringBoundaryDistance(p, ring)))

/**
 * A point of `a`'s boundary that lies inside `b` deeper than `tolerance`:
 * each edge of `a`'s rings is cut where it meets `b`'s rings, and the middle
 * of each piece is tested. Null when no piece reaches in.
 */
const boundaryInside = (a: Region, b: Region, tolerance: number): Point2 | null => {
  const cutters = ringsOf(b)
  for (const ring of ringsOf(a)) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const p = ring[j]
      const q = ring[i]
      const cuts = [0, 1]
      for (const other of cutters) {
        for (let k = 0, l = other.length - 1; k < other.length; l = k++) {
          const t = crossingParameter(p, q, other[l], other[k])
          if (t !== null) cuts.push(t)
        }
      }
      cuts.sort((x, y) => x - y)
      for (let c = 1; c < cuts.length; c++) {
        const t = (cuts[c - 1] + cuts[c]) / 2
        const mid = { x: p.x + t * (q.x - p.x), y: p.y + t * (q.y - p.y) }
        if (pointInRegion(mid, b) && regionBoundaryDistance(mid, b) > tolerance) return mid
      }
    }
  }
  return null
}

/**
 * Whether two regions' interiors overlap by more than `tolerance`: a stretch
 * of either boundary lies inside the other further than `tolerance` from its
 * boundary. Regions that touch, share an edge, or overlap by a hair do not.
 * Returns a point of the overlap, or null.
 */
export const regionsOverlap = (a: Region, b: Region, tolerance: number): Point2 | null =>
  boundaryInside(a, b, tolerance) ??
  boundaryInside(b, a, tolerance) ??
  interiorInside(a, b, tolerance) ??
  interiorInside(b, a, tolerance)

/**
 * The middle of `a`'s box, when it lies inside both regions deeper than
 * `tolerance`: two regions whose boundaries coincide overlap everywhere, yet
 * no stretch of either boundary lies inside the other.
 */
const interiorInside = (a: Region, b: Region, tolerance: number): Point2 | null => {
  const box = ringBox(a.outer)
  const mid = { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 }
  for (const region of [a, b])
    if (!pointInRegion(mid, region) || regionBoundaryDistance(mid, region) <= tolerance) return null
  return mid
}

/** `regionsOverlap` for two plain rings. */
export const ringsOverlap = (
  a: readonly Point2[],
  b: readonly Point2[],
  tolerance: number
): Point2 | null =>
  regionsOverlap({ outer: [...a], holes: [] }, { outer: [...b], holes: [] }, tolerance)

/**
 * Whether a capsule (segment `a`→`b` swept by `radius`) reaches into a
 * region: its axis enters the interior, or its body crosses a ring by more
 * than `tolerance`. A capsule lying along the boundary does not count.
 */
export const capsuleEntersRegion = (
  a: Point2,
  b: Point2,
  radius: number,
  region: Region,
  tolerance: number
): boolean => {
  if (pointInRegion(a, region) || pointInRegion(b, region)) return true
  const rings = ringsOf(region)
  // Both ends outside: an axis that crosses any ring passes through the region
  // on the way (out of a hole is into the region).
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      if (segmentsCrossProperly(a, b, ring[j], ring[i])) return true
    }
  }
  // Not crossing: only the body's radius can reach in past a ring.
  let d = Infinity
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      d = Math.min(d, segmentDistance(a, b, ring[j], ring[i]))
    }
  }
  return d < radius - tolerance
}

/** Distance between two segments, 0 when they cross. */
export const segmentDistance = (a: Point2, b: Point2, c: Point2, d: Point2): number => {
  if (segmentsCrossProperly(a, b, c, d)) return 0
  return Math.min(
    distanceToSegment(a, c, d),
    distanceToSegment(b, c, d),
    distanceToSegment(c, a, b),
    distanceToSegment(d, a, b)
  )
}
