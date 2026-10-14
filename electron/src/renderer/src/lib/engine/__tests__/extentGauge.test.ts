import { describe, expect, test } from 'vitest'
import { formatMm, niceTickStep } from '../extentGauge'

describe('niceTickStep', () => {
  test('picks 1/2/5 decade steps giving roughly 4-8 divisions', () => {
    expect(niceTickStep(10)).toBe(2)
    expect(niceTickStep(25.4)).toBe(5)
    expect(niceTickStep(100)).toBe(20)
    expect(niceTickStep(3)).toBe(0.5)
    expect(niceTickStep(0.8)).toBe(0.1)
  })

  test('division count stays in a readable range across magnitudes', () => {
    for (const span of [0.3, 1, 4.7, 12.7, 33, 160, 1200]) {
      const divisions = span / niceTickStep(span)
      expect(divisions).toBeGreaterThanOrEqual(3)
      expect(divisions).toBeLessThanOrEqual(10)
    }
  })

  test('degenerate spans fall back to a sane step', () => {
    expect(niceTickStep(0)).toBe(1)
    expect(niceTickStep(-5)).toBe(1)
    expect(niceTickStep(Number.NaN)).toBe(1)
  })
})

describe('formatMm', () => {
  test('rounds to at most two decimals without trailing zeros', () => {
    expect(formatMm(25.4)).toBe('25.4')
    expect(formatMm(3.175)).toBe('3.18')
    expect(formatMm(10)).toBe('10')
    expect(formatMm(0.049999)).toBe('0.05')
  })
})
