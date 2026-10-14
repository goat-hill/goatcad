import { describe, expect, it } from 'vitest'
import {
  collapseValue,
  formatAngle,
  formatDistance,
  hexToRgba,
  isMixed,
  MIXED,
  nextRowIndex,
  normalizeAngle,
  parseAngle,
  parseDistance,
  rgbaEq,
  rgbaToHex,
  snapCardinal
} from '../propertyTable'

describe('collapseValue', () => {
  it('returns the shared value when all members agree', () => {
    expect(collapseValue([{ x: 2 }, { x: 2 }, { x: 2 }], (m) => m.x)).toBe(2)
  })

  it('returns MIXED when members disagree', () => {
    expect(collapseValue([{ x: 2 }, { x: 5 }], (m) => m.x)).toBe(MIXED)
  })

  it('returns the value for a single member', () => {
    expect(collapseValue([{ name: 'A' }], (m) => m.name)).toBe('A')
  })

  it('handles booleans and empty selections', () => {
    expect(collapseValue([{ b: true }, { b: true }], (m) => m.b)).toBe(true)
    expect(collapseValue([{ b: true }, { b: false }], (m) => m.b)).toBe(MIXED)
    expect(collapseValue([], () => 1)).toBe(MIXED)
  })
})

describe('isMixed', () => {
  it('identifies the sentinel only', () => {
    expect(isMixed(MIXED)).toBe(true)
    expect(isMixed(null)).toBe(false)
    expect(isMixed('')).toBe(false)
    expect(isMixed(0)).toBe(false)
  })
})

describe('nextRowIndex', () => {
  it('moves within bounds and clamps at the ends (no wrap)', () => {
    expect(nextRowIndex(0, 1, 3)).toBe(1)
    expect(nextRowIndex(2, 1, 3)).toBe(2) // clamp at last
    expect(nextRowIndex(0, -1, 3)).toBe(0) // clamp at first
    expect(nextRowIndex(1, -1, 3)).toBe(0)
  })

  it('is safe for single-row and empty tables', () => {
    expect(nextRowIndex(0, 1, 1)).toBe(0)
    expect(nextRowIndex(0, -1, 0)).toBe(0)
  })
})

describe('distance conversion', () => {
  it('formats mm and mil, honoring negate', () => {
    expect(formatDistance(1.27, 'mm')).toBe('1.27')
    expect(formatDistance(2.54, 'mil')).toBe('100')
    expect(formatDistance(3.81, 'mm', true)).toBe('-3.81')
  })

  it('parses default unit + explicit suffix, then un-negates', () => {
    expect(parseDistance('1.27', 'mm')).toBe(1.27)
    expect(parseDistance('100mil', 'mm')).toBeCloseTo(2.54, 9)
    expect(parseDistance('-3.81', 'mm', true)).toBe(3.81)
    expect(parseDistance('', 'mm')).toBeNull()
    expect(parseDistance('abc', 'mm')).toBeNull()
  })

  it('round-trips mm through mil display', () => {
    const shown = formatDistance(2.54, 'mil') // '100'
    expect(parseDistance(shown, 'mil')).toBeCloseTo(2.54, 9)
  })
})

describe('angle conversion', () => {
  it('normalizes into [0,360)', () => {
    expect(normalizeAngle(450)).toBe(90)
    expect(normalizeAngle(-90)).toBe(270)
  })

  it('snaps to cardinals', () => {
    expect(snapCardinal(44)).toBe(0)
    expect(snapCardinal(46)).toBe(90)
    expect(snapCardinal(359)).toBe(0)
  })

  it('formats with an optional storage scale (÷) and parses (×)', () => {
    expect(formatAngle(90)).toBe('90')
    expect(formatAngle(900, 10)).toBe('90') // stored ×10
    expect(parseAngle('90', 10)).toBe(900)
  })

  it('parse applies cardinal snap + normalize', () => {
    expect(parseAngle('46', 1, true)).toBe(90)
    expect(parseAngle('-90')).toBe(270)
    expect(parseAngle('')).toBeNull()
  })
})

describe('color helpers', () => {
  it('round-trips rgb through hex', () => {
    expect(rgbaToHex({ r: 255, g: 128, b: 0, a: 1 })).toBe('#ff8000')
    expect(hexToRgba('#ff8000', 0.5)).toEqual({ r: 255, g: 128, b: 0, a: 0.5 })
  })

  it('rgbaEq compares by value and handles null/unset', () => {
    expect(rgbaEq({ r: 1, g: 2, b: 3, a: 1 }, { r: 1, g: 2, b: 3, a: 1 })).toBe(true)
    expect(rgbaEq({ r: 1, g: 2, b: 3, a: 1 }, { r: 1, g: 2, b: 4, a: 1 })).toBe(false)
    expect(rgbaEq(null, null)).toBe(true)
    expect(rgbaEq(null, { r: 0, g: 0, b: 0, a: 0 })).toBe(false)
  })

  it('collapseValue with rgbaEq collapses value-equal colors', () => {
    const members = [{ c: { r: 1, g: 2, b: 3, a: 1 } }, { c: { r: 1, g: 2, b: 3, a: 1 } }]
    expect(collapseValue(members, (m) => m.c, rgbaEq)).toEqual({ r: 1, g: 2, b: 3, a: 1 })
    const mixed = [{ c: { r: 1, g: 2, b: 3, a: 1 } }, { c: { r: 9, g: 9, b: 9, a: 1 } }]
    expect(collapseValue(mixed, (m) => m.c, rgbaEq)).toBe(MIXED)
  })
})
