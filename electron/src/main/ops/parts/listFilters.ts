/**
 * `parts.list_filters` — the half of the handshake that hands out vocabulary.
 *
 * The ids returned here are the
 * only ones `parts_search_category` accepts, and that is enforced rather than
 * documented: a filter the distributor never offered would be dropped at the API
 * and come back as a broader result set that looks like a successful narrow.
 */
import { defineOp } from '../registry'
import { s } from '../schema'
import { succeed } from '../errors'
import {
  BROWSE_PROVIDER,
  distributorFailure,
  quotaSummary,
  rememberVocabulary,
  requireBrowseProvider
} from './shared'

export const partsListFilters = defineOp({
  name: 'parts.list_filters',
  scope: 'app',
  mutates: false,
  summary: "List a DigiKey category's filter parameters and values, each with its product count.",
  guidance:
    'Call before parts_search_category: it accepts only the ids returned here, and refuses any other. Product counts show which choice would narrow to nothing.',
  input: s.object({
    categoryId: s.integer().describe('Category id from parts_browse_categories.')
  }),
  async run(args, ctx) {
    const guard = requireBrowseProvider(ctx)
    if (guard) return guard

    // One row: we want the facets, not the products. The rows come back either
    // way — a distributor charges per request, not per result — so asking for
    // fewer is only politeness, and the facets describe the whole category.
    const result = await ctx.parts.search(BROWSE_PROVIDER, '', 1, 0, args.categoryId)
    if (!result.ok) return distributorFailure(ctx, result.error.kind, result.error.detail)

    rememberVocabulary(args.categoryId, result.value)

    return succeed({
      categoryId: args.categoryId,
      totalProducts: result.value.total,
      parameters: result.value.facets.parametric.map((facet) => ({
        parameterId: facet.parameterId,
        name: facet.name,
        values: facet.values.map((value) => ({
          valueId: value.id,
          label: value.label,
          productCount: value.productCount
        }))
      })),
      manufacturers: result.value.facets.manufacturers.map((value) => ({
        id: value.id,
        label: value.label,
        productCount: value.productCount
      })),
      packaging: result.value.facets.packaging.map((value) => ({
        id: value.id,
        label: value.label
      })),
      status: result.value.facets.status.map((value) => ({ id: value.id, label: value.label })),
      series: result.value.facets.series.map((value) => ({ id: value.id, label: value.label })),
      next: 'Pass parameterId → [valueId] to parts_search_category, ids exactly as given.',
      quota: quotaSummary(ctx.parts.usage())
    })
  }
})
