import { describe, expect, it } from 'vitest'
import { librarySymbolCopy } from '../symbolCopy'
import {
  namespaceSymbolLibrary,
  parseKicadSymbolLibrary,
  type KicadSymbolLibrary
} from '../../kicad/symbolLibrary'
import { serializeSExpr } from '../../kicad/sexpr'
import { getLibSymbolProperty, type KicadLibSymbol } from '../../kicad/schematic'

const unit = (name: string): string =>
  `(symbol "${name}_1_1" (pin passive line (at 0 0 0) (length 2.54) (name "~") (number "1")))`

/** A standard library as KiCad ships it: a base symbol and one derived from it. */
const CONNECTOR_LIB = `(kicad_symbol_lib (version 20241209) (generator "kicad_symbol_editor")
  (symbol "6P2C" (property "Reference" "J") (property "Value" "6P2C") (property "Datasheet" "base.pdf") ${unit('6P2C')})
  (symbol "RJ11" (extends "6P2C") (property "Reference" "J") (property "Value" "RJ11"))
)`

/** The copy as a one-symbol project library reads it back. */
const reread = (node: ReturnType<typeof librarySymbolCopy>): KicadSymbolLibrary =>
  parseKicadSymbolLibrary(`(kicad_symbol_lib (version 20241209) ${serializeSExpr(node)})`)

describe('librarySymbolCopy', () => {
  const library = namespaceSymbolLibrary(CONNECTOR_LIB, 'Connector')
  const lookup = (name: string): KicadLibSymbol | undefined => library.symbols.get(name)

  it('flattens the extends parent into a bare-named copy', () => {
    const copy = reread(librarySymbolCopy(library.symbols.get('Connector:RJ11')!, lookup, 'RJ11'))
    expect(copy.names).toEqual(['RJ11'])
    const symbol = copy.symbols.get('RJ11')!
    expect(symbol.extends).toBeFalsy()
    expect(getLibSymbolProperty(symbol, 'Value')).toBe('RJ11')
    // The parent's field and pin come with it.
    expect(getLibSymbolProperty(symbol, 'Datasheet')).toBe('base.pdf')
    expect(serializeSExpr(symbol._node)).toContain('"RJ11_1_1"')
  })

  it('renames the copy and its units, and a Value that held the old name', () => {
    const copy = reread(librarySymbolCopy(library.symbols.get('Connector:6P2C')!, lookup, 'Jack'))
    expect(copy.names).toEqual(['Jack'])
    const text = serializeSExpr(copy.symbols.get('Jack')!._node)
    expect(text).toContain('"Jack_1_1"')
    expect(text).not.toContain('6P2C_1_1')
    expect(getLibSymbolProperty(copy.symbols.get('Jack')!, 'Value')).toBe('Jack')
  })
})
