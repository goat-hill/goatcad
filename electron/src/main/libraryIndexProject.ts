// Project-scope index (see libraries-workstream.md §2) — pure, `fs` injected, so
// it unit-tests and runs inline in main (no worker: a project has few files). It
// gathers the open design's own symbol sources and its placed footprint
// assignments; the renderer unions these over the system/global index with the
// project copy winning on a lib_id clash. Nothing here is persisted — it is
// rebuilt on demand, guarded by a per-file mtime memo (`projectManifest`).
//
// Sources: the project-tier `sym-lib-table` and `fp-lib-table` (KiCad's own
// S-exprs next to the `.kicad_pro`), each project `.kicad_sch`'s embedded
// `(lib_symbols …)`, and the placed-instance
// `(symbol … (property "Footprint" …))` assignments.

import { join } from 'path'
import { extractSymbols, extractFootprint, extractPlacedAssignments } from './libraryIndexExtract'
import type { IndexLibrary, IndexRecord } from './libraryIndexTypes'

export interface FootprintAssignment {
  symbol: string
  footprint: string
}

/**
 * A project-tier library as *registered* — from `sym-lib-table` / `fp-lib-table`
 * — independent of whether it currently holds any parts. A freshly created empty
 * library has zero `records`, so the Project view needs this to show it at all.
 */
export type ProjectLibraryRef = IndexLibrary

export interface ProjectIndex {
  records: IndexRecord[]
  assignments: FootprintAssignment[]
  /** Registered project libraries, empty ones included (see ProjectLibraryRef). */
  libraries: ProjectLibraryRef[]
  /** Input file → mtimeMs; the memo serves the cached result while these hold. */
  manifest: Record<string, number>
}

export interface ProjectDeps {
  /** File text, or null when missing/unreadable. */
  readFile: (path: string) => string | null
  /** File names directly in a directory ([] when missing). */
  listDir: (dir: string) => string[]
  /** mtimeMs of a path (0 when it cannot be statted). */
  mtimeMs: (path: string) => number
}

