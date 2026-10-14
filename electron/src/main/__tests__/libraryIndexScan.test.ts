import { describe, it, expect } from 'vitest'
import { scanRequest, type BuildRequest, type ScanDeps, type DirEntry } from '../libraryIndexScan'

const dir = (...names: [string, boolean][]): DirEntry[] =>
  names.map(([name, isDirectory]) => ({ name, isDirectory }))

const deps: ScanDeps = {
  readDir: (d) =>
    ({
      '/std/fp': dir(['Resistor.pretty', true]),
      '/std/fp/Resistor.pretty': dir(['R_0402.kicad_mod', false]),
      '/user/Custom.pretty': dir(['A.kicad_mod', false], ['B.kicad_mod', false]),
      '/std/3d': dir(['Res.3dshapes', true]),
      '/std/3d/Res.3dshapes': dir(['r.step', false], ['r.wrl', false])
    })[d] ?? [],
  // Distinct mtimes so a manifest key can be told apart in the diff tests.
  mtimeMs: (p) =>
    ({
      '/std/Device.kicad_sym': 10,
      '/user/My.kicad_sym': 11,
      '/std/fp': 20,
      '/std/fp/Resistor.pretty': 21,
      '/user/Custom.pretty': 30,
      '/user/Custom.pretty/A.kicad_mod': 31,
      '/user/Custom.pretty/B.kicad_mod': 32,
      '/std/3d': 40,
      '/std/3d/Res.3dshapes': 41
    })[p] ?? 0
}

const req: BuildRequest = {
  symbolFiles: [
    { library: 'Device', file: '/std/Device.kicad_sym', scope: 'system' },
    { library: 'My', file: '/user/My.kicad_sym', scope: 'global' }
  ],
  footprintRoots: [
    { nickname: 'std', dir: '/std/fp', scope: 'system', fineGrained: false },
    { nickname: 'Custom', dir: '/user/Custom.pretty', scope: 'global', fineGrained: true }
  ],
  modelRoot: '/std/3d'
}

describe('scanRequest', () => {
  const scan = scanRequest(req, deps)

  it('threads scope per unit (system vs global)', () => {
    expect(scan.symbolFiles.map((s) => [s.library, s.scope])).toEqual([
      ['Device', 'system'],
      ['My', 'global']
    ])
    const byLib = Object.fromEntries(scan.footprintFiles.map((f) => [f.library, f.scope]))
    expect(byLib).toEqual({ Resistor: 'system', Custom: 'global' })
    expect(scan.modelPackages.every((p) => p.scope === 'system')).toBe(true)
  })

  it('records coarse dir mtimes for read-only libs, per-file mtimes for fineGrained ones', () => {
    // Coarse system `.pretty`: the directory is the unit, not each `.kicad_mod`.
    expect(scan.manifest['/std/fp/Resistor.pretty']).toBe(21)
    expect('/std/fp/Resistor.pretty/R_0402.kicad_mod' in scan.manifest).toBe(false)
    // Fine-grained user lib: every `.kicad_mod` is its own unit (writable → edits).
    expect(scan.manifest['/user/Custom.pretty/A.kicad_mod']).toBe(31)
    expect(scan.manifest['/user/Custom.pretty/B.kicad_mod']).toBe(32)
  })

  it('stamps symbol files, container roots, and model packages', () => {
    expect(scan.manifest['/std/Device.kicad_sym']).toBe(10)
    expect(scan.manifest['/std/fp']).toBe(20) // container catches a `.pretty` add/remove
    expect(scan.manifest['/std/3d']).toBe(40)
    expect(scan.manifest['/std/3d/Res.3dshapes']).toBe(41)
    expect(scan.modelPackages[0]).toMatchObject({ pkg: 'Res', files: ['r.step', 'r.wrl'] })
  })

  it('marks footprint files with their root fineGrained flag', () => {
    const custom = scan.footprintFiles.filter((f) => f.library === 'Custom')
    expect(custom).toHaveLength(2)
    expect(custom.every((f) => f.fineGrained)).toBe(true)
    expect(scan.footprintFiles.find((f) => f.library === 'Resistor')?.fineGrained).toBe(false)
  })

  it('lists every library it reaches: each `.pretty` under a root, and each symbol file', () => {
    expect(scan.libraries).toEqual([
      {
        type: 'symbol',
        name: 'Device',
        file: '/std/Device.kicad_sym',
        scope: 'system',
        readable: true
      },
      { type: 'symbol', name: 'My', file: '/user/My.kicad_sym', scope: 'global', readable: true },
      {
        type: 'footprint',
        name: 'Resistor',
        file: '/std/fp/Resistor.pretty',
        scope: 'system',
        readable: true
      },
      {
        type: 'footprint',
        name: 'Custom',
        file: '/user/Custom.pretty',
        scope: 'global',
        readable: true
      }
    ])
  })

  it('names a root that is itself a library by its table nickname, empty or missing alike', () => {
    const libraries = scanRequest(
      {
        symbolFiles: [],
        footprintRoots: [
          { nickname: 'Mine', dir: '/user/Custom.pretty', scope: 'global', fineGrained: true },
          { nickname: 'Empty', dir: '/user/Empty.pretty', scope: 'global', fineGrained: true }
        ],
        modelRoot: null
      },
      deps
    ).libraries
    expect(libraries.map((l) => [l.name, l.readable])).toEqual([
      ['Mine', true],
      // Nothing there: listed, so a check can say it cannot be read rather than that no table has it.
      ['Empty', false]
    ])
  })
})
