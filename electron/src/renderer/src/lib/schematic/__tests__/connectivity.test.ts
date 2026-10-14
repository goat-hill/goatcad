import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  buildConnectivity,
  buildSheetConnectivity,
  placedPinPosition,
  type SchematicConnectivity
} from '../connectivity'
import { parseKicadSchematic, type KicadSchematic, type Point } from '../../kicad/schematic'

// ---------------------------------------------------------------------------
// Fixture builders — minimal but grammatically real KiCad 8 output
// ---------------------------------------------------------------------------

const RESISTOR_LIB = `
  (lib_symbols
    (symbol "Device:R"
      (pin_numbers hide)
      (symbol "R_1_1"
        (pin passive line (at 0 3.81 270) (length 1.27)
          (name "~" (effects (font (size 1.27 1.27))))
          (number "1" (effects (font (size 1.27 1.27)))))
        (pin passive line (at 0 -3.81 90) (length 1.27)
          (name "~" (effects (font (size 1.27 1.27))))
          (number "2" (effects (font (size 1.27 1.27)))))))
    (symbol "power:GND"
      (power)
      (symbol "GND_1_1"
        (pin power_in line (at 0 0 270) (length 0) hide
          (name "GND" (effects (font (size 1.27 1.27))))
          (number "1" (effects (font (size 1.27 1.27))))))))
`

const sheetDoc = (body: string, uuid = 'aaaaaaaa-0000-0000-0000-000000000000'): string =>
  `(kicad_sch (version 20231120) (generator "test") (uuid "${uuid}") ${RESISTOR_LIB} ${body})`

const wire = (x1: number, y1: number, x2: number, y2: number): string =>
  `(wire (pts (xy ${x1} ${y1}) (xy ${x2} ${y2})) (stroke (width 0)))`

const resistor = (reference: string, x: number, y: number, angle = 0, uuid = reference): string =>
  `(symbol (lib_id "Device:R") (at ${x} ${y} ${angle}) (unit 1) (uuid "${uuid}")
     (property "Reference" "${reference}" (at ${x} ${y} 0))
     (property "Value" "10k" (at ${x} ${y} 0)))`

const gnd = (reference: string, x: number, y: number): string =>
  `(symbol (lib_id "power:GND") (at ${x} ${y} 0) (unit 1) (uuid "${reference}")
     (property "Reference" "${reference}" (at ${x} ${y} 0))
     (property "Value" "GND" (at ${x} ${y} 0)))`

const connectivityOf = (body: string): SchematicConnectivity =>
  buildSheetConnectivity(parseKicadSchematic(sheetDoc(body)))

// ---------------------------------------------------------------------------

describe('placedPinPosition', () => {
  const schematic = parseKicadSchematic(sheetDoc(resistor('R1', 88.9, 76.2, 90)))

  test('rotates lib-space pins into sheet space (y-down)', () => {
    const connectivity = buildSheetConnectivity(schematic)
    const positions = connectivity.nets
      .flatMap((net) => net.pins)
      .map((pin) => pin.position)
      .sort((a, b) => a.x - b.x)
    // R at (88.9, 76.2) rotated 90°: pins land 3.81 mm left/right of center.
    // Integer-nm placement is exact, so no float-noise snapping is needed.
    expect(positions).toEqual([
      { x: 85_090_000, y: 76_200_000 },
      { x: 92_710_000, y: 76_200_000 }
    ])
  })

  test('mirror x flips the pin across the horizontal axis', () => {
    const upright = parseKicadSchematic(sheetDoc(resistor('R1', 50, 50, 0)))
    const pin1 = upright.libSymbols.get('Device:R')!.variants[0].pins[0]
    expect(placedPinPosition(upright.symbols[0], pin1)).toEqual({ x: 50_000_000, y: 46_190_000 })
    upright.symbols[0].mirror = 'x'
    expect(placedPinPosition(upright.symbols[0], pin1)).toEqual({ x: 50_000_000, y: 53_810_000 })
  })

  test('a mirror applies after the rotation, about the axis as drawn', () => {
    // KiCad composes `(mirror x)` on top of the angle (`SCH_SYMBOL::SetOrientation`),
    // so at 270° the flip is about the symbol's horizontal axis on the sheet and
    // the two pins swap ends — what KiCad's netlist reports for such a part.
    const turned = parseKicadSchematic(sheetDoc(resistor('R1', 50, 50, 270)))
    const pin1 = turned.libSymbols.get('Device:R')!.variants[0].pins[0]
    expect(placedPinPosition(turned.symbols[0], pin1)).toEqual({ x: 53_810_000, y: 50_000_000 })
    turned.symbols[0].mirror = 'x'
    expect(placedPinPosition(turned.symbols[0], pin1)).toEqual({ x: 53_810_000, y: 50_000_000 })
    turned.symbols[0].mirror = 'y'
    expect(placedPinPosition(turned.symbols[0], pin1)).toEqual({ x: 46_190_000, y: 50_000_000 })
  })
})