const unescape = (s: string): string => s.replace(/\\(["\\n])/g, (_, c) => (c === 'n' ? '\n' : c))

/** Resolve `${KIPRJMOD}` (the project directory) in a `sym-lib-table` uri. Twin of
 *  the renderer's `resolveLibUri` (renderer/lib/kicad/symbolLibraryTable.ts) —
 *  duplicated because main has no access to the renderer's S-expr parser; keep
 *  the two in sync. Other URI variables are left intact (they simply miss). */
export function resolveKiprjmod(uri: string, projectDir: string): string {
  return uri.replace(/\$\{KIPRJMOD\}/g, projectDir)
}

/** Lightweight library-table read (name + uri per `(lib …)`). Serves both
 *  `sym-lib-table` and `fp-lib-table` — the row shape is identical, only the
 *  wrapping token differs. The renderer parses these with its full S-expr
 *  parser; main needs only name/uri, and each `(lib)` carries exactly one of
 *  each in order, so a zipped scan suffices. */
export function parseSymLibTableLite(source: string): { name: string; uri: string }[] {
  const names = [...source.matchAll(/\(name\s+"((?:[^"\\]|\\.)*)"/g)].map((m) => unescape(m[1]))
  const uris = [...source.matchAll(/\(uri\s+"((?:[^"\\]|\\.)*)"/g)].map((m) => unescape(m[1]))
  const out: { name: string; uri: string }[] = []
  for (let i = 0; i < Math.min(names.length, uris.length); i++) {
    out.push({ name: names[i], uri: uris[i] })
  }
  return out
}

const schematicFiles = (dir: string, deps: ProjectDeps): string[] =>
  deps
    .listDir(dir)
    .filter((n) => n.toLowerCase().endsWith('.kicad_sch'))
    .map((n) => join(dir, n))

/** Rows of a project-tier library table, with `${KIPRJMOD}` resolved. */
const libTableEntries = (
  dir: string,
  tableName: 'sym-lib-table' | 'fp-lib-table',
  deps: ProjectDeps
): { name: string; file: string }[] => {
  const table = deps.readFile(join(dir, tableName))
  if (table === null) return []
  return parseSymLibTableLite(table).map((e) => ({
    name: e.name,
    file: resolveKiprjmod(e.uri, dir)
  }))
}

const symLibFiles = (dir: string, deps: ProjectDeps): { name: string; file: string }[] =>
  libTableEntries(dir, 'sym-lib-table', deps)

/** Registered footprint libraries — each a `.pretty` *directory*. */
const fpLibDirs = (dir: string, deps: ProjectDeps): { name: string; file: string }[] =>
  libTableEntries(dir, 'fp-lib-table', deps)

const footprintFilesIn = (libDir: string, deps: ProjectDeps): string[] =>
  deps
    .listDir(libDir)
    .filter((n) => n.toLowerCase().endsWith('.kicad_mod'))
    .map((n) => join(libDir, n))

/** The files whose mtimes invalidate a memoized project index. */
export function projectManifest(projectDir: string, deps: ProjectDeps): Record<string, number> {
  const manifest: Record<string, number> = {}
  for (const tableName of ['sym-lib-table', 'fp-lib-table'] as const) {
    const tablePath = join(projectDir, tableName)
    if (deps.readFile(tablePath) !== null) manifest[tablePath] = deps.mtimeMs(tablePath)
  }
  for (const { file } of symLibFiles(projectDir, deps)) manifest[file] = deps.mtimeMs(file)
  // Footprint libraries are tracked by *directory* mtime, one stat per library
  // rather than one per `.kicad_mod` — a registered `.pretty` can hold thousands
  // of files and this runs inline in main, not in the index worker. A directory
  // mtime catches footprints added or removed; it does not catch an edit to an
  // existing one, so editing a footprint in place will not refresh the index
  // until something else in the manifest moves. Acceptable while project-tier
  // libraries are small and hand-curated; the change bus closes the gap later
  // (the editor knows when it saved).
  for (const { file: libDir } of fpLibDirs(projectDir, deps))
    manifest[libDir] = deps.mtimeMs(libDir)
  for (const file of schematicFiles(projectDir, deps)) manifest[file] = deps.mtimeMs(file)
  return manifest
}

export function manifestEquals(a: Record<string, number>, b: Record<string, number>): boolean {
  const ak = Object.keys(a)
  if (ak.length !== Object.keys(b).length) return false
  return ak.every((k) => a[k] === b[k])
}

/** Build the project index from a resolved project directory. */
export function buildProjectIndex(projectDir: string, deps: ProjectDeps): ProjectIndex {
  const records: IndexRecord[] = []
  const assignments: FootprintAssignment[] = []
  const libraries: ProjectLibraryRef[] = []
  const seen = new Set<string>()

  // Project-tier `sym-lib-table` libraries (available parts, placed or not). The
  // library is registered whether or not it parses or holds symbols, so record
  // it before reading — an empty new library must still appear in the Project view.
  for (const { name, file } of symLibFiles(projectDir, deps)) {
    libraries.push({
      name,
      file,
      type: 'symbol',
      scope: 'project',
      readable: deps.mtimeMs(file) > 0
    })
    const content = deps.readFile(file)
    if (content === null) continue
    try {
      records.push(...extractSymbols(content, { library: name, file, scope: 'project' }))
    } catch {
      /* skip unparseable project library */
    }
  }

  // Project-tier `fp-lib-table` libraries. A `.pretty` is a directory of
  // `.kicad_mod` files, so this enumerates rather than reading one file.
  for (const { name, file: libDir } of fpLibDirs(projectDir, deps)) {
    libraries.push({
      name,
      file: libDir,
      type: 'footprint',
      scope: 'project',
      readable: deps.mtimeMs(libDir) > 0
    })
    for (const file of footprintFilesIn(libDir, deps)) {
      const content = deps.readFile(file)
      if (content === null) continue
      try {
        records.push(
          extractFootprint(content, {
            library: name,
            file,
            scope: 'project',
            name: file.replace(/^.*[\\/]/, '').replace(/\.kicad_mod$/i, '')
          })
        )
      } catch {
        /* skip unparseable footprint */
      }
    }
  }

  // Embedded definitions + placed footprint assignments, per schematic sheet.
  for (const file of schematicFiles(projectDir, deps)) {
    const content = deps.readFile(file)
    if (content === null) continue
    try {
      records.push(
        ...extractSymbols(
          content,
          { library: '', file, scope: 'project' },
          { container: 'lib_symbols', embedded: true }
        )
      )
    } catch {
      /* skip unparseable sheet */
    }
    try {
      for (const a of extractPlacedAssignments(content)) {
        const key = `${a.symbol} ${a.footprint}`
        if (seen.has(key)) continue
        seen.add(key)
        assignments.push(a)
      }
    } catch {
      /* skip */
    }
  }

  return { records, assignments, libraries, manifest: projectManifest(projectDir, deps) }
}
