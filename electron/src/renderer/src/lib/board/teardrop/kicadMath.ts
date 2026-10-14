/**
 * The slice of KiCad's integer geometry (libs/kimath) the teardrop builder
 * leans on, with KiCad's rounding: `VECTOR2I` from doubles truncates, `KiROUND`
 * rounds half away from zero, `rescale` rounds to nearest. Coordinates are the
 * file's: integer nanometers, y down. Each function names the KiCad one it
 * follows; teardrop output has to match KiCad's to the nanometer.
 */

import { arcCenterFromPoints, roundPoint } from '../../kicad/kicadArc'

export interface IPt {
  x: number
  y: number
}

/** KiCad's `KiROUND`: half away from zero. */
export const kiRound = (v: number): number => (v < 0 ? -Math.round(-v) : Math.round(v))

/** A C++ `static_cast<int>( double )`: toward zero. */
export const toInt = (v: number): number => Math.trunc(v)

export const pt = (x: number, y: number): IPt => ({ x, y })
export const add = (a: IPt, b: IPt): IPt => ({ x: a.x + b.x, y: a.y + b.y })
export const sub = (a: IPt, b: IPt): IPt => ({ x: a.x - b.x, y: a.y - b.y })
export const same = (a: IPt, b: IPt): boolean => a.x === b.x && a.y === b.y
/** `VECTOR2I / 2` on integers (truncating). */
export const half = (a: IPt): IPt => ({ x: toInt(a.x / 2), y: toInt(a.y / 2) })
/** `VECTOR2I( VECTOR2D )` and `VECTOR2I( double, double )`: truncating. */
export const truncPt = (x: number, y: number): IPt => ({ x: toInt(x), y: toInt(y) })

/** `rescale( int64 numerator, value, denominator )`: (n·v ± d/2) / d, exact. */
export function rescale(numerator: number, value: number, denominator: number): number {
  const n = BigInt(numerator) * BigInt(value)
  const d = BigInt(denominator)
  const halfD = d / 2n
  const q = n < 0n !== d < 0n ? (n - halfD) / d : (n + halfD) / d
  return Number(q)
}

/** `VECTOR2I::EuclideanNorm`, rounded to an integer. */
export function norm(v: IPt): number {
  if (Math.abs(v.x) === Math.abs(v.y)) return kiRound(Math.abs(v.x) * Math.SQRT2)
  if (v.x === 0) return Math.abs(v.y)
  if (v.y === 0) return Math.abs(v.x)
  return kiRound(Math.hypot(v.x, v.y))
}

/** `VECTOR2D::EuclideanNorm`. */
export const normD = (v: IPt): number => Math.hypot(v.x, v.y)

/** `VECTOR2I::Resize`. */
export function resize(v: IPt, length: number): IPt {
  if (v.x === 0 && v.y === 0) return { x: 0, y: 0 }
  let nx: number
  let ny: number
  if (Math.abs(v.x) === Math.abs(v.y)) nx = ny = Math.abs(length) * Math.SQRT1_2
  else {
    const l2 = v.x * v.x + v.y * v.y
    const n2 = length * length
    nx = Math.sqrt(rescale(n2, v.x * v.x, l2))
    ny = Math.sqrt(rescale(n2, v.y * v.y, l2))
  }
  const sign = length < 0 ? -1 : length > 0 ? 1 : 0
  return {
    x: (v.x < 0 ? -kiRound(nx) : kiRound(nx)) * sign,
    y: (v.y < 0 ? -kiRound(ny) : kiRound(ny)) * sign
  }
}

/** `SEG::Length`. */
export const segLength = (a: IPt, b: IPt): number => norm(sub(a, b))

/** `EDA_ANGLE( VECTOR2D )`, in degrees. */
export function angleOf(v: IPt): number {
  if (v.x === 0 && v.y === 0) return 0
  if (v.y === 0) return v.x >= 0 ? 0 : -180
  if (v.x === 0) return v.y >= 0 ? 90 : -90
  if (v.x === v.y) return v.x >= 0 ? 45 : -180 + 45
  if (v.x === -v.y) return v.x >= 0 ? -45 : 180 - 45
  return (Math.atan2(v.y, v.x) * 180) / Math.PI
}

