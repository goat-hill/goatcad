import { describe, expect, test } from 'vitest'
import { DEFAULT_DESIGN_RULES, makeNetClass, type NetClass } from '../../../kicad/project'
import type { Rule, RuleItem } from '../constraints'
import { boardSetupRules, netClassRules } from '../implicitRules'
import { ConstraintResolver } from '../resolver'
import { matchDiffPair } from '../diffPairs'

const rules = { ...DEFAULT_DESIGN_RULES, minClearance: 0.1, minCopperHoleClearance: 0.25 }
const defaults: NetClass = { ...makeNetClass('Default'), clearance: 0.2 }
const power: NetClass = { ...makeNetClass('Power'), clearance: 0.4, priority: 0 }
const usb: NetClass = { ...makeNetClass('USB'), clearance: 0.2, diffPairGap: 0.12, priority: 1 }
const netNames = new Set(['GND', 'VBUS', 'USB_P', 'USB_N'])

const track = (netName: string, netClass: string, extra: Partial<RuleItem> = {}): RuleItem => ({
  kind: 'track',
  label: `track ${netName}`,
  net: 1,
  netName,
  netClass,
  layers: ['F.Cu'],
  nonCopper: false,
  ...extra
})

const resolverWith = (user: Rule[] = []): ConstraintResolver =>
  new ConstraintResolver(
    [...boardSetupRules(rules), ...netClassRules(rules, [defaults, power, usb], netNames), ...user],
    { minClearance: rules.minClearance, minHoleClearance: rules.minCopperHoleClearance }
  )

const userRule = (
  name: string,
  min: number,
  condition: Rule['condition'] = null,
  layers: Rule['layers'] = null
): Rule => ({
  name: `rule '${name}'`,
  implicit: null,
  layers,
  condition,
  constraints: new Map([['clearance', { min }]])
})

