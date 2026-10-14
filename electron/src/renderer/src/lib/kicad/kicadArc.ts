// Parts follow KiCad's source, named below: Copyright The KiCad Developers, GPL-3.0-or-later.
/**
 * KiCad's own arc arithmetic, ported where a migration has to land on the
 * integer KiCad would (`libs/kimath/src/trigo.cpp`, `common/eda_shape.cpp`,
 * `EDA_ANGLE`). Rendering has its own, simpler math (`engine/arcGeometry.ts`);
 * this exists only to reproduce KiCad's rounding, so it follows KiCad's steps
 * and special cases rather than the shortest formula.
 */

export interface IuPoint {
  x: number
  y: number
}

/** `KiROUND`: to the nearest integer, halves away from zero. */
export const kiRound = (v: number): number => (v < 0 ? Math.trunc(v - 0.5) : Math.trunc(v + 0.5))

/** Degrees, normalized to [0, 360) (`EDA_ANGLE::Normalize`). */
const normalize = (degrees: number): number => {
  let value = degrees
  while (value < 0) value += 360
  while (value >= 360) value -= 360
  return value
}

/** `EDA_ANGLE( VECTOR2D )`, in degrees, with its exact cardinal and diagonal cases. */
export function angleOf(x: number, y: number): number {
  if (x === 0 && y === 0) return 0
  if (y === 0) return x >= 0 ? 0 : -180
  if (x === 0) return y >= 0 ? 90 : -90
  if (x === y) return x >= 0 ? 45 : -180 + 45
  if (x === -y) return x >= 0 ? -45 : 180 - 45
  return Math.atan2(y, x) / (Math.PI / 180)
}

const sinOf = (degrees: number): number => {
  const d = normalize(degrees)
  if (d === 0 || d === 180) return 0
  if (d === 45 || d === 135) return Math.SQRT1_2
  if (d === 225 || d === 315) return -Math.SQRT1_2
  if (d === 90) return 1
  if (d === 270) return -1
  return Math.sin(d * (Math.PI / 180))
}

const cosOf = (degrees: number): number => {
  const d = normalize(degrees)
  if (d === 0) return 1
  if (d === 180) return -1
  if (d === 90 || d === 270) return 0
  if (d === 45 || d === 315) return Math.SQRT1_2
  if (d === 135 || d === 225) return -Math.SQRT1_2
  return Math.cos(d * (Math.PI / 180))
}

/** `RotatePoint` about the origin; `round` for the integer overload. */
function rotate(x: number, y: number, degrees: number, round: boolean): IuPoint {
  const d = normalize(degrees)
  if (d === 0) return { x, y }
  if (d === 90) return { x: y, y: -x }
  if (d === 180) return { x: -x, y: -y }
  if (d === 270) return { x: -y, y: x }
  const s = sinOf(d)
  const c = cosOf(d)
  const px = y * s + x * c
  const py = y * c - x * s
  return round ? { x: kiRound(px), y: kiRound(py) } : { x: px, y: py }
}

/** Integer `RotatePoint( point, center, angle )`. */
export function rotateAbout(point: IuPoint, center: IuPoint, degrees: number): IuPoint {
  const r = rotate(point.x - center.x, point.y - center.y, degrees, true)
  return { x: r.x + center.x, y: r.y + center.y }
}

/** `VECTOR2D::Resize`. */
function resize(x: number, y: number, length: number): IuPoint {
  if (x === 0 && y === 0) return { x: 0, y: 0 }
  let nx: number
  let ny: number
  if (Math.abs(x) === Math.abs(y)) {
    nx = ny = Math.abs(length) * Math.SQRT1_2
  } else {
    // `rescale( newLength_sq, x_sq, l_sq )`, in that order.
    const xSq = x * x
    const ySq = y * y
    const lengthSq = length * length
    nx = Math.sqrt((lengthSq * xSq) / (xSq + ySq))
    ny = Math.sqrt((lengthSq * ySq) / (xSq + ySq))
  }
  return { x: x < 0 ? -nx : nx, y: y < 0 ? -ny : ny }
}

/** The center of the arc from `start` to `end` sweeping `degrees` (`CalcArcCenter`, the angle form), unrounded. */
export function arcCenterFromAngle(start: IuPoint, end: IuPoint, degrees: number): IuPoint {
  let angle = degrees
  let s = start
  let e = end
  if (angle < 0) {
    ;[s, e] = [e, s]
    angle = -angle
  }
  if (angle > 180) {
    ;[s, e] = [e, s]
    angle = 360 - angle
  }
  const chord = Math.hypot(s.x - e.x, s.y - e.y)
  const sinHalf = sinOf(angle / 2)
  if (sinHalf === 0) return { x: (s.x + e.x) / 2, y: (s.y + e.y) / 2 }
  const r = chord / 2 / sinHalf
  const dSquared = r * r - (chord * chord) / 4
  const d = dSquared > 0 ? Math.sqrt(dSquared) : 0
  const toEnd = resize(e.x - s.x, e.y - s.y, d)
  const half = resize(e.x - s.x, e.y - s.y, chord / 2)
  const perpendicular = rotate(toEnd.x, toEnd.y, -90, false)
  return { x: s.x + half.x + perpendicular.x, y: s.y + half.y + perpendicular.y }
}

/**
 * The center through three points (`CalcArcCenter`, the three-point form):
 * slopes with their rounding uncertainty propagated, snapped to a round
 * 100 or 10 units where that is within it. Unrounded.
 */
