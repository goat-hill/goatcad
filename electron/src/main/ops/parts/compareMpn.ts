/**
 * `parts.compare_mpn` — one known part at every connected distributor, side by
 * side.
 *
 * At most one row per distributor: its row whose MPN is the one asked, and,
 * when `manufacturer` is given, whose maker name is that one. Several rows or
 * none answer no row and the maker names the distributor lists, so the caller
 * decides; names are compared as given, never mapped onto each other.
 */
import { PROVIDER_IDS, PROVIDER_INFO } from '../../partsProviders'
import { defineOp } from '../registry'
import { s } from '../schema'
import { refused, succeed } from '../errors'
import {
  byManufacturer,
  listingsForMpn,
  manufacturersOf,
  partColumnsArg,
  noCredentials,
  partRow,
  quotaSummary,
  REMEDY
} from './shared'

export const partsCompareMpn = defineOp({
  name: 'parts.compare_mpn',
  scope: 'app',
  mutates: false,
  summary: 'Look up one exact manufacturer part number at every connected distributor.',
  guidance:
    'One entry per distributor: part is its row whose MPN matches whole, ignoring case, with every offer it lists. part is null when it lists none or several; manufacturers then names the makers it lists under that MPN, to pass as manufacturer. Find candidates with parts_search first.',
  input: s.object({
    mpn: s.string().trim().describe('Manufacturer part number, matched whole, ignoring case.'),
    manufacturer: s
      .string()
      .trim()
      .describe('Maker name as a distributor reports it, ignoring case.')
      .optional(),
    qty: s
      .integer()
      .min(1)
      .describe("Build quantity, selecting each offer's priceAtQty. Default 1.")
      .optional(),
    columns: partColumnsArg
  }),
  examples: [
    { args: { mpn: 'STM32F405RGT6', qty: 100 }, note: 'stock and price at each distributor' },
    {
      args: { mpn: 'LM358DR', manufacturer: 'Texas Instruments' },
      note: 'one maker of a shared MPN'
    }
  ],
  async run(args, ctx) {
    if (!args.mpn) {
      return refused(
        'mpn is required and must not be empty.',
        'Pass a manufacturer part number from parts_search.'
      )
    }
    if (!ctx.parts.credentialStatus().some((status) => status.configured)) return noCredentials(ctx)

    const qty = args.qty ?? 1
    const listings = await listingsForMpn(ctx, args.mpn)
    const distributors = PROVIDER_IDS.map((provider) => {
      const distributor = PROVIDER_INFO[provider].name
      // A distributor with no key was not asked.
      const listing = listings.find((entry) => entry.provider === provider) ?? {
        error: { kind: 'no-credentials' as const, detail: undefined },
        rows: []
      }
      if (listing.error) {
        const { kind, detail } = listing.error
        return {
          distributor,
          part: null,
          error: { kind, detail: detail ?? null, remedy: REMEDY[kind] }
        }
      }
      const matches = byManufacturer(listing.rows, args.manufacturer)
      return matches.length === 1
        ? { distributor, part: partRow(matches[0], qty, args.columns), matches: 1 }
        : {
            distributor,
            part: null,
            matches: matches.length,
            manufacturers: manufacturersOf(listing.rows)
          }
    })

    return succeed({
      mpn: args.mpn,
      ...(args.manufacturer ? { manufacturer: args.manufacturer } : {}),
      qty,
      distributors,
      quota: quotaSummary(ctx.parts.usage())
    })
  }
})
