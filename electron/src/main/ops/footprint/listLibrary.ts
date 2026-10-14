/**
 * `footprint.list_library` — the browse step for footprints.
 */
import { listFootprintLibrary } from '../../partsMcpFootprints'
import { LIBRARY_PAGE_DEFAULT, LIBRARY_PAGE_MAX } from '../../partsMcpLibrary'
import { defineOp } from '../registry'
import { s } from '../schema'
import { notFound, refused, succeed } from '../errors'
import { libraryRecords, LIBRARY_UNAVAILABLE } from '../libraryRecords'

export const footprintListLibrary = defineOp({
  name: 'footprint.list_library',
  scope: 'app',
  mutates: false,
  summary: 'List the footprints in one library, each with its description and pad count.',
  guidance:
    'Names carry body size and pitch (QFP-64_10x10mm_P0.5mm); descriptions name variants (HandSolder, ThermalVias). Check the pad count against the part, then footprint_get. Paged by offset and limit.',
  input: s.object({
    library: s
      .string()
      .trim()
      .describe('Library nickname from footprint_list_libraries, e.g. "Package_QFP".'),
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
        'Call footprint_list_libraries for the nicknames this project can see.'
      )
    }
    const records = await libraryRecords(ctx)
    if (!records) return LIBRARY_UNAVAILABLE
    const page = listFootprintLibrary(records, args.library, {
      offset: args.offset,
      limit: args.limit
    })
    if (page.error !== undefined) {
      return notFound(
        `No footprint library has the nickname "${args.library}".`,
        page.guidance ??
          'Call footprint_list_libraries for the real names rather than trying variants.',
        { kind: page.error, candidates: page.didYouMean ?? [] }
      )
    }
    return succeed(page)
  }
})
