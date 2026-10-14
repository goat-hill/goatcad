import { describe, expect, test } from 'vitest'
import { parseKicadFootprint } from '../../kicad/footprint'
import { FIND_TEXT_DEFAULTS, findHits } from '../../canvasFind'
import { footprintFindCandidates } from '../footprintFind'

const fp = parseKicadFootprint(`(footprint "T" (layer "F.Cu") (attr smd)
  (property "Reference" "REF**" (at 0 -3 0) (layer "F.SilkS"))
  (property "Value" "SOT-23" (at 0 3 0) (layer "F.Fab"))
  (property "Datasheet" "ds" (at 0 0 0) (layer "F.Fab") hide)
  (fp_text user "\${REFERENCE}" (at 0 1 0) (layer "F.Fab"))
  (pad "1" smd rect (at -1 1) (size 0.5 0.5) (layers "F.Cu"))
  (pad "2" smd rect (at 1 1) (size 0.5 0.5) (layers "F.Cu"))
  (pad "" smd rect (at 0 -1) (size 0.5 0.5) (layers "F.Cu"))
  (pad "3" smd rect (at 0 -1) (size 0.5 0.5) (layers "F.Cu")))`)

const find = (query: string): Array<{ type: string; index: number }> =>
  findHits(footprintFindCandidates(fp), query, FIND_TEXT_DEFAULTS).map((hit) => hit.target)

describe('footprintFindCandidates', () => {
  test('finds pad numbers, in reading order', () => {
    expect(find('1')).toEqual([{ type: 'pad', index: 0 }])
    expect(
      findHits(footprintFindCandidates(fp), '^\\d$', { ...FIND_TEXT_DEFAULTS, regex: true }).map(
        (hit) => hit.text
      )
    ).toEqual(['3', '1', '2'])
  })

  test('finds fields and free texts as stored', () => {
    expect(find('REF')).toEqual([
      { type: 'property', index: 0 },
      { type: 'text', index: 0 }
    ])
    expect(find('SOT')).toEqual([{ type: 'property', index: 1 }])
  })

  test('skips a hidden field and an unnumbered pad', () => {
    expect(find('ds')).toEqual([])
    expect(footprintFindCandidates(fp).filter((c) => c.target.type === 'pad')).toHaveLength(3)
  })
})
