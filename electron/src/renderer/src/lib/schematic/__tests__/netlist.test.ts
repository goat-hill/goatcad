import { describe, expect, test } from 'vitest'
import { netlistDate, netlistNets, netlistPathFor, strNumCmp, writeNetlist } from '../netlist'
import { buildConnectivity, type SheetConnectivityInput } from '../connectivity'
import { parseKicadSchematic } from '../../kicad/schematic'
import {
  findChild,
  findChildren,
  getAtomValues,
  getToken,
  parseSExpr,
  type SExprList
} from '../../kicad/sexpr'
import type { SyncDesign } from '../../board/boardSync'
import type { SheetSource } from '../../componentsTable'
import { loadDesign, readNetlist } from './netlistFixtures'
import { CANARY_SCHEMATIC } from '../../__tests__/canaryFixture'

// ---------------------------------------------------------------------------
// Fixtures — small, grammatically real
// ---------------------------------------------------------------------------

const LIB = `
  (lib_symbols
    (symbol "Device:R"
      (property "Reference" "R" (at 0 0 0))
      (property "Value" "R" (at 0 0 0))
      (property "Description" "Resistor" (at 0 0 0))
      (property "ki_keywords" "R res resistor" (at 0 0 0))
      (property "ki_fp_filters" "R_*" (at 0 0 0))
      (symbol "R_1_1"
        (pin passive line (at 0 3.81 270) (length 1.27)
          (name "~" (effects (font (size 1.27 1.27))))
          (number "1" (effects (font (size 1.27 1.27)))))
        (pin passive line (at 0 -3.81 90) (length 1.27)
          (name "~" (effects (font (size 1.27 1.27))))
          (number "2" (effects (font (size 1.27 1.27)))))))
    (symbol "Regulator:LDO"
      (property "Datasheet" "https://example.com/ldo.pdf" (at 0 0 0))
      (symbol "LDO_1_1"
        (pin power_in line (at -5.08 0 0) (length 2.54)
          (name "VIN" (effects (font (size 1.27 1.27))))
          (number "1" (effects (font (size 1.27 1.27)))))
        (pin power_out line (at 5.08 0 180) (length 2.54)
          (name "VOUT" (effects (font (size 1.27 1.27))))
          (number "2" (effects (font (size 1.27 1.27)))))
        (pin output line (at 0 -5.08 90) (length 2.54)
          (name "FAULT" (effects (font (size 1.27 1.27))))
          (number "3" (effects (font (size 1.27 1.27)))))))
    (symbol "power:GND"
      (power)
      (symbol "GND_1_1"
        (pin power_in line (at 0 0 270) (length 0) hide
          (name "GND" (effects (font (size 1.27 1.27))))
          (number "1" (effects (font (size 1.27 1.27))))))))
`

const ROOT_UUID = 'aaaaaaaa-0000-0000-0000-000000000000'

const wire = (x1: number, y1: number, x2: number, y2: number): string =>
  `(wire (pts (xy ${x1} ${y1}) (xy ${x2} ${y2})) (stroke (width 0)))`

const resistor = (
  reference: string,
  x: number,
  y: number,
  options: { onBoard?: boolean; dnp?: boolean; mpn?: string } = {}
): string =>
  `(symbol (lib_id "Device:R") (at ${x} ${y} 0) (unit 1)
     (in_bom yes) (on_board ${options.onBoard === false ? 'no' : 'yes'}) (dnp ${options.dnp ? 'yes' : 'no'})
     (uuid "${reference.toLowerCase()}-uuid")
     (property "Reference" "${reference}" (at ${x} ${y} 0))
     (property "Value" "10k" (at ${x} ${y} 0))
     (property "Footprint" "Resistor_SMD:R_0402_1005Metric" (at ${x} ${y} 0))
     (property "Datasheet" "" (at ${x} ${y} 0))
     (property "Description" "Resistor" (at ${x} ${y} 0))
     ${options.mpn ? `(property "MPN" "${options.mpn}" (at ${x} ${y} 0))` : ''})`

