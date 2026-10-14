/** T4: the cursor meter's scale. */
import { describe, expect, test } from 'vitest'
import { tuneMeterScale } from '../tuneMeter'

describe('tuneMeterScale', () => {
  test('no target is the plain readout', () => {
    expect(tuneMeterScale(12, { min: 0, opt: Infinity, max: Infinity })).toBeNull()
  })

  test('a tuned value sits in a band centered on the bar', () => {
    const s = tuneMeterScale(10, { min: 9.9, opt: 10, max: 10.1 })!
    expect(s.band[0]).toBeCloseTo(1 / 3)
    expect(s.band[1]).toBeCloseTo(2 / 3)
    expect(s.opt).toBeCloseTo(0.5)
    expect(s.needle).toBeCloseTo(0.5)
  })

  test('a far-short value widens the bar to take it in, off its edge', () => {
    const s = tuneMeterScale(5, { min: 9.9, opt: 10, max: 10.1 })!
    expect(s.needle).toBeGreaterThan(0)
    expect(s.needle).toBeLessThan(0.1)
    expect(s.band[0]).toBeGreaterThan(s.needle)
    expect(s.band[1]).toBeLessThan(1)
  })

  test('a skew band either side of nothing', () => {
    const s = tuneMeterScale(0.25, { min: -0.1, opt: 0, max: 0.1 })!
    expect(s.needle).toBeGreaterThan(s.band[1])
    expect(s.needle).toBeLessThan(1)
  })
})