describe('wire topology', () => {
  test('wires sharing an endpoint join one net', () => {
    const connectivity = connectivityOf(`${wire(10, 10, 20, 10)} ${wire(20, 10, 20, 20)}`)
    expect(connectivity.nets).toHaveLength(1)
    expect(connectivity.nets[0].wires).toHaveLength(2)
  })

  // kicad-cli 10's netlist: a wire end resting on another wire's interior is
  // not connected until a junction sits there, and ERC calls it an
  // "unconnected wire endpoint".
  test('a wire ending mid-segment stays apart without a junction', () => {
    const connectivity = connectivityOf(`${wire(10, 10, 30, 10)} ${wire(20, 20, 20, 10)}`)
    expect(connectivity.nets).toHaveLength(2)
    expect(connectivity.dangling.map((end) => end.position)).toContainEqual({
      x: 20_000_000,
      y: 10_000_000
    })
  })

  test('a junction on the tee connects it', () => {
    const connectivity = connectivityOf(
      `${wire(10, 10, 30, 10)} ${wire(20, 20, 20, 10)} (junction (at 20 10))`
    )
    expect(connectivity.nets).toHaveLength(1)
    expect(connectivity.dangling.map((end) => end.position)).not.toContainEqual({
      x: 20_000_000,
      y: 10_000_000
    })
  })

  test('crossing wires stay separate without a junction', () => {
    const connectivity = connectivityOf(`${wire(10, 10, 30, 10)} ${wire(20, 0, 20, 20)}`)
    expect(connectivity.nets).toHaveLength(2)
  })

  test('a junction connects crossing wires', () => {
    const connectivity = connectivityOf(
      `${wire(10, 10, 30, 10)} ${wire(20, 0, 20, 20)} (junction (at 20 10))`
    )
    expect(connectivity.nets).toHaveLength(1)
    expect(connectivity.nets[0].junctions).toHaveLength(1)
  })

  test('a corner (mid-polyline vertex) resting on a wire does not connect', () => {
    // V-shaped polyline whose middle vertex rests on another wire's interior;
    // its terminal ends are elsewhere. Only terminal ends T-connect.
    const vee = `(wire (pts (xy 15 -5) (xy 20 0) (xy 25 -5)) (stroke (width 0)))`
    const connectivity = connectivityOf(`${wire(10, 0, 30, 0)} ${vee}`)
    expect(connectivity.nets).toHaveLength(2)
  })

  // Wires are looked up by position, so these pin the lookup to the geometry.
  test.each([
    ['far along a long wire', wire(0, 10, 250, 10), 'label "X" (at 237.49 10 0)'],
    ['on a diagonal wire', wire(10, 10, 60, 60), 'label "X" (at 35 35 0)'],
    ['at negative coordinates', wire(-30, -10, -10, -10), 'label "X" (at -20 -10 0)'],
    ['within tolerance across a cell edge', wire(10, 2.54, 30, 2.54), 'label "X" (at 20 2.535 0)']
  ])('a label %s joins the wire', (_, wireText, label) => {
    const connectivity = connectivityOf(`${wireText} (${label})`)
    expect(connectivity.nets).toHaveLength(1)
    expect(connectivity.nets[0].labels).toHaveLength(1)
  })

  test('a label beside a wire, past the tolerance, stays apart', () => {
    const connectivity = connectivityOf(`${wire(10, 2.54, 30, 2.54)} (label "X" (at 20 2.52 0))`)
    expect(connectivity.nets).toHaveLength(2)
  })
})

