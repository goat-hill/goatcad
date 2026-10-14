/**
 * `symbol.list_library` — the browse step.
 *
 * An unknown nickname answers
 * with near-misses rather than an empty list: the likely cause is a recalled
 * name, and the fix is to show the real one.
 */
import { listSymbolLibrary, LIBRARY_PAGE_DEFAULT, LIBRARY_PAGE_MAX } from '../../partsMcpLibrary'
import { defineOp } from '../registry'
import { s } from '../schema'
import { notFound, refused, succeed } from '../errors'
import { libraryRecords, LIBRARY_UNAVAILABLE } from '../libraryRecords'

export const symbolListLibrary = defineOp({
  name: 'symbol.list_library',
  scope: 'app',
  mutates: false,
  summary: 'List the symbols in one library, each with its description and pin count.',
  guidance:
    'Prefer browsing to symbol_search: the description tells similar names apart (Device:R vs Device:R_Small). Check the pin count against the chosen part. Paged by offset and limit.',
  input: s.object({
    library: s
      .string()
      .trim()
      .describe('Library nickname from symbol_list_libraries, e.g. "Device".'),
    offset: s.integer().min(0).describe('Row to start at. Defaults to 0.').optional(),
    limit: s
      .integer()
      .min(1)
      .max(LIBRARY_PAGE_MAX)
      .describe(`Rows to return. Defaults to ${LIBRARY_PAGE_DEFAULT}.`)
      .optional()
  }),
  async run(args, ctx) {
    if (!args.library) {
      return refused(
        'library is required and must not be empty.',
        'Call symbol_list_libraries for the nicknames this project can see.'
      )
    }
    const records = await libraryRecords(ctx)
    if (!records) return LIBRARY_UNAVAILABLE
    const page = listSymbolLibrary(records, args.library, {
      offset: args.offset,
      limit: args.limit
    })
    if (page.error !== undefined) {
      return notFound(
        `No library has the nickname "${args.library}".`,
        page.guidance ??
          'Call symbol_list_libraries for the real names rather than trying variants.',
        { kind: page.error, candidates: page.didYouMean ?? [] }
      )
    }
    return succeed(page)
  }
})
