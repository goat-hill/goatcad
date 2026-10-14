/**
 * Which columns the results table shows, and which of them sort.
 *
 * **The category is what makes a parametric table possible.** DigiKey returns no
 * `ParametricFilters` for a bare keyword search and 16 of them for Ceramic
 * Capacitors, so the columns are its own statement of what
 * describes parts in *this* category — ordered by it, not invented by us. That
 * is the same reasoning that refuses a cross-provider spec mapping: we
 * show a distributor's vocabulary, we do not author one.
 *
 * Which is why Universal and Mouser get the fixed columns only. Two catalogs'
 * parameters cannot be merged without inventing a cross-provider mapping, and
 * Mouser publishes no parametric data at all — so their absence is a fact about
 * those modes rather than a gap in the table.
 *
 * Cells are joined to columns by `parameterId`, never by display name: the facet
 * list and the product's own parameters are two payloads that happen to be
 * spelled alike, and matching text would break the day one of them is retitled.
 */
import type {
  PartGroup,
  PartsFacets,
  PartsSearchMode,
  PartsSortField
} from '../../../preload/partsTypes'

/** A fixed column's identity. Parametric columns are keyed `p:<parameterId>`. */
export type FixedColumnKey = 'part' | 'status' | 'seller' | 'stock' | 'price'

export interface PartsColumn {
  key: string
  /** Parametric columns carry the distributor's own label, which is not ours to
   *  translate. Fixed columns resolve their text from the locale file instead. */
  label: string | null
  parameterId: number | null
  /**
   * The API fields this column can be ordered by — usually one, none for a
   * column the API will not sort. More than one because `part` stacks the part
   * number, manufacturer and description in a single cell to save width, and two
   * of those three are independently sortable; its heading offers both rather
   * than picking one and quietly dropping the other.
   *
   * Empty is permanent for parametric columns: DigiKey rejects `Parameter` as a
   * sort field, and ordering a page locally would rank twenty rows against a
   * six-figure total.
   */
  sorts: PartsSortField[]
}

/**
 * Which heading a sort control borrows its text from. The button says what it
 * orders by, which is not always the column's own name — the `part` column has
 * two.
 */
export const SORT_LABEL_KEY: Record<PartsSortField, string> = {
  ManufacturerProductNumber: 'mpn',
  Manufacturer: 'manufacturer',
  ProductStatus: 'status',
  QuantityAvailable: 'stock',
  Price: 'price',
  Packaging: 'packaging',
  Supplier: 'seller'
}

/**
 * The columns every mode shows.
 *
 * `seller`, `stock` and `price` are per-distributor, and in Universal a row can
 * carry two of each. They are never merged into a single figure: the agreements
 * forbid blending one distributor's data with a competitor's without distinction,
 * and a lone "best price" would mislead anyway, since offers differ in
 * minimum quantity and packaging.
 *
 * **This order is the header order and the cell order.** `PartsView` writes these
 * cells out one by one rather than looping — each renders differently enough that
 * a loop would be a switch statement in a template — so reordering here without
 * reordering there silently puts every value under the wrong heading. The test
 * beside this file pins the sequence; the template names it in a comment.
 *
 * `part` carries the part number, manufacturer and description stacked as three
 * lines. They are a single column because width is the scarce resource once a
 * category contributes a dozen parametric columns, and because those three are
 * one fact — which part this is — read together rather than compared down the
 * page the way a specification is.
 */
export const FIXED_COLUMNS: PartsColumn[] = [
  // Sorts by part number only. The cell stacks the manufacturer too, but a
  // heading that listed every sortable line would be two rows of controls over
  // a column that is already three rows of text.
  { key: 'part', label: null, parameterId: null, sorts: ['ManufacturerProductNumber'] },
  { key: 'status', label: null, parameterId: null, sorts: ['ProductStatus'] },
  { key: 'seller', label: null, parameterId: null, sorts: [] },
  { key: 'stock', label: null, parameterId: null, sorts: ['QuantityAvailable'] },
  { key: 'price', label: null, parameterId: null, sorts: ['Price'] }
]

/** A row's value for one parameter, or '' when it does not report that one. */
export const parameterValue = (group: PartGroup, parameterId: number): string => {
  for (const source of group.sources) {
    const hit = source.record.parameters.find((parameter) => parameter.parameterId === parameterId)
    if (hit) return hit.value
  }
  return ''
}

/**
 * Parametric columns for the current result set, in the distributor's order.
 *
 * A column whose value is the same on every row is dropped — the column analog
 * of a facet that cannot narrow. With sixteen candidates competing for width,
 * one that reads identically all the way down costs a scroll and distinguishes
 * nothing. Nothing is lost by it: expanding a row still lists every parameter
 * that part reports, which is where a value common to the whole page belongs.
 */
export const parametricColumns = (
  mode: PartsSearchMode,
  facets: PartsFacets,
  groups: PartGroup[]
): PartsColumn[] => {
  if (mode !== 'digikey') return []
  return facets.parametric
    .filter((facet) => {
      const seen = new Set<string>()
      for (const group of groups) {
        const value = parameterValue(group, facet.parameterId)
        if (value) seen.add(value)
        if (seen.size > 1) return true
      }
      return false
    })
    .map((facet) => ({
      key: `p:${facet.parameterId}`,
      label: facet.name,
      parameterId: facet.parameterId,
      sorts: []
    }))
}

/** Every column, fixed first — the part's identity before its specifications. */
export const tableColumns = (
  mode: PartsSearchMode,
  facets: PartsFacets,
  groups: PartGroup[]
): PartsColumn[] => [...FIXED_COLUMNS, ...parametricColumns(mode, facets, groups)]

/**
 * Clicking a sortable header: ascending, then descending, then back to the
 * distributor's own ordering. The third state is not decoration — `SortField`
 * has no relevance member, so the only way back to relevance is to stop sending
 * a sort at all, and without this the first click would be irreversible.
 */
export const nextSort = (
  current: { field: PartsSortField; order: 'asc' | 'desc' } | null,
  field: PartsSortField
): { field: PartsSortField; order: 'asc' | 'desc' } | null => {
  if (!current || current.field !== field) return { field, order: 'asc' }
  if (current.order === 'asc') return { field, order: 'desc' }
  return null
}
