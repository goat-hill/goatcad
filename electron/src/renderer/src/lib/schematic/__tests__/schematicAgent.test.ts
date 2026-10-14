import { describe, expect, test } from 'vitest'
import {
  addressablePins,
  asMm,
  boxOfFrame,
  DESCRIBE_CAP,
  inflateBox,
  paperFrame,
  sheetFrameOf,
  unionBoxes,
  worldBoxOf,
  describeSchematic,
  documentKindOf,
  fileCandidates,
  resolveAgentFile,
  changedIds,
  diffDescribe,
  netChanged,
  halfExtents,
  offGridPlacement,
  labelAngleForPin,
  partPropertyMap,
  resolveAgentSheet,
  resolvePinRef,
  symbolValue,
  type AddressablePin,
  type Box
} from '../schematicAgent'
import {
  parseKicadSchematic,
  type KicadSchematic,
  type KicadSchematicSymbol
} from '../../kicad/schematic'
import { buildSheetConnectivity } from '../connectivity'
import { mmToNm, nm, type Nm } from '../../kicad/coordinates'
import type { PlacementGeometry } from '../schematicTools'

const MM = 1_000_000

/** A square outline of `half` millimetres either side of the origin. */
const geometry = (half: number): PlacementGeometry => ({
  outline: [
    { x: nm(-half * MM), y: nm(-half * MM) },
    { x: nm(half * MM), y: nm(-half * MM) },
    { x: nm(half * MM), y: nm(half * MM) },
    { x: nm(-half * MM), y: nm(half * MM) },
    { x: nm(-half * MM), y: nm(-half * MM) }
  ],
  pins: []
})

const box = (minX: number, minY: number, maxX: number, maxY: number): Box => ({
  minX: minX * MM,
  minY: minY * MM,
  maxX: maxX * MM,
  maxY: maxY * MM
})

const SOURCE = `(kicad_sch
  (version 20231120)
  (generator "eeschema")
  (uuid "root-uuid")
  (paper "A4")
  (lib_symbols
    (symbol "Device:R"
      (property "Reference" "R" (at 0 0 0))
      (symbol "R_0_1"
        (rectangle (start -1.016 -2.54) (end 1.016 2.54)
          (stroke (width 0.254) (type default))
          (fill (type none))))
      (symbol "R_1_1"
        (pin passive line (at 0 3.81 270) (length 1.27)
          (name "~" (effects (font (size 1.27 1.27))))
          (number "1" (effects (font (size 1.27 1.27)))))
        (pin passive line (at 0 -3.81 90) (length 1.27)
          (name "~" (effects (font (size 1.27 1.27))))
          (number "2" (effects (font (size 1.27 1.27)))))))
  )
  (wire (pts (xy 50.8 52.07) (xy 63.5 52.07))
    (stroke (width 0) (type default))
    (uuid "wire-uuid"))
  (label "VBUS" (at 63.5 52.07 0)
    (effects (font (size 1.27 1.27)) (justify left bottom)))
  (symbol
    (lib_id "Device:R")
    (at 50.8 55.88 0)
    (unit 1)
    (in_bom yes)
    (on_board yes)
    (dnp yes)
    (uuid "symbol-uuid")
    (property "Reference" "R1" (at 52.07 54.61 0) (effects (font (size 1.27 1.27))))
    (property "Value" "10k" (at 52.07 57.15 0) (effects (font (size 1.27 1.27))))
    (property "MPN" "RC0402FR-0710KL" (at 50.8 55.88 0) (effects (font (size 1.27 1.27)) hide))
    (property "ki_locked" "" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
    (property "Blank" "" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
    (pin "1" (uuid "pin-1"))
    (pin "2" (uuid "pin-2")))
  (sheet_instances (path "/" (page "1")))
)`

const parsed = (): KicadSchematic => parseKicadSchematic(SOURCE)

