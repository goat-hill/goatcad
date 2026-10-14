import { describe, expect, test } from 'vitest'
import { parseKicadSymbolLibrary } from '../../kicad/symbolLibrary'
import { diffSymbolLibraries, symbolDiffUnitCount, symbolDiffView } from '../symbolLibraryDiff'

const pin = (number: string, y: number): string =>
  `(pin passive line (at 0 ${y} 270) (length 1.27)
        (name "~" (effects (font (size 1.27 1.27))))
        (number "${number}" (effects (font (size 1.27 1.27)))))`

const resistor = (name: string, value: string, pins: string): string => `(symbol "${name}"
    (property "Reference" "R" (at 2.032 0 90) (effects (font (size 1.27 1.27))))
    (property "Value" "${value}" (at 0 0 90) (effects (font (size 1.27 1.27))))
    (symbol "${name}_0_1"
      (rectangle (start -1.016 -2.54) (end 1.016 2.54)
        (stroke (width 0.254) (type default)) (fill (type none)))
    )
    (symbol "${name}_1_1"
      ${pins}
    )
  )`

const lib = (...symbols: string[]): ReturnType<typeof parseKicadSymbolLibrary> =>
  parseKicadSymbolLibrary(`(kicad_symbol_lib
  (version 20231120)
  (generator "kicad_symbol_editor")
  ${symbols.join('\n  ')}
)`)

const TWO_PINS = `${pin('1', 3.81)} ${pin('2', -3.81)}`

describe('diffSymbolLibraries', () => {
  test('pairs symbols by name', () => {
    const before = lib(resistor('R', 'R', TWO_PINS), resistor('Old', 'Old', TWO_PINS))
    const after = lib(resistor('R', 'R', pin('1', 3.81)), resistor('New', 'New', TWO_PINS))
    expect(diffSymbolLibraries(before, after)).toEqual([
      { name: 'New', kind: 'added' },
      { name: 'Old', kind: 'removed' },
      { name: 'R', kind: 'modified' }
    ])
  })

  test('an identical library has no changes and no sheet', () => {
    const one = lib(resistor('R', 'R', TWO_PINS))
    expect(diffSymbolLibraries(one, one)).toEqual([])
    expect(symbolDiffView(one, one, 'R', 'diff')).toBeNull()
  })
})

describe('symbolDiffView', () => {
  test('a moved pin: the old place drawn back in red, the new place in color', () => {
    const before = lib(resistor('R', 'R', TWO_PINS))
    const after = lib(resistor('R', 'R', `${pin('1', 3.81)} ${pin('2', -5.08)}`))
    const view = symbolDiffView(before, after, 'R', 'diff')
    // Pin 2 at its new place is the unit's second pin; the old one is appended third.
    expect([...(view?.paint.changed ?? [])]).toEqual(['symbol:0/pin:0.1.1.1'])
    expect([...(view?.paint.removed ?? [])]).toEqual(['symbol:0/pin:0.1.1.2'])
    expect(view?.doc.libSymbols.get('R')?.variants.find((v) => v.unit === 1)?.pins).toHaveLength(3)
  })

  test('After is the new symbol alone: the moved pin in color, nothing red', () => {
    const before = lib(resistor('R', 'R', TWO_PINS))
    const after = lib(resistor('R', 'R', `${pin('1', 3.81)} ${pin('2', -5.08)}`))
    const view = symbolDiffView(before, after, 'R', 'after')
    expect([...(view?.paint.changed ?? [])]).toEqual(['symbol:0/pin:0.1.1.1'])
    expect(view?.paint.removed.size).toBe(0)
    expect(view?.doc.libSymbols.get('R')?.variants.find((v) => v.unit === 1)?.pins).toHaveLength(2)
  })

  test('Before is the old symbol alone: its departed parts in color, nothing red', () => {
    const before = lib(resistor('R', 'R', TWO_PINS))
    const after = lib(resistor('R', 'R', pin('1', 3.81)))
    const view = symbolDiffView(before, after, 'R', 'before')
    expect([...(view?.paint.changed ?? [])]).toEqual(['symbol:0/pin:0.1.1.1'])
    expect(view?.paint.removed.size).toBe(0)
  })

  test('a field edit colors that field only', () => {
    const view = symbolDiffView(
      lib(resistor('R', 'R', TWO_PINS)),
      lib(resistor('R', '10k', TWO_PINS)),
      'R',
      'diff'
    )
    expect([...(view?.paint.changed ?? [])]).toEqual(['symbol:0/field:Value'])
    expect(view?.paint.removed.size).toBe(0)
  })

  test('a moved field is a change to that field, value untouched', () => {
    const moved = resistor('R', 'R', TWO_PINS).replace(
      '(property "Value" "R" (at 0 0 90)',
      '(property "Value" "R" (at 2.54 0 90)'
    )
    const view = symbolDiffView(lib(resistor('R', 'R', TWO_PINS)), lib(moved), 'R', 'diff')
    expect([...(view?.paint.changed ?? [])]).toEqual(['symbol:0/field:Value'])
  })

  test('a change no part shows paints the whole symbol rather than none of it', () => {
    const offset = resistor('R', 'R', TWO_PINS).replace(
      '(symbol "R"\n',
      '(symbol "R"\n    (pin_names (offset 0.508))\n'
    )
    const view = symbolDiffView(lib(resistor('R', 'R', TWO_PINS)), lib(offset), 'R', 'diff')
    expect([...(view?.paint.changed ?? [])]).toEqual(['symbol:0'])
  })

  test('an added symbol is in color; it has no Before', () => {
    const before = lib()
    const after = lib(resistor('New', 'New', TWO_PINS))
    expect([...(symbolDiffView(before, after, 'New', 'diff')?.paint.changed ?? [])]).toEqual([
      'symbol:0'
    ])
    expect(symbolDiffView(before, after, 'New', 'before')).toBeNull()
  })

  test('a removed symbol is red in Diff, in color in Before, and absent After', () => {
    const before = lib(resistor('Old', 'Old', TWO_PINS))
    const after = lib()
    expect([...(symbolDiffView(before, after, 'Old', 'diff')?.paint.removed ?? [])]).toEqual([
      'symbol:0'
    ])
    expect([...(symbolDiffView(before, after, 'Old', 'before')?.paint.changed ?? [])]).toEqual([
      'symbol:0'
    ])
    expect(symbolDiffView(before, after, 'Old', 'after')).toBeNull()
  })

  test('units count across both versions, and the chosen unit is the one placed', () => {
    const twoUnits = (name: string): string => `(symbol "${name}"
    (property "Reference" "U" (at 0 0 0) (effects (font (size 1.27 1.27))))
    (symbol "${name}_1_1" ${pin('1', 3.81)})
    (symbol "${name}_2_1" ${pin('2', 3.81)})
  )`
    const before = lib(twoUnits('U'))
    const after = lib(resistor('U', 'U', TWO_PINS))
    expect(symbolDiffUnitCount(before, after, 'U')).toBe(2)
    expect(symbolDiffView(before, after, 'U', 'before', 2)?.doc.symbols[0].unit).toBe(2)
  })
})
