/**
 * What the library chooser lists, and in what order
 * (docs/libraries-workstream.md §3). Pure: the host builds the items from
 * the index and its own documents, and this ranks, filters and caps them, so a
 * keystroke materializes at most `cap` rows (RULES.md §8).
 */
import { matchComponent } from '../utils/componentSearch'

export type ChooserKind = 'symbol' | 'power' | 'footprint'

/** Where an item comes from, nearest first. */
export type ChooserScope = 'design' | 'project' | 'global' | 'system'

export interface ChooserItem {
  /** The lib id the pick answers with. */
  id: string
  name: string
  library: string
  description: string
  /** Keywords or tags, searched but not shown. */
  keywords: string
  scope: ChooserScope
  /** Distinct pins (symbol) or numbered pads (footprint); 0 when unknown. */
  count: number
  /** The library file, for the preview and Open. */
  file?: string
}

/** The groups pinned above the libraries. */
export type ChooserSection = 'design' | 'recent' | 'fits'

export interface ChooserRow {
  item: ChooserItem
  /** Fits the symbol being chosen for; null when nothing is being fitted. */
  fits: boolean | null
}

export interface ChooserOptions {
  query: string
  /** Lib ids the open design already uses. */
  inDesign: ReadonlySet<string>
  /** Recent picks of this kind, newest first. */
  recent: readonly string[]
  /** Whether a footprint fits the symbol being chosen for; absent when none is. */
  fit?: (item: ChooserItem) => boolean
}

/** One heading of the list — a pinned section or a library — and every match under it, in order. */
export interface ChooserGroup {
  /** `section:<section>` or `library:<nickname>`. */
  key: string
  section?: ChooserSection
  library?: string
  /** How many matched — known without ordering them. */
  count: number
  /** The matches in order, sorted on first ask: a shut group never pays for it. */
  rows(): ChooserRow[]
}

/** Exact name, then name prefix, then anywhere: what was typed should lead. */
const nameRank = (item: ChooserItem, needle: string): number => {
  if (!needle) return 0
  const name = item.name.toLowerCase()
  if (name === needle || item.id.toLowerCase() === needle) return 0
  if (name.startsWith(needle)) return 1
  return 2
}

// One collator for every comparison: `localeCompare` with options builds a new
// one per call, which over a full library is most of a chooser's open.
const collator = new Intl.Collator(undefined, { numeric: true })

export const byName = (a: ChooserItem, b: ChooserItem): number =>
  collator.compare(a.name, b.name) || collator.compare(a.id, b.id)

/**
 * Every match, grouped as KiCad's chooser groups them: what the design uses,
 * what was picked recently and (for a footprint) what fits the symbol, pinned,
 * then one group per library. A part in
 * a pinned group is in its library's too. With a query, the libraries holding
 * the best matches lead; without one they are alphabetical. The list renders
 * headings for every group and rows only for the open ones.
 */
export function chooseRows(items: readonly ChooserItem[], options: ChooserOptions): ChooserGroup[] {
  const needle = options.query.trim().toLowerCase()
  const recentRank = new Map(options.recent.map((id, index) => [id, index]))
  const design: ChooserRow[] = []
  const recent: ChooserRow[] = []
  const fitting: ChooserRow[] = []
  const libraries = new Map<string, { rows: ChooserRow[]; best: number }>()
  const rank = new Map<ChooserRow, number>()
  const seen = new Set<string>()
  for (const item of items) {
    if (seen.has(item.id)) continue
    const fits = options.fit ? options.fit(item) : null
    if (
      !matchComponent(options.query, {
        name: item.name,
        library: item.library,
        extraSearchTerms: [item.description, item.keywords]
      })
    )
      continue
    seen.add(item.id)
    const row: ChooserRow = { item, fits }
    const itemRank = nameRank(item, needle)
    rank.set(row, itemRank)
    if (options.inDesign.has(item.id)) design.push(row)
    if (recentRank.has(item.id)) recent.push(row)
    if (fits) fitting.push(row)
    const library = libraries.get(item.library)
    if (library) {
      library.rows.push(row)
      library.best = Math.min(library.best, itemRank)
    } else libraries.set(item.library, { rows: [row], best: itemRank })
  }
  const ranked = (a: ChooserRow, b: ChooserRow): number =>
    (rank.get(a) ?? 0) - (rank.get(b) ?? 0) || byName(a.item, b.item)
  const lazily = (rows: ChooserRow[], order: (a: ChooserRow, b: ChooserRow) => number) => {
    let sorted = false
    return (): ChooserRow[] => {
      if (!sorted) {
        rows.sort(order)
        sorted = true
      }
      return rows
    }
  }
  const groups: ChooserGroup[] = []
  const pinned = (section: ChooserSection, rows: ChooserRow[], order = ranked): void => {
    if (rows.length)
      groups.push({
        key: `section:${section}`,
        section,
        count: rows.length,
        rows: lazily(rows, order)
      })
  }
  pinned('design', design)
  pinned(
    'recent',
    recent,
    needle ? ranked : (a, b) => (recentRank.get(a.item.id) ?? 0) - (recentRank.get(b.item.id) ?? 0)
  )
  pinned('fits', fitting)
  const ordered = [...libraries.entries()].sort(
    ([a, left], [b, right]) => (needle ? left.best - right.best : 0) || collator.compare(a, b)
  )
  for (const [library, { rows }] of ordered)
    groups.push({
      key: `library:${library}`,
      library,
      count: rows.length,
      rows: lazily(rows, ranked)
    })
  return groups
}

/** Fits a symbol: its footprint filters match, where it has any, and the numbered pads are its pins. */
export function symbolFit(
  filter: ((item: ChooserItem) => boolean) | null,
  pinCount: number
): ((item: ChooserItem) => boolean) | undefined {
  if (!filter && pinCount === 0) return undefined
  return (item) => (!filter || filter(item)) && (pinCount === 0 || item.count === pinCount)
}

/** The recents list after a pick: newest first, deduplicated, bounded. */
export function withRecent(recent: readonly string[], id: string, limit = 12): string[] {
  return [id, ...recent.filter((entry) => entry !== id)].slice(0, limit)
}

/** A command's label as the chooser's title: the dialog is open, so its `…` has been kept. */
export const commandTitle = (label: string): string => label.replace(/\s*…$/, '')