const describeOf = (schematic: KicadSchematic): Record<string, unknown> =>
  describeSchematic({
    schematic,
    connectivity: buildSheetConnectivity(schematic),
    // The single-sheet connectivity's own instance path.
    sheetPath: '/',
    filePath: '/p/main.kicad_sch',
    name: 'main.kicad_sch',
    readOnly: false,
    sheets: [
      {
        path: '/p/main.kicad_sch',
        name: 'main.kicad_sch',
        sheetPath: '/root-uuid',
        namePath: '/',
        depth: 0,
        symbolCount: schematic.symbols.length
      }
    ]
  })

describe('the wiring grid on a placement', () => {
  test('measures an outline by its widest extent either side of the origin', () => {
    expect(halfExtents(geometry(5))).toEqual({ halfW: 5 * MM, halfH: 5 * MM })
  })

  // A resistor: pins 3.81 mm either side of the origin, so the origin has to
  // sit at an odd multiple of 1.27 mm for both to land on the 2.54 mm grid.
  const resistor = (): PlacementGeometry => ({
    ...geometry(2),
    pins: [
      { x: nm(0), y: nm(3.81 * MM) },
      { x: nm(0), y: nm(-3.81 * MM) }
    ]
  })
  const at = (x: number, y: number): { x: Nm; y: Nm } => ({ x: mmToNm(x), y: mmToNm(y) })

  test('accepts an origin that puts every pin on the connection grid', () => {
    // The pins are 3.81 mm above and below the origin, so any origin on the
    // 1.27 mm connection grid puts them on it — the 2.54 mm pin pitch is the
    // guide's convention, not the window's rule, as KiCad's own ERC has it.
    expect(offGridPlacement(resistor(), at(101.6, 72.39), 0)).toBeNull()
    expect(offGridPlacement(resistor(), at(101.6, 71.12), 0)).toBeNull()
    expect(offGridPlacement(resistor(), at(100.33, 71.12), 90)).toBeNull()
  })

  test('refuses an origin that leaves a pin off grid, naming the nearest that works', () => {
    const result = offGridPlacement(resistor(), at(101.6, 71.5), 0)
    expect(result).not.toBeNull()
    expect(result!.pins).toHaveLength(2)
    expect(asMm(result!.nearest.x)).toBe(101.6)
    expect(asMm(result!.nearest.y)).toBe(71.12)
    expect(offGridPlacement(resistor(), result!.nearest, 0)).toBeNull()
  })

  test('a tie between two grid lines moves toward the origin', () => {
    const result = offGridPlacement(resistor(), at(101.6, 71.755), 0)
    expect(result).not.toBeNull()
    expect(asMm(result!.nearest.y)).toBe(71.12)
  })

  test('folds the rotation in before it looks', () => {
    // Turned 90°, the pins lie along x, so the origin's x carries the offset.
    const result = offGridPlacement(resistor(), at(101.98, 71.12), 90)
    expect(result).not.toBeNull()
    expect(asMm(result!.nearest.x)).toBe(101.6)
    expect(asMm(result!.nearest.y)).toBe(71.12)
    expect(offGridPlacement(resistor(), result!.nearest, 90)).toBeNull()
  })

  test('lets a symbol whose pins can never all sit on grid through', () => {
    // Mixed offsets are the library's drawing; the caller's origin is not the
    // problem, and KiCad places such a symbol too.
    const odd: PlacementGeometry = {
      ...geometry(2),
      pins: [
        { x: nm(0), y: nm(2.54 * MM) },
        { x: nm(0), y: nm(-3.175 * MM) }
      ]
    }
    expect(offGridPlacement(odd, at(101.6, 71.12), 0)).toBeNull()
  })

  test('has nothing to say about a symbol with no pins', () => {
    expect(offGridPlacement(geometry(5), at(100.1, 50.3), 0)).toBeNull()
  })
})

