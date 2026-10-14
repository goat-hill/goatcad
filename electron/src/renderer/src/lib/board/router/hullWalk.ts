/**
 * The router's geometry kernel: bend a polyline around one hull, clockwise or
 * counterclockwise — a port of KiCad PNS `LINE::Walkaround`.
 * Everything above it (walkaround mode, shove,
 * auto-complete) is policy over repeated calls to this.
 *
 * The algorithm is a graph walk, not a polygon boolean: split the path and
 * the hull ring at their intersection points, classify path vertices as
 * inside/outside/on-edge, then walk from the path's start — following the
 * path while outside, following the hull ring while on it (leaving for the
 * path as soon as possible, which is what makes the result hug the obstacle
 * rather than orbit it). Direction is encoded purely by ring order: the
 * caller reverses the hull for the counterclockwise walk.
 *
 * PNS relies on exact integer coordinates for vertex identity; the float
 * analog here is a single EPS for "same point" / "on edge", kept far above
 * accumulated error and far below any real clearance.
 */

import type { Pt } from '../spatialIndex'
import type { Hull } from './hulls'

/** Point-identity / on-edge tolerance (mm). */
const EPS = 1e-6

const same = (a: Pt, b: Pt): boolean => Math.abs(a.x - b.x) <= EPS && Math.abs(a.y - b.y) <= EPS

const segPointDist = (p: Pt, a: Pt, b: Pt): number => {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const l2 = dx * dx + dy * dy
  if (l2 === 0) return Math.hypot(p.x - a.x, p.y - a.y)
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

/** Even-odd containment (boundary points are NOT inside — see onRing). */
export function pointInRing(p: Pt, ring: readonly Pt[]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]
    const b = ring[j]
    if (a.y > p.y !== b.y > p.y) {
      const x = ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x
      if (p.x < x) inside = !inside
    }
  }
  return inside
}

export function onRing(p: Pt, ring: readonly Pt[]): boolean {
  for (let i = 0; i < ring.length; i++) {
    if (segPointDist(p, ring[i], ring[(i + 1) % ring.length]) <= EPS) return true
  }
  return false
}

/** Proper + touching segment intersections, as points (t along a→b). */
function segSegIntersections(a: Pt, b: Pt, c: Pt, d: Pt): Pt[] {
  const r = { x: b.x - a.x, y: b.y - a.y }
  const s = { x: d.x - c.x, y: d.y - c.y }
  const denom = r.x * s.y - r.y * s.x
  const acx = c.x - a.x
  const acy = c.y - a.y
  if (Math.abs(denom) < 1e-12) {
    // Parallel: collinear overlap contributes the overlap's endpoints.
    if (Math.abs(acx * r.y - acy * r.x) > EPS) return []
    const out: Pt[] = []
    for (const p of [c, d]) {
      if (segPointDist(p, a, b) <= EPS) out.push({ ...p })
    }
    for (const p of [a, b]) {
      if (segPointDist(p, c, d) <= EPS && !out.some((q) => same(q, p))) out.push({ ...p })
    }
    return out
  }
  const t = (acx * s.y - acy * s.x) / denom
  const u = (acx * r.y - acy * r.x) / denom
  if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return []
  return [{ x: a.x + t * r.x, y: a.y + t * r.y }]
}

/** Insert `p` into the polyline on the edge it lies on (no-op if a vertex). */
function splitAt(points: Pt[], p: Pt): void {
  for (const q of points) if (same(q, p)) return
  for (let i = 0; i < points.length - 1; i++) {
    if (segPointDist(p, points[i], points[i + 1]) <= EPS) {
      points.splice(i + 1, 0, { ...p })
      return
    }
  }
}

/** Ring variant: the closing edge counts. */
function splitRingAt(ring: Pt[], p: Pt): void {
  for (const q of ring) if (same(q, p)) return
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]
    const b = ring[(i + 1) % ring.length]
    if (segPointDist(p, a, b) <= EPS) {
      ring.splice(i + 1, 0, { ...p })
      return
    }
  }
}

