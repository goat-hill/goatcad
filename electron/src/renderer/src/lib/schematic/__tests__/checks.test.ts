import { describe, expect, test } from 'vitest'
import { KICAD10_PIN_MAP } from '../../kicad/projectDefaults'
import { mmToNm, spacingToMm } from '../../kicad/coordinates'
import {
  buildConnectivity,
  buildSheetConnectivity,
  type SchematicConnectivity,
  type SheetConnectivityInput
} from '../connectivity'
import { itemRefsWithUuids, parseKicadSchematic } from '../../kicad/schematic'
import { connectionChecks } from '../connectionChecks'
import {
  CHECK_RULES,
  allChecks,
  checkDelta,
  compactDelta,
  electricalChecks,
  gridChecks,
  groupChecks,
  hierarchyChecks,
  librarySymbolChecks,
  unconnectedChecks,
  type CheckResult,
  type LibrarySymbolLookup
} from '../checks'

// Minimal but grammatically real KiCad 8 output, in the shape
// `connectivity.test.ts` established. Every pin type a rule reads is here.
const LIB = `
  (lib_symbols
    (symbol "Device:R"
      (symbol "R_1_1"
        (pin passive line (at 0 3.81 270) (length 1.27)
          (name "~" (effects (font (size 1.27 1.27))))
          (number "1" (effects (font (size 1.27 1.27)))))
        (pin passive line (at 0 -3.81 90) (length 1.27)
          (name "~" (effects (font (size 1.27 1.27))))
          (number "2" (effects (font (size 1.27 1.27)))))))
    (symbol "Amp:BUF"
      (symbol "BUF_1_1"
        (pin output line (at 0 0 0) (length 2.54)
          (name "OUT" (effects (font (size 1.27 1.27))))
          (number "1" (effects (font (size 1.27 1.27)))))))
    (symbol "Logic:IN"
      (symbol "IN_1_1"
        (pin input line (at 0 0 0) (length 2.54)
          (name "IN" (effects (font (size 1.27 1.27))))
          (number "1" (effects (font (size 1.27 1.27)))))))
    (symbol "Logic:QUAD"
      (symbol "QUAD_0_1"
        (pin passive line (at 0 -2.54 270) (length 2.54)
          (name "COM" (effects (font (size 1.27 1.27))))
          (number "9" (effects (font (size 1.27 1.27))))))
      (symbol "QUAD_1_1"
        (pin input line (at 0 0 0) (length 2.54)
          (name "A" (effects (font (size 1.27 1.27))))
          (number "1" (effects (font (size 1.27 1.27))))))
      (symbol "QUAD_2_1"
        (pin input line (at 0 0 0) (length 2.54)
          (name "B" (effects (font (size 1.27 1.27))))
          (number "2" (effects (font (size 1.27 1.27))))))
      (symbol "QUAD_3_1"
        (pin bidirectional line (at 0 0 0) (length 2.54)
          (name "C" (effects (font (size 1.27 1.27))))
          (number "3" (effects (font (size 1.27 1.27))))))
      (symbol "QUAD_4_1"
        (pin power_in line (at 0 0 0) (length 2.54)
          (name "VCC" (effects (font (size 1.27 1.27))))
          (number "4" (effects (font (size 1.27 1.27)))))))
    (symbol "Chip:G"
      (property "ki_fp_filters" "SOIC*" (at 0 0 0))
      (symbol "G_1_1"
        (pin power_in line (at 0 0 0) (length 2.54)
          (name "GND" (effects (font (size 1.27 1.27))))
          (number "1" (effects (font (size 1.27 1.27)))))
        (pin power_in line (at 0 -2.54 0) (length 2.54)
          (name "GND" (effects (font (size 1.27 1.27))))
          (number "2" (effects (font (size 1.27 1.27)))))
        (pin passive line (at 0 -5.08 0) (length 2.54)
          (name "S" (effects (font (size 1.27 1.27))))
          (number "[3-1]" (effects (font (size 1.27 1.27)))))))
    (symbol "Conn:X"
      (symbol "X_1_1"
        (pin unspecified line (at 0 0 0) (length 2.54)
          (name "A" (effects (font (size 1.27 1.27))))
          (number "1" (effects (font (size 1.27 1.27)))))
        (pin unspecified line (at 0 0 0) (length 2.54)
          (name "A" (effects (font (size 1.27 1.27))))
          (number "2" (effects (font (size 1.27 1.27)))))))
    (symbol "MCU:U"
      (symbol "U_1_1"
        (pin power_in line (at 0 0 0) (length 2.54)
          (name "VDD" (effects (font (size 1.27 1.27))))
          (number "1" (effects (font (size 1.27 1.27)))))))
    (symbol "power:GND"
      (power)
      (symbol "GND_1_1"
        (pin power_in line (at 0 0 270) (length 0) hide
          (name "GND" (effects (font (size 1.27 1.27))))
          (number "1" (effects (font (size 1.27 1.27)))))))
    (symbol "power:PWR_FLAG"
      (power)
      (symbol "PWR_FLAG_1_1"
        (pin power_out line (at 0 0 90) (length 0)
          (name "pwr" (effects (font (size 1.27 1.27))))
          (number "1" (effects (font (size 1.27 1.27)))))))
    (symbol "power:+3V3"
      (power)
      (symbol "+3V3_1_1"
        (pin power_out line (at 0 0 90) (length 0)
          (name "+3V3" (effects (font (size 1.27 1.27))))
          (number "1" (effects (font (size 1.27 1.27))))))))
`

const doc = (body: string): string =>
  `(kicad_sch (version 20231120) (generator "test") (uuid "aaaaaaaa-0000-0000-0000-000000000000") ${LIB} ${body})`

const part = (libId: string, reference: string, x: number, y: number, angle = 0): string =>
  `(symbol (lib_id "${libId}") (at ${x} ${y} ${angle}) (unit 1) (uuid "${reference}")
     (property "Reference" "${reference}" (at ${x} ${y} 0))
     (property "Value" "v" (at ${x} ${y} 0)))`

const wire = (x1: number, y1: number, x2: number, y2: number): string =>
  `(wire (pts (xy ${x1} ${y1}) (xy ${x2} ${y2})) (stroke (width 0)))`

const label = (text: string, x: number, y: number): string =>
  `(label "${text}" (at ${x} ${y} 0) (effects (font (size 1.27 1.27))))`

const check = (body: string): SchematicConnectivity =>
  buildSheetConnectivity(parseKicadSchematic(doc(body)))

