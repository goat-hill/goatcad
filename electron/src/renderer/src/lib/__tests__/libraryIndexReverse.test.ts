import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  normalizeModelKey,
  buildReverseMaps,
  unionRecords,
  footprintsMatchingFilters,
  symbolsMatchingFootprint,
  loadProjectIndex,
  clearProjectIndex
} from '../libraryIndex'
import type { SymbolRecord, FootprintRecord, ModelRecord } from '../libraryIndex'

const sym = (id: string, footprint: string): SymbolRecord => ({
  type: 'symbol',
  id,
  name: id.split(':')[1],
  library: id.split(':')[0],
  scope: 'system',
  file: `/s/${id}.kicad_sym`,
  isPower: false,
  value: '',
  description: '',
  keywords: '',
  datasheet: '',
  footprint,
  fpFilters: [],
  pins: 2
})

const fp = (id: string, models: string[]): FootprintRecord => ({
  type: 'footprint',
  id,
  name: id.split(':')[1],
  library: id.split(':')[0],
  scope: 'system',
  file: `/f/${id}.kicad_mod`,
  description: '',
  tags: '',
  pads: 2,
  padNumbers: 2,
  models
})

const model = (file: string): ModelRecord => ({
  type: 'model',
  id: file,
  name: file.split('/').pop() ?? file,
  library: '3dshapes',
  scope: 'system',
  file
})

describe('normalizeModelKey', () => {
  it('matches env-var and absolute paths, ignoring extension/case', () => {
    const envRef = '${KICAD10_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0402_1005Metric.wrl'
    const abs = '/usr/share/kicad/3dmodels/Resistor_SMD.3dshapes/R_0402_1005Metric.step'
    expect(normalizeModelKey(envRef)).toBe(normalizeModelKey(abs))
    expect(normalizeModelKey(abs)).toBe('resistor_smd.3dshapes/r_0402_1005metric')
  })
})

describe('buildReverseMaps', () => {
  const records = [
    sym('Device:R', 'Resistor_SMD:R_0402_1005Metric'),
    sym('Device:R_Small', 'Resistor_SMD:R_0402_1005Metric'),
    sym('Device:C', ''),
    fp('Resistor_SMD:R_0402_1005Metric', [
      '${KICAD10_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0402_1005Metric.wrl'
    ])
  ]
  const { modelUsedBy, footprintUsedBy } = buildReverseMaps(records)

  it('maps a footprint lib_id to the symbols assigning it (blank Footprint ignored)', () => {
    expect(footprintUsedBy.get('Resistor_SMD:R_0402_1005Metric')?.map((s) => s.id)).toEqual([
      'Device:R',
      'Device:R_Small'
    ])
    expect(footprintUsedBy.has('')).toBe(false)
  })

  it('maps a normalized model key to the footprints referencing it', () => {
    const key = normalizeModelKey(
      '/usr/share/kicad/3dmodels/Resistor_SMD.3dshapes/R_0402_1005Metric.step'
    )
    expect(modelUsedBy.get(key)?.map((f) => f.id)).toEqual(['Resistor_SMD:R_0402_1005Metric'])
  })

  it('folds placed-component assignments into footprintUsedBy, keyed to the symbol', () => {
    const projSym = { ...sym('Device:R', ''), scope: 'project' as const }
    const { footprintUsedBy } = buildReverseMaps(
      [projSym],
      [{ symbol: 'Device:R', footprint: 'Resistor_SMD:R_0402_1005Metric' }]
    )
    expect(footprintUsedBy.get('Resistor_SMD:R_0402_1005Metric')?.map((s) => s.id)).toEqual([
      'Device:R'
    ])
    // An assignment whose symbol isn't indexed is dropped, not crashed on.
    const { footprintUsedBy: empty } = buildReverseMaps(
      [],
      [{ symbol: 'Ghost:Z', footprint: 'Lib:FP' }]
    )
    expect(empty.has('Lib:FP')).toBe(false)
  })
})

describe('buildReverseMaps footprintModels', () => {
  it('resolves refs to indexed model records and omits footprints with none', () => {
    const records = [
      // First ref points at an unindexed package; the second resolves — the map
      // must surface the live one, not stop at models[0].
      fp('Lib:Multi', [
        '${KICAD10_3DMODEL_DIR}/Dead.3dshapes/Gone.wrl',
        '${KICAD10_3DMODEL_DIR}/Cap_SMD.3dshapes/C_0402.step'
      ]),
      // Only ref is unindexed → absent from the map entirely.
      fp('Lib:Orphan', ['${KICAD10_3DMODEL_DIR}/Dead.3dshapes/Gone.wrl']),
      model('/usr/share/kicad/3dmodels/Cap_SMD.3dshapes/C_0402.wrl')
    ]
    const { footprintModels } = buildReverseMaps(records)
    expect(footprintModels.get('Lib:Multi')?.map((m) => m.id)).toEqual([
      '/usr/share/kicad/3dmodels/Cap_SMD.3dshapes/C_0402.wrl'
    ])
    expect(footprintModels.has('Lib:Orphan')).toBe(false)
  })

  it('dedupes when several refs normalize to the same model', () => {
    const records = [
      fp('Lib:Dup', [
        '${KICAD10_3DMODEL_DIR}/Cap_SMD.3dshapes/C_0402.wrl',
        '/abs/Cap_SMD.3dshapes/C_0402.step'
      ]),
      model('/usr/share/kicad/3dmodels/Cap_SMD.3dshapes/C_0402.wrl')
    ]
    const { footprintModels } = buildReverseMaps(records)
    expect(footprintModels.get('Lib:Dup')).toHaveLength(1)
  })
})