describe('reading a sheet back', () => {
  test('says which page the sheet is drawn on', () => {
    expect((describeOf(parsed()) as { paper: unknown }).paper).toEqual({
      size: 'A4',
      portrait: false,
      box: { x: 0, y: 0, width: 297, height: 210 }
    })
  })

  test('reports each symbol with its reference, value and part fields', () => {
    const result = describeOf(parsed()) as {
      symbols: Array<{ reference: string; value: string; properties: Record<string, string> }>
      counts: { symbols: number }
    }
    expect(result.counts.symbols).toBe(1)
    expect(result.symbols[0]).toMatchObject({
      reference: 'R1',
      libId: 'Device:R',
      value: '10k',
      properties: { MPN: 'RC0402FR-0710KL' }
    })
  })

  test('omits ki_* bookkeeping and blank fields from a part binding', () => {
    const symbol = parsed().symbols[0]
    expect(partPropertyMap(symbol)).toEqual({ MPN: 'RC0402FR-0710KL' })
    // Reference and Value have their own columns; repeating them would invite
    // an agent to write the same fact two ways.
    expect(partPropertyMap(symbol)).not.toHaveProperty('Reference')
    expect(symbolValue(symbol)).toBe('10k')
  })

  test('carries dnp as present-or-absent rather than a column of falses', () => {
    const result = describeOf(parsed()) as { symbols: Array<Record<string, unknown>> }
    expect(result.symbols[0].dnp).toBe(true)
    expect(result.symbols[0]).not.toHaveProperty('inBom')
  })

  test('says which nets someone actually named', () => {
    const result = describeOf(parsed()) as { nets: Array<{ name: string; named: boolean }> }
    // Local labels are scoped by sheet path, so the name carries the path.
    expect(result.nets.find((net) => net.name === '/VBUS')?.named).toBe(true)
    // A net named after the pin that lands on it is not a signal anyone chose,
    // and an agent must not cite it as one.
    expect(result.nets.find((net) => net.name.startsWith('unconnected-'))?.named).toBe(false)
  })

  test('reports unconnected pins, which is the point of reading back', () => {
    const result = describeOf(parsed()) as {
      unconnected: Array<{ reference: string; pin: string }>
      counts: { unconnected: number }
    }
    // Pin 1 sits on the wire; pin 2 hangs.
    expect(result.unconnected).toEqual([{ reference: 'R1', pin: '2', at: { x: 50.8, y: 59.69 } }])
    expect(result.counts.unconnected).toBe(1)
  })

  test('positions come back in millimetres, not nanometres', () => {
    const result = describeOf(parsed()) as {
      symbols: Array<{ at: { x: number; y: number }; angle: number }>
    }
    expect(result.symbols[0].at).toEqual({ x: 50.8, y: 55.88 })
    expect(result.symbols[0].angle).toBe(0)
  })

  test('announces a truncation rather than letting a cut list read as complete', () => {
    const schematic = parsed()
    const one = schematic.symbols[0]
    schematic.symbols = Array.from({ length: DESCRIBE_CAP + 5 }, () => one)
    const result = describeOf(schematic) as {
      symbols: unknown[]
      counts: { symbols: number }
      truncated?: true
      guidance: string
    }
    expect(result.symbols).toHaveLength(DESCRIBE_CAP)
    expect(result.counts.symbols).toBe(DESCRIBE_CAP + 5)
    expect(result.truncated).toBe(true)
    expect(result.guidance).toContain('items_query')
  })

  test('says nothing about truncation when nothing was cut', () => {
    expect(describeOf(parsed())).not.toHaveProperty('truncated')
  })
})

