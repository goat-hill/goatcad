// Bounded search collection for the Libraries navigator (LibraryNavigator.vue).
//
// A broad query ("C") matches essentially the whole library index — tens of
// thousands of records. The navigator auto-expands every container while a query
// is active, so without a bound that would mount tens of thousands of DOM rows in
// one synchronous pass and freeze the UI thread. We instead collect matches per
// container, in render order, under a per-primitive-type budget: the rendered
// result — and the match work behind it — can never grow unbounded with the
// number of hits. Past the cap the navigator shows a "refine your search" note.
//
// Design principle (see RULES.md §8): a single user interaction must
// never do unbounded, input-blocking work on the renderer's main thread.

/** Max leaves rendered per primitive type (symbol / footprint / model) while a
 *  query is active. System and user libraries of one type share the budget. */
export const NAV_RESULT_CAP = 300

export interface CapBudget {
  remaining: number
  capped: boolean
}

export const newBudget = (cap = NAV_RESULT_CAP): CapBudget => ({ remaining: cap, capped: false })

/**
 * Collect matching items grouped by container, visiting containers in `order` and
 * items in each container's natural order, stopping once the shared `budget` is
 * exhausted (which marks it `capped`). Containers with no matched item are
 * omitted. `budget` is passed in so several sections (e.g. system + user symbol
 * libraries) can share one primitive-type cap; call `newBudget()` per type.
 */
export function collectCapped<T>(
  budget: CapBudget,
  order: string[],
  itemsOf: (key: string) => T[],
  matches: (item: T) => boolean
): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const key of order) {
    // Once the budget is spent, no later container can contribute a leaf — stop
    // scanning entirely rather than walking the rest of the index for nothing.
    if (budget.remaining <= 0) {
      budget.capped = true
      break
    }
    const matched: T[] = []
    for (const item of itemsOf(key)) {
      if (!matches(item)) continue
      if (budget.remaining <= 0) {
        budget.capped = true
        break
      }
      matched.push(item)
      budget.remaining--
    }
    if (matched.length) groups.set(key, matched)
  }
  return groups
}
