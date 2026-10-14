/**
 * `symbol.search` — the second choice, deliberately.
 *
 * A plain unranked substring
 * match, and the guidance says so, because an agent that believes this is a
 * semantic search will trust a vague query's flat list as a shortlist.
 */
import { searchSymbols, SEARCH_LIMIT_DEFAULT, SEARCH_LIMIT_MAX } from '../../partsMcpLibrary'
import { defineOp } from '../registry'
import { s } from '../schema'
import { refused, succeed } from '../errors'
import { libraryRecords, LIBRARY_UNAVAILABLE } from '../libraryRecords'

export const symbolSearch = defineOp({
  name: 'symbol.search',
  scope: 'app',
  mutates: false,
  summary: 'Find symbols by name, description or keyword across every library.',
  guidance:
    'For a known part number or family. An unranked substring match with no synonyms or spelling tolerance, so a vague query returns a long flat list; browse with symbol_list_library instead.',
  input: s.object({
    query: s.string().trim().describe('Terms that must all appear, e.g. "stm32f405" or "usb c".'),
    power: s
      .boolean()
      .describe('true for power ports only (GND, +3V3), false to exclude them. Omit for both.')
      .optional(),
    limit: s
      .integer()
      .min(1)
      .max(SEARCH_LIMIT_MAX)
      .describe(`Rows to return. Defaults to ${SEARCH_LIMIT_DEFAULT}.`)
      .optional()
  }),
  async run(args, ctx) {
    if (!args.query) {
      return refused(
        'query is required and must not be empty.',
        'Pass a term that appears in the symbol name, description or keywords.'
      )
    }
    const records = await libraryRecords(ctx)
    if (!records) return LIBRARY_UNAVAILABLE
    return succeed(searchSymbols(records, args.query, { limit: args.limit, power: args.power }))
  }
})
