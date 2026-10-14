import { describe, expect, test } from 'vitest'
import { PARSE_SLICE, mergeBoardLoadProgress } from '../boardLoadProgress'

describe('mergeBoardLoadProgress', () => {
  test('is null only when nothing is loading', () => {
    expect(mergeBoardLoadProgress(null, null, false)).toBeNull()
    expect(mergeBoardLoadProgress(0, null, false)).toBe(0)
    expect(mergeBoardLoadProgress(null, 0, false)).toBe(PARSE_SLICE)
    expect(mergeBoardLoadProgress(null, null, true)).toBe(PARSE_SLICE)
  })

  test('gives each phase its own slice of one bar', () => {
    expect(mergeBoardLoadProgress(1, null, false)).toBeCloseTo(PARSE_SLICE)
    expect(mergeBoardLoadProgress(null, 1, false)).toBeCloseTo(1)
    expect(mergeBoardLoadProgress(0.5, null, false)).toBeCloseTo(PARSE_SLICE / 2)
  })

  test('never goes backwards across a whole load', () => {
    // parse → handoff → scene build, as the editor reports it
    const sequence: Array<[number | null, number | null, boolean]> = [
      [0, null, false],
      [0.4, null, false],
      [1, null, false],
      [null, null, true],
      [null, 0, true],
      [null, 0.6, true],
      [null, 1, true]
    ]
    const seen = sequence.map(([parse, scene, awaiting]) =>
      mergeBoardLoadProgress(parse, scene, awaiting)
    )
    expect(seen.every((value) => value !== null)).toBe(true)
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]!).toBeGreaterThanOrEqual(seen[i - 1]!)
    }
    expect(seen[seen.length - 1]).toBeCloseTo(1)
  })

  test('a live scene build outranks a stale parse fraction', () => {
    expect(mergeBoardLoadProgress(0.2, 0.5, true)).toBeGreaterThan(PARSE_SLICE)
  })
})