describe('resolving the sheet an agent means', () => {
  const tabs = [
    { name: 'main.kicad_sch', path: '/p/main.kicad_sch' },
    { name: 'power.kicad_sch', path: '/p/power.kicad_sch' },
    { name: 'board.kicad_pcb', path: '/p/board.kicad_pcb' }
  ]
  const files = [
    { name: 'p', path: '/p', children: [{ name: 'usb.kicad_sch', path: '/p/sub/usb.kicad_sch' }] }
  ]

  test('takes the sheet in front of the user when none is named', () => {
    expect(
      resolveAgentSheet(undefined, { openTabs: tabs, activePath: '/p/power.kicad_sch', files })
    ).toBe('/p/power.kicad_sch')
  })

  test('refuses to guess between several open sheets', () => {
    // Picking the wrong one writes to the wrong board, which is the one failure
    // here that a user cannot see coming.
    expect(
      resolveAgentSheet(undefined, { openTabs: tabs, activePath: '/p/board.kicad_pcb', files })
    ).toBeNull()
  })

  test('falls back to the only schematic open when the active tab is not one', () => {
    const single = [tabs[0], tabs[2]]
    expect(
      resolveAgentSheet(undefined, { openTabs: single, activePath: '/p/board.kicad_pcb', files })
    ).toBe('/p/main.kicad_sch')
  })

  test("falls back to the project's root sheet when no open tab resolves", () => {
    const root = '/p/main.kicad_sch'
    expect(
      resolveAgentSheet(undefined, { openTabs: [], activePath: null, files, rootPath: root })
    ).toBe(root)
    // Several open sheets, none in front: the root, never one of the tabs.
    expect(
      resolveAgentSheet(undefined, {
        openTabs: tabs,
        activePath: '/p/board.kicad_pcb',
        files,
        rootPath: root
      })
    ).toBe(root)
    // The sheet in front still wins.
    expect(
      resolveAgentSheet(undefined, {
        openTabs: tabs,
        activePath: '/p/power.kicad_sch',
        files,
        rootPath: root
      })
    ).toBe('/p/power.kicad_sch')
    expect(
      resolveAgentSheet(undefined, { openTabs: [], activePath: null, files, rootPath: null })
    ).toBeNull()
  })

  test('matches an open tab by path or by bare file name', () => {
    expect(
      resolveAgentSheet('/p/main.kicad_sch', { openTabs: tabs, activePath: null, files })
    ).toBe('/p/main.kicad_sch')
    expect(resolveAgentSheet('POWER.kicad_sch', { openTabs: tabs, activePath: null, files })).toBe(
      '/p/power.kicad_sch'
    )
  })

  test('finds a sheet in the project tree that is not open yet', () => {
    expect(resolveAgentSheet('usb.kicad_sch', { openTabs: tabs, activePath: null, files })).toBe(
      '/p/sub/usb.kicad_sch'
    )
  })

  test('will not resolve a name that is not a schematic', () => {
    expect(resolveAgentSheet('board.kicad_pcb', { openTabs: tabs, activePath: null, files })).toBe(
      null
    )
    expect(
      resolveAgentSheet('/p/board.kicad_pcb', { openTabs: tabs, activePath: null, files })
    ).toBe(null)
  })

  test('answers null for a name nothing matches', () => {
    expect(resolveAgentSheet('nope.kicad_sch', { openTabs: tabs, activePath: null, files })).toBe(
      null
    )
  })
})

// --- connect: addressing a pin, and where its label points -------------------

const CONNECT_LIB = `
  (lib_symbols
    (symbol "Device:R"
      (symbol "R_1_1"
        (pin passive line (at 0 3.81 270) (length 1.27)
          (name "~" (effects (font (size 1.27 1.27))))
          (number "1" (effects (font (size 1.27 1.27)))))
        (pin passive line (at 0 -3.81 90) (length 1.27)
          (name "~" (effects (font (size 1.27 1.27))))
          (number "2" (effects (font (size 1.27 1.27)))))))
    (symbol "MCU:U"
      (symbol "U_1_1"
        (pin power_in line (at -7.62 0 0) (length 2.54)
          (name "VDD" (effects (font (size 1.27 1.27))))
          (number "1" (effects (font (size 1.27 1.27)))))
        (pin power_in line (at -7.62 -2.54 0) (length 2.54)
          (name "GND" (effects (font (size 1.27 1.27))))
          (number "2" (effects (font (size 1.27 1.27)))))
        (pin power_in line (at -7.62 -5.08 0) (length 2.54)
          (name "GND" (effects (font (size 1.27 1.27))))
          (number "3" (effects (font (size 1.27 1.27))))))))
`

const connectDoc = (body: string): string =>
  `(kicad_sch (version 20231120) (generator "test") (uuid "aaaaaaaa-0000-0000-0000-000000000000") ${CONNECT_LIB} ${body})`

