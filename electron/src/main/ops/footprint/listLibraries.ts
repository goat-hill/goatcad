/**
 * `footprint.list_libraries` — the footprint twin of the symbol entry point.
 */
import { listFootprintLibraries } from '../../partsMcpFootprints'
import { defineOp } from '../registry'
import { s } from '../schema'
import { succeed } from '../errors'
import { libraryRecords, LIBRARY_UNAVAILABLE } from '../libraryRecords'

export const footprintListLibraries = defineOp({
  name: 'footprint.list_libraries',
  scope: 'app',
  mutates: false,
  summary: 'List every footprint library this project can see, with its footprint count.',
  guidance:
    'The usual first call for a footprint: nicknames are a package taxonomy (Package_QFP, Resistor_SMD). Project libraries sort first. A Footprint field naming a footprint no library has is refused.',
  input: s.object({}),
  async run(_args, ctx) {
    const records = await libraryRecords(ctx)
    if (!records) return LIBRARY_UNAVAILABLE
    return succeed(listFootprintLibraries(records))
  }
})