type VertexType = 'inside' | 'outside' | 'on-edge'

interface WalkVertex {
  pos: Pt
  type: VertexType
  /** Index along the (split) path; -1 for hull-only vertices. */
  indexP: number
  /** Index along the (split) hull ring; -1 for path-only vertices. */
  indexH: number
  visited: boolean
}

/**
 * Bend `path` around `hull`. `cw: true` follows the hull ring in its stored
 * (clockwise) order; false walks the reversed ring. Returns the bent path,
 * or null when the walk cannot succeed: the path starts inside the hull, or
 * the graph walk dead-ends (PNS returns false on the same conditions and the
 * caller treats the whole direction as stuck).
 *
 * The path's first point is never moved. If the path's LAST point lies
 * inside the hull, the walk ends at its projection onto the hull boundary —
 * the "route toward a pad inside the obstacle" case (PNS's `inLast` exit).
 */
export function walkPathAroundHull(path: readonly Pt[], hull: Hull, cw: boolean): Pt[] | null {
  if (path.length < 2 || hull.length < 3) return null
  // Only the stretch of path whose segments reach the hull's box can bend;
  // the rest passes through untouched. Walking just that stretch gives the
  // same result for a fraction of the work on a long line.
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const q of hull) {
    minX = Math.min(minX, q.x - EPS)
    minY = Math.min(minY, q.y - EPS)
    maxX = Math.max(maxX, q.x + EPS)
    maxY = Math.max(maxY, q.y + EPS)
  }
  const reaches = (i: number): boolean =>
    Math.max(path[i].x, path[i + 1].x) >= minX &&
    Math.min(path[i].x, path[i + 1].x) <= maxX &&
    Math.max(path[i].y, path[i + 1].y) >= minY &&
    Math.min(path[i].y, path[i + 1].y) <= maxY
  let first = -1
  let last = -1
  for (let i = 0; i < path.length - 1; i++) {
    if (!reaches(i)) continue
    if (first < 0) first = i
    last = i
  }
  if (first < 0) return path.map((q) => ({ ...q }))
  if (first === 0 && last === path.length - 2) return walkWhole(path, hull, cw)
  const middle = walkWhole(path.slice(first, last + 2), hull, cw)
  if (!middle) return null
  return [
    ...path.slice(0, first).map((q) => ({ ...q })),
    ...middle,
    ...path.slice(last + 2).map((q) => ({ ...q }))
  ]
}

