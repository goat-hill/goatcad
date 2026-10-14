import { beforeAll, describe, expect, it } from 'vitest'
import {
  clipperLoaded,
  difference,
  intersection,
  loadClipper,
  merged,
  offset,
  union,
  type ClipPt,
  type ClipRegion
} from '../clip'

const square = (a: number, b: number): ClipPt[] => [
  { x: a, y: a },
  { x: b, y: a },
  { x: b, y: b },
  { x: a, y: b }
]

const region = (outer: ClipPt[], holes: ClipPt[][] = []): ClipRegion => ({ outer, holes })

const ringArea = (ring: readonly ClipPt[]): number => {
  let sum = 0
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]
    const b = ring[(i + 1) % ring.length]
    sum += a.x * b.y - b.x * a.y
  }
  return sum / 2
}

/** Net area of a region set — outers minus the holes cut out of them. */
const area = (regions: readonly ClipRegion[]): number =>
  regions.reduce(
    (sum, r) =>
      sum +
      Math.abs(ringArea(r.outer)) -
      r.holes.reduce((h, ring) => h + Math.abs(ringArea(ring)), 0),
    0
  )

beforeAll(async () => {
  await loadClipper()
})

describe('clip facade', () => {
  it('reports the engine loaded', () => {
    expect(clipperLoaded()).toBe(true)
  })

  it('cuts an interior hole: square minus centered square', () => {
    const out = difference([region(square(0, 10))], [region(square(4, 6))])
    expect(out).toHaveLength(1)
    expect(out[0].holes).toHaveLength(1)
    expect(area(out)).toBeCloseTo(100 - 4, 6)
  })

  it('trims an overlapping edge without creating a hole', () => {
    const out = difference([region(square(0, 10))], [region(square(8, 12))])
    expect(out).toHaveLength(1)
    expect(out[0].holes).toHaveLength(0)
    expect(area(out)).toBeCloseTo(100 - 4, 6)
  })

  it('returns nothing when the clip swallows the subject', () => {
    expect(difference([region(square(4, 6))], [region(square(0, 10))])).toEqual([])
  })

  it('splits a subject the clip cuts in two', () => {
    const bar: ClipPt[] = [
      { x: 4, y: -1 },
      { x: 6, y: -1 },
      { x: 6, y: 11 },
      { x: 4, y: 11 }
    ]
    const out = difference([region(square(0, 10))], [region(bar)])
    expect(out).toHaveLength(2)
    expect(area(out)).toBeCloseTo(100 - 20, 6)
  })

  it('is winding-agnostic on both subject and clip rings', () => {
    const cw = [...square(0, 10)].reverse()
    const out = difference([region(cw)], [region([...square(4, 6)].reverse())])
    expect(area(out)).toBeCloseTo(96, 6)
  })

  it('respects subject holes: an annulus keeps its bore through a clip', () => {
    const out = difference([region(square(0, 10), [square(4, 6)])], [region(square(-2, 2))])
    expect(area(out)).toBeCloseTo(100 - 4 - 4, 6)
  })

  it('collects islands nested inside holes as regions of their own', () => {
    // A plate with a hole, and a separate island inside that hole.
    const out = intersection(
      [region(square(0, 10), [square(2, 8)]), region(square(4, 6))],
      [region(square(-1, 11))]
    )
    expect(out).toHaveLength(2)
    expect(area(out)).toBeCloseTo(100 - 36 + 4, 6)
  })

  it('intersection keeps only what lies inside the clip', () => {
    const out = intersection([region(square(0, 10))], [region(square(5, 15))])
    expect(out).toHaveLength(1)
    expect(area(out)).toBeCloseTo(25, 6)
  })

  it('survives a KiCad-style self-touching slit contour', () => {
    // An outer square whose ring dives through a zero-width slit to trace an
    // inner cutout — the shape KiCad stores zone fills as.
    const slit: ClipPt[] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 5.5, y: 10 },
      { x: 5.5, y: 6 },
      { x: 4.5, y: 6 },
      { x: 4.5, y: 10 },
      { x: 5.5, y: 10 },
      { x: 5.5, y: 10 },
      { x: 0, y: 10 }
    ]
    const out = difference([region(slit)], [region(square(4.8, 5.2))])
    expect(out.length).toBeGreaterThan(0)
    expect(area(out)).toBeLessThan(100)
  })

  it('handles a pour minus hundreds of discs at interactive build cost', () => {
    const disc = (cx: number, cy: number, r: number, n = 16): ClipPt[] => {
      const ring: ClipPt[] = []
      for (let i = 0; i < n; i++) {
        const angle = (i / n) * Math.PI * 2
        ring.push({ x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) })
      }
      return ring
    }
    const clips: ClipRegion[] = []
    for (let i = 0; i < 400; i++) {
      clips.push(region(disc((i % 20) * 5 + 2.5, Math.floor(i / 20) * 5 + 2.5, 0.4)))
    }
    const out = difference([region(square(0, 100))], clips)
    expect(out).toHaveLength(1)
    expect(out[0].holes).toHaveLength(400)
    expect(area(out)).toBeCloseTo(100 * 100 - 400 * Math.abs(ringArea(disc(0, 0, 0.4))), 3)
  })
})

