import { describe, expect, test } from 'vitest'
import {
  capsuleEntersRegion,
  pointInRegion,
  regionBoundaryDistance,
  regionsOverlap,
  ringsOverlap,
  segmentDistance,
  segmentsCrossProperly,
  segmentsMeet,
  type Region
} from '../polygon'

const square = (cx: number, cy: number, half: number): Array<{ x: number; y: number }> => [
  { x: cx - half, y: cy - half },
  { x: cx + half, y: cy - half },
  { x: cx + half, y: cy + half },
  { x: cx - half, y: cy + half }
]

/** A 6 × 6 square about the origin with a 2 × 2 cutout at its center. */
const frame: Region = { outer: square(0, 0, 3), holes: [square(0, 0, 1)] }

describe('regions', () => {
  test('a point is in the region inside the outer ring and outside its holes', () => {
    expect(pointInRegion({ x: 2, y: 2 }, frame)).toBe(true)
    expect(pointInRegion({ x: 0, y: 0 }, frame)).toBe(false)
    expect(pointInRegion({ x: 4, y: 0 }, frame)).toBe(false)
    expect(regionBoundaryDistance({ x: 2, y: 0 }, frame)).toBe(1)
  })
})

describe('overlap', () => {
  test('overlapping squares report a point of the overlap', () => {
    const hit = ringsOverlap(square(0, 0, 1), square(1, 0, 1), 0.01)
    expect(hit).not.toBeNull()
    expect(hit!.x).toBeGreaterThanOrEqual(0)
    expect(hit!.x).toBeLessThanOrEqual(1)
  })

  test('two regions that coincide overlap, though no boundary lies inside the other', () => {
    expect(ringsOverlap(square(0, 0, 1), square(0, 0, 1), 0.01)).toEqual({ x: 0, y: 0 })
  })

  test('touching squares and a hair of overlap do not count', () => {
    expect(ringsOverlap(square(0, 0, 1), square(2, 0, 1), 0.01)).toBeNull()
    expect(ringsOverlap(square(0, 0, 1), square(1.995, 0, 1), 0.01)).toBeNull()
    expect(ringsOverlap(square(0, 0, 1), square(1.98, 0, 1), 0.01)).not.toBeNull()
  })

  test('stacked squares of one width overlap along a whole side', () => {
    // No vertex of either lies strictly inside the other, and the vertical
    // sides are collinear: the overlap is only visible along the boundary.
    expect(ringsOverlap(square(0, 0, 1), square(0, 1.5, 1), 0.01)).not.toBeNull()
  })

  test('one ring inside another overlaps; one inside a cutout does not', () => {
    expect(ringsOverlap(square(0, 0, 3), square(0, 0, 0.5), 0.01)).not.toBeNull()
    expect(regionsOverlap(frame, { outer: square(0, 0, 0.5), holes: [] }, 0.01)).toBeNull()
    expect(regionsOverlap(frame, { outer: square(0, 0, 1.5), holes: [] }, 0.01)).not.toBeNull()
  })
})

describe('capsules', () => {
  test('a capsule enters a region by its axis, its crossing, or its body', () => {
    const outer: Region = { outer: square(0, 0, 3), holes: [] }
    expect(capsuleEntersRegion({ x: 0, y: 0 }, { x: 0, y: 0 }, 0.2, outer, 0.005)).toBe(true)
    expect(capsuleEntersRegion({ x: -5, y: 0 }, { x: 5, y: 0 }, 0.2, outer, 0.005)).toBe(true)
    expect(capsuleEntersRegion({ x: -3.1, y: -1 }, { x: -3.1, y: 1 }, 0.2, outer, 0.005)).toBe(true)
    expect(capsuleEntersRegion({ x: -3.3, y: -1 }, { x: -3.3, y: 1 }, 0.2, outer, 0.005)).toBe(
      false
    )
    // Lying along the boundary, within the tolerance, is not entering.
    expect(capsuleEntersRegion({ x: -3.198, y: -1 }, { x: -3.198, y: 1 }, 0.2, outer, 0.005)).toBe(
      false
    )
  })

  test('a capsule inside a cutout is outside the region until its body reaches the ring', () => {
    expect(capsuleEntersRegion({ x: 0, y: 0 }, { x: 0, y: 0 }, 0.5, frame, 0.005)).toBe(false)
    expect(capsuleEntersRegion({ x: 0, y: 0 }, { x: 0, y: 0 }, 1.1, frame, 0.005)).toBe(true)
  })
})

describe('segments', () => {
  test('proper crossings, touching ends, and distances', () => {
    const a = { x: 0, y: 0 }
    const b = { x: 2, y: 0 }
    expect(segmentsCrossProperly(a, b, { x: 1, y: -1 }, { x: 1, y: 1 })).toBe(true)
    expect(segmentsCrossProperly(a, b, { x: 2, y: -1 }, { x: 2, y: 1 })).toBe(false)
    expect(segmentDistance(a, b, { x: 1, y: -1 }, { x: 1, y: 1 })).toBe(0)
    expect(segmentDistance(a, b, { x: 0, y: 1 }, { x: 2, y: 1 })).toBe(1)
    expect(segmentDistance(a, b, { x: 3, y: 0 }, { x: 4, y: 0 })).toBe(1)
  })

  test('segments meet when they cross, touch at an end, or overlap along a line', () => {
    const a = { x: 0, y: 0 }
    const b = { x: 2_000_000, y: 0 }
    expect(segmentsMeet(a, b, { x: 1_000_000, y: -1 }, { x: 1_000_000, y: 1 })).toEqual({
      x: 1_000_000,
      y: 0
    })
    expect(segmentsMeet(a, b, b, { x: 3_000_000, y: 5 })).toEqual(b)
    // An end on the other's middle, a T.
    expect(segmentsMeet(a, b, { x: 1_000_000, y: 0 }, { x: 1_000_000, y: 7 })).toEqual({
      x: 1_000_000,
      y: 0
    })
    expect(segmentsMeet(a, b, { x: 1_000_000, y: 0 }, { x: 3_000_000, y: 0 })).toEqual({
      x: 1_500_000,
      y: 0
    })
    expect(segmentsMeet(a, b, { x: 2_000_001, y: 0 }, { x: 3_000_000, y: 0 })).toBeNull()
    expect(segmentsMeet(a, b, { x: 0, y: 1 }, { x: 2_000_000, y: 1 })).toBeNull()
    // A nanometer off at board scale, where a float cross product loses it.
    const slope = { x: 300_000_000, y: 200_000_000 }
    const above = { x: 150_000_000, y: 100_000_001 }
    expect(segmentsMeet(a, slope, above, { x: 150_000_000, y: 300_000_000 })).toBeNull()
  })
})