const ldo = (reference: string, x: number, y: number): string =>
  `(symbol (lib_id "Regulator:LDO") (at ${x} ${y} 0) (unit 1) (uuid "${reference.toLowerCase()}-uuid")
     (property "Reference" "${reference}" (at ${x} ${y} 0))
     (property "Value" "LDO" (at ${x} ${y} 0))
     (property "Footprint" "Package_TO_SOT_SMD:SOT-23" (at ${x} ${y} 0))
     (property "Datasheet" "https://example.com/ldo.pdf" (at ${x} ${y} 0)))`

const gnd = (reference: string, x: number, y: number): string =>
  `(symbol (lib_id "power:GND") (at ${x} ${y} 0) (unit 1) (uuid "${reference.toLowerCase()}-uuid")
     (property "Reference" "${reference}" (at ${x} ${y} 0))
     (property "Value" "GND" (at ${x} ${y} 0)))`

// U1's VOUT feeds R1, R1 feeds R2, R2 goes to ground; VIN by global label.
const DIVIDER = `
  ${ldo('U1', 50, 50)}
  ${resistor('R1', 70, 50, { mpn: 'RC0402FR-0710KL' })}
  ${resistor('R2', 70, 70)}
  ${gnd('#PWR01', 70, 80)}
  ${wire(55.08, 50, 70, 50)} ${wire(70, 50, 70, 46.19)}
  ${wire(70, 53.81, 70, 66.19)}
  ${wire(70, 73.81, 70, 80)}
  (global_label "VIN" (at 44.92 50 180) (effects (font (size 1.27 1.27))) (uuid "label-vin"))
`

const designOf = (body: string): SyncDesign => {
  const schematic = parseKicadSchematic(
    `(kicad_sch (version 20250114) (generator "test") (uuid "${ROOT_UUID}")
       (title_block (title "Divider") (rev "B") (comment 2 "second"))
       ${LIB} ${body}
       (sheet_instances (path "/" (page "1"))))`
  )
  const sheetPath = `/${ROOT_UUID}`
  const sheets: SheetSource[] = [
    { schematic, sheetPath, sheetName: '', filePath: '/p/divider.kicad_sch' }
  ]
  const inputs: SheetConnectivityInput[] = [{ sheetPath, namePath: '/', schematic }]
  return { sheets, inputs, connectivity: buildConnectivity(inputs) }
}

const OPTIONS = { source: '/p/divider.kicad_sch', date: '2026-01-02T03:04:05', tool: 'GoatCAD 1.0' }

const section = (root: SExprList, token: string): SExprList => findChild(root, token)!

const valueOf = (node: SExprList, token: string): string | undefined => {
  const child = findChild(node, token)
  return child ? getAtomValues(child)[0] : undefined
}

// ---------------------------------------------------------------------------

describe('strNumCmp', () => {
  test('orders digit runs by value and the rest by code unit', () => {
    const names = [
      'R10',
      'R2',
      'R1',
      'GND',
      '+5V',
      '/USB/D-',
      'unconnected-(U2-GPIO14-Pad22)',
      'unconnected-(U2-GPIO3-Pad15)'
    ]
    expect([...names].sort((a, b) => strNumCmp(a, b))).toEqual([
      '+5V',
      '/USB/D-',
      'GND',
      'R1',
      'R2',
      'R10',
      'unconnected-(U2-GPIO3-Pad15)',
      'unconnected-(U2-GPIO14-Pad22)'
    ])
  })

  test('is case-sensitive unless asked, and a prefix sorts first', () => {
    expect(strNumCmp('a', 'B')).toBeGreaterThan(0)
    expect(strNumCmp('a', 'B', true)).toBeLessThan(0)
    expect(strNumCmp('R1', 'R1A')).toBeLessThan(0)
    expect(strNumCmp('R01', 'R1')).toBe(0)
  })
})