describe('pins and labels', () => {
  // kicad-cli 10: a pin on a wire's interior is "pin not connected", and the
  // netlist puts it on its own `unconnected-(…)` net, until a junction joins it.
  test('a pin landing on a wire interior does not connect', () => {
    // R1 rotated 90° at (20,10): pins at x=16.19 and x=23.81 on y=10.
    const connectivity = connectivityOf(`${wire(10, 10, 30, 10)} ${resistor('R1', 20, 10, 90)}`)
    expect(connectivity.nets).toHaveLength(3)
    expect(connectivity.nets.find((net) => net.wires.length)?.pins).toHaveLength(0)
    expect(connectivity.dangling.map((end) => end.kind).sort()).toEqual([
      'pin',
      'pin',
      'wire',
      'wire'
    ])
  })

  test('a junction on the pin connects it', () => {
    const connectivity = connectivityOf(
      `${wire(10, 10, 30, 10)} ${resistor('R1', 20, 10, 90)} (junction (at 16.19 10))`
    )
    const wired = connectivity.nets.find((net) => net.wires.length)
    expect(wired?.pins.map((pin) => pin.pin.number)).toEqual(['1'])
    expect(connectivity.dangling.map((end) => end.kind).sort()).toEqual(['pin', 'wire', 'wire'])
  })

  test('local labels merge nets by name within the sheet', () => {
    const connectivity = connectivityOf(
      `${wire(10, 10, 20, 10)} (label "CLK" (at 10 10 0))
       ${wire(40, 40, 50, 40)} (label "CLK" (at 50 40 0))`
    )
    expect(connectivity.nets).toHaveLength(1)
    expect(connectivity.nets[0].name).toBe('/CLK')
    expect(connectivity.nets[0].nameSource).toBe('local_label')
  })

  test('a label mid-wire attaches to the wire', () => {
    const connectivity = connectivityOf(`${wire(10, 10, 30, 10)} (label "MID" (at 20 10 0))`)
    expect(connectivity.nets).toHaveLength(1)
    expect(connectivity.nets[0].name).toBe('/MID')
  })

  test('a global or hierarchical label mid-wire attaches too', () => {
    for (const [label, name] of [
      ['(global_label "GG" (shape input) (at 20 10 0))', 'GG'],
      ['(hierarchical_label "HH" (shape input) (at 20 10 0))', '/HH']
    ]) {
      const connectivity = connectivityOf(`${wire(10, 10, 30, 10)} ${label}`)
      expect(connectivity.nets).toHaveLength(1)
      expect(connectivity.nets[0].name).toBe(name)
    }
  })

  test('a label on a crossing joins both wires, as a junction does', () => {
    const connectivity = connectivityOf(
      `${wire(10, 10, 30, 10)} ${wire(20, 0, 20, 20)} (label "X" (at 20 10 0))`
    )
    expect(connectivity.nets).toHaveLength(1)
    expect(connectivity.nets[0].wires).toHaveLength(2)
  })

  test('a sheet pin mid-wire attaches to the wire', () => {
    const connectivity = connectivityOf(
      `${wire(10, 10, 30, 10)}
       (sheet (at 15 10) (size 10 5) (uuid "s1")
         (property "Sheetname" "Child" (at 15 9 0))
         (property "Sheetfile" "child.kicad_sch" (at 15 16 0))
         (pin "P" input (at 20 10 90) (uuid "p1")))`
    )
    expect(connectivity.nets).toHaveLength(1)
    expect(connectivity.nets[0].sheetPins).toHaveLength(1)
  })

  test('power symbols drive a global net named by their value', () => {
    const connectivity = connectivityOf(
      `${wire(10, 10, 20, 10)} ${gnd('#PWR01', 10, 10)}
       ${wire(40, 40, 50, 40)} ${gnd('#PWR02', 40, 40)}`
    )
    expect(connectivity.nets).toHaveLength(1)
    expect(connectivity.nets[0].name).toBe('GND')
    expect(connectivity.nets[0].nameSource).toBe('power')
  })

  test('power beats local labels; global labels beat power', () => {
    const powered = connectivityOf(
      `${wire(10, 10, 20, 10)} ${gnd('#PWR01', 10, 10)} (label "DIRT" (at 20 10 0))`
    )
    expect(powered.nets[0].name).toBe('GND')

    const global = connectivityOf(
      `${wire(10, 10, 20, 10)} ${gnd('#PWR01', 10, 10)}
       (global_label "EARTH" (at 20 10 0) (shape passive))`
    )
    expect(global.nets[0].name).toBe('EARTH')
    expect(global.nets[0].nameSource).toBe('global_label')
  })

  test('unlabeled pin-to-pin nets get KiCad-style fallback names', () => {
    // R1 (rot 90 at 20,10): pins at (16.19,10) and (23.81,10).
    // R2 (rot 90 at 30,20): pins at (26.19,20) and (33.81,20).
    const connectivity = connectivityOf(
      `${wire(23.81, 10, 23.81, 20)} ${wire(23.81, 20, 26.19, 20)}
       ${resistor('R1', 20, 10, 90)} ${resistor('R2', 30, 20, 90, 'R2u')}`
    )
    const named = connectivity.nets.find((net) => net.name.startsWith('Net-'))
    expect(named).toBeDefined()
    expect(named!.pins).toHaveLength(2)
    // Alphabetically first pin names the net: R1-Pad2 sorts before R2-Pad1.
    expect(named!.name).toBe('Net-(R1-Pad2)')
  })
})

describe('no-connects and dangling detection', () => {
  test('an open wire end is dangling', () => {
    const connectivity = connectivityOf(`${wire(10, 10, 20, 10)} (label "X" (at 10 10 0))`)
    expect(connectivity.dangling).toMatchObject([
      { sheetPath: '/', position: { x: 20_000_000, y: 10_000_000 }, kind: 'wire', wireIndex: 0 }
    ])
  })

  test('an unconnected pin is dangling unless no-connect flagged', () => {
    const bare = connectivityOf(resistor('R1', 20, 10, 90))
    expect(bare.dangling.map((end) => end.kind)).toEqual(['pin', 'pin'])
    expect(bare.nets.every((net) => net.name.startsWith('unconnected-'))).toBe(true)

    const flagged = connectivityOf(
      `${resistor('R1', 20, 10, 90)} (no_connect (at 16.19 10)) (no_connect (at 23.81 10))`
    )
    expect(flagged.dangling).toHaveLength(0)
    expect(flagged.nets.flatMap((net) => net.pins).every((pin) => pin.noConnect)).toBe(true)
  })

  test('a label or sheet pin with nothing at its anchor is open, on a wire end or interior it is not', () => {
    const connectivity = connectivityOf(
      `${wire(10, 10, 20, 10)} (label "ON_END" (at 10 10 0)) (label "ON_WIRE" (at 15 10 0))
       (global_label "ALONE" (shape input) (at 40 40 0))
       (sheet (at 50 50) (size 20 10) (uuid "bbbbbbbb-0000-0000-0000-000000000000")
         (property "Sheetname" "S" (at 50 49 0)) (property "Sheetfile" "s.kicad_sch" (at 50 61 0))
         (pin "P" input (at 50 55 180) (uuid "cccccccc-0000-0000-0000-000000000000")))`
    )
    expect(connectivity.openAnchors).toEqual([
      { sheetPath: '/', position: { x: 40_000_000, y: 40_000_000 }, kind: 'global_label' },
      { sheetPath: '/', position: { x: 50_000_000, y: 55_000_000 }, kind: 'sheet_pin' }
    ])
    // Not findings: the open wire end alone is.
    expect(connectivity.dangling.map((end) => end.kind)).toEqual(['wire'])
  })
})

