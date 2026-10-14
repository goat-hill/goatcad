import { describe, expect, test } from 'vitest'
import {
  activeFindings,
  applyExclusions,
  exclusionMatches,
  extractExclusions,
  parseExclusion
} from '../kicadExclusions'
import type { RuleOf } from '../ruleSeverity'
import type { CheckResult } from '../schematic/checks'

const A = '11659109-eea0-488c-af3a-a134aa53be7b'
const B = '86b7aa3e-5fae-4956-9584-486046f4c3e7'
const C = 'e230c5a8-92bf-4d40-a3da-f37e567e2181'
const NIL = '00000000-0000-0000-0000-000000000000'

const finding = (code: string, kicadIds: string[], sheetPath?: string): CheckResult => ({
  code,
  severity: 'error',
  message: code,
  items: kicadIds,
  kicadIds,
  ...(sheetPath ? { sheetPath } : {})
})

const KEYS: Record<string, string> = {
  'courtyards-overlap': 'courtyards_overlap',
  'via-dangling': 'via_dangling',
  'unconnected-pin': 'pin_not_connected'
}
const ruleOf: RuleOf = (code) => (KEYS[code] ? { key: KEYS[code] } : undefined)

describe('KiCad exclusions', () => {
  test('both on-disk forms parse, nil ids dropped and an ERC sheet path kept', () => {
    const project = JSON.stringify({
      board: {
        design_settings: {
          drc_exclusions: [
            [`courtyards_overlap|100221000|45955000|${A}|${B}`, 'Intentional Overlap'],
            `via_dangling|1|2|${C}|${NIL}`
          ]
        }
      },
      erc: { erc_exclusions: [[`pin_not_connected|1|2|${A}|${NIL}|/${B}|/${B}|`, 'comment1']] }
    })
    expect(extractExclusions(project, 'drc')).toEqual([
      {
        raw: `courtyards_overlap|100221000|45955000|${A}|${B}`,
        key: 'courtyards_overlap',
        ids: [A, B],
        comment: 'Intentional Overlap'
      },
      { raw: `via_dangling|1|2|${C}|${NIL}`, key: 'via_dangling', ids: [C], comment: '' }
    ])
    expect(extractExclusions(project, 'erc')[0]).toMatchObject({
      key: 'pin_not_connected',
      ids: [A],
      sheetPath: `/${B}`,
      comment: 'comment1'
    })
    expect(extractExclusions('not json', 'drc')).toEqual([])
  })

  test('a finding is excluded by its rule and items, whatever the marker position', () => {
    const exclusions = extractExclusions(
      JSON.stringify({
        board: {
          design_settings: {
            drc_exclusions: [
              [`courtyards_overlap|0|0|${A}|${B}`, 'ok'],
              `via_dangling|9|9|${C}|${NIL}`
            ]
          }
        }
      }),
      'drc'
    )
    const results = applyExclusions(
      [
        finding('courtyards-overlap', [B, A]),
        finding('courtyards-overlap', [A, C]),
        finding('via-dangling', [C]),
        finding('via-dangling', [A])
      ],
      exclusions,
      ruleOf
    )
    expect(results.map((result) => result.excluded?.comment ?? null)).toEqual([
      'ok',
      null,
      '',
      null
    ])
    expect(activeFindings(results)).toHaveLength(2)
    expect(exclusionMatches(results).get(`via_dangling|9|9|${C}|${NIL}`)).toBe(1)
  })

  test('a finding naming fewer items than KiCad does still matches, as an edge clearance does', () => {
    const exclusion = parseExclusion(`via_dangling|0|0|${C}|${A}`)!
    expect(
      applyExclusions([finding('via-dangling', [C])], [exclusion], ruleOf)[0].excluded
    ).toBeTruthy()
  })

  test('an exclusion on another sheet instance, or naming no item, matches nothing', () => {
    const onOther = parseExclusion(`pin_not_connected|0|0|${A}|${NIL}|/${B}|/${B}|`)!
    const positionOnly = parseExclusion(`pin_not_connected|0|0|F.Cu|0|${NIL}|${NIL}`)!
    expect(positionOnly.ids).toEqual([])
    const results = applyExclusions(
      [finding('unconnected-pin', [A], `/${C}`)],
      [onOther, positionOnly],
      ruleOf
    )
    expect(results[0].excluded).toBeUndefined()
    expect(
      applyExclusions([finding('unconnected-pin', [A], `/${B}`)], [onOther], ruleOf)[0].excluded
    ).toBeTruthy()
  })
})
