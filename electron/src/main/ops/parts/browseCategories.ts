/**
 * `parts.browse_categories` — one level of DigiKey's own tree at a time.
 *
 * A category is what makes
 * parametric filtering possible at all, so this is the first step of the browse
 * path and the reason free-text-to-category was settled by probe and refused.
 */
import { defineOp } from '../registry'
import { s } from '../schema'
import { notFound, succeed } from '../errors'
import {
  BROWSE_PROVIDER,
  distributorFailure,
  findCategory,
  quotaSummary,
  requireBrowseProvider
} from './shared'

export const partsBrowseCategories = defineOp({
  name: 'parts.browse_categories',
  scope: 'app',
  mutates: false,
  summary: "Walk DigiKey's own category tree, one level at a time.",
  guidance:
    'Call with no argument for the top level, then with parentId to descend. Use it when you know the kind of part but not a part number: filters exist only within a category. DigiKey only. The tree is fetched once per session; descending costs no quota.',
  input: s.object({
    parentId: s
      .integer()
      .describe('Category id whose children to list; omit for the top level.')
      .optional()
  }),
  async run(args, ctx) {
    const guard = requireBrowseProvider(ctx)
    if (guard) return guard

    const result = await ctx.parts.categories(BROWSE_PROVIDER)
    if (!result.ok) return distributorFailure(ctx, result.error.kind, result.error.detail)

    const parentId = args.parentId ?? null
    const parent = parentId === null ? null : findCategory(result.value, parentId)
    if (parentId !== null && !parent) {
      return notFound(
        `No category with id ${parentId}.`,
        'Take ids from this tool; call parts_browse_categories with no argument for the top level.',
        { kind: 'unknown-category', data: { quota: quotaSummary(ctx.parts.usage()) } }
      )
    }

    const nodes = parent ? parent.children : result.value
    return succeed({
      parent: parent
        ? { id: parent.id, name: parent.name, productCount: parent.productCount }
        : null,
      categories: nodes.map((node) => ({
        id: node.id,
        name: node.name,
        productCount: node.productCount,
        hasChildren: node.children.length > 0
      })),
      next:
        nodes.length === 0
          ? 'A leaf category: call parts_list_filters with its id.'
          : 'Descend with parts_browse_categories(parentId), or call parts_list_filters on a leaf.',
      quota: quotaSummary(ctx.parts.usage())
    })
  }
})
