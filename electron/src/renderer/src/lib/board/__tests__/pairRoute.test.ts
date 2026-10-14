import { describe, expect, test } from 'vitest'
import {
  mergeStraight,
  pairPartner,
  pairSizesOf,
  pairTarget,
  type PairDraft,
  type PairStartItem
} from '../pairRoute'
import type { PrimitivePair } from '../router/diffPair'

const seg = (x0: number, y0: number, x1: number, y1: number): PairDraft['p'][number] => ({
  x0,
  y0,
  x1,
  y1,
  width: 0.2,
  layer: 'F.Cu'
})

describe('pairSizesOf (PR6, S13)', () => {
  const cls = { width: 0.2, gap: 0.25 }
  const list = [{ width: 0.3, gap: 0.3, viaGap: 0.4 }]
  test("the rules' sizes at row 0, the project list past it, typed sizes over both", () => {
    expect(pairSizesOf(cls, list, 0, null)).toEqual({ width: 0.2, gap: 0.25, viaGap: 0.25 })
    expect(pairSizesOf(cls, list, 1, null)).toEqual(list[0])
    const typed = { width: 0.1, gap: 0.1, viaGap: 0.1 }
    expect(pairSizesOf(cls, list, 1, typed)).toBe(typed)
  })
})

describe('mergeStraight (R26)', () => {
  test('joins collinear runs, keeps bends, drops zero-length pieces', () => {
    expect(
      mergeStraight([seg(0, 0, 1, 0), seg(1, 0, 2, 0), seg(2, 0, 2, 0), seg(2, 0, 3, 1)])
    ).toEqual([seg(0, 0, 2, 0), seg(2, 0, 3, 1)])
  })
})

describe('pairTarget (PR4)', () => {
  const pair: PrimitivePair = {
    anchorP: { x: 0, y: 0 },
    anchorN: { x: 0, y: 1 },
    p: { kind: 'via', layers: ['F.Cu', 'B.Cu'] },
    n: { kind: 'via', layers: ['F.Cu', 'B.Cu'] }
  }
  const draft = { nets: { p: 1, n: 2 }, start: pair, p: [] } as unknown as PairDraft
  test('never the copper it started from before anything is laid; another end of the pair', () => {
    expect(pairTarget({ pair, nets: { p: 1, n: 2 }, layer: 'F.Cu' }, draft)).toBeUndefined()
    const far = { ...pair, anchorP: { x: 20, y: 0 } }
    expect(pairTarget({ pair: far, nets: { p: 1, n: 2 }, layer: 'F.Cu' }, draft)).toBe(far)
    expect(pairTarget({ pair: far, nets: { p: 3, n: 2 }, layer: 'F.Cu' }, draft)).toBeUndefined()
  })
})

describe('PR1. Starting', () => {
  const item = (
    kind: PairStartItem['kind'],
    x: number,
    layers = ['F.Cu', 'B.Cu'],
    loose = true
  ): PairStartItem => ({ kind, layers, at: loose ? { x, y: 0 } : null })

  test('the partner is the nearest of the same kind, however far and whatever its footprint', () => {
    const start = item('pad', 0)
    const near = item('via', 0.5)
    const far = item('pad', 40)
    expect(pairPartner(start, [near, far])).toBe(far)
  })

  test('a pad or via partners only copper on the same layers', () => {
    const start = item('pad', 0, ['F.Cu'])
    const back = item('pad', 1, ['B.Cu'])
    const front = item('pad', 3, ['F.Cu'])
    expect(pairPartner(start, [back, front])).toBe(front)
  })

  test('a track starts from its loose end and partners a track with one', () => {
    const start = item('track', 0, ['F.Cu'])
    const joined = item('track', 0.5, ['F.Cu'], false)
    const loose = item('track', 2, ['F.Cu'])
    expect(pairPartner(start, [joined, loose])).toBe(loose)
    expect(pairPartner(item('track', 0, ['F.Cu'], false), [loose])).toBeNull()
  })
})
