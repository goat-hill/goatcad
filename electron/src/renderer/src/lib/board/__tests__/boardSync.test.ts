import { describe, expect, test } from 'vitest'
import {
  applyBoardSync,
  boardPathFor,
  footprintPath,
  netsInUse,
  planBoardSync,
  scopePlan,
  sheetNameFor,
  unannotatedReferences,
  type SyncDesign
} from '../boardSync'
import {
  parseKicadBoard,
  remapKicadBoard,
  serializeKicadBoard,
  type KicadBoard
} from '../../kicad/board'
import { buildConnectivity, type SheetConnectivityInput } from '../../schematic/connectivity'
import { parseKicadFootprint, type KicadFootprint } from '../../kicad/footprint'
import { mmToNm as mm } from '../../kicad/coordinates'
import { parseKicadSchematic } from '../../kicad/schematic'
import {
  findChild,
  findChildren,
  getAtomValues,
  getFirstAtomValue,
  getToken,
  type SExprList
} from '../../kicad/sexpr'
import type { SheetSource } from '../../componentsTable'

// ---------------------------------------------------------------------------
// Fixtures — small, grammatically real
// ---------------------------------------------------------------------------

const LIB = `
  (lib_symbols
    (symbol "Device:R"
      (property "ki_fp_filters" "R_*" (at 0 0 0))
      (symbol "R_1_1"
        (pin passive line (at 0 3.81 270) (length 1.27)
          (name "~" (effects (font (size 1.27 1.27))))
          (number "1" (effects (font (size 1.27 1.27)))))
        (pin passive line (at 0 -3.81 90) (length 1.27)
          (name "~" (effects (font (size 1.27 1.27))))
          (number "2" (effects (font (size 1.27 1.27)))))))
    (symbol "Regulator:LDO"
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

const sheetDoc = (body: string, uuid = ROOT_UUID): string =>
  `(kicad_sch (version 20231120) (generator "test") (uuid "${uuid}") ${LIB} ${body})`

const wire = (x1: number, y1: number, x2: number, y2: number): string =>
  `(wire (pts (xy ${x1} ${y1}) (xy ${x2} ${y2})) (stroke (width 0)))`

const resistor = (
  reference: string,
  x: number,
  y: number,
  options: {
    footprint?: string
    dnp?: boolean
    inBom?: boolean
    onBoard?: boolean
    mpn?: string
  } = {}
): string =>
  `(symbol (lib_id "Device:R") (at ${x} ${y} 0) (unit 1)
     (in_bom ${options.inBom === false ? 'no' : 'yes'}) (on_board ${options.onBoard === false ? 'no' : 'yes'}) (dnp ${options.dnp ? 'yes' : 'no'})
     (uuid "${reference.toLowerCase()}-uuid")
     (property "Reference" "${reference}" (at ${x} ${y} 0))
     (property "Value" "10k" (at ${x} ${y} 0))
     (property "Footprint" "${options.footprint ?? ''}" (at ${x} ${y} 0))
     (property "Datasheet" "~" (at ${x} ${y} 0))
     ${options.mpn ? `(property "MPN" "${options.mpn}" (at ${x} ${y} 0))` : ''})`

const ldo = (reference: string, x: number, y: number): string =>
  `(symbol (lib_id "Regulator:LDO") (at ${x} ${y} 0) (unit 1) (uuid "${reference.toLowerCase()}-uuid")
     (property "Reference" "${reference}" (at ${x} ${y} 0))
     (property "Value" "LDO" (at ${x} ${y} 0))
     (property "Footprint" "Package_TO_SOT_SMD:SOT-23" (at ${x} ${y} 0)))`

const gnd = (reference: string, x: number, y: number): string =>
  `(symbol (lib_id "power:GND") (at ${x} ${y} 0) (unit 1) (uuid "${reference.toLowerCase()}-uuid")
     (property "Reference" "${reference}" (at ${x} ${y} 0))
     (property "Value" "GND" (at ${x} ${y} 0)))`

const R_0402 = `(footprint "R_0402_1005Metric"
  (version 20240108)
  (generator "kicad-footprint-generator")
  (layer "F.Cu")
  (descr "Resistor SMD 0402")
  (tags "resistor")
  (property "Reference" "REF**" (at 0 -1.17 0) (layer "F.SilkS") (uuid "11111111-0000-0000-0000-000000000001") (effects (font (size 1 1) (thickness 0.15))))
  (property "Value" "R_0402_1005Metric" (at 0 1.17 0) (layer "F.Fab") (uuid "11111111-0000-0000-0000-000000000002") (effects (font (size 1 1) (thickness 0.15))))
  (attr smd)
  (fp_line (start -0.93 -0.47) (end 0.93 -0.47) (stroke (width 0.05) (type solid)) (layer "F.CrtYd") (uuid "11111111-0000-0000-0000-000000000003"))
  (fp_line (start -0.93 0.47) (end 0.93 0.47) (stroke (width 0.05) (type solid)) (layer "F.CrtYd") (uuid "11111111-0000-0000-0000-000000000004"))
  (pad "1" smd roundrect (at -0.485 0) (size 0.59 0.64) (layers "F.Cu" "F.Paste" "F.Mask") (roundrect_rratio 0.25) (uuid "11111111-0000-0000-0000-000000000005"))
  (pad "2" smd roundrect (at 0.485 0) (size 0.59 0.64) (layers "F.Cu" "F.Paste" "F.Mask") (roundrect_rratio 0.25) (uuid "11111111-0000-0000-0000-000000000006"))
)`

const SOT23 = `(footprint "SOT-23"
  (version 20240108)
  (generator "test")
  (layer "F.Cu")
  (property "Reference" "REF**" (at 0 -2.5 0) (layer "F.SilkS") (uuid "22222222-0000-0000-0000-000000000001") (effects (font (size 1 1) (thickness 0.15))))
  (property "Value" "SOT-23" (at 0 2.5 0) (layer "F.Fab") (uuid "22222222-0000-0000-0000-000000000002") (effects (font (size 1 1) (thickness 0.15))))
  (attr smd)
  (pad "1" smd rect (at -1 -0.95) (size 0.9 0.8) (layers "F.Cu" "F.Paste" "F.Mask") (uuid "22222222-0000-0000-0000-000000000003"))
  (pad "2" smd rect (at -1 0.95) (size 0.9 0.8) (layers "F.Cu" "F.Paste" "F.Mask") (uuid "22222222-0000-0000-0000-000000000004"))
  (pad "3" smd rect (at 1 0) (size 0.9 0.8) (layers "F.Cu" "F.Paste" "F.Mask") (uuid "22222222-0000-0000-0000-000000000005"))
  (pad "" np_thru_hole circle (at 0 0) (size 0.3 0.3) (drill 0.3) (layers "*.Cu" "*.Mask") (uuid "22222222-0000-0000-0000-000000000006"))
)`

const LIBRARY: Record<string, string> = {
  'Resistor_SMD:R_0402_1005Metric': R_0402,
  'Package_TO_SOT_SMD:SOT-23': SOT23
}

const loader = (libId: string): KicadFootprint | null =>
  LIBRARY[libId] ? parseKicadFootprint(LIBRARY[libId]) : null

const EMPTY_BOARD = `(kicad_pcb
  (version 20241229)
  (generator "pcbnew")
  (generator_version "9.0")
  (general (thickness 1.6) (legacy_teardrops no))
  (paper "A4")
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))
  (setup (pad_to_mask_clearance 0))
  (net 0 "")
  (gr_line (start 100 100) (end 150 100) (stroke (width 0.05) (type default)) (layer "Edge.Cuts") (uuid "33333333-0000-0000-0000-000000000001"))
  (gr_line (start 150 100) (end 150 140) (stroke (width 0.05) (type default)) (layer "Edge.Cuts") (uuid "33333333-0000-0000-0000-000000000002"))
)`

const NAMED_BOARD = `(kicad_pcb
  (version 20260206)
  (generator "pcbnew")
  (generator_version "10.0")
  (general (thickness 1.6) (legacy_teardrops no))
  (paper "A4")
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))
  (setup (pad_to_mask_clearance 0))
)`

/** One root sheet as the agents hand it to the planner. */
const designOf = (body: string, uuid = ROOT_UUID): SyncDesign => {
  const schematic = parseKicadSchematic(sheetDoc(body, uuid))
  const sheetPath = `/${uuid}`
  const sheets: SheetSource[] = [
    { schematic, sheetPath, sheetName: '', filePath: '/p/root.kicad_sch' }
  ]
  const inputs: SheetConnectivityInput[] = [{ sheetPath, namePath: '/', schematic }]
  return { sheets, inputs, connectivity: buildConnectivity(inputs) }
}

const sync = (
  design: SyncDesign,
  source: string,
  options: { prune?: boolean } = {}
): KicadBoard => {
  let board = parseKicadBoard(source)
  const plan = planBoardSync(design, board, loader)
  applyBoardSync(board, plan, options)
  board = remapKicadBoard(board)
  // What lands must survive the file: re-parse the text, never trust the AST alone.
  return parseKicadBoard(serializeKicadBoard(board))
}

const padNets = (board: KicadBoard, reference: string): Record<string, string> => {
  const footprint = board.footprints.find((fp) => fp.reference === reference)!
  return Object.fromEntries(
    footprint.footprint.pads.map((pad) => [pad.number, pad.net?.name ?? ''])
  )
}

const padChild = (board: KicadBoard, reference: string, pad: string, token: string): string => {
  const footprint = board.footprints.find((fp) => fp.reference === reference)!
  const node = findChildren(footprint._raw, 'pad').find((p) => getAtomValues(p)[0] === pad)!
  const child = findChild(node, token)
  return child ? (getFirstAtomValue(child) ?? '') : ''
}

const childText = (node: SExprList, token: string): string => {
  const child = findChild(node, token)
  return child ? (getFirstAtomValue(child) ?? '') : ''
}

const tokensOf = (node: SExprList): string[] => {
  const out: string[] = []
  for (const child of node.children) {
    if (child.type !== 'list') continue
    const token = getToken(child) ?? ''
    if (out[out.length - 1] !== token) out.push(token)
  }
  return out
}

// A divider: U1's VOUT feeds R1, R1 feeds R2, R2 goes to ground; VIN by label.
const DIVIDER = `
  ${ldo('U1', 50, 50)}
  ${resistor('R1', 70, 50, { footprint: 'Resistor_SMD:R_0402_1005Metric', mpn: 'RC0402FR-0710KL' })}
  ${resistor('R2', 70, 70, { footprint: 'Resistor_SMD:R_0402_1005Metric' })}
  ${gnd('#PWR01', 70, 80)}
  ${wire(55.08, 50, 70, 50)} ${wire(70, 50, 70, 46.19)}
  ${wire(70, 53.81, 70, 66.19)}
  ${wire(70, 73.81, 70, 80)}
  (global_label "VIN" (at 44.92 50 180) (effects (font (size 1.27 1.27))) (uuid "label-vin"))