/** `EDA_ANGLE::DEGREES_TO_RADIANS`. */
const DEG2RAD = Math.PI / 180

const normalize = (deg: number): number => {
  let a = deg
  while (a < 0) a += 360
  while (a >= 360) a -= 360
  return a
}

/** `EDA_ANGLE::Sin`. */
function sinOf(deg: number): number {
  const a = normalize(deg)
  if (a === 0 || a === 180) return 0
  if (a === 45 || a === 135) return Math.SQRT1_2
  if (a === 225 || a === 315) return -Math.SQRT1_2
  if (a === 90) return 1
  if (a === 270) return -1
  return Math.sin(a * DEG2RAD)
}

/** `EDA_ANGLE::Cos`. */
function cosOf(deg: number): number {
  const a = normalize(deg)
  if (a === 0) return 1
  if (a === 180) return -1
  if (a === 90 || a === 270) return 0
  if (a === 45 || a === 315) return Math.SQRT1_2
  if (a === 135 || a === 225) return -Math.SQRT1_2
  return Math.cos(a * DEG2RAD)
}

/** `RotatePoint( VECTOR2I&, const EDA_ANGLE& )` on integers. */
export function rotate(p: IPt, deg: number): IPt {
  const a = normalize(deg)
  if (a === 0) return { x: p.x, y: p.y }
  if (a === 90) return { x: p.y, y: -p.x }
  if (a === 180) return { x: -p.x, y: -p.y }
  if (a === 270) return { x: -p.y, y: p.x }
  const s = sinOf(a)
  const c = cosOf(a)
  return { x: kiRound(p.y * s + p.x * c), y: kiRound(p.y * c - p.x * s) }
}

/** `RotatePoint( VECTOR2I&, centre, angle )`. */
export const rotateAbout = (p: IPt, center: IPt, deg: number): IPt =>
  add(rotate(sub(p, center), deg), center)

/** `SEG::intersects` (segments, endpoints counted): the crossing, or null. */
export function segIntersect(a: IPt, b: IPt, c: IPt, d: IPt): IPt | null {
  if (
    Math.max(a.x, b.x) < Math.min(c.x, d.x) ||
    Math.max(c.x, d.x) < Math.min(a.x, b.x) ||
    Math.max(a.y, b.y) < Math.min(c.y, d.y) ||
    Math.max(c.y, d.y) < Math.min(a.y, b.y)
  )
    return null
  const dir1 = sub(b, a)
  const dir2 = sub(d, c)
  const offset = sub(c, a)
  const cross = (u: IPt, v: IPt): number => u.x * v.y - u.y * v.x
  const det = cross(dir2, dir1)
  if (det === 0) {
    if (cross(dir1, offset) !== 0) return null
    return collinearOverlap(a, b, c, d, Math.abs(dir1.x) >= Math.abs(dir1.y))
  }
  const p2 = cross(dir2, offset)
  const p1 = cross(dir1, offset)
  if (det > 0) {
    if (p1 < 0 || p1 > det || p2 < 0 || p2 > det) return null
  } else if (p1 > 0 || p1 < det || p2 > 0 || p2 < det) return null
  return { x: c.x + rescale(p1, dir2.x, det), y: c.y + rescale(p1, dir2.y, det) }
}

/** `SEG::checkCollinearOverlap`: the middle of the shared stretch. */
function collinearOverlap(a: IPt, b: IPt, c: IPt, d: IPt, useX: boolean): IPt | null {
  const [s1, e1, s2, e2, o1, o2] = useX
    ? [a.x, b.x, c.x, d.x, a.y, b.y]
    : [a.y, b.y, c.y, d.y, a.x, b.x]
  const min1 = Math.min(s1, e1)
  const max1 = Math.max(s1, e1)
  const min2 = Math.min(s2, e2)
  const max2 = Math.max(s2, e2)
  if (!(max1 >= min2 && max2 >= min1)) return null
  const proj = toInt((Math.max(min1, min2) + Math.min(max1, max2)) / 2)
  const other = e1 !== s1 ? o1 + rescale(proj - s1, o2 - o1, e1 - s1) : o1
  return useX ? { x: proj, y: other } : { x: other, y: proj }
}