describe('no-connect flags and bus entries, as kicad-cli 10 reads them', () => {
  test('a no-connect on a wire interior joins nothing', () => {
    const connectivity = connectivityOf(`${wire(10, 10, 30, 10)} (no_connect (at 20 10))`)
    expect(connectivity.nets).toHaveLength(1)
    expect(connectivity.nets[0].hasNoConnect).toBe(false)
  })

  test('a flag on a wired pin names its net unconnected', () => {
    // R1 pin 2 (23.81,10) wired to R2 pin 1 (26.19,10), flagged: KiCad exports
    // `unconnected-(R1-Pad2)` with both pins on it.
    const connectivity = connectivityOf(
      `${wire(23.81, 10, 26.19, 10)} ${resistor('R1', 20, 10, 90)}
       ${resistor('R2', 30, 10, 90, 'R2u')} (no_connect (at 23.81 10))`
    )
    const flagged = connectivity.nets.find((net) => net.hasNoConnect)
    expect(flagged?.name).toBe('unconnected-(R1-Pad2)')
    expect(flagged?.pins).toHaveLength(2)
  })

  test('a wire ending on a bus entry is not dangling there', () => {
    const connectivity = connectivityOf(
      `(bus (pts (xy 0 0) (xy 40 0))) (bus_entry (at 20 0) (size 2.54 2.54))
       ${wire(22.54, 2.54, 22.54, 10)} (label "A" (at 22.54 10 0))`
    )
    expect(connectivity.dangling).toEqual([])
  })

  test('a bus entry resting on a wire interior connects nothing', () => {
    const connectivity = connectivityOf(
      `${wire(10, 10, 30, 10)} (label "A" (at 10 10 0)) (label "A" (at 30 10 0))
       (bus_entry (at 17.46 7.46) (size 2.54 2.54))`
    )
    expect(connectivity.nets).toHaveLength(1)
    expect(connectivity.dangling).toEqual([])
  })
})

describe('hierarchy', () => {
  const CHILD_UUID = 'cccccccc-0000-0000-0000-000000000000'
  const SHEET_NODE_UUID = 'dddddddd-0000-0000-0000-000000000000'

  test('sheet pins bind to matching hierarchical labels in the child instance', () => {
    const parent = parseKicadSchematic(
      sheetDoc(
        `${wire(10, 10, 20, 10)} (label "PCLK" (at 10 10 0))
         (sheet (at 20 5) (size 20 10) (uuid "${SHEET_NODE_UUID}")
           (property "Sheetname" "Timing" (at 20 5 0))
           (property "Sheetfile" "child.kicad_sch" (at 20 5 0))
           (pin "CLK" input (at 20 10 180)))`
      )
    )
    const child = parseKicadSchematic(
      sheetDoc(
        `${wire(50, 50, 60, 50)} (hierarchical_label "CLK" (at 50 50 0) (shape input))`,
        CHILD_UUID
      )
    )
    const rootPath = `/${parent.uuid}`
    const connectivity = buildConnectivity([
      { sheetPath: rootPath, namePath: '/', schematic: parent },
      { sheetPath: `${rootPath}/${SHEET_NODE_UUID}`, namePath: '/Timing', schematic: child }
    ])
    expect(connectivity.nets).toHaveLength(1)
    // Local label outranks the hierarchical name.
    expect(connectivity.nets[0].name).toBe('/PCLK')
    expect(connectivity.nets[0].sheetPins).toHaveLength(1)
    expect(connectivity.nets[0].labels).toHaveLength(2)
  })

  test("a reused sheet's names read its sheet symbol's fields and page", () => {
    const box = (uuid: string, y: number, param: string): string =>
      `(sheet (at 20 ${y}) (size 20 10) (uuid "${uuid}")
         (property "Sheetname" "S${y}" (at 20 ${y} 0))
         (property "Sheetfile" "child.kicad_sch" (at 20 ${y} 0))
         (property "param" "${param}" (at 20 ${y} 0))
         (pin "\${param}" input (at 20 ${y + 5} 180)))`
    const parent = parseKicadSchematic(
      sheetDoc(
        `${box('s1', 0, 'ONE')} ${wire(10, 5, 20, 5)} (label "ONE" (at 10 5 0))
         ${box('s2', 40, 'TWO')} ${wire(10, 45, 20, 45)} (label "TWO" (at 10 45 0))`
      )
    )
    const child = parseKicadSchematic(
      sheetDoc(
        `${wire(50, 50, 60, 50)} (hierarchical_label "\${param}" (at 50 50 0) (shape input))
         ${gnd('#PWR1', 60, 50)}`,
        CHILD_UUID
      ).replace('(property "Value" "GND"', '(property "Value" "REF${#}"')
    )
    const root = `/${parent.uuid}`
    const connectivity = buildConnectivity([
      { sheetPath: root, namePath: '/', page: '1', schematic: parent },
      { sheetPath: `${root}/s1`, namePath: '/S0', page: '2', schematic: child },
      { sheetPath: `${root}/s2`, namePath: '/S40', page: '3', schematic: child }
    ])
    const named = connectivity.nets
      .map((net) => [net.name, net.labels.map((entry) => entry.label.text).sort()])
      .sort()
    expect(named).toEqual([
      ['REF2', ['${param}', 'ONE']],
      ['REF3', ['${param}', 'TWO']]
    ])
  })

  test('global labels merge across sheets', () => {
    const a = parseKicadSchematic(
      sheetDoc(`${wire(10, 10, 20, 10)} (global_label "VBUS" (at 10 10 0) (shape passive))`)
    )
    const b = parseKicadSchematic(
      sheetDoc(
        `${wire(30, 30, 40, 30)} (global_label "VBUS" (at 30 30 0) (shape passive))`,
        CHILD_UUID
      )
    )
    const connectivity = buildConnectivity([
      { sheetPath: '/a', namePath: '/', schematic: a },
      { sheetPath: '/a/b', namePath: '/B', schematic: b }
    ])
    expect(connectivity.nets).toHaveLength(1)
    expect(connectivity.nets[0].name).toBe('VBUS')
    expect(connectivity.nets[0].wires).toHaveLength(2)
  })
})

