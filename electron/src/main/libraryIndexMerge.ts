// Incremental invalidation for the system/global index (see libraries-workstream.md §2)
// — pure functions, unit-tested. On launch, rather than throwing the
// whole cache away on any manifest mismatch, main diffs the freshly-scanned
// manifest against the cached one, reparses ONLY the changed/added units in the
// worker, and merges those records over the ones it keeps.
//
// A record maps to exactly one merge *unit*: a symbol → its `.kicad_sym` file; a
// footprint → its `.pretty` directory (`dirname(file)`, whether the manifest
// tracked it coarsely or per-file); a model → its `.3dshapes` directory
// (`dirname(file)`). 3D is handled wholesale (a package is cheap to re-walk and
// carries no per-file manifest), so any model-unit change reparses every package.

import { dirname } from 'path'
import type { BuildRequest, ScanResult } from './libraryIndexScan'
import type { IndexRecord } from './libraryIndexTypes'

export interface ManifestDiff {
  /** Units present in both manifests whose mtime differs. */
  changed: string[]
  /** Units in the cached manifest that no longer resolve. */
  removed: string[]
  /** Units resolvable now but absent from the cached manifest. */
  added: string[]
}

export function computeManifestDiff(
  oldManifest: Record<string, number>,
  newManifest: Record<string, number>
): ManifestDiff {
  const changed: string[] = []
  const removed: string[] = []
  const added: string[] = []
  for (const [unit, mtime] of Object.entries(oldManifest)) {
    if (!(unit in newManifest)) removed.push(unit)
    else if (newManifest[unit] !== mtime) changed.push(unit)
  }
  for (const unit of Object.keys(newManifest)) {
    if (!(unit in oldManifest)) added.push(unit)
  }
  return { changed, removed, added }
}

export const diffIsEmpty = (d: ManifestDiff): boolean =>
  d.changed.length === 0 && d.removed.length === 0 && d.added.length === 0

/** A `.3dshapes` package directory — models are diffed at this granularity. */
const isModelKey = (key: string): boolean => /\.3dshapes$/i.test(key)

/** The merge/reparse unit a manifest key belongs to, or null for a container
 *  root (a parent footprint dir or the model root — its child add/remove is
 *  separately keyed, so the container key drives nothing on its own). */
export function reparseUnitForKey(key: string): string | null {
  if (/\.kicad_sym$/i.test(key)) return key // symbol unit = the file
  if (/\.kicad_mod$/i.test(key)) return dirname(key) // fine-grained footprint → its `.pretty`
  if (/\.pretty$/i.test(key)) return key // coarse footprint unit = the `.pretty` dir
  return null // container root — ignored (children carry the signal)
}

/** The merge unit a record belongs to (see module header). Model records are not
 *  keyed here — they are handled wholesale via `modelDirty`. */
export function recordUnit(r: IndexRecord): string {
  return r.type === 'symbol' ? r.file : dirname(r.file)
}

const anyModelDirty = (d: ManifestDiff): boolean =>
  [...d.changed, ...d.removed, ...d.added].some(isModelKey)

/**
 * The partial `BuildRequest` covering only the changed ∪ added units, drawn from
 * the fresh full scan so scope/nickname/fineGrained come along. Symbols are
 * file-granular; footprints reparse the whole affected `.pretty`; models reparse
 * every package when any package changed (else are skipped).
 */
export function planPartialBuild(diff: ManifestDiff, scan: ScanResult): BuildRequest {
  const wanted = new Set<string>()
  for (const key of [...diff.changed, ...diff.added]) {
    if (isModelKey(key)) continue
    const unit = reparseUnitForKey(key)
    if (unit) wanted.add(unit)
  }

  const symbolFiles = scan.symbolFiles.filter((s) => wanted.has(s.file))

  const rootByDir = new Map<
    string,
    { nickname: string; dir: string; scope: IndexRecord['scope']; fineGrained: boolean }
  >()
  for (const fp of scan.footprintFiles) {
    if (!wanted.has(fp.dir) || rootByDir.has(fp.dir)) continue
    rootByDir.set(fp.dir, {
      nickname: fp.library,
      dir: fp.dir,
      scope: fp.scope,
      fineGrained: fp.fineGrained
    })
  }

  return {
    symbolFiles,
    footprintRoots: [...rootByDir.values()],
    modelRoot: anyModelDirty(diff) ? (scan.modelRoot ?? null) : null
  }
}

/**
 * Merge freshly-reparsed records over the kept ones: drop every old record whose
 * unit was changed or removed (and every model record when any package changed),
 * then append the fresh records. Pure — the caller pairs the new full manifest
 * with the returned records.
 */
export function mergeIndex(
  oldRecords: IndexRecord[],
  freshRecords: IndexRecord[],
  diff: ManifestDiff
): IndexRecord[] {
  const modelDirty = anyModelDirty(diff)
  const dropped = new Set<string>()
  for (const key of [...diff.changed, ...diff.removed]) {
    if (isModelKey(key)) continue
    const unit = reparseUnitForKey(key)
    if (unit) dropped.add(unit)
  }
  const kept = oldRecords.filter((r) =>
    r.type === 'model' ? !modelDirty : !dropped.has(recordUnit(r))
  )
  return kept.concat(freshRecords)
}
