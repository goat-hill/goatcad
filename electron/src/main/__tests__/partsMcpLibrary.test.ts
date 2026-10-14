import { describe, it, expect } from 'vitest'
import {
  listSymbolLibraries,
  listSymbolLibrary,
  matchesSymbol,
  searchSymbols
} from '../partsMcpLibrary'
import type { IndexRecord, SymbolRecord } from '../libraryIndexTypes'

const sym = (overrides: Partial<SymbolRecord> & { id: string }): SymbolRecord => ({
  type: 'symbol',
  name: overrides.id.split(':')[1] ?? overrides.id,
  library: overrides.id.split(':')[0] ?? '',
  scope: 'system',
  file: '/x.kicad_sym',
  isPower: false,
  value: '',
  description: '',
  keywords: '',
  datasheet: '',
  footprint: '',
  fpFilters: [],
  pins: 2,
  ...overrides
})

const RECORDS: IndexRecord[] = [
  sym({ id: 'Device:R', description: 'Resistor', keywords: 'R res resistor' }),
  sym({ id: 'Device:R_Small', description: 'Resistor, small symbol' }),
  sym({ id: 'Device:C', description: 'Unpolarized capacitor' }),
  sym({ id: 'power:GND', description: 'Power symbol for ground', isPower: true, pins: 1 }),
  sym({
    id: 'MCU_ST_STM32F4:STM32F405RGTx',
    description: 'Arm Cortex-M4 MCU, LQFP64',
    keywords: 'stm32 arm',
    pins: 64
  }),
  // A project library shadows a same-named system one; and a footprint record
  // must never leak into a symbol answer.
  sym({ id: 'MyParts:REG1', description: 'House regulator', scope: 'project' }),
  {
    type: 'footprint',
    id: 'Resistor_SMD:R_0402',
    name: 'R_0402',
    library: 'Resistor_SMD',
    scope: 'system',
    file: '/x.pretty',
    description: 'not a symbol',
    tags: '',
    pads: 2,
    padNumbers: 2,
    models: []
  }
]

describe('listSymbolLibraries', () => {
  it('counts symbols per library and never counts a footprint as one', () => {
    const result = listSymbolLibraries(RECORDS)
    expect(result.totalSymbols).toBe(6)
    expect(result.libraries.map((entry) => [entry.library, entry.symbols])).toEqual([
      ['MyParts', 1],
      ['Device', 3],
      ['MCU_ST_STM32F4', 1],
      ['power', 1]
    ])
  })

  it("sorts the project's own libraries first", () => {
    // A part the design already carries must never be re-authored, so the
    // library holding it is the first thing an agent should read.
    expect(listSymbolLibraries(RECORDS).libraries[0]).toMatchObject({
      library: 'MyParts',
      scope: 'project'
    })
  })
})

describe('listSymbolLibrary', () => {
  it('returns the library whole, with the description and pin count', () => {
    const page = listSymbolLibrary(RECORDS, 'Device')
    expect(page.total).toBe(3)
    expect(page.nextOffset).toBeNull()
    expect(page.symbols).toEqual([
      { libId: 'Device:C', description: 'Unpolarized capacitor', pins: 2 },
      { libId: 'Device:R', description: 'Resistor', pins: 2 },
      { libId: 'Device:R_Small', description: 'Resistor, small symbol', pins: 2 }
    ])
  })

  it('marks power ports rather than carrying a false column on every other row', () => {
    expect(listSymbolLibrary(RECORDS, 'power').symbols[0]).toEqual({
      libId: 'power:GND',
      description: 'Power symbol for ground',
      pins: 1,
      isPower: true
    })
    expect(listSymbolLibrary(RECORDS, 'Device').symbols[0]).not.toHaveProperty('isPower')
  })

  it('pages, and says how much is left rather than truncating silently', () => {
    const first = listSymbolLibrary(RECORDS, 'Device', { limit: 2 })
    expect(first.symbols).toHaveLength(2)
    expect(first.nextOffset).toBe(2)
    expect(first.guidance).toContain('offset=2')

    const second = listSymbolLibrary(RECORDS, 'Device', { offset: 2, limit: 2 })
    expect(second.symbols.map((row) => row.libId)).toEqual(['Device:R_Small'])
    expect(second.nextOffset).toBeNull()
  })

  it('matches a nickname case-insensitively', () => {
    expect(listSymbolLibrary(RECORDS, 'device').total).toBe(3)
  })

  it('answers an unknown nickname with near misses, not an empty list', () => {
    // The likely cause is a recalled name, so the fix is to show the real one —
    // an empty list reads as "this library has no symbols".
    const page = listSymbolLibrary(RECORDS, 'MCU_ST_STM32F7')
    expect(page.error).toBe('unknown-library')
    expect(page.didYouMean).toContain('MCU_ST_STM32F4')
    expect(page.symbols).toEqual([])
  })
})

describe('searchSymbols', () => {
  it('requires every term, across id, library, description and keywords', () => {
    expect(searchSymbols(RECORDS, 'stm32 lqfp64').symbols.map((row) => row.libId)).toEqual([
      'MCU_ST_STM32F4:STM32F405RGTx'
    ])
    expect(searchSymbols(RECORDS, 'stm32 lqfp48').symbols).toEqual([])
  })

  it('treats an underscore as a word break, as the chooser does', () => {
    expect(matchesSymbol('r small', RECORDS[1] as SymbolRecord)).toBe(true)
  })

  it('filters to (or away from) power ports', () => {
    expect(searchSymbols(RECORDS, 'ground', { power: true }).symbols.map((r) => r.libId)).toEqual([
      'power:GND'
    ])
    expect(searchSymbols(RECORDS, 'ground', { power: false }).symbols).toEqual([])
  })

  it('says the shown rows are not the best rows when it truncates', () => {
    // The match is unranked AND-of-substrings, so a cut list is arbitrary, not
    // a shortlist — and an agent that reads it as one recommends the wrong part.
    const result = searchSymbols(RECORDS, 'r', { limit: 1 })
    expect(result.truncated).toBe(true)
    expect(result.total).toBeGreaterThan(1)
    expect(result.guidance).toContain('unranked')
  })

  it('explains a miss as wording or absence rather than returning bare silence', () => {
    const result = searchSymbols(RECORDS, 'crystal 16mhz')
    expect(result.symbols).toEqual([])
    // The frequency is a Value set at placement, not a library fact: no query
    // finds it, and an agent must be told that rather than trying synonyms.
    expect(result.guidance).toContain('frequency')
  })
})
