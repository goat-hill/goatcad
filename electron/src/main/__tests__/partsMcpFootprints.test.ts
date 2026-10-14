import { describe, it, expect } from 'vitest'
import {
  listFootprintLibraries,
  listFootprintLibrary,
  matchesFootprint,
  searchFootprints
} from '../partsMcpFootprints'
import type { FootprintRecord, IndexRecord } from '../libraryIndexTypes'

const fp = (overrides: Partial<FootprintRecord> & { id: string }): FootprintRecord => ({
  type: 'footprint',
  name: overrides.id.split(':')[1] ?? overrides.id,
  library: overrides.id.split(':')[0] ?? '',
  scope: 'system',
  file: '/x.pretty/x.kicad_mod',
  description: '',
  tags: '',
  pads: 2,
  padNumbers: 2,
  models: [],
  ...overrides
})

const RECORDS: IndexRecord[] = [
  fp({ id: 'Resistor_SMD:R_0402_1005Metric', description: 'Resistor SMD 0402', tags: 'resistor' }),
  fp({ id: 'Resistor_SMD:R_0603_1608Metric', description: 'Resistor SMD 0603', models: ['a.wrl'] }),
  fp({ id: 'Package_QFP:LQFP-64_10x10mm_P0.5mm', description: 'LQFP, 64 Pin', pads: 64 }),
  fp({ id: 'House:REG_PAD', description: 'house regulator pad', scope: 'project' }),
  // A symbol must never leak into a footprint answer.
  {
    type: 'symbol',
    id: 'Device:R',
    name: 'R',
    library: 'Device',
    scope: 'system',
    file: '/x.kicad_sym',
    isPower: false,
    value: '',
    description: 'Resistor',
    keywords: 'resistor',
    datasheet: '',
    footprint: '',
    fpFilters: [],
    pins: 2
  }
]

describe('listFootprintLibraries', () => {
  it('counts footprints per nickname, project first, and never a symbol', () => {
    const answer = listFootprintLibraries(RECORDS)
    expect(answer.totalFootprints).toBe(4)
    expect(answer.libraries.map((entry) => [entry.library, entry.scope, entry.footprints])).toEqual(
      [
        ['House', 'project', 1],
        ['Package_QFP', 'system', 1],
        ['Resistor_SMD', 'system', 2]
      ]
    )
  })
})

describe('listFootprintLibrary', () => {
  it('lists one library alphabetically with pad counts, and says which carry a model', () => {
    const page = listFootprintLibrary(RECORDS, 'Resistor_SMD')
    expect(page.error).toBeUndefined()
    expect(page.footprints).toEqual([
      { libId: 'Resistor_SMD:R_0402_1005Metric', description: 'Resistor SMD 0402', pads: 2 },
      {
        libId: 'Resistor_SMD:R_0603_1608Metric',
        description: 'Resistor SMD 0603',
        pads: 2,
        models: 1
      }
    ])
    expect(page.nextOffset).toBeNull()
  })

  it('answers an unknown nickname with near-misses', () => {
    const page = listFootprintLibrary(RECORDS, 'Resistor')
    expect(page.error).toBe('unknown-library')
    expect(page.didYouMean).toEqual(['Resistor_SMD'])
  })
})

describe('searchFootprints', () => {
  it('matches every term across id, library, description and tags', () => {
    expect(searchFootprints(RECORDS, '0402 resistor').footprints.map((r) => r.libId)).toEqual([
      'Resistor_SMD:R_0402_1005Metric'
    ])
    expect(searchFootprints(RECORDS, 'lqfp 64').total).toBe(1)
    expect(matchesFootprint('smd 0603', fp({ id: 'Resistor_SMD:R_0603_1608Metric' }))).toBe(true)
  })

  it('says so when nothing matches, and when the list was cut', () => {
    expect(searchFootprints(RECORDS, 'bga').guidance).toContain('No footprint matches')
    const cut = searchFootprints(RECORDS, 'r', { limit: 1 })
    expect(cut.truncated).toBe(true)
    expect(cut.footprints).toHaveLength(1)
  })
})
