/**
 * Plain polyline geometry the router's stages share: the tidy-up every
 * proposal passes through (docs/router-behavior.md R17, R26), and the side
 * test that makes a route keep to the side of an obstacle it already has
 * (R7, R8).
 */

import type { CopperShape, Pt } from '../spatialIndex'
import { sampleArc } from '../spatialIndex'

/** Point identity (mm), far below any real feature and far above float noise. */
export const GEOM_EPS = 1e-6

export const samePt = (a: Pt, b: Pt): boolean =>
  Math.abs(a.x - b.x) <= GEOM_EPS && Math.abs(a.y - b.y) <= GEOM_EPS

const cross = (ax: number, ay: number, bx: number, by: number): number => ax * by - ay * bx

export function pathLength(path: readonly Pt[]): number {
  let len = 0
  for (let i = 0; i < path.length - 1; i++) {
    len += Math.hypot(path[i + 1].x - path[i].x, path[i + 1].y - path[i].y)
  }
  return len
}

/**
 * Drop zero-length steps, merge straight runs, and fold a step that doubles
 * straight back on the one before it (it would draw copper over itself).
 */
export function mergeColinear(path: readonly Pt[]): Pt[] {
  const out: Pt[] = []
  for (const p of path) {
    if (
      out.length > 0 &&
      Math.hypot(p.x - out[out.length - 1].x, p.y - out[out.length - 1].y) < 1e-9
    ) {
      // A repeat of the start keeps the start; any other keeps the later
      // point, so a pinned end is never traded for a computed one beside it.
      if (out.length > 1) out[out.length - 1] = { ...p }
      continue
    }
    out.push({ ...p })
    // Settle the new corner against the two points before it.
    while (out.length >= 3) {
      const a = out[out.length - 3]
      const b = out[out.length - 2]
      const c = out[out.length - 1]
      const ux = b.x - a.x
      const uy = b.y - a.y
      const vx = c.x - b.x
      const vy = c.y - b.y
      const lu = Math.hypot(ux, uy)
      const lv = Math.hypot(vx, vy)
      if (Math.abs(cross(ux, uy, vx, vy)) > 1e-9 * Math.max(1, lu * lv)) break
      // Straight on, or straight back: either way b is not a corner.
      out.splice(out.length - 2, 1)
      if (samePt(out[out.length - 1], out[out.length - 2])) out.pop()
    }
  }
  return out
}

/** Where segments ab and cd properly cross, as the parameter along ab. */
function crossingParam(a: Pt, b: Pt, c: Pt, d: Pt): number | null {
  const rx = b.x - a.x
  const ry = b.y - a.y
  const sx = d.x - c.x
  const sy = d.y - c.y
  const denom = cross(rx, ry, sx, sy)
  if (Math.abs(denom) < 1e-12) return null
  const t = cross(c.x - a.x, c.y - a.y, sx, sy) / denom
  const u = cross(c.x - a.x, c.y - a.y, rx, ry) / denom
  if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null
  return Math.max(0, Math.min(1, t))
}

/**
 * Cut out every loop: where the path crosses or touches its own earlier
 * part, keep the way in and the way out and drop what lies between (R17).
 * The ends never move.
 */
export function removeLoops(path: readonly Pt[]): Pt[] {
  let p = mergeColinear(path)
  for (let guard = 0; guard < 64; guard++) {
    let cut: { i: number; j: number; at: Pt } | null = null
    outer: for (let i = 0; i < p.length - 1; i++) {
      // The farthest later segment touching segment i: cutting there drops
      // the largest loop at once.
      for (let j = p.length - 2; j >= i + 2; j--) {
        const t = crossingParam(p[i], p[i + 1], p[j], p[j + 1])
        if (t === null) continue
        const at = { x: p[i].x + t * (p[i + 1].x - p[i].x), y: p[i].y + t * (p[i + 1].y - p[i].y) }
        cut = { i, j, at }
        break outer
      }
    }
    if (!cut) return p
    p = mergeColinear([...p.slice(0, cut.i + 1), cut.at, ...p.slice(cut.j + 1)])
  }
  return p
}

/** The tidy-up every proposal passes through before anyone sees it. */
export const tidyPath = (path: readonly Pt[]): Pt[] => removeLoops(mergeColinear(path))

/** Whether a path crosses itself anywhere (the invariant R17 promises). */
export function selfCrosses(path: readonly Pt[]): boolean {
  for (let i = 0; i < path.length - 1; i++) {
    for (let j = i + 2; j < path.length - 1; j++) {
      if (crossingParam(path[i], path[i + 1], path[j], path[j + 1]) !== null) return true
    }
  }
  return false
}

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

/**
 * A few points inside a copper shape's own copper, which lie on one side of
 * any route that clears it. They say which side of a route an obstacle is on.
 */
