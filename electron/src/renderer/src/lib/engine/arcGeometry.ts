/**
 * Three-point arc math, shared by every renderer that has to draw one.
 *
 * KiCad stores an arc as start / mid / end rather than center + sweep, so each
 * consumer has to recover the circle before it can draw anything. The 2D board
 * scene needs center/radius/bisector for its shader batch; the 3D board scene
 * needs a polyline it can stroke as flat geometry. Both start from the same two
 * pieces of math, which is why they live here rather than a third time in a
 * scene file.
 */

import { distanceToSegment, type Point2 } from '../geometry/distance'

export type { Point2 }

/** Circle through three points, or null when they are collinear. */
export function circumscribedCircle(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  x3: number,
  y3: number
): { cx: number; cy: number; r: number } | null {
  const A = x1 * (y2 - y3) - y1 * (x2 - x3) + x2 * y3 - x3 * y2
  if (Math.abs(A) < 1e-9) return null
  const B =
    (x1 * x1 + y1 * y1) * (y3 - y2) +
    (x2 * x2 + y2 * y2) * (y1 - y3) +
    (x3 * x3 + y3 * y3) * (y2 - y1)
  const C =
    (x1 * x1 + y1 * y1) * (x2 - x3) +
    (x2 * x2 + y2 * y2) * (x3 - x1) +
    (x3 * x3 + y3 * y3) * (x1 - x2)

  const cx = -B / (2 * A)
  const cy = -C / (2 * A)
  return { cx, cy, r: Math.hypot(x1 - cx, y1 - cy) }
}

/** Whether walking CCW from start reaches mid before end: the arc through its mid point. */
export function arcContainsMidCCW(
  pStart: Point2,
  pMid: Point2,
  pEnd: Point2,
  cx: number,
  cy: number
): boolean {
  const normalize = (a: number): number => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
  const nStart = normalize(Math.atan2(pStart.y - cy, pStart.x - cx))
  const nMid = normalize(Math.atan2(pMid.y - cy, pMid.x - cx))
  const nEnd = normalize(Math.atan2(pEnd.y - cy, pEnd.x - cx))
  return nStart <= nEnd ? nMid >= nStart && nMid <= nEnd : nMid >= nStart || nMid <= nEnd
}

/**
 * A three-point arc's signed sweep (radians, CCW positive) as KiCad's zone
 * filler reads it (`SHAPE_ARC::GetCentralAngle`): the turn from start to mid
 * plus the turn from mid to end, each taken the short way round, into
 * (−π, π]. For an arc whose mid lies between its ends it is the arc through the
 * mid; a file whose mid lies just past the end reads as the short arc — where
 * KiCad's DRC, like `arcContainsMidCCW`, goes through the mid the long way round.
 */
export function arcCentralSweep(
  pStart: Point2,
  pMid: Point2,
  pEnd: Point2,
  cx: number,
  cy: number
): number {
  const half = (a: number): number => {
    let t = a % (2 * Math.PI)
    if (t < 0) t += 2 * Math.PI
    return t > Math.PI ? t - 2 * Math.PI : t
  }
  const aStart = Math.atan2(pStart.y - cy, pStart.x - cx)
  const aMid = Math.atan2(pMid.y - cy, pMid.x - cx)
  const aEnd = Math.atan2(pEnd.y - cy, pEnd.x - cx)
  return half(aMid - aStart) + half(aEnd - aMid)
}

/** CCW angle from `from` to `to`, in [0, 2π). */
const ccwDelta = (from: number, to: number): number => {
  const delta = (to - from) % (2 * Math.PI)
  return delta < 0 ? delta + 2 * Math.PI : delta
}

/**
 * The exact bounding box of a three-point arc: its ends, plus each point where
 * the circle meets an axis extreme inside the sweep. Sampling the arc instead
 * cuts the corners by up to r(1 − cos(step/2)), which on a large arc is enough
 * for a spatial query to miss it. Collinear input bounds the straight line.
 */