// Each expected name is what `kicad-cli sch export netlist` (10.0.6) gives the same design.
describe('a net across sheets takes the name KiCad gives it', () => {
  /** A sheet symbol; its uuid is its name in lower case. */
  const sheetBox = (name: string, x: number, pin: string): string =>
    `(sheet (at ${x} 0) (size 10 20) (uuid "${name.toLowerCase()}")
       (property "Sheetname" "${name}" (at ${x} 0 0))
       (property "Sheetfile" "${name}.kicad_sch" (at ${x} 0 0)) ${pin})`
  const hier = (text: string): string => `(hierarchical_label "${text}" (at 50 50 0) (shape input))`
  /** A child sheet: a hierarchical label wired to a resistor, plus `extra`. */
  const leaf = (text: string, reference: string, extra = ''): string =>
    `${hier(text)} ${wire(50, 50, 60, 50)} ${resistor(reference, 60, 53.81)} ${extra}`
  /** Sheets by name path, the root's `''`. */
  const design = (bodies: Record<string, string>): SchematicConnectivity =>
    buildConnectivity(
      Object.entries(bodies).map(([path, body], index) => ({
        sheetPath: `/root${path.toLowerCase()}`,
        namePath: path || '/',
        schematic: parseKicadSchematic(
          sheetDoc(body, `00000000-0000-0000-0000-00000000000${index}`)
        )
      }))
    )
  const nameOfPin = (connectivity: SchematicConnectivity, reference: string): string =>
    connectivity.nets.find((net) =>
      net.pins.some((pin) => pin.reference === reference && pin.pin.number === '1')
    )!.name

  // Run 11: MCU.USB_DP is an input pin, Power.USB_DP an output, wired together on the root.
  const runEleven = (powerExtra: string): SchematicConnectivity =>
    design({
      '': `${sheetBox('MCU', 20, '(pin "USB_DP" input (at 30 10 0))')}
           ${sheetBox('Power', 60, '(pin "USB_DP" output (at 60 10 180))')}
           ${wire(30, 10, 60, 10)}`,
      '/MCU': leaf('USB_DP', 'R1'),
      '/Power': leaf('USB_DP', 'R2', powerExtra)
    })

  test("a child's local label beats every hierarchical label and the sheet pins above it", () => {
    const connectivity = runEleven('(label "USB_DP" (at 55 50 0))')
    expect(nameOfPin(connectivity, 'R1')).toBe('/Power/USB_DP')
    expect(nameOfPin(connectivity, 'R2')).toBe('/Power/USB_DP')
  })

  test('two hierarchical labels at one depth: the lower name, whichever pin is the output', () => {
    expect(nameOfPin(runEleven(''), 'R1')).toBe('/MCU/USB_DP')
  })

  test('drivers of one kind at two depths: the shallower sheet wins over the lower name', () => {
    const connectivity = design({
      '': `${sheetBox('Child', 20, '(pin "X" input (at 30 10 0))')}
           ${wire(30, 10, 40, 10)} (label "N" (at 40 10 0)) ${resistor('R1', 40, 13.81)}`,
      '/Child': leaf('X', 'R2', '(label "M" (at 55 50 0))')
    })
    expect(nameOfPin(connectivity, 'R2')).toBe('/N')
  })

  test('hierarchical labels at two depths: the shallower one', () => {
    const connectivity = design({
      '': `${sheetBox('Zed', 20, '(pin "Q" input (at 30 10 0))')}
           ${sheetBox('Alpha', 60, '(pin "Q" input (at 60 10 180))')}
           ${wire(30, 10, 60, 10)}`,
      '/Zed': leaf('Q', 'R1'),
      '/Alpha': `${hier('Q')} ${wire(50, 50, 70, 50)}
                 ${sheetBox('A', 70, '(pin "Q" input (at 70 50 180))')}`,
      '/Alpha/A': leaf('Q', 'R2')
    })
    expect(nameOfPin(connectivity, 'R1')).toBe('/Alpha/Q')
  })

  test('a stronger driver wins from the deepest sheet', () => {
    const connectivity = design({
      '': `${sheetBox('Mid', 20, '(pin "X" input (at 30 10 0))')}
           ${wire(30, 10, 40, 10)} ${resistor('R1', 40, 13.81)}`,
      '/Mid': `${hier('X')} ${wire(50, 50, 70, 50)}
               ${sheetBox('Leaf', 70, '(pin "X" input (at 70 50 180))')}`,
      '/Mid/Leaf': leaf('X', 'R2', '(label "Z" (at 55 50 0))')
    })
    expect(nameOfPin(connectivity, 'R1')).toBe('/Mid/Leaf/Z')
  })

  test('sheet pins with nothing behind them: the output pin, scoped to the sheet it is drawn on', () => {
    const connectivity = design({
      '': `${sheetBox('Ka', 20, '(pin "A" input (at 30 10 0))')}
           ${sheetBox('Kb', 60, '(pin "B" output (at 60 10 180))')}
           ${wire(30, 10, 60, 10)} ${resistor('R1', 45, 13.81)} (junction (at 45 10))`,
      '/Ka': resistor('R2', 60, 53.81),
      '/Kb': resistor('R3', 60, 53.81)
    })
    expect(nameOfPin(connectivity, 'R1')).toBe('/B')
  })
})

