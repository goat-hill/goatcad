// Filesystem walk for the library index — pure, with `fs` injected via `ScanDeps`
// so it runs identically in the index worker (real fs) and in main's incremental
// change-detection path, and unit-tests against an in-memory tree. It does the
// cheap part (readdir + stat) and never reads file *contents*: it resolves which
// symbol files / footprint `.kicad_mod`s / model packages a `BuildRequest` covers
// and the coarse `{unit → mtime}` manifest, leaving the heavy parse to the worker.
//
// Manifest granularity (see libraries-workstream.md §2): a `.kicad_sym`
// file, a `.pretty` dir (read-only system libs — dir-mtime), a single
// `.kicad_mod` (user/`fineGrained` libs — per-file mtime, since they are
// writable), or a `.3dshapes` dir. Container roots (a footprint root of `.pretty`
// dirs, the model root) are also stamped so an added/removed child is caught.

import { join } from 'path'
import type { IndexLibrary, IndexScope } from './libraryIndexTypes'

/** One build unit's inputs. `scope` is threaded per unit (a request mixes system
 *  and global rows), not once per request. */
export interface BuildRequest {
  /** `.kicad_sym` files — one file, many symbols. */
  symbolFiles: { library: string; file: string; scope: IndexScope }[]
  /** Footprint roots — a dir of `.pretty` subdirs (KiCad_Official) or a single
   *  `.pretty`. `fineGrained` (user-writable libs) records per-`.kicad_mod`
   *  mtimes instead of the dir mtime, so in-place edits are caught. */
  footprintRoots: { nickname: string; dir: string; scope: IndexScope; fineGrained?: boolean }[]
  /** The `3dmodels/` directory (`.3dshapes` packages), or null. System scope. */
  modelRoot: string | null
}

export interface DirEntry {
  name: string
  isDirectory: boolean
}

export interface ScanDeps {
  /** Directory listing; returns [] for a missing/unreadable dir. */
  readDir: (dir: string) => DirEntry[]
  /** mtimeMs of a path; 0 when it cannot be statted. */
  mtimeMs: (path: string) => number
}

export interface FootprintFile {
  library: string
  /** The `.pretty` directory. */
  dir: string
  /** Absolute `.kicad_mod` path. */
  file: string
  scope: IndexScope
  fineGrained: boolean
}

export interface ModelPackage {
  pkg: string
  dir: string
  files: string[]
  scope: IndexScope
}

export interface ScanResult {
  /** Change-detection units: unit path → mtimeMs. */
  manifest: Record<string, number>
  symbolFiles: { library: string; file: string; scope: IndexScope }[]
  footprintFiles: FootprintFile[]
  modelPackages: ModelPackage[]
  /** Every symbol and footprint library the request reaches, empty ones included.
   *  Whole only for a full request; a partial one lists just its own units. */
  libraries: IndexLibrary[]
  /** Echoed from the request, for building a partial reparse of models. */
  modelRoot: string | null
}

const isModelFile = (name: string): boolean => /\.(step|stp|wrl)$/i.test(name)

/** Normalize a footprint root into its constituent `.pretty` libraries: either the
 *  root is itself a library — a `.pretty`, or a directory holding `.kicad_mod`s —
 *  named by its table nickname as KiCad names it, or a parent of `.pretty`s, each
 *  named by its directory. */
function footprintLibDirs(
  root: { nickname: string; dir: string },
  deps: ScanDeps
): { library: string; dir: string }[] {
  const entries = deps.readDir(root.dir)
  const isLibrary =
    /\.pretty$/i.test(root.dir) ||
    entries.some((e) => !e.isDirectory && e.name.toLowerCase().endsWith('.kicad_mod'))
  if (isLibrary) return [{ library: root.nickname, dir: root.dir }]
  return entries
    .filter((e) => e.isDirectory && e.name.toLowerCase().endsWith('.pretty'))
    .map((e) => ({ library: e.name.replace(/\.pretty$/i, ''), dir: join(root.dir, e.name) }))
}

/** Resolve a request's files + coarse manifest without reading file contents. */
export function scanRequest(req: BuildRequest, deps: ScanDeps): ScanResult {
  const manifest: Record<string, number> = {}
  const libraries: IndexLibrary[] = []

  const symbolFiles = req.symbolFiles.map((s) => {
    manifest[s.file] = deps.mtimeMs(s.file)
    libraries.push({
      type: 'symbol',
      name: s.library,
      file: s.file,
      scope: s.scope,
      readable: manifest[s.file] > 0
    })
    return s
  })

  const footprintFiles: FootprintFile[] = []
  for (const root of req.footprintRoots) {
    manifest[root.dir] = deps.mtimeMs(root.dir) // container: catches add/remove of a `.pretty`
    const fineGrained = !!root.fineGrained
    for (const lib of footprintLibDirs(root, deps)) {
      if (!fineGrained) manifest[lib.dir] = deps.mtimeMs(lib.dir)
      libraries.push({
        type: 'footprint',
        name: lib.library,
        file: lib.dir,
        scope: root.scope,
        readable: deps.mtimeMs(lib.dir) > 0
      })
      for (const e of deps.readDir(lib.dir)) {
        if (e.isDirectory || !e.name.toLowerCase().endsWith('.kicad_mod')) continue
        const file = join(lib.dir, e.name)
        if (fineGrained) manifest[file] = deps.mtimeMs(file)
        footprintFiles.push({
          library: lib.library,
          dir: lib.dir,
          file,
          scope: root.scope,
          fineGrained
        })
      }
    }
  }

  const modelPackages: ModelPackage[] = []
  if (req.modelRoot) {
    manifest[req.modelRoot] = deps.mtimeMs(req.modelRoot) // container
    for (const e of deps.readDir(req.modelRoot)) {
      if (!e.isDirectory || !e.name.toLowerCase().endsWith('.3dshapes')) continue
      const dir = join(req.modelRoot, e.name)
      manifest[dir] = deps.mtimeMs(dir)
      const files = deps
        .readDir(dir)
        .filter((f) => !f.isDirectory && isModelFile(f.name))
        .map((f) => f.name)
      modelPackages.push({ pkg: e.name.replace(/\.3dshapes$/i, ''), dir, files, scope: 'system' })
    }
  }

  return {
    manifest,
    symbolFiles,
    footprintFiles,
    modelPackages,
    libraries,
    modelRoot: req.modelRoot
  }
}
