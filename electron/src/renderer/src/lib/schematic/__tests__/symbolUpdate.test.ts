import { describe, expect, test } from 'vitest'
import {
  getSymbolProperty,
  parseKicadSchematic,
  serializeKicadSchematic,
  type KicadLibSymbol,
  type KicadSchematic
} from '../../kicad/schematic'
import { mmToNm, type Nm } from '../../kicad/coordinates'
import {
  applySymbolUpdate,
  CHANGE_DEFAULTS,
  checkSymbolUpdate,
  symbolUpdatePinMoves,
  UPDATE_DEFAULTS
} from '../symbolUpdate'
import { applyMovePlan, planMovedPoints, selectionOf } from '../schematicMove'

const PIN = (number: string, y: number, angle: number): string =>
  `(pin passive line (at 0 ${y} ${angle}) (length 1.27)
          (name "~" (effects (font (size 1.27 1.27))))
          (number "${number}" (effects (font (size 1.27 1.27)))))`

/** The sheet's copy of Device:R: pins at ±3.81 mm. */
const OLD_R = `(symbol "Device:R"
      (property "Reference" "R" (at 2.032 0 90) (effects (font (size 1.27 1.27))))
      (property "Value" "R" (at 0 0 90) (effects (font (size 1.27 1.27))))
      (property "Footprint" "" (at -1.778 0 90) (effects (font (size 1.27 1.27)) hide))
      (symbol "R_0_1"
        (rectangle (start -1.016 -2.54) (end 1.016 2.54)
          (stroke (width 0.254) (type default))
          (fill (type none))))
      (symbol "R_1_1"
        ${PIN('1', 3.81, 270)}
        ${PIN('2', -3.81, 90)}))`

const sheet = (): KicadSchematic =>
  parseKicadSchematic(`(kicad_sch
  (version 20231120)
  (generator "eeschema")
  (uuid "root")
  (paper "A4")
  (lib_symbols
    (symbol "Device:A"
      (property "Reference" "A" (at 0 0 0) (effects (font (size 1.27 1.27)))))
    ${OLD_R}
    (symbol "Device:Z"
      (property "Reference" "Z" (at 0 0 0) (effects (font (size 1.27 1.27)))))
  )
  (wire (pts (xy 50.8 40.64) (xy 50.8 52.07))
    (stroke (width 0) (type default))
    (uuid "wire-uuid"))
  (symbol
    (lib_id "Device:R")
    (at 50.8 55.88 0)
    (unit 1)
    (in_bom yes)
    (on_board yes)
    (dnp no)
    (uuid "r1")
    (property "Reference" "R1" (at 52.07 54.61 0) (effects (font (size 1.27 1.27)) (justify left)))
    (property "Value" "10k" (at 52.07 57.15 0) (effects (font (size 1.27 1.27)) (justify left)))
    (property "Footprint" "Resistor_SMD:R_0402" (at 50.8 55.88 0) (effects (font (size 1.27 1.27)) hide))
    (property "MPN" "RC0402" (at 50.8 55.88 0) (effects (font (size 1.27 1.27)) hide))
    (pin "1" (uuid "r1-pin-1"))
    (pin "2" (uuid "r1-pin-2"))
    (instances (project "p" (path "/root" (reference "R1") (unit 1)))))
  (symbol
    (lib_id "Device:R")
    (at 76.2 55.88 0)
    (unit 1)
    (in_bom yes)
    (on_board yes)
    (dnp no)
    (uuid "r2")
    (property "Reference" "R2" (at 77.47 54.61 0) (effects (font (size 1.27 1.27)) (justify left)))
    (property "Value" "1k" (at 77.47 57.15 0) (effects (font (size 1.27 1.27)) (justify left)))
    (pin "1" (uuid "r2-pin-1"))
    (pin "2" (uuid "r2-pin-2"))
    (instances (project "p" (path "/root" (reference "R2") (unit 1)))))
  (sheet_instances (path "/" (page "1")))
)`)