describe('netlistNets', () => {
  test('names each net, lists its nodes in order, and leaves power symbols out', () => {
    const nets = netlistNets(designOf(DIVIDER).connectivity)
    expect(nets.map((net) => net.name)).toEqual(
      ['GND', 'Net-(U1-VOUT)', 'Net-(R1-Pad2)', 'VIN', 'unconnected-(U1-FAULT-Pad3)'].sort((a, b) =>
        strNumCmp(a, b)
      )
    )
    const gnd = nets.find((net) => net.name === 'GND')!
    expect(gnd.nodes).toEqual([{ ref: 'R2', pin: '2', pinType: 'passive' }])
    const vout = nets.find((net) => net.name === 'Net-(U1-VOUT)')!
    expect(vout.nodes).toEqual([
      { ref: 'R1', pin: '1', pinType: 'passive' },
      { ref: 'U1', pin: '2', pinFunction: 'VOUT_2', pinType: 'power_out' }
    ])
    expect(nets.every((net) => net.netClass === 'Default')).toBe(true)
    // Codes count every net in name order, so they climb without gaps here.
    expect(nets.map((net) => net.code)).toEqual([1, 2, 3, 4, 5])
  })

  test('a no-connect flag on a lone pin marks its type', () => {
    const nets = netlistNets(
      designOf(`${DIVIDER} (no_connect (at 50 55.08) (uuid "nc-1"))`).connectivity
    )
    const fault = nets.find((net) => net.nodes.some((node) => node.pinFunction === 'FAULT_3'))!
    expect(fault.nodes).toEqual([
      { ref: 'U1', pin: '3', pinFunction: 'FAULT_3', pinType: 'output+no_connect' }
    ])
  })

  test('a part kept off the board contributes no node', () => {
    const design = designOf(`
      ${DIVIDER}
      ${resistor('R9', 90, 50, { onBoard: false })}
      ${wire(90, 46.19, 90, 40)} (label "TAP" (at 90 40 0) (effects (font (size 1.27 1.27))))
      (label "TAP" (at 70 50 0) (effects (font (size 1.27 1.27))))
    `)
    const nets = netlistNets(design.connectivity)
    expect(nets.flatMap((net) => net.nodes).some((node) => node.ref === 'R9')).toBe(false)
  })

  test('the class comes from the caller', () => {
    const nets = netlistNets(designOf(DIVIDER).connectivity, (name) =>
      name === 'GND' ? 'Power' : 'Default'
    )
    expect(nets.find((net) => net.name === 'GND')!.netClass).toBe('Power')
  })
})

