import { describe, expect, test } from 'vitest'
import {
  libSymbolUnitPins,
  parseKicadSchematic,
  serializeKicadSchematic,
  setSchematicSymbolBodyStyle,
  setSchematicSymbolUnit
} from '../../kicad/schematic'
import {
  findUnitHolder,
  letterSubReference,
  nextBodyStyle,
  placedSymbolChain,
  placedSymbolChoices,
  type UnitSource
} from '../symbolUnits'
import { buildSchematicGroups } from '../schematicPropertySchema'

const ROOT = '/root'

// A two-gate part with a De Morgan body: pins 1-2 on gate A, 3-4 on gate B.
const LIB = `(lib_symbols
  (symbol "Logic:NAND" (in_bom yes) (on_board yes)
    (property "Reference" "U" (at 0 0 0))
    (symbol "NAND_1_1" (pin input line (at 0 0 0) (length 2.54) (name "A") (number "1")))
    (symbol "NAND_1_2" (pin input line (at 0 0 0) (length 2.54) (name "A") (number "1")))
    (symbol "NAND_2_1" (pin input line (at 0 5 0) (length 2.54) (name "B") (number "3")))
    (symbol "NAND_2_2" (pin input line (at 0 5 0) (length 2.54) (name "B") (number "3")))))`

const placed = (reference: string, unit: number, extra = ''): string =>
  `(symbol (lib_id "Logic:NAND") (at 10 10 0) (unit ${unit})${extra} (in_bom yes) (on_board yes) (dnp no) (uuid "${reference}-${unit}")
    (property "Reference" "${reference}" (at 10 10 0))
    (pin "1" (uuid "pin-1"))
    (instances (project "p" (path "${ROOT}" (reference "${reference}") (unit ${unit})))))`

const sheet = (...symbols: string[]): ReturnType<typeof parseKicadSchematic> =>
  parseKicadSchematic(
    `(kicad_sch (version 20250114) (generator "test") (uuid "root") ${LIB} ${symbols.join(' ')})`
  )

describe('letterSubReference', () => {
  test('counts A to Z, then AA', () => {
    expect([1, 2, 26, 27, 28].map(letterSubReference)).toEqual(['A', 'B', 'Z', 'AA', 'AB'])
  })
})

describe('placed symbol choices', () => {
  test('reads units and body styles off the sheet copy', () => {
    const doc = sheet(placed('U1', 1))
    expect(placedSymbolChain(doc, doc.symbols[0])).toHaveLength(1)
    expect(placedSymbolChoices(doc, doc.symbols[0])).toEqual({ units: 2, bodyStyles: 2 })
  })

  test('a part the sheet does not carry offers nothing', () => {
    const doc = parseKicadSchematic(
      `(kicad_sch (version 20250114) (generator "test") (uuid "root") (lib_symbols) ${placed('U1', 1)})`
    )
    expect(placedSymbolChoices(doc, doc.symbols[0])).toEqual({ units: 1, bodyStyles: 1 })
  })

  test('the body style cycles and wraps', () => {
    expect(nextBodyStyle(1, 2)).toBe(2)
    expect(nextBodyStyle(2, 2)).toBe(1)
    expect(nextBodyStyle(1, 1)).toBe(1)
  })

  test('the properties panel offers the unit and body style rows only where they choose', () => {
    const doc = sheet(placed('U1', 2))
    const fields = (document: typeof doc): Array<[string, unknown]> =>
      buildSchematicGroups([{ type: 'symbol', index: 0 }], (key) => key, {
        symbols: document.symbols,
        labels: [],
        wires: [],
        junctions: [],
        noConnects: [],
        netName: null,
        document
      })[0].fields.flatMap((field) =>
        field.key === 'unit' || field.key === 'bodyStyle' ? [[field.key, field.value]] : []
      )
    expect(fields(doc)).toEqual([
      ['unit', '2'],
      ['bodyStyle', '1']
    ])
    const bare = parseKicadSchematic(
      `(kicad_sch (version 20250114) (generator "test") (uuid "root") (lib_symbols) ${placed('U1', 1)})`
    )
    expect(fields(bare)).toEqual([])
  })
})

describe('findUnitHolder', () => {
  test('finds the other placement showing the unit, never the one asking', () => {
    const doc = sheet(placed('U1', 1), placed('U1', 2), placed('U2', 2))
    const sources: UnitSource[] = [{ filePath: '/p/a.kicad_sch', sheetPath: ROOT, schematic: doc }]
    const self = { filePath: '/p/a.kicad_sch', sheetPath: ROOT, symbolIndex: 0 }
    expect(findUnitHolder(sources, 'U1', 2, self)).toEqual({ ...self, symbolIndex: 1 })
    expect(findUnitHolder(sources, 'U1', 1, self)).toBeNull()
    expect(findUnitHolder(sources, 'U3', 2, self)).toBeNull()
  })
})

describe('writing a unit and a body style', () => {
  test('a unit change sets the placement, its instance and the new pins, and nothing else', () => {
    const doc = sheet(placed('U1', 1))
    const symbol = doc.symbols[0]
    const before = serializeKicadSchematic(doc)
    setSchematicSymbolUnit(symbol, 2, ROOT, libSymbolUnitPins(placedSymbolChain(doc, symbol), 2))
    const after = parseKicadSchematic(serializeKicadSchematic(doc)).symbols[0]
    expect(after.unit).toBe(2)
    expect(after.instances[0].unit).toBe(2)
    const text = serializeKicadSchematic(doc)
    expect(text).toContain('(pin "1"\n\t\t\t(uuid "pin-1")')
    expect(text).toMatch(/\(pin "3"\s+\(uuid "[0-9a-f-]+"\)/)
    // Back to unit 1: only the new pin entry is left over from the round trip.
    setSchematicSymbolUnit(symbol, 1, ROOT, [])
    expect(serializeKicadSchematic(doc).replace(/\s*\(pin "3"\s+\(uuid "[^"]+"\)\s*\)/, '')).toBe(
      before
    )
  })

  test('a body style is written after the unit, or where an old convert stands', () => {
    const doc = sheet(placed('U1', 1), placed('U2', 1, ' (convert 1)'))
    setSchematicSymbolBodyStyle(doc.symbols[0], 2, [])
    setSchematicSymbolBodyStyle(doc.symbols[1], 2, [])
    const text = serializeKicadSchematic(doc)
    expect(text).toMatch(/\(unit 1\)\s+\(body_style 2\)/)
    expect(text).toContain('(convert 2)')
    const reread = parseKicadSchematic(text)
    expect(reread.symbols.map((symbol) => symbol.bodyStyle)).toEqual([2, 2])
  })
})
