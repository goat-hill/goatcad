// Renderer-side library index client (see docs/libraries-workstream.md). Loads the
// records built in main, and searches them locally with the shared token matcher
// (utils/componentSearch) — instant type-ahead, no IPC per keystroke. Reverse
// association maps are derived on load. The open design's own libraries + embedded
// symbols are loaded separately (project scope) and unioned over the system/global
// records, the project copy winning on a lib_id clash; placed-component footprint
// assignments fold into the `footprintUsedBy` reverse map.

import { matchComponent, type SearchItem } from '../utils/componentSearch'
import type {
  IndexLibrary,
  IndexRecord,
  IndexType,
  IndexScope,
  SymbolRecord,
  FootprintRecord,
  ModelRecord
} from '../../../main/libraryIndexTypes'

export type {
  IndexLibrary,
  IndexRecord,
  IndexType,
  IndexScope,
  SymbolRecord,
  FootprintRecord,
  ModelRecord
}

let records: IndexRecord[] = []
/** The system/global libraries the index found, empty ones included. */
let libraries: IndexLibrary[] = []
let loaded = false
let inflight: Promise<void> | null = null

/**
 * Bumped whenever the records change or are invalidated. Consumers that cache
 * anything derived from the index compare it and refetch on next use — see
 * `markIndexStale` for why that is the mechanism rather than subscriptions
 * (docs/projects.md §9).
 */
let generation = 0

/** True when a change was announced but not yet reloaded. */
let stale = false

export const indexGeneration = (): number => generation

/**
 * Mark the loaded records out of date. The next `loadIndex()` refetches
 * instead of no-opping on its `loaded` flag, so an added library reaches
 * every consumer that loads once and caches, not only ones that subscribe to
 * `index:progress` directly.
 *
 * Invalidation is deliberately *pull*: consumers are told nothing, they simply
 * get fresh records the next time they ask. Pushing a rebuilt 40k-record index
 * into every window on every library change is the unbounded UI-thread work
 * RULES.md §8 forbids.
 */
export function markIndexStale(): void {
  stale = true
  generation++
}

/**
 * Subscribe the index to main's rebuild announcements, app-wide. Called once
 * per window; without it, only components that happen to subscribe themselves
 * would ever learn a rebuild finished.
 */
export function installIndexInvalidation(): () => void {
  return window.api.onIndexProgress((progress) => {
    if (progress.complete) markIndexStale()
  })
}

/**
 * Run `then` after each completed rebuild, the records already marked stale so
 * a `loadIndex()` inside it fetches the new ones — whichever of the window's
 * `index:progress` listeners main reaches first.
 */
export function onIndexRebuilt(then: () => void): () => void {
  return window.api.onIndexProgress((progress) => {
    if (!progress.complete) return
    markIndexStale()
    then()
  })
}

// Project scope — the open design's records + placed footprint assignments, held
// beside the system/global records and unioned at query time (project wins).
interface FootprintAssignment {
  symbol: string
  footprint: string
}
/** A registered project library, empty ones included — main's
 *  `ProjectLibraryRef`. The Project view lists these so a new empty library shows. */
export type ProjectLibraryRef = IndexLibrary
let projectRecords: IndexRecord[] = []
let projectAssignments: FootprintAssignment[] = []
let projectLibraries: ProjectLibraryRef[] = []
let combined: IndexRecord[] | null = null

/** Union project records over the system/global ones: a project copy (deduped by
 *  `(type, id)`, since a lib may be both table-registered and embedded) shadows a
 *  system/global record with the same identity — the design's own copy wins. */
export function unionRecords(sys: IndexRecord[], proj: IndexRecord[]): IndexRecord[] {
  const kept: IndexRecord[] = []
  const projKeys = new Set<string>()
  for (const r of proj) {
    const k = `${r.type}:${r.id}`
    if (projKeys.has(k)) continue
    projKeys.add(k)
    kept.push(r)
  }
  return sys.filter((r) => !projKeys.has(`${r.type}:${r.id}`)).concat(kept)
}

