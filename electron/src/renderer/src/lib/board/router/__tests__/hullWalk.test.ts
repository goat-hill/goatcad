import { describe, expect, test } from 'vitest'
import { walkPathAroundHull, pointInRing, onRing, pathLength } from '../hullWalk'
import { octagonHull, segmentHull, rrectHull } from '../hulls'
import type { Pt } from '../../spatialIndex'

// A clockwise (y-up) unit test square, |x|,|y| ≤ 1.
const square = (r = 1): Pt[] => [
  { x: -r, y: r },
  { x: r, y: r },
  { x: r, y: -r },
  { x: -r, y: -r }
]

const startsAt = (path: Pt[], p: Pt): void => {
  expect(path[0].x).toBeCloseTo(p.x, 9)
  expect(path[0].y).toBeCloseTo(p.y, 9)
}
const endsAt = (path: Pt[], p: Pt): void => {
  expect(path[path.length - 1].x).toBeCloseTo(p.x, 9)
  expect(path[path.length - 1].y).toBeCloseTo(p.y, 9)
}
const avoidsInterior = (path: Pt[], hull: Pt[]): void => {
  // Sample each segment; no sample may be strictly inside the hull.
  for (let i = 0; i < path.length - 1; i++) {
    for (let t = 0; t <= 1; t += 0.05) {
      const p = {
        x: path[i].x + (path[i + 1].x - path[i].x) * t,
        y: path[i].y + (path[i + 1].y - path[i].y) * t
      }
      if (onRing(p, hull)) continue
      expect(pointInRing(p, hull)).toBe(false)
    }
  }
}

describe('hull construction', () => {
  test('octagon edges sit at distance d', () => {
    const hull = octagonHull(0, 0, 2)
    expect(hull).toHaveLength(8)
    // Flat edge midpoints at exactly d; vertices slightly beyond.
    expect(onRing({ x: 0, y: 2 }, hull)).toBe(true)
    expect(pointInRing({ x: 0, y: 1.99 }, hull)).toBe(true)
    expect(pointInRing({ x: 0, y: 2.01 }, hull)).toBe(false)
  })

  test('segment hull contains the swept capsule', () => {
    const hull = segmentHull({ x: 0, y: 0 }, { x: 10, y: 0 }, 1)
    expect(hull).toHaveLength(8)
    expect(pointInRing({ x: 5, y: 0.9 }, hull)).toBe(true)
    expect(pointInRing({ x: 5, y: 1.1 }, hull)).toBe(false)
    expect(pointInRing({ x: -0.9, y: 0 }, hull)).toBe(true)
    expect(pointInRing({ x: 10.9, y: 0 }, hull)).toBe(true)
  })

  test('rrect hull respects rotation', () => {
    // 2×1 rect rotated 90° stands up: reach along y is halfW + d.
    const hull = rrectHull(0, 0, 1, 0.5, 0, Math.PI / 2, 0.5)
    expect(pointInRing({ x: 0, y: 1.4 }, hull)).toBe(true)
    expect(pointInRing({ x: 0, y: 1.6 }, hull)).toBe(false)
    expect(pointInRing({ x: 1.1, y: 0 }, hull)).toBe(false)
  })
})

describe('walkPathAroundHull', () => {
  test('a path crossing the hull bends around it, both directions', () => {
    const path: Pt[] = [
      { x: -3, y: 0 },
      { x: 3, y: 0 }
    ]
    const cwPath = walkPathAroundHull(path, square(), true)!
    const ccwPath = walkPathAroundHull(path, square(), false)!
    expect(cwPath).not.toBeNull()
    expect(ccwPath).not.toBeNull()
    startsAt(cwPath, path[0])
    endsAt(cwPath, path[1])
    startsAt(ccwPath, path[0])
    endsAt(ccwPath, path[1])
    avoidsInterior(cwPath, square())
    avoidsInterior(ccwPath, square())
    // One goes over the top, the other under — opposite sides.
    const cwMaxY = Math.max(...cwPath.map((p) => p.y))
    const ccwMinY = Math.min(...ccwPath.map((p) => p.y))
    const sides = [cwMaxY >= 1 - 1e-9, ccwMinY <= -1 + 1e-9]
    expect(sides.filter(Boolean)).toHaveLength(2)
    // Both are longer than the straight shot but sane.
    expect(pathLength(cwPath)).toBeGreaterThan(6)
    expect(pathLength(cwPath)).toBeLessThan(12)
  })

  test('a path that misses the hull is returned unchanged', () => {
    const path: Pt[] = [
      { x: -3, y: 5 },
      { x: 3, y: 5 }
    ]
    const out = walkPathAroundHull(path, square(), true)!
    expect(out).toHaveLength(2)
    startsAt(out, path[0])
    endsAt(out, path[1])
  })

  test('a start inside the hull is a hard failure', () => {
    const path: Pt[] = [
      { x: 0, y: 0 },
      { x: 5, y: 0 }
    ]
    expect(walkPathAroundHull(path, square(), true)).toBeNull()
    expect(walkPathAroundHull(path, square(), false)).toBeNull()
  })

  test('an endpoint inside the hull lands on the boundary near it', () => {
    const path: Pt[] = [
      { x: -3, y: 0.25 },
      { x: 0, y: 0.25 }
    ]
    const out = walkPathAroundHull(path, square(), true)!
    expect(out).not.toBeNull()
    startsAt(out, path[0])
    const end = out[out.length - 1]
    expect(onRing(end, square())).toBe(true)
    avoidsInterior(out, square())
  })

  test('a multi-segment elbow path bends only where it crosses', () => {
    // 45° elbow passing through the obstacle's corner region.
    const path: Pt[] = [
      { x: -3, y: -3 },
      { x: 0, y: 0 },
      { x: 0, y: 4 }
    ]
    const out = walkPathAroundHull(path, square(), true)!
    expect(out).not.toBeNull()
    startsAt(out, path[0])
    endsAt(out, path[2])
    avoidsInterior(out, square())
  })

  test('octagonal hulls (the real shape) walk clean', () => {
    const hull = segmentHull({ x: 0, y: 0 }, { x: 6, y: 0 }, 0.8)
    const path: Pt[] = [
      { x: -3, y: 0 },
      { x: 9, y: 0 }
    ]
    const out = walkPathAroundHull(path, hull, false)!
    expect(out).not.toBeNull()
    startsAt(out, path[0])
    endsAt(out, path[1])
    avoidsInterior(out, hull)
  })
})
