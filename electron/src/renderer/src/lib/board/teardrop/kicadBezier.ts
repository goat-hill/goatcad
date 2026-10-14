// Parts follow KiCad's source, named below: Copyright The KiCad Developers, GPL-3.0-or-later.
/**
 * KiCad's cubic Bézier to polyline (`BEZIER_POLY::GetPoly( std::vector<VECTOR2I>&, int )`,
 * libs/kimath/src/bezier_curves.cpp): parabolic approximation between
 * inflection points (Hain et al.), recursive halving where that fails, the
 * points rounded with KiROUND. Followed step by step, since a teardrop's
 * curved edge has to land on KiCad's vertices.
 */
import { kiRound, type IPt } from './kicadMath'

type V = { x: number; y: number }
type Cubic = [V, V, V, V]

const vsub = (a: V, b: V): V => ({ x: a.x - b.x, y: a.y - b.y })
const vadd = (a: V, b: V): V => ({ x: a.x + b.x, y: a.y + b.y })
const vmul = (s: number, a: V): V => ({ x: s * a.x, y: s * a.y })
const cross = (a: V, b: V): number => a.x * b.y - a.y * b.x
const dot = (a: V, b: V): number => a.x * b.x + a.y * b.y
const sq = (a: V): number => a.x * a.x + a.y * a.y

function isNaNCurve(c: Cubic): boolean {
  return c.some((p) => Number.isNaN(p.x) || Number.isNaN(p.y))
}

function isFlat(c: Cubic, maxError: number): boolean {
  const delta = vsub(c[3], c[0])
  const d21 = vsub(c[1], c[0])
  const d31 = vsub(c[2], c[0])
  const cross1 = cross(delta, d21)
  const cross2 = cross(delta, d31)
  const inv = 1 / sq(delta)
  const d1 = cross1 * cross1 * inv
  const d2 = cross2 * cross2 * inv
  const factor = cross1 * cross2 > 0 ? 3 / 4 : 4 / 9
  const f2 = factor * factor
  const tol = maxError * maxError
  return d1 * f2 <= tol && d2 * f2 <= tol
}

function subdivide(c: Cubic, t: number): [Cubic, Cubic] {
  const leftCtrl1 = vadd(c[0], vmul(t, vsub(c[1], c[0])))
  const tmp = vadd(c[1], vmul(t, vsub(c[2], c[1])))
  const leftCtrl2 = vadd(leftCtrl1, vmul(t, vsub(tmp, leftCtrl1)))
  const rightCtrl2 = vadd(c[2], vmul(t, vsub(c[3], c[2])))
  const rightCtrl1 = vadd(tmp, vmul(t, vsub(rightCtrl2, tmp)))
  const shared = vadd(leftCtrl2, vmul(t, vsub(rightCtrl1, leftCtrl2)))
  return [
    [c[0], leftCtrl1, leftCtrl2, shared],
    [shared, rightCtrl1, rightCtrl2, c[3]]
  ]
}

function numberOfInflectionPoints(c: Cubic): number {
  const d21 = vsub(c[1], c[0])
  const d32 = vsub(c[2], c[1])
  const d43 = vsub(c[3], c[2])
  const cross1 = cross(d21, d32) * cross(d32, d43)
  const cross2 = cross(d21, d32) * cross(d21, d43)
  if (cross1 < 0) return 1
  if (cross2 > 0) return 0
  const b1 = dot(d21, d32) > 0
  const b2 = dot(d32, d43) > 0
  if (b1 !== b2) return 0
  return -1
}

function thirdControlPointDeviation(c: Cubic): number {
  const delta = vsub(c[1], c[0])
  const lenSq = sq(delta)
  if (lenSq < 1e-6) return 0
  const len = Math.sqrt(lenSq)
  const r = (c[1].y - c[0].y) / len
  const s = (c[0].x - c[1].x) / len
  const u = (c[1].x * c[0].y - c[0].x * c[1].y) / len
  return Math.abs(r * c[2].x + s * c[2].y + u)
}