/** All records queried against (union, cached until either set reloads). */
function queryRecords(): IndexRecord[] {
  return (combined ??= unionRecords(records, projectRecords))
}

/**
 * The records search runs over, as one array whose identity changes exactly
 * when they do — the key for anything derived from them.
 */
export const indexSnapshot = (): readonly IndexRecord[] => queryRecords()

const warmers: Array<() => void> = []

/**
 * Derive something from the records after every load, while the window is
 * idle, so what an interaction reads is ready before it is asked for. The
 * library chooser's lists register here.
 */
export function addIndexWarmer(warm: () => void): void {
  warmers.push(warm)
  // Registered after a load (its module arrived later): warm now rather than at the next one.
  if (loaded) whenIdle(warm)
}

const whenIdle = (run: () => void): void => {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(run)
  else setTimeout(run, 0)
}

const scheduleWarm = (): void =>
  whenIdle(() => {
    for (const warm of warmers) warm()
  })

/** Load (or reload) the system/global index records from main. Deduped. */
export async function loadIndex(force = false): Promise<void> {
  if (loaded && !stale && !force) return
  if (!inflight) {
    // A change announced *during* the fetch must not be cleared by it — the
    // records in flight predate that change. Comparing generations keeps the
    // stale flag set so the next caller refetches.
    const startedAt = generation
    inflight = (async () => {
      const index = await window.api.getLibraryIndex()
      records = index.records
      libraries = index.libraries
      combined = null
      reverse = null // rebuild reverse maps lazily from the new records
      loaded = true
      if (generation === startedAt) stale = false
      scheduleWarm()
    })().finally(() => {
      inflight = null
    })
  }
  return inflight
}

/** Load (or reload) the project-scope index for the open design. `projectPath` is
 *  the project file or its directory; main memoizes per-project with mtime
 *  validation, so calling this after a schematic save is cheap when nothing moved. */
export async function loadProjectIndex(projectPath: string): Promise<void> {
  const res = await window.api.getProjectIndex(projectPath)
  projectRecords = res.records as IndexRecord[]
  projectAssignments = res.assignments ?? []
  projectLibraries = res.libraries ?? []
  combined = null
  reverse = null
  generation++
  scheduleWarm()
}

/** Drop project scope (e.g. the window closed its project). */
export function clearProjectIndex(): void {
  if (!projectRecords.length && !projectAssignments.length && !projectLibraries.length) return
  projectRecords = []
  projectAssignments = []
  projectLibraries = []
  combined = null
  reverse = null
  generation++
}

/** Registered project libraries (empty ones included), for the Project view. */
export const projectIndexLibraries = (): ProjectLibraryRef[] => projectLibraries

/** The searchable fields for a record, fed to matchComponent. */
function searchItem(r: IndexRecord): SearchItem {
  if (r.type === 'symbol')
    return { name: r.name, library: r.library, extraSearchTerms: [r.keywords, r.description] }
  if (r.type === 'footprint')
    return { name: r.name, library: r.library, extraSearchTerms: [r.tags, r.description] }
  return { name: r.name, library: r.library }
}

/** Does a single record match the query (token-based, via componentSearch)? */
export function recordMatches(query: string, r: IndexRecord): boolean {
  return matchComponent(query, searchItem(r))
}

export interface SearchOptions {
  types?: IndexType[]
  limit?: number
}

/** Records matching `query` (whitespace-tokenized, every token must match). */
export function search(query: string, opts: SearchOptions = {}): IndexRecord[] {
  const { types, limit } = opts
  const out: IndexRecord[] = []
  for (const r of queryRecords()) {
    if (types && !types.includes(r.type)) continue
    if (matchComponent(query, searchItem(r))) {
      out.push(r)
      if (limit && out.length >= limit) break
    }
  }
  return out
}

/** System + global records only. Project-tier records live in their own set —
 *  see `projectIndexRecords` — and are unioned in by `queryRecords` for search. */
export const indexRecords = (): IndexRecord[] => records

