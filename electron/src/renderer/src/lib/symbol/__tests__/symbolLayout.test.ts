import { describe, expect, test } from 'vitest'
import {
  planSymbol,
  sideForGroup,
  slotOffsets,
  symbolTextBoxes,
  TEXT_CLEARANCE,
  textViolations,
  textWidth,
  type SymbolGroupSpec,
  type SymbolLayout,
  type SymbolPinSpec
} from '../symbolLayout'
import { nmToMm } from '../../kicad/coordinates'

const MM = 1_000_000
/** Spacings here are authored in mil, as the layout's own constants are. */
const MIL = 25_400

/** The real SCD4x pin table, read off page 5 of the manufacturer's datasheet —
 *  21 pads, of which a human drew 7. This is the case the whole spec is
 *  calibrated against. */
const SCD4X_GROUPS: SymbolGroupSpec[] = [
  { id: 'pwr', role: 'power' },
  { id: 'gnd', role: 'ground' },
  { id: 'i2c', role: 'signal' }
]
const SCD4X_PINS: SymbolPinSpec[] = [
  ...[1, 2, 3, 4, 5, 8, 11, 12, 13, 14, 15, 16, 17, 18].map((n) => ({
    number: String(n),
    name: 'DNC',
    type: 'no_connect' as const,
    group: 'gnd',
    omit: true
  })),
  { number: '7', name: 'VDD', type: 'power_in', group: 'pwr' },
  // VDDH is drawn as VDD, stacked: the datasheet says it must be tied there.
  { number: '19', name: 'VDD', type: 'power_in', group: 'pwr', stackWith: '7' },
  { number: '6', name: 'GND', type: 'power_in', group: 'gnd' },
  { number: '20', name: 'GND', type: 'power_in', group: 'gnd', stackWith: '6' },
  { number: '21', name: 'GND', type: 'power_in', group: 'gnd', stackWith: '6' },
  { number: '9', name: 'SCL', type: 'input', group: 'i2c' },
  { number: '10', name: 'SDA', type: 'bidirectional', group: 'i2c' }
]

const plan = (groups = SCD4X_GROUPS, pins = SCD4X_PINS): SymbolLayout => {
  const result = planSymbol(groups, pins)
  if (!result.ok) throw new Error(`expected a layout, got ${result.error}`)
  return result.layout
}

const pinOf = (layout: SymbolLayout, number: string): (typeof layout.pins)[number] =>
  layout.pins.find((pin) => pin.number === number)!

describe('slot offsets', () => {
  test('keep every pin on the 2.54 mm grid, including even counts', () => {
    // The naive centring of an even count lands on 1.27 offsets — off the grid a
    // wire has to meet. This is the bug that rule prevents.
    for (const count of [1, 2, 3, 4, 5, 8, 17]) {
      for (const offset of slotOffsets(count)) {
        // Math.abs because JS gives -0 for a negative exact multiple, and
        // Object.is distinguishes it from +0. The claim is divisibility.
        expect(Math.abs(offset % (2.54 * MM))).toBe(0)
      }
    }
  })

  test('space pins one pitch apart, top to bottom', () => {
    expect(slotOffsets(3).map((o) => o / MM)).toEqual([2.54, 0, -2.54])
    // Two pins bias toward the top, which is what the library's own SCD40 does.
    expect(slotOffsets(2).map((o) => o / MM)).toEqual([2.54, 0])
  })

  test('return nothing for an empty side', () => {
    expect(slotOffsets(0)).toEqual([])
  })
})

describe('side assignment', () => {
  const signal = (types: SymbolPinSpec['type'][]): SymbolPinSpec[] =>
    types.map((type, i) => ({ number: String(i), name: `P${i}`, type, group: 'g' }))

  test('places power and ground by ROLE, never by type', () => {
    // KiCad has no ground type: VDD and GND are both power_in. Keying on type
    // would scatter rails and grounds around the box.
    expect(sideForGroup('power', signal(['power_in']))).toBe('top')
    expect(sideForGroup('ground', signal(['power_in']))).toBe('bottom')
  })

  test('sends a mostly-input group left and everything else right', () => {
    expect(sideForGroup('signal', signal(['input', 'input', 'output']))).toBe('left')
    expect(sideForGroup('signal', signal(['output', 'output']))).toBe('right')
  })

  test('sends a bidirectional group right, every time', () => {
    // 39/60 in the library is not a preference to approximate, it is the
    // absence of a rule — so the house style picks one and always picks it.
    expect(sideForGroup('signal', signal(['bidirectional', 'bidirectional']))).toBe('right')
    expect(sideForGroup('signal', signal(['input', 'bidirectional']))).toBe('right')
  })
})