describe('writeNetlist', () => {
  const text = writeNetlist(designOf(DIVIDER), OPTIONS)
  const root = parseSExpr(text) as SExprList

  test('is a version E export with every section KiCad writes but libraries', () => {
    expect(root.children[0]).toMatchObject({ type: 'atom', value: 'export' })
    expect(valueOf(root, 'version')).toBe('E')
    expect(
      root.children
        .filter((child): child is SExprList => child.type === 'list')
        .map((child) => getToken(child))
    ).toEqual(['version', 'design', 'components', 'groups', 'variants', 'libparts', 'nets'])
    // Tabs and one node per line, as KiCad's Prettify writes it.
    expect(text.startsWith('(export\n\t(version "E")\n\t(design\n')).toBe(true)
    expect(text.endsWith(')\n')).toBe(true)
  })

  test('the header names the source, the stamp and each sheet with its title block', () => {
    const design = section(root, 'design')
    expect(valueOf(design, 'source')).toBe('/p/divider.kicad_sch')
    expect(valueOf(design, 'date')).toBe('2026-01-02T03:04:05')
    expect(valueOf(design, 'tool')).toBe('GoatCAD 1.0')
    const [sheet] = findChildren(design, 'sheet')
    expect(valueOf(sheet, 'number')).toBe('1')
    expect(valueOf(sheet, 'name')).toBe('/')
    expect(valueOf(sheet, 'tstamps')).toBe('/')
    const block = section(sheet, 'title_block')
    expect(valueOf(block, 'title')).toBe('Divider')
    expect(valueOf(block, 'company')).toBeUndefined()
    expect(valueOf(block, 'rev')).toBe('B')
    expect(valueOf(block, 'source')).toBe('divider.kicad_sch')
    const comments = findChildren(block, 'comment').map((comment) => [
      valueOf(comment, 'number'),
      valueOf(comment, 'value')
    ])
    expect(comments).toHaveLength(9)
    expect(comments[1]).toEqual(['2', 'second'])
    expect(comments[0]).toEqual(['1', ''])
  })

  test('a component carries its fields, library source, flags, sheet and units', () => {
    const [r1, r2, u1] = findChildren(section(root, 'components'), 'comp')
    expect([r1, r2, u1].map((comp) => valueOf(comp, 'ref'))).toEqual(['R1', 'R2', 'U1'])
    expect(valueOf(r1, 'value')).toBe('10k')
    expect(valueOf(r1, 'footprint')).toBe('Resistor_SMD:R_0402_1005Metric')
    expect(valueOf(r1, 'datasheet')).toBeUndefined()
    expect(valueOf(r1, 'description')).toBe('Resistor')
    const fields = findChildren(section(r1, 'fields'), 'field').map((field) => [
      valueOf(field, 'name'),
      getAtomValues(field)[0]
    ])
    expect(fields).toEqual([
      ['MPN', 'RC0402FR-0710KL'],
      ['Footprint', 'Resistor_SMD:R_0402_1005Metric'],
      ['Datasheet', undefined],
      ['Description', 'Resistor']
    ])
    const libsource = section(r1, 'libsource')
    expect([valueOf(libsource, 'lib'), valueOf(libsource, 'part')]).toEqual(['Device', 'R'])
    const properties = findChildren(r1, 'property').map((property) => [
      valueOf(property, 'name'),
      valueOf(property, 'value')
    ])
    expect(properties).toEqual([
      ['MPN', 'RC0402FR-0710KL'],
      ['Sheetname', 'divider'],
      ['Sheetfile', 'divider.kicad_sch'],
      ['ki_keywords', 'R res resistor'],
      ['ki_fp_filters', 'R_*']
    ])
    const sheetpath = section(r1, 'sheetpath')
    expect([valueOf(sheetpath, 'names'), valueOf(sheetpath, 'tstamps')]).toEqual(['/', '/'])
    expect(getAtomValues(section(r1, 'tstamps'))).toEqual(['r1-uuid'])
    const units = findChildren(section(u1, 'units'), 'unit')
    expect(units.map((unit) => valueOf(unit, 'name'))).toEqual(['A'])
    // By x, then down the page: VIN at the left, FAULT below the middle, VOUT at the right.
    expect(
      findChildren(section(units[0], 'pins'), 'pin').map((pin) => valueOf(pin, 'num'))
    ).toEqual(['1', '3', '2'])
    expect(valueOf(u1, 'datasheet')).toBe('https://example.com/ldo.pdf')
  })

  test('a DNP part says so, and a part kept off the board is not listed', () => {
    const design = designOf(
      `${DIVIDER} ${resistor('R7', 90, 50, { dnp: true })} ${resistor('R8', 110, 50, { onBoard: false })}`
    )
    const comps = findChildren(
      section(parseSExpr(writeNetlist(design, OPTIONS)) as SExprList, 'components'),
      'comp'
    )
    expect(comps.map((comp) => valueOf(comp, 'ref'))).toEqual(['R1', 'R2', 'R7', 'U1'])
    const r7 = comps.find((comp) => valueOf(comp, 'ref') === 'R7')!
    expect(findChildren(r7, 'property').map((property) => valueOf(property, 'name'))).toContain(
      'dnp'
    )
  })

  test('each library symbol a part draws from is listed once, with its pins', () => {
    const libparts = findChildren(section(root, 'libparts'), 'libpart')
    expect(libparts.map((part) => `${valueOf(part, 'lib')}:${valueOf(part, 'part')}`)).toEqual([
      'Device:R',
      'Regulator:LDO'
    ])
    const [r, ldo] = libparts
    expect(getAtomValues(section(section(r, 'footprints'), 'fp'))).toEqual(['R_*'])
    expect(valueOf(ldo, 'docs')).toBe('https://example.com/ldo.pdf')
    expect(
      findChildren(section(ldo, 'pins'), 'pin').map((pin) => [
        valueOf(pin, 'num'),
        valueOf(pin, 'name'),
        valueOf(pin, 'type')
      ])
    ).toEqual([
      ['1', 'VIN', 'power_in'],
      ['2', 'VOUT', 'power_out'],
      ['3', 'FAULT', 'output']
    ])
    const rFields = findChildren(section(r, 'fields'), 'field').map((field) =>
      valueOf(field, 'name')
    )
    expect(rFields).toEqual(['Reference', 'Value', 'Footprint', 'Datasheet', 'Description'])
  })

  test('the nets read back as netlistNets built them', () => {
    const read = readNetlist(text)
    expect(read.nets.map((net) => net.name)).toEqual(
      netlistNets(designOf(DIVIDER).connectivity).map((net) => net.name)
    )
    const vout = findChildren(section(root, 'nets'), 'net').find(
      (net) => valueOf(net, 'name') === 'Net-(U1-VOUT)'
    )!
    expect(valueOf(vout, 'class')).toBe('Default')
    expect(findChildren(vout, 'node').map((node) => valueOf(node, 'pinfunction'))).toEqual([
      undefined,
      'VOUT_2'
    ])
  })
})

