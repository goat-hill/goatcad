import { describe, expect, test } from 'vitest'
import { fuzzyMatch } from '../fuzzyMatch'

describe('fuzzyMatch', () => {
  test('requires the query as an in-order subsequence', () => {
    expect(fuzzyMatch('brd', 'board.kicad_pcb')).not.toBeNull()
    expect(fuzzyMatch('xyz', 'board.kicad_pcb')).toBeNull()
    // In-order only: characters present but reversed do not match.
    expect(fuzzyMatch('db', 'bd')).toBeNull()
  })

  test('is case-insensitive but reports original indices', () => {
    const m = fuzzyMatch('RM', 'README.md')
    expect(m).not.toBeNull()
    expect(m!.indices).toEqual([0, 7])
  })

  test('empty query matches everything with no highlights', () => {
    expect(fuzzyMatch('', 'anything')).toEqual({ score: 0, indices: [] })
  })

  test('prefers a word start over a mid-word occurrence', () => {
    // The `r` of `readme` should be the basename start, not the r in `hardware`.
    const m = fuzzyMatch('readme', 'hardware/readme.md')
    expect(m!.indices[0]).toBe(9)
  })

  test('a continued run is not abandoned for a later word start', () => {
    // After matching `boar`, the final `d` continues the run at index 4
    // instead of jumping to the word-start `d` of `design`.
    const m = fuzzyMatch('board', 'board-design.txt')
    expect(m!.indices).toEqual([0, 1, 2, 3, 4])
  })

  test('scores a basename match above the same match in a directory', () => {
    const inBasename = fuzzyMatch('main', 'src/main.c')!
    const inDirectory = fuzzyMatch('main', 'main/other.c')!
    expect(inBasename.score).toBeGreaterThan(inDirectory.score)
  })

  test('scores consecutive matches above scattered ones', () => {
    const consecutive = fuzzyMatch('sch', 'power.kicad_sch')!
    const scattered = fuzzyMatch('sch', 'silk-copper-hole.txt')!
    expect(consecutive.score).toBeGreaterThan(scattered.score)
  })

  test('indices are strictly ascending', () => {
    const m = fuzzyMatch('aaa', 'banana-salad')!
    for (let i = 1; i < m.indices.length; i++) {
      expect(m.indices[i]).toBeGreaterThan(m.indices[i - 1])
    }
  })
})