describe('row order', () => {
  test('top and bottom rows read left to right in the order the table gives', () => {
    const groups: SymbolGroupSpec[] = [
      { id: 'core', role: 'power' },
      { id: 'io', role: 'power' },
      { id: 'gnd', role: 'ground' },
      { id: 'bus', role: 'signal' }
    ]
    const layout = plan(groups, [
      { number: '1', name: 'VBAT', type: 'power_in', group: 'core' },
      { number: '2', name: 'VDDSW', type: 'power_in', group: 'core' },
      { number: '3', name: 'DVDD', type: 'power_in', group: 'core' },
      { number: '4', name: 'VIO', type: 'power_in', group: 'io' },
      { number: '5', name: 'GND', type: 'power_in', group: 'gnd' },
      { number: '6', name: 'AGND', type: 'power_in', group: 'gnd' },
      { number: '7', name: 'SCL', type: 'input', group: 'bus' }
    ])
    const row = (side: 'top' | 'bottom'): string[] =>
      layout.pins
        .filter((pin) => pin.side === side)
        .sort((a, b) => a.x - b.x)
        .map((pin) => pin.number)
    expect(row('top')).toEqual(['1', '2', '3', '4'])
    expect(row('bottom')).toEqual(['5', '6'])
  })
})

describe('the SCD4x, which is the case this is calibrated against', () => {
  test('draws 7 pins for 21 pads', () => {
    const layout = plan()
    expect(layout.pins).toHaveLength(7)
    expect(layout.omitted).toHaveLength(14)
  })

  test('keeps the I²C bus together on one side', () => {
    // The rule a per-pin policy cannot express: SCL is an input and SDA is
    // bidirectional, so a type-driven layout splits a two-wire bus across the
    // symbol. Grouping beats side.
    const layout = plan()
    expect(pinOf(layout, '9').side).toBe(pinOf(layout, '10').side)
    expect(pinOf(layout, '9').side).toBe('right')
  })

  test('stacks every ground pad on one coordinate', () => {
    const layout = plan()
    const grounds = ['6', '20', '21'].map((n) => pinOf(layout, n))
    expect(new Set(grounds.map((pin) => `${pin.x},${pin.y}`)).size).toBe(1)
    expect(grounds.every((pin) => pin.side === 'bottom')).toBe(true)
  })

  test('leaves exactly one driver on a stacked net', () => {
    // Several power_in pins on one net is what ERC complains about; the
    // library's own SCD40 makes pins 20 and 21 passive for this reason.
    const layout = plan()
    expect(pinOf(layout, '6').type).toBe('power_in')
    expect(pinOf(layout, '20').type).toBe('passive')
    expect(pinOf(layout, '21').type).toBe('passive')
    expect(pinOf(layout, '19').type).toBe('passive')
  })

  test('reports the omissions and stacks, which the drawing cannot show', () => {
    const layout = plan()
    expect(layout.omitted).toContain('1')
    expect(layout.stacks).toEqual(
      expect.arrayContaining([
        { primary: '6', stacked: ['20', '21'] },
        { primary: '7', stacked: ['19'] }
      ])
    )
  })

  test('puts the rail on top and the ground on the bottom', () => {
    const layout = plan()
    expect(pinOf(layout, '7').side).toBe('top')
    expect(pinOf(layout, '6').side).toBe('bottom')
    expect(pinOf(layout, '7').y).toBeGreaterThan(0)
    expect(pinOf(layout, '6').y).toBeLessThan(0)
  })
})

