/** KiCad 9's private fields: `(property private "Name" "Value" …)`, read by their name. */
import { describe, expect, test } from 'vitest'
import {
  addSchematicSymbolToAST,
  libSymbolChain,
  libSymbolUnitPins,
  parseKicadSchematic,
  serializeKicadSchematic,
  setSchematicPropertyValue
} from '../schematic'
import { nm } from '../coordinates'

const SHEET = `(kicad_sch (version 20250114) (generator "eeschema") (uuid "00000000-0000-0000-0000-000000000001") (paper "A4")
  (lib_symbols
    (symbol "Device:R" (in_bom yes) (on_board yes)
      (property "Reference" "R" (at 2 0 90) (effects (font (size 1.27 1.27))))
      (property private "Sim.Notes" "trimmed" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))))
  (sheet_instances (path "/" (page "1"))))`

describe('a private field', () => {
  test('is read by its name, marked private, and written back in place', () => {
    const sheet = parseKicadSchematic(SHEET)
    const field = sheet.libSymbols.get('Device:R')!.properties.find((p) => p.isPrivate)!
    expect(field.key).toBe('Sim.Notes')
    expect(field.value).toBe('trimmed')
    setSchematicPropertyValue(field, 'kept')
    expect(serializeKicadSchematic(sheet)).toContain('(property private "Sim.Notes" "kept"')
  })
})

describe('placing a symbol with a private field', () => {
  test('leaves the private field on the library symbol, as KiCad does', () => {
    const sheet = parseKicadSchematic(SHEET)
    const definition = sheet.libSymbols.get('Device:R')!
    const chain = libSymbolChain(definition, (name) => sheet.libSymbols.get(name))
    addSchematicSymbolToAST(
      sheet,
      definition,
      { x: nm(10_000_000), y: nm(10_000_000), angle: 0 },
      'R1',
      libSymbolUnitPins(chain),
      [{ project: 'demo', path: '/00000000-0000-0000-0000-000000000001' }]
    )
    const placed = parseKicadSchematic(serializeKicadSchematic(sheet)).symbols[0]
    expect(placed.properties.map((p) => p.key)).toEqual(['Reference'])
  })
})