/** The library as it is now: R's pins moved out to ±5.08 and a new field, and a C. */
const library = parseKicadSchematic(`(kicad_sch (version 20231120) (uuid "lib")
  (lib_symbols
    (symbol "Device:R"
      (property "Reference" "R" (at 2.032 0 90) (effects (font (size 1.27 1.27))))
      (property "Value" "R" (at 0 0 90) (effects (font (size 1.27 1.27))))
      (property "Footprint" "" (at -1.778 0 90) (effects (font (size 1.27 1.27)) hide))
      (property "Sim.Device" "R" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
      (symbol "R_0_1"
        (rectangle (start -1.016 -3.81) (end 1.016 3.81)
          (stroke (width 0.254) (type default))
          (fill (type none))))
      (symbol "R_1_1"
        ${PIN('1', 5.08, 270)}
        ${PIN('2', -5.08, 90)}))
    (symbol "Device:C"
      (property "Reference" "C" (at 1.524 0 0) (effects (font (size 1.27 1.27)) (justify left)))
      (property "Value" "C" (at 1.524 -2.54 0) (effects (font (size 1.27 1.27)) (justify left)))
      (property "Footprint" "Capacitor_SMD:C_0402" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
      (in_bom no)
      (symbol "C_1_1"
        ${PIN('1', 3.81, 270)}
        ${PIN('2', -3.81, 90)}
        ${PIN('3', 0, 180)})))
)`)

const lookup = (libId: string): KicadLibSymbol | undefined => library.libSymbols.get(libId)
const reparse = (doc: KicadSchematic): KicadSchematic =>
  parseKicadSchematic(serializeKicadSchematic(doc))
const mm = (value: number): Nm => mmToNm(value)
const definitionNames = (doc: KicadSchematic): string[] => [...doc.libSymbols.keys()]

