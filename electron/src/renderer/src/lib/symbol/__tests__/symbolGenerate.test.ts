import { describe, expect, test } from 'vitest'
import {
  EMPTY_SYMBOL_LIBRARY,
  generateBlankSymbol,
  generateSymbol,
  parseOrCreateLibrary
} from '../symbolGenerate'
import { parseKicadSymbolLibrary } from '../../kicad/symbolLibrary'
import { serializeKicadSymbolLibrary } from '../../kicad/symbolLibrary'
import { planSymbol, type SymbolGroupSpec, type SymbolPinSpec } from '../symbolLayout'
import { libSymbolChain, libSymbolUnitPins, type SchematicProperty } from '../../kicad/schematic'

const GROUPS: SymbolGroupSpec[] = [
  { id: 'pwr', role: 'power' },
  { id: 'gnd', role: 'ground' },
  { id: 'i2c', role: 'signal' }
]
const PINS: SymbolPinSpec[] = [
  { number: '1', name: 'VDD', type: 'power_in', group: 'pwr' },
  { number: '2', name: 'GND', type: 'power_in', group: 'gnd' },
  { number: '3', name: 'GND', type: 'power_in', group: 'gnd', stackWith: '2' },
  { number: '4', name: 'SCL', type: 'input', group: 'i2c' },
  { number: '5', name: 'SDA', type: 'bidirectional', group: 'i2c' },
  { number: '6', name: 'DNC', type: 'no_connect', group: 'i2c', omit: true }
]

const build = (name = 'SGP41-D-R4'): string => {
  const plan = planSymbol(GROUPS, PINS)
  if (!plan.ok) throw new Error(plan.error)
  const library = parseOrCreateLibrary(null)
  generateSymbol(library, name, plan.layout, {
    reference: 'U',
    value: name,
    description: 'VOC and NOx sensor, I2C',
    keywords: 'voc gas sensor',
    datasheet: 'https://example.com/sgp41.pdf',
    extra: { MPN: name, Manufacturer: 'Sensirion AG' }
  })
  return serializeKicadSymbolLibrary(library)
}

describe('emitting a generated symbol', () => {
  test('round-trips through the parser it will be read back by', () => {
    const text = build()
    const reparsed = parseOrCreateLibrary(text)
    expect(reparsed.names).toEqual(['SGP41-D-R4'])
    const symbol = reparsed.symbols.get('SGP41-D-R4')!
    // Pins live in the unit sub-symbol, which is where KiCad puts them and how
    // every reader in this codebase gets at them.
    const pins = libSymbolUnitPins(
      libSymbolChain(symbol, (n) => reparsed.symbols.get(n)),
      1
    )
    // Five pads drawn, one omitted; the stacked pair is two pins at one point.
    expect(pins).toHaveLength(5)
    expect(pins.map((pin) => pin.number).sort()).toEqual(['1', '2', '3', '4', '5'])
  })

  test('writes the part fields, and leaves Footprint empty on purpose', () => {
    const symbol = parseOrCreateLibrary(build()).symbols.get('SGP41-D-R4')!
    const value = (key: string): string | undefined =>
      symbol.properties.find((property) => property.key === key)?.value
    expect(value('MPN')).toBe('SGP41-D-R4')
    expect(value('Manufacturer')).toBe('Sensirion AG')
    expect(value('Reference')).toBe('U')
    // Guessing a footprint from a package string is the mismatch sourcing §4.2
    // calls the highest-value warning in the feature. Empty is ERC-visible.
    expect(value('Footprint')).toBe('')
  })

  test('starts a library for a project that has none', () => {
    expect(parseOrCreateLibrary(null).names).toEqual([])
    expect(EMPTY_SYMBOL_LIBRARY).toContain('kicad_symbol_lib')
  })

  test('replaces a symbol of the same name rather than adding a second', () => {
    const plan = planSymbol(GROUPS, PINS)
    if (!plan.ok) throw new Error(plan.error)
    const library = parseOrCreateLibrary(build())
    const result = generateSymbol(library, 'SGP41-D-R4', plan.layout, {
      reference: 'U',
      value: 'v2'
    })
    expect(result.replaced).toBe(true)
    expect(parseOrCreateLibrary(serializeKicadSymbolLibrary(library)).names).toEqual(['SGP41-D-R4'])
  })

  test('the emitted pins carry the layout’s own coordinates', () => {
    const plan = planSymbol(GROUPS, PINS)
    if (!plan.ok) throw new Error(plan.error)
    const reparsed = parseOrCreateLibrary(build())
    const symbol = reparsed.symbols.get('SGP41-D-R4')!
    const pins = libSymbolUnitPins(
      libSymbolChain(symbol, (n) => reparsed.symbols.get(n)),
      1
    )
    for (const laid of plan.layout.pins) {
      const emitted = pins.find((pin) => pin.number === laid.number)!
      expect(emitted.position.x).toBe(laid.x)
      expect(emitted.position.y).toBe(laid.y)
    }
  })
})

describe('a blank symbol', () => {
  test('carries fields and no body; a power port hides its Reference', () => {
    const library = parseOrCreateLibrary(null)
    generateBlankSymbol(library, '+5V', { reference: '#PWR', value: '+5V' }, 'global')
    const symbol = parseKicadSymbolLibrary(serializeKicadSymbolLibrary(library)).symbols.get('+5V')!
    expect(symbol.isPower).toBe(true)
    expect(symbol.isLocalPower).toBe(false)
    expect(symbol.variants.flatMap((variant) => [...variant.pins, ...variant.graphics])).toEqual([])
    const field = (key: string): SchematicProperty | undefined =>
      symbol.properties.find((property) => property.key === key)
    expect(field('Reference')).toMatchObject({ value: '#PWR', hidden: true })
    expect(field('Value')).toMatchObject({ value: '+5V', hidden: false })
    expect(field('Value')!.position.y).toBeLessThan(0)
  })
})

describe('drafting details that were wrong the first time', () => {
  test('the body is filled with `background`, as an IC body is', () => {
    // Measured: 97% of single-body rectangles in 2-64 pin standard-library
    // symbols use `background`. The filled outline is what makes a symbol read
    // as a part rather than as a drawing; this shipped as `none` and looked it.
    expect(build()).toMatch(/\(rectangle[\s\S]*?\(fill\s*\(type background\)/)
  })

  test('a stacked pad is written hidden', () => {
    const text = build()
    // Pin 3 stacks on pin 2; only the duplicate carries the flag. The whole pin
    // node is checked, and the flag must sit where KiCad puts it — right after
    // (length …), ahead of the name and number.
    const pinBlock = (number: string): string => {
      const idx = text.indexOf(`(number "${number}"`)
      const start = text.lastIndexOf('(pin ', idx)
      return text.slice(
        start,
        text.indexOf('(pin ', idx) === -1 ? undefined : text.indexOf('(pin ', idx)
      )
    }
    expect(pinBlock('3')).toMatch(/\(length [\d.]+\)\s*\(hide yes\)/)
    expect(pinBlock('2')).not.toContain('(hide yes)')
  })
})