describe('clearance', () => {
  test('a pair in two classes keeps the larger class clearance, named for it', () => {
    const resolved = resolverWith().evaluate(
      'clearance',
      track('GND', 'Default'),
      track('VBUS', 'Power'),
      'F.Cu'
    )
    expect(resolved.value.min).toBe(0.4)
    expect(resolved.name).toBe("netclass 'Power'")
  })

  test("the halves of a pair may sit at their class's pair gap", () => {
    const resolved = resolverWith().evaluate(
      'clearance',
      track('USB_P', 'USB'),
      track('USB_N', 'USB'),
      'F.Cu'
    )
    expect(resolved.value.min).toBe(0.12)
    expect(resolved.name).toBe("netclass 'USB' (diff pair)")
  })

  test("a pad's own clearance wins over every rule, floored at the board minimum", () => {
    const resolver = resolverWith([userRule('wide', 1)])
    const pad = track('GND', 'Default', {
      kind: 'pad',
      clearanceOverride: { value: 0.05, source: 'R1.1 clearance' }
    })
    const floored = resolver.evaluate('clearance', pad, track('VBUS', 'Power'), 'F.Cu')
    expect(floored.value.min).toBe(0.1)
    expect(floored.name).toBe('board minimum')
    const own = { ...pad, clearanceOverride: { value: 0.6, source: 'R1.1 clearance' } }
    expect(resolver.evaluate('clearance', own, track('VBUS', 'Power'), 'F.Cu').value.min).toBe(0.6)
  })

  test('a zero override is no override', () => {
    const pad = track('GND', 'Default', {
      kind: 'pad',
      clearanceOverride: { value: 0, source: 'R1.1 clearance' }
    })
    expect(resolverWith().evaluate('clearance', pad, track('VBUS', 'Power'), 'F.Cu').name).toBe(
      "netclass 'Power'"
    )
  })

  test("a zone's own clearance is maxed in after the rules", () => {
    const zone = track('GND', 'Default', {
      kind: 'zone',
      localClearance: { value: 0.5, source: 'zone GND clearance' }
    })
    const resolved = resolverWith().evaluate('clearance', zone, track('VBUS', 'Power'), 'F.Cu')
    expect(resolved.value.min).toBe(0.5)
    expect(resolved.name).toBe('zone GND clearance')
  })

  test('a user rule overrides the classes, and is not floored at the board minimum', () => {
    const narrow = userRule('narrow', 0.05, ({ a }) => a.netName === 'VBUS')
    const resolved = resolverWith([narrow]).evaluate(
      'clearance',
      track('GND', 'Default'),
      track('VBUS', 'Power'),
      'F.Cu'
    )
    expect(resolved.value.min).toBe(0.05)
    expect(resolved.name).toBe("rule 'narrow'")
  })

  test('a condition holds for the pair either way round', () => {
    const rule = userRule('pair', 0.9, ({ a, b }) => a.netName === 'GND' && b?.netName === 'VBUS')
    const resolver = resolverWith([rule])
    expect(
      resolver.evaluate('clearance', track('VBUS', 'Power'), track('GND', 'Default'), 'F.Cu').value
        .min
    ).toBe(0.9)
  })

  test('a rule on other layers is passed over, and the explain trail says so', () => {
    const inner = userRule('inner', 0.9, null, new Set(['In1.Cu']))
    const resolved = resolverWith([inner]).evaluate(
      'clearance',
      track('GND', 'Default'),
      track('VBUS', 'Power'),
      'F.Cu',
      true
    )
    expect(resolved.value.min).toBe(0.4)
    expect(resolved.trail).toContainEqual({ rule: "rule 'inner'", outcome: 'layer-mismatch' })
  })

  test('the last user rule to match wins', () => {
    const resolved = resolverWith([userRule('first', 0.7), userRule('second', 0.3)]).evaluate(
      'clearance',
      track('GND', 'Default'),
      track('VBUS', 'Power'),
      'F.Cu'
    )
    expect(resolved.value.min).toBe(0.3)
  })

  test('a net tie makes the nets it joins 0 apart', () => {
    const pad = track('GND', 'Default', { kind: 'pad', netTies: new Set([2]) })
    const other = track('VBUS', 'Power', { net: 2 })
    const resolved = resolverWith().evaluate('clearance', pad, other, 'F.Cu')
    expect(resolved.value.min).toBe(0)
    expect(resolved.name).toBe('net tie')
  })

  test('clearance never applies to an item on no copper', () => {
    const silk = track('', '', { kind: 'graphic', nonCopper: true })
    const resolved = resolverWith([userRule('any', 2)]).evaluate(
      'clearance',
      silk,
      track('GND', 'Default'),
      'F.Cu'
    )
    expect(resolved.value.min).toBeUndefined()
  })
})

describe('sizes', () => {
  test("a track's width is held to the board minimum, with its class's width preferred", () => {
    const resolved = resolverWith().evaluate('track_width', track('VBUS', 'Power'), null, 'F.Cu')
    expect(resolved.value.min).toBe(rules.minTrackWidth)
    expect(resolved.value.opt).toBe(power.trackWidth)
    expect(resolved.implicitMin).toBe(true)
  })

  test("a micro-via is held to the class's micro-via diameter as its min", () => {
    const via = track('GND', 'Default', { kind: 'via', viaType: 'micro' })
    const resolved = resolverWith().evaluate('via_diameter', via, null, null)
    expect(resolved.value.min).toBe(defaults.microviaDiameter)
  })

  test('courtyards may not touch, and nothing more', () => {
    const fp = track('', '', { kind: 'footprint', net: undefined })
    const resolved = resolverWith().evaluate('courtyard_clearance', fp, fp, 'F.Cu')
    expect(resolved.isNull).toBe(false)
    expect(resolved.value.min).toBeUndefined()
  })
})

describe('matchDiffPair', () => {
  test('reads the polarity past trailing digits and underscores', () => {
    expect(matchDiffPair('/USB_P')?.complement).toBe('/USB_N')
    expect(matchDiffPair('DATA-')?.complement).toBe('DATA+')
    expect(matchDiffPair('CLK_N_1')?.complement).toBe('CLK_P_1')
    expect(matchDiffPair('GND')).toBeNull()
  })
})