describe('unconnected', () => {
  test('reports a pin that goes nowhere, with the id an agent addresses it by', () => {
    const results = unconnectedChecks(check(part('Device:R', 'R1', 100, 100)))
    expect(results).toHaveLength(2)
    expect(results.map((r) => r.items[0]).sort()).toEqual(['R1.1', 'R1.2'])
    expect(results[0].code).toBe('unconnected-pin')
    expect(results[0].severity).toBe('error')
  })

  test('says nothing about a pin that is connected', () => {
    // Two resistors sharing a point: both inner pins are joined, both outer
    // pins still dangle.
    const body = [
      part('Device:R', 'R1', 100, 100),
      part('Device:R', 'R2', 100, 107.62),
      wire(100, 103.81, 100, 103.81)
    ].join(' ')
    const results = unconnectedChecks(check(body))
    expect(results.map((r) => r.items[0])).not.toContain('R1.2')
  })

  // KiCad 10's ERC: "Unconnected wire endpoint" for a wire teed onto another's
  // interior, "Pin not connected" for a pin resting on one — no junction, no join.
  test('a wire end or pin resting on a wire interior is reported until a junction joins it', () => {
    const body = [
      wire(90, 110, 110, 110),
      label('A', 90, 110),
      label('A', 110, 110),
      wire(100, 120, 100, 110),
      label('A', 100, 120),
      // R1 at (95, 106.19): pin 2 lands on the wire at (95, 110).
      part('Device:R', 'R1', 95, 106.19)
    ].join(' ')
    const open = unconnectedChecks(check(body))
    expect(open.map((r) => r.code).sort()).toEqual([
      'unconnected-pin',
      'unconnected-pin',
      'unconnected-wire-end'
    ])
    expect(open.find((r) => r.code === 'unconnected-wire-end')?.position).toEqual({
      x: 100,
      y: 110
    })
    const joined = unconnectedChecks(
      check(`${body} (junction (at 100 110)) (junction (at 95 110))`)
    )
    expect(joined.map((r) => r.items[0])).toEqual(['R1.1'])
  })

  test('is stable across calls, so a delta means something', () => {
    const connectivity = check(part('Device:R', 'R1', 100, 100))
    expect(unconnectedChecks(connectivity)).toEqual(unconnectedChecks(connectivity))
  })
})

describe('electrical rules', () => {
  test('flags two outputs driving one net', () => {
    const body = [
      part('Amp:BUF', 'U1', 100, 100),
      part('Amp:BUF', 'U2', 110, 100),
      wire(100, 100, 110, 100),
      label('OUT', 100, 100)
    ].join(' ')
    const results = electricalChecks(check(body))
    const conflict = results.find((r) => r.code === 'pin-conflict')
    expect(conflict).toBeDefined()
    expect(conflict!.items).toEqual(['U1.1', 'U2.1'])
    expect(conflict!.severity).toBe('error')
  })

  test('unspecified pins sharing a net are a warning, and a stacked pair is one pin', () => {
    const stacked = electricalChecks(
      check(`${part('Conn:X', 'J1', 100, 100)} ${wire(100, 100, 110, 100)} ${label('A', 110, 100)}`)
    )
    expect(stacked.filter((r) => r.code === 'pin-conflict')).toEqual([])
    const shared = electricalChecks(
      check(
        [
          part('Conn:X', 'J1', 100, 100),
          part('Conn:X', 'J2', 120, 100),
          wire(100, 100, 120, 100),
          label('A', 110, 100)
        ].join(' ')
      )
    ).find((r) => r.code === 'pin-conflict')
    expect(shared?.severity).toBe('warning')
    expect(shared?.items).toEqual(['J1.1', 'J1.2', 'J2.1', 'J2.2'])
  })

  test("the project's pin map grades the pairs", () => {
    const body = [
      part('Amp:BUF', 'U1', 100, 100),
      part('Amp:BUF', 'U2', 110, 100),
      wire(100, 100, 110, 100)
    ].join(' ')
    const lenient = KICAD10_PIN_MAP.map((row) => [...row])
    lenient[1][1] = 0
    expect(electricalChecks(check(body), lenient).filter((r) => r.code === 'pin-conflict')).toEqual(
      []
    )
  })

  test('an input nothing drives is an error; a passive or a no-connect settles it', () => {
    const lone = [
      part('Logic:IN', 'U1', 100, 100),
      wire(100, 100, 110, 100),
      label('SENSE', 110, 100)
    ]
    const undriven = electricalChecks(check(lone.join(' '))).find(
      (r) => r.code === 'input-undriven'
    )
    expect(undriven?.items).toEqual(['U1.1'])
    expect(undriven?.severity).toBe('error')
    const pulled = [...lone, part('Device:R', 'R1', 110, 103.81)]
    expect(
      electricalChecks(check(pulled.join(' '))).filter((r) => r.code === 'input-undriven')
    ).toEqual([])
    const parked = [...lone, '(no_connect (at 110 100))']
    expect(
      electricalChecks(check(parked.join(' '))).filter((r) => r.code === 'input-undriven')
    ).toEqual([])
  })

  test("an unannotated part's input is not asked for a driver until it is annotated", () => {
    const body = [part('Logic:IN', 'U?', 100, 100), wire(100, 100, 110, 100)].join(' ')
    expect(electricalChecks(check(body)).filter((r) => r.code === 'input-undriven')).toEqual([])
  })

  test('leaves one output alone', () => {
    const body = [part('Amp:BUF', 'U1', 100, 100), part('Device:R', 'R1', 105, 100)].join(' ')
    expect(
      electricalChecks(check(body)).find((r) => r.code === 'conflicting-drivers')
    ).toBeUndefined()
  })

  test('flags a power pin nothing drives', () => {
    const results = electricalChecks(check(part('MCU:U', 'U1', 100, 100)))
    const undriven = results.find((r) => r.code === 'power-input-undriven')
    // The message has to open with what to DO. A reader who acted on the old
    // opening ("wants a power output pin") deleted the power symbol.
    expect(undriven?.message).toMatch(/Add a PWR_FLAG/)
    expect(undriven?.message).not.toMatch(/^[^.]*wants a power output pin/)
    expect(undriven).toBeDefined()
    expect(undriven!.items).toEqual(['U1.1'])
  })

  test('a power symbol alone does not drive a rail, as KiCad also rules', () => {
    const body = [
      part('MCU:U', 'U1', 100, 100),
      part('power:GND', 'PWR2', 105, 100),
      wire(100, 100, 105, 100)
    ].join(' ')
    const results = electricalChecks(check(body))
    expect(results.find((r) => r.code === 'power-input-undriven')).toBeDefined()
  })

  test('accepts a power pin a power symbol drives', () => {
    // A wire from the MCU's VDD to the power symbol's pin puts both on one net.
    const body = [
      part('MCU:U', 'U1', 100, 100),
      part('power:+3V3', 'PWR1', 105, 100),
      wire(100, 100, 105, 100)
    ].join(' ')
    const results = electricalChecks(check(body))
    expect(results.find((r) => r.code === 'power-input-undriven')).toBeUndefined()
  })
})