`

// ---------------------------------------------------------------------------

describe('paths and names', () => {
  test('the board path drops the root sheet and appends the symbol', () => {
    expect(boardPathFor('/root', 'sym')).toBe('/sym')
    expect(boardPathFor('/root/sheet', 'sym')).toBe('/sheet/sym')
    expect(boardPathFor('/root/outer/inner', 'sym')).toBe('/outer/inner/sym')
  })

  test('sheetname is / for the root and /Name/ below it', () => {
    expect(sheetNameFor('/')).toBe('/')
    expect(sheetNameFor('/HDMI')).toBe('/HDMI/')
    expect(sheetNameFor('/Outer/Inner')).toBe('/Outer/Inner/')
  })
})

describe('unannotatedReferences', () => {
  test('names the parts still numbered with ?, leaving out power and parts kept off the board', () => {
    const design = designOf(`
      ${resistor('R1', 50, 50)}
      ${resistor('R?', 70, 50)}
      ${resistor('C?', 90, 50)}
      ${resistor('D?', 110, 50, { onBoard: false })}
      ${gnd('#PWR?', 130, 50)}
    `)
    expect(unannotatedReferences(design)).toEqual(['C?', 'R?'])
  })

  test('is empty on an annotated schematic', () => {
    expect(unannotatedReferences(designOf(DIVIDER))).toEqual([])
  })
})

describe('planBoardSync', () => {
  test('adds every linkable part, skips the rest by reason, and names the nets', () => {
    const design = designOf(`
      ${DIVIDER}
      ${resistor('R3', 90, 50)}
      ${resistor('R4', 90, 70, { footprint: 'Nowhere:Missing' })}
      ${resistor('R5', 90, 90, { footprint: 'Resistor_SMD:R_0402_1005Metric', onBoard: false })}
    `)
    const plan = planBoardSync(design, parseKicadBoard(EMPTY_BOARD), loader)
    expect(plan.add.map((a) => a.part.reference)).toEqual(['R1', 'R2', 'U1'])
    expect(plan.skipped).toEqual([
      { reference: 'R3', reason: 'no-footprint' },
      { reference: 'R4', reason: 'footprint-not-found', libId: 'Nowhere:Missing' }
    ])
    expect(plan.update).toEqual([])
    expect(plan.orphans).toEqual([])
    // Named as KiCad names them: a pin name beats a pad number, and the
    // lowest name wins; an unconnected pin carries its name and pad number.
    expect(plan.nets.added).toEqual([
      'GND',
      'Net-(R1-Pad2)',
      'Net-(U1-VOUT)',
      'VIN',
      'unconnected-(U1-FAULT-Pad3)'
    ])
    expect(plan.nets.removed).toEqual([])
    expect(plan.add.some((a) => a.part.reference.startsWith('#'))).toBe(false)
  })

  test('a part carries what KiCad exports: fields, filters, flags and pad nets', () => {
    const design = designOf(DIVIDER)
    const plan = planBoardSync(design, parseKicadBoard(EMPTY_BOARD), loader)
    const r1 = plan.add.find((a) => a.part.reference === 'R1')!.part
    expect(r1.path).toBe(`/r1-uuid`)
    expect(r1.sheetName).toBe('/')
    expect(r1.sheetFile).toBe('root.kicad_sch')
    // `~` is KiCad's legacy spelling of an empty field and crosses as empty.
    expect(r1.fields).toEqual([
      ['Datasheet', ''],
      ['Description', ''],
      ['MPN', 'RC0402FR-0710KL']
    ])
    expect(r1.fpFilters).toBe('R_*')
    expect([...r1.pads.entries()]).toEqual([
      ['1', { net: 'Net-(U1-VOUT)', pinType: 'passive' }],
      ['2', { net: 'Net-(R1-Pad2)', pinType: 'passive' }]
    ])
    const u1 = plan.add.find((a) => a.part.reference === 'U1')!.part
    expect(u1.pads.get('1')).toEqual({ net: 'VIN', pinType: 'power_in', pinFunction: 'VIN_1' })
    expect(u1.pads.get('2')).toEqual({
      net: 'Net-(U1-VOUT)',
      pinType: 'power_out',
      pinFunction: 'VOUT_2'
    })
    expect(u1.pads.get('3')).toEqual({
      net: 'unconnected-(U1-FAULT-Pad3)',
      pinType: 'output',
      pinFunction: 'FAULT_3'
    })
  })

  test('a no-connect flag on a lone pin marks its pin type', () => {
    const design = designOf(`${DIVIDER} (no_connect (at 50 55.08) (uuid "nc-1"))`)
    const plan = planBoardSync(design, parseKicadBoard(EMPTY_BOARD), loader)
    const u1 = plan.add.find((a) => a.part.reference === 'U1')!.part
    expect(u1.pads.get('3')?.pinType).toBe('output+no_connect')
  })

  test('new footprints stage below the outline in a row, nothing overlapping', () => {
    const design = designOf(DIVIDER)
    const plan = planBoardSync(design, parseKicadBoard(EMPTY_BOARD), loader)
    const at = plan.add.map((a) => a.at)
    // The outline spans x 100..150, y 100..140; the row starts 10 mm below it.
    for (const position of at) expect(position.y).toBeGreaterThan(140_000_000)
    const xs = at.map((p) => p.x)
    expect(new Set(xs).size).toBe(xs.length)
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(100_000_000)
  })
})

describe('applyBoardSync', () => {
  test('writes footprints KiCad would: link, fields, attributes, nets, in a numbered file', () => {
    const board = sync(designOf(DIVIDER), EMPTY_BOARD)
    expect(board.footprints.map((fp) => fp.reference).sort()).toEqual(['R1', 'R2', 'U1'])
    const r1 = board.footprints.find((fp) => fp.reference === 'R1')!
    expect(r1.libId).toBe('Resistor_SMD:R_0402_1005Metric')
    expect(r1.value).toBe('10k')
    expect(r1.layer).toBe('F.Cu')
    expect(r1.position.angle ?? 0).toBe(0)
    expect(footprintPath(r1)).toBe('/r1-uuid')
    expect(childText(r1._raw, 'sheetname')).toBe('/')
    expect(childText(r1._raw, 'sheetfile')).toBe('root.kicad_sch')
    // The library header is gone and the node has one uuid of its own.
    expect(findChild(r1._raw, 'version')).toBeNull()
    expect(findChild(r1._raw, 'generator')).toBeNull()
    expect(r1.uuid).toMatch(/^[0-9a-f-]{36}$/)
    // Fields: the mandatory two plus the user's, hidden on F.Fab; Footprint is never written.
    const keys = r1.footprint.properties.map((p) => p.key)
    expect(keys).toEqual(['Reference', 'Value', 'Datasheet', 'Description', 'MPN', 'ki_fp_filters'])
    const mpn = r1.footprint.properties.find((p) => p.key === 'MPN')!
    expect(mpn.value).toBe('RC0402FR-0710KL')
    expect(mpn.layer).toBe('F.Fab')
    expect(mpn.hide).toBe(true)
    // The node's children come in the order KiCad's writer emits them.
    expect(tokensOf(r1._raw)).toEqual([
      'layer',
      'uuid',
      'at',
      'descr',
      'tags',
      'property',
      'path',
      'sheetname',
      'sheetfile',
      'attr',
      'fp_line',
      'pad'
    ])
    expect(padNets(board, 'R1')).toEqual({ '1': 'Net-(U1-VOUT)', '2': 'Net-(R1-Pad2)' })
    expect(padNets(board, 'R2')).toEqual({ '1': 'Net-(R1-Pad2)', '2': 'GND' })
    expect(padNets(board, 'U1')).toEqual({
      '1': 'VIN',
      '2': 'Net-(U1-VOUT)',
      '3': 'unconnected-(U1-FAULT-Pad3)',
      '': ''
    })
    expect(padChild(board, 'U1', '1', 'pinfunction')).toBe('VIN_1')
    expect(padChild(board, 'U1', '1', 'pintype')).toBe('power_in')
    // A pad's net sits before its uuid, as KiCad writes it.
    const pad = findChildren(r1._raw, 'pad')[0]
    expect(tokensOf(pad)).toEqual([
      'at',
      'size',
      'layers',
      'roundrect_rratio',
      'net',
      'pintype',
      'uuid'
    ])
    // A numbered file grew its table, net 0 first, in the order the pads were written.
    expect(board.netRefStyle).toBe('number')
    expect(board.nets.map((n) => n.name)).toEqual([
      '',
      'Net-(U1-VOUT)',
      'Net-(R1-Pad2)',
      'GND',
      'VIN',
      'unconnected-(U1-FAULT-Pad3)'
    ])
    expect(getAtomValues(findChild(pad, 'net')!)).toEqual(['1', 'Net-(U1-VOUT)'])
  })

  test('a named file (KiCad 10) writes pad nets by name and no table', () => {
    const board = sync(designOf(DIVIDER), NAMED_BOARD)
    expect(board.netRefStyle).toBe('name')
    expect(findChildren(board._raw as SExprList, 'net')).toEqual([])
    const r1 = board.footprints.find((fp) => fp.reference === 'R1')!
    expect(getAtomValues(findChild(findChildren(r1._raw, 'pad')[0], 'net')!)).toEqual([
      'Net-(U1-VOUT)'
    ])
    expect(padNets(board, 'R2')).toEqual({ '1': 'Net-(R1-Pad2)', '2': 'GND' })
  })

  test("a library footprint's zones land board-absolute at its placement", () => {
    const keepout = `(zone (layers "F.Cu" "B.Cu") (uuid "44444444-0000-0000-0000-000000000001")
    (keepout (tracks not_allowed) (vias not_allowed) (pads allowed) (copperpour not_allowed) (footprints allowed))
    (polygon (pts (xy -1 -3) (xy 1 -3) (xy 1 -2) (xy -1 -2))))\n)`
    const original = LIBRARY['Resistor_SMD:R_0402_1005Metric']
    LIBRARY['Resistor_SMD:R_0402_1005Metric'] = original.replace(/\)\s*$/, keepout)
    try {
      const board = sync(designOf(DIVIDER), EMPTY_BOARD)
      const r1 = board.footprints.find((fp) => fp.reference === 'R1')!
      const { x, y } = r1.position
      expect(r1.footprint.zones[0].points[0]).toEqual({ x: x - mm(1), y: y - mm(3) })
    } finally {
      LIBRARY['Resistor_SMD:R_0402_1005Metric'] = original
    }
  })

  test('two instances of one library footprint share no uuid', () => {
    const board = sync(designOf(DIVIDER), EMPTY_BOARD)
    const uuids: string[] = []
    const collect = (node: SExprList): void => {
      for (const child of node.children) {
        if (child.type !== 'list') continue
        if (getToken(child) === 'uuid') uuids.push(getFirstAtomValue(child)!)
        else collect(child)
      }
    }
    for (const fp of board.footprints) collect(fp._raw)
    expect(uuids.length).toBeGreaterThan(10)
    expect(new Set(uuids).size).toBe(uuids.length)
  })

  test("dnp and exclude-from-bom become attributes in KiCad's order", () => {
    const design = designOf(`
      ${resistor('R1', 50, 50, { footprint: 'Resistor_SMD:R_0402_1005Metric', dnp: true, inBom: false })}
    `)
    const board = sync(design, EMPTY_BOARD)
    const r1 = board.footprints[0]
    expect(getAtomValues(findChild(r1._raw, 'attr')!)).toEqual(['smd', 'exclude_from_bom', 'dnp'])
  })

  test('a second sync changes nothing, and a changed value is the one update', () => {
    let board = sync(designOf(DIVIDER), EMPTY_BOARD)
    const text = serializeKicadBoard(board)
    const again = planBoardSync(designOf(DIVIDER), board, loader)
    expect(again.add).toEqual([])
    expect(again.update).toEqual([])
    expect(again.unchanged).toBe(3)
    expect(again.nets).toEqual({ added: [], removed: [] })
    applyBoardSync(board, again)
    expect(serializeKicadBoard(remapKicadBoard(board))).toBe(text)

    const changed = designOf(DIVIDER.replace('"10k" (at 70 70 0)', '"4k7" (at 70 70 0)'))
    const plan = planBoardSync(changed, board, loader)
    expect(plan.update.map((u) => [u.part.reference, u.changes])).toEqual([['R2', ['value']]])
    applyBoardSync(board, plan)
    board = remapKicadBoard(board)
    expect(board.footprints.find((fp) => fp.reference === 'R2')!.value).toBe('4k7')
  })

  test('with fields off, a new MPN and value land only as the value', () => {
    let board = sync(designOf(DIVIDER), EMPTY_BOARD)
    const changed = designOf(
      DIVIDER.replace('RC0402FR-0710KL', 'NEW-MPN').replace(
        `(property "Reference" "R1" (at 70 50 0))
     (property "Value" "10k"`,
        `(property "Reference" "R1" (at 70 50 0))
     (property "Value" "4k7"`
      )
    )
    const plan = scopePlan(planBoardSync(changed, board, loader), { updateFields: false })
    expect(plan.update.map((u) => [u.part.reference, u.changes])).toEqual([['R1', ['value']]])
    applyBoardSync(board, plan)
    board = parseKicadBoard(serializeKicadBoard(remapKicadBoard(board)))
    const r1 = board.footprints.find((fp) => fp.reference === 'R1')!
    expect(r1.value).toBe('4k7')
    expect(r1.footprint.properties.find((p) => p.key === 'MPN')?.value).toBe('RC0402FR-0710KL')
  })

  test('placement survives a re-sync; a rewire moves the net and prunes the table', () => {
    let board = sync(designOf(DIVIDER), EMPTY_BOARD)
    const r2 = board.footprints.find((fp) => fp.reference === 'R2')!
    const at = findChild(r2._raw, 'at')!
    at.children[1] = { type: 'atom', value: '123', quoted: false, start: 0, end: 0 }
    at.children[2] = { type: 'atom', value: '45', quoted: false, start: 0, end: 0 }
    board = parseKicadBoard(serializeKicadBoard(board))
    // R2 now hangs from a local label instead of ground.
    const rewired = designOf(
      DIVIDER.replace(wire(70, 73.81, 70, 80), '') +
        `(label "SENSE" (at 70 73.81 0) (effects (font (size 1.27 1.27))) (uuid "label-sense"))`
    )
    const plan = planBoardSync(rewired, board, loader)
    expect(plan.update.map((u) => [u.part.reference, u.changes])).toEqual([['R2', ['nets']]])
    expect(plan.nets).toEqual({ added: ['/SENSE'], removed: ['GND'] })
    applyBoardSync(board, plan)
    board = parseKicadBoard(serializeKicadBoard(remapKicadBoard(board)))
    const after = board.footprints.find((fp) => fp.reference === 'R2')!
    expect(after.position.x).toBe(123_000_000)
    expect(padNets(board, 'R2')).toEqual({ '1': 'Net-(R1-Pad2)', '2': '/SENSE' })
    expect(board.nets.map((n) => n.name)).not.toContain('GND')
    expect(board.nets.map((n) => n.name)).toContain('/SENSE')
  })

  test('a footprint whose symbol is gone is an orphan: reported, removed only with prune', () => {
    const board = sync(designOf(DIVIDER), EMPTY_BOARD)
    const smaller = designOf(
      DIVIDER.replace(resistor('R2', 70, 70, { footprint: 'Resistor_SMD:R_0402_1005Metric' }), '')
    )
    const plan = planBoardSync(smaller, board, loader)
    expect(plan.orphans.map((o) => o.reference)).toEqual(['R2'])
    applyBoardSync(board, plan)
    expect(
      remapKicadBoard(board)
        .footprints.map((fp) => fp.reference)
        .sort()
    ).toEqual(['R1', 'R2', 'U1'])
    const pruned = sync(smaller, serializeKicadBoard(remapKicadBoard(board)), { prune: true })
    expect(pruned.footprints.map((fp) => fp.reference).sort()).toEqual(['R1', 'U1'])
  })

  test('a hand-placed footprint with the same reference is taken over and linked', () => {
    const board = parseKicadBoard(
      EMPTY_BOARD.replace(
        '(net 0 "")',
        `(net 0 "")
  (footprint "Resistor_SMD:R_0402_1005Metric" (layer "F.Cu") (uuid "44444444-0000-0000-0000-000000000001") (at 120 120)
    (property "Reference" "R1" (at 0 -1.17 0) (layer "F.SilkS") (uuid "44444444-0000-0000-0000-000000000002") (effects (font (size 1 1) (thickness 0.15))))
    (property "Value" "10k" (at 0 1.17 0) (layer "F.Fab") (uuid "44444444-0000-0000-0000-000000000003") (effects (font (size 1 1) (thickness 0.15))))
    (attr smd)
    (pad "1" smd roundrect (at -0.485 0) (size 0.59 0.64) (layers "F.Cu" "F.Paste" "F.Mask") (roundrect_rratio 0.25) (uuid "44444444-0000-0000-0000-000000000004"))
    (pad "2" smd roundrect (at 0.485 0) (size 0.59 0.64) (layers "F.Cu" "F.Paste" "F.Mask") (roundrect_rratio 0.25) (uuid "44444444-0000-0000-0000-000000000005"))
  )`
      )
    )
    const plan = planBoardSync(designOf(DIVIDER), board, loader)
    const r1 = plan.update.find((u) => u.part.reference === 'R1')!
    expect(r1.relinked).toBe(true)
    expect(r1.changes).toEqual(['path', 'sheet', 'fields', 'filters', 'nets'])
    expect(plan.add.map((a) => a.part.reference)).toEqual(['R2', 'U1'])
    applyBoardSync(board, plan)
    const after = parseKicadBoard(serializeKicadBoard(remapKicadBoard(board)))
    const linked = after.footprints.find((fp) => fp.reference === 'R1')!
    expect(footprintPath(linked)).toBe('/r1-uuid')
    expect(linked.position.x).toBe(120_000_000)
    expect(padNets(after, 'R1')).toEqual({ '1': 'Net-(U1-VOUT)', '2': 'Net-(R1-Pad2)' })
  })

  test('a changed Footprint field rebuilds the placed footprint from the new one, where it sits', () => {
    const board = sync(designOf(DIVIDER), EMPTY_BOARD)
    const r1 = board.footprints.find((fp) => fp.reference === 'R1')!
    const swapped = designOf(
      DIVIDER.replace(
        '"Resistor_SMD:R_0402_1005Metric" (at 70 50 0)',
        '"Package_TO_SOT_SMD:SOT-23" (at 70 50 0)'
      )
    )
    const plan = planBoardSync(swapped, board, loader)
    expect(
      plan.footprintChanged.map(({ reference, board: from, schematic }) => ({
        reference,
        from,
        schematic
      }))
    ).toEqual([
      {
        reference: 'R1',
        from: 'Resistor_SMD:R_0402_1005Metric',
        schematic: 'Package_TO_SOT_SMD:SOT-23'
      }
    ])
    expect(plan.add).toEqual([])
    const after = sync(swapped, serializeKicadBoard(board))
    const replaced = after.footprints.find((fp) => fp.reference === 'R1')!
    expect(replaced.libId).toBe('Package_TO_SOT_SMD:SOT-23')
    expect(replaced.uuid).toBe(r1.uuid)
    expect(replaced.position).toEqual(r1.position)
    // Pads take the schematic's nets by number; the new third pad has none.
    expect(padNets(after, 'R1')).toEqual({ ...padNets(board, 'R1'), '3': '', '': '' })
  })

  test('a changed Footprint field no library holds is reported and the board keeps its own', () => {
    const board = sync(designOf(DIVIDER), EMPTY_BOARD)
    const swapped = designOf(
      DIVIDER.replace(
        '"Resistor_SMD:R_0402_1005Metric" (at 70 50 0)',
        '"Nope:Missing" (at 70 50 0)'
      )
    )
    const plan = planBoardSync(swapped, board, loader)
    expect(plan.footprintChanged.map((change) => change.library)).toEqual([null])
    const after = sync(swapped, serializeKicadBoard(board))
    expect(after.footprints.find((fp) => fp.reference === 'R1')!.libId).toBe(
      'Resistor_SMD:R_0402_1005Metric'
    )
  })
})

describe('the nets a board uses', () => {
  test('are its pads, tracks, vias and zones, not a net only an earlier parse knew', () => {
    const board = parseKicadBoard(`(kicad_pcb (version 20240108) (generator "pcbnew")
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal))
  (net 0 "") (net 1 "PAD") (net 2 "TRACK") (net 3 "VIA") (net 4 "ZONE") (net 5 "OLD") (net 6 "UNUSED")
  (footprint "R" (layer "F.Cu") (at 0 0)
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 1 "PAD")))
  (segment (start 0 0) (end 1 0) (width 0.2) (layer "F.Cu") (net 2))
  (segment (start 0 1) (end 1 1) (width 0.2) (layer "F.Cu") (net 5))
  (via (at 2 2) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 3))
  (zone (net 4) (net_name "ZONE") (layer "F.Cu") (polygon (pts (xy 0 0) (xy 1 0) (xy 1 1))))
)`)
    expect([...netsInUse(board)].sort()).toEqual(['OLD', 'PAD', 'TRACK', 'VIA', 'ZONE'])
    // Drop the track and its net row: the re-parse keeps OLD in board.nets for the session.
    const root = board._raw as { children: unknown[] }
    root.children = root.children.filter(
      (child) => !JSON.stringify(child).includes('"OLD"') && child !== board.segments[1]._raw
    )
    const after = remapKicadBoard(board)
    expect(after.nets.some((net) => net.name === 'OLD')).toBe(true)
    expect([...netsInUse(after)].sort()).toEqual(['PAD', 'TRACK', 'VIA', 'ZONE'])
  })
})
