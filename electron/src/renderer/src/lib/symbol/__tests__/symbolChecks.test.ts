import { describe, expect, test } from 'vitest'
import { mmToNm, spacingToMm } from '../../kicad/coordinates'
import { parseKicadSymbolLibrary } from '../../kicad/symbolLibrary'
import { symbolPartNode } from '../symbolEdit'
import {
  expandStackedPinNumber,
  SYMBOL_CHECK_RULES,
  symbolChecks,
  symbolTarget,
  symbolTargetAddress
} from '../symbolChecks'

const GRID = mmToNm(spacingToMm(50, 'mil'))

const pin = (
  number: string,
  x: number,
  y: number,
  { type = 'passive', name = '~', hidden = false } = {}
): string =>
  `(pin ${type} line (at ${x} ${y} 0) (length 2.54)${hidden ? ' (hide yes)' : ''}
    (name "${name}" (effects (font (size 1.27 1.27))))
    (number "${number}" (effects (font (size 1.27 1.27)))))`

const symbol = (
  name: string,
  units: Record<string, string>,
  { reference = 'U', head = '' } = {}
): string =>
  `(symbol "${name}" ${head}
    (property "Reference" "${reference}" (at 0 0 0) (effects (font (size 1.27 1.27))))
    (property "Value" "${name}" (at 0 0 0) (effects (font (size 1.27 1.27))))
    ${Object.entries(units)
      .map(([suffix, body]) => `(symbol "${name}_${suffix}" ${body})`)
      .join('\n')})`

const library = (...symbols: string[]): ReturnType<typeof parseKicadSymbolLibrary> =>
  parseKicadSymbolLibrary(
    `(kicad_symbol_lib (version 20231120) (generator "test") ${symbols.join('\n')})`
  )

const check = (source: string, grid = GRID): ReturnType<typeof symbolChecks> => {
  const lib = library(source)
  return symbolChecks(lib.symbols.get(lib.names[0])!, grid)
}

const codes = (results: ReturnType<typeof symbolChecks>): string[] => results.map((r) => r.code)