describe('a global label and a power port of one name', () => {
  test('are one net', () => {
    const body = [
      part('MCU:U', 'U1', 100, 100),
      `(global_label "GND" (shape input) (at 100 100 0) (effects (font (size 1.27 1.27))))`,
      // A power port names its net by its Value, which `part` writes as "v";
      // the fixture's GND is the KiCad shape, a power_in pin on a (power) symbol.
      `(symbol (lib_id "power:GND") (at 150 150 0) (unit 1) (uuid "PWR1")
         (property "Reference" "PWR1" (at 150 150 0))
         (property "Value" "GND" (at 150 150 0)))`
    ].join(' ')
    const graph = check(body)
    const rail = graph.nets.find((n) => n.pins.some((p) => p.reference === 'U1'))!
    expect(rail.pins.map((p) => p.reference).sort()).toEqual(['PWR1', 'U1'])
    expect(rail.name).toBe('GND')
  })
})

describe('a power symbol under a label', () => {
  test('is named by the undriven-rail finding and by nothing else', () => {
    // The fourth run reported "power symbols reported as unconnected when a
    // label sat on their pin". The dangling pass
    // never reports a hidden pin, so what the agent read was its own power
    // symbol listed among the sinks of a rail nothing drives — the finding the
    // reworded message now answers. This pins the reproduction down so the
    // report stays closed.
    const body = [part('power:GND', '#PWR01', 100, 100), label('GND', 100, 100)].join(' ')
    const results = allChecks(check(body))
    expect(results.filter((r) => r.code === 'unconnected-pin')).toEqual([])
    const undriven = results.filter((r) => r.code === 'power-input-undriven')
    expect(undriven).toHaveLength(1)
    expect(undriven[0].items).toEqual(['#PWR01.1'])
    expect(undriven[0].message).toMatch(/adding or removing one changes nothing/)
  })
})

describe('a PWR_FLAG', () => {
  test('drives a rail without naming it', () => {
    const body = [
      part('MCU:U', 'U1', 100, 100),
      part('power:PWR_FLAG', '#FLG1', 105, 100),
      wire(100, 100, 105, 100),
      label('VIN', 105, 100)
    ].join(' ')
    const graph = check(body)
    const net = graph.nets.find((n) => n.pins.some((p) => p.reference === 'U1'))!
    expect(net.name).toBe('/VIN')
    expect(electricalChecks(graph).find((r) => r.code === 'power-input-undriven')).toBeUndefined()
  })

  test('two of them on two rails stay two nets', () => {
    const body = [
      part('MCU:U', 'U1', 100, 100),
      part('power:PWR_FLAG', '#FLG1', 105, 100),
      wire(100, 100, 105, 100),
      part('MCU:U', 'U2', 100, 120),
      part('power:PWR_FLAG', '#FLG2', 105, 120),
      wire(100, 120, 105, 120)
    ].join(' ')
    const graph = check(body)
    const rails = graph.nets.filter((n) => n.pins.some((p) => p.reference.startsWith('#FLG')))
    expect(rails).toHaveLength(2)
  })
})

describe('the delta', () => {
  const finding = (
    code: string,
    items: string[]
  ): { code: string; severity: 'error'; message: string; items: string[] } => ({
    code,
    severity: 'error',
    message: 'm',
    items
  })

  test('names what appeared and what went away', () => {
    const before = [finding('unconnected-pin', ['U1.VDD']), finding('a', ['x'])]
    const after = [finding('a', ['x']), finding('conflicting-drivers', ['U1.1', 'U2.1'])]
    const delta = checkDelta(before, after)
    expect(delta.new.map((r) => r.code)).toEqual(['conflicting-drivers'])
    expect(delta.resolved.map((r) => r.code)).toEqual(['unconnected-pin'])
  })

  test('is empty when nothing moved', () => {
    const same = [finding('unconnected-pin', ['U1.VDD'])]
    expect(checkDelta(same, same)).toEqual({ new: [], resolved: [] })
  })

  test('ignores a move: the same finding in a new place is not a new finding', () => {
    const before = [{ ...finding('unconnected-pin', ['U1.1']), position: { x: 1, y: 1 } }]
    const after = [{ ...finding('unconnected-pin', ['U1.1']), position: { x: 9, y: 9 } }]
    expect(checkDelta(before, after)).toEqual({ new: [], resolved: [] })
  })
})

describe('allChecks', () => {
  test('is everything applicable, in one stable order', () => {
    const body = [part('MCU:U', 'U1', 100, 100), part('Amp:BUF', 'A1', 120, 120)].join(' ')
    const results = allChecks(check(body))
    expect(results.map((r) => r.code)).toEqual([...results.map((r) => r.code)].sort())
    expect(results.some((r) => r.code === 'power-input-undriven')).toBe(true)
    expect(results.some((r) => r.code === 'unconnected-pin')).toBe(true)
  })
})

