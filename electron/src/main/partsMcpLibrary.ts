/**
 * Reading the symbol library as an agent, not as a search box.
 *
 * Pure: records in, payloads out, no Electron and no `fs` — the index is already
 * built (`libraryIndex.ts`) and this only projects it. The index
 * itself is `docs/libraries-workstream.md`.
 *
 * **Why browse and not just search.** Measured against the standard libraries on
 * a KiCad 10 install: 22,784 symbols across 223 libraries. Returning them whole
 * is ~11.6 MB, and even stripped to `name` + `description` it is ~2.4 MB — past
 * any context window, for an answer nobody can read. But the 223 **library
 * nicknames** are 3.7 KB, and they are a real taxonomy rather than a file
 * listing: `MCU_ST_STM32L4`, `Regulator_Linear`, `Transistor_FET`. So the shape
 * is the one `parts_browse_categories` → `parts_list_filters` → `parts_search_category` already
 * uses on the distributor side, for the same reason: the agent reads the real
 * vocabulary instead of recalling one.
 *
 * The median library projects to 2.9 KB, and only three exceed 100 KB
 * (`Regulator_Linear`, `Converter_DCDC_Isolated`, `Regulator_Switching`), which
 * is why `listSymbolLibrary` pages rather than caps.
 */
import type { IndexRecord, IndexScope, SymbolRecord } from './libraryIndexTypes'

/** Rows per `listSymbolLibrary` page. Sized so the median library arrives whole
 *  and the three oversized ones arrive in two or three readable pages. */
export const LIBRARY_PAGE_DEFAULT = 400
export const LIBRARY_PAGE_MAX = 1000

export const SEARCH_LIMIT_DEFAULT = 40
export const SEARCH_LIMIT_MAX = 200

const isSymbol = (record: IndexRecord): record is SymbolRecord => record.type === 'symbol'

/**
 * Does every whitespace-separated term appear somewhere in the record?
 *
 * A deliberate twin of the renderer's `matchComponent` (`utils/componentSearch.ts`)
 * rather than an import: main does not reach into renderer code, and the two are
 * kept in step the way `resolveKiprjmod` and `resolveLibUri` are. Keep them the
 * same rule — an agent and the chooser disagreeing about what matches is a bug
 * report nobody can reproduce.
 */
export const matchesSymbol = (query: string, record: SymbolRecord): boolean => {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return true
  const haystack = [
    record.id,
    record.id.replace(/_/g, ' '),
    record.library,
    record.library.replace(/_/g, ' '),
    record.description,
    record.keywords
  ]
    .join(' ')
    .toLowerCase()
  return terms.every((term) => haystack.includes(term))
}

/** One listed symbol. `pins` is here because it is the cheapest check that a
 *  symbol matches a chosen part's package — see `libraryIndexTypes.ts`. */
export interface SymbolRow {
  libId: string
  description: string
  pins: number
  isPower?: true
}

const toRow = (record: SymbolRecord): SymbolRow => ({
  libId: record.id,
  description: record.description,
  pins: record.pins,
  // Present-or-absent rather than a boolean column: it is true for ~100 of
  // 22,784 rows, and `false` twenty thousand times is pure weight.
  ...(record.isPower ? { isPower: true as const } : {})
})

export interface LibrarySummary {
  library: string
  scope: IndexScope
  symbols: number
}

/**
 * Every symbol library, with how many symbols each holds.
 *
 * The entry point, and the one call an agent can afford unconditionally.
 * Project-scope libraries sort first because they are the design's own, and a
 * part that already exists in the project should never be re-authored.
 */
export function listSymbolLibraries(records: IndexRecord[]): {
  libraries: LibrarySummary[]
  totalSymbols: number
  guidance: string
} {
  const byLibrary = new Map<string, LibrarySummary>()
  let totalSymbols = 0
  for (const record of records) {
    if (!isSymbol(record)) continue
    totalSymbols += 1
    const existing = byLibrary.get(record.library)
    if (existing) {
      existing.symbols += 1
      // Project scope wins the label on a nickname clash, matching how the
      // renderer unions the scopes (`lib/libraryIndex.ts`).
      if (record.scope === 'project') existing.scope = 'project'
      continue
    }
    byLibrary.set(record.library, { library: record.library, scope: record.scope, symbols: 1 })
  }

  const rank: Record<IndexScope, number> = { project: 0, global: 1, system: 2 }
  const libraries = [...byLibrary.values()].sort(
    (a, b) => rank[a.scope] - rank[b.scope] || a.library.localeCompare(b.library)
  )

  return {
    libraries,
    totalSymbols,
    guidance:
      'Library nicknames are the vocabulary: they name a manufacturer family or a part class, so the right one is usually recognisable without searching. Read one with symbol_list_library before authoring anything — a symbol that already exists must never be re-drawn. Names alone are often not enough to choose between symbols in a library (Device:R vs Device:R_Small), which is why the listing carries descriptions.'
  }
}