describe('drafting invariants', () => {
  const layouts = (): SymbolLayout[] => [
    plan(),
    plan(SCD4X_GROUPS, [
      { number: '1', name: 'VCC', type: 'power_in', group: 'pwr' },
      { number: '2', name: 'GND', type: 'power_in', group: 'gnd' },
      { number: '3', name: 'IN', type: 'input', group: 'i2c' },
      { number: '4', name: 'OUT', type: 'output', group: 'i2c' },
      { number: '5', name: 'EN', type: 'input', group: 'i2c' }
    ])
  ]

  test('every pin lands on the 2.54 mm grid', () => {
    for (const layout of layouts()) {
      for (const pin of layout.pins) {
        expect(Math.abs(pin.x % (2.54 * MM))).toBe(0)
        expect(Math.abs(pin.y % (2.54 * MM))).toBe(0)
      }
    }
  })

  test('every pin touches the body edge, on the correct side', () => {
    for (const layout of layouts()) {
      for (const pin of layout.pins) {
        // `at` is the free end; the pin runs `length` back to the body.
        if (pin.side === 'left') expect(pin.x + pin.length).toBe(layout.body.minX)
        if (pin.side === 'right') expect(pin.x - pin.length).toBe(layout.body.maxX)
        if (pin.side === 'top') expect(pin.y - pin.length).toBe(layout.body.maxY)
        if (pin.side === 'bottom') expect(pin.y + pin.length).toBe(layout.body.minY)
      }
    }
  })

  test('rotation matches the side, so pins point into the body', () => {
    const expected = { left: 0, right: 180, top: 270, bottom: 90 }
    for (const layout of layouts()) {
      for (const pin of layout.pins) expect(pin.angle).toBe(expected[pin.side])
    }
  })

  test('no two pins share a coordinate unless they are stacked', () => {
    for (const layout of layouts()) {
      const stacked = new Set(layout.stacks.flatMap((s) => [s.primary, ...s.stacked]))
      const positions = new Map<string, string>()
      for (const pin of layout.pins) {
        if (stacked.has(pin.number)) continue
        const key = `${pin.x},${pin.y}`
        expect(positions.has(key)).toBe(false)
        positions.set(key, pin.number)
      }
    }
  })

  test('the body is centered on the origin and has real area', () => {
    for (const layout of layouts()) {
      expect(layout.body.minX).toBe(-layout.body.maxX)
      expect(layout.body.minY).toBe(-layout.body.maxY)
      expect(nmToMm(layout.body.maxX)).toBeGreaterThan(0)
      expect(nmToMm(layout.body.maxY)).toBeGreaterThan(0)
    }
  })

  test('a group never ends up split across two sides', () => {
    for (const layout of layouts()) {
      const sides = new Map<string, string>()
      for (const pin of layout.pins) {
        const seen = sides.get(pin.group)
        if (seen) expect(pin.side).toBe(seen)
        else sides.set(pin.group, pin.side)
      }
    }
  })
})

