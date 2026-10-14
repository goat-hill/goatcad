/**
 * `parts.search_category` — the verb that answers "I need a part that does X".
 *
 * The refusal is the feature:
 * an id this category does not offer is rejected rather than dropped, because a
 * dropped filter returns a broader result set that looks like a successful
 * narrow, and that is invisible from the outside.
 */
import type { PartsSort } from '../../../preload/partsTypes'
import { PROVIDER_INFO } from '../../partsProviders'
import { defineOp } from '../registry'
import { s } from '../schema'
import { refused, succeed } from '../errors'
import {
  BROWSE_PROVIDER,
  buildFilters,
  distributorFailure,
  partColumnsArg,
  partRow,
  quotaSummary,
  rememberVocabulary,
  requireBrowseProvider,
  SORT_FIELDS
} from './shared'

export const partsSearchCategory = defineOp({
  name: 'parts.search_category',
  scope: 'app',
  mutates: false,
  summary: 'Search one DigiKey category with parametric filters, to find a part by specification.',
  guidance:
    'Call parts_list_filters first: ids come from there, and one the category does not offer is refused at no quota cost. Filter by inStock and hasDatasheet routinely. has3dModel means only that the distributor lists a model; these tools cannot fetch it, so do not choose a part by it.',
  input: s.object({
    categoryId: s.integer().describe('Category id from parts_browse_categories.'),
    keyword: s.string().trim().describe('Keyword within the category.').optional(),
    filters: s
      .object({
        inStock: s.boolean().optional(),
        rohs: s.boolean().optional(),
        hasDatasheet: s.boolean().optional(),
        has3dModel: s.boolean().optional(),
        manufacturerIds: s.array(s.string()).optional(),
        packagingIds: s.array(s.string()).optional(),
        statusIds: s.array(s.string()).optional(),
        seriesIds: s.array(s.string()).optional(),
        parameters: s.record(s.array(s.string())).optional()
      })
      .describe('Filters; parameters maps a parameterId to its valueIds, from parts_list_filters.')
      .optional(),
    sort: s
      .object({
        field: s.enum(SORT_FIELDS),
        order: s.enum(['asc', 'desc'] as const).optional()
      })
      .optional(),
    qty: s
      .integer()
      .min(1)
      .describe("Build quantity, selecting each offer's priceAtQty. Default 1.")
      .optional(),
    limit: s.integer().min(1).max(50).optional(),
    offset: s.integer().min(0).optional(),
    columns: partColumnsArg
  }),
  async run(args, ctx) {
    const guard = requireBrowseProvider(ctx)
    if (guard) return guard

    const built = buildFilters(args.filters, args.categoryId)
    if (!built.ok) {
      // Loudly, and without spending a call: a refused filter that cost quota
      // would punish the agent twice for one recoverable mistake.
      return refused(
        built.reason,
        `Call parts_list_filters(${args.categoryId}) and use the ids it returns.`,
        {
          kind: 'invalid-filter'
        }
      )
    }

    const sort: PartsSort | null = args.sort
      ? { field: args.sort.field, order: args.sort.order === 'desc' ? 'desc' : 'asc' }
      : null

    const qty = args.qty ?? 1
    const offset = args.offset ?? 0
    const keyword = args.keyword ?? ''

    const result = await ctx.parts.search(
      BROWSE_PROVIDER,
      keyword,
      args.limit,
      offset,
      args.categoryId,
      built.filters,
      sort
    )
    if (!result.ok) return distributorFailure(ctx, result.error.kind, result.error.detail)

    // Facets come back narrowed by what was just applied, so this keeps the
    // vocabulary fresh for the next call without spending another request.
    rememberVocabulary(args.categoryId, result.value)

    return succeed({
      categoryId: args.categoryId,
      distributor: PROVIDER_INFO[BROWSE_PROVIDER].name,
      total: result.value.total,
      count: result.value.parts.length,
      offset,
      qty,
      parts: result.value.parts.map((record) => partRow(record, qty, args.columns)),
      narrowedBy: result.value.facets.parametric.map((facet) => ({
        parameterId: facet.parameterId,
        name: facet.name,
        remainingValues: facet.values.length
      })),
      note:
        result.value.total > result.value.parts.length
          ? `${result.value.total} products match. Narrow with parts_list_filters values rather than paging.`
          : null,
      quota: quotaSummary(ctx.parts.usage())
    })
  }
})
