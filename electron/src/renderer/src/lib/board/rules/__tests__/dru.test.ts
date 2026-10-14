import { describe, expect, test } from 'vitest'
import type { ConditionContext, RuleItem } from '../constraints'
import { compileCondition, evaluateNumber, type RuleEnvironment } from '../expression'
import { parseRules } from '../dru'
import { wildcard } from '../diffPairs'

const LAYERS = ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu', 'F.SilkS', 'B.SilkS', 'Edge.Cuts'].map(
  (name) => ({ name, userName: name === 'F.SilkS' ? 'F.Silkscreen' : undefined })
)
const env: RuleEnvironment = {
  layersMatching: (pattern) =>
    new Set(
      LAYERS.filter(
        (l) => wildcard(pattern, l.name) || (!!l.userName && wildcard(pattern, l.userName))
      ).map((l) => l.name)
    ),
  netNames: new Set(['GND', 'USB_P', 'USB_N'])
}

const item = (extra: Partial<RuleItem>): RuleItem => ({
  kind: 'track',
  label: 'track',
  net: 1,
  netName: 'GND',
  netClass: 'Default',
  layers: ['F.Cu'],
  nonCopper: false,
  ...extra
})

const holds = (source: string, a: RuleItem, b: RuleItem | null = null, layer = 'F.Cu'): boolean => {
  const context: ConditionContext = { a, b, layer, type: 'clearance' }
  return compileCondition(source, env).test(context)
}

describe('conditions', () => {
  test('strings compare without regard to case, and as wildcards on the right', () => {
    expect(holds("A.NetName == 'gnd'", item({}))).toBe(true)
    expect(holds("A.NetName == 'G*'", item({}))).toBe(true)
    expect(holds("A.Type == 'track'", item({}))).toBe(true)
    expect(holds("A.Type == 'Via'", item({}))).toBe(false)
  })

  test('|| binds tighter than &&', () => {
    // a && b || c reads a && (b || c): false && … is false whatever c is.
    expect(holds("A.Type == 'Via' && A.NetName == 'X' || A.NetName == 'GND'", item({}))).toBe(false)
  })

  test('an undefined property is neither equal nor unequal', () => {
    // A track has no via type: both comparisons are false.
    expect(holds("A.Via_Type == 'Micro'", item({}))).toBe(false)
    expect(holds("A.Via_Type != 'Micro'", item({}))).toBe(false)
    expect(holds("A.Via_Type != 'Micro'", item({ kind: 'via', viaType: 'through' }))).toBe(true)
  })

  test('a layer compares as a pattern over canonical and user names', () => {
    expect(holds("A.Layer == 'F.Cu'", item({}))).toBe(true)
    expect(holds("A.Layer == '*.Cu'", item({}))).toBe(true)
    expect(holds("A.Layer == 'F.Silkscreen'", item({ layers: ['F.SilkS'] }))).toBe(true)
    expect(holds("A.existsOnLayer('In*')", item({ layers: ['In2.Cu'] }))).toBe(true)
  })

  test('a net class equals any of its constituents', () => {
    const composite = item({ netClass: 'Fast,Default' })
    expect(holds("A.NetClass == 'Fast'", composite)).toBe(true)
    expect(holds("A.NetClass == 'Fast,Default'", composite)).toBe(true)
    expect(holds("A.hasNetclass('Fa*')", composite)).toBe(true)
    expect(holds("A.hasExactNetclass('Fast')", composite)).toBe(false)
  })

  test('two items on one net compare equal by net', () => {
    expect(holds('A.NetName == B.NetName', item({}), item({ net: 1 }))).toBe(true)
    expect(holds('A.NetName == B.NetName', item({}), item({ net: 2, netName: 'GND' }))).toBe(false)
  })

  test('numbers carry their units, apart or together', () => {
    const wide = item({ property: (name) => (name === 'width' ? 0.254 : undefined) })
    expect(holds('A.Width >= 10mil', wide)).toBe(true)
    expect(holds('A.Width > 0.3 mm', wide)).toBe(false)
  })

  test('the differential-pair functions read the net names', () => {
    const p = item({ netName: 'USB_P' })
    const n = item({ netName: 'USB_N' })
    expect(holds("A.inDiffPair('USB')", p)).toBe(true)
    expect(holds('AB.isCoupledDiffPair()', p, n)).toBe(true)
    expect(holds('AB.isCoupledDiffPair()', p, item({}))).toBe(false)
  })

  test('an unterminated string runs to the end, as KiCad reads it', () => {
    expect(holds("A.NetName == 'GND", item({}))).toBe(true)
  })

  test('only a space separates tokens; a tab is an error', () => {
    expect(() => compileCondition("A.Type ==\t'Via'", env)).toThrow()
  })

  test('an empty condition holds', () => {
    expect(holds('', item({}))).toBe(true)
  })

  test('names it does not read are listed, and read as undefined', () => {
    const compiled = compileCondition("A.notAFunction('U1-1')", env)
    expect(compiled.unsupported).toEqual(['notAFunction()'])
  })
})