describe('the shapes an agent reads', () => {
  const finding = (code: string, item: string): CheckResult => ({
    code,
    severity: 'error',
    message: `${item} long sentence`,
    items: [item],
    position: { x: 1, y: 2 }
  })

  test('groups findings by rule, with every item and one sentence', () => {
    const groups = groupChecks([
      finding('unconnected-pin', 'U1.2'),
      finding('unconnected-pin', 'U1.1'),
      finding('power-input-undriven', 'U2.3')
    ])
    expect(groups.map((g) => [g.code, g.count, g.items])).toEqual([
      ['power-input-undriven', 1, ['U2.3']],
      ['unconnected-pin', 2, ['U1.1', 'U1.2']]
    ])
    expect(groups[1].rule).toContain('no-connect')
  })

  test('a compact delta keeps the code and the items and drops the prose', () => {
    const delta = compactDelta({ new: [finding('unconnected-pin', 'U1.1')], resolved: [] })
    expect(delta).toEqual({
      new: [{ code: 'unconnected-pin', severity: 'error', items: ['U1.1'] }],
      resolved: []
    })
  })

  test('a compact delta is one row per rule, and a count once the items are many', () => {
    // Placing a 41-pin part answered 41 rows nobody read;
    // the pins are the part's own, which the reader just placed. A wire's
    // delta of one or two items, which the reader does act on, stays itemised.
    const pins = Array.from({ length: 41 }, (_, index) => `U3.${index + 1}`)
    const delta = compactDelta({
      new: [...pins.map((pin) => finding('unconnected-pin', pin)), finding('off-grid', 'W7')],
      resolved: [finding('unconnected-pin', 'C8.1'), finding('unconnected-pin', 'C8.2')]
    })
    expect(delta).toEqual({
      new: [
        { code: 'off-grid', severity: 'error', items: ['W7'] },
        { code: 'unconnected-pin', severity: 'error', count: 41 }
      ],
      resolved: [{ code: 'unconnected-pin', severity: 'error', items: ['C8.1', 'C8.2'] }]
    })
  })
})

describe('a hierarchical boundary is one connection with two halves', () => {
  const parentWith = (pins: string): ReturnType<typeof parseKicadSchematic> =>
    parseKicadSchematic(`(kicad_sch (version 20231120) (uuid "root") (paper "A4") (lib_symbols)
      (sheet (at 100 100) (size 40 30)
        (stroke (width 0.1524) (type solid))
        (uuid "block-uuid")
        (property "Sheetname" "Power" (at 100 99 0) (effects (font (size 1.27 1.27))))
        (property "Sheetfile" "power.kicad_sch" (at 100 131 0) (effects (font (size 1.27 1.27))))
        ${pins}))`)

  const childWith = (labels: string): ReturnType<typeof parseKicadSchematic> =>
    parseKicadSchematic(
      `(kicad_sch (version 20231120) (uuid "child") (paper "A4") (lib_symbols) ${labels})`
    )

  const treeOf = (
    parent: ReturnType<typeof parseKicadSchematic>,
    child: ReturnType<typeof parseKicadSchematic>
  ): Parameters<typeof hierarchyChecks>[0] => [
    { sheetPath: '/root', namePath: '/', schematic: parent },
    { sheetPath: '/root/block-uuid', namePath: '/Power', schematic: child }
  ]

  const PIN = '(pin "VBUS" input (at 100 105 180) (effects (font (size 1.27 1.27))) (uuid "p1"))'
  const LABEL =
    '(hierarchical_label "VBUS" (shape input) (at 50 50 0) (effects (font (size 1.27 1.27))) (uuid "l1"))'

  test('a matched pair reports nothing', () => {
    expect(hierarchyChecks(treeOf(parentWith(PIN), childWith(LABEL)))).toEqual([])
  })

  test('a pin with no label inside the block is an error naming the pin', () => {
    const results = hierarchyChecks(treeOf(parentWith(PIN), childWith('')))
    expect(results.map((r) => [r.code, r.severity, r.items])).toEqual([
      ['sheet-pin-unmatched', 'error', ['block-uuid#VBUS']]
    ])
    expect(results[0].message).toContain('/Power')
  })

  test('a label with no pin on the box is an error naming the label', () => {
    const results = hierarchyChecks(treeOf(parentWith(''), childWith(LABEL)))
    expect(results.map((r) => [r.code, r.items])).toEqual([
      ['hierarchical-label-unmatched', ['l1']]
    ])
  })

  // A local label stays inside the block by definition, so it is not a
  // boundary at all and must not be reported as a missing one.
  test('a local label inside the block is not a boundary', () => {
    const local = '(label "VSENSE" (at 50 60 0) (effects (font (size 1.27 1.27))) (uuid "l2"))'
    expect(hierarchyChecks(treeOf(parentWith(PIN), childWith(`${LABEL} ${local}`)))).toEqual([])
  })

  // A child file that was never loaded is a different problem; reporting every
  // one of its pins would bury a real name mismatch.
  test('a child that is not in the tree is not this rule to report', () => {
    const parent = parentWith(PIN)
    expect(hierarchyChecks([{ sheetPath: '/root', namePath: '/', schematic: parent }])).toEqual([])
  })
})

describe('a rail across sheets', () => {
  // KiCad's real shapes: a +3V3 port is a `power_in` pin on a `(power)` symbol
  // and names the net wherever it appears; a PWR_FLAG is `power_out` and
  // drives without naming. The test lib above gives +3V3 a `power_out` pin for
  // the single-sheet rules, so this tree carries its own.
  const RAIL_LIB = `
    (lib_symbols
      (symbol "MCU:U"
        (symbol "U_1_1"
          (pin power_in line (at 0 0 0) (length 2.54)
            (name "VDD" (effects (font (size 1.27 1.27))))
            (number "1" (effects (font (size 1.27 1.27)))))))
      (symbol "power:PWR_FLAG"
        (power)
        (symbol "PWR_FLAG_1_1"
          (pin power_out line (at 0 0 90) (length 0)
            (name "pwr" (effects (font (size 1.27 1.27))))
            (number "1" (effects (font (size 1.27 1.27)))))))
      (symbol "power:+3V3"
        (power)
        (symbol "+3V3_1_1"
          (pin power_in line (at 0 0 90) (length 0)
            (name "+3V3" (effects (font (size 1.27 1.27))))
            (number "1" (effects (font (size 1.27 1.27))))))))`

  const sheetDoc = (uuid: string, body: string): ReturnType<typeof parseKicadSchematic> =>
    parseKicadSchematic(
      `(kicad_sch (version 20231120) (generator "test") (uuid "${uuid}") ${RAIL_LIB} ${body})`
    )

  // The power sheet: a +3V3 port with a PWR_FLAG on the same point.
  const power = sheetDoc(
    'power',
    [part('power:+3V3', '#PWR01', 100, 100), part('power:PWR_FLAG', '#FLG01', 100, 100)].join(' ')
  )
  // The MCU sheet: the same rail into a power_in pin, no flag of its own.
  const mcu = sheetDoc(
    'mcu',
    [part('power:+3V3', '#PWR02', 50, 50), part('MCU:U', 'U1', 50, 50)].join(' ')
  )
  const rows = (results: CheckResult[]): string[][] =>
    results.filter((r) => r.code === 'power-input-undriven').map((r) => r.items)

  test('a PWR_FLAG on the power sheet drives the rail on every sheet in the tree', () => {
    const tree = buildConnectivity([
      { sheetPath: '/root/power', namePath: '/Power', schematic: power },
      { sheetPath: '/root/mcu', namePath: '/MCU', schematic: mcu }
    ])
    expect(rows(electricalChecks(tree))).toEqual([])
  })

  test('the MCU sheet on its own reports the rail undriven — which is what a check fed one sheet says', () => {
    expect(rows(electricalChecks(buildSheetConnectivity(mcu)))).toEqual([['#PWR02.1', 'U1.1']])
  })
})

