import { describe, it, expect } from 'vitest'
import {
  KICAD_LIB_VERSION,
  LIBRARY_SETS,
  tarballUrl,
  extractedDirName,
  shareRootCandidates,
  detectSystemLibraries,
  detectThirdPartyDir,
  thirdPartyRootCandidates
} from '../kicadLibraries'

describe('kicad library set specs', () => {
  it('names env vars with the targeted major version', () => {
    expect(LIBRARY_SETS.symbols.envVar).toBe('KICAD10_SYMBOL_DIR')
    expect(LIBRARY_SETS.footprints.envVar).toBe('KICAD10_FOOTPRINT_DIR')
    expect(LIBRARY_SETS.packages3d.envVar).toBe('KICAD10_3DMODEL_DIR')
  })

  it('builds a version-pinned archive URL (not a moving branch)', () => {
    expect(tarballUrl('symbols')).toBe(
      `https://gitlab.com/kicad/libraries/kicad-symbols/-/archive/${KICAD_LIB_VERSION}/kicad-symbols-${KICAD_LIB_VERSION}.tar.gz`
    )
    expect(tarballUrl('footprints', '9.0.0')).toContain(
      '/archive/9.0.0/kicad-footprints-9.0.0.tar.gz'
    )
  })

  it('derives the tarball top-level directory name', () => {
    expect(extractedDirName('symbols')).toBe(`kicad-symbols-${KICAD_LIB_VERSION}`)
    expect(extractedDirName('packages3d', '9.0.0')).toBe('kicad-packages3D-9.0.0')
  })
})

describe('shareRootCandidates', () => {
  it('uses the app bundle path on macOS', () => {
    expect(shareRootCandidates('darwin')[0]).toBe(
      '/Applications/KiCad/KiCad.app/Contents/SharedSupport'
    )
  })

  it('enumerates Program Files majors newest-first on Windows', () => {
    const roots = shareRootCandidates('win32')
    expect(roots[0]).toBe('C:\\Program Files\\KiCad\\10\\share\\kicad')
    expect(roots.some((r) => r.includes('\\9\\'))).toBe(true)
  })

  it('prefers native package locations on Linux, includes flatpak', () => {
    const roots = shareRootCandidates('linux', '/home/u')
    expect(roots[0]).toBe('/usr/share/kicad')
    expect(roots.some((r) => r.includes('/home/u/.local/share/flatpak'))).toBe(true)
  })
})

describe('detectSystemLibraries', () => {
  const linux =
    (present: Set<string>): ((p: string) => boolean) =>
    (p) =>
      present.has(p)

  it('returns the first root with symbols or footprints, filling only existing sets', () => {
    const present = new Set(['/usr/share/kicad/symbols', '/usr/share/kicad/footprints'])
    const found = detectSystemLibraries({ platform: 'linux', existsSync: linux(present) })
    expect(found).toEqual({
      root: '/usr/share/kicad',
      symbols: '/usr/share/kicad/symbols',
      footprints: '/usr/share/kicad/footprints'
    })
  })

  it('includes 3dmodels only when present', () => {
    const present = new Set([
      '/usr/share/kicad/symbols',
      '/usr/share/kicad/footprints',
      '/usr/share/kicad/3dmodels'
    ])
    const found = detectSystemLibraries({ platform: 'linux', existsSync: linux(present) })
    expect(found?.models3d).toBe('/usr/share/kicad/3dmodels')
  })

  it('skips a root that has neither symbols nor footprints', () => {
    const present = new Set(['/usr/local/share/kicad/footprints'])
    const found = detectSystemLibraries({ platform: 'linux', existsSync: linux(present) })
    expect(found?.root).toBe('/usr/local/share/kicad')
    expect(found?.symbols).toBeUndefined()
  })

  it('returns null when no install is found', () => {
    expect(detectSystemLibraries({ platform: 'linux', existsSync: () => false })).toBeNull()
  })

  it('uses backslash separators on Windows', () => {
    const present = new Set(['C:\\Program Files\\KiCad\\10\\share\\kicad\\symbols'])
    const found = detectSystemLibraries({ platform: 'win32', existsSync: (p) => present.has(p) })
    expect(found?.symbols).toBe('C:\\Program Files\\KiCad\\10\\share\\kicad\\symbols')
  })
})

describe('the PCM third-party directory', () => {
  it('looks in the per-user data root, newest major first', () => {
    const linux = thirdPartyRootCandidates('linux', '/home/u')
    expect(linux[0]).toBe('/home/u/.local/share/kicad/10.0/3rdparty')
    expect(linux).toContain('/home/u/.local/share/kicad/8.0/3rdparty')
  })

  it('uses the Documents tree on macOS and Windows', () => {
    expect(thirdPartyRootCandidates('darwin', '/Users/u')[0]).toBe(
      '/Users/u/Documents/KiCad/10.0/3rdparty'
    )
    expect(thirdPartyRootCandidates('win32', 'C:\\Users\\u')[0]).toBe(
      'C:\\Users\\u\\Documents\\KiCad\\10.0\\3rdparty'
    )
  })

  it('has nothing to offer without a home directory', () => {
    expect(thirdPartyRootCandidates('linux')).toEqual([])
    expect(detectThirdPartyDir({ platform: 'linux', existsSync: () => true })).toBeNull()
  })

  // The version in the path is the KiCad that created the tree, not the one
  // installed now — an 8.0 board routinely points into a 10.0 3rdparty dir.
  it('takes the newest tree that exists, whatever the board referenced', () => {
    const present = new Set(['/home/u/.local/share/kicad/9.0/3rdparty'])
    expect(
      detectThirdPartyDir({
        platform: 'linux',
        existsSync: (p) => present.has(p),
        home: '/home/u'
      })
    ).toBe('/home/u/.local/share/kicad/9.0/3rdparty')
  })

  it('returns null when the user has installed nothing through the PCM', () => {
    expect(
      detectThirdPartyDir({ platform: 'linux', existsSync: () => false, home: '/home/u' })
    ).toBeNull()
  })
})
