/**
 * One page of an `items.query` answer, on every document: the rows from
 * `offset`, `truncated` when more match, and a capped answer's guidance naming
 * the narrowings the matches themselves offer (docs/MCP-STYLE.md, "A capped
 * list"). Each count is exactly what adding that filter would answer.
 */

/** Rows a query answers when the caller names no limit. */
export const QUERY_DEFAULT_LIMIT = 100

/** One filter's values over the matches, most common first, then by name. */
export type Tally = Array<[value: string, count: number]>

/** How many matches carry each value; an item with several values counts under each. */
export const tally = <T>(
  matches: readonly T[],
  valuesOf: (item: T) => readonly string[]
): Tally => {
  const counts = new Map<string, number>()
  for (const item of matches) {
    for (const value of new Set(valuesOf(item))) counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  return [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
  )
}

/** How many matches a filter keeps, per candidate value, for a filter that is not a plain field. */
export const tallyBy = <T>(
  matches: readonly T[],
  values: readonly string[],
  keeps: (item: T, value: string) => boolean
): Tally => tally(matches, (item) => values.filter((value) => keeps(item, value)))

const count = (n: number): string => n.toLocaleString('en-US')

const MAX_VALUES = 6

const listed = (entries: Tally): string => {
  const shown = entries.slice(0, MAX_VALUES).map(([value, n]) => `${value || '(none)'} ${count(n)}`)
  const rest = entries.length - MAX_VALUES
  return rest > 0 ? `${shown.join(', ')}, ${rest} more` : shown.join(', ')
}

/** A breakdown worth naming: a filter with at least two values among the matches. */
export interface Narrowing {
  /** The argument it narrows by, e.g. "layer". */
  arg: string
  values: Tally
  /** The value of another argument the breakdown is within, e.g. `kind "track"`. */
  within?: string
}

export interface QueryPage<T> {
  rows: T[]
  total: number
  offset: number
  truncated: boolean
}

/** The page of `matches` from `offset`, at most `limit` rows. */
export const pageOf = <T>(
  matches: readonly T[],
  offset = 0,
  limit = QUERY_DEFAULT_LIMIT
): QueryPage<T> => {
  const rows = matches.slice(offset, offset + limit)
  return { rows, total: matches.length, offset, truncated: offset + rows.length < matches.length }
}

/**
 * What a capped answer says: how many matched, the breakdowns among them, and
 * where the next page starts (pinned to `revision` when the document has one).
 */
export const cappedGuidance = (
  page: QueryPage<unknown>,
  narrowings: readonly Narrowing[],
  revision?: number
): string => {
  const end = page.offset + page.rows.length
  const parts = [
    `${count(page.total)} match; these are rows ${count(page.offset)} to ${count(end - 1)}.`
  ]
  for (const narrowing of narrowings) {
    if (narrowing.values.length < 2) continue
    const head = narrowing.within
      ? `${narrowing.within} by ${narrowing.arg}`
      : `By ${narrowing.arg}`
    parts.push(`${head}: ${listed(narrowing.values)}.`)
  }
  parts.push(
    `Narrow by one of these, or read on with offset ${end}${revision === undefined ? '' : ` and revision ${revision}`}.`
  )
  return parts.join(' ')
}

/**
 * The usual breakdowns: by kind when no kind was asked for, then the largest
 * kind (or the one asked for) by each further filter not already applied.
 */
export const narrowingsOf = <T extends { kind: string }>(
  matches: readonly T[],
  kindGiven: boolean,
  further: ReadonlyArray<{ arg: string; given: boolean; tally: (items: readonly T[]) => Tally }>
): Narrowing[] => {
  const out: Narrowing[] = []
  const kinds = tally(matches, (item) => [item.kind])
  if (!kindGiven && kinds.length > 1) out.push({ arg: 'kind', values: kinds })
  const focus = kinds[0]?.[0]
  if (focus === undefined) return out
  const within = matches.filter((item) => item.kind === focus)
  for (const filter of further) {
    if (filter.given) continue
    const values = filter.tally(within)
    if (values.length < 2) continue
    out.push({
      arg: filter.arg,
      values,
      within: `kind "${focus}" (${count(within.length)})`
    })
  }
  return out
}
