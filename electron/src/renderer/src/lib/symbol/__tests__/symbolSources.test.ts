import { describe, expect, it } from 'vitest'
import { createSymbolSources, type SymbolSourceIo } from '../symbolSources'

const unit = (name: string): string =>
  `(symbol "${name}_1_1" (pin passive line (at 0 0 0) (length 2.54) (name "~") (number "1")))`

/** A standard library as KiCad ships it: a base symbol and one derived from it. */
const CONNECTOR_LIB = `(kicad_symbol_lib (version 20241209) (generator "kicad_symbol_editor")
  (symbol "6P2C" (property "Reference" "J") (property "Value" "6P2C") ${unit('6P2C')})
  (symbol "6P4C" (property "Reference" "J") (property "Value" "6P4C") ${unit('6P4C')})
  (symbol "RJ11" (extends "6P2C") (property "Reference" "J") (property "Value" "RJ11"))
)`

/** A sheet that has placed `Connector:RJ11`: KiCad embeds the flattened copy. */
const SHEET = `(kicad_sch (version 20231120) (generator "eeschema")
  (lib_symbols
    (symbol "Connector:RJ11" (property "Reference" "J") (property "Value" "RJ11") ${unit('RJ11')})
  )
)`

const io = (): SymbolSourceIo => ({
  globalLibraries: async () => [],
  projectTable: async () => ({ content: null, dir: null }),
  readLibrary: async (path) =>
    ({ '/kicad/Connector.kicad_sym': CONNECTOR_LIB, '/proj/sheet.kicad_sch': SHEET })[path] ?? null,
  // Two files under one nickname. The app's index no longer answers a sheet
  // here (findLibrarySymbol), but the loaded set must not assume one file per
  // nickname either way.
  standardLibraryOf: async (libId) =>
    libId === 'Connector:RJ11'
      ? { library: 'Connector', file: '/proj/sheet.kicad_sch' }
      : libId.startsWith('Connector:')
        ? { library: 'Connector', file: '/kicad/Connector.kicad_sym' }
        : undefined
})

const has = (sources: ReturnType<typeof createSymbolSources>, libId: string): boolean =>
  sources.standardSymbols.value.some((entry) => entry.libId === libId)

describe('createSymbolSources standard tier', () => {
  it('still loads a library after a sheet-embedded symbol of the same nickname', async () => {
    // A bare file name has no directory, so no project file is looked for.
    const sources = createSymbolSources('sheet.kicad_sch', io())
    await sources.ready()

    await sources.ensureStandardLibrary('Connector:RJ11')
    expect(has(sources, 'Connector:RJ11')).toBe(true)
    expect(has(sources, 'Connector:6P4C')).toBe(false)

    await sources.ensureStandardLibrary('Connector:6P4C')
    expect(has(sources, 'Connector:6P4C')).toBe(true)
    expect(has(sources, 'Connector:6P2C')).toBe(true)
  })

  it('parses a library file once however many of its symbols are asked for', async () => {
    const sources = createSymbolSources('sheet.kicad_sch', io())
    await sources.ready()
    await sources.ensureStandardLibrary('Connector:6P4C')
    await sources.ensureStandardLibrary('Connector:6P2C')
    const ids = sources.standardSymbols.value.map((entry) => entry.libId)
    expect(ids.filter((id) => id === 'Connector:6P4C')).toHaveLength(1)
  })
})
