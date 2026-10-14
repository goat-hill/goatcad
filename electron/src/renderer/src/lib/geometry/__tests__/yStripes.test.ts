import { describe, expect, it } from 'vitest'
import { YStripes, type StripePt } from '../yStripes'
import { pointInPolygon } from '../regionClips'

/** Deterministic LCG so failures reproduce. */
const rng = (seed: number): (() => number) => {
  let s = seed
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0xffffffff
  }
}

const star = (n: number, rOuter: number, rInner: number): StripePt[] => {
  const pts: StripePt[] = []
  for (let i = 0; i < n * 2; i++) {
    const r = i % 2 === 0 ? rOuter : rInner
    const a = (Math.PI * i) / n
    pts.push({ x: r * Math.cos(a), y: r * Math.sin(a) })
  }
  return pts
}

const jaggedRing = (n: number, rand: () => number): StripePt[] => {
  // A non-convex, non-self-intersecting ring: a circle with noisy radius.
  const pts: StripePt[] = []
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n
    const r = 5 + 4 * rand()
    pts.push({ x: r * Math.cos(a), y: r * Math.sin(a) })
  }
  return pts
}

describe('YStripes.contains', () => {
  it('matches pointInPolygon on a star polygon', () => {
    const ring = star(7, 10, 3)
    const stripes = new YStripes(ring)
    const rand = rng(42)
    for (let i = 0; i < 2000; i++) {
      const p = { x: (rand() - 0.5) * 24, y: (rand() - 0.5) * 24 }
      expect(stripes.contains(p)).toBe(pointInPolygon(p, ring))
    }
  })

  it('matches pointInPolygon on jagged rings of many sizes', () => {
    const rand = rng(7)
    for (const n of [3, 4, 17, 250, 5000]) {
      const ring = jaggedRing(n, rand)
      const stripes = new YStripes(ring)
      for (let i = 0; i < 500; i++) {
        const p = { x: (rand() - 0.5) * 20, y: (rand() - 0.5) * 20 }
        expect(stripes.contains(p)).toBe(pointInPolygon(p, ring))
      }
    }
  })

  it('handles a ring degenerate in y (flat)', () => {
    const ring: StripePt[] = [
      { x: 0, y: 1 },
      { x: 4, y: 1 },
      { x: 8, y: 1 }
    ]
    const stripes = new YStripes(ring)
    expect(stripes.contains({ x: 2, y: 1 })).toBe(pointInPolygon({ x: 2, y: 1 }, ring))
    expect(stripes.contains({ x: 2, y: 2 })).toBe(false)
  })
})

describe('YStripes.someEdgeInYRange', () => {
  it('visits every edge overlapping the range exactly once', () => {
    const ring = star(9, 10, 4)
    const stripes = new YStripes(ring)
    const seen = new Map<string, number>()
    stripes.someEdgeInYRange(-2, 3, (a) => {
      const key = `${a.x},${a.y}`
      seen.set(key, (seen.get(key) ?? 0) + 1)
      return false
    })
    for (const [, count] of seen) expect(count).toBe(1)
    // Exhaustive: every edge whose true y-range overlaps must be present.
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]
      const b = ring[(i + 1) % ring.length]
      if (Math.max(a.y, b.y) < -2 || Math.min(a.y, b.y) > 3) continue
      expect(seen.has(`${a.x},${a.y}`)).toBe(true)
    }
  })

  it('stops early when the callback returns true', () => {
    const ring = star(9, 10, 4)
    const stripes = new YStripes(ring)
    let calls = 0
    const hit = stripes.someEdgeInYRange(-10, 10, () => {
      calls++
      return true
    })
    expect(hit).toBe(true)
    expect(calls).toBe(1)
  })

  it('resets visit stamps across scans', () => {
    const ring = star(5, 10, 4)
    const stripes = new YStripes(ring)
    const countEdges = (): number => {
      let c = 0
      stripes.someEdgeInYRange(-10, 10, () => {
        c++
        return false
      })
      return c
    }
    const first = countEdges()
    expect(countEdges()).toBe(first)
    expect(first).toBe(ring.length)
  })
})