describe('buses', () => {
  const PARENT_SHEET = 'dddddddd-0000-0000-0000-000000000000'
  const CHILD_UUID = 'cccccccc-0000-0000-0000-000000000000'
  const netNames = (connectivity: SchematicConnectivity): string[][] =>
    connectivity.nets.map((net) => net.labels.map((l) => l.label.text).sort()).sort()

  const parentWith = (busLabel: string, pinName: string, netLabels: string): KicadSchematic =>
    parseKicadSchematic(
      sheetDoc(
        `(bus (pts (xy 10 10) (xy 20 10))) (label "${busLabel}" (at 12 10 0))
         ${netLabels}
         (sheet (at 20 5) (size 20 10) (uuid "${PARENT_SHEET}")
           (property "Sheetname" "Block" (at 20 5 0))
           (property "Sheetfile" "child.kicad_sch" (at 20 5 0))
           (pin "${pinName}" input (at 20 10 180)))`
      )
    )
  const childWith = (hierLabel: string, netLabels: string): KicadSchematic =>
    parseKicadSchematic(
      sheetDoc(
        `(bus (pts (xy 50 50) (xy 60 50))) (hierarchical_label "${hierLabel}" (at 50 50 0) (shape input))
         ${netLabels}`,
        CHILD_UUID
      )
    )
  const build = (parent: KicadSchematic, child: KicadSchematic): SchematicConnectivity => {
    const root = `/${parent.uuid}`
    return buildConnectivity([
      { sheetPath: root, namePath: '/', schematic: parent },
      { sheetPath: `${root}/${PARENT_SHEET}`, namePath: '/Block', schematic: child }
    ])
  }

  test('a vector bus through a sheet pin joins its members by position', () => {
    const parent = parentWith(
      'DATA[0..1]',
      'D[0..1]',
      `${wire(0, 30, 10, 30)} (label "DATA0" (at 0 30 0)) ${wire(0, 40, 10, 40)} (label "DATA1" (at 0 40 0))`
    )
    const child = childWith(
      'D[0..1]',
      `${wire(70, 30, 80, 30)} (label "D0" (at 70 30 0)) ${wire(70, 40, 80, 40)} (label "D1" (at 70 40 0))`
    )
    expect(netNames(build(parent, child))).toEqual([
      ['D0', 'DATA0'],
      ['D1', 'DATA1']
    ])
  })

  test('a group bus joins by member name, and a bus label names no net', () => {
    const parent = parentWith(
      'SFP0{TX RX}',
      'SFP{TX RX}',
      `${wire(0, 30, 10, 30)} (label "SFP0.RX" (at 0 30 0))`
    )
    const child = childWith('SFP{TX RX}', `${wire(70, 30, 80, 30)} (label "SFP.RX" (at 70 30 0))`)
    expect(netNames(build(parent, child))).toEqual([['SFP.RX', 'SFP0.RX']])
  })

  test("an alias the project file defines names a bus's members", () => {
    const parent = parentWith('{AD}', '{AD}', `${wire(0, 30, 10, 30)} (label "AD.2" (at 0 30 0))`)
    const child = childWith('{AD}', `${wire(70, 30, 80, 30)} (label "AD.2" (at 70 30 0))`)
    const root = `/${parent.uuid}`
    const inputs = [
      { sheetPath: root, namePath: '/', schematic: parent },
      { sheetPath: `${root}/${PARENT_SHEET}`, namePath: '/Block', schematic: child }
    ]
    expect(netNames(buildConnectivity(inputs))).toEqual([['AD.2'], ['AD.2']])
    expect(netNames(buildConnectivity(inputs, { busAliases: { AD: ['AD.1', 'AD.2'] } }))).toEqual([
      ['AD.2', 'AD.2']
    ])
  })

  test('labels spelled with a slash or its escape are one name', () => {
    const connectivity = connectivityOf(
      `${wire(10, 10, 20, 10)} (label "A/B" (at 10 10 0)) ${wire(30, 30, 40, 30)} (label "A{slash}B" (at 30 30 0))`
    )
    expect(connectivity.nets).toHaveLength(1)
  })

  test("same-named pins of two sheet symbols are two nets: a chain of one sheet's instances", () => {
    const sheetBox = (uuid: string, x: number): string =>
      `(sheet (at ${x} 0) (size 10 20) (uuid "${uuid}")
         (property "Sheetname" "S${x}" (at ${x} 0 0))
         (property "Sheetfile" "stage.kicad_sch" (at ${x} 0 0))
         (pin "OUT" output (at ${x + 10} 10 0)))`
    const connectivity = connectivityOf(
      `${sheetBox('s1', 10)} ${sheetBox('s2', 40)} ${wire(20, 10, 30, 10)} ${wire(50, 10, 60, 10)}`
    )
    expect(connectivity.nets).toHaveLength(2)
  })
})