describe('library symbol mismatch', () => {
  // The sheet's embedded copy of a two-pin part, and three "library" versions
  // of it: the same, one with a pad added, one with a pin drawn elsewhere.
  const RECTANGLE = `(rectangle (start -5.08 -5.08) (end 5.08 5.08)
          (stroke (width 0.254) (type default)) (fill (type none)))`
  const CIRCLE = `(circle (center 0 0) (radius 1.27)
          (stroke (width 0.254) (type default)) (fill (type none)))`
  const definition = (pins: string, body = RECTANGLE): string => `
    (symbol "Custom:CODEC"
      (property "Reference" "U" (at 0 0 0))
      (symbol "CODEC_0_1" ${body})
      (symbol "CODEC_1_1" ${pins}))`
  const PIN_1 = `(pin power_in line (at -7.62 2.54 0) (length 2.54)
        (name "VDD" (effects (font (size 1.27 1.27))))
        (number "1" (effects (font (size 1.27 1.27)))))`
  const PIN_2 = `(pin passive line (at -7.62 -2.54 0) (length 2.54)
        (name "GND" (effects (font (size 1.27 1.27))))
        (number "2" (effects (font (size 1.27 1.27)))))`
  const PIN_1_MOVED = PIN_1.replace('(at -7.62 2.54 0)', '(at -7.62 0 0)')
  const EPAD = `(pin passive line (at 0 -7.62 90) (length 2.54)
        (name "EPAD" (effects (font (size 1.27 1.27))))
        (number "EPAD" (effects (font (size 1.27 1.27)))))`

  const sheetWith = (pins: string, body?: string): ReturnType<typeof parseKicadSchematic> =>
    parseKicadSchematic(`(kicad_sch (version 20231120) (generator "test") (uuid "sheet")
      (lib_symbols ${definition(pins, body)})
      ${part('Custom:CODEC', 'U1', 100, 100)}
      ${part('Custom:CODEC', 'U2', 140, 100)})`)
  const libraryWith = (pins: string, body?: string): ReturnType<typeof parseKicadSchematic> =>
    parseKicadSchematic(
      `(kicad_sch (version 20231120) (generator "test") (uuid "lib") (lib_symbols ${definition(pins, body)}))`
    )
  const inputs = (sheet: ReturnType<typeof parseKicadSchematic>): SheetConnectivityInput[] => [
    { sheetPath: '/sheet', namePath: '/', schematic: sheet }
  ]
  const lookupIn =
    (library: ReturnType<typeof parseKicadSchematic>): LibrarySymbolLookup =>
    (libId) =>
      library.libSymbols.get(libId)

  test('a copy that matches its library reports nothing', () => {
    const sheet = sheetWith(`${PIN_1} ${PIN_2}`)
    expect(librarySymbolChecks(inputs(sheet), lookupIn(libraryWith(`${PIN_1} ${PIN_2}`)))).toEqual(
      []
    )
  })

  test('a library the project cannot see is not compared', () => {
    const sheet = sheetWith(`${PIN_1} ${PIN_2}`)
    expect(librarySymbolChecks(inputs(sheet), () => undefined)).toEqual([])
  })

  test('a pin the library has and the copy lacks is an error naming every instance', () => {
    const sheet = sheetWith(`${PIN_1} ${PIN_2}`)
    const results = librarySymbolChecks(
      inputs(sheet),
      lookupIn(libraryWith(`${PIN_1} ${PIN_2} ${EPAD}`))
    )
    expect(results.map((r) => [r.code, r.severity, r.items])).toEqual([
      ['symbol-library-mismatch', 'error', ['U1', 'U2']]
    ])
    expect(results[0].message).toContain('added EPAD')
    expect(results[0].message).toContain('items_delete')
  })

  // KiCad compares a library pin by its unit, number and place only.
  test('a pin retyped, renamed or restyled in the library is not a change', () => {
    const sheet = sheetWith(`${PIN_1} ${PIN_2}`)
    const restyled = PIN_1.replace('power_in line', 'input inverted')
      .replace('(name "VDD"', '(name "VCC"')
      .replace('(length 2.54)', '(length 5.08) hide')
    expect(
      librarySymbolChecks(inputs(sheet), lookupIn(libraryWith(`${restyled} ${PIN_2}`)))
    ).toEqual([])
  })

  test('a pin drawn elsewhere is a warning', () => {
    const sheet = sheetWith(`${PIN_1} ${PIN_2}`)
    const results = librarySymbolChecks(
      inputs(sheet),
      lookupIn(libraryWith(`${PIN_1_MOVED} ${PIN_2}`))
    )
    expect(results.map((r) => [r.code, r.severity])).toEqual([
      ['symbol-library-mismatch', 'warning']
    ])
    expect(results[0].message).toContain('pins 1 moved')
  })

  test('an unnamed pin spelled ~ in the copy and "" in the library is the same pin', () => {
    const tilde = PIN_2.replace('(name "GND"', '(name "~"').replace('(number "2"', '(number "~"')
    const empty = PIN_2.replace('(name "GND"', '(name ""').replace('(number "2"', '(number ""')
    const sheet = sheetWith(`${PIN_1} ${tilde}`)
    expect(librarySymbolChecks(inputs(sheet), lookupIn(libraryWith(`${PIN_1} ${empty}`)))).toEqual(
      []
    )
  })

  test('a library that lists the same shapes in another order has not changed', () => {
    const sheet = sheetWith(`${PIN_1} ${PIN_2}`, `${RECTANGLE} ${CIRCLE}`)
    const library = libraryWith(`${PIN_1} ${PIN_2}`, `${CIRCLE} ${RECTANGLE}`)
    expect(librarySymbolChecks(inputs(sheet), lookupIn(library))).toEqual([])
    const redrawn = libraryWith(`${PIN_1} ${PIN_2}`, CIRCLE)
    expect(librarySymbolChecks(inputs(sheet), lookupIn(redrawn))[0].message).toContain(
      'the body is drawn differently'
    )
  })

  test('an arc written end to start is the same arc', () => {
    const arc = `(arc (start 0 -2.032) (mid 0.508 -1.524) (end 0 -1.016)
          (stroke (width 0) (type default)) (fill (type none)))`
    const reversed = `(arc (start 0 -1.016) (mid 0.508 -1.524) (end 0 -2.032)
          (stroke (width 0) (type default)) (fill (type none)))`
    const sheet = sheetWith(`${PIN_1} ${PIN_2}`, arc)
    expect(
      librarySymbolChecks(inputs(sheet), lookupIn(libraryWith(`${PIN_1} ${PIN_2}`, reversed)))
    ).toEqual([])
  })

  test('a field the library adds or rewords is a warning naming the field', () => {
    const sheet = sheetWith(`${PIN_1} ${PIN_2}`)
    const library = parseKicadSchematic(
      `(kicad_sch (version 20231120) (generator "test") (uuid "lib") (lib_symbols ${definition(
        `${PIN_1} ${PIN_2}`
      ).replace(
        '(property "Reference" "U" (at 0 0 0))',
        '(property "Reference" "U" (at 0 0 0)) (property "Sim.Pins" "1=K 2=A" (at 0 0 0))'
      )}))`
    )
    const results = librarySymbolChecks(inputs(sheet), lookupIn(library))
    expect(results.map((r) => [r.code, r.severity])).toEqual([
      ['symbol-library-mismatch', 'warning']
    ])
    expect(results[0].message).toContain('fields Sim.Pins differ')
  })

  test("what only the sheet decides — a field's place, shown pin names — is not a change", () => {
    const sheet = sheetWith(`${PIN_1} ${PIN_2}`)
    const library = parseKicadSchematic(
      `(kicad_sch (version 20231120) (generator "test") (uuid "lib") (lib_symbols ${definition(
        `${PIN_1} ${PIN_2}`
      )
        .replace('(property "Reference" "U" (at 0 0 0))', '(property "Reference" "U" (at 5 5 0))')
        .replace('(symbol "Custom:CODEC"', '(symbol "Custom:CODEC" (pin_names hide)')}))`
    )
    expect(librarySymbolChecks(inputs(sheet), lookupIn(library))).toEqual([])
  })

  test('the rule is in the catalog and in schematic.check', () => {
    expect(CHECK_RULES['symbol-library-mismatch']).toContain('never rewrites')
    const sheet = sheetWith(`${PIN_1} ${PIN_2}`)
    const all = allChecks(
      buildSheetConnectivity(sheet),
      inputs(sheet),
      lookupIn(libraryWith(`${PIN_1} ${PIN_2} ${EPAD}`))
    )
    expect(all.some((r) => r.code === 'symbol-library-mismatch')).toBe(true)
  })
})

