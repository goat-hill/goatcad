/**
 * The filter rail's model — **a modification to the search**, not a local sieve.
 *
 * An earlier version filtered the rows already fetched. That is instant and
 * free, but it can only narrow what the first page happened to contain: filter
 * to a manufacturer whose parts were not in the top twenty and you are told
 * there are none. So the rail edits the *request* instead, and the distributor
 * answers with the parts that actually match.
 *
 * The cost is that every change re-queries, against a ~1000-call day. Hence the
 * **pending/applied split** below: the rail edits a draft, the Apply button
 * commits it, and five checkboxes cost one request rather than five.
 *
 * Facet options are not derived here — they come from the distributor in each
 * response (`PartsFacets`), so the rail offers exactly what that result set can
 * be narrowed by, with its counts. Universal mode has none, since two catalogs'
 * facets cannot be merged without inventing a shared taxonomy.
 */
import type { PartFacetValue, PartsFilterState, PartsSearchMode } from '../../../preload/partsTypes'

export const emptyFilterState = (): PartsFilterState => ({
  inStock: false,
  rohs: false,
  hasDatasheet: false,
  has3dModel: false,
  manufacturerIds: [],
  packagingIds: [],
  statusIds: [],
  seriesIds: [],
  parameters: {}
})

export const isFilterActive = (state: PartsFilterState): boolean =>
  state.inStock ||
  state.rohs ||
  state.hasDatasheet ||
  state.has3dModel ||
  state.manufacturerIds.length > 0 ||
  state.packagingIds.length > 0 ||
  state.statusIds.length > 0 ||
  state.seriesIds.length > 0 ||
  Object.values(state.parameters).some((values) => values.length > 0)

/** Whether a draft differs from what is currently applied — drives Apply's
 *  enabled state, so the button never offers to re-run an identical search. */
export const filtersEqual = (a: PartsFilterState, b: PartsFilterState): boolean =>
  JSON.stringify(normalize(a)) === JSON.stringify(normalize(b))

/** Order within a multi-select is not meaningful; sorting makes equality
 *  reflect the request that would actually be sent. */
const normalize = (state: PartsFilterState): unknown => ({
  inStock: state.inStock,
  rohs: state.rohs,
  hasDatasheet: state.hasDatasheet,
  has3dModel: state.has3dModel,
  manufacturerIds: [...state.manufacturerIds].sort(),
  packagingIds: [...state.packagingIds].sort(),
  statusIds: [...state.statusIds].sort(),
  seriesIds: [...state.seriesIds].sort(),
  parameters: Object.fromEntries(
    Object.entries(state.parameters)
      .filter(([, values]) => values.length > 0)
      .map(([key, values]): [string, string[]] => [key, [...values].sort()])
      .sort((a, b) => a[0].localeCompare(b[0]))
  )
})

/**
 * A plain, structured-cloneable copy — required before this crosses IPC.
 *
 * `filters` is a `ref`, so reading `.value` hands back a Vue Proxy, and Electron
 * structured-clones every IPC argument. Passing it through rejects the invoke
 * with "An object could not be cloned" (RULES.md §9), which surfaces as a search
 * that returns nothing at all. Rebuilt field by field rather than spread,
 * because `parameters` is a nested object whose arrays are proxies too.
 */
export const toPlainFilters = (state: PartsFilterState): PartsFilterState => ({
  inStock: state.inStock,
  rohs: state.rohs,
  hasDatasheet: state.hasDatasheet,
  has3dModel: state.has3dModel,
  manufacturerIds: [...state.manufacturerIds],
  packagingIds: [...state.packagingIds],
  statusIds: [...state.statusIds],
  seriesIds: [...state.seriesIds],
  parameters: Object.fromEntries(
    Object.entries(state.parameters).map(([key, values]) => [Number(key), [...values]])
  )
})

/**
 * The options a group should offer for a local search term.
 *
 * A **selected** option always survives, even when it does not match: hiding a
 * ticked box is how someone applies a filter they can no longer see, and cannot
 * find to undo. Order is preserved, so a group does not reshuffle as you type.
 *
 * Local to the options list — it narrows what is *offered*, never what is
 * searched. Only Apply touches the request.
 */
export const matchFacetOptions = (
  options: readonly PartFacetValue[],
  search: string,
  selected: readonly string[]
): PartFacetValue[] => {
  const needle = search.trim().toLowerCase()
  if (!needle) return [...options]
  return options.filter(
    (option) => selected.includes(option.id) || option.label.toLowerCase().includes(needle)
  )
}

