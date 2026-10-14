import { describe, expect, test } from 'vitest'
import { DEFAULT_MEANDER, meander, piecesLength } from '../meander'

// docs/router-behavior.md T1–T3.

const from = { x: 0, y: 0 }
const to = { x: 10, y: 0 }
const square = { ...DEFAULT_MEANDER, cornerRadiusPercent: 0 }
const always = (): boolean => true

describe('meander', () => {
  test('with no target every bump is as tall as it may be, one serpentine across the stretch', () => {
    const m = meander(from, to, Infinity, square, always)
    // From the stretch's start (KiCad's), 16 touching bumps 0.6 mm wide fit in
    // 10 mm, sides alternating: a 1 mm leg in and out, and 15 legs of 2 mm
    // crossing the stretch between.
    expect(m.bumps).toBe(16)
    expect(m.added).toBeCloseTo(32, 9)
    expect(piecesLength(m.pieces)).toBeCloseTo(42, 9)
    const ys = m.pieces.flatMap((p) => [p.a.y, p.b.y])
    expect(Math.max(...ys)).toBeCloseTo(1, 9)
    expect(Math.min(...ys)).toBeCloseTo(-1, 9)
    // KiCad's MT_TURN: no run along the stretch between the first leg and the last.
    const runs = m.pieces.filter((p) => p.a.y === p.b.y)
    expect(runs.slice(1, -1).every((p) => Math.abs(p.a.y) === 1)).toBe(true)
    expect(m.pieces.some((p) => p.a.x === p.b.x && p.a.y * p.b.y < 0)).toBe(true)
  })

  test('T2: to a target, the bumps are lowered together so the stretch lands on it', () => {
    const m = meander(from, to, 3, square, always)
    expect(piecesLength(m.pieces)).toBeCloseTo(13, 6)
    // KiCad's tuneLineLength: every bump the same height, not the last cut down alone.
    const tops = m.pieces.filter((p) => Math.abs(p.a.y - p.b.y) < 1e-9 && Math.abs(p.a.y) > 1e-9)
    const heights = tops.map((p) => Math.abs(p.a.y))
    expect(heights.length).toBeGreaterThan(1)
    for (const h of heights) expect(h).toBeCloseTo(heights[0], 6)
    expect(heights[0]).toBeLessThan(1)
  })

  test('T3: a place no bump fits is passed, the bumps starting again beyond it', () => {
    // Nothing fits over the first 4 mm, at any height.
    const m = meander(from, to, Infinity, square, (bump) => bump.every((p) => p.x >= 4))
    const xs = m.pieces.filter((p) => Math.abs(p.a.y) > 1e-9).map((p) => p.a.x)
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(4 - 1e-9)
    expect(Math.min(...xs)).toBeLessThan(4.7)
    expect(m.bumps).toBeGreaterThan(5)
  })

  test('rounded corners still land on the target', () => {
    const m = meander(from, to, 3, DEFAULT_MEANDER, always)
    expect(m.pieces.some((p) => p.mid)).toBe(true)
    expect(piecesLength(m.pieces)).toBeCloseTo(13, 3)
  })

  test('single-sided, every bump goes the one way', () => {
    const m = meander(from, to, Infinity, { ...square, singleSided: true, side: -1 }, always)
    expect(Math.max(...m.pieces.flatMap((p) => [p.a.y, p.b.y]))).toBeCloseTo(0, 9)
  })

  test('T3: a bump that would not keep clear is lower, or left out', () => {
    const m = meander(from, to, Infinity, { ...square, singleSided: true }, (bump) =>
      bump.every((p) => p.y <= 0.5 + 1e-9 || p.x > 5)
    )
    const tops = m.pieces.filter((p) => p.a.y === p.b.y && p.a.y > 0)
    expect(tops.every((p) => p.a.x > 5 || p.a.y <= 0.5 + 1e-9)).toBe(true)
    // Lowered where clearance asks, not dropped; full height (1 mm) beyond.
    expect(tops.some((p) => p.a.x <= 5 && p.a.y > 0)).toBe(true)
    expect(tops.some((p) => p.a.x > 5 && Math.abs(p.a.y - 1) < 1e-9)).toBe(true)
  })
})
