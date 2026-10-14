import { describe, expect, test } from 'vitest'
import { arcPath, hitShape, shapeInBox, type HitShape } from '../schematicHitShapes'

const square = (filled: boolean): HitShape => ({
  kind: 'path',
  points: [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 }
  ],
  closed: true,
  halfWidth: 0.1,
  filled
})

describe('hitShape', () => {
  test('an unfilled outline is hit on its stroke, not in its middle', () => {
    expect(hitShape(square(false), { x: 5, y: 0.3 }, 0.25)).toBe('edge')
    // The closing segment counts: x = 0 is the fourth side.
    expect(hitShape(square(false), { x: -0.2, y: 5 }, 0.25)).toBe('edge')
    expect(hitShape(square(false), { x: 5, y: 5 }, 0.25)).toBeNull()
  })

  test('a filled body is hit inside too, ranked apart from its edge', () => {
    expect(hitShape(square(true), { x: 5, y: 5 }, 0.25)).toBe('inside')
    expect(hitShape(square(true), { x: 5, y: 0 }, 0.25)).toBe('edge')
    expect(hitShape(square(true), { x: 15, y: 5 }, 0.25)).toBeNull()
  })

  test('the stroke width widens the reach', () => {
    const thick: HitShape = { ...square(false), halfWidth: 1 } as HitShape
    expect(hitShape(thick, { x: 5, y: 1.2 }, 0.25)).toBe('edge')
    expect(hitShape(square(false), { x: 5, y: 1.2 }, 0.25)).toBeNull()
  })

  test('an open run does not close', () => {
    const run: HitShape = { ...square(false), closed: false } as HitShape
    expect(hitShape(run, { x: -0.1, y: 5 }, 0.25)).toBeNull()
  })

  test('a circle is hit on its ring, and inside only when filled', () => {
    const ring: HitShape = {
      kind: 'circle',
      center: { x: 0, y: 0 },
      radius: 5,
      halfWidth: 0.1,
      filled: false
    }
    expect(hitShape(ring, { x: 5.2, y: 0 }, 0.25)).toBe('edge')
    expect(hitShape(ring, { x: 1, y: 1 }, 0.25)).toBeNull()
    expect(hitShape({ ...ring, filled: true }, { x: 1, y: 1 }, 0.25)).toBe('inside')
  })

  test('a filled arc is a pie slice, its fill polygon through the center', () => {
    const arc = arcPath({ x: 5, y: 0 }, { x: 0, y: 5 }, { x: -5, y: 0 })
    if (!arc) throw new Error('arc')
    const shape: HitShape = {
      kind: 'path',
      points: arc.points,
      closed: false,
      halfWidth: 0.1,
      filled: true,
      fillPolygon: [...arc.points, arc.center]
    }
    expect(hitShape(shape, { x: 0, y: 2 }, 0.1)).toBe('inside')
    expect(hitShape(shape, { x: 0, y: -2 }, 0.1)).toBeNull()
    expect(hitShape(shape, { x: 0, y: 5 }, 0.1)).toBe('edge')
  })

  test('text boxes land as the item, large areas as its inside', () => {
    const box = { minX: 0, minY: 0, maxX: 4, maxY: 1 }
    expect(hitShape({ kind: 'box', box }, { x: 2, y: 0.5 }, 0.2)).toBe('edge')
    expect(hitShape({ kind: 'area', box }, { x: 2, y: 0.5 }, 0.2)).toBe('inside')
    expect(hitShape({ kind: 'box', box }, { x: 5, y: 0.5 }, 0.2)).toBeNull()
  })
})

describe('arcPath', () => {
  test('runs from start through mid to end on the circle', () => {
    const arc = arcPath({ x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 })
    expect(arc?.center.x).toBeCloseTo(0, 9)
    expect(arc?.center.y).toBeCloseTo(0, 9)
    const points = arc?.points ?? []
    expect(points[0]).toEqual({ x: 1, y: 0 })
    expect(points[points.length - 1].x).toBeCloseTo(-1, 9)
    // Through the top, not the bottom.
    expect(Math.max(...points.map((p) => p.y))).toBeCloseTo(1, 2)
    for (const p of points) expect(Math.hypot(p.x, p.y)).toBeCloseTo(1, 9)
  })

  test('is null for collinear points', () => {
    expect(arcPath({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 })).toBeNull()
  })
})

describe('shapeInBox', () => {
  test('a window takes only what it encloses', () => {
    expect(shapeInBox(square(false), { minX: -1, minY: -1, maxX: 11, maxY: 11 }, false)).toBe(true)
    expect(shapeInBox(square(false), { minX: -1, minY: -1, maxX: 9, maxY: 11 }, false)).toBe(false)
  })

  test('a crossing band takes an outline it touches, not the hole in it', () => {
    // Inside the unfilled square, touching no side.
    const hole = { minX: 3, minY: 3, maxX: 7, maxY: 7 }
    expect(shapeInBox(square(false), hole, true)).toBe(false)
    expect(shapeInBox(square(true), hole, true)).toBe(true)
    expect(shapeInBox(square(false), { minX: 8, minY: 3, maxX: 12, maxY: 7 }, true)).toBe(true)
  })

  test('a crossing band inside a ring misses it; across it hits', () => {
    const ring: HitShape = {
      kind: 'circle',
      center: { x: 0, y: 0 },
      radius: 5,
      halfWidth: 0.1,
      filled: false
    }
    expect(shapeInBox(ring, { minX: -1, minY: -1, maxX: 1, maxY: 1 }, true)).toBe(false)
    expect(shapeInBox(ring, { minX: 4, minY: -1, maxX: 6, maxY: 1 }, true)).toBe(true)
    expect(shapeInBox(ring, { minX: 7, minY: 7, maxX: 8, maxY: 8 }, true)).toBe(false)
  })
})