/**
 * The active project's own records: its `sym-lib-table` / `fp-lib-table`
 * libraries plus the symbols embedded in its documents.
 *
 * Separate accessor rather than a `scope` filter over `indexRecords()`, which
 * silently returns nothing for project scope — the two sets are stored apart so
 * either can reload without rebuilding the other.
 */
export const projectIndexRecords = (): IndexRecord[] => projectRecords
export const indexLoaded = (): boolean => loaded

// --- footprint filter matching (on-demand) ------------------------------------
// A generic symbol (e.g. Device:C) carries no single assigned footprint; instead
// its `ki_fp_filters` hold KiCad glob patterns (`C_*`, `Package_SO:SOIC*`) naming
// the footprints it *may* take. Rather than materialize a symbol→footprints map at
// index time (hundreds of footprints per generic part, most never viewed), we scan
// the footprint records on demand when a symbol view opens — a single O(N) pass
// per open, off the interaction hot path.

/** Compile a KiCad footprint-filter glob (`*`, `?`) to a case-insensitive regex. */
function globToRegExp(pattern: string): RegExp {
  const body = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^${body}$`, 'i')
}

/** Compile a symbol's `ki_fp_filters` into glob matchers. A pattern with a `:` is
 *  tested against a footprint's full lib_id, a bare one against its name — mirroring
 *  KiCad's filter semantics. Blank patterns dropped. */
function compileFpFilters(filters: string[]): { re: RegExp; scoped: boolean }[] {
  return filters.filter(Boolean).map((p) => ({ re: globToRegExp(p), scoped: p.includes(':') }))
}

/** Do any of a symbol's compiled filters match this footprint? */
function filtersMatchFootprint(
  globs: { re: RegExp; scoped: boolean }[],
  fp: FootprintRecord
): boolean {
  return globs.some((g) => g.re.test(g.scoped ? fp.id : fp.name))
}

/** A matcher for a symbol's `ki_fp_filters`, or null when it has none. */
export function footprintFilterMatcher(
  filters: string[]
): ((footprint: Pick<FootprintRecord, 'id' | 'name'>) => boolean) | null {
  const globs = compileFpFilters(filters)
  if (globs.length === 0) return null
  return (footprint) => globs.some((g) => g.re.test(g.scoped ? footprint.id : footprint.name))
}

/** Footprints whose name (or `library:name`) matches any of the symbol's
 *  `ki_fp_filters` globs. Empty `filters` → no matches. Name-sorted for a stable
 *  dropdown. Scans the footprint records on demand (one symbol view open). */
export function footprintsMatchingFilters(filters: string[]): FootprintRecord[] {
  const globs = compileFpFilters(filters)
  if (globs.length === 0) return []
  const out: FootprintRecord[] = []
  for (const r of queryRecords()) {
    if (r.type === 'footprint' && filtersMatchFootprint(globs, r)) out.push(r)
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

/** The reverse: symbols compatible with a given footprint — those whose
 *  `ki_fp_filters` globs match it. Generic footprints (`D_0402_1005Metric`) are
 *  assigned by no symbol's default Footprint yet accept many parts, so this
 *  complements `symbolsUsingFootprint`. Name-sorted; scans symbols on demand. */
export function symbolsMatchingFootprint(footprint: FootprintRecord): SymbolRecord[] {
  const out: SymbolRecord[] = []
  for (const r of queryRecords()) {
    if (r.type !== 'symbol' || r.fpFilters.length === 0) continue
    if (filtersMatchFootprint(compileFpFilters(r.fpFilters), footprint)) out.push(r)
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

// --- reverse associations (Phase 2) -------------------------------------------
// Forward refs are in the records (symbol → footprint, footprint → models);
// reverse maps are derived. Model refs use env-var paths while model records use
// absolute paths, so both normalize to `<pkg>.3dshapes/<basename>` (extension
// dropped so a footprint's `.wrl` ref matches the `.step` model and vice versa).

export function normalizeModelKey(p: string): string {
  const segs = p.split(/[\\/]/).filter(Boolean)
  return segs
    .slice(-2)
    .join('/')
    .replace(/\.(step|stp|wrl)$/i, '')
    .toLowerCase()
}

export interface ReverseMaps {
  /** normalized model key → footprints that reference it. */
  modelUsedBy: Map<string, FootprintRecord[]>
  /** footprint lib_id → symbols whose Footprint field assigns it. */
  footprintUsedBy: Map<string, SymbolRecord[]>
  /** footprint id → the indexed model records its `(model …)` refs resolve to.
   *  Raw refs (env-var paths) whose 3D package isn't indexed are dropped, so this
   *  is the single source of truth for "which of a footprint's models are actually
   *  viewable" — shared by the Libraries cube marker and the Component viewer.
   *  Derived (not a stored record field): resolution depends on the current model
   *  set, which changes without re-indexing footprints. Absent = none resolve. */
  footprintModels: Map<string, ModelRecord[]>
  /** id/key → record, so the Component view's lookups are O(1) instead of a
   *  linear scan of the whole index per resolve. */
  symbolById: Map<string, SymbolRecord>
  footprintById: Map<string, FootprintRecord>
  modelByKey: Map<string, ModelRecord>
  /** normalized model keys that reach a symbol (model → footprint → symbol). The
   *  only second-degree availability edge; the rest are direct `.has()` lookups. */
  modelsWithSymbol: Set<string>
}

export function buildReverseMaps(
  recs: IndexRecord[],
  assignments: { symbol: string; footprint: string }[] = []
): ReverseMaps {
  const modelUsedBy = new Map<string, FootprintRecord[]>()
  const footprintUsedBy = new Map<string, SymbolRecord[]>()
  const modelByKey = new Map<string, ModelRecord>()
  const symbolById = new Map<string, SymbolRecord>()
  const footprintById = new Map<string, FootprintRecord>()
  for (const r of recs) {
    if (r.type === 'model') {
      modelByKey.set(normalizeModelKey(r.file), r)
    } else if (r.type === 'footprint') {
      footprintById.set(r.id, r)
      for (const m of r.models) {
        const k = normalizeModelKey(m)
        const arr = modelUsedBy.get(k) ?? []
        arr.push(r)
        modelUsedBy.set(k, arr)
      }
    } else if (r.type === 'symbol') {
      symbolById.set(r.id, r)
      if (r.footprint) {
        const arr = footprintUsedBy.get(r.footprint) ?? []
        arr.push(r)
        footprintUsedBy.set(r.footprint, arr)
      }
    }
  }
  // Fold placed-component footprint assignments (project scope) into the reverse
  // map — the concrete, design-level "this footprint is used here" edges, keyed to
  // the placed symbol's (embedded) record.
  for (const a of assignments) {
    const s = symbolById.get(a.symbol)
    if (!s) continue
    const arr = footprintUsedBy.get(a.footprint) ?? []
    if (!arr.some((x) => x.id === s.id)) {
      arr.push(s)
      footprintUsedBy.set(a.footprint, arr)
    }
  }
  // Resolve each footprint's refs to indexed model records (dedup, order kept).
  const footprintModels = new Map<string, ModelRecord[]>()
  for (const [key, model] of modelByKey) {
    for (const fp of modelUsedBy.get(key) ?? []) {
      const arr = footprintModels.get(fp.id)
      if (arr) {
        if (!arr.some((m) => m.id === model.id)) arr.push(model)
      } else {
        footprintModels.set(fp.id, [model])
      }
    }
  }
  // Second-degree: a model reaches a symbol if any footprint referencing it is
  // itself assigned by a symbol (footprintUsedBy already folds in placements).
  const modelsWithSymbol = new Set<string>()
  for (const [key, fps] of modelUsedBy) {
    if (fps.some((fp) => footprintUsedBy.has(fp.id))) modelsWithSymbol.add(key)
  }
  return {
    modelUsedBy,
    footprintUsedBy,
    footprintModels,
    symbolById,
    footprintById,
    modelByKey,
    modelsWithSymbol
  }
}

let reverse: ReverseMaps | null = null
const ensureReverse = (): ReverseMaps =>
  (reverse ??= buildReverseMaps(queryRecords(), projectAssignments))

/** Pre-build the reverse/lookup maps so the first Component open doesn't pay the
 *  O(N) build synchronously mid-click. Call after the index loads, off the
 *  interaction path (e.g. requestIdleCallback); a no-op once warm. */
export function warmIndex(): void {
  void ensureReverse()
}
addIndexWarmer(warmIndex)

/** Footprints that reference a 3D model (by path). */
export function footprintsUsingModel(modelPath: string): FootprintRecord[] {
  return ensureReverse().modelUsedBy.get(normalizeModelKey(modelPath)) ?? []
}

/** Symbols whose Footprint field assigns a given footprint lib_id. */
export function symbolsUsingFootprint(footprintId: string): SymbolRecord[] {
  return ensureReverse().footprintUsedBy.get(footprintId) ?? []
}

/** The indexed model records a footprint's `(model …)` refs resolve to (may be
 *  empty). Built once with the reverse maps; O(1) per footprint. */
export function footprintModels(footprintId: string): ModelRecord[] {
  return ensureReverse().footprintModels.get(footprintId) ?? []
}

/** Does this footprint have any `(model …)` ref that resolves to an indexed model? */
export function footprintHasModel(footprintId: string): boolean {
  return ensureReverse().footprintModels.has(footprintId)
}

// --- availability edges (for the Libraries row indicators) --------------------
// Each answers "does the associated primitive exist?" — booleans, not lists — so
// a row can mark which of the other two types are present. All O(1). "Present"
// means a resolved/declared link (a symbol's default Footprint field, a
// footprint's embedded model ref), not "some compatible part could be paired".

/** Does this symbol's default Footprint field resolve to an indexed footprint? */
export function symbolHasFootprint(symbolId: string): boolean {
  const rev = ensureReverse()
  const s = rev.symbolById.get(symbolId)
  return !!s?.footprint && rev.footprintById.has(s.footprint)
}
/** Does this symbol reach a 3D model, through its default footprint? */
export function symbolHasModel(symbolId: string): boolean {
  const rev = ensureReverse()
  const s = rev.symbolById.get(symbolId)
  return !!s?.footprint && rev.footprintModels.has(s.footprint)
}
/** Does any symbol assign this footprint as its default Footprint? */
export function footprintHasSymbol(footprintId: string): boolean {
  return ensureReverse().footprintUsedBy.has(footprintId)
}
/** Is this model referenced by any indexed footprint? */
export function modelHasFootprint(modelPath: string): boolean {
  return ensureReverse().modelUsedBy.has(normalizeModelKey(modelPath))
}
/** Does this model reach a symbol (via a footprint that references it)? */
export function modelHasSymbol(modelPath: string): boolean {
  return ensureReverse().modelsWithSymbol.has(normalizeModelKey(modelPath))
}

// --- lookups (for the Component view's slot resolution; over the union) ---
// O(1) via the memoized id-maps rather than a linear scan of the whole index.
export const findSymbol = (id: string): SymbolRecord | undefined =>
  ensureReverse().symbolById.get(id)
export const findFootprint = (id: string): FootprintRecord | undefined =>
  ensureReverse().footprintById.get(id)

/** A record's file is a sheet when the symbol is a copy a schematic embeds. */
const isEmbeddedCopy = (record: IndexRecord): boolean => /\.kicad_sch$/i.test(record.file)

// Keyed on the union it was built beside: `combined` is replaced whenever either
// record set reloads, so an identity check is the invalidation.
let librarySymbols: { from: IndexRecord[]; byId: Map<string, SymbolRecord> } | null = null

/**
 * The library a symbol id is defined in, never a sheet's embedded copy of it.
 * `findSymbol` answers over the union, where a sheet's copy shadows its library
 * so the Component view shows the design's own; a loader that took that record
 * would parse the sheet as if it were the library — a copy that goes stale as
 * the sheet is edited, holds none of the library's other symbols, and makes the
 * library-mismatch check compare a sheet against itself.
 */
export const findLibrarySymbol = (id: string): SymbolRecord | undefined => {
  const from = queryRecords()
  if (librarySymbols?.from !== from) {
    const byId = new Map<string, SymbolRecord>()
    for (const record of [...records, ...projectRecords]) {
      if (record.type === 'symbol' && !isEmbeddedCopy(record)) byId.set(record.id, record)
    }
    librarySymbols = { from, byId }
  }
  return librarySymbols.byId.get(id)
}
/** Resolve a footprint's `(model …)` ref (env-var path) to an indexed model file. */
export const findModelByRef = (modelRef: string): ModelRecord | undefined =>
  ensureReverse().modelByKey.get(normalizeModelKey(modelRef))

// --- libraries (library › symbol or footprint) ---------------------------------
// What a design reaches, by nickname, each library holding its parts by name:
// `view.footprints.get('Capacitor_SMD')?.items.get('C_0402_1005Metric')`. A
// library is there exactly when the index found it, so the ERC and DRC library
// rules read this rather than the tables beside it, where one row can name a
// whole folder of libraries.

export interface IndexedLibrary<R extends IndexRecord> {
  library: IndexLibrary
  /** The library's parts by name — what a lib_id names after the colon. */
  items: ReadonlyMap<string, R>
}

export interface LibraryView {
  symbols: ReadonlyMap<string, IndexedLibrary<SymbolRecord>>
  footprints: ReadonlyMap<string, IndexedLibrary<FootprintRecord>>
}

/** A library's state as KiCad's checks tell them apart: no table has it, or one points at nothing. */
export const libraryState = (
  library: IndexedLibrary<IndexRecord> | undefined
): 'ok' | 'missing' | 'unreadable' =>
  !library ? 'missing' : library.library.readable ? 'ok' : 'unreadable'

/**
 * Libraries by nickname from one index set, over `under`'s: a library of the
 * set replaces one of the same nickname whole, as a project table's row
 * shadows a global one. A sheet's embedded copy of a symbol is not its library's.
 */
export function buildLibraryView(
  set: { libraries: readonly IndexLibrary[]; records: readonly IndexRecord[] },
  under?: LibraryView
): LibraryView {
  const symbols = new Map(under?.symbols)
  const footprints = new Map(under?.footprints)
  const ownSymbols = new Map<string, Map<string, SymbolRecord>>()
  const ownFootprints = new Map<string, Map<string, FootprintRecord>>()
  for (const library of set.libraries) {
    if (library.type === 'symbol') {
      const items = new Map<string, SymbolRecord>()
      ownSymbols.set(library.name, items)
      symbols.set(library.name, { library, items })
    } else {
      const items = new Map<string, FootprintRecord>()
      ownFootprints.set(library.name, items)
      footprints.set(library.name, { library, items })
    }
  }
  for (const record of set.records) {
    if (record.type === 'model' || isEmbeddedCopy(record)) continue
    const name = record.id.slice(record.library.length + 1)
    if (record.type === 'symbol') ownSymbols.get(record.library)?.set(name, record)
    else ownFootprints.get(record.library)?.set(name, record)
  }
  return { symbols, footprints }
}

let systemView: { from: IndexRecord[]; view: LibraryView } | null = null

/**
 * The libraries a design reaches: the app's, with its project's own over them.
 * The project is read for this answer alone, not loaded into the window's
 * index, which stays the open project's.
 */
export async function loadLibraryView(projectPath?: string | null): Promise<LibraryView> {
  await loadIndex()
  if (systemView?.from !== records)
    systemView = { from: records, view: buildLibraryView({ libraries, records }) }
  if (!projectPath) return systemView.view
  return buildLibraryView(await window.api.getProjectIndex(projectPath), systemView.view)
}
