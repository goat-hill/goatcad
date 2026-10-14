/**
 * `symbol.list_libraries` — the taxonomy, which is where a symbol hunt
 * starts.
 *
 * Browse first, search second.
 */
import { listSymbolLibraries } from '../../partsMcpLibrary'
import { defineOp } from '../registry'
import { s } from '../schema'
import { succeed } from '../errors'
import { libraryRecords, LIBRARY_UNAVAILABLE } from '../libraryRecords'

export const symbolListLibraries = defineOp({
  name: 'symbol.list_libraries',
  scope: 'app',
  mutates: false,
  summary:
    "List every symbol library this project can see: standard, user-added and the project's own.",
  guidance:
    'The usual first call for a symbol: nicknames are a taxonomy (Regulator_Linear, MCU_ST_STM32L4). Browse one with symbol_list_library.',
  input: s.object({}),
  async run(_args, ctx) {
    const records = await libraryRecords(ctx)
    if (!records) return LIBRARY_UNAVAILABLE
    return succeed(listSymbolLibraries(records))
  }
})