describe('off grid', () => {
  const sheets = (body: string): SheetConnectivityInput[] => [
    {
      sheetPath: '/aaaaaaaa-0000-0000-0000-000000000000',
      namePath: '/',
      schematic: parseKicadSchematic(doc(body))
    }
  ]

  test('a wire end or pin off the 1.27 mm grid is a warning, on-grid ones are not', () => {
    expect(
      gridChecks(sheets(`${wire(50.8, 50.8, 63.5, 50.8)} ${part('Device:R', 'R1', 50.8, 54.61)}`))
    ).toEqual([])
    const found = gridChecks(
      sheets(`${wire(70.8, 42.54, 83.5, 42.54)} ${part('Device:R', 'R1', 20, 40)}`)
    )
    // As KiCad reports them: a symbol at its first off-grid pin, a wire at its first off-grid end.
    expect(found.map((r) => [r.code, r.severity, r.items])).toEqual([
      ['off-grid', 'warning', ['R1.1']],
      ['off-grid', 'warning', ['wire@70.8,42.54']]
    ])
    expect(CHECK_RULES['off-grid']).toBeTruthy()
  })

  test("the project's connection grid is the one measured against", () => {
    const body = wire(50.8, 50.8, 52.07, 50.8)
    expect(gridChecks(sheets(body))).toEqual([])
    const coarse = gridChecks(sheets(body), mmToNm(spacingToMm(100, 'mil')))
    expect(coarse.map((r) => r.items)).toEqual([['wire@52.07,50.8']])
    expect(coarse[0].message).toContain('2.54 mm connection grid')
  })

  test('a reused sheet is reported once', () => {
    const [one] = sheets(wire(70.8, 42.54, 83.5, 42.54))
    expect(gridChecks([one, { ...one, sheetPath: '/other' }])).toHaveLength(1)
  })
})

describe('where a finding is, for the GUI to locate it', () => {
  test('an unconnected pin names its sheet, its symbol by uuid and the pin', () => {
    const [result] = unconnectedChecks(check(part('Device:R', 'R1', 100, 100)))
    expect(result.sheetPath).toBeTruthy()
    expect(result.targets).toEqual(['R1'])
    expect(result.subject).toBe(result.items[0])
  })

  test('a wire end has a place and selects its wire', () => {
    const uuidWire = wire(10, 10, 20, 10).replace('(stroke', '(uuid "w1") (stroke')
    const result = unconnectedChecks(check(uuidWire)).find((r) => r.code === 'unconnected-wire-end')
    expect(result?.sheetPath).toBeTruthy()
    expect(result?.targets).toEqual(['w1'])
    expect(result?.position).toBeDefined()
  })

  // The finding names the wire as items_get and items_delete take it, so an
  // agent can remove the stub without scanning for it; a write's check delta
  // carries only items, so without it every open end read as one.
  test('a wire end names its wire by the id an agent addresses it by', () => {
    const uuidWire = wire(10, 10, 20, 10).replace('(stroke', '(uuid "w1") (stroke')
    const named = unconnectedChecks(check(uuidWire)).filter(
      (r) => r.code === 'unconnected-wire-end'
    )
    expect(named.map((r) => r.items)).toEqual([['w1'], ['w1']])
    const bare = unconnectedChecks(check(`${wire(0, 0, 5, 0)} ${wire(10, 10, 20, 10)}`)).filter(
      (r) => r.code === 'unconnected-wire-end'
    )
    expect([...new Set(bare.flatMap((r) => r.items))].sort()).toEqual([
      'wire@0,0#0',
      'wire@10,10#1'
    ])
    expect(bare.every((r) => r.subject === `(${r.position!.x}, ${r.position!.y})`)).toBe(true)
  })

  test('a net rule names the net and selects every symbol on it', () => {
    const body = [
      part('Amp:BUF', 'U1', 100, 100),
      part('Amp:BUF', 'U2', 110, 100),
      wire(100, 100, 110, 100),
      label('OUT', 100, 100)
    ].join(' ')
    const conflict = electricalChecks(check(body)).find((r) => r.code === 'pin-conflict')
    expect(conflict?.subject).toBe('/OUT')
    expect([...(conflict?.targets ?? [])].sort()).toEqual(['U1', 'U2'])
  })

  test('the new fields leave what an agent reads unchanged', () => {
    const results = unconnectedChecks(check(part('Device:R', 'R1', 100, 100)))
    expect(Object.keys(groupChecks(results)[0]).sort()).toEqual(
      ['code', 'count', 'items', 'rule', 'severity'].sort()
    )
    expect(Object.keys(compactDelta(checkDelta([], results)).new[0]).sort()).toEqual(
      ['code', 'items', 'severity'].sort()
    )
  })
})