export function arcBounds(
  pStart: Point2,
  pMid: Point2,
  pEnd: Point2
): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Math.min(pStart.x, pEnd.x)
  let minY = Math.min(pStart.y, pEnd.y)
  let maxX = Math.max(pStart.x, pEnd.x)
  let maxY = Math.max(pStart.y, pEnd.y)
  const circle = circumscribedCircle(pStart.x, pStart.y, pMid.x, pMid.y, pEnd.x, pEnd.y)
  if (!circle) return { minX, minY, maxX, maxY }
  const { cx, cy, r } = circle
  // The sweep runs CCW from `from` through the mid to the other end.
  const ccw = arcContainsMidCCW(pStart, pMid, pEnd, cx, cy)
  const from = ccw ? pStart : pEnd
  const to = ccw ? pEnd : pStart
  const a0 = Math.atan2(from.y - cy, from.x - cx)
  const sweep = ccwDelta(a0, Math.atan2(to.y - cy, to.x - cx))
  for (let k = 0; k < 4; k++) {
    const angle = (k * Math.PI) / 2
    if (ccwDelta(a0, angle) > sweep) continue
    const x = cx + r * Math.cos(angle)
    const y = cy + r * Math.sin(angle)
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
  }
  return { minX, minY, maxX, maxY }
}

/**
 * Distance from a point to the arc ITSELF, for hit-testing.
 *
 * Exact rather than sampled: an arc is part of a circle, so a point whose angle
 * falls inside the sweep is `|distance to center − r|` away and one outside it
 * is nearest an endpoint. That is what keeps the click target on the curve at
 * every zoom — measuring to the start→mid and mid→end CHORDS instead cuts
 * inside the drawing by up to 0.29r on a semicircle, several times the engine's
 * 10-pixel tolerance, which is why an arc used to be almost unclickable.
 *
 * Collinear input has no circle; the renderer draws the straight `start → end`
 * in that case, and so does this.
 */
export function distanceToArc(p: Point2, pStart: Point2, pMid: Point2, pEnd: Point2): number {
  const circle = circumscribedCircle(pStart.x, pStart.y, pMid.x, pMid.y, pEnd.x, pEnd.y)
  if (!circle) return distanceToSegment(p, pStart, pEnd)
  const { cx, cy, r } = circle
  const aStart = Math.atan2(pStart.y - cy, pStart.x - cx)
  const aEnd = Math.atan2(pEnd.y - cy, pEnd.x - cx)
  const aPoint = Math.atan2(p.y - cy, p.x - cx)
  // Which way round the circle the arc runs is the same question the polyline
  // asks, answered by the same helper — so the span tested here and the span
  // drawn cannot disagree.
  const inside = arcContainsMidCCW(pStart, pMid, pEnd, cx, cy)
    ? ccwDelta(aStart, aPoint) <= ccwDelta(aStart, aEnd)
    : ccwDelta(aEnd, aPoint) <= ccwDelta(aEnd, aStart)
  if (inside) return Math.abs(Math.hypot(p.x - cx, p.y - cy) - r)
  return Math.min(
    Math.hypot(p.x - pStart.x, p.y - pStart.y),
    Math.hypot(p.x - pEnd.x, p.y - pEnd.y)
  )
}

/** Resolution of a tessellated arc, in segments per full turn. */
export const ARC_SEGMENTS_PER_TURN = 64

/**
 * The arc as a polyline from start to end, passing through mid. Collinear
 * (degenerate) input returns the straight `[start, end]`, which is what the
 * geometry actually is.
 */
export function arcPolyline(
  pStart: Point2,
  pMid: Point2,
  pEnd: Point2,
  segmentsPerTurn = ARC_SEGMENTS_PER_TURN
): Point2[] {
  const circle = circumscribedCircle(pStart.x, pStart.y, pMid.x, pMid.y, pEnd.x, pEnd.y)
  if (!circle) return [pStart, pEnd]

  const { cx, cy, r } = circle
  const aStart = Math.atan2(pStart.y - cy, pStart.x - cx)
  const aEnd = Math.atan2(pEnd.y - cy, pEnd.x - cx)
  const anticlockwise = !arcContainsMidCCW(pStart, pMid, pEnd, cx, cy)

  let sweep = anticlockwise ? aStart - aEnd : aEnd - aStart
  if (sweep <= 0) sweep += 2 * Math.PI

  const steps = Math.max(2, Math.ceil((sweep / (2 * Math.PI)) * segmentsPerTurn))
  const points: Point2[] = []
  for (let i = 0; i <= steps; i++) {
    const angle = anticlockwise ? aStart - (sweep * i) / steps : aStart + (sweep * i) / steps
    points.push({ x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) })
  }
  return points
}