// ------------------------------------------------------------ applied chips

/** The multi-select dimensions a chip can come from. */
export type FacetDimension = 'manufacturerIds' | 'packagingIds' | 'statusIds' | 'seriesIds'

export const FACET_DIMENSIONS: FacetDimension[] = [
  'manufacturerIds',
  'packagingIds',
  'statusIds',
  'seriesIds'
]

/** Boolean filters, which need no captured label — their wording is ours. */
export type FilterFlag = 'inStock' | 'rohs' | 'hasDatasheet' | 'has3dModel'

export const FILTER_FLAGS: FilterFlag[] = ['inStock', 'rohs', 'hasDatasheet', 'has3dModel']

/**
 * Display text for selected ids, captured **when the box is ticked**.
 *
 * Not derivable later, and that is the whole point: facets are computed against
 * the current result set, so applying *Manufacturer = Texas Instruments* can
 * leave a response whose Manufacturer facet contains only that one value — or
 * none at all. A chip resolving its label from the live facets would then render
 * a bare `296` exactly when it is the only way left to remove the filter.
 */
export type FilterLabels = Record<string, { label: string; group?: string }>

export const labelKey = (scope: string, id: string): string => `${scope}:${id}`

export const parameterScope = (parameterId: number): string => `p${parameterId}`

export type AppliedChip =
  | { key: string; kind: 'flag'; flag: FilterFlag }
  | { key: string; kind: 'facet'; dimension: FacetDimension; id: string; label: string }
  | {
      key: string
      kind: 'parameter'
      parameterId: number
      id: string
      label: string
      group: string
    }

/**
 * Everything currently narrowing the search, as removable chips.
 *
 * Falls back to the raw id when no label was captured — a chip that reads `296`
 * is poor, but a filter you cannot see at all is worse.
 */
export const describeAppliedFilters = (
  state: PartsFilterState,
  labels: FilterLabels
): AppliedChip[] => {
  const chips: AppliedChip[] = []

  for (const flag of FILTER_FLAGS) {
    if (state[flag]) chips.push({ key: `flag:${flag}`, kind: 'flag', flag })
  }

  for (const dimension of FACET_DIMENSIONS) {
    for (const id of state[dimension]) {
      const key = labelKey(dimension, id)
      chips.push({ key, kind: 'facet', dimension, id, label: labels[key]?.label ?? id })
    }
  }

  for (const [rawId, values] of Object.entries(state.parameters)) {
    const parameterId = Number(rawId)
    for (const id of values) {
      const key = labelKey(parameterScope(parameterId), id)
      chips.push({
        key,
        kind: 'parameter',
        parameterId,
        id,
        label: labels[key]?.label ?? id,
        group: labels[key]?.group ?? ''
      })
    }
  }

  return chips
}

/** Take one chip back out of the draft. */
export const removeAppliedFilter = (
  state: PartsFilterState,
  chip: AppliedChip
): PartsFilterState => {
  if (chip.kind === 'flag') return { ...state, [chip.flag]: false }
  if (chip.kind === 'facet') {
    return { ...state, [chip.dimension]: state[chip.dimension].filter((id) => id !== chip.id) }
  }
  return { ...state, parameters: toggleParameter(state.parameters, chip.parameterId, chip.id) }
}

/** Add or remove one value from a multi-select dimension. */
export const toggleValue = <T>(values: readonly T[], value: T): T[] =>
  values.includes(value) ? values.filter((item) => item !== value) : [...values, value]

export const toggleParameter = (
  parameters: PartsFilterState['parameters'],
  parameterId: number,
  valueId: string
): PartsFilterState['parameters'] => {
  const next = toggleValue(parameters[parameterId] ?? [], valueId)
  const result = { ...parameters }
  if (next.length) result[parameterId] = next
  else delete result[parameterId]
  return result
}

/**
 * Which sections the rail may show for a mode.
 *
 * Universal is limited to the two switches **both** APIs implement — anything
 * else would apply to one distributor's results and silently not to the other's,
 * which is a filter that lies. Mouser's whole filter surface is those same two.
 * Only DigiKey has facets, so only DigiKey mode shows them.
 */
export const filterCapabilities = (
  mode: PartsSearchMode
): { basics: boolean; digikeyOptions: boolean; facets: boolean } => ({
  basics: true,
  digikeyOptions: mode === 'digikey',
  facets: mode === 'digikey'
})