describe('every rule selects what it reports', () => {
  // One finding of every rule, each held to selecting its items in the editor:
  // a rule whose finding cannot be located is a click that does nothing.
  const uuidWire = (uuid: string, x1: number, y1: number, x2: number, y2: number): string =>
    wire(x1, y1, x2, y2).replace('(stroke', `(uuid "${uuid}") (stroke`)
  const unitPart = (
    reference: string,
    unit: number,
    x: number,
    y: number,
    value = 'v',
    footprint = ''
  ): string =>
    `(symbol (lib_id "Logic:QUAD") (at ${x} ${y} 0) (unit ${unit}) (uuid "${reference}-${unit}")
       (property "Reference" "${reference}" (at ${x} ${y} 0))
       (property "Value" "${value}" (at ${x} ${y} 0))
       (property "Footprint" "${footprint}" (at ${x} ${y} 0)))`
  const powerPart = (reference: string, x: number, y: number, value: string): string =>
    `(symbol (lib_id "power:GND") (at ${x} ${y} 0) (unit 1) (uuid "${reference}")
       (property "Reference" "${reference}" (at ${x} ${y} 0))
       (property "Value" "${value}" (at ${x} ${y} 0)))`
  const uuidLabel = (uuid: string, text: string, x: number, y: number): string =>
    `(label "${text}" (at ${x} ${y} 0) (effects (font (size 1.27 1.27))) (uuid "${uuid}"))`
  const main = parseKicadSchematic(
    doc(
      [
        part('Device:R', 'R1', 50.8, 50.8),
        part('Device:R', 'R7', 100.5, 50.8),
        part('MCU:U', 'U9', 152.4, 152.4),
        part('Amp:BUF', 'U1', 203.2, 101.6),
        part('Amp:BUF', 'U2', 213.36, 101.6),
        uuidWire('w-out', 203.2, 101.6, 213.36, 101.6),
        label('OUT', 203.2, 101.6),
        uuidWire('w-open', 10.5, 10.16, 20.32, 10.16),
        // A label on a net with one pin; a flag on a wired pin; a flag on nothing;
        // two names on one wire; a label joining two crossing wires.
        part('Device:R', 'R8', 304.8, 50.8),
        uuidWire('w-solo', 304.8, 54.61, 314.96, 54.61),
        uuidLabel('l-solo', 'SOLO', 314.96, 54.61),
        part('Device:R', 'R9', 355.6, 50.8),
        part('Device:R', 'R10', 365.76, 50.8),
        uuidWire('w-nc', 355.6, 54.61, 365.76, 54.61),
        '(no_connect (at 355.6 54.61) (uuid "nc-wired"))',
        uuidWire('w-bare', 406.4, 10.16, 416.56, 10.16),
        '(no_connect (at 406.4 10.16) (uuid "nc-bare"))',
        part('Device:R', 'R11', 431.8, 50.8),
        uuidWire('w-names', 431.8, 54.61, 441.96, 54.61),
        uuidLabel('l-aa', 'AA', 436.88, 54.61),
        uuidLabel('l-bb', 'BB', 441.96, 54.61),
        uuidWire('w-v', 469.9, 0, 469.9, 20.32),
        uuidWire('w-h', 459.74, 10.16, 480.06, 10.16),
        uuidLabel('l-x', 'X', 469.9, 10.16),
        // References: not annotated, duplicated, a unit the part lacks; a quad
        // part with one unit placed; one whose units disagree on value and footprint.
        part('Device:R', 'R?', 50.8, 203.2),
        part('Device:R', 'R20', 76.2, 203.2),
        part('Device:R', 'R20', 101.6, 203.2).replace('(uuid "R20")', '(uuid "R20b")'),
        part('Device:R', 'R21', 127, 203.2).replace('(unit 1)', '(unit 3)'),
        unitPart('U31', 1, 50.8, 228.6),
        unitPart('U32', 1, 101.6, 228.6, 'a', 'Pkg:A'),
        unitPart('U32', 2, 127, 228.6, 'b', 'Pkg:B'),
        unitPart('U32', 3, 152.4, 228.6, 'a', 'Pkg:A'),
        unitPart('U32', 4, 177.8, 228.6, 'a', 'Pkg:A'),
        // Names: two labels and two power ports differing in case, a label and a
        // power port the same way, a local and a global label of one name; a
        // ground pin off ground; a malformed stacked number; a spaced field
        // name; an unknown netclass; a lone global label; four wires at a point.
        uuidWire('w-sda', 50.8, 254, 60.96, 254),
        uuidLabel('l-sda', 'SDA', 50.8, 254),
        uuidWire('w-sda2', 76.2, 254, 86.36, 254),
        uuidLabel('l-sda2', 'sda', 76.2, 254),
        powerPart('#PWR50', 101.6, 254, 'GND'),
        powerPart('#PWR51', 111.76, 254, 'gnd'),
        uuidWire('w-vcc', 127, 254, 137.16, 254),
        uuidLabel('l-vcc', 'gnd', 127, 254),
        uuidWire('w-shared', 152.4, 254, 162.56, 254),
        uuidLabel('l-shared', 'SHARED', 152.4, 254),
        `(global_label "SHARED" (shape input) (at 162.56 254 0) (effects (font (size 1.27 1.27))) (uuid "g-shared"))`,
        `(global_label "LONE" (shape input) (at 177.8 254 0) (effects (font (size 1.27 1.27))) (uuid "g-lone"))`,
        `(symbol (lib_id "Chip:G") (at 203.2 254 0) (unit 1) (uuid "U40")
           (property "Reference" "U40" (at 203.2 254 0))
           (property "Value" "v" (at 203.2 254 0))
           (property " Custom" "x" (at 203.2 254 0))
           (property "Netclass" "Fast" (at 203.2 254 0))
           (property "Note" "\${UNDEFINED_THING}" (at 203.2 254 0)))`,
        uuidWire('w-g1', 203.2, 254, 213.36, 254),
        uuidLabel('l-g1', 'GND', 213.36, 254),
        uuidWire('w-g2', 203.2, 256.54, 213.36, 256.54),
        uuidLabel('l-g2', 'VX', 213.36, 256.54),
        uuidWire('w-4a', 228.6, 254, 238.76, 254),
        uuidWire('w-4b', 238.76, 254, 248.92, 254),
        uuidWire('w-4c', 238.76, 243.84, 238.76, 254),
        uuidWire('w-4d', 238.76, 254, 238.76, 264.16),
        // A bus whose global label and sheet port share no member; a net label on a bus.
        '(bus (pts (xy 355.6 304.8) (xy 381 304.8)) (stroke (width 0) (type default)) (uuid "b2"))',
        `(global_label "G[0..1]" (shape input) (at 360.68 304.8 0) (effects (font (size 1.27 1.27))) (uuid "g-bus"))`,
        `(hierarchical_label "H[5..6]" (shape input) (at 381 304.8 0) (effects (font (size 1.27 1.27))) (uuid "h-bus"))`,
        uuidLabel('l-onbus', 'NETY', 370.84, 304.8),
        // A net named X9 on a bus that carries D0 and D1.
        '(bus (pts (xy 304.8 304.8) (xy 330.2 304.8)) (stroke (width 0) (type default)) (uuid "b1"))',
        `(label "D[0..1]" (at 309.88 304.8 0) (effects (font (size 1.27 1.27))) (uuid "l-bus"))`,
        '(bus_entry (at 314.96 304.8) (size 2.54 2.54) (stroke (width 0) (type default)) (uuid "be1"))',
        uuidWire('w-x9', 317.5, 307.34, 327.66, 307.34),
        uuidLabel('l-x9', 'X9', 327.66, 307.34),
        `(sheet (at 203.2 203.2) (size 10.16 10.16) (uuid "box2")
          (property "Sheetname" "block" (at 203.2 202 0))
          (property "Sheetfile" "other.kicad_sch" (at 203.2 214 0)))`,
        part('Logic:IN', 'U5', 254, 50.8),
        wire(254, 50.8, 264.16, 50.8),
        uuidLabel('l-sense', 'SENSE', 264.16, 50.8),
        `(sheet (at 50.8 76.2) (size 10.16 10.16) (uuid "box")
          (property "Sheetname" "Block" (at 50.8 75 0))
          (property "Sheetfile" "block.kicad_sch" (at 50.8 87 0))
          (pin "IN" input (at 50.8 80.5 180) (uuid "sp")))`
      ].join(' ')
    )
  )
  const block = parseKicadSchematic(
    doc(
      '(hierarchical_label "OUT" (shape output) (at 25.4 25.4 0) (effects (font (size 1.27 1.27))) (uuid "hl"))'
    )
  )
  const sheets: SheetConnectivityInput[] = [
    { sheetPath: '/aaaaaaaa-0000-0000-0000-000000000000', namePath: '/', schematic: main },
    { sheetPath: '/aaaaaaaa-0000-0000-0000-000000000000/box', namePath: '/Block', schematic: block }
  ]
  // A library whose Device:R has other pins than the copy: a mismatch to report.
  const lookup: LibrarySymbolLookup = (libId) =>
    libId === 'Device:R' ? main.libSymbols.get('MCU:U') : undefined
  const results = allChecks(buildConnectivity(sheets), sheets, lookup, undefined, undefined, {
    netclasses: [],
    // The project cannot reach Chip (a symbol library) or any footprint library.
    symbolLibrary: (nickname) => (nickname === 'Chip' ? 'missing' : 'ok'),
    footprintLibrary: () => 'missing'
  })

  test.each(Object.keys(CHECK_RULES))('%s', (code) => {
    const found = results.filter((result) => result.code === code)
    expect(found.length).toBeGreaterThan(0)
    for (const result of found) {
      const sheet = sheets.find((entry) => entry.sheetPath === result.sheetPath)?.schematic
      expect(sheet).toBeDefined()
      expect(result.targets?.length).toBeGreaterThan(0)
      expect(itemRefsWithUuids(sheet!, result.targets!)).toHaveLength(result.targets!.length)
    }
  })
})