describe('refusals', () => {
  const refuse = (pins: SymbolPinSpec[], groups = SCD4X_GROUPS): string => {
    const result = planSymbol(groups, pins)
    if (result.ok) throw new Error('expected a refusal')
    return result.error
  }

  test('a pin with no group is refused, not guessed at', () => {
    // The boundary made concrete: GoatCAD never infers semantics, so there is
    // no silent default to audit afterwards.
    expect(
      refuse([
        { number: '1', name: 'VCC', type: 'power_in', group: 'pwr' },
        { number: '2', name: 'GND', type: 'power_in', group: 'gnd' },
        { number: '3', name: 'X', type: 'input', group: '' }
      ])
    ).toBe('unknown-group')
  })

  test('a group the caller never declared is refused', () => {
    expect(
      refuse([
        { number: '1', name: 'VCC', type: 'power_in', group: 'pwr' },
        { number: '2', name: 'GND', type: 'power_in', group: 'gnd' },
        { number: '3', name: 'X', type: 'input', group: 'spi' }
      ])
    ).toBe('unknown-group')
  })

  test('duplicate pad numbers are refused rather than silently overlapping', () => {
    expect(
      refuse([
        { number: '1', name: 'VCC', type: 'power_in', group: 'pwr' },
        { number: '1', name: 'GND', type: 'power_in', group: 'gnd' }
      ])
    ).toBe('duplicate-pin-number')
  })

  test('a pin table with no rails at all is refused', () => {
    // Almost always a partial extraction, and the symbol would look finished.
    expect(
      refuse(
        [
          { number: '1', name: 'A', type: 'input', group: 'i2c' },
          { number: '2', name: 'B', type: 'output', group: 'i2c' }
        ],
        [{ id: 'i2c', role: 'signal' }]
      )
    ).toBe('no-power-pins')
  })

  test('a stack pointing at nothing, at itself, or round in a circle', () => {
    const base: SymbolPinSpec[] = [
      { number: '1', name: 'VCC', type: 'power_in', group: 'pwr' },
      { number: '2', name: 'GND', type: 'power_in', group: 'gnd' }
    ]
    expect(
      refuse([...base, { number: '3', name: 'G', type: 'passive', group: 'gnd', stackWith: '99' }])
    ).toBe('stack-target-missing')
    expect(
      refuse([...base, { number: '3', name: 'G', type: 'passive', group: 'gnd', stackWith: '3' }])
    ).toBe('stack-self')
    expect(
      refuse([
        ...base,
        { number: '3', name: 'G', type: 'passive', group: 'gnd', stackWith: '4' },
        { number: '4', name: 'G', type: 'passive', group: 'gnd', stackWith: '3' }
      ])
    ).toBe('stack-cycle')
  })

  test('an omitted pad cannot be stacked on', () => {
    expect(
      refuse([
        { number: '1', name: 'VCC', type: 'power_in', group: 'pwr' },
        { number: '2', name: 'GND', type: 'power_in', group: 'gnd', omit: true },
        { number: '3', name: 'GND', type: 'passive', group: 'gnd', stackWith: '2' }
      ])
    ).toBe('stack-target-missing')
  })
})

describe('stacked pins are hidden', () => {
  test('only the first pad in a stack is visible', () => {
    // Two visible pins at one coordinate read as a drawing mistake in the
    // editor and give no way to tell which is which. The standard library's own
    // SCD40 hides pins 19, 20 and 21 for exactly this reason.
    const layout = plan()
    expect(pinOf(layout, '6').hidden).toBeUndefined()
    expect(pinOf(layout, '20').hidden).toBe(true)
    expect(pinOf(layout, '21').hidden).toBe(true)
    expect(pinOf(layout, '7').hidden).toBeUndefined()
    expect(pinOf(layout, '19').hidden).toBe(true)
  })

  test('every coincident pin beyond the first is hidden, always', () => {
    const layout = plan()
    const byPosition = new Map<string, number>()
    for (const pin of layout.pins) {
      const key = `${pin.x},${pin.y}`
      const seen = byPosition.get(key) ?? 0
      if (seen > 0) expect(pin.hidden).toBe(true)
      byPosition.set(key, seen + 1)
    }
  })
})

