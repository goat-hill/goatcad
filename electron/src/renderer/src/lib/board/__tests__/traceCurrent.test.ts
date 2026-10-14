import { describe, expect, test } from 'vitest'
import { traceWidthForCurrent } from '../traceCurrent'

describe('traceWidthForCurrent', () => {
  test('1 A at a 10 °C rise on outer 1 oz copper is about 0.30 mm', () => {
    const { widthMm, inRange } = traceWidthForCurrent(1, 10, 0.035, true)
    expect(widthMm).toBeCloseTo(0.3, 2)
    expect(inRange).toBe(true)
  })

  test('an inner layer needs 2^(1/0.725) the width of an outer one', () => {
    const outer = traceWidthForCurrent(2, 20, 0.035, true).widthMm ?? 0
    const inner = traceWidthForCurrent(2, 20, 0.035, false).widthMm ?? 0
    expect(inner / outer).toBeCloseTo(2 ** (1 / 0.725), 6)
  })

  test('twice the copper halves the width', () => {
    const one = traceWidthForCurrent(3, 10, 0.035, true).widthMm ?? 0
    const two = traceWidthForCurrent(3, 10, 0.07, true).widthMm ?? 0
    expect(two).toBeCloseTo(one / 2, 9)
  })

  test('past the fitted range it still answers, out of range', () => {
    expect(traceWidthForCurrent(40, 10, 0.035, true).inRange).toBe(false)
    expect(traceWidthForCurrent(20, 100, 0.105, true).inRange).toBe(true)
    expect(traceWidthForCurrent(20, 100, 0.105, false).inRange).toBe(false)
    expect(traceWidthForCurrent(1, 5, 0.035, true).inRange).toBe(false)
    expect(traceWidthForCurrent(1, 10, 0.01, true).inRange).toBe(false)
  })

  test('no current or no copper gives no width', () => {
    expect(traceWidthForCurrent(0, 10, 0.035, true).widthMm).toBeNull()
    expect(traceWidthForCurrent(1, 10, 0, true).widthMm).toBeNull()
  })
})