describe('update from library', () => {
  test('the sheet copy is replaced where it stood; placements keep what they are', () => {
    const doc = sheet()
    const report = applySymbolUpdate(
      doc,
      [
        { index: 0, libId: 'Device:R' },
        { index: 1, libId: 'Device:R' }
      ],
      lookup,
      UPDATE_DEFAULTS
    )
    expect(report.updated).toEqual([0, 1])
    const after = reparse(doc)
    // In place, between its neighbors, and the copy now matches the library.
    expect(definitionNames(after)).toEqual(['Device:A', 'Device:R', 'Device:Z'])
    expect(after.libSymbols.get('Device:R')?.pins).toEqual([])
    expect(after.libSymbols.get('Device:R')?.variants[1].pins[0].position.y).toBe(mm(5.08))
    const [r1, r2] = after.symbols
    expect(r1.position).toEqual({ x: mm(50.8), y: mm(55.88), angle: 0 })
    expect(r1.libName).toBeUndefined()
    // Reference and Value are not in the list by default; an empty library
    // Footprint does not overwrite a chosen one; a user field stays.
    expect(getSymbolProperty(r1, 'Reference')).toBe('R1')
    expect(getSymbolProperty(r1, 'Value')).toBe('10k')
    expect(getSymbolProperty(r1, 'Footprint')).toBe('Resistor_SMD:R_0402')
    expect(getSymbolProperty(r1, 'MPN')).toBe('RC0402')
    // A field the library has and the placement lacks comes along, hidden.
    const sim = r2.properties.find((field) => field.key === 'Sim.Device')
    expect(sim?.value).toBe('R')
    expect(sim?.hidden).toBe(true)
    expect(sim?.position).toEqual({ x: mm(76.2), y: mm(55.88), angle: 0 })
    // Field positions stay unless asked.
    expect(r1.properties[0].position).toEqual({ x: mm(52.07), y: mm(54.61), angle: 0 })
    // Pins keep their uuids by number.
    expect(serializeKicadSchematic(after)).toMatch(/\(pin "1"\s+\(uuid "r1-pin-1"\)\s*\)/)
  })

  test('the fields list limits which fields the run touches', () => {
    const doc = sheet()
    applySymbolUpdate(doc, [{ index: 1, libId: 'Device:R' }], lookup, {
      ...UPDATE_DEFAULTS,
      fields: ['Footprint']
    })
    // Sim.Device is the library's and the placement lacks it, but it is not in the list.
    const r2 = reparse(doc).symbols[1]
    expect(r2.properties.some((field) => field.key === 'Sim.Device')).toBe(false)
  })

  test('given a fields list, Reference and Value keep their text but take the ticked look and place', () => {
    const doc = sheet()
    const before = { ...doc.symbols[0].properties.find((field) => field.key === 'Value')!.position }
    applySymbolUpdate(doc, [{ index: 0, libId: 'Device:R' }], lookup, {
      ...UPDATE_DEFAULTS,
      resetFieldText: true,
      resetFieldPositions: true,
      fields: []
    })
    const r1 = reparse(doc).symbols[0]
    expect(getSymbolProperty(r1, 'Reference')).toBe('R1')
    expect(getSymbolProperty(r1, 'Value')).toBe('10k')
    expect(r1.properties.find((field) => field.key === 'Value')!.position).not.toEqual(before)
  })

  test('a second run over an up-to-date sheet changes nothing', () => {
    const doc = sheet()
    const all = [
      { index: 0, libId: 'Device:R' },
      { index: 1, libId: 'Device:R' }
    ]
    applySymbolUpdate(doc, all, lookup, UPDATE_DEFAULTS)
    const once = serializeKicadSchematic(doc)
    const again = reparse(doc)
    applySymbolUpdate(again, all, lookup, UPDATE_DEFAULTS)
    expect(serializeKicadSchematic(again)).toBe(once)
  })

  test('updating one of two leaves the other on the old copy, the new one renamed', () => {
    const doc = sheet()
    applySymbolUpdate(doc, [{ index: 1, libId: 'Device:R' }], lookup, UPDATE_DEFAULTS)
    const after = reparse(doc)
    expect(definitionNames(after)).toEqual(['Device:A', 'Device:R', 'Device:Z', 'R_1'])
    expect(after.symbols[0].libName).toBeUndefined()
    expect(after.symbols[1].libName).toBe('R_1')
    expect(after.symbols[1].libId).toBe('Device:R')
    // The renamed copy's units follow its name, or KiCad refuses it.
    expect(serializeKicadSchematic(after)).toContain('(symbol "R_1_1_1"')
    // Updating the other one too folds both onto the name, the stale copy gone.
    applySymbolUpdate(after, [{ index: 0, libId: 'Device:R' }], lookup, UPDATE_DEFAULTS)
    const both = reparse(after)
    expect(both.symbols[0].libName).toBe('R_1')
    expect(definitionNames(both)).toEqual(['Device:A', 'Device:Z', 'R_1'])
  })

  test('the options reset what KiCad’s do', () => {
    const doc = sheet()
    applySymbolUpdate(doc, [{ index: 0, libId: 'Device:R' }], lookup, {
      ...UPDATE_DEFAULTS,
      updateValue: true,
      resetEmptyFields: true,
      removeExtraFields: true,
      resetFieldPositions: true,
      resetFieldVisibility: true
    })
    const [r1] = reparse(doc).symbols
    expect(getSymbolProperty(r1, 'Value')).toBe('R')
    expect(getSymbolProperty(r1, 'Footprint')).toBe('')
    expect(getSymbolProperty(r1, 'MPN')).toBeUndefined()
    // Reference kept out of the list: its text stays, its place does not.
    expect(getSymbolProperty(r1, 'Reference')).toBe('R1')
    const value = r1.properties.find((field) => field.key === 'Value')
    // The library's offset (0, 0) placed at the symbol, its angle kept.
    expect(value?.position).toEqual({ x: mm(50.8), y: mm(55.88), angle: 0 })
  })
})