describe('balancing a large symbol', () => {
  const bank = (count: number, group: string): SymbolPinSpec[] =>
    Array.from({ length: count }, (_, i) => ({
      number: `${group}${i}`,
      name: `${group.toUpperCase()}${i}`,
      type: 'bidirectional' as const,
      group
    }))
  const RAILS: SymbolPinSpec[] = [
    { number: 'P', name: 'VDD', type: 'power_in', group: 'pwr' },
    { number: 'G', name: 'GND', type: 'power_in', group: 'gnd' }
  ]
  const groupsFor = (ids: string[]): SymbolGroupSpec[] => [
    { id: 'pwr', role: 'power' },
    { id: 'gnd', role: 'ground' },
    ...ids.map((id) => ({ id, role: 'signal' as const }))
  ]

  test('a small symbol keeps the deterministic side, so it never shuffles', () => {
    // Below the threshold, consistency beats balance: the same part must come
    // out the same way every time, even as groups are added.
    const layout = plan(groupsFor(['a', 'b']), [...RAILS, ...bank(2, 'a'), ...bank(2, 'b')])
    expect(layout.pins.filter((p) => p.side === 'left')).toHaveLength(0)
    expect(layout.pins.filter((p) => p.side === 'right')).toHaveLength(4)
  })

  test('a large symbol spreads its groups across both sides', () => {
    // The ESP32 failure: every bidirectional group preferred right, so 36 pins
    // stacked into a 10 x 97 mm sliver where the library draws 25 x 51.
    const ids = ['a', 'b', 'c', 'd']
    const layout = plan(groupsFor(ids), [...RAILS, ...ids.flatMap((id) => bank(8, id))])
    const left = layout.pins.filter((p) => p.side === 'left').length
    const right = layout.pins.filter((p) => p.side === 'right').length
    expect(left + right).toBe(32)
    expect(Math.abs(left - right)).toBeLessThanOrEqual(8)
  })

  test('a group is still never split, however lopsided that leaves it', () => {
    // Cohesion outranks balance — splitting a bus across two sides is the thing
    // grouping exists to prevent.
    const layout = plan(groupsFor(['huge', 'tiny']), [
      ...RAILS,
      ...bank(30, 'huge'),
      ...bank(2, 'tiny')
    ])
    const sides = new Set(layout.pins.filter((p) => p.group === 'huge').map((p) => p.side))
    expect(sides.size).toBe(1)
  })

  test('says so when one side is still very tall, and names the group to split', () => {
    // Geometry cannot fix a single 30-pin bank; the caller has to divide it, so
    // the caller is told which one and why.
    const layout = plan(groupsFor(['huge', 'tiny']), [
      ...RAILS,
      ...bank(30, 'huge'),
      ...bank(2, 'tiny')
    ])
    expect(layout.warnings).toHaveLength(1)
    expect(layout.warnings[0]).toContain('huge')
    expect(layout.warnings[0]).toContain('sub-groups')
  })

  test('a well-grouped large symbol raises no warning', () => {
    const ids = ['a', 'b', 'c', 'd']
    const layout = plan(groupsFor(ids), [...RAILS, ...ids.flatMap((id) => bank(8, id))])
    expect(layout.warnings).toEqual([])
  })

  test('the small symbols this was calibrated on are unchanged', () => {
    expect(plan().warnings).toEqual([])
    expect(pinOf(plan(), '9').side).toBe('right')
    expect(pinOf(plan(), '10').side).toBe('right')
  })
})

describe('the body has to fit the names, in both directions', () => {
  const REG: SymbolGroupSpec[] = [
    { id: 'vin', role: 'power' },
    { id: 'gnd', role: 'ground' },
    { id: 'en', role: 'signal' },
    { id: 'out', role: 'signal' }
  ]
  const regPins = (topName: string, bottomName: string): SymbolPinSpec[] => [
    { number: '1', name: topName, type: 'power_in', group: 'vin' },
    { number: '2', name: bottomName, type: 'power_in', group: 'gnd' },
    { number: '3', name: 'EN', type: 'input', group: 'en' },
    { number: '5', name: 'VOUT', type: 'power_out', group: 'out' }
  ]

  test('a top and a bottom name never meet in the middle', () => {
    // The AP2112 bug: a top pin's name is drawn vertically INSIDE the body, and
    // so is the bottom one. Sizing the body only for the left/right pair left a
    // 5.08 mm-tall regulator holding two 3-character names that needed 6 mm.
    for (const [top, bottom] of [
      ['VIN', 'GND'],
      ['VDDIO', 'AGND'],
      ['V', 'G']
    ]) {
      const layout = plan(REG, regPins(top, bottom))
      const height = layout.body.maxY - layout.body.minY
      const needed = (top.length + bottom.length) * 1.27 * 0.8
      expect(height).toBeGreaterThanOrEqual(needed)
    }
  })

  test('a long left and right name pair still gets the width it needs', () => {
    const layout = plan(REG, [
      { number: '1', name: 'VIN', type: 'power_in', group: 'vin' },
      { number: '2', name: 'GND', type: 'power_in', group: 'gnd' },
      { number: '3', name: 'CHIP_ENABLE_N', type: 'input', group: 'en' },
      { number: '5', name: 'REGULATED_OUT', type: 'power_out', group: 'out' }
    ])
    const width = layout.body.maxX - layout.body.minX
    expect(width).toBeGreaterThanOrEqual(
      ('CHIP_ENABLE_N'.length + 'REGULATED_OUT'.length) * 1.27 * 0.8
    )
  })

  test('the body stays on the pin grid however the names size it', () => {
    for (const [top, bottom] of [
      ['VIN', 'GND'],
      ['VDDIO', 'AGND']
    ]) {
      const layout = plan(REG, regPins(top, bottom))
      expect(Math.abs(layout.body.maxY % (2.54 * MM))).toBe(0)
      expect(Math.abs(layout.body.maxX % (2.54 * MM))).toBe(0)
    }
  })
})

