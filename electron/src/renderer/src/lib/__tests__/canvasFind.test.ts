import { describe, expect, test } from 'vitest'
import {
  compileQuery,
  findHits,
  findStepFor,
  FIND_TEXT_DEFAULTS,
  steppedHit,
  type FindCandidate
} from '../canvasFind'

const candidates: FindCandidate<string>[] = [
  { key: 'low', target: 'low', text: 'R2 R20', position: { x: 0, y: 10 } },
  { key: 'high-right', target: 'high-right', text: 'R1', position: { x: 5, y: 0 } },
  { key: 'high-left', target: 'high-left', text: 'r3', position: { x: 0, y: 0 } },
  { key: 'net', target: 'net', text: 'R_NET' }
]

const key = (k: string, mods: Partial<KeyboardEvent> = {}): KeyboardEvent =>
  ({
    key: k,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...mods
  }) as KeyboardEvent

describe('compileQuery', () => {
  test('escapes a plain query and honors the switches', () => {
    expect(compileQuery('a.b', FIND_TEXT_DEFAULTS)?.test('axb')).toBe(false)
    expect(compileQuery('a.b', { ...FIND_TEXT_DEFAULTS, regex: true })?.test('axb')).toBe(true)
    expect(compileQuery('R', { ...FIND_TEXT_DEFAULTS, matchCase: true })?.test('r')).toBe(false)
  })

  test('is null for nothing, or for a regex that does not compile', () => {
    expect(compileQuery('', FIND_TEXT_DEFAULTS)).toBeNull()
    expect(compileQuery('(', { ...FIND_TEXT_DEFAULTS, regex: true })).toBeNull()
  })
})

describe('findHits', () => {
  test('reads top to bottom, then left to right, with placeless hits last', () => {
    const hits = findHits(candidates, 'r', FIND_TEXT_DEFAULTS)
    expect(hits.map((hit) => hit.target)).toEqual(['high-left', 'high-right', 'low', 'low', 'net'])
  })

  test('reads upward in a y-up space', () => {
    const hits = findHits(candidates.slice(0, 3), 'r', FIND_TEXT_DEFAULTS, false)
    expect(hits[0].target).toBe('low')
  })

  test('keys each hit in one text apart', () => {
    const hits = findHits(candidates, 'R2', FIND_TEXT_DEFAULTS)
    expect(hits.map((hit) => [hit.key, hit.start, hit.end])).toEqual([
      ['low|0', 0, 2],
      ['low|3', 3, 5]
    ])
  })

  test('whole word skips a hit inside a longer name', () => {
    expect(findHits(candidates, 'R2', { ...FIND_TEXT_DEFAULTS, wholeWord: true })).toHaveLength(1)
  })
})

describe('steppedHit', () => {
  test('starts at either end, then steps and wraps', () => {
    expect(steppedHit(-1, 1, 3)).toBe(0)
    expect(steppedHit(-1, -1, 3)).toBe(2)
    expect(steppedHit(2, 1, 3)).toBe(0)
    expect(steppedHit(0, -1, 3)).toBe(2)
    expect(steppedHit(0, 1, 0)).toBe(-1)
  })
})

describe('findStepFor', () => {
  test('reads F3 and Shift+F3, and the macOS ⌘G pair', () => {
    expect(findStepFor(key('F3'))).toBe(1)
    expect(findStepFor(key('F3', { shiftKey: true }))).toBe(-1)
    expect(findStepFor(key('g', { metaKey: true }))).toBe(1)
    expect(findStepFor(key('G', { metaKey: true, shiftKey: true }))).toBe(-1)
  })

  test('leaves Ctrl+G and Ctrl+Shift+G alone — the latter opens the Git pane', () => {
    expect(findStepFor(key('g', { ctrlKey: true }))).toBeNull()
    expect(findStepFor(key('G', { ctrlKey: true, shiftKey: true }))).toBeNull()
  })
})