describe('legacy power symbols', () => {
  // KiCad renames a pre-KiCad-7 power symbol with a hidden pin by that pin on
  // load, so a GND symbol whose value reads GNDA still lands on GND.
  const legacy = (version: number): SchematicConnectivity =>
    buildSheetConnectivity(
      parseKicadSchematic(
        sheetDoc(
          `${wire(10, 10, 20, 10)} ${gnd('#PWR1', 10, 10).replace('"Value" "GND"', '"Value" "GNDA"')}`
        ).replace('(version 20231120)', `(version ${version})`)
      )
    )

  test('an old file names the net by the hidden pin', () => {
    expect(legacy(20211123).nets[0].name).toBe('GND')
  })

  test('a current file names it by the value', () => {
    expect(legacy(20231120).nets[0].name).toBe('GNDA')
  })
})

describe('local power symbols', () => {
  // `(power local)`: the port names its own sheet's net, as a local label does.
  const localGnd = (reference: string, x: number, y: number): string =>
    gnd(reference, x, y).replace('power:GND', 'power:LGND')
  const withLocal = (body: string): SchematicConnectivity =>
    buildSheetConnectivity(
      parseKicadSchematic(
        sheetDoc(body).replace(
          '(symbol "power:GND"',
          `(symbol "power:LGND" (power local)
             (symbol "LGND_1_1"
               (pin power_in line (at 0 0 270) (length 0) hide
                 (name "GND" (effects (font (size 1.27 1.27))))
                 (number "1" (effects (font (size 1.27 1.27)))))))
           (symbol "power:GND"`
        )
      )
    )

  test('two local ports of one name join, under the sheet path', () => {
    const c = withLocal(
      `${wire(10, 10, 20, 10)} ${wire(40, 10, 50, 10)} ${localGnd('#PWR1', 10, 10)} ${localGnd('#PWR2', 40, 10)}`
    )
    expect(c.nets.map((n) => n.name)).toEqual(['/GND'])
  })

  test('a local port stays apart from a global one of the same name', () => {
    const c = withLocal(
      `${wire(10, 10, 20, 10)} ${wire(40, 10, 50, 10)} ${localGnd('#PWR1', 10, 10)} ${gnd('#PWR2', 40, 10)}`
    )
    expect(c.nets.map((n) => n.name).sort()).toEqual(['/GND', 'GND'])
  })
})

describe('lookups', () => {
  test('netOfPin, netOfWire, and netAt agree', () => {
    const connectivity = connectivityOf(
      `${wire(10, 10, 30, 10)} ${resistor('R1', 20, 10, 90, 'r1-uuid')} (junction (at 16.19 10))
       (label "SIG" (at 10 10 0))`
    )
    const net = connectivity.nets[0]
    expect(connectivity.netOfPin('/', 'r1-uuid', '1')).toBe(net)
    expect(connectivity.netOfWire('/', 0)).toBe(net)
    expect(connectivity.netAt('/', { x: 25_000_000, y: 10_000_000 } as Point)).toBe(net)
    expect(connectivity.netAt('/', { x: 25_000_000, y: 12_000_000 } as Point)).toBeUndefined()
  })

  test('netAt accepts a hover tolerance and picks the nearest item', () => {
    const connectivity = connectivityOf(
      `${wire(10, 10, 30, 10)} (label "TOP" (at 10 10 0))
       ${wire(10, 12, 30, 12)} (label "LOW" (at 10 12 0))`
    )
    // 0.8 mm above the lower wire: inside a 1 mm radius of both, LOW is nearer.
    expect(connectivity.netAt('/', { x: 20_000_000, y: 11_200_000 } as Point, 1_000_000)).toBe(
      connectivity.nets.find((net) => net.name === '/LOW')
    )
    // Beyond tolerance finds nothing.
    expect(
      connectivity.netAt('/', { x: 20_000_000, y: 16_000_000 } as Point, 1_000_000)
    ).toBeUndefined()
  })
})

