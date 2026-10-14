import { describe, expect, test } from 'vitest'
import {
  boardItemKind,
  boardRefKey,
  footprintsOf,
  footprintTextClass,
  promotePads,
  rankBoardHits,
  type BoardItemRef,
  type RankedBoardHit
} from '../BoardScene'
import { resolveHit, resolveSweep, type HitCandidate } from '../../selectionResolve'
import { allowsHitFor, defaultFilterState } from '../../selectionFilter'

/**
 * `BoardScene` itself cannot be constructed here — it builds a `LabelBatch`,
 * which rasterizes glyphs against a DOM canvas, and the suite runs in node. So
 * the two pieces the hit-test refactor actually risks are exported and tested
 * directly: the type→kind mapping and the ranking that replaced the old
 * single-best fold.
 */

let order = 0
const hit = (type: string, dist: number, above = 0, index = 0, locked = false): RankedBoardHit => ({
  hit: { type, index },
  kind: boardItemKind(type),
  locked,
  dist,
  above,
  rank: RANK[type],
  order: order++
})

// Mirrors BOARD_TYPE_RANK, which is private: the order the hit loops run in.
const RANK: Record<string, number> = {
  via: 0,
  segment: 1,
  tarc: 2,
  gr_line: 3,
  gr_arc: 4,
  gr_circle: 5,
  gr_rect: 6,
  gr_poly: 7,
  gr_text: 8,
  zone: 9,
  footprint: 10
}

const types = (ranked: RankedBoardHit[]): string[] => ranked.map((r) => r.hit.type)

const candidates = (ranked: RankedBoardHit[]): Array<HitCandidate<BoardItemRef>> =>
  ranked.map(({ hit: ref, kind, locked }) => ({ levels: [{ kind, locked, ref }] }))

describe('boardItemKind', () => {
  test('collapses item types onto the kinds a user actually filters', () => {
    expect(boardItemKind('segment')).toBe('track')
    expect(boardItemKind('tarc')).toBe('track')
    expect(boardItemKind('gr_line')).toBe('graphic')
    expect(boardItemKind('gr_poly')).toBe('graphic')
    expect(boardItemKind('gr_text')).toBe('text')
    expect(boardItemKind('via')).toBe('via')
    expect(boardItemKind('footprint')).toBe('footprint')
    expect(boardItemKind('zone')).toBe('zone')
    // A keepout zone is KiCad's rule area, filtered on its own switch.
    expect(boardItemKind('zone', true)).toBe('rule_area')
  })
})

// The ranking used to be a fold that kept only a winner. Turning it into a
// sorted list must not shift which item wins — each case below is one of the
// fold's rules, restated as an ordering.
describe('rankBoardHits', () => {
  test('puts the nearest first', () => {
    order = 0
    expect(types(rankBoardHits([hit('footprint', 0.3), hit('via', 0.1)]))).toEqual([
      'via',
      'footprint'
    ])
  })

  test('a via inside a footprint outline beats it on the distance-0 tie', () => {
    order = 0
    // Registration order is via-then-footprint; the footprint's bbox interior
    // is distance 0 just as the via's body is.
    expect(types(rankBoardHits([hit('via', 0), hit('footprint', 0)]))).toEqual(['via', 'footprint'])
    // ...and the same holds if the sort is handed them the other way round.
    order = 0
    expect(types(rankBoardHits([hit('footprint', 0), hit('via', 0)]))).toEqual(['via', 'footprint'])
  })

  test('cross-type priority does not let paint rank override it', () => {
    order = 0
    // A silkscreen graphic paints far above a via, and still loses the tie:
    // the fold only ever compares paint rank between items of one type.
    expect(types(rankBoardHits([hit('via', 0, 0), hit('gr_line', 0, 99)]))).toEqual([
      'via',
      'gr_line'
    ])
  })

  test('between same-type overlaps, the one drawn on top wins', () => {
    order = 0
    const back = hit('gr_text', 0, 1, 0)
    const front = hit('gr_text', 0, 5, 1)
    expect(types(rankBoardHits([back, front]))).toEqual(['gr_text', 'gr_text'])
    expect(rankBoardHits([back, front])[0].hit.index).toBe(1)
  })

  test('at equal z the later item wins, matching the fold', () => {
    order = 0
    // Real boards carry same-layer duplicate texts as drop shadows; the fold's
    // `z >= bestZ` let the later one replace the earlier.
    const first = hit('gr_text', 0, 3, 0)
    const second = hit('gr_text', 0, 3, 1)
    expect(rankBoardHits([first, second])[0].hit.index).toBe(1)
  })

  test('distance still outranks everything below it', () => {
    order = 0
    // A footprint right under the cursor beats a via that is merely nearby,
    // even though the via has the better type priority.
    expect(types(rankBoardHits([hit('via', 0.4), hit('footprint', 0)]))).toEqual([
      'footprint',
      'via'
    ])
  })
})

