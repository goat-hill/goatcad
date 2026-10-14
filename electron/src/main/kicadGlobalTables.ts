// One-time import of a user's KiCad global-library tables; never mirror them.

/** KiCad majors to look for, newest first — a machine may hold several. */
const KICAD_CONFIG_MAJORS = [10, 9, 8, 7, 6]

export interface ConfigDeps {
  platform: NodeJS.Platform
  existsSync: (p: string) => boolean
  home?: string
}

/**
 * Where KiCad keeps its per-user configuration, newest major first. These are
 * the documented locations for KiCad 6+; earlier versions used an unversioned
 * directory and are not targeted.
 */
export function kicadConfigCandidates(platform: NodeJS.Platform, home?: string): string[] {
  if (!home) return []
  if (platform === 'win32') {
    return KICAD_CONFIG_MAJORS.map((major) => `${home}\\AppData\\Roaming\\kicad\\${major}.0`)
  }
  if (platform === 'darwin') {
    return KICAD_CONFIG_MAJORS.map((major) => `${home}/Library/Preferences/kicad/${major}.0`)
  }
  return KICAD_CONFIG_MAJORS.map((major) => `${home}/.config/kicad/${major}.0`)
}

/**
 * The user's KiCad config directory — the first candidate that actually holds a
 * global library table. Existence of the directory alone is not enough: KiCad
 * creates version directories eagerly, and an empty one has nothing to seed.
 */
export function detectKicadConfigDir(deps: ConfigDeps): string | null {
  const { platform, existsSync, home } = deps
  const sep = platform === 'win32' ? '\\' : '/'
  for (const dir of kicadConfigCandidates(platform, home)) {
    if (existsSync(`${dir}${sep}sym-lib-table`) || existsSync(`${dir}${sep}fp-lib-table`)) {
      return dir
    }
  }
  return null
}

/** What each KiCad path token in a library URI expands to. */
export interface UriFallbacks {
  /** The detected install's `symbols/` dir, for `${KICAD*_SYMBOL_DIR}`. */
  symbolDir?: string
  /** Its `footprints/` dir, for `${KICAD*_FOOTPRINT_DIR}`. */
  footprintDir?: string
  /** The user's PCM `3rdparty/` dir, for `${KICAD*_3RD_PARTY}`. */
  thirdPartyDir?: string
  home?: string
}

const SYMBOL_DIR_VAR = /^KICAD\d*_SYMBOL_DIR$/
const FOOTPRINT_DIR_VAR = /^KICAD\d*_FOOTPRINT_DIR$/
const THIRD_PARTY_VAR = /^KICAD\d*_3RD_PARTY$/

/**
 * Expand `${VAR}` tokens in a library URI. Same problem `modelResolver.ts`
 * solves for `(model …)` paths: the values exist only inside a running KiCad and
 * are never serialized, so a detected install stands in. An unknown token is
 * left intact, which is what marks the row unresolvable below.
 */
export function expandLibraryUri(
  uri: string,
  env: NodeJS.ProcessEnv,
  fallbacks: UriFallbacks = {}
): string {
  return uri.replace(/\$\{([^}]+)\}/g, (whole, name: string) => {
    const value = env[name]
    if (value) return value
    if (SYMBOL_DIR_VAR.test(name) && fallbacks.symbolDir) return fallbacks.symbolDir
    if (FOOTPRINT_DIR_VAR.test(name) && fallbacks.footprintDir) return fallbacks.footprintDir
    if (THIRD_PARTY_VAR.test(name) && fallbacks.thirdPartyDir) return fallbacks.thirdPartyDir
    if (name === 'HOME' && fallbacks.home) return fallbacks.home
    return whole
  })
}

/** Split a path on either separator, tolerating both platforms' conventions. */
const segments = (path: string): string[] => path.split(/[/\\]/).filter(Boolean)

/** Whether `path` sits under `dir`, compared case-insensitively (macOS/Windows). */
const isUnder = (path: string, dir: string | undefined): boolean => {
  if (!dir) return false
  const target = segments(path)
  const base = segments(dir)
  if (target.length < base.length) return false
  return base.every((part, i) => part.toLowerCase() === target[i].toLowerCase())
}

export interface SeedRow {
  nickname: string
  path: string
}

/**
 * The rows worth importing from one of KiCad's global tables.
 *
 * Three kinds are dropped, each for its own reason:
 * - **Standard libraries** — already provisioned as `system` scope, and importing
 *   them again would double every stock part in the chooser.
 * - **Unresolvable tokens** — a `${SOMEVAR}` we cannot expand names a path that
 *   does not exist for us; registering it would add a permanently broken row.
 * - **`${KIPRJMOD}`** — project-relative, which is meaningless in a *global*
 *   table. KiCad allows it; it resolves to whatever project happens to be open.
 */
export function seedRowsFromTable(
  entries: readonly { name: string; uri: string }[],
  fallbacks: UriFallbacks,
  env: NodeJS.ProcessEnv = process.env
): SeedRow[] {
  const rows: SeedRow[] = []
  for (const entry of entries) {
    if (entry.uri.includes('${KIPRJMOD}')) continue
    const path = expandLibraryUri(entry.uri, env, fallbacks)
    if (path.includes('${')) continue
    if (isUnder(path, fallbacks.symbolDir) || isUnder(path, fallbacks.footprintDir)) continue
    rows.push({ nickname: entry.name, path })
  }
  return rows
}

/**
 * Merge seed rows into an existing table, keyed by **path** rather than by
 * nickname: re-running the seed must not duplicate a library the user already
 * has, and the same library registered under a different nickname is still the
 * same library. A nickname collision suffixes instead, since the nickname is the
 * part's identity (`lib_id` is `Nickname:Name`) and shadowing one silently would
 * change which part a design resolves to.
 *
 * Returns null when nothing was added, so the caller can skip the write (and the
 * index rebuild that follows it) entirely.
 */
export function mergeSeedRows<T extends { nickname: string; path: string }>(
  existing: readonly T[],
  seeds: readonly SeedRow[],
  make: (row: SeedRow) => T
): T[] | null {
  const paths = new Set(existing.map((row) => row.path.toLowerCase()))
  const nicknames = new Set(existing.map((row) => row.nickname.toLowerCase()))
  const added: T[] = []
  for (const seed of seeds) {
    if (paths.has(seed.path.toLowerCase())) continue
    paths.add(seed.path.toLowerCase())
    let nickname = seed.nickname
    for (let index = 1; nicknames.has(nickname.toLowerCase()); index++) {
      nickname = `${seed.nickname}-${index}`
    }
    nicknames.add(nickname.toLowerCase())
    added.push(make({ nickname, path: seed.path }))
  }
  return added.length > 0 ? [...existing, ...added] : null
}