describe('buildReverseMaps availability edges', () => {
  it('marks a model as reaching a symbol only through a footprint that has one', () => {
    const records = [
      sym('Device:R', 'Lib:FP_A'), // assigns FP_A as its default footprint
      fp('Lib:FP_A', ['${KICAD10_3DMODEL_DIR}/Pkg.3dshapes/A.wrl']),
      fp('Lib:FP_B', ['${KICAD10_3DMODEL_DIR}/Pkg.3dshapes/B.wrl']), // no symbol assigns it
      model('/usr/share/kicad/3dmodels/Pkg.3dshapes/A.wrl'),
      model('/usr/share/kicad/3dmodels/Pkg.3dshapes/B.wrl')
    ]
    const { modelsWithSymbol, symbolById, footprintById } = buildReverseMaps(records)
    expect(modelsWithSymbol.has(normalizeModelKey('x/Pkg.3dshapes/A.wrl'))).toBe(true)
    expect(modelsWithSymbol.has(normalizeModelKey('x/Pkg.3dshapes/B.wrl'))).toBe(false)
    // id-maps cover every record of their type (blank-footprint symbols included).
    expect(symbolById.has('Device:R')).toBe(true)
    expect(footprintById.get('Lib:FP_A')?.id).toBe('Lib:FP_A')
  })
})

describe('footprint ⇄ symbol filter matching', () => {
  // Seed the module's query set through the project-index path (the only public
  // seeder); a stubbed `window.api` returns these as project-scope records.
  const withFilters = (id: string, footprint: string, fpFilters: string[]): SymbolRecord => ({
    ...sym(id, footprint),
    scope: 'project',
    fpFilters
  })
  const records: (SymbolRecord | FootprintRecord)[] = [
    // Device:D takes any diode footprint (`D_*`) or a three-char TO package.
    withFilters('Device:D', '', ['TO-???*', '*_Diode_*', 'D_*']),
    withFilters('Device:C', '', ['C_*']),
    withFilters('Device:R', 'Resistor_SMD:R_0402_1005Metric', ['R_*']),
    { ...fp('Diode_SMD:D_0402_1005Metric', []), scope: 'project' },
    { ...fp('Capacitor_SMD:C_0402_1005Metric', []), scope: 'project' },
    { ...fp('Package_TO_SOT_THT:TO-220', []), scope: 'project' }
  ]

  beforeAll(async () => {
    ;(globalThis as unknown as { window: unknown }).window = {
      api: { getProjectIndex: async () => ({ records, assignments: [] }) }
    }
    await loadProjectIndex('/seed')
  })
  afterAll(() => {
    clearProjectIndex()
    delete (globalThis as unknown as { window?: unknown }).window
  })

  const footprint = (id: string): FootprintRecord =>
    records.find((r) => r.id === id) as FootprintRecord

  it('lists symbols compatible with a generic footprint via ki_fp_filters', () => {
    // No symbol *assigns* D_0402 as its default, but Device:D's `D_*` filter matches.
    expect(
      symbolsMatchingFootprint(footprint('Diode_SMD:D_0402_1005Metric')).map((s) => s.id)
    ).toEqual(['Device:D'])
    expect(
      symbolsMatchingFootprint(footprint('Capacitor_SMD:C_0402_1005Metric')).map((s) => s.id)
    ).toEqual(['Device:C'])
  })

  it('matches ? and * wildcards (TO-??? against TO-220)', () => {
    expect(
      symbolsMatchingFootprint(footprint('Package_TO_SOT_THT:TO-220')).map((s) => s.id)
    ).toEqual(['Device:D'])
  })

  it('is the forward direction too: a symbol’s filters select footprints', () => {
    expect(footprintsMatchingFilters(['C_*']).map((f) => f.id)).toEqual([
      'Capacitor_SMD:C_0402_1005Metric'
    ])
    expect(footprintsMatchingFilters([]).length).toBe(0)
  })
})

describe('unionRecords', () => {
  it('shadows a system record with the project copy of the same lib_id', () => {
    const sys = [sym('Device:R', 'Sys:FP'), sym('Device:C', '')]
    const proj = [{ ...sym('Device:R', 'Proj:FP'), scope: 'project' as const }]
    const union = unionRecords(sys, proj)
    expect(union.map((r) => r.id).sort()).toEqual(['Device:C', 'Device:R'])
    const r = union.find((x) => x.id === 'Device:R') as SymbolRecord
    expect(r.scope).toBe('project')
    expect(r.footprint).toBe('Proj:FP')
  })

  it('dedupes duplicate project records (table + embedded)', () => {
    const dup = { ...sym('Device:R', ''), scope: 'project' as const }
    expect(unionRecords([], [dup, dup])).toHaveLength(1)
  })
})