/**
 * `SHAPE_LINE_CHAIN::Intersect( SEG )` on a closed ring: every crossing, sorted
 * by rounded distance from the segment's start (a stable sort: KiCad's
 * `std::sort` leaves ties in an unspecified order).
 */
export function ringIntersectSeg(ring: readonly IPt[], a: IPt, b: IPt): IPt[] {
  const hits: IPt[] = []
  for (let s = 0; s < ring.length; s++) {
    const p = segIntersect(ring[s], ring[(s + 1) % ring.length], a, b)
    if (p) hits.push(p)
  }
  return hits
    .map((p) => ({ p, d: norm(sub(a, p)) }))
    .sort((x, y) => x.d - y.d)
    .map((h) => h.p)
}

/**
 * `SHAPE_LINE_CHAIN::Intersect( SHAPE_LINE_CHAIN )` of a closed ring and an
 * open polyline: the crossings in the ring's segment order, then the
 * polyline's.
 */
export function ringIntersectPolyline(ring: readonly IPt[], line: readonly IPt[]): IPt[] {
  const hits: IPt[] = []
  for (let s = 0; s < ring.length; s++) {
    for (let t = 0; t + 1 < line.length; t++) {
      const p = segIntersect(ring[s], ring[(s + 1) % ring.length], line[t], line[t + 1])
      if (p) hits.push(p)
    }
  }
  return hits
}

/** `SHAPE_LINE_CHAIN_BASE::PointInside` (no accuracy): crossing parity. */
export function pointInside(ring: readonly IPt[], p: IPt): boolean {
  if (ring.length < 3) return false
  let inside = false
  for (let i = 0; i < ring.length;) {
    const p1 = ring[i++]
    const p2 = ring[i === ring.length ? 0 : i]
    const dy = p2.y - p1.y
    if (dy === 0) continue
    const d = intRescale(p2.x - p1.x, p.y - p1.y, dy)
    if (p1.y >= p.y !== p2.y >= p.y && p.x - p1.x < d) inside = !inside
  }
  return inside
}

/** `rescale( int, int, int )`. */
function intRescale(numerator: number, value: number, denominator: number): number {
  const n = numerator * value
  const h = toInt(denominator / 2)
  return n < 0 !== denominator < 0 ? toInt((n - h) / denominator) : toInt((n + h) / denominator)
}

/** `SHAPE_POLY_SET::Contains` over outlines with holes, no accuracy. */
export function polysContain(polys: readonly IPolygon[], p: IPt): boolean {
  return polys.some(
    (poly) => pointInside(poly.outline, p) && !poly.holes.some((hole) => pointInside(hole, p))
  )
}

export interface IPolygon {
  outline: IPt[]
  holes: IPt[][]
}

/** `SHAPE_LINE_CHAIN::Area` of a closed ring, signed as KiCad signs it. */
export function ringArea(ring: readonly IPt[]): number {
  let area = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++)
    area += (ring[j].x + ring[i].x) * (ring[j].y - ring[i].y)
  return -area * 0.5
}

/** `BuildConvexHull` (Andrew's monotone chain, collinear points dropped). */
export function convexHull(points: readonly IPt[]): IPt[] {
  if (points.length < 2) return []
  const poly = [...points].sort((a, b) => a.x - b.x || a.y - b.y)
  const cross = (o: IPt, a: IPt, b: IPt): number =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
  const out: IPt[] = []
  for (const p of poly) {
    while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop()
    out.push(p)
  }
  const t = out.length + 1
  for (let i = poly.length - 2; i >= 0; i--) {
    while (out.length >= t && cross(out[out.length - 2], out[out.length - 1], poly[i]) <= 0)
      out.pop()
    out.push(poly[i])
  }
  if (out.length > 1 && same(out[0], out[out.length - 1])) out.pop()
  return out
}

/** `GetArcToSegmentCount` for a full turn. */
export function circleSegments(radius: number, maxError: number): number {
  const r = Math.max(1, radius)
  const e = Math.max(1, maxError)
  const increment = Math.min(360 / 8, (180 / Math.PI) * Math.acos(1 - e / r) * 2)
  return Math.max(kiRound(360 / increment), 2)
}