describe('helpers', () => {
  test('the stamp is local ISO 8601 without a zone', () => {
    expect(netlistDate(new Date(2026, 8, 4, 7, 5, 3))).toBe('2026-09-04T07:05:03')
  })

  test('the file is offered beside the root sheet', () => {
    expect(netlistPathFor('/p/psu.kicad_sch')).toBe('/p/psu.net')
    expect(netlistPathFor('C:\\p\\psu.kicad_sch')).toBe('C:\\p\\psu.net')
  })
})

// The sample project, as KiCad 10 exports it (netlist.parity.test.ts compares
// the whole file with kicad-cli's; these hold the load-bearing facts without it).
const SAMPLE = CANARY_SCHEMATIC

describe('the sample project', () => {
  test('exports KiCad’s nets across its four sheets', async () => {
    const read = readNetlist(writeNetlist(await loadDesign(SAMPLE), { ...OPTIONS, source: SAMPLE }))
    expect(read.sheets.map((sheet) => sheet.name)).toEqual([
      '/',
      '/Display Port/',
      '/Sensors/',
      '/USB/'
    ])
    expect(read.components).toHaveLength(73)
    expect(read.nets).toHaveLength(68)
    const names = read.nets.map((net) => net.name)
    expect(names.slice(0, 3)).toEqual(['+3.3V', '+5V', '/BMV_IRQ1'])
    expect(names).toContain('/Display Port/D_VGH_BD')
    expect(names).toContain('unconnected-(U2-GPIO3{slash}TOUCH3{slash}ADC1_CH2-Pad15)')
    expect(names.indexOf('unconnected-(U2-GPIO3{slash}TOUCH3{slash}ADC1_CH2-Pad15)')).toBeLessThan(
      names.indexOf(
        'unconnected-(U2-GPIO14{slash}TOUCH14{slash}ADC2_CH3{slash}FSPIWP{slash}FSPIDQS{slash}SUBSPIWP-Pad22)'
      )
    )
    expect(read.nets.find((net) => net.name === '/USB/CC1')!.nodes).toEqual([
      { ref: 'J3', pin: 'A5', pinfunction: 'CC1_A5', pintype: 'unspecified' },
      { ref: 'J4', pin: 'A5', pinfunction: 'CC1_A5', pintype: 'unspecified' },
      { ref: 'R8', pin: '1', pinfunction: undefined, pintype: 'passive' }
    ])
    expect(read.nets.find((net) => net.name === 'unconnected-(J3-SBU1-PadA8)')!.nodes).toEqual([
      { ref: 'J3', pin: 'A8', pinfunction: 'SBU1_A8', pintype: 'unspecified+no_connect' }
    ])
  })
})