export interface LibraryPage {
  library: string
  scope: IndexScope | null
  symbols: SymbolRow[]
  total: number
  offset: number
  /** Null when this page is the end of the library. */
  nextOffset: number | null
  error?: string
  didYouMean?: string[]
  guidance?: string
}

/**
 * One library, listed whole where it fits and paged where it does not.
 *
 * An unknown nickname answers with near-misses rather than an empty list: the
 * likely cause is a recalled name, and the fix is to show the real one.
 */
export function listSymbolLibrary(
  records: IndexRecord[],
  library: string,
  options: { offset?: number; limit?: number } = {}
): LibraryPage {
  const wanted = library.trim().toLowerCase()
  const matches = records.filter(
    (record): record is SymbolRecord => isSymbol(record) && record.library.toLowerCase() === wanted
  )

  if (!matches.length) {
    const names = [...new Set(records.filter(isSymbol).map((record) => record.library))]
    const stem = wanted.split(/[_\s]/)[0] ?? wanted
    return {
      library,
      scope: null,
      symbols: [],
      total: 0,
      offset: 0,
      nextOffset: null,
      error: 'unknown-library',
      didYouMean: names
        .filter((name) => {
          const lower = name.toLowerCase()
          return stem.length >= 2 && (lower.includes(stem) || wanted.includes(lower))
        })
        .slice(0, 12),
      guidance:
        'No library has that nickname. Call symbol_list_libraries for the real names rather than trying variants — the nickname is exact, and a near-miss is usually a remembered name rather than a missing library.'
    }
  }

  const offset = Math.max(0, Math.trunc(options.offset ?? 0))
  const limit = Math.min(
    LIBRARY_PAGE_MAX,
    Math.max(1, Math.trunc(options.limit ?? LIBRARY_PAGE_DEFAULT))
  )
  const sorted = matches.sort((a, b) => a.name.localeCompare(b.name))
  const page = sorted.slice(offset, offset + limit)
  const end = offset + page.length

  return {
    library: matches[0].library,
    scope: matches[0].scope,
    symbols: page.map(toRow),
    total: sorted.length,
    offset,
    nextOffset: end < sorted.length ? end : null,
    ...(end < sorted.length
      ? {
          guidance: `${sorted.length - end} more symbols in this library. Page with offset=${end} only if none of these fit — the list is alphabetical, not ranked, so a later page is not a better page.`
        }
      : {})
  }
}

export interface SymbolSearch {
  query: string
  symbols: SymbolRow[]
  total: number
  truncated: boolean
  guidance?: string
}

/**
 * Substring search across every library.
 *
 * The shortcut for when the lib_id or the MPN is already known — not the way to
 * explore. It is an unranked AND-of-substrings (that is what the chooser does,
 * and the two must agree), so a broad query returns a large flat set in
 * alphabetical order and the count is the only honest signal about it. Say so
 * rather than letting a hundred rows read as a shortlist.
 */
export function searchSymbols(
  records: IndexRecord[],
  query: string,
  options: { limit?: number; power?: boolean } = {}
): SymbolSearch {
  const limit = Math.min(
    SEARCH_LIMIT_MAX,
    Math.max(1, Math.trunc(options.limit ?? SEARCH_LIMIT_DEFAULT))
  )
  const hits = records
    .filter(isSymbol)
    .filter((record) => (options.power === undefined ? true : record.isPower === options.power))
    .filter((record) => matchesSymbol(query, record))
    .sort((a, b) => a.id.localeCompare(b.id))

  const truncated = hits.length > limit
  return {
    query,
    symbols: hits.slice(0, limit).map(toRow),
    total: hits.length,
    truncated,
    guidance: !hits.length
      ? 'No symbol matches every term. This search is a plain substring match with no ranking or synonyms, so it fails on wording rather than on absence — and some facts are simply not in the library at all: a crystal carries no frequency (Device:Crystal is "Two pin crystal"; the frequency is the Value you set when placing it), and a generic passive carries no value. Drop terms, or browse the likely library with symbol_list_library.'
      : truncated
        ? `${hits.length} symbols match; ${limit} are shown. These results are unranked, so the shown ones are not the best ones — narrow the query or browse the library that owns them.`
        : undefined
  }
}
