import { describe, expect, test } from 'vitest'
import { constrainChainPoint, constrainLinePoint, nextLineMode } from '../lineMode'

describe('nextLineMode', () => {
  test('cycles 45° → 90° → free → 45°', () => {
    expect(nextLineMode('45')).toBe('90')
    expect(nextLineMode('90')).toBe('free')
    expect(nextLineMode('free')).toBe('45')
  })
})

describe('constrainLinePoint', () => {
  const o = { x: 0, y: 0 }

  test('free leaves the point alone', () => {
    expect(constrainLinePoint('free', o, { x: 3, y: 7 })).toEqual({ x: 3, y: 7 })
  })

  test('90° keeps the larger extent on its axis', () => {
    expect(constrainLinePoint('90', o, { x: 5, y: 2 })).toEqual({ x: 5, y: 0 })
    expect(constrainLinePoint('90', o, { x: 2, y: -5 })).toEqual({ x: 0, y: -5 })
    expect(constrainLinePoint('90', { x: 10, y: 10 }, { x: 13, y: 13 })).toEqual({ x: 13, y: 10 })
  })

  test('45° picks an axis past twice the other extent, the diagonal otherwise', () => {
    expect(constrainLinePoint('45', o, { x: 10, y: 4 })).toEqual({ x: 10, y: 0 })
    expect(constrainLinePoint('45', o, { x: 4, y: 10 })).toEqual({ x: 0, y: 10 })
    expect(constrainLinePoint('45', o, { x: 10, y: 6 })).toEqual({ x: 10, y: 10 })
    expect(constrainLinePoint('45', o, { x: -6, y: 10 })).toEqual({ x: -10, y: 10 })
    expect(constrainLinePoint('45', o, { x: 10, y: -7 })).toEqual({ x: 10, y: -10 })
  })

  test('keeps other fields of the point', () => {
    const p = constrainLinePoint('90', o, { x: 5, y: 1, tag: 'a' })
    expect(p).toEqual({ x: 5, y: 0, tag: 'a' })
  })
})

describe('constrainChainPoint', () => {
  test('the first point is free', () => {
    expect(constrainChainPoint('90', [], { x: 3, y: 4 })).toEqual({ x: 3, y: 4 })
  })

  test('measures from the last point placed', () => {
    const draft = [
      { x: 0, y: 0 },
      { x: 10, y: 0 }
    ]
    expect(constrainChainPoint('90', draft, { x: 12, y: 8 })).toEqual({ x: 10, y: 8 })
  })

  test('a click back on the start stays on it, so the outline closes', () => {
    const draft = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 }
    ]
    expect(constrainChainPoint('90', draft, { x: 0, y: 0 })).toEqual({ x: 0, y: 0 })
  })
})