describe('pin display, alternate functions and power values', () => {
  /** The library, edited: its text rewritten, then read as a lookup. */
  const libraryWith = (
    edit: (text: string) => string
  ): ((libId: string) => KicadLibSymbol | undefined) => {
    const edited = parseKicadSchematic(edit(serializeKicadSchematic(library)))
    return (libId) => edited.libSymbols.get(libId)
  }
  const sheetWith = (edit: (text: string) => string): KicadSchematic =>
    parseKicadSchematic(edit(serializeKicadSchematic(sheet())))
  const copyOf = (doc: KicadSchematic, index: number): KicadLibSymbol | undefined => {
    const placed = reparse(doc)
    const symbol = placed.symbols[index]
    return placed.libSymbols.get(symbol.libName ?? symbol.libId)
  }

  test('the new copy keeps whether pin names showed, unless the library’s is asked for', () => {
    const hidden = (text: string): string =>
      text.replace('(symbol "Device:R"', '(symbol "Device:R" (pin_names (hide yes))')
    const kept = sheetWith(hidden)
    applySymbolUpdate(kept, [{ index: 0, libId: 'Device:R' }], lookup, UPDATE_DEFAULTS)
    expect(copyOf(kept, 0)?.pinNamesHidden).toBe(true)
    const reset = sheetWith(hidden)
    applySymbolUpdate(reset, [{ index: 0, libId: 'Device:R' }], lookup, {
      ...UPDATE_DEFAULTS,
      resetPinTextVisibility: true
    })
    expect(copyOf(reset, 0)?.pinNamesHidden).toBe(false)
  })

  test('an alternate the new pin offers stays unless reset; one it lacks goes', () => {
    // Pin 1 of the library's R offers SDA.
    const sda = { name: 'SDA', electricalType: 'bidirectional', graphicStyle: 'line' }
    const offers = (libId: string): KicadLibSymbol | undefined => {
      const definition = lookup(libId)
      if (!definition) return undefined
      const withSda = <P extends { number: string; alternates: (typeof sda)[] }>(pin: P): P =>
        pin.number === '1' ? { ...pin, alternates: [sda] } : pin
      return {
        ...definition,
        pins: definition.pins.map(withSda),
        variants: definition.variants.map((v) => ({ ...v, pins: v.pins.map(withSda) }))
      }
    }
    const chosen = (name: string) => (text: string) =>
      text.replace('(uuid "r1-pin-1")', `(uuid "r1-pin-1") (alternate "${name}")`)
    const alternateOf = (doc: KicadSchematic): string | undefined =>
      serializeKicadSchematic(doc).match(/\(alternate "([^"]+)"\)/)?.[1]

    const kept = sheetWith(chosen('SDA'))
    applySymbolUpdate(kept, [{ index: 0, libId: 'Device:R' }], offers, UPDATE_DEFAULTS)
    expect(alternateOf(kept)).toBe('SDA')
    const reset = sheetWith(chosen('SDA'))
    applySymbolUpdate(reset, [{ index: 0, libId: 'Device:R' }], offers, {
      ...UPDATE_DEFAULTS,
      resetAlternatePins: true
    })
    expect(alternateOf(reset)).toBeUndefined()
    const gone = sheetWith(chosen('SCL'))
    applySymbolUpdate(gone, [{ index: 0, libId: 'Device:R' }], offers, UPDATE_DEFAULTS)
    expect(alternateOf(gone)).toBeUndefined()
  })

  test('a power symbol keeps its Value unless custom power values are reset', () => {
    const power = libraryWith((text) =>
      text.replace('(symbol "Device:R"', '(symbol "Device:R" (power)')
    )
    const options = { ...UPDATE_DEFAULTS, updateValue: true }
    const kept = sheet()
    applySymbolUpdate(kept, [{ index: 0, libId: 'Device:R' }], power, options)
    expect(getSymbolProperty(reparse(kept).symbols[0], 'Value')).toBe('10k')
    const reset = sheet()
    applySymbolUpdate(reset, [{ index: 0, libId: 'Device:R' }], power, {
      ...options,
      resetCustomPower: true
    })
    expect(getSymbolProperty(reparse(reset).symbols[0], 'Value')).toBe('R')
  })
})