function recursiveSegmentation(curve: Cubic, out: V[], threshold: number): void {
  const stack: Cubic[] = [curve]
  while (stack.length > 0) {
    const top = stack[stack.length - 1]
    if (top[3].x === top[0].x && top[3].y === top[0].y) stack.pop()
    else if (isFlat(top, threshold)) {
      out.push(top[3])
      stack.pop()
    } else {
      const [left, right] = subdivide(top, 0.5)
      stack[stack.length - 1] = right
      stack.push(left)
    }
  }
}

function findInflectionPoints(c: Cubic): { count: number; t1: number; t2: number } {
  const A = {
    x: -c[0].x + 3 * c[1].x - 3 * c[2].x + c[3].x,
    y: -c[0].y + 3 * c[1].y - 3 * c[2].y + c[3].y
  }
  const B = { x: 3 * c[0].x - 6 * c[1].x + 3 * c[2].x, y: 3 * c[0].y - 6 * c[1].y + 3 * c[2].y }
  const C = { x: -3 * c[0].x + 3 * c[1].x, y: -3 * c[0].y + 3 * c[1].y }
  const a = 3 * cross(A, B)
  const b = 3 * cross(A, C)
  const cc = cross(B, C)
  const r2 = b * b - 4 * a * cc
  if (r2 >= 0 && a !== 0) {
    const r = Math.sqrt(r2)
    let t1 = (-b + r) / (2 * a)
    let t2 = (-b - r) / (2 * a)
    const in1 = t1 > 0 && t1 < 1
    const in2 = t2 > 0 && t2 < 1
    if (in1 && in2) {
      if (t1 > t2) [t1, t2] = [t2, t1]
      return { count: t2 - t1 > 0.00001 ? 2 : 1, t1, t2 }
    }
    if (in1) return { count: 1, t1, t2: 0 }
    if (in2) return { count: 1, t1: t2, t2: 0 }
  }
  return { count: 0, t1: 0, t2: 0 }
}

function cubicParabolicApprox(curve: Cubic, out: V[], maxError: number): void {
  let c = curve
  for (;;) {
    if (isNaNCurve(c)) break
    if (isFlat(c, maxError)) {
      out.push(c[3])
      break
    }
    const d = thirdControlPointDeviation(c)
    const t = 2 * Math.sqrt(maxError / (3 * d))
    if (t > 1) {
      recursiveSegmentation(c, out, maxError)
      break
    }
    const [b1, b2] = subdivide(c, t)
    if (isFlat(b1, maxError)) out.push(b1[3])
    else recursiveSegmentation(b1, out, maxError)
    c = b2
  }
}

function cubicPoly(c: Cubic, out: V[], maxError: number): void {
  out.push(c[0])
  if (numberOfInflectionPoints(c) === 0) {
    cubicParabolicApprox(c, out, maxError)
    return
  }
  const first = findInflectionPoints(c)
  if (first.count === 2) {
    const [sub1, tmp1] = subdivide(c, first.t1)
    cubicParabolicApprox(sub1, out, maxError)
    const second = findInflectionPoints(tmp1)
    if (second.count === 0) {
      out.push(tmp1[3])
      return
    }
    const [sub2, sub3] = subdivide(tmp1, second.t1)
    recursiveSegmentation(sub2, out, maxError)
    cubicParabolicApprox(sub3, out, maxError)
  } else if (first.count === 1) {
    const [sub1, sub2] = subdivide(c, first.t1)
    cubicParabolicApprox(sub1, out, maxError)
    cubicParabolicApprox(sub2, out, maxError)
  } else cubicParabolicApprox(c, out, maxError)
}

/** `BEZIER_POLY( start, c1, c2, end ).GetPoly( out, maxError )`. */
export function bezierPoly(start: IPt, c1: IPt, c2: IPt, end: IPt, maxError: number): IPt[] {
  const out: V[] = []
  cubicPoly([start, c1, c2, end], out, maxError <= 0 ? 10 : maxError)
  return out.map((p) => ({ x: kiRound(p.x), y: kiRound(p.y) }))
}
