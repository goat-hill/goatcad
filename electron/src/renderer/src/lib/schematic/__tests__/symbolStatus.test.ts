/**
 * The properties panel's library status for a symbol (`libSymbolMatches`):
 * stricter than the ERC mismatch rule, so an edited copy never reads as matching.
 */
import { describe, expect, test } from 'vitest'
import { parseKicadSymbolLibrary } from '../../kicad/symbolLibrary'
import type { KicadLibSymbol } from '../../kicad/schematic'
import { compareLibSymbols, libSymbolMatches } from '../checks'

const LIB = (
  pinName: string,
  valueAt: string,
  hidePinNames = false
): string => `(kicad_symbol_lib (version 20241209) (generator "test")
  (symbol "Device:R" ${hidePinNames ? '(pin_names (hide yes))' : ''}
    (property "Reference" "R" (at 2 0 90) (effects (font (size 1.27 1.27))))
    (property "Value" "R" (at ${valueAt} 90) (effects (font (size 1.27 1.27))))
    (symbol "R_1_1"
      (pin passive line (at 0 3.81 270) (length 1.27) (name "${pinName}" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))
      (pin passive line (at 0 -3.81 90) (length 1.27) (name "~" (effects (font (size 1.27 1.27)))) (number "2" (effects (font (size 1.27 1.27))))))))`

const definition = (text: string): KicadLibSymbol =>
  parseKicadSymbolLibrary(text).symbols.get('Device:R')!

describe('library status of a symbol copy', () => {
  test('an untouched copy matches', () => {
    expect(libSymbolMatches(definition(LIB('~', '0 0')), definition(LIB('~', '0 0')))).toBe(true)
  })

  test('a renamed pin, a moved field and hidden pin names do not, though ERC lets them pass', () => {
    const library = definition(LIB('~', '0 0'))
    const renamed = definition(LIB('A', '0 0'))
    expect(compareLibSymbols(renamed, library)).toBeNull()
    expect(libSymbolMatches(renamed, library)).toBe(false)
    expect(libSymbolMatches(definition(LIB('~', '1 0')), library)).toBe(false)
    expect(libSymbolMatches(definition(LIB('~', '0 0', true)), library)).toBe(false)
  })
})