describe('connection rules on a label or sheet pin with nothing wired', () => {
  const run = (body: string): CheckResult[] => {
    const schematic = parseKicadSchematic(doc(body))
    const sheets = [{ sheetPath: '/', namePath: '/', schematic }]
    return connectionChecks(buildConnectivity(sheets), sheets)
  }

  test('a label on another label touches something; alone it touches nothing', () => {
    const lone = `(label "A" (at 50 50 0) (uuid "l1"))`
    expect(run(lone).map((r) => r.code)).toContain('label-dangling')
    // The net reaches a pin elsewhere, so only touching nothing would make it dangle.
    const stacked = `${lone} (global_label "A" (shape input) (at 50 50 0) (uuid "l2"))
      (global_label "A" (shape input) (at 60 50 0) (uuid "l3")) ${part('Device:R', 'R1', 60, 53.81)}`
    expect(
      run(stacked).filter((r) => r.code === 'label-dangling' && r.targets?.includes('l1'))
    ).toEqual([])
  })

  test('a flag that marks nothing names itself by the id items_get takes', () => {
    const [dangling] = run(`(no_connect (at 40.64 30.48) (uuid "nc1"))`).filter(
      (r) => r.code === 'no-connect-dangling'
    )
    expect(dangling.items).toEqual(['no_connect@40.64,30.48'])
    expect(dangling.subject).toBe('(40.64, 30.48)')
  })

  test('a sheet pin with a no-connect flag is open on purpose', () => {
    const sheet = `(sheet (at 20 20) (size 20 20) (uuid "s1")
      (property "Sheetname" "Block" (at 20 20 0))
      (property "Sheetfile" "block.kicad_sch" (at 20 20 0))
      (pin "OUT" output (at 40 30 0) (uuid "p1")))`
    expect(run(sheet).map((r) => r.code)).toContain('unconnected-sheet-port')
    expect(run(`${sheet} (no_connect (at 40 30))`).map((r) => r.code)).not.toContain(
      'unconnected-sheet-port'
    )
  })
})