const placed = (
  libId: string,
  reference: string,
  x: number,
  y: number,
  angle = 0,
  mirror = ''
): string =>
  `(symbol (lib_id "${libId}") (at ${x} ${y} ${angle}) ${mirror ? `(mirror ${mirror})` : ''} (unit 1) (uuid "${reference}")
     (property "Reference" "${reference}" (at ${x} ${y} 0))
     (property "Value" "v" (at ${x} ${y} 0)))`

const pinsOf = (body: string): AddressablePin[] =>
  addressablePins(parseKicadSchematic(connectDoc(body)), '/')

describe('labelAngleForPin', () => {
  const symbol = (angle: number, mirror?: 'x' | 'y'): KicadSchematicSymbol =>
    ({ position: { x: 0, y: 0, angle }, mirror }) as KicadSchematicSymbol

  test('points away from the body, not into it', () => {
    // A pin whose angle is 0 reaches rightward into the symbol, so it sits on
    // the left edge and its label reads leftward.
    expect(labelAngleForPin(symbol(0), 0)).toBe(180)
    expect(labelAngleForPin(symbol(0), 180)).toBe(0)
    expect(labelAngleForPin(symbol(0), 270)).toBe(90)
  })

  test('turns with the symbol', () => {
    expect(labelAngleForPin(symbol(90), 0)).toBe(270)
    expect(labelAngleForPin(symbol(180), 0)).toBe(0)
  })

  test('follows a mirror', () => {
    expect(labelAngleForPin(symbol(0, 'y'), 0)).toBe(0)
    expect(labelAngleForPin(symbol(0, 'x'), 270)).toBe(270)
  })

  test('never produces an angle nobody can read', () => {
    for (const pinAngle of [0, 45, 90, 135, 180, 270]) {
      expect([0, 90, 180, 270]).toContain(labelAngleForPin(symbol(0), pinAngle))
    }
  })
})

describe('resolvePinRef', () => {
  const pins = pinsOf(
    [placed('Device:R', 'R1', 100, 100), placed('MCU:U', 'U1', 120, 100)].join(' ')
  )

  test('takes a pad number', () => {
    const found = resolvePinRef('R1.2', pins)
    expect(found.ok).toBe(true)
    if (found.ok) expect(found.pin.number).toBe('2')
  })

  test('takes a pin name when it names exactly one pad', () => {
    const found = resolvePinRef('U1.VDD', pins)
    expect(found.ok).toBe(true)
    if (found.ok) expect(found.pin.number).toBe('1')
  })

  test('refuses a name that means two pads, rather than picking one', () => {
    // The failure this prevents: connecting the wrong ground pad and never
    // finding out, because both are called GND.
    const found = resolvePinRef('U1.GND', pins)
    expect(found.ok).toBe(false)
    if (!found.ok) expect(found.candidates).toEqual(['U1.2', 'U1.3'])
  })

  test('names the references that exist when the symbol does not', () => {
    const found = resolvePinRef('R9.1', pins)
    expect(found.ok).toBe(false)
    if (!found.ok) expect(found.candidates).toEqual(['R1', 'U1'])
  })

  test('lists the pins that exist when the pad does not', () => {
    const found = resolvePinRef('R1.7', pins)
    expect(found.ok).toBe(false)
    if (!found.ok) expect(found.candidates).toEqual(['R1.1', 'R1.2'])
  })

  test('rejects something that is not a pin id at all', () => {
    expect(resolvePinRef('R1', pins).ok).toBe(false)
    expect(resolvePinRef('.2', pins).ok).toBe(false)
    expect(resolvePinRef('R1.', pins).ok).toBe(false)
  })

  test('splits on the first dot, so a pin named 3.3V still resolves', () => {
    const found = resolvePinRef('U1.VDD', pins)
    expect(found.ok).toBe(true)
  })
})

describe('addressablePins', () => {
  test('puts a pin where connectivity puts it', () => {
    const body = placed('Device:R', 'R1', 100, 100)
    const pins = pinsOf(body)
    const connectivity = buildSheetConnectivity(parseKicadSchematic(connectDoc(body)))
    const dangling = connectivity.dangling.find((end) => end.pinNumber === '1')!
    const pin = pins.find((entry) => entry.number === '1')!
    expect(pin.position).toEqual(dangling.position)
  })
})

