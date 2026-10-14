import { describe, expect, test } from 'vitest'
import type { KicadLibSymbol, SymbolGraphic, SymbolPin } from '../../kicad/schematic'
import { symbolItemLabel } from '../symbolItemLabel'

const t = (key: string, params?: Record<string, unknown>): string =>
  params ? `${key}(${Object.values(params).join(',')})` : key

const pin = (number: string, name: string): SymbolPin => ({ number, name }) as SymbolPin

const symbolOf = (
  variants: Array<{ unit: number; pins?: SymbolPin[]; graphics?: SymbolGraphic[] }>
): KicadLibSymbol =>
  ({
    variants: variants.map((v) => ({ style: 1, pins: [], graphics: [], ...v })),
    properties: []
  }) as unknown as KicadLibSymbol

describe('symbolItemLabel', () => {
  test('a pin by number and name, with no unit on a one-unit symbol', () => {
    const symbol = symbolOf([{ unit: 1, pins: [pin('3', 'VCC')] }])
    expect(symbolItemLabel(symbol, { kind: 'pin', unit: 1, style: 1, index: 0 }, t)).toBe(
      'shared.primitives.pin · 3 · VCC'
    )
  })

  test('an unnamed pin drops the name, and a multi-unit symbol names the unit', () => {
    const symbol = symbolOf([{ unit: 1 }, { unit: 2, pins: [pin('5', '~')] }])
    expect(symbolItemLabel(symbol, { kind: 'pin', unit: 2, style: 1, index: 0 }, t)).toBe(
      'shared.primitives.pin · 5 · symbolEditor.units.option(B)'
    )
  })

  test('a field by its name', () => {
    const symbol = symbolOf([{ unit: 1 }])
    expect(
      symbolItemLabel(symbol, { kind: 'field', unit: 0, style: 0, index: 0, field: 'Value' }, t)
    ).toBe('shared.primitives.field · Value')
  })

  test('a text by its first line, cut short; a bezier is a curve', () => {
    const long = 'A very long first line of text here\nsecond'
    const symbol = symbolOf([
      {
        unit: 1,
        graphics: [
          { type: 'text', text: long } as SymbolGraphic,
          { type: 'bezier' } as SymbolGraphic
        ]
      }
    ])
    expect(symbolItemLabel(symbol, { kind: 'graphic', unit: 1, style: 1, index: 0 }, t)).toBe(
      'shared.primitives.text · A very long first line…'
    )
    expect(symbolItemLabel(symbol, { kind: 'graphic', unit: 1, style: 1, index: 1 }, t)).toBe(
      'shared.primitives.curve'
    )
  })
})