describe('power-supply fixture', () => {
  // R1 sits across the POWER_GOOD wire with no junction on either pin. kicad-cli
  // 10 exports two `unconnected-(R1-PadN)` nets and flags both pins, the label
  // and the wire's open end; the label's own end is not reported.
  test('leaves R1 off the POWER_GOOD net it rests on', () => {
    const source = readFileSync(
      resolve(
        process.cwd(),
        'src/renderer/src/lib/schematic/__tests__/fixtures/power_supply.kicad_sch'
      ),
      'utf8'
    )
    const connectivity = buildSheetConnectivity(parseKicadSchematic(source))
    expect(connectivity.nets.map((net) => net.name).sort()).toEqual([
      '/POWER_GOOD',
      'unconnected-(R1-Pad1)',
      'unconnected-(R1-Pad2)'
    ])
    const net = connectivity.nets.find((entry) => entry.name === '/POWER_GOOD')!
    expect(net.wires).toHaveLength(2)
    expect(net.pins).toHaveLength(0)
    expect(
      connectivity.dangling
        .map((end) => `${end.kind}@${end.position.x / 1e6},${end.position.y / 1e6}`)
        .sort()
    ).toEqual(['pin@85.09,76.2', 'pin@92.71,76.2', 'wire@76.2,76.2'])
  })
})

describe('a hidden pin does not stand in for a connection', () => {
  // Stacked pads: a symbol draws three grounds at one coordinate with two of
  // them hidden. That is a drawing device for not repeating the same net three
  // times, not a connection anyone made — so with nothing else attached the node
  // is floating and the visible pin must still say so.
  const STACKED_LIB = `
  (lib_symbols
    (symbol "Local:U"
      (symbol "U_1_1"
        (pin power_in line (at 0 -5.08 90) (length 2.54)
          (name "GND" (effects (font (size 1.27 1.27))))
          (number "1" (effects (font (size 1.27 1.27)))))
        (pin passive line (at 0 -5.08 90) (length 2.54) (hide yes)
          (name "GND" (effects (font (size 1.27 1.27))))
          (number "2" (effects (font (size 1.27 1.27)))))
        (pin passive line (at 0 -5.08 90) (length 2.54) (hide yes)
          (name "GND" (effects (font (size 1.27 1.27))))
          (number "3" (effects (font (size 1.27 1.27)))))))
  )`

  const sheet = (extra = ''): string => `(kicad_sch (version 20231120) (generator "t")
    (uuid "root") (paper "A4")
    ${STACKED_LIB}
    (symbol (lib_id "Local:U") (at 100 100 0) (unit 1) (uuid "u1")
      (property "Reference" "U1" (at 100 100 0))
      (pin "1" (uuid "p1")) (pin "2" (uuid "p2")) (pin "3" (uuid "p3")))
    ${extra}
  )`

  test('the visible pin of an unwired stack is still dangling', () => {
    const c = buildSheetConnectivity(parseKicadSchematic(sheet()))
    const pins = c.dangling.filter((end) => end.kind === 'pin')
    expect(pins.map((end) => end.pinNumber)).toEqual(['1'])
    // Symbol space is y-up and the sheet is y-down, so the pin at local
    // (0, -5.08) lands 5.08 BELOW the symbol origin on the sheet.
    expect(pins[0].position).toEqual({ x: 100_000_000, y: 105_080_000 })
  })

  test('the hidden pads are not reported themselves', () => {
    const c = buildSheetConnectivity(parseKicadSchematic(sheet()))
    expect(c.dangling.some((end) => end.pinNumber === '2' || end.pinNumber === '3')).toBe(false)
  })

  test('all three pads are still one net — this changes the marker, not the wiring', () => {
    const c = buildSheetConnectivity(parseKicadSchematic(sheet()))
    const net = c.nets.find((n) => n.pins.some((p) => p.pin.number === '1'))
    expect(net?.pins.map((p) => p.pin.number).sort()).toEqual(['1', '2', '3'])
  })

  test("another symbol's hidden pin attaches: a wire or pin on a power symbol is not open", () => {
    const c = connectivityOf(`${wire(10, 10, 20, 10)} ${gnd('#PWR1', 20, 10)}`)
    expect(c.dangling.map((end) => end.position.x)).toEqual([10_000_000])
  })

  test('a wire onto the stack clears the marker, as it should', () => {
    const wired = sheet(
      `(wire (pts (xy 100 105.08) (xy 120 105.08)) (stroke (width 0) (type default)) (uuid "w"))`
    )
    const c = buildSheetConnectivity(parseKicadSchematic(wired))
    expect(c.dangling.some((end) => end.kind === 'pin' && end.pinNumber === '1')).toBe(false)
  })
})