describe('symbolChecks', () => {
  test('a sound symbol has no findings', () => {
    expect(check(symbol('R', { '1_1': `${pin('1', 0, 3.81)} ${pin('2', 0, -3.81)}` }))).toEqual([])
  })

  test('a reference prefix that is empty or ends in a digit or "?" is a warning', () => {
    for (const reference of ['', 'U1', 'U?']) {
      const results = check(symbol('R', { '1_1': pin('1', 0, 0) }, { reference }))
      expect(results.map((r) => [r.code, r.severity])).toEqual([['reference-prefix', 'warning']])
    }
  })

  test('two pins with one number in one body style clash', () => {
    const results = check(symbol('U', { '1_1': `${pin('1', 0, 0)} ${pin('1', 0, 2.54)}` }))
    expect(results.map((r) => [r.code, r.severity, r.items])).toEqual([
      ['duplicate-pin', 'error', ['pin:1', 'pin:1']]
    ])
  })

  test('the same number in two units clashes; in two body styles it does not', () => {
    const units = check(symbol('U', { '1_1': pin('1', 0, 0), '2_1': pin('1', 0, 0) }))
    expect(codes(units)).toEqual(['duplicate-pin'])
    expect(units[0].subject).toBe('pin 1, unit A; pin 1, unit B')
    expect(check(symbol('U', { '1_1': pin('1', 0, 0), '1_2': pin('1', 0, 0) }))).toEqual([])
    // Style 0 is common to every style, so it clashes with each.
    expect(codes(check(symbol('U', { '0_0': pin('1', 0, 0), '1_2': pin('1', 0, 0) })))).toEqual([
      'duplicate-pin'
    ])
  })

  test('stacked numbers are expanded before comparing', () => {
    expect(expandStackedPinNumber('[1,3,5-7]')).toEqual(['1', '3', '5', '6', '7'])
    expect(expandStackedPinNumber('[A1-A3]')).toEqual(['A1', 'A2', 'A3'])
    expect(expandStackedPinNumber('3')).toBeNull()
    expect(expandStackedPinNumber('[3-1]')).toBeNull()
    const results = check(symbol('U', { '1_1': `${pin('[1-3]', 0, 0)} ${pin('2', 0, 2.54)}` }))
    expect(codes(results)).toEqual(['duplicate-pin'])
  })

  test('a pin off the grid is a warning, and the grid is never finer than 25 mil', () => {
    const off = symbol('U', { '1_1': pin('1', 0, 0.635) })
    expect(codes(check(off))).toEqual(['off-grid-pin'])
    expect(check(off, mmToNm(spacingToMm(25, 'mil')))).toEqual([])
    const fine = symbol('U', { '1_1': pin('1', 0, 0.254) })
    expect(codes(check(fine, mmToNm(spacingToMm(10, 'mil'))))).toEqual(['off-grid-pin'])
  })

  test('a hidden power input is a warning, except on a global power symbol', () => {
    const hidden = pin('1', 0, 0, { type: 'power_in', name: 'VCC', hidden: true })
    expect(codes(check(symbol('U', { '1_1': hidden })))).toEqual(['hidden-power-pin'])
    const global = check(symbol('VCC', { '0_1': hidden }, { reference: '#PWR', head: '(power)' }))
    expect(codes(global)).toEqual(['power-symbol-hidden-pin'])
    const local = check(
      symbol('VCC', { '0_1': hidden }, { reference: '#PWR', head: '(power local)' })
    )
    expect(codes(local)).toEqual(['hidden-power-pin', 'power-symbol-hidden-pin'])
  })

  test('a power symbol needs one unit and one power pin', () => {
    const head = { reference: '#PWR', head: '(power)' }
    const sound = pin('1', 0, 0, { type: 'power_in', name: 'VCC' })
    expect(check(symbol('VCC', { '0_1': sound }, head))).toEqual([])
    const passive = check(symbol('VCC', { '0_1': pin('1', 0, 0) }, head))
    expect(passive.map((r) => [r.code, r.severity])).toEqual([['power-symbol', 'error']])
    expect(passive[0].message).toContain('passive')
    const two = check(
      symbol('VCC', { '0_1': `${sound} ${pin('2', 0, 2.54, { type: 'power_in' })}` }, head)
    )
    expect(codes(two)).toEqual(['power-symbol'])
    const units = check(symbol('VCC', { '1_1': sound, '2_1': '' }, head))
    expect(units[0].message).toContain('2 units')
  })

  test('a circle with no radius or a rectangle with no size is an error', () => {
    const shapes = `(circle (center 0 0) (radius 0) (stroke (width 0)) (fill (type none)))
      (rectangle (start 1.27 1.27) (end 1.27 1.27) (stroke (width 0)) (fill (type none)))
      (rectangle (start 0 0) (end 2.54 2.54) (stroke (width 0)) (fill (type none)))`
    const results = check(symbol('U', { '0_1': shapes, '1_1': pin('1', 0, 0) }))
    expect(results.map((r) => [r.code, r.items])).toEqual([
      ['zero-size-graphic', ['circle@0,0']],
      ['zero-size-graphic', ['rectangle@1.27,1.27']]
    ])
  })

  test('a derived symbol is checked with its parent pins and its own reference', () => {
    const lib = library(
      symbol('Base', { '1_1': `${pin('1', 0, 0)} ${pin('1', 0, 2.54)}` }),
      `(symbol "Child" (extends "Base")
        (property "Reference" "Q?" (at 0 0 0) (effects (font (size 1.27 1.27)))))`
    )
    const results = symbolChecks(lib.symbols.get('Child')!, GRID, (name) => lib.symbols.get(name))
    expect(codes(results)).toEqual(['duplicate-pin', 'reference-prefix'])
    expect(results[0].message).toContain('inherited from Base')
    // Its parent's pins are not parts of the open symbol, so nothing selects them.
    expect(results[0].targets).toEqual([])
  })

  test('every finding selects what it reports', () => {
    const shapes = '(circle (center 0 0) (radius 0) (stroke (width 0)) (fill (type none)))'
    const lib = library(
      symbol(
        'U',
        {
          '0_1': shapes,
          '1_1': `${pin('1', 0, 0)} ${pin('1', 0, 0.635)} ${pin('2', 0, 5.08, { type: 'power_in', name: 'VCC', hidden: true })}`
        },
        { reference: 'U?' }
      ),
      symbol(
        'PWR',
        { '0_1': pin('1', 0, 0, { type: 'passive', hidden: true }) },
        { reference: '#PWR', head: '(power)' }
      ),
      symbol(
        'GND',
        { '0_1': pin('1', 0, 0, { type: 'power_in', name: 'GND', hidden: true }) },
        { reference: '#PWR', head: '(power)' }
      )
    )
    const found = new Set<string>()
    for (const name of lib.names) {
      const definition = lib.symbols.get(name)!
      for (const result of symbolChecks(definition, GRID)) {
        found.add(result.code)
        expect(result.targets?.length, result.code).toBeGreaterThan(0)
        for (const target of result.targets ?? []) {
          const address = symbolTargetAddress(target)
          expect(address, target).not.toBeNull()
          expect(symbolTarget(address!)).toBe(target)
          expect(symbolPartNode(definition._node, address!), target).not.toBeNull()
        }
      }
    }
    expect([...found].sort()).toEqual(Object.keys(SYMBOL_CHECK_RULES).sort())
  })
})