export function arcCenterFromPoints(a: IuPoint, m: IuPoint, b: IuPoint): IuPoint {
  const minX = Math.min(a.x, m.x, b.x)
  const maxX = Math.max(a.x, m.x, b.x)
  const minY = Math.min(a.y, m.y, b.y)
  const maxY = Math.max(a.y, m.y, b.y)
  if (maxX - minX < 5 && maxY - minY < 5)
    return { x: (a.x + m.x + b.x) / 3, y: (a.y + m.y + b.y) / 3 }

  let yDelta21 = m.y - a.y
  let xDelta21 = m.x - a.x
  let yDelta32 = b.y - m.y
  let xDelta32 = b.x - m.x
  if ((xDelta21 === 0 && yDelta32 === 0) || (yDelta21 === 0 && xDelta32 === 0)) {
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
  }
  if (xDelta21 === 0) xDelta21 = Number.EPSILON
  if (xDelta32 === 0) xDelta32 = -Number.EPSILON
  let aSlope = yDelta21 / xDelta21
  let bSlope = yDelta32 / xDelta32
  if (yDelta21 === 0) yDelta21 = Number.EPSILON
  if (yDelta32 === 0) yDelta32 = Number.EPSILON
  const daSlope = aSlope * Math.hypot(0.5 / yDelta21, 0.5 / xDelta21)
  const dbSlope = bSlope * Math.hypot(0.5 / yDelta32, 0.5 / xDelta32)
  if (aSlope === bSlope) {
    if (a.x === b.x && a.y === b.y) return { x: (a.x + m.x) / 2, y: (a.y + m.y) / 2 }
    aSlope += Number.EPSILON
    bSlope -= Number.EPSILON
  }
  if (aSlope === 0) aSlope = 1e-10
  if (bSlope === 0) bSlope = 1e-10

  const sq = (v: number): number => v * v
  const abSlopeStartEndY = aSlope * bSlope * (a.y - b.y)
  const dabSlopeStartEndY =
    abSlopeStartEndY *
    Math.sqrt(sq(daSlope / aSlope) + sq(dbSlope / bSlope) + sq(Math.SQRT1_2 / (a.y - b.y)))
  const bSlopeStartMidX = bSlope * (a.x + m.x)
  const dbSlopeStartMidX =
    bSlopeStartMidX * Math.sqrt(sq(dbSlope / bSlope) + sq(Math.SQRT1_2 / (a.x + m.x)))
  const aSlopeMidEndX = aSlope * (m.x + b.x)
  const daSlopeMidEndX =
    aSlopeMidEndX * Math.sqrt(sq(daSlope / aSlope) + sq(Math.SQRT1_2 / (m.x + b.x)))
  const twiceBASlopeDiff = 2 * (bSlope - aSlope)
  const dtwiceBASlopeDiff = 2 * Math.sqrt(dbSlope * dbSlope + daSlope * daSlope)
  const centerNumeratorX = abSlopeStartEndY + bSlopeStartMidX - aSlopeMidEndX
  const dCenterNumeratorX = Math.sqrt(
    sq(dabSlopeStartEndY) + sq(dbSlopeStartMidX) + sq(daSlopeMidEndX)
  )
  const centerX = (abSlopeStartEndY + bSlopeStartMidX - aSlopeMidEndX) / twiceBASlopeDiff
  const dCenterX =
    centerX *
    Math.sqrt(sq(dCenterNumeratorX / centerNumeratorX) + sq(dtwiceBASlopeDiff / twiceBASlopeDiff))
  const centerNumeratorY = (a.x + m.x) / 2 - centerX
  const dCenterNumeratorY = Math.sqrt(1 / 8 + dCenterX * dCenterX)
  const centerFirstTerm = centerNumeratorY / aSlope
  const dcenterFirstTermY =
    centerFirstTerm * Math.sqrt(sq(dCenterNumeratorY / centerNumeratorY) + sq(daSlope / aSlope))
  const centerY = centerFirstTerm + (a.y + m.y) / 2
  const dCenterY = Math.sqrt(dcenterFirstTermY * dcenterFirstTermY + 1 / 8)

  const round100X = Math.floor((centerX + 50) / 100) * 100
  const round100Y = Math.floor((centerY + 50) / 100) * 100
  const round10X = Math.floor((centerX + 5) / 10) * 10
  const round10Y = Math.floor((centerY + 5) / 10) * 10
  if (Math.abs(round100X - centerX) < dCenterX && Math.abs(round100Y - centerY) < dCenterY) {
    return { x: round100X, y: round100Y }
  }
  if (Math.abs(round10X - centerX) < dCenterX && Math.abs(round10Y - centerY) < dCenterY) {
    return { x: round10X, y: round10Y }
  }
  return { x: centerX, y: centerY }
}

/** `VECTOR2I( const VECTOR2D& )` via `CalcArcCenter`'s integer form: rounded. */
export const roundPoint = (p: IuPoint): IuPoint => ({ x: kiRound(p.x), y: kiRound(p.y) })

/** A `VECTOR2D` assigned to a `VECTOR2I`: truncated toward zero. */
export const truncPoint = (p: IuPoint): IuPoint => ({ x: Math.trunc(p.x), y: Math.trunc(p.y) })

/** `EDA_SHAPE::CalcArcAngles` → the sweep from start to end about `center`, in degrees. */
export function arcSweep(start: IuPoint, end: IuPoint, center: IuPoint): number {
  const startAngle = angleOf(start.x - center.x, start.y - center.y)
  let endAngle = angleOf(end.x - center.x, end.y - center.y)
  if (endAngle === startAngle) endAngle = startAngle + 360
  while (endAngle < startAngle) endAngle += 360
  return endAngle - startAngle
}

/** `EDA_SHAPE::GetArcMid`, computed. */
export const arcMid = (start: IuPoint, end: IuPoint, center: IuPoint): IuPoint =>
  rotateAbout(start, center, -arcSweep(start, end, center) / 2)