export function shapeCore(shape: CopperShape): Pt[] {
  switch (shape.kind) {
    case 'capsule':
      return [
        { x: shape.x0, y: shape.y0 },
        { x: (shape.x0 + shape.x1) / 2, y: (shape.y0 + shape.y1) / 2 },
        { x: shape.x1, y: shape.y1 }
      ]
    case 'circle':
      return [{ x: shape.cx, y: shape.cy }]
    case 'rrect':
      return [{ x: shape.cx, y: shape.cy }]
    case 'arc':
      return sampleArc(shape.x0, shape.y0, shape.mx, shape.my, shape.x1, shape.y1, 4)
    case 'poly':
      return shape.rings[0] ? shape.rings[0].map((p) => ({ ...p })) : []
    case 'compound':
      return shape.parts.flatMap(shapeCore)
  }
}

/**
 * Whether two convex rings overlap (touching counts): no edge of either
 * separates them.
 */
export function convexOverlap(a: readonly Pt[], b: readonly Pt[]): boolean {
  for (const ring of [a, b]) {
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i]
      const q = ring[(i + 1) % ring.length]
      const nx = -(q.y - p.y)
      const ny = q.x - p.x
      let minA = Infinity
      let maxA = -Infinity
      let minB = Infinity
      let maxB = -Infinity
      for (const v of a) {
        const d = v.x * nx + v.y * ny
        minA = Math.min(minA, d)
        maxA = Math.max(maxA, d)
      }
      for (const v of b) {
        const d = v.x * nx + v.y * ny
        minB = Math.min(minB, d)
        maxB = Math.max(maxB, d)
      }
      if (maxA < minB - 1e-12 || maxB < minA - 1e-12) return false
    }
  }
  return true
}

/** +1 for a left turn at b, −1 right, 0 straight. */
export function turnSign(a: Pt, b: Pt, c: Pt): number {
  return Math.sign(cross(b.x - a.x, b.y - a.y, c.x - b.x, c.y - b.y))
}

/**
 * The convex polygon bounding `ring` with edges only in the given directions
 * (unit normals, counterclockwise order): the octagon of 45° routing, the
 * rectangle of 90°. Wound clockwise, as every hull is.
 */
export function boundByDirections(ring: readonly Pt[], normals: readonly Pt[]): Pt[] {
  const h = normals.map((n) => Math.max(...ring.map((p) => p.x * n.x + p.y * n.y)))
  const out: Pt[] = []
  for (let k = 0; k < normals.length; k++) {
    const n1 = normals[k]
    const n2 = normals[(k + 1) % normals.length]
    const det = n1.x * n2.y - n1.y * n2.x
    const x = (h[k] * n2.y - h[(k + 1) % normals.length] * n1.y) / det
    const y = (n1.x * h[(k + 1) % normals.length] - n2.x * h[k]) / det
    const p = { x, y }
    if (out.length === 0 || !samePt(out[out.length - 1], p)) out.push(p)
  }
  if (out.length > 1 && samePt(out[0], out[out.length - 1])) out.pop()
  return out.reverse()
}

const S = Math.SQRT1_2
export const OCTILINEAR_NORMALS: readonly Pt[] = [
  { x: 1, y: 0 },
  { x: S, y: S },
  { x: 0, y: 1 },
  { x: -S, y: S },
  { x: -1, y: 0 },
  { x: -S, y: -S },
  { x: 0, y: -1 },
  { x: S, y: -S }
]
export const AXIS_NORMALS: readonly Pt[] = [
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
  { x: 0, y: -1 }
]

/** An arc a→mid→b as a polyline, for judging and as copper in a world. */
export function arcPolyline(a: Pt, mid: Pt, b: Pt, pieces = 8): Pt[] {
  const ax = mid.x - a.x
  const ay = mid.y - a.y
  const bx = b.x - a.x
  const by = b.y - a.y
  const d = 2 * (ax * by - ay * bx)
  if (Math.abs(d) < 1e-12) return [a, b]
  const ux = (by * (ax * ax + ay * ay) - ay * (bx * bx + by * by)) / d
  const uy = (ax * (bx * bx + by * by) - bx * (ax * ax + ay * ay)) / d
  const c = { x: a.x + ux, y: a.y + uy }
  const r = Math.hypot(ux, uy)
  const angle = (p: Pt): number => Math.atan2(p.y - c.y, p.x - c.x)
  const a0 = angle(a)
  let sweep = angle(b) - a0
  const mSweep = angle(mid) - a0
  const norm = (x: number): number =>
    (((x % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI)) - Math.PI
  sweep = norm(sweep)
  if (Math.sign(norm(mSweep)) !== Math.sign(sweep)) sweep = sweep - Math.sign(sweep) * 2 * Math.PI
  const out: Pt[] = []
  for (let k = 0; k <= pieces; k++) {
    const t = a0 + (sweep * k) / pieces
    out.push(
      k === 0
        ? { ...a }
        : k === pieces
          ? { ...b }
          : { x: c.x + r * Math.cos(t), y: c.y + r * Math.sin(t) }
    )
  }
  return out
}