/** `TransformCircleToPolygon( ERROR_INSIDE, 16 )`: vertices on the circle. */
export function circlePolygon(center: IPt, radius: number, maxError: number): IPt[] {
  let n = Math.max(16, circleSegments(radius, maxError))
  n = Math.ceil(n / 8) * 8
  const delta = 360 / n
  const out: IPt[] = []
  for (let angle = delta / 2; angle < 360; angle += delta)
    out.push(add(rotate({ x: radius, y: 0 }, angle), center))
  return out
}

/** `TestSegmentHit`: whether p lies within `dist` of segment ab. */
export function segmentHit(p: IPt, a: IPt, b: IPt, dist: number): boolean {
  const d = sub(b, a)
  const l2 = d.x * d.x + d.y * d.y
  if (l2 === 0) return (p.x - a.x) ** 2 + (p.y - a.y) ** 2 <= dist * dist
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * d.x + (p.y - a.y) * d.y) / l2))
  const qx = a.x + t * d.x - p.x
  const qy = a.y + t * d.y - p.y
  return qx * qx + qy * qy <= dist * dist
}

/**
 * `SHAPE_ARC( start, mid, end, width ).ConvertToPolyline( maxError )`: the
 * ends exact, the points between half the error band outside the arc.
 */
export function arcPolyline(
  start: IPt,
  mid: IPt,
  end: IPt,
  width: number,
  maxError: number
): IPt[] {
  const c = roundPoint(arcCenterFromPoints(start, mid, end))
  const r0 = Math.sqrt((start.x - c.x) ** 2 + (start.y - c.y) ** 2)
  const sa = normalize(angleOf(sub(start, c)))
  let ca: number
  if (same(start, end)) ca = 360
  else {
    ca = angleOf(sub(end, c)) - angleOf(sub(start, c))
    const ccw = (end.x - mid.x) * (start.y - mid.y) - (end.y - mid.y) * (start.x - mid.x) > 0
    if (ccw && ca < 0) ca += 360
    if (!ccw && ca > 0) ca -= 360
  }
  const halfMaxError = Math.max(1, maxError / 2)
  const external = r0 + width / 2
  let n: number
  let effectiveError: number
  if (external < halfMaxError || segmentDistance(start, end, mid) < halfMaxError) {
    n = 0
    effectiveError = external
  } else {
    n = arcSegments(toInt(external), maxError, ca)
    const seg360 = toInt((n * 360) / Math.abs(ca))
    effectiveError = endSegmentDeltaRadius(toInt(external), seg360)
  }
  const r = r0 + effectiveError / 2
  n *= 2
  const out: IPt[] = [start]
  for (let i = 1; i < n; i += 2) {
    const a = sa + (ca * i) / n
    out.push({ x: kiRound(c.x + r * cosOf(a)), y: kiRound(c.y + r * sinOf(a)) })
  }
  out.push(end)
  return out
}

/** `GetArcToSegmentCount( radius, error, arcAngle )`. */
function arcSegments(radius: number, maxError: number, degrees: number): number {
  const r = Math.max(1, radius)
  const e = Math.max(1, maxError)
  const increment = Math.min(360 / 8, (180 / Math.PI) * Math.acos(1 - e / r) * 2)
  return Math.max(kiRound(Math.abs(degrees) / increment), 2)
}

/** `CircleToEndSegmentDeltaRadius`. */
function endSegmentDeltaRadius(radius: number, segCount: number): number {
  const n = segCount <= 2 ? 3 : segCount
  return kiRound(Math.abs(radius * (1 - 1 / Math.cos(Math.PI / n))))
}

/** `SEG::Distance( point )`, rounded. */
function segmentDistance(a: IPt, b: IPt, p: IPt): number {
  const d = sub(b, a)
  const l2 = d.x * d.x + d.y * d.y
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * d.x + (p.y - a.y) * d.y) / l2))
  return kiRound(Math.hypot(a.x + t * d.x - p.x, a.y + t * d.y - p.y))
}
