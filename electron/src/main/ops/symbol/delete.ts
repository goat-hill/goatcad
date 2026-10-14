/**
 * `symbol.delete` — remove a symbol definition from the project library.
 *
 * Not the tool for taking a
 * symbol off a sheet: KiCad calls both a placement and a library definition a
 * "symbol", so the word to watch is *library*.
 */
import { defineDesignOp } from '../registry'
import { s } from '../schema'
import { refused } from '../errors'

export const symbolDelete = defineDesignOp({
  name: 'symbol.delete',
  scope: 'project',
  mutates: true,
  summary: "Remove a symbol definition from the project's own symbol library.",
  guidance:
    'To take a symbol off a sheet, use items_delete. Only the project library is writable. One undo step on the library tab when one holds it, else the file is rewritten. Placed symbols keep their sheet copy.',
  input: s.object({
    symbol: s.string().trim().describe('A project library id "Nickname:Name".')
  }),
  examples: [{ args: { symbol: 'board:ES8388' }, note: 'a generated symbol' }],
  request: (args) =>
    args.symbol.includes(':')
      ? { kind: 'delete-symbol', symbol: args.symbol }
      : refused(
          `"${args.symbol}" is not a library id.`,
          'Pass "Nickname:Name" as symbol_list_library reports it.'
        )
})
