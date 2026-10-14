import { describe, expect, test } from 'vitest'
import {
  documentFindings,
  findingMarks,
  groupFindings,
  measureValue,
  healthCounts,
  ruleTitle,
  schematicFindings,
  titledRules,
  type HealthFinding
} from '../designHealth'
import { CHECK_RULES, type CheckResult } from '../schematic/checks'
import { FOOTPRINT_CHECK_RULES } from '../footprint/footprintChecks'
import { SYMBOL_CHECK_RULES } from '../symbol/symbolChecks'
import { BOARD_CHECK_RULES } from '../board/boardChecks'

const result = (overrides: Partial<CheckResult>): CheckResult => ({
  code: 'unconnected-pin',
  severity: 'error',
  message: 'm',
  items: [],
  ...overrides
})

const finding = (overrides: Partial<HealthFinding>): HealthFinding => ({
  key: 'k',
  code: 'unconnected-pin',
  severity: 'error',
  subject: 's',
  place: null,
  ...overrides
})

describe('rule titles', () => {
  test('every rule an engine runs has a name for a person', () => {
    const engines = [
      ...Object.keys(CHECK_RULES),
      ...Object.keys(FOOTPRINT_CHECK_RULES),
      ...Object.keys(SYMBOL_CHECK_RULES),
      ...Object.keys(BOARD_CHECK_RULES)
    ]
    expect(engines.filter((code) => ruleTitle(code) === null)).toEqual([])
    expect(titledRules().sort()).toEqual([...new Set(engines)].sort())
  })
})

describe('counts', () => {
  test('counts errors and warnings apart', () => {
    const findings = [
      finding({ key: 'a' }),
      finding({ key: 'b', severity: 'warning' }),
      finding({ key: 'c' })
    ]
    expect(healthCounts(findings)).toEqual({ errors: 2, warnings: 1 })
  })
})

describe('grouping', () => {
  test('one group per rule, errors first, then by rule', () => {
    const groups = groupFindings([
      finding({ key: 'a', code: 'off-grid', severity: 'warning' }),
      finding({ key: 'b', code: 'unconnected-pin' }),
      finding({ key: 'c', code: 'conflicting-drivers' }),
      finding({ key: 'd', code: 'off-grid', severity: 'warning' })
    ])
    expect(groups.map((group) => group.code)).toEqual([
      'conflicting-drivers',
      'unconnected-pin',
      'off-grid'
    ])
    expect(groups[2].findings.map((entry) => entry.key)).toEqual(['a', 'd'])
  })

  test('a rule that is an error anywhere leads as an error', () => {
    const [group] = groupFindings([
      finding({ key: 'a', code: 'symbol-library-mismatch', severity: 'warning' }),
      finding({ key: 'b', code: 'symbol-library-mismatch', severity: 'error' })
    ])
    expect(group.severity).toBe('error')
  })

  test('groups by title as read; within one, errors, then the root sheet, sheets and subjects in natural order', () => {
    const titles: Record<string, string> = { b: 'Alpha', a: 'Beta' }
    expect(
      groupFindings(
        [finding({ key: '1', code: 'a' }), finding({ key: '2', code: 'b' })],
        (code) => titles[code]
      ).map((group) => group.code)
    ).toEqual(['b', 'a'])
    const [group] = groupFindings([
      finding({ key: 'power-r10', place: '/Power', subject: 'R10' }),
      finding({ key: 'power-r2', place: '/Power', subject: 'R2' }),
      finding({ key: 'root-warn', subject: 'R1', severity: 'warning' }),
      finding({ key: 'io-r1', place: '/IO', subject: 'R1' }),
      finding({ key: 'root-r3', subject: 'R3' })
    ])
    expect(group.findings.map((entry) => entry.key)).toEqual([
      'root-r3',
      'io-r1',
      'power-r2',
      'power-r10',
      'root-warn'
    ])
  })
})

describe('schematic findings', () => {
  const names = new Map([
    ['/root', '/'],
    ['/root/child', '/Power']
  ])

  test('every finding off the root names its sheet, whichever sheet is on screen', () => {
    const [root, child] = schematicFindings(
      [
        result({ items: ['U1.1'], sheetPath: '/root', subject: 'U1.1' }),
        result({ items: ['U2.1'], sheetPath: '/root/child', subject: 'U2.1' })
      ],
      names
    )
    expect(root.place).toBeNull()
    expect(child.place).toBe('/Power')
  })

  test('a finding with nothing to name is listed by where it is', () => {
    const [entry] = schematicFindings(
      [result({ code: 'unconnected-wire-end', position: { x: 10, y: 20 }, sheetPath: '/root' })],
      names
    )
    expect(entry.subject).toBe('(10, 20)')
  })

  test('keys are unique and stable across runs of the same input', () => {
    const results = [
      result({ code: 'unconnected-wire-end', position: { x: 1, y: 1 }, sheetPath: '/root' }),
      result({ code: 'unconnected-wire-end', position: { x: 1, y: 1 }, sheetPath: '/root' }),
      result({ code: 'unconnected-wire-end', position: { x: 2, y: 1 }, sheetPath: '/root' })
    ]
    const keys = schematicFindings(results, names).map((entry) => entry.key)
    expect(new Set(keys).size).toBe(3)
    expect(schematicFindings(results, names).map((entry) => entry.key)).toEqual(keys)
  })
})

describe('footprint findings', () => {
  test('list by the items they name, all on the one footprint', () => {
    const [entry] = documentFindings([result({ code: 'pads-overlap', items: ['pad:1', 'pad:2'] })])
    expect(entry.subject).toBe('pad:1, pad:2')
    expect(entry.place).toBeNull()
  })

  test('name their subject as it reads, its markup dropped', () => {
    const [entry] = documentFindings([
      result({ code: 'copper-clearance', subject: 'track /M.2/PCIe_{C1x1}.TX0+ · zone ~{RST}' })
    ])
    expect(entry.subject).toBe('track /M.2/PCIeC1x1.TX0+ · zone RST')
  })
})

describe('findingMarks', () => {
  test('one marker per finding with a place, none for one a KiCad exclusion names', () => {
    const results = [
      result({ position: { x: 1, y: 2 } }),
      result({ severity: 'warning', position: { x: 3, y: 4 }, items: ['b'] }),
      result({ items: ['c'] }),
      result({ position: { x: 5, y: 6 }, items: ['d'], excluded: { comment: '', exclusion: '' } })
    ]
    const findings = documentFindings(results)
    expect(findingMarks(results, findings)).toEqual([
      { key: findings[0].key, x: 1, y: 2, severity: 'error' },
      { key: findings[1].key, x: 3, y: 4, severity: 'warning' }
    ])
    expect(findingMarks(results, findings, () => ({ x: 0, y: 0 }))).toHaveLength(3)
  })
})

describe("a row's numbers", () => {
  test('carry the measure and the detail; values print short, in their unit', () => {
    const measure = { actual: 0.15, limit: 0.2, bound: 'min' as const, unit: 'mm' as const }
    const [finding] = documentFindings([result({ measure, detail: 'GND · VCC' })])
    expect(finding).toMatchObject({ measure, detail: 'GND · VCC' })
    expect(measureValue(0.149999999, 'mm')).toBe('0.15 mm')
    expect(measureValue(30.04, 'deg')).toBe('30°')
    expect(measureValue(2, 'count')).toBe('2')
    expect(measureValue(12.5, 'ps')).toBe('12.5 ps')
  })
})
