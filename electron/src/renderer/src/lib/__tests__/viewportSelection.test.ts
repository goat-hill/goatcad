import { describe, expect, test } from 'vitest'
import {
  coordinateField,
  formatCoordinate,
  gridDecimals,
  isMultiSelect,
  sameRef,
  toggleSelection
} from '../viewportSelection'

const ref = (type: string, index: number): { type: string; index: number } => ({ type, index })

describe('isMultiSelect', () => {
  test('any of shift/ctrl/meta adds to the selection', () => {
    const none = { shiftKey: false, ctrlKey: false, metaKey: false }
    expect(isMultiSelect(none)).toBe(false)
    expect(isMultiSelect({ ...none, shiftKey: true })).toBe(true)
    expect(isMultiSelect({ ...none, ctrlKey: true })).toBe(true)
    expect(isMultiSelect({ ...none, metaKey: true })).toBe(true)
  })
})

describe('sameRef', () => {
  test('compares kind and index, not identity', () => {
    expect(sameRef(ref('pin', 2), ref('pin', 2))).toBe(true)
    expect(sameRef(ref('pin', 2), ref('graphic', 2))).toBe(false)
    expect(sameRef(ref('pin', 2), ref('pin', 3))).toBe(false)
  })
})

describe('toggleSelection', () => {
  test('a plain click replaces the selection', () => {
    expect(toggleSelection([ref('pin', 1), ref('pin', 2)], ref('graphic', 0), false)).toEqual([
      ref('graphic', 0)
    ])
  })

  test('a modified click adds', () => {
    expect(toggleSelection([ref('pin', 1)], ref('pin', 2), true)).toEqual([
      ref('pin', 1),
      ref('pin', 2)
    ])
  })

  test('a modified click on a selected item removes it', () => {
    expect(toggleSelection([ref('pin', 1), ref('pin', 2)], ref('pin', 1), true)).toEqual([
      ref('pin', 2)
    ])
  })

  test('same index in a different kind is a different item', () => {
    expect(toggleSelection([ref('pin', 1)], ref('graphic', 1), true)).toEqual([
      ref('pin', 1),
      ref('graphic', 1)
    ])
  })

  test('does not mutate the selection it was given', () => {
    const items = [ref('pin', 1)]
    toggleSelection(items, ref('pin', 2), true)
    toggleSelection(items, ref('pin', 1), true)
    expect(items).toEqual([ref('pin', 1)])
  })
})

describe('formatCoordinate', () => {
  test('mm passes through at three decimals', () => {
    expect(formatCoordinate(1.27, 'mm')).toBe('1.270')
    expect(formatCoordinate(-0.5, 'mm')).toBe('-0.500')
  })

  test('mil converts by the exact factor, not a rounded reciprocal', () => {
    // 1.27 mm is exactly 50 mil. The 39.3701 the viewports used inline gives
    // 49.99, which rounds to 50.0 here but drifts as coordinates grow.
    expect(formatCoordinate(1.27, 'mil')).toBe('50.0')
    expect(formatCoordinate(25.4, 'mil')).toBe('1000.0')
    expect(formatCoordinate(254, 'mil')).toBe('10000.0')
  })

  test('a mil reads to one decimal, matching mm at three', () => {
    expect(formatCoordinate(0.0254, 'mil')).toBe('1.0')
  })

  test('an inch reads to four decimals', () => {
    expect(formatCoordinate(1.27, 'in')).toBe('0.0500')
    expect(formatCoordinate(25.4, 'in')).toBe('1.0000')
  })
})

describe('gridDecimals', () => {
  test('a grid can only land on as many decimals as its spacing has', () => {
    expect(gridDecimals(50)).toBe(0)
    expect(gridDecimals(25)).toBe(0)
    expect(gridDecimals(0.1)).toBe(1)
    expect(gridDecimals(1.27)).toBe(2)
    expect(gridDecimals(0.635)).toBe(3)
  })

  test('survives the shapes a hand-edited config can hold', () => {
    expect(gridDecimals(1e-3)).toBe(3)
    expect(gridDecimals(-0.05)).toBe(2)
    expect(gridDecimals(Number.NaN)).toBe(0)
  })
})

describe('formatCoordinate with a grid', () => {
  // Snap is on, so every point reported IS a grid point: more decimals than the
  // grid can land on are trailing zeroes pretending to be precision.
  test('the grid sets the precision, not the unit', () => {
    expect(formatCoordinate(1.27, 'mil', 50)).toBe('50')
    expect(formatCoordinate(1.27, 'mm', 1.27)).toBe('1.27')
    expect(formatCoordinate(0.5, 'mm', 0.1)).toBe('0.5')
  })

  test('no grid falls back to the per-unit resolution', () => {
    expect(formatCoordinate(1.27, 'mm')).toBe('1.270')
    expect(formatCoordinate(1.27, 'mil')).toBe('50.0')
  })
})

describe('coordinateField', () => {
  // The point of the padding: a readout you follow with your eyes must hold
  // still, so every value at one unit+grid occupies the same width and the
  // rightmost digit never moves.
  test('every value at one setting is the same width', () => {
    const widths = [0, 1.27, -1.27, 127, -1270].map((mm) => coordinateField(mm, 'mm', 1.27).length)
    expect(new Set(widths).size).toBe(1)
  })

  test('right-aligns with spaces, never zeroes', () => {
    // 1 sign + 4 integer + '.' + 2 decimals = 8.
    expect(coordinateField(1.27, 'mm', 1.27)).toBe('    1.27')
    expect(coordinateField(-1.27, 'mm', 1.27)).toBe('   -1.27')
    expect(coordinateField(0, 'mm', 1.27)).toBe('    0.00')
  })

  test('a whole-mil grid reserves no decimal columns', () => {
    // 1 sign + 5 integer, no point.
    expect(coordinateField(1.27, 'mil', 50)).toBe('    50')
    expect(coordinateField(-25.4, 'mil', 50)).toBe(' -1000')
  })

  test('a value past the allowance widens rather than clipping', () => {
    expect(coordinateField(-99999.9, 'mm', 1.27).trim()).toBe('-99999.90')
  })
})
