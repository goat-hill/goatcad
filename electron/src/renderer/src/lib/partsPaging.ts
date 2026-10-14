/**
 * Paging arithmetic for a distributor result set.
 *
 * Both APIs report a total — DigiKey's `ProductsCount`, Mouser's
 * `NumberOfResult` — and both take an offset, so a distributor mode can page
 * properly. **Universal cannot** and does not try: its rows are a merge of two
 * catalogs, so "page 2" is not a well-defined thing to ask either of them for.
 *
 * Totals here are enormous — a broad DigiKey category returns hundreds of
 * thousands — so the pager shows a window around the current page rather than
 * every page number, and the count line is what actually orients you.
 */

/** Rows per request. Capped at 50 because that is DigiKey's documented maximum
 *  per call; Mouser's `records` is the same order and is capped alongside it. */
export const PAGE_SIZES = [10, 20, 50] as const
export const MAX_PAGE_SIZE = 50
export const DEFAULT_PAGE_SIZE = 20

export const pageCount = (total: number, pageSize: number): number =>
  pageSize <= 0 ? 1 : Math.max(1, Math.ceil(total / pageSize))

/**
 * The 1-based span this page covers, for "Showing 1–20 of 892,356".
 *
 * `to` is clamped to the total so the last page reads honestly (…891–892,356,
 * not …891–892,360), and a page beyond the end reports an empty span rather
 * than negative numbers.
 */
export const pageRange = (
  page: number,
  pageSize: number,
  total: number
): { from: number; to: number } => {
  if (total <= 0) return { from: 0, to: 0 }
  const from = page * pageSize + 1
  if (from > total) return { from: 0, to: 0 }
  return { from, to: Math.min(total, (page + 1) * pageSize) }
}

/** A gap in the page list, rendered as an ellipsis. */
export const PAGE_GAP = 'gap' as const
export type PageSlot = number | typeof PAGE_GAP

/**
 * The page numbers to offer: always the first and last, plus a window around
 * the current page, with gaps marked.
 *
 * Pages are 0-based here and rendered 1-based. A gap is only emitted where it
 * actually saves space — replacing a single skipped page with an ellipsis costs
 * a click and saves nothing.
 */
export const pageWindow = (page: number, pages: number, span = 1): PageSlot[] => {
  if (pages <= 1) return [0]

  const wanted = new Set<number>([0, pages - 1])
  for (let offset = -span; offset <= span; offset++) {
    const candidate = page + offset
    if (candidate >= 0 && candidate < pages) wanted.add(candidate)
  }

  const sorted = [...wanted].sort((a, b) => a - b)
  const slots: PageSlot[] = []
  let previous: number | null = null
  for (const value of sorted) {
    if (previous !== null && value - previous > 1) {
      // One skipped page becomes that page, not an ellipsis hiding it.
      if (value - previous === 2) slots.push(previous + 1)
      else slots.push(PAGE_GAP)
    }
    slots.push(value)
    previous = value
  }
  return slots
}
