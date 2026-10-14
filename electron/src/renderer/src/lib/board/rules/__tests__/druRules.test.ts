import { describe, expect, test } from 'vitest'
import { patchRules, ruleNamesIn, ruleTextIn, type DruRule } from '../druRules'
import { parseRules } from '../dru'

const parseDru = (text: string): ReturnType<typeof parseRules> =>
  parseRules(text, { layersMatching: () => new Set<string>(), netNames: new Set<string>() }, [
    { name: 'F.Cu' }
  ])

const skew: DruRule = {
  name: 'USB skew within pairs',
  condition: "A.NetClass == 'USB'",
  constraints: ['(constraint skew (max 5ps) (within_diff_pairs))']
}
const vias: DruRule = {
  name: 'USB via count',
  condition: "A.NetClass == 'USB'",
  constraints: ['(constraint via_count (max 4))']
}

const USER = `(version 1)
# the user's own
(rule "HV"
\t(condition "A.NetClass == 'HV'")
\t(constraint clearance (min 1.5mm)))
`

describe("a class's rules, written by name", () => {
  test("a new file starts with KiCad's version and holds only KiCad's syntax", () => {
    const text = patchRules(undefined, [skew.name], [skew])
    expect(text.startsWith('(version 1)\n\n(rule "USB skew within pairs"')).toBe(true)
    expect(text).not.toContain('#')
    expect(parseDru(text).errors).toEqual([])
  })

  test("writing again replaces the rule in place; the user's rules and comments stay", () => {
    const once = patchRules(USER, [skew.name, vias.name], [skew, vias])
    expect(once.startsWith(USER)).toBe(true)
    const twice = patchRules(
      once,
      [skew.name, vias.name],
      [{ ...skew, constraints: ['(constraint skew (max 4ps) (within_diff_pairs))'] }, vias]
    )
    expect(twice).toBe(once.replace('5ps', '4ps'))
    expect(ruleNamesIn(twice)).toEqual(['HV', 'USB skew within pairs', 'USB via count'])
  })

  test('a rule no longer written goes with its line; nothing to write leaves the file', () => {
    const once = patchRules(USER, [skew.name, vias.name], [skew, vias])
    const fewer = patchRules(once, [skew.name, vias.name], [skew])
    expect(ruleNamesIn(fewer)).toEqual(['HV', 'USB skew within pairs'])
    expect(ruleTextIn(fewer, 'USB via count')).toBeNull()
    expect(patchRules(USER, [skew.name], [])).toBe(USER)
    expect(parseDru(fewer).errors).toEqual([])
  })
})