describe('board candidates under the selection filter', () => {
  const allows = (excludedKinds: string[], allowLocked = true): ReturnType<typeof allowsHitFor> =>
    allowsHitFor('pcb', { excludedKinds, allowLocked })

  /** A via over a track over a footprint — the classic dense-board stack. */
  const stack = (): Array<HitCandidate<BoardItemRef>> => {
    order = 0
    return candidates(rankBoardHits([hit('via', 0), hit('segment', 0), hit('footprint', 0)]))
  }

  test('resolves to the winner when nothing is filtered out', () => {
    expect(resolveHit(stack(), allows([]))).toMatchObject({ type: 'via' })
  })

  // The reason hitTest could not stay a single-best fold: with the winner
  // filtered out, the click has to reach what is behind it rather than
  // selecting nothing.
  test('falls through to what sits behind a filtered-out kind', () => {
    expect(resolveHit(stack(), allows(['via']))).toMatchObject({ type: 'segment' })
    expect(resolveHit(stack(), allows(['via', 'track']))).toMatchObject({ type: 'footprint' })
    expect(resolveHit(stack(), allows(['via', 'track', 'footprint']))).toBeNull()
  })

  test('one filter switch covers every type that maps to the kind', () => {
    order = 0
    const tracks = candidates(rankBoardHits([hit('segment', 0), hit('tarc', 0.1)]))
    expect(resolveHit(tracks, allows(['track']))).toBeNull()
  })

  test('locked is filtered independently of kind', () => {
    order = 0
    const lockedTrack = candidates(rankBoardHits([hit('segment', 0, 0, 1, true)]))
    expect(resolveHit(lockedTrack, allows([], true))).toMatchObject({ type: 'segment' })
    expect(resolveHit(lockedTrack, allows([], false))).toBeNull()

    // An unlocked item of the same kind is untouched by the locked switch.
    order = 0
    const mixed = candidates(
      rankBoardHits([hit('segment', 0, 0, 1, true), hit('segment', 0.1, 0, 2, false)])
    )
    expect(resolveHit(mixed, allows([], false))).toMatchObject({ type: 'segment', index: 2 })
  })

  test('the default filter changes nothing about what a click selects', () => {
    const withDefault = resolveHit(stack(), allowsHitFor('pcb', defaultFilterState()))
    expect(withDefault).toEqual(stack()[0].levels[0].ref)
  })

  test('a sweep drops filtered kinds and keeps the rest', () => {
    order = 0
    // Distinct distances so the sweep's order is the ranking's, not a tie-break.
    const swept = candidates(
      rankBoardHits([
        hit('via', 0, 0, 0),
        hit('segment', 0.01, 0, 0),
        hit('segment', 0.02, 0, 1, true),
        hit('footprint', 0.03, 0, 0)
      ])
    )
    const key = (ref: BoardItemRef): string => `${ref.type}:${ref.index}`
    expect(resolveSweep(swept, allows(['footprint', 'via']), key).map(key)).toEqual([
      'segment:0',
      'segment:1'
    ])
    // Locked off removes only the locked track.
    expect(resolveSweep(swept, allows(['footprint', 'via'], false), key).map(key)).toEqual([
      'segment:0'
    ])
  })
})

describe('pads on the board', () => {
  test('a pad is keyed by its paint key, under its footprint', () => {
    expect(boardRefKey({ type: 'pad', index: 3, pad: 2 })).toBe('footprint:3/pad:2')
    expect(boardRefKey({ type: 'via', index: 3 })).toBe('via:3')
  })

  test('move, rotate and copy act on a pad’s footprint, each footprint once', () => {
    expect(
      promotePads([
        { type: 'pad', index: 1, pad: 0 },
        { type: 'pad', index: 1, pad: 4 },
        { type: 'footprint', index: 1 },
        { type: 'via', index: 0 }
      ])
    ).toEqual([
      { type: 'footprint', index: 1 },
      { type: 'via', index: 0 }
    ])
  })
})

describe('a footprint’s fields and texts', () => {
  test('are keyed under their footprint and filtered as text', () => {
    expect(boardRefKey({ type: 'fp_field', index: 2, child: 0 })).toBe('footprint:2/field:0')
    expect(boardRefKey({ type: 'fp_text', index: 2, child: 1 })).toBe('footprint:2/text:1')
    expect(boardItemKind('fp_field')).toBe('text')
    expect(boardItemKind('fp_text')).toBe('text')
    expect(boardItemKind('point')).toBe('point')
  })

  test('follow their switch: Reference, Value, or text', () => {
    expect(footprintTextClass({ key: 'Reference' })).toBe('reference')
    expect(footprintTextClass({ key: 'Value' })).toBe('value')
    expect(footprintTextClass({ key: 'Footprint' })).toBe('text')
    expect(footprintTextClass({ type: 'user', text: '${REFERENCE}' })).toBe('reference')
    expect(footprintTextClass({ type: 'user', text: 'hi' })).toBe('text')
    expect(footprintTextClass({ type: 'value', text: '10k' })).toBe('value')
  })

  test('move on their own, unless their footprint moves them', () => {
    expect(
      promotePads([
        { type: 'fp_field', index: 0, child: 0 },
        { type: 'fp_text', index: 1, child: 0 },
        { type: 'footprint', index: 1 }
      ])
    ).toEqual([
      { type: 'fp_field', index: 0, child: 0 },
      { type: 'footprint', index: 1 }
    ])
    expect(
      footprintsOf([
        { type: 'fp_field', index: 3 },
        { type: 'via', index: 0 }
      ])
    ).toEqual([3])
  })
})
