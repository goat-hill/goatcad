import { beforeAll, describe, expect, it } from 'vitest'
import { loadClipper, type ClipPt, type ClipRegion } from '../clip'
import { drainSteps, subtractInPieces, subtractInPiecesSteps } from '../regionClips'

const square = (cx: number, cy: number, half: number): ClipPt[] => [
  { x: cx - half, y: cy - half },
  { x: cx + half, y: cy - half },
  { x: cx + half, y: cy + half },
  { x: cx - half, y: cy + half }
]

const region = (outer: ClipPt[], holes: ClipPt[][] = []): ClipRegion => ({ outer, holes })

const ringArea = (ring: readonly ClipPt[]): number => {
  let sum = 0
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]
    const b = ring[(i + 1) % ring.length]
    sum += a.x * b.y - b.x * a.y
  }
  return Math.abs(sum / 2)
}

const netArea = (regions: readonly ClipRegion[]): number =>
  regions.reduce(
    (sum, r) => sum + ringArea(r.outer) - r.holes.reduce((h, ring) => h + ringArea(ring), 0),
    0
  )

describe('subtractInPieces', () => {
  beforeAll(async () => {
    await loadClipper()
  })

  it('matches a plain difference under the cut budget', () => {
    const pieces = subtractInPieces(region(square(0, 0, 10)), [region(square(0, 0, 1))])
    expect(netArea(pieces)).toBeCloseTo(400 - 4, 6)
  })

  it('partitions past the budget: same area, small pieces everywhere', () => {
    // A 100-cut grid over a 40×40 plate, with a budget of 8 cuts per piece.
    const cuts: ClipRegion[] = []
    for (let i = 0; i < 100; i++) {
      cuts.push(region(square((i % 10) * 4 + 2, Math.floor(i / 10) * 4 + 2, 0.5)))
    }
    const subject = region([
      { x: 0, y: 0 },
      { x: 40, y: 0 },
      { x: 40, y: 40 },
      { x: 0, y: 40 }
    ])
    const pieces = subtractInPieces(subject, cuts, 8)
    expect(pieces.length).toBeGreaterThan(1)
    for (const piece of pieces) expect(piece.holes.length).toBeLessThanOrEqual(8)
    expect(netArea(pieces)).toBeCloseTo(40 * 40 - 100 * 1, 4)
  })

  it('keeps the subject holes it was handed', () => {
    // A plate with its own cutout, plus cuts that force one split.
    const subject = region(square(0, 0, 10), [square(5, 5, 2)])
    const cuts = [region(square(-5, -5, 1)), region(square(-5, 5, 1)), region(square(0, -5, 1))]
    const pieces = subtractInPieces(subject, cuts, 2)
    expect(netArea(pieces)).toBeCloseTo(400 - 16 - 3 * 4, 4)
  })

  it('cuts that straddle the split line are not double-counted', () => {
    const subject = region(square(0, 0, 10))
    // Three cuts in a horizontal row; the median split lands inside the middle
    // one, so it is handed to both halves.
    const cuts = [region(square(-5, 0, 1)), region(square(0, 0, 1)), region(square(5, 0, 1))]
    const pieces = subtractInPieces(subject, cuts, 1)
    expect(netArea(pieces)).toBeCloseTo(400 - 3 * 4, 4)
  })

  it('returns the subject untouched with no cuts', () => {
    const subject = region(square(0, 0, 3))
    expect(subtractInPieces(subject, [])).toEqual([subject])
  })

  it('steps form yields at least once per split and returns the same result', () => {
    const cuts: ClipRegion[] = []
    for (let i = 0; i < 20; i++) cuts.push(region(square(i * 2 + 1, 1, 0.4)))
    const subject = region([
      { x: 0, y: 0 },
      { x: 42, y: 0 },
      { x: 42, y: 2 },
      { x: 0, y: 2 }
    ])
    const steps = subtractInPiecesSteps(subject, cuts, 4)
    let yields = 0
    let step = steps.next()
    while (!step.done) {
      yields++
      step = steps.next()
    }
    expect(yields).toBeGreaterThan(1)
    expect(netArea(step.value)).toBeCloseTo(
      netArea(drainSteps(subtractInPiecesSteps(subject, cuts, 4))),
      6
    )
  })
})