describe('large sets', () => {
  // A chain of 400 overlapping unit squares, shuffled, and some disjoint ones:
  // merged in batches, the answer is the one a single pass gives.
  const chain = Array.from({ length: 400 }, (_, i) => {
    const x = (i * 37) % 400 // a deterministic shuffle of 0..399
    return region([
      { x: x * 0.5, y: 0 },
      { x: x * 0.5 + 1, y: 0 },
      { x: x * 0.5 + 1, y: 1 },
      { x: x * 0.5, y: 1 }
    ])
  })
  const apart = Array.from({ length: 100 }, (_, i) => region(square(1000 + 3 * i, 1001 + 3 * i)))

  it('merges into the same regions a single pass would', () => {
    const out = merged([...chain, ...apart])
    expect(out).toHaveLength(101)
    expect(area(out)).toBeCloseTo(0.5 * 399 + 1 + 100, 6)
  })

  it('difference and union batch their large inputs to the same answer', () => {
    const cut = difference([region(square(-1, 300))], chain)
    expect(area(cut)).toBeCloseTo(301 * 301 - (0.5 * 399 + 1), 6)
    expect(area(union(chain, apart))).toBeCloseTo(0.5 * 399 + 1 + 100, 6)
  })
})

describe('offset', () => {
  it('grows a square by a rounded border and shrinks it back square', () => {
    // A 10 mm square grown by 1 mm with round corners: 12 × 12 less the four
    // corners' squares, plus four quarter discs of radius 1.
    const grown = offset([region(square(0, 10))], 1, { join: 'round', arcTolerance: 0.0005 })
    expect(area(grown)).toBeCloseTo(144 - 4 + Math.PI, 2)
    // Shrinking the rounded square by 1 gives the original back.
    expect(area(offset(grown, -1, { join: 'round', arcTolerance: 0.0005 }))).toBeCloseTo(100, 2)
  })

  it('carries holes: a hole shrinks as its region grows', () => {
    const frame = region(square(0, 10), [square(3, 7)])
    const grown = offset([frame], 0.5, { join: 'miter' })
    expect(grown).toHaveLength(1)
    expect(grown[0].holes).toHaveLength(1)
    // Outer 11 × 11 less the hole shrunk to 3 × 3.
    expect(area(grown)).toBeCloseTo(121 - 9, 6)
  })

  it('removes what is thinner than twice a shrink', () => {
    // A 0.2 mm wide strip vanishes shrunk by 0.15 mm.
    const strip = region([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 0.2 },
      { x: 0, y: 0.2 }
    ])
    expect(offset([strip], -0.15)).toEqual([])
  })
})
