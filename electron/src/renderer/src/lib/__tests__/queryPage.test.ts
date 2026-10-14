import { describe, expect, test } from 'vitest'
import { cappedGuidance, narrowingsOf, pageOf, tally } from '../queryPage'

describe('a capped query page', () => {
  const tracks = [
    ...Array.from({ length: 610 }, () => ({ kind: 'track', layer: 'F.Cu' })),
    ...Array.from({ length: 630 }, () => ({ kind: 'track', layer: 'B.Cu' })),
    ...Array.from({ length: 12 }, () => ({ kind: 'via', layer: 'F.Cu' }))
  ]

  test('pages from offset and says whether more match', () => {
    expect(pageOf([1, 2, 3, 4, 5], 2, 2)).toEqual({
      rows: [3, 4],
      total: 5,
      offset: 2,
      truncated: true
    })
    expect(pageOf([1, 2, 3], 1, 5).truncated).toBe(false)
  })

  test('names the counts the matches offer, largest first', () => {
    const narrowings = narrowingsOf(tracks, false, [
      { arg: 'layer', given: false, tally: (items) => tally(items, (item) => [item.layer]) }
    ])
    const text = cappedGuidance(pageOf(tracks, 0, 100), narrowings, 4)
    expect(text).toBe(
      '1,252 match; these are rows 0 to 99. By kind: track 1,240, via 12. kind "track" (1,240) by layer: B.Cu 630, F.Cu 610. Narrow by one of these, or read on with offset 100 and revision 4.'
    )
  })

  test('leaves out a filter already given, and one with a single value', () => {
    const narrowings = narrowingsOf(tracks, true, [
      { arg: 'layer', given: true, tally: (items) => tally(items, (item) => [item.layer]) },
      { arg: 'net', given: false, tally: () => [['GND', 1240]] }
    ])
    expect(narrowings).toEqual([])
  })
})
