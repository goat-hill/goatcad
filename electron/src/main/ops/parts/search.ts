/**
 * `parts.search` — one distributor's catalog, by keyword or MPN.
 *
 * One distributor per call, its rows as it gives them. Merging catalogs needs
 * guesses (whose maker name, which offer, how to split a limit), and those are
 * the caller's. Comparing one known part across distributors is
 * `parts.compare_mpn`.
 *
 * One op serves both catalogs because their keyword APIs take the same
 * request: a keyword, a row count up to 50, a starting row, and in-stock and
 * RoHS switches. DigiKey's further filters and sorting need a category, which
 * is `parts.search_category`.
 */
import { emptyFilterState, PROVIDER_IDS, PROVIDER_INFO } from '../../partsProviders'
import { defineOp } from '../registry'
import { s } from '../schema'
import { refused, succeed } from '../errors'
import { distributorFailure, noCredentials, partColumnsArg, partRow, quotaSummary } from './shared'

export const partsSearch = defineOp({
  name: 'parts.search',
  scope: 'app',
  mutates: false,
  summary: "Search one distributor's catalog by keyword or manufacturer part number.",
  guidance:
    'Rows come in the distributor\'s order, each with every offer it lists (DigiKey: one per packaging), with minimum, stock and price breaks. Catalogs match names, not descriptions: a family ("SHT40") or kind plus value ("10k 0402") shows the variants; a sentence returns nothing. Distributor order codes match too; check the manufacturer. To check one MPN at every distributor use parts_compare_mpn; for a specification search, parts_search_category (DigiKey). Pass qty for the price at build quantity.',
  input: s.object({
    distributor: s.enum(PROVIDER_IDS).describe('Catalog to search, from parts_status.'),
    query: s
      .string()
      .trim()
      .describe('Family name, kind plus value, or MPN: "SHT40", "10k 0402", "STM32F405RGT6".'),
    inStock: s
      .boolean()
      .describe('Only rows the distributor has in stock. Default false.')
      .optional(),
    rohs: s.boolean().describe('Only RoHS-compliant rows. Default false.').optional(),
    qty: s
      .integer()
      .min(1)
      .describe("Build quantity, selecting each offer's priceAtQty. Default 1.")
      .optional(),
    limit: s
      .integer()
      .min(1)
      .max(50)
      .describe('Rows to return from this distributor. Default 20.')
      .optional(),
    offset: s.integer().min(0).describe('Rows to skip, to page. Default 0.').optional(),
    columns: partColumnsArg
  }),
  examples: [
    { args: { distributor: 'digikey', query: 'SHT40', qty: 25 }, note: 'a family at DigiKey' },
    {
      args: { distributor: 'mouser', query: '10k 0402', inStock: true, limit: 10 },
      note: 'stocked passives at Mouser'
    },
    {
      args: {
        distributor: 'digikey',
        query: 'TPS62130',
        columns: ['description', 'offers.packaging', 'offers.stock', 'offers.priceAtQty']
      },
      note: 'only the columns needed'
    }
  ],
  async run(args, ctx) {
    if (!args.query) {
      return refused(
        'query is required and must not be empty.',
        'Pass a keyword or MPN, e.g. { distributor: "digikey", query: "STM32F405RGT6" }.'
      )
    }
    const provider = args.distributor
    const configured = ctx.parts
      .credentialStatus()
      .some((status) => status.provider === provider && status.configured)
    if (!configured) return noCredentials(ctx, provider)

    const qty = args.qty ?? 1
    const offset = args.offset ?? 0
    // No filters object when unfiltered, so the cache key matches other unfiltered lookups (parts_compare_mpn's).
    const filters =
      args.inStock || args.rohs
        ? { ...emptyFilterState(), inStock: args.inStock === true, rohs: args.rohs === true }
        : undefined

    const result = await ctx.parts.search(
      provider,
      args.query,
      args.limit,
      offset,
      undefined,
      filters
    )
    if (!result.ok) return distributorFailure(ctx, result.error.kind, result.error.detail)

    const { parts, total } = result.value
    return succeed({
      distributor: PROVIDER_INFO[provider].name,
      query: args.query,
      qty,
      total,
      count: parts.length,
      offset,
      parts: parts.map((record) => partRow(record, qty, args.columns)),
      ...(total === 0
        ? {
            guidance:
              'No rows. Catalogs match part and family names: shorten the query, or search a DigiKey category with parts_list_filters and parts_search_category.'
          }
        : total > offset + parts.length
          ? {
              guidance: `${total} rows match; ${parts.length} returned. Page with offset, or narrow the query.`
            }
          : {}),
      quota: quotaSummary(ctx.parts.usage())
    })
  }
})
