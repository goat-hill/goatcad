/**
 * Reading the footprint libraries as an agent — the footprint twin of
 * `partsMcpLibrary.ts`, and the same argument: the index is already built, this
 * only projects it, and the nicknames are the vocabulary. Pure: records in,
 * payloads out.
 *
 * A footprint record is a header scan (`libraryIndexExtract.ts`): name,
 * description, tags, a pad count and the model paths. Pads, the courtyard and
 * a model's placement need the real parser, which lives in the renderer, so
 * `footprint_get` is a design request and not a projection here.
 */
import type { FootprintRecord, IndexRecord, IndexScope } from './libraryIndexTypes'
import {
  LIBRARY_PAGE_DEFAULT,
  LIBRARY_PAGE_MAX,
  SEARCH_LIMIT_DEFAULT,
  SEARCH_LIMIT_MAX
} from './partsMcpLibrary'

const isFootprint = (record: IndexRecord): record is FootprintRecord => record.type === 'footprint'

/** Every term appears somewhere in the record — the rule `matchesSymbol` uses,
 *  over a footprint's fields. */
export const matchesFootprint = (query: string, record: FootprintRecord): boolean => {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return true
  const haystack = [
    record.id,
    record.id.replace(/_/g, ' '),
    record.library,
    record.library.replace(/_/g, ' '),
    record.description,
    record.tags
  ]
    .join(' ')
    .toLowerCase()
  return terms.every((term) => haystack.includes(term))
}

/** One listed footprint. `pads` is the cheapest check against a chosen part's
 *  package, as `pins` is for a symbol. */
export interface FootprintRow {
  libId: string
  description: string
  pads: number
  /** Present when the footprint references a 3D model. */
  models?: number
}

const toRow = (record: FootprintRecord): FootprintRow => ({
  libId: record.id,
  description: record.description,
  pads: record.pads,
  ...(record.models.length ? { models: record.models.length } : {})
})

export interface FootprintLibrarySummary {
  library: string
  scope: IndexScope
  footprints: number
}

export function listFootprintLibraries(records: IndexRecord[]): {
  libraries: FootprintLibrarySummary[]
  totalFootprints: number
  guidance: string
} {
  const byLibrary = new Map<string, FootprintLibrarySummary>()
  let totalFootprints = 0
  for (const record of records) {
    if (!isFootprint(record)) continue
    totalFootprints += 1
    const existing = byLibrary.get(record.library)
    if (existing) {
      existing.footprints += 1
      if (record.scope === 'project') existing.scope = 'project'
      continue
    }
    byLibrary.set(record.library, { library: record.library, scope: record.scope, footprints: 1 })
  }
  const rank: Record<IndexScope, number> = { project: 0, global: 1, system: 2 }
  const libraries = [...byLibrary.values()].sort(
    (a, b) => rank[a.scope] - rank[b.scope] || a.library.localeCompare(b.library)
  )
  return {
    libraries,
    totalFootprints,
    guidance:
      "Footprint library nicknames name a package family (Package_QFP, Resistor_SMD, Connector_USB), so the right one is usually recognisable from the part's package. Read one with footprint_list_library, then footprint_get for the pads and the courtyard before writing a Footprint field — a name that is not in a library is refused at placement."
  }
}

export interface FootprintLibraryPage {
  library: string
  scope: IndexScope | null
  footprints: FootprintRow[]
  total: number
  offset: number
  nextOffset: number | null
  error?: string
  didYouMean?: string[]
  guidance?: string
}

export function listFootprintLibrary(
  records: IndexRecord[],
  library: string,
  options: { offset?: number; limit?: number } = {}
): FootprintLibraryPage {
  const wanted = library.trim().toLowerCase()
  const matches = records.filter(
    (record): record is FootprintRecord =>
      isFootprint(record) && record.library.toLowerCase() === wanted
  )
  if (!matches.length) {
    const names = [...new Set(records.filter(isFootprint).map((record) => record.library))]
    const stem = wanted.split(/[_\s]/)[0] ?? wanted
    return {
      library,
      scope: null,
      footprints: [],
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
        'No footprint library has that nickname. Call footprint_list_libraries for the real names rather than trying variants.'
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
    footprints: page.map(toRow),
    total: sorted.length,
    offset,
    nextOffset: end < sorted.length ? end : null,
    ...(end < sorted.length
      ? {
          guidance: `${sorted.length - end} more footprints in this library. Page with offset=${end} only if none of these fit — the list is alphabetical, not ranked.`
        }
      : {})
  }
}

export interface FootprintSearch {
  query: string
  footprints: FootprintRow[]
  total: number
  truncated: boolean
  guidance?: string
}

export function searchFootprints(
  records: IndexRecord[],
  query: string,
  options: { limit?: number } = {}
): FootprintSearch {
  const limit = Math.min(
    SEARCH_LIMIT_MAX,
    Math.max(1, Math.trunc(options.limit ?? SEARCH_LIMIT_DEFAULT))
  )
  const hits = records
    .filter(isFootprint)
    .filter((record) => matchesFootprint(query, record))
    .sort((a, b) => a.id.localeCompare(b.id))
  const truncated = hits.length > limit
  return {
    query,
    footprints: hits.slice(0, limit).map(toRow),
    total: hits.length,
    truncated,
    guidance: !hits.length
      ? 'No footprint matches every term. This is a plain substring match over the name, description and tags — KiCad names packages by their standard (QFP-64_10x10mm_P0.5mm, SOT-23-5), so search the package name from the datasheet, or browse the likely library with footprint_list_library.'
      : truncated
        ? `${hits.length} footprints match; ${limit} are shown, unranked. Narrow the query with the pitch or the body size, or browse the library that owns them.`
        : undefined
  }
}
