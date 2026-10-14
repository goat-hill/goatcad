import { describe, it, expect } from 'vitest'
import {
  computeManifestDiff,
  diffIsEmpty,
  reparseUnitForKey,
  recordUnit,
  planPartialBuild,
  mergeIndex,
  type ManifestDiff
} from '../libraryIndexMerge'
import type { ScanResult } from '../libraryIndexScan'
import type { SymbolRecord, FootprintRecord, ModelRecord } from '../libraryIndexTypes'

const sym = (id: string, file: string): SymbolRecord => ({
  type: 'symbol',
  id,
  name: id.split(':')[1],
  library: id.split(':')[0],
  scope: 'system',
  file,
  isPower: false,
  value: '',
  description: '',
  keywords: '',
  datasheet: '',
  footprint: '',
  fpFilters: [],
  pins: 2
})
const fp = (id: string, file: string): FootprintRecord => ({
  type: 'footprint',
  id,
  name: id.split(':')[1],
  library: id.split(':')[0],
  scope: 'system',
  file,
  description: '',
  tags: '',
  pads: 2,
  padNumbers: 2,
  models: []
})
const model = (file: string): ModelRecord => ({
  type: 'model',
  id: file,
  name: file.split('/').pop() ?? file,
  library: 'pkg',
  scope: 'system',
  file
})

describe('computeManifestDiff', () => {
  it('splits into changed / removed / added', () => {
    const d = computeManifestDiff({ a: 1, b: 2, c: 3 }, { a: 1, b: 9, d: 4 })
    expect(d).toEqual({ changed: ['b'], removed: ['c'], added: ['d'] })
    expect(diffIsEmpty(d)).toBe(false)
    expect(diffIsEmpty(computeManifestDiff({ a: 1 }, { a: 1 }))).toBe(true)
  })
})

describe('reparseUnitForKey / recordUnit', () => {
  it('maps keys to their reparse unit; containers → null', () => {
    expect(reparseUnitForKey('/s/Device.kicad_sym')).toBe('/s/Device.kicad_sym')
    expect(reparseUnitForKey('/f/R.pretty/R.kicad_mod')).toBe('/f/R.pretty')
    expect(reparseUnitForKey('/f/R.pretty')).toBe('/f/R.pretty')
    expect(reparseUnitForKey('/f')).toBeNull() // parent container
    expect(reparseUnitForKey('/m/Res.3dshapes')).toBeNull() // models handled wholesale
  })
  it('maps records to the same unit', () => {
    expect(recordUnit(sym('Device:R', '/s/Device.kicad_sym'))).toBe('/s/Device.kicad_sym')
    expect(recordUnit(fp('R:F', '/f/R.pretty/F.kicad_mod'))).toBe('/f/R.pretty')
    expect(recordUnit(model('/m/Res.3dshapes/x.step'))).toBe('/m/Res.3dshapes')
  })
})

const scan = (over: Partial<ScanResult>): ScanResult => ({
  manifest: {},
  libraries: [],
  symbolFiles: [
    { library: 'Device', file: '/s/Device.kicad_sym', scope: 'system' },
    { library: 'My', file: '/u/My.kicad_sym', scope: 'global' }
  ],
  footprintFiles: [
    {
      library: 'Res',
      dir: '/f/Res.pretty',
      file: '/f/Res.pretty/R.kicad_mod',
      scope: 'system',
      fineGrained: false
    },
    {
      library: 'Custom',
      dir: '/u/Custom.pretty',
      file: '/u/Custom.pretty/A.kicad_mod',
      scope: 'global',
      fineGrained: true
    }
  ],
  modelPackages: [],
  modelRoot: '/m',
  ...over
})

describe('planPartialBuild', () => {
  it('selects only the changed/added symbol files and footprint dirs', () => {
    const diff: ManifestDiff = {
      changed: ['/s/Device.kicad_sym', '/u/Custom.pretty/A.kicad_mod'],
      removed: [],
      added: []
    }
    const plan = planPartialBuild(diff, scan({}))
    expect(plan.symbolFiles.map((s) => s.file)).toEqual(['/s/Device.kicad_sym'])
    expect(plan.footprintRoots.map((r) => [r.dir, r.fineGrained])).toEqual([
      ['/u/Custom.pretty', true]
    ])
    expect(plan.modelRoot).toBeNull() // no model unit touched
  })

  it('reparses all models when any package changed', () => {
    const plan = planPartialBuild(
      { changed: ['/m/Res.3dshapes'], removed: [], added: [] },
      scan({})
    )
    expect(plan.modelRoot).toBe('/m')
    expect(plan.symbolFiles).toEqual([])
    expect(plan.footprintRoots).toEqual([])
  })
})

describe('mergeIndex', () => {
  const old = [
    sym('Device:R', '/s/Device.kicad_sym'),
    sym('My:X', '/u/My.kicad_sym'),
    fp('Res:R', '/f/Res.pretty/R.kicad_mod'),
    model('/m/Res.3dshapes/x.step')
  ]

  it('drops changed/removed units, keeps the rest, appends fresh', () => {
    const diff: ManifestDiff = {
      changed: ['/s/Device.kicad_sym'],
      removed: ['/u/My.kicad_sym'],
      added: []
    }
    const fresh = [sym('Device:R2', '/s/Device.kicad_sym')]
    const merged = mergeIndex(old, fresh, diff)
    expect(merged.map((r) => r.id).sort()).toEqual(
      ['Device:R2', 'Res:R', '/m/Res.3dshapes/x.step'].sort()
    )
  })

  it('replaces all model records wholesale when a package changed', () => {
    const diff: ManifestDiff = { changed: ['/m/Res.3dshapes'], removed: [], added: [] }
    const fresh = [model('/m/Res.3dshapes/x.step'), model('/m/Res.3dshapes/y.step')]
    const merged = mergeIndex(old, fresh, diff)
    const models = merged.filter((r) => r.type === 'model').map((r) => r.id)
    expect(models).toEqual(['/m/Res.3dshapes/x.step', '/m/Res.3dshapes/y.step'])
    // Non-model records untouched.
    expect(
      merged
        .filter((r) => r.type !== 'model')
        .map((r) => r.id)
        .sort()
    ).toEqual(['Device:R', 'My:X', 'Res:R'])
  })
})
