/**
 * Clearance geometry for footprint generation and checks, in the footprint's
 * own frame (integer nanometers, y down).
 *
 * Every pad shape the generator writes is a convex core inflated by a radius:
 * a rect is its four corners and no radius, a roundrect its rect shrunk by the
 * corner radius, a circle one point, an oval the segment between its two end
 * centers. Distance between two such shapes is the distance between the cores
 * less both radii, so one function answers pad-to-pad overlap and
 * silk-to-pad clearance alike.
 */
import type { KicadPad } from '../kicad/footprint'

export interface Point {
  x: number
  y: number
}

/** A convex core (1 point, 2 for a segment, 3+ for a polygon) grown by `radius`. */
export interface Shape {
  core: Point[]
  radius: number
}

export interface Box {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/**
 * A pad-local vector in the footprint frame. KiCad's pad angle turns
 * counter-clockwise as drawn, and y points down.
 */
export const rotateLocal = (x: number, y: number, angle: number): Point => {
  if (!angle) return { x, y }
  const rad = (angle * Math.PI) / 180
  const c = Math.cos(rad)
  const s = Math.sin(rad)
  return { x: x * c + y * s, y: -x * s + y * c }
}

export interface PadGeometry {
  shape: KicadPad['shape']
  position: { x: number; y: number; angle?: number }
  size: { w: number; h: number }
  roundrectRatio?: number
}

/** The copper of a pad as a shape. Custom and trapezoid pads use their box. */
export const padShape = (pad: PadGeometry, grow = 0): Shape => {
  const { w, h } = pad.size
  const angle = pad.position.angle ?? 0
  const at = (x: number, y: number): Point => {
    const r = rotateLocal(x, y, angle)
    return { x: pad.position.x + r.x, y: pad.position.y + r.y }
  }
  const rectCore = (hw: number, hh: number): Point[] => [
    at(-hw, -hh),
    at(hw, -hh),
    at(hw, hh),
    at(-hw, hh)
  ]
  switch (pad.shape) {
    case 'circle':
      return { core: [at(0, 0)], radius: Math.max(w, h) / 2 + grow }
    case 'oval': {
      const r = Math.min(w, h) / 2
      const half = Math.abs(w - h) / 2
      const core = w >= h ? [at(-half, 0), at(half, 0)] : [at(0, -half), at(0, half)]
      return { core, radius: r + grow }
    }
    case 'roundrect': {
      const radius = Math.min(w, h) * (pad.roundrectRatio ?? 0.25)
      return { core: rectCore(w / 2 - radius, h / 2 - radius), radius: radius + grow }
    }
    default:
      return { core: rectCore(w / 2, h / 2), radius: grow }
  }
}

export const shapeBox = (shape: Shape): Box => {
  const xs = shape.core.map((p) => p.x)
  const ys = shape.core.map((p) => p.y)
  return {
    minX: Math.min(...xs) - shape.radius,
    minY: Math.min(...ys) - shape.radius,
    maxX: Math.max(...xs) + shape.radius,
    maxY: Math.max(...ys) + shape.radius
  }
}

export const unionBox = (a: Box | null, b: Box): Box =>
  a
    ? {
        minX: Math.min(a.minX, b.minX),
        minY: Math.min(a.minY, b.minY),
        maxX: Math.max(a.maxX, b.maxX),
        maxY: Math.max(a.maxY, b.maxY)
      }
    : { ...b }

export const pointsBox = (points: Point[]): Box => ({
  minX: Math.min(...points.map((p) => p.x)),
  minY: Math.min(...points.map((p) => p.y)),
  maxX: Math.max(...points.map((p) => p.x)),
  maxY: Math.max(...points.map((p) => p.y))
})

const cross = (o: Point, a: Point, b: Point): number =>
  (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)

const pointSegmentDistance = (p: Point, a: Point, b: Point): number => {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const length2 = dx * dx + dy * dy
  const t = length2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length2)) : 0
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

const segmentsCross = (a: Point, b: Point, c: Point, d: Point): boolean => {
  const d1 = cross(c, d, a)
  const d2 = cross(c, d, b)
  const d3 = cross(a, b, c)
  const d4 = cross(a, b, d)
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
}

const segmentDistance = (a: Point, b: Point, c: Point, d: Point): number =>
  segmentsCross(a, b, c, d)
    ? 0
    : Math.min(
        pointSegmentDistance(a, c, d),
        pointSegmentDistance(b, c, d),
        pointSegmentDistance(c, a, b),
        pointSegmentDistance(d, a, b)
      )

/** Whether a point is inside a convex polygon, either winding. */
const insideConvex = (p: Point, polygon: Point[]): boolean => {
  if (polygon.length < 3) return false
  let sign = 0
  for (let i = 0; i < polygon.length; i++) {
    const value = cross(polygon[i], polygon[(i + 1) % polygon.length], p)
    if (value === 0) continue
    const s = Math.sign(value)
    if (sign && s !== sign) return false
    sign = s
  }
  return true
}

const edges = (core: Point[]): Array<[Point, Point]> => {
  if (core.length === 1) return [[core[0], core[0]]]
  if (core.length === 2) return [[core[0], core[1]]]
  return core.map((p, i) => [p, core[(i + 1) % core.length]])
}