describe('diffDescribe', () => {
  const projection = (
    revision: number,
    symbols: Array<Record<string, unknown>>,
    unconnected: Array<Record<string, unknown>> = []
  ): Record<string, unknown> => ({
    sheet: { path: '/a.kicad_sch', name: 'a' },
    revision,
    symbols,
    nets: [],
    unconnected,
    counts: { symbols: symbols.length, nets: 0, unconnected: unconnected.length }
  })

  test('reports only the row that moved', () => {
    const before = projection(1, [
      { reference: 'R1', value: '10k' },
      { reference: 'R2', value: '1k' }
    ])
    const after = projection(2, [
      { reference: 'R1', value: '10k' },
      { reference: 'R2', value: '4k7' }
    ])
    const diff = diffDescribe(before, after) as {
      symbols: {
        created: Array<{ reference: string }>
        updated: Array<{ reference: string }>
        deleted: string[]
      }
      since: number
      revision: number
    }
    expect(diff.symbols.updated.map((row) => row.reference)).toEqual(['R2'])
    expect(diff.symbols.created).toEqual([])
    expect(diff.symbols.deleted).toEqual([])
    expect(diff.since).toBe(1)
    expect(diff.revision).toBe(2)
  })

  test('names what went away by its id', () => {
    const before = projection(1, [{ reference: 'R1' }, { reference: 'R2' }])
    const after = projection(2, [{ reference: 'R1' }])
    const diff = diffDescribe(before, after) as { symbols: { deleted: string[] } }
    expect(diff.symbols.deleted).toEqual(['R2'])
  })

  test('counts the whole sheet, not the diff', () => {
    // The trap this guards: an agent reading `counts.symbols` off a change list
    // and concluding the board has one part on it.
    const after = projection(2, [{ reference: 'R1' }, { reference: 'R2' }])
    const diff = diffDescribe(projection(1, [{ reference: 'R1' }]), after) as {
      counts: { symbols: number }
      symbols: { created: unknown[]; updated: unknown[] }
    }
    expect(diff.symbols.created).toHaveLength(1)
    expect(diff.symbols.updated).toHaveLength(0)
    expect(diff.counts.symbols).toBe(2)
  })

  test('says plainly when nothing changed, rather than answering with silence', () => {
    const same = projection(1, [{ reference: 'R1' }])
    const diff = diffDescribe(same, { ...same, revision: 2 }) as { guidance: string }
    expect(diff.guidance).toContain('Nothing changed')
  })

  test('tracks unconnected pins by pin id, not by symbol', () => {
    const before = projection(
      1,
      [],
      [
        { reference: 'U1', pin: '1' },
        { reference: 'U1', pin: '2' }
      ]
    )
    const after = projection(2, [], [{ reference: 'U1', pin: '2' }])
    const diff = diffDescribe(before, after) as { unconnected: { deleted: string[] } }
    expect(diff.unconnected.deleted).toEqual(['U1.1'])
  })
})

describe('framing a render', () => {
  test('unionBoxes holds every box and is null for none', () => {
    expect(unionBoxes([])).toBeNull()
    expect(unionBoxes([box(0, 0, 10, 10), box(-5, 20, 2, 30)])).toEqual(box(-5, 0, 10, 30))
  })

  test('inflateBox grows every side by the margin', () => {
    expect(inflateBox(box(0, 0, 10, 10), 5 * MM)).toEqual(box(-5, -5, 15, 15))
  })

  test('worldBoxOf flips y the way the scene draws, and sheetFrameOf flips it back', () => {
    const world = worldBoxOf(box(10, 20, 110, 70))
    expect(world).toEqual({ minX: 10, maxX: 110, minY: -70, maxY: -20 })
    expect(sheetFrameOf(world)).toEqual({ x: 10, y: 20, width: 100, height: 50 })
  })

  test('boxOfFrame reads the millimetre rectangle an agent sends', () => {
    expect(boxOfFrame({ x: 10, y: 20, width: 100, height: 50 })).toEqual(box(10, 20, 110, 70))
  })

  // The frame a render reports is the CONTENT. The page is answered beside it
  // so an agent can tell "my block ran off the paper" from "the render broke".
  test('paperFrame is the page from the sheet origin, in millimetres', () => {
    expect(
      paperFrame({ size: 'A3', portrait: false, width: mmToNm(420), height: mmToNm(297) })
    ).toEqual({ size: 'A3', portrait: false, box: { x: 0, y: 0, width: 420, height: 297 } })
  })
})

