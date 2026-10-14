import { describe, expect, test } from 'vitest'
import { applySeverities, effectiveSeverity, type RuleOf } from '../ruleSeverity'
import type { CheckResult } from '../schematic/checks'
import { DRC_CATALOG, DRC_INTERNAL_KEYS } from '../board/drcCatalog'
import { BOARD_KICAD_KEYS } from '../board/boardChecks'
import { ERC_CATALOG, ercRuleOf } from '../schematic/ercCatalog'
import { ERC_KICAD_KEYS } from '../schematic/checks'

const finding = (code: string, severity: CheckResult['severity']): CheckResult => ({
  code,
  severity,
  message: code,
  items: [code]
})

const ruleOf: RuleOf = (code) =>
  code === 'a' ? { key: 'rule_a' } : code === 'g' ? { key: 'rule_g', graded: true } : undefined

describe('applySeverities', () => {
  test('ignore drops, a setting re-ranks, no setting keeps the engine severity', () => {
    const results = [finding('a', 'error'), finding('g', 'error'), finding('x', 'warning')]
    expect(applySeverities(results, ruleOf, {})).toEqual(results)
    expect(applySeverities(results, ruleOf, { rule_a: 'ignore' }).map((r) => r.code)).toEqual([
      'g',
      'x'
    ])
    expect(applySeverities(results, ruleOf, { rule_a: 'warning' })[0].severity).toBe('warning')
  })

  test('a graded rule keeps its per-finding severity unless ignored', () => {
    const results = [finding('g', 'error'), finding('g', 'warning')]
    expect(applySeverities(results, ruleOf, { rule_g: 'warning' })).toEqual(results)
    expect(applySeverities(results, ruleOf, { rule_g: 'ignore' })).toEqual([])
  })

  test('an ERC conflict turned off in the project is gone; the matrix grades the rest', () => {
    const results = [finding('pin-conflict', 'error')]
    expect(applySeverities(results, ercRuleOf, { pin_to_pin: 'warning' })).toEqual(results)
    expect(applySeverities(results, ercRuleOf, { pin_to_pin: 'ignore' })).toEqual([])
  })
})

describe('the rule catalogs', () => {
  test.each([
    ['DRC', DRC_CATALOG, BOARD_KICAD_KEYS, DRC_INTERNAL_KEYS],
    ['ERC', ERC_CATALOG, ERC_KICAD_KEYS, new Set<string>()]
  ] as const)(
    '%s lists each KiCad key once and every engine code under its key',
    (_, catalog, keys, internal) => {
      const listed = catalog.map((rule) => rule.key)
      expect(new Set(listed).size).toBe(listed.length)
      for (const [code, key] of Object.entries(keys)) {
        // KiCad's internal findings have no severity to list.
        if (internal.has(key)) continue
        expect(catalog.find((rule) => rule.key === key)?.codes).toContain(code)
      }
    }
  )

  test("a rule's severity is the project's, else KiCad's default", () => {
    const rule = DRC_CATALOG.find((entry) => entry.key === 'hole_to_hole')!
    expect(effectiveSeverity(rule, {})).toBe('warning')
    expect(effectiveSeverity(rule, { hole_to_hole: 'error' })).toBe('error')
  })
})