describe('text never crosses text (the fifth run: names under the rails)', () => {
  const SENSOR: SymbolGroupSpec[] = [
    { id: 'pwr', role: 'power' },
    { id: 'gnd', role: 'ground' },
    { id: 'ctl', role: 'signal' },
    { id: 'i2c', role: 'signal' }
  ]
  const sensorPins = (left: string[]): SymbolPinSpec[] => [
    { number: '1', name: 'VDD', type: 'power_in', group: 'pwr' },
    { number: '2', name: 'GND', type: 'power_in', group: 'gnd' },
    ...left.map((name, i) => ({
      number: String(3 + i),
      name,
      type: 'input' as const,
      group: 'ctl'
    })),
    { number: '8', name: 'SDA', type: 'bidirectional' as const, group: 'i2c' },
    { number: '9', name: 'SCL', type: 'input' as const, group: 'i2c' }
  ]
  const nameSpan = (name: string): number => textWidth(name) + 20 * MIL

  test('a side name that reaches the rail column starts below the rail name', () => {
    // A left name runs across the body; VDD runs down it at x = 0. With three
    // long left names the first row crossed both VDD and GND, and the picture
    // was unreadable. The first row now sits below VDD's far end, with the
    // text's own half-height to spare.
    const layout = plan(SENSOR, sensorPins(['nRESET_IN', 'INTERRUPT_OUT', 'ADDR_SELECT']))
    const topRow = Math.max(...layout.pins.filter((p) => p.side === 'left').map((p) => p.y))
    const vdd = layout.pins.find((p) => p.name === 'VDD')!
    expect(topRow + 25 * MIL).toBeLessThanOrEqual(layout.body.maxY - nameSpan('VDD'))
    expect(vdd.side).toBe('top')
  })

  test('a short side name that never reaches the column costs no height', () => {
    // `IN+` stops well before x = 0, so the body is exactly as tall as it is
    // with no side names at all — the rails' own names are what size it.
    const height = (layout: SymbolLayout): number => layout.body.maxY - layout.body.minY
    const short = plan(SENSOR, sensorPins(['IN+', 'IN-', 'EN']))
    const bare = plan(SENSOR, sensorPins([]))
    expect(height(short)).toBe(height(bare))
  })

  test('facing side names clear each other by the clearance, offsets included', () => {
    const layout = plan(SENSOR, sensorPins(['INTERRUPT_OUT']))
    const width = layout.body.maxX - layout.body.minX
    expect(width).toBeGreaterThanOrEqual(
      nameSpan('INTERRUPT_OUT') + nameSpan('SDA') + TEXT_CLEARANCE
    )
  })

  test('nothing the layout draws is within the clearance of anything else', () => {
    // The layout's own judge, on the fixtures above and the calibrated part.
    for (const layout of [
      plan(),
      plan(SENSOR, sensorPins(['nRESET_IN', 'INTERRUPT_OUT', 'ADDR_SELECT'])),
      plan(SENSOR, sensorPins(['IN+', 'IN-', 'EN']))
    ]) {
      expect(textViolations(symbolTextBoxes(layout, 'U?', 'PART'), layout.body)).toEqual([])
    }
  })

  test('a rail name longer than the limit is refused rather than drawn tall', () => {
    const result = planSymbol(SENSOR, [
      { number: '1', name: 'VDD_CORE_1V2', type: 'power_in', group: 'pwr' },
      { number: '2', name: 'GND', type: 'power_in', group: 'gnd' },
      { number: '3', name: 'IN', type: 'input', group: 'ctl' }
    ])
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe('rail-name-too-long')
    }
    // The same name on a side is fine: it runs across the body, not down it.
    const pinned = plan(
      SENSOR.map((g) => (g.id === 'pwr' ? { ...g, side: 'left' as const } : g)),
      [
        { number: '1', name: 'VDD_CORE_1V2', type: 'power_in', group: 'pwr' },
        { number: '2', name: 'GND', type: 'power_in', group: 'gnd' },
        { number: '3', name: 'IN', type: 'input', group: 'ctl' }
      ]
    )
    expect(pinOf(pinned, '1').side).toBe('left')
  })

  test('a pin is long enough to carry its number', () => {
    // `B11` is wider than a 100 mil pin: on one it spills into the body and
    // over the name. Two digits fit, and keep the short pin.
    const twoDigit = plan(SENSOR, sensorPins(['IN']))
    expect(twoDigit.pinLength).toBe(100 * MIL)
    const alnum = plan(SENSOR, [
      { number: 'A4', name: 'VDD', type: 'power_in', group: 'pwr' },
      { number: 'B12', name: 'GND', type: 'power_in', group: 'gnd' },
      { number: 'A6', name: 'IN', type: 'input', group: 'ctl' }
    ])
    expect(alnum.pinLength).toBe(200 * MIL)
    expect(textWidth('B12')).toBeGreaterThan(100 * MIL)
  })
})

