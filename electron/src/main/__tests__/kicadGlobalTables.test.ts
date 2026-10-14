import { describe, it, expect } from 'vitest'
import {
  detectKicadConfigDir,
  expandLibraryUri,
  kicadConfigCandidates,
  mergeSeedRows,
  seedRowsFromTable
} from '../kicadGlobalTables'

const NO_ENV: NodeJS.ProcessEnv = {}

describe('kicadConfigCandidates', () => {
  it('lists the newest KiCad major first, so a machine with several picks it', () => {
    const linux = kicadConfigCandidates('linux', '/home/u')
    expect(linux[0]).toBe('/home/u/.config/kicad/10.0')
    expect(linux).toContain('/home/u/.config/kicad/6.0')
  })

  it("uses each platform's own configuration location", () => {
    expect(kicadConfigCandidates('darwin', '/Users/u')[0]).toBe(
      '/Users/u/Library/Preferences/kicad/10.0'
    )
    expect(kicadConfigCandidates('win32', 'C:\\Users\\u')[0]).toBe(
      'C:\\Users\\u\\AppData\\Roaming\\kicad\\10.0'
    )
  })

  it('yields nothing without a home directory to anchor on', () => {
    expect(kicadConfigCandidates('linux')).toEqual([])
  })
})

describe('detectKicadConfigDir', () => {
  it('skips a version directory that holds no table', () => {
    const present = new Set(['/home/u/.config/kicad/9.0/sym-lib-table'])
    expect(
      detectKicadConfigDir({
        platform: 'linux',
        home: '/home/u',
        existsSync: (p) => present.has(p)
      })
    ).toBe('/home/u/.config/kicad/9.0')
  })

  it('is null when KiCad has never run here', () => {
    expect(
      detectKicadConfigDir({ platform: 'linux', home: '/home/u', existsSync: () => false })
    ).toBeNull()
  })
})

describe('expandLibraryUri', () => {
  const fallbacks = {
    symbolDir: '/usr/share/kicad/symbols',
    footprintDir: '/usr/share/kicad/footprints',
    thirdPartyDir: '/home/u/.local/share/kicad/10.0/3rdparty',
    home: '/home/u'
  }

  it("substitutes the detected install for KiCad's unset library variables", () => {
    expect(expandLibraryUri('${KICAD9_SYMBOL_DIR}/Device.kicad_sym', NO_ENV, fallbacks)).toBe(
      '/usr/share/kicad/symbols/Device.kicad_sym'
    )
    expect(expandLibraryUri('${KICAD8_FOOTPRINT_DIR}/R.pretty', NO_ENV, fallbacks)).toBe(
      '/usr/share/kicad/footprints/R.pretty'
    )
  })

  it('prefers a real environment value over the fallback', () => {
    expect(
      expandLibraryUri('${KICAD9_SYMBOL_DIR}/Device.kicad_sym', {
        KICAD9_SYMBOL_DIR: '/opt/kicad/symbols'
      })
    ).toBe('/opt/kicad/symbols/Device.kicad_sym')
  })

  it('leaves a token it cannot resolve intact, which is what marks the row broken', () => {
    expect(expandLibraryUri('${MY_PARTS}/House.kicad_sym', NO_ENV, fallbacks)).toBe(
      '${MY_PARTS}/House.kicad_sym'
    )
  })
})

describe('seedRowsFromTable', () => {
  const fallbacks = {
    symbolDir: '/usr/share/kicad/symbols',
    footprintDir: '/usr/share/kicad/footprints',
    home: '/home/u'
  }

  it("imports the user's own libraries and drops the standard ones", () => {
    const rows = seedRowsFromTable(
      [
        { name: 'Device', uri: '${KICAD9_SYMBOL_DIR}/Device.kicad_sym' },
        { name: 'MyParts', uri: '/home/u/parts/MyParts.kicad_sym' }
      ],
      fallbacks,
      NO_ENV
    )
    expect(rows).toEqual([{ nickname: 'MyParts', path: '/home/u/parts/MyParts.kicad_sym' }])
  })

  it('drops a row whose variable nothing can expand', () => {
    const rows = seedRowsFromTable(
      [{ name: 'Ghost', uri: '${SOME_VAR}/Ghost.kicad_sym' }],
      fallbacks,
      NO_ENV
    )
    expect(rows).toEqual([])
  })

  it('drops a project-relative row, which is meaningless in a global table', () => {
    const rows = seedRowsFromTable(
      [{ name: 'Local', uri: '${KIPRJMOD}/Local.kicad_sym' }],
      fallbacks,
      NO_ENV
    )
    expect(rows).toEqual([])
  })

  it('keeps a third-party (PCM) library — the user installed that deliberately', () => {
    const rows = seedRowsFromTable(
      [{ name: 'Espressif', uri: '${KICAD10_3RD_PARTY}/symbols/Espressif.kicad_sym' }],
      { ...fallbacks, thirdPartyDir: '/home/u/.local/share/kicad/10.0/3rdparty' },
      NO_ENV
    )
    expect(rows).toEqual([
      {
        nickname: 'Espressif',
        path: '/home/u/.local/share/kicad/10.0/3rdparty/symbols/Espressif.kicad_sym'
      }
    ])
  })
})

describe('mergeSeedRows', () => {
  const make = (row: { nickname: string; path: string }): typeof row & { type: 'local' } => ({
    ...row,
    type: 'local'
  })

  it('adds rows the table does not already carry', () => {
    const merged = mergeSeedRows(
      [{ nickname: 'Existing', path: '/a/Existing.kicad_sym', type: 'local' as const }],
      [{ nickname: 'MyParts', path: '/b/MyParts.kicad_sym' }],
      make
    )
    expect(merged).toHaveLength(2)
    expect(merged?.[1]).toEqual({
      nickname: 'MyParts',
      path: '/b/MyParts.kicad_sym',
      type: 'local'
    })
  })

  it('is idempotent by path, so a re-run adds nothing', () => {
    const existing = [{ nickname: 'Renamed', path: '/b/MyParts.kicad_sym', type: 'local' as const }]
    expect(
      mergeSeedRows(existing, [{ nickname: 'MyParts', path: '/b/MyParts.kicad_sym' }], make)
    ).toBeNull()
  })

  it('suffixes a clashing nickname rather than shadowing the existing library', () => {
    const merged = mergeSeedRows(
      [{ nickname: 'MyParts', path: '/a/MyParts.kicad_sym', type: 'local' as const }],
      [{ nickname: 'MyParts', path: '/b/MyParts.kicad_sym' }],
      make
    )
    expect(merged?.[1].nickname).toBe('MyParts-1')
  })
})