describe('values', () => {
  test('units convert to millimeters and arithmetic works', () => {
    expect(evaluateNumber('0.2mm')).toBeCloseTo(0.2, 12)
    expect(evaluateNumber('10mil')).toBeCloseTo(0.254, 12)
    expect(evaluateNumber('0.1mm + 2mil')).toBeCloseTo(0.1508, 12)
  })

  test('a lone number without a unit is an error', () => {
    expect(() => evaluateNumber('0.2')).toThrow(/Missing units/)
  })
})

describe('the rule file', () => {
  const read = (text: string): ReturnType<typeof parseRules> => parseRules(text, env, LAYERS)

  test('reads a rule with its condition, layer, severity and constraints', () => {
    const { rules, errors } = read(`(version 1)
# a comment
(rule "HV"
  (layer outer)
  (condition "A.NetName == 'GND'")
  (constraint clearance (min 1.5mm))
  (constraint track_width (min 0.3mm) (opt 0.5mm))
  (severity warning))`)
    expect(errors).toEqual([])
    expect(rules).toHaveLength(1)
    const [rule] = rules
    expect(rule.name).toBe("rule 'HV'")
    expect([...(rule.layers ?? [])]).toEqual(['F.Cu', 'B.Cu'])
    expect(rule.severity).toBe('warning')
    expect(rule.constraints.get('clearance')).toEqual({ min: 1.5 })
    expect(rule.constraints.get('track_width')?.opt).toBeCloseTo(0.5, 12)
  })

  test('a layer clause is a wildcard over every layer KiCad names, `inner` the inner copper', () => {
    const { rules, errors } = read(`(version 1)
(rule a (layer "In*.Cu") (constraint clearance (min 1mm)))
(rule b (layer inner) (constraint clearance (min 1mm)))
(rule c (layer "In30.Cu") (constraint clearance (min 1mm)))
(rule d (layer "F.Silkscreen") (constraint silk_clearance (min 1mm)))`)
    expect(errors).toEqual([])
    expect(rules[0].layers?.has('In2.Cu')).toBe(true)
    expect(rules[1].layers?.has('In30.Cu')).toBe(true)
    // A layer the board lacks is no error: the rule matches nothing there.
    expect([...(rules[2].layers ?? [])]).toEqual(['In30.Cu'])
    // A user name reaches its layer.
    expect(rules[3].layers?.has('F.SilkS')).toBe(true)
  })

  test('a file of comments only is empty, not an error', () => {
    expect(read('# nothing yet\n# at all')).toEqual({ rules: [], errors: [], unsupported: [] })
  })

  test('disallow reads its kinds as flags, `via` meaning every via', () => {
    const { rules } = read(`(version 1)
(rule keep (constraint disallow track via))`)
    expect(rules[0].constraints.get('disallow')?.disallow).toBeGreaterThan(0)
  })

  test('any error sets the whole file aside', () => {
    const missingVersion = read(`(rule a (constraint clearance (min 1mm)))`)
    expect(missingVersion.rules).toEqual([])
    expect(missingVersion.errors[0]).toMatch(/version/)
    const duplicate = read(`(version 1)
(rule a (constraint clearance (min 1mm)) (constraint clearance (min 2mm)))
(rule b (constraint clearance (min 1mm)))`)
    expect(duplicate.rules).toEqual([])
    expect(duplicate.errors[0]).toMatch(/already has a 'clearance'/)
  })

  test('the old constraint names still read', () => {
    const { rules } = read(`(version 1)
(rule a (constraint hole (min 0.3mm)) (constraint mechanical_clearance (min 1mm)))`)
    expect(rules[0].constraints.has('hole_size')).toBe(true)
    expect(rules[0].constraints.has('physical_clearance')).toBe(true)
  })
})