describe('a side the caller chose', () => {
  const LDO: SymbolGroupSpec[] = [
    { id: 'in', role: 'signal' },
    { id: 'out', role: 'signal' },
    { id: 'gnd', role: 'ground' }
  ]
  const ldoPins: SymbolPinSpec[] = [
    { number: '1', name: 'VIN', type: 'power_in', group: 'in' },
    { number: '2', name: 'GND', type: 'power_in', group: 'gnd' },
    { number: '3', name: 'VOUT', type: 'power_out', group: 'out' }
  ]

  test('a supply filed as a signal flows in, so VIN goes left on its own', () => {
    const layout = plan(LDO, ldoPins)
    expect(pinOf(layout, '1').side).toBe('left')
    expect(pinOf(layout, '3').side).toBe('right')
  })

  test('an explicit side wins over the rule, and the balancer never moves it', () => {
    expect(sideForGroup('signal', [ldoPins[0]], 'right')).toBe('right')
    expect(sideForGroup('power', [ldoPins[0]], 'left')).toBe('left')
    const pinned = plan(
      LDO.map((g) => (g.id === 'in' ? { ...g, side: 'top' as const } : g)),
      ldoPins
    )
    expect(pinOf(pinned, '1').side).toBe('top')
  })
})

describe('field placement', () => {
  test("both sit one line above the body, on the library's own offset", () => {
    // Measured: Reference is above the body on 92% of 2-64 pin symbols, and
    // 3,772 of the 4,700 that do put it exactly 1.27 mm clear. Nothing in
    // IEEE 315 or IEC 60617 governs this — those cover the graphics and the
    // designator letter classes, not where the text is drawn.
    const layout = plan()
    expect(layout.fields.reference.y).toBe(layout.body.maxY + 50 * MIL)
    expect(layout.fields.value.y).toBe(layout.fields.reference.y)
  })

  test('does not also clear the pin length — that floated them off the symbol', () => {
    // Clearing the pins vertically was needed when both fields were centered at
    // x = 0. Offset sideways, it only pushed the labels 2.54 mm away from the
    // thing they name.
    const layout = plan()
    expect(layout.fields.reference.y).toBeLessThan(layout.body.maxY + layout.pinLength)
  })

  test('neither sits in the path a wire takes out of a top pin', () => {
    // The bug this fixes: centered at x = 0, both labels sat directly above the
    // top pin's free end — which is exactly where the net attaches and where a
    // wire runs upward.
    const layout = plan()
    const topPins = layout.pins.filter((pin) => pin.side === 'top')
    expect(topPins.length).toBeGreaterThan(0)
    for (const pin of topPins) {
      // Reference starts at the body's left edge and reads rightward; Value
      // starts clear of the rightmost top pin.
      expect(layout.fields.reference.x).toBeLessThanOrEqual(pin.x)
      expect(layout.fields.value.x).toBeGreaterThan(pin.x)
    }
  })

  test('Value sits one pitch past the rightmost top pin, not out at the body edge', () => {
    // Anchoring on the body's right edge threw it a long way out on a wide part;
    // one pitch clears the pin and its number and still reads as this symbol's.
    const wide = plan(SCD4X_GROUPS, [
      { number: '1', name: 'VDD', type: 'power_in', group: 'pwr' },
      { number: '2', name: 'GND', type: 'power_in', group: 'gnd' },
      ...Array.from({ length: 10 }, (_, i) => ({
        number: `s${i}`,
        name: `SIGNAL_NAME_${i}`,
        type: 'bidirectional' as const,
        group: 'i2c'
      }))
    ])
    const topPin = wide.pins.find((pin) => pin.side === 'top')!
    expect(wide.fields.value.x).toBe(topPin.x + 100 * MIL)
    // The body is much wider than that, which is the case the old rule got wrong.
    expect(wide.body.maxX).toBeGreaterThan(wide.fields.value.x)
  })

  test('with no top pins it anchors at the body center, clear of Reference', () => {
    const noTop = plan(
      [
        { id: 'gnd', role: 'ground' },
        { id: 'io', role: 'signal' }
      ],
      [
        { number: '1', name: 'GND', type: 'power_in', group: 'gnd' },
        { number: '2', name: 'A', type: 'input', group: 'io' },
        { number: '3', name: 'B', type: 'output', group: 'io' }
      ]
    )
    expect(noTop.pins.some((pin) => pin.side === 'top')).toBe(false)
    expect(noTop.fields.value.x).toBe(0)
    expect(noTop.fields.reference.x).toBe(noTop.body.minX)
  })

  test("Reference is at the body's left edge", () => {
    const layout = plan()
    expect(layout.fields.reference.x).toBe(layout.body.minX)
  })

  test('both are left-justified, so a long value grows away from the pins', () => {
    const layout = plan()
    expect(layout.fields.reference.justify).toBe('left')
    expect(layout.fields.value.justify).toBe('left')
  })

  test('the two fields are never in the same place', () => {
    // They scaffold at the origin — on each other, and inside the body.
    const layout = plan()
    expect(layout.fields.reference).not.toEqual(layout.fields.value)
    expect(layout.fields.reference.y).not.toBe(0)
  })

  test('the bottom is left entirely clear for ground wiring', () => {
    const layout = plan()
    for (const field of [layout.fields.reference, layout.fields.value]) {
      expect(field.y).toBeGreaterThan(layout.body.maxY)
    }
  })
})

