// Standard KiCad library provisioning — pure helpers (no Electron/fs side effects
// beyond an injected `existsSync`), so they unit-test cleanly. See
// `docs/libraries-workstream.md` for the design.
//
// GoatCAD supplies the standard symbol/footprint/3D libraries by either detecting
// a local KiCad install (preferred — reuses files already on disk) or downloading
// a version-pinned copy. Both are strictly read-only.

/**
 * The KiCad library generation GoatCAD targets. Drives both the download tag and
 * the `KICAD{MAJOR}_*_DIR` env-var names KiCad uses in library tables and
 * footprint `(model …)` paths. Bump together.
 */
export const KICAD_LIB_VERSION = '10.0.7'
export const KICAD_LIB_MAJOR = 10

/** The three standard library sets. 3D is separate — multi-GB, path-based. */
export type LibrarySet = 'symbols' | 'footprints' | 'packages3d'

interface LibrarySetSpec {
  /** GitLab project under gitlab.com/kicad/libraries. */
  repo: string
  /** Subdirectory name inside a detected/extracted KiCad share dir. */
  installSubdir: string
  /** The `KICAD{MAJOR}_*_DIR` variable KiCad substitutes for this set. */
  envVar: string
}

export const LIBRARY_SETS: Record<LibrarySet, LibrarySetSpec> = {
  symbols: {
    repo: 'kicad-symbols',
    installSubdir: 'symbols',
    envVar: `KICAD${KICAD_LIB_MAJOR}_SYMBOL_DIR`
  },
  footprints: {
    repo: 'kicad-footprints',
    installSubdir: 'footprints',
    envVar: `KICAD${KICAD_LIB_MAJOR}_FOOTPRINT_DIR`
  },
  packages3d: {
    repo: 'kicad-packages3D',
    installSubdir: '3dmodels',
    envVar: `KICAD${KICAD_LIB_MAJOR}_3DMODEL_DIR`
  }
}

/**
 * Version-pinned GitLab archive tarball URL for a set (no git clone). The archive
 * expands to a top-level `<repo>-<tag>/` directory.
 */
export function tarballUrl(set: LibrarySet, version = KICAD_LIB_VERSION): string {
  const { repo } = LIBRARY_SETS[set]
  return `https://gitlab.com/kicad/libraries/${repo}/-/archive/${version}/${repo}-${version}.tar.gz`
}

/** Directory name the tarball expands to (its top-level folder). */
export function extractedDirName(set: LibrarySet, version = KICAD_LIB_VERSION): string {
  return `${LIBRARY_SETS[set].repo}-${version}`
}

export interface DetectDeps {
  platform: NodeJS.Platform
  existsSync: (p: string) => boolean
  /** Home directory, for Flatpak user installs on Linux. */
  home?: string
}

export interface DetectedLibraries {
  /** Human label for the install root that matched (e.g. `/usr/share/kicad`). */
  root: string
  symbols?: string
  footprints?: string
  models3d?: string
}

/**
 * Candidate KiCad "share" roots for a platform, newest install first. Each root is
 * expected to contain `symbols/`, `footprints/`, `3dmodels/` subdirs.
 */
export function shareRootCandidates(platform: NodeJS.Platform, home?: string): string[] {
  if (platform === 'darwin') {
    return ['/Applications/KiCad/KiCad.app/Contents/SharedSupport']
  }
  if (platform === 'win32') {
    const majors = [10, 9, 8, 7, 6]
    const bases = ['C:\\Program Files\\KiCad', 'C:\\Program Files (x86)\\KiCad']
    const out: string[] = []
    for (const major of majors) {
      for (const base of bases) out.push(`${base}\\${major}\\share\\kicad`)
    }
    return out
  }
  // Linux and everything else: native package locations, then Flatpak (best-effort).
  const roots = ['/usr/share/kicad', '/usr/local/share/kicad']
  const flatpakSuffix = 'app/org.kicad.KiCad/current/active/files/share/kicad'
  roots.push(`/var/lib/flatpak/${flatpakSuffix}`)
  if (home) roots.push(`${home}/.local/share/flatpak/${flatpakSuffix}`)
  return roots
}

/**
 * Detect a local KiCad install's standard libraries. Returns the first share root
 * that has at least one of `symbols/` or `footprints/`, with each set's dir filled
 * in only when it exists. `null` when nothing is found (→ offer download).
 */
/**
 * KiCad's per-user data root, where the Plugin & Content Manager installs
 * third-party libraries — the `${KICAD*_3RD_PARTY}` token. Not under the shared
 * install root: it belongs to the user, not the package, and its version
 * directory tracks the KiCad that created it rather than the one installed now
 * (a board written against KiCad 8 routinely points into a 10.0 tree).
 * Newest major first, so a machine with several picks the current one.
 */
export function thirdPartyRootCandidates(platform: NodeJS.Platform, home?: string): string[] {
  if (!home) return []
  const majors = [10, 9, 8, 7, 6]
  if (platform === 'win32') {
    return majors.map((major) => `${home}\\Documents\\KiCad\\${major}.0\\3rdparty`)
  }
  if (platform === 'darwin') {
    return majors.map((major) => `${home}/Documents/KiCad/${major}.0/3rdparty`)
  }
  return majors.map((major) => `${home}/.local/share/kicad/${major}.0/3rdparty`)
}

/** The user's PCM third-party directory, or null when they have none. */
export function detectThirdPartyDir(deps: DetectDeps): string | null {
  const { platform, existsSync, home } = deps
  return thirdPartyRootCandidates(platform, home).find(existsSync) ?? null
}

export function detectSystemLibraries(deps: DetectDeps): DetectedLibraries | null {
  const { platform, existsSync, home } = deps
  const sep = platform === 'win32' ? '\\' : '/'
  for (const root of shareRootCandidates(platform, home)) {
    const symbols = `${root}${sep}symbols`
    const footprints = `${root}${sep}footprints`
    const models3d = `${root}${sep}3dmodels`
    const hasSymbols = existsSync(symbols)
    const hasFootprints = existsSync(footprints)
    if (!hasSymbols && !hasFootprints) continue
    return {
      root,
      ...(hasSymbols ? { symbols } : {}),
      ...(hasFootprints ? { footprints } : {}),
      ...(existsSync(models3d) ? { models3d } : {})
    }
  }
  return null
}
