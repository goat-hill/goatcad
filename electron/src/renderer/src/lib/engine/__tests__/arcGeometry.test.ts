import { describe, expect, test } from 'vitest'
import { arcBounds, arcCentralSweep, arcPolyline, distanceToArc } from '../arcGeometry'

// A unit semicircle from (1,0) up over (0,1) to (-1,0) — the case that shows
// the difference between the arc and its chords most clearly.
const START = { x: 1, y: 0 }
const MID = { x: 0, y: 1 }
const END = { x: -1, y: 0 }

describe('distanceToArc', () => {
  test('measures to the curve, not to the chords between its three points', () => {
    // 45° along the arc, exactly on it. The start→mid chord passes well inside
    // here, which is what made an arc almost unclickable: the engine's
    // tolerance is 10 screen pixels and the chord error is a fraction of the
    // radius.
    const onCurve = { x: Math.SQRT1_2, y: Math.SQRT1_2 }
    expect(distanceToArc(onCurve, START, MID, END)).toBeCloseTo(0, 12)

    // The same point measured to the chords is off by the sagitta — here about
    // 0.29r, orders of magnitude past the click tolerance.
    const chordMidpoint = { x: 0.5, y: 0.5 }
    expect(Math.hypot(onCurve.x - chordMidpoint.x, onCurve.y - chordMidpoint.y)).toBeGreaterThan(
      0.2
    )
  })

  test('is the radial offset for a point inside the swept angles', () => {
    expect(distanceToArc({ x: 0, y: 1.25 }, START, MID, END)).toBeCloseTo(0.25, 12)
    expect(distanceToArc({ x: 0, y: 0.75 }, START, MID, END)).toBeCloseTo(0.25, 12)
  })

  test('falls back to the nearer endpoint outside the sweep', () => {
    // Directly below the center: on the circle, but on the half the arc does
    // not cover, so the honest answer is the distance to an end — not zero.
    const below = { x: 0, y: -1 }
    expect(distanceToArc(below, START, MID, END)).toBeCloseTo(Math.SQRT2, 12)
  })

  test('reads the sweep the same way the polyline draws it', () => {
    // Reversing start and end walks the other way round the circle; both the
    // drawn polyline and the distance have to agree about which half that is.
    const reversed = distanceToArc({ x: 0, y: 1 }, END, MID, START)
    expect(reversed).toBeCloseTo(0, 12)
    const points = arcPolyline(END, MID, START)
    expect(points.some((p) => Math.abs(p.x) < 1e-9 && Math.abs(p.y - 1) < 1e-9)).toBe(true)
  })

  test('treats collinear points as the straight segment the renderer draws', () => {
    const a = { x: 0, y: 0 }
    const b = { x: 1, y: 0 }
    const c = { x: 2, y: 0 }
    expect(distanceToArc({ x: 1, y: 0.5 }, a, b, c)).toBeCloseTo(0.5, 12)
    // Past the end, so it measures to the endpoint rather than the infinite line.
    expect(distanceToArc({ x: 5, y: 0 }, a, b, c)).toBeCloseTo(3, 12)
  })
})

describe('arcBounds', () => {
  test('a quarter arc reaches its axis extreme, not only its ends', () => {
    // Center (0,0), r 10, from (10,0) CCW through 45° to (0,10): the ends bound it.
    const m = Math.SQRT1_2 * 10
    expect(arcBounds({ x: 10, y: 0 }, { x: m, y: m }, { x: 0, y: 10 })).toEqual({
      minX: 0,
      minY: 0,
      maxX: 10,
      maxY: 10
    })
    // From (m,-m) through (10,0) to (m,m): the 0° extreme is inside the sweep.
    const b = arcBounds({ x: m, y: -m }, { x: 10, y: 0 }, { x: m, y: m })
    expect(b.maxX).toBeCloseTo(10, 12)
    expect(b.minX).toBeCloseTo(m, 12)
  })

  test('the sweep follows the mid, whichever way it turns', () => {
    // Same ends, mid on the far side: the arc goes the long way round.
    const m = Math.SQRT1_2 * 10
    const b = arcBounds({ x: m, y: -m }, { x: -10, y: 0 }, { x: m, y: m })
    expect(b.minX).toBeCloseTo(-10, 12)
    expect(b.maxY).toBeCloseTo(10, 12)
    expect(b.minY).toBeCloseTo(-10, 12)
    expect(b.maxX).toBeCloseTo(m, 12)
  })

  test('a near-full arc of large radius is bounded by its circle', () => {
    // A 358° arc of radius 35: twelve samples would miss its extremes by ~1.2 mm.
    const r = 35
    const at = (deg: number): { x: number; y: number } => ({
      x: r * Math.cos((deg * Math.PI) / 180),
      y: r * Math.sin((deg * Math.PI) / 180)
    })
    const b = arcBounds(at(1), at(180), at(359))
    expect(b.minX).toBeCloseTo(-r, 12)
    expect(b.minY).toBeCloseTo(-r, 12)
    expect(b.maxY).toBeCloseTo(r, 12)
  })
})

describe('a mid that lies past the end', () => {
  // On a circle of radius 35 about the origin: start at 0°, end at 2°, mid at
  // 2.5°. Through the mid in order the arc runs 357.5° the long way — as KiCad's
  // DRC reads it; KiCad's filler takes start→mid and mid→end each the short
  // way (+2.5°, −0.5°), a 2° arc.
  const at = (deg: number): { x: number; y: number } => ({
    x: 35 * Math.cos((deg * Math.PI) / 180),
    y: 35 * Math.sin((deg * Math.PI) / 180)
  })
  const [start, mid, end] = [at(0), at(2.5), at(2)]

  test('runs through the mid, the long way round', () => {
    expect(arcBounds(start, mid, end).minX).toBeCloseTo(-35, 6)
  })

  test("is the short arc in the filler's reading", () => {
    expect(arcCentralSweep(start, mid, end, 0, 0)).toBeCloseTo((2 * Math.PI) / 180, 9)
  })
})