describe('change symbol', () => {
  test('a new library id keeps the reference number and the unit, and takes the new look', () => {
    const doc = sheet()
    applySymbolUpdate(doc, [{ index: 0, libId: 'Device:C' }], lookup, {
      ...CHANGE_DEFAULTS,
      updateReference: true
    })
    const after = reparse(doc)
    const [c1, r2] = after.symbols
    expect(c1.libId).toBe('Device:C')
    expect(c1.instances[0].reference).toBe('C1')
    expect(getSymbolProperty(c1, 'Reference')).toBe('C1')
    expect(getSymbolProperty(c1, 'Value')).toBe('10k')
    expect(getSymbolProperty(c1, 'Footprint')).toBe('Capacitor_SMD:C_0402')
    expect(c1.inBom).toBe(false)
    expect(c1.uuid).toBe('r1')
    expect(r2.libId).toBe('Device:R')
    expect(definitionNames(after)).toEqual(['Device:A', 'Device:C', 'Device:R', 'Device:Z'])
    // Pin 3 is new: a node with a fresh uuid, beside the two kept.
    const text = serializeKicadSchematic(after)
    expect(text).toMatch(/\(pin "1"\s+\(uuid "r1-pin-1"\)\s*\)/)
    expect(text).toMatch(/\(pin "3"\s+\(uuid "[0-9a-f-]{36}"\)\s*\)/)
  })

  test('the definition no placement uses any more goes', () => {
    const doc = sheet()
    applySymbolUpdate(
      doc,
      [
        { index: 0, libId: 'Device:C' },
        { index: 1, libId: 'Device:C' }
      ],
      lookup,
      CHANGE_DEFAULTS
    )
    expect(definitionNames(reparse(doc))).toEqual(['Device:A', 'Device:C', 'Device:Z'])
  })

  test('what cannot be written is reported and left alone', () => {
    const doc = sheet()
    const report = checkSymbolUpdate(
      doc,
      [
        { index: 0, libId: 'Device:Missing' },
        { index: 1, libId: 'Device:R' }
      ],
      lookup
    )
    expect(report.notFound).toEqual(['Device:Missing'])
    expect(report.updated).toEqual([1])
    const unitTwo = sheet()
    unitTwo.symbols[0].unit = 2
    expect(
      checkSymbolUpdate(unitTwo, [{ index: 0, libId: 'Device:R' }], lookup).tooFewUnits
    ).toEqual([0])
  })
})

describe('wires stay on the pins that stay', () => {
  test('each surviving pin moves from where it is drawn to where the new copy draws it', () => {
    const doc = sheet()
    const moves = symbolUpdatePinMoves(doc, [{ index: 0, libId: 'Device:R' }], lookup)
    expect(moves.map(({ from, to }) => [from, to])).toEqual([
      [
        { x: mm(50.8), y: mm(52.07) },
        { x: mm(50.8), y: mm(50.8) }
      ],
      [
        { x: mm(50.8), y: mm(59.69) },
        { x: mm(50.8), y: mm(60.96) }
      ]
    ])
  })

  test('the wire on pin 1 follows it through the move plan', () => {
    const doc = sheet()
    const targets = [{ index: 0, libId: 'Device:R' }]
    const moved = symbolUpdatePinMoves(doc, targets, lookup)
    const plan = planMovedPoints(doc, moved, selectionOf([{ type: 'symbol', index: 0 }]), {
      grid: mm(1.27),
      wires: true,
      carryAttached: true
    })
    applySymbolUpdate(doc, targets, lookup, UPDATE_DEFAULTS)
    applyMovePlan(doc, plan)
    const after = reparse(doc)
    // Shortened to the pin's new end, from whichever end the reshape writes first.
    expect(after.wires[0].points).toHaveLength(2)
    expect(after.wires[0].points).toEqual(
      expect.arrayContaining([
        { x: mm(50.8), y: mm(40.64) },
        { x: mm(50.8), y: mm(50.8) }
      ])
    )
  })
})
