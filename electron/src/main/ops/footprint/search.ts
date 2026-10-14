/**
 * `footprint.search` — substring search across every footprint library.
 */
import { searchFootprints } from '../../partsMcpFootprints'
import { SEARCH_LIMIT_DEFAULT, SEARCH_LIMIT_MAX } from '../../partsMcpLibrary'
import { defineOp } from '../registry'
import { s } from '../schema'
import { refused, succeed } from '../errors'
import { libraryRecords, LIBRARY_UNAVAILABLE } from '../libraryRecords'

export const footprintSearch = defineOp({
  name: 'footprint.search',
  scope: 'app',
  mutates: false,
  summary: 'Find footprints by name, description or tag across every footprint library.',
  guidance:
    'Search the package name and pitch ("QFN-20 0.5mm", "SOT-23-5", "0402"). An unranked substring match with no synonyms, so a vague query returns a long flat list; browse with footprint_list_library instead.',
  input: s.object({
    query: s
      .string()
      .trim()
      .describe('Terms that must all appear, e.g. "qfn-20 0.5mm" or "usb c".'),
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
        'Pass a term that appears in the footprint name, description or tags.'
      )
    }
    const records = await libraryRecords(ctx)
    if (!records) return LIBRARY_UNAVAILABLE
    return succeed(searchFootprints(records, args.query, { limit: args.limit }))
  }
})