describe('order down a side', () => {
  test("balancing picks the side; the caller's group order picks the sequence", () => {
    // Groups are assigned largest-first to even the columns, which must not also
    // become the order they appear in — that is the datasheet's, and the only
    // sequence a reader expects.
    const groups: SymbolGroupSpec[] = [
      { id: 'pwr', role: 'power' },
      { id: 'gnd', role: 'ground' },
      { id: 'first', role: 'signal' },
      { id: 'second', role: 'signal' },
      { id: 'third', role: 'signal' }
    ]
    const pins: SymbolPinSpec[] = [
      { number: 'P', name: 'VDD', type: 'power_in', group: 'pwr' },
      { number: 'G', name: 'GND', type: 'power_in', group: 'gnd' },
      ...Array.from({ length: 3 }, (_, i) => ({
        number: `f${i}`,
        name: `F${i}`,
        type: 'bidirectional' as const,
        group: 'first'
      })),
      ...Array.from({ length: 9 }, (_, i) => ({
        number: `s${i}`,
        name: `S${i}`,
        type: 'bidirectional' as const,
        group: 'second'
      })),
      ...Array.from({ length: 6 }, (_, i) => ({
        number: `t${i}`,
        name: `T${i}`,
        type: 'bidirectional' as const,
        group: 'third'
      }))
    ]
    const layout = plan(groups, pins)
    for (const side of ['left', 'right'] as const) {
      const seen = layout.pins.filter((p) => p.side === side).map((p) => p.group)
      const firstIndex = [...new Set(seen)].map((g) => ['first', 'second', 'third'].indexOf(g))
      expect(firstIndex).toEqual([...firstIndex].sort((a, b) => a - b))
    }
  })
})