function walkWhole(path: readonly Pt[], hull: Hull, cw: boolean): Pt[] | null {
  const start = path[0]
  if (pointInRing(start, hull) && !onRing(start, hull)) return null

  const p: Pt[] = path.map((q) => ({ ...q }))
  const ring: Pt[] = (cw ? hull : [...hull].reverse()).map((q) => ({ ...q }))

  // Split both at every crossing so shared vertices exist in both chains.
  const crossings: Pt[] = []
  for (let i = 0; i < p.length - 1; i++) {
    for (let j = 0; j < ring.length; j++) {
      for (const ip of segSegIntersections(p[i], p[i + 1], ring[j], ring[(j + 1) % ring.length])) {
        if (!crossings.some((q) => same(q, ip))) crossings.push(ip)
      }
    }
  }
  for (const ip of crossings) {
    splitAt(p, ip)
    splitRingAt(ring, ip)
  }
  // Path vertices sitting on the ring (but not ring vertices) split the ring
  // too, so the walk can transfer at them.
  for (const q of p) {
    if (onRing(q, ring)) splitRingAt(ring, q)
  }

  const last = p[p.length - 1]
  const lastInside = pointInRing(last, ring) && !onRing(last, ring)

  // Build the vertex graph: path vertices (typed), then hull-only vertices.
  const vertices: WalkVertex[] = p.map((pos, indexP) => ({
    pos,
    type: onRing(pos, ring) ? 'on-edge' : pointInRing(pos, ring) ? 'inside' : 'outside',
    indexP,
    indexH: -1,
    visited: false
  }))
  const hullVertexAt: number[] = []
  ring.forEach((pos, indexH) => {
    const existing = vertices.findIndex((v) => same(v.pos, pos))
    if (existing >= 0) {
      vertices[existing].indexH = indexH
      hullVertexAt[indexH] = existing
    } else {
      hullVertexAt[indexH] = vertices.length
      vertices.push({ pos, type: 'on-edge', indexP: -1, indexH, visited: false })
    }
  })
  const nextOnHull = (v: WalkVertex): WalkVertex | null =>
    v.indexH >= 0 ? vertices[hullVertexAt[(v.indexH + 1) % ring.length]] : null

  const out: Pt[] = []
  let v: WalkVertex | null = vertices[0]
  let lastDist = Infinity
  let appendFinal = true
  let iterLimit = 2000

  while (v && v.indexP !== p.length - 1) {
    if (--iterLimit === 0) return null
    if (v.visited) break
    out.push({ ...v.pos })
    let next: WalkVertex | null

    if (v.type === 'outside') {
      // Follow the path. Post-split, an outside vertex's successor is never
      // interior (the boundary crossing was inserted between them) — if it
      // reads as interior anyway, the geometry is degenerate: stuck.
      const succ = v.indexP >= 0 && v.indexP + 1 < p.length ? vertices[v.indexP + 1] : null
      if (!succ || succ.type === 'inside') return null
      next = succ
    } else if (v.type === 'inside') {
      // Only reachable through eps misclassification; never emit it.
      return null
    } else {
      // On the hull: leave for the path as soon as possible.
      const succ = v.indexP >= 0 && v.indexP + 1 < p.length ? vertices[v.indexP + 1] : null
      if (succ && succ.type === 'outside') {
        next = succ
      } else if (succ && succ.type === 'on-edge' && succ.indexH === -1) {
        // A path run along the boundary (collinear touch) is fine to follow.
        next = succ
      } else {
        next = nextOnHull(v)
        if (next && lastInside) {
          // The target sits inside this hull: once continuing around stops
          // getting closer to it, end at the projection onto this edge.
          const d = (next.pos.x - last.x) ** 2 + (next.pos.y - last.y) ** 2
          if (d < lastDist) {
            lastDist = d
          } else {
            const proj = projectOntoSegment(last, v.pos, next.pos)
            out.push(proj)
            appendFinal = false
            break
          }
        }
        if (next?.visited) {
          // Completed a lap without an exit; allow one more pass only when
          // chasing the inside endpoint, else the walk is stuck.
          if (!lastInside) return null
          for (const w of vertices) if (w.indexH >= 0) w.visited = false
          if (next) next.visited = false
        }
      }
      if (!next) return null
    }

    v.visited = true
    v = next
  }

  if (v && appendFinal) out.push({ ...v.pos })

  // Drop consecutive duplicates the splitting may have produced.
  const cleaned: Pt[] = []
  for (const q of out) {
    if (cleaned.length === 0 || !same(cleaned[cleaned.length - 1], q)) cleaned.push(q)
  }
  return cleaned.length >= 2 ? cleaned : null
}

function projectOntoSegment(p: Pt, a: Pt, b: Pt): Pt {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const l2 = dx * dx + dy * dy
  if (l2 === 0) return { ...a }
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2
  t = Math.max(0, Math.min(1, t))
  return { x: a.x + t * dx, y: a.y + t * dy }
}

/** Polyline length. */
export function pathLength(path: readonly Pt[]): number {
  let len = 0
  for (let i = 0; i < path.length - 1; i++) {
    len += Math.hypot(path[i + 1].x - path[i].x, path[i + 1].y - path[i].y)
  }
  return len
}