/** Distance between two convex cores; 0 when they touch or overlap. */
const coreDistance = (a: Point[], b: Point[]): number => {
  if (a.some((p) => insideConvex(p, b)) || b.some((p) => insideConvex(p, a))) return 0
  let best = Infinity
  for (const [p, q] of edges(a)) {
    for (const [r, s] of edges(b)) {
      best = Math.min(best, segmentDistance(p, q, r, s))
      if (best === 0) return 0
    }
  }
  return best
}

/** Gap between two shapes' outlines; negative when they overlap. */
export const shapeGap = (a: Shape, b: Shape): number =>
  coreDistance(a.core, b.core) - a.radius - b.radius

/** Gap between a stroke's centerline point and a shape's outline. */
export const pointGap = (p: Point, shape: Shape): number =>
  coreDistance([p], shape.core) - shape.radius

/** Gap between a segment and a shape's outline. */
export const segmentGap = (a: Point, b: Point, shape: Shape): number =>
  coreDistance([a, b], shape.core) - shape.radius

/**
 * The part of the segment a→b, as parameters in [0, 1], lying closer than
 * `clearance` to `shape`, or null. Distance from a convex shape is convex
 * along a line, so the part is one interval: the minimum is found by ternary
 * search and each end by bisection.
 */
const blockedInterval = (
  a: Point,
  b: Point,
  shape: Shape,
  clearance: number
): [number, number] | null => {
  const at = (t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
  const gap = (t: number): number => pointGap(at(t), shape)
  if (segmentGap(a, b, shape) >= clearance) return null
  let lo = 0
  let hi = 1
  for (let i = 0; i < 60; i++) {
    const m1 = lo + (hi - lo) / 3
    const m2 = hi - (hi - lo) / 3
    if (gap(m1) <= gap(m2)) hi = m2
    else lo = m1
  }
  const tMin = (lo + hi) / 2
  const edge = (from: number, to: number): number => {
    // `from` is blocked; walk toward `to` for the last blocked parameter.
    if (gap(to) < clearance) return to
    let inside = from
    let outside = to
    for (let i = 0; i < 50; i++) {
      const mid = (inside + outside) / 2
      if (gap(mid) < clearance) inside = mid
      else outside = mid
    }
    return (inside + outside) / 2
  }
  return [edge(tMin, 0), edge(tMin, 1)]
}

/**
 * A segment with every stretch closer than `clearance` to any shape removed,
 * pieces shorter than `minLength` dropped.
 */
export const cutSegment = (
  a: Point,
  b: Point,
  shapes: Shape[],
  clearance: number,
  minLength: number
): Array<[Point, Point]> => {
  const blocked = shapes
    .map((shape) => blockedInterval(a, b, shape, clearance))
    .filter((interval): interval is [number, number] => interval !== null)
    .sort((x, y) => x[0] - y[0])
  const free: Array<[number, number]> = []
  let cursor = 0
  for (const [start, end] of blocked) {
    if (start > cursor) free.push([cursor, start])
    cursor = Math.max(cursor, end)
  }
  if (cursor < 1) free.push([cursor, 1])
  const length = Math.hypot(b.x - a.x, b.y - a.y)
  const at = (t: number): Point => ({
    x: Math.round(a.x + (b.x - a.x) * t),
    y: Math.round(a.y + (b.y - a.y) * t)
  })
  return free
    .filter(([start, end]) => (end - start) * length >= minLength)
    .map(([start, end]) => [at(start), at(end)])
}

/** Twice the signed area; positive for a clockwise polygon on a y-down screen. */
export const signedArea2 = (points: Point[]): number => {
  let sum = 0
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    const q = points[(i + 1) % points.length]
    sum += p.x * q.y - q.x * p.y
  }
  return sum
}

/**
 * A simple polygon offset outward by `distance`, mitered at each corner: every
 * edge moves along its outward normal and consecutive edges meet where their
 * moved lines cross.
 */
export const offsetPolygon = (points: Point[], distance: number): Point[] => {
  const n = points.length
  // Outward normal for a y-down clockwise (positive area) polygon is (dy, -dx).
  const orientation = signedArea2(points) >= 0 ? 1 : -1
  const lines = points.map((p, i) => {
    const q = points[(i + 1) % n]
    const length = Math.hypot(q.x - p.x, q.y - p.y) || 1
    const nx = ((q.y - p.y) / length) * orientation
    const ny = (-(q.x - p.x) / length) * orientation
    return {
      p: { x: p.x + nx * distance, y: p.y + ny * distance },
      d: { x: q.x - p.x, y: q.y - p.y }
    }
  })
  return lines.map((line, i) => {
    const prev = lines[(i - 1 + n) % n]
    const det = prev.d.x * line.d.y - prev.d.y * line.d.x
    if (Math.abs(det) < 1e-9) return line.p
    const t = ((line.p.x - prev.p.x) * line.d.y - (line.p.y - prev.p.y) * line.d.x) / det
    return { x: Math.round(prev.p.x + prev.d.x * t), y: Math.round(prev.p.y + prev.d.y * t) }
  })
}

export const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y)
