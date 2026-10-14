import { describe, expect, test } from 'vitest'
import { partInBand } from '../partBand'

describe('partInBand', () => {
  const band = { xMin: 0, xMax: 10, yMin: 0, yMax: 10 }
  const inside = { minX: 2, minY: 2, maxX: 4, maxY: 4 }
  const straddling = { minX: 8, minY: 2, maxX: 12, maxY: 4 }
  const outside = { minX: 12, minY: 2, maxX: 14, maxY: 4 }

  test('a window band takes only what it wholly encloses', () => {
    expect(partInBand(inside, band, false)).toBe(true)
    expect(partInBand(straddling, band, false)).toBe(false)
    expect(partInBand(outside, band, false)).toBe(false)
  })

  test('a crossing band takes whatever it touches', () => {
    expect(partInBand(inside, band, true)).toBe(true)
    expect(partInBand(straddling, band, true)).toBe(true)
    expect(partInBand(outside, band, true)).toBe(false)
  })

  test('a band over everything takes every part', () => {
    const everywhere = { xMin: -Infinity, xMax: Infinity, yMin: -Infinity, yMax: Infinity }
    expect(partInBand(outside, everywhere, true)).toBe(true)
    expect(partInBand(outside, everywhere, false)).toBe(true)
  })
})