describe('resolving any file an agent means', () => {
  const tree = [
    { name: 'phoneamenal.kicad_sch', path: '/p/phoneamenal.kicad_sch' },
    { name: 'phoneamenal.kicad_pcb', path: '/p/phoneamenal.kicad_pcb' },
    {
      name: 'lib',
      path: '/p/lib',
      isDirectory: true,
      children: [
        { name: 'notes.md', path: '/p/lib/notes.md' },
        { name: 'phoneamenal.kicad_sym', path: '/p/lib/phoneamenal.kicad_sym' }
      ]
    },
    { name: 'notes.md', path: '/p/notes.md' }
  ]
  const tabs = [{ name: 'phoneamenal.kicad_pcb', path: '/p/phoneamenal.kicad_pcb' }]

  test('an open tab wins, then the tree, by path or by unique name', () => {
    expect(resolveAgentFile('phoneamenal.kicad_pcb', { openTabs: tabs, files: tree })).toBe(
      '/p/phoneamenal.kicad_pcb'
    )
    expect(resolveAgentFile('PHONEAMENAL.kicad_sym', { openTabs: tabs, files: tree })).toBe(
      '/p/lib/phoneamenal.kicad_sym'
    )
    expect(resolveAgentFile('/p/lib/notes.md', { openTabs: tabs, files: tree })).toBe(
      '/p/lib/notes.md'
    )
  })

  test('a name that matches two files, a directory, or nothing is refused', () => {
    expect(resolveAgentFile('notes.md', { openTabs: tabs, files: tree })).toBeNull()
    expect(resolveAgentFile('lib', { openTabs: tabs, files: tree })).toBeNull()
    expect(resolveAgentFile('/elsewhere/x.kicad_sch', { openTabs: tabs, files: tree })).toBeNull()
  })

  test('candidates share a stem with what was asked, and fall back to everything', () => {
    expect(fileCandidates(tree, 'phoneamenal.sch')).toEqual([
      '/p/phoneamenal.kicad_sch',
      '/p/phoneamenal.kicad_pcb',
      '/p/lib/phoneamenal.kicad_sym'
    ])
    expect(fileCandidates(tree, 'zzz', 2)).toEqual([
      '/p/phoneamenal.kicad_sch',
      '/p/phoneamenal.kicad_pcb'
    ])
  })

  test('documentKindOf reads the extension', () => {
    expect(
      ['a.kicad_sch', 'a.kicad_pcb', 'a.kicad_sym', 'a.kicad_mod', 'a.kicad_pro', 'a.md'].map(
        documentKindOf
      )
    ).toEqual(['schematic', 'board', 'symbol-library', 'footprint', 'project', 'text'])
  })
})

describe('what a write answers it changed', () => {
  test('a change set answers its ids, each once', () => {
    expect(
      changedIds({
        created: [{ id: 'R2', kind: 'symbol' }],
        updated: [
          { id: 'R1', kind: 'symbol' },
          { id: 'R1', kind: 'symbol' }
        ],
        deleted: [{ id: 'label-1', kind: 'label' }]
      })
    ).toEqual({ created: ['R2'], updated: ['R1'], deleted: ['label-1'] })
  })

  test('several writes answer what they came to together', () => {
    expect(
      netChanged([
        { created: ['R2', 'R3'], updated: ['R1'], deleted: [] },
        { created: [], updated: ['R2', 'R4'], deleted: ['R3', 'R5'] }
      ])
    ).toEqual({ created: ['R2'], updated: ['R1', 'R4'], deleted: ['R5'] })
  })
})
