/**
 * `symbol.copy` — a library symbol copied into the project's own symbol
 * library, as Copy to project library does, so it can be edited. The twin of
 * `footprint.copy`; an `extends` parent is flattened into the copy.
 */
import { defineDesignOp } from '../registry'
import { s } from '../schema'
import { refused } from '../errors'

export const symbolCopy = defineDesignOp({
  name: 'symbol.copy',
  scope: 'project',
  mutates: true,
  summary: "Copy a library symbol into the project's own symbol library, to edit it.",
  guidance:
    "Standard and global libraries are read-only; this makes an editable copy, its extends parent flattened in. The copy is a new id: place it with schematic_place_symbol. One undo step on the library's tab when one holds it, else the file is written; the library opens as a tab behind.",
  input: s.object({
    symbol: s.string().trim().describe('Source symbol id "Nickname:Name".'),
    name: s
      .string()
      .trim()
      .describe("Name for the copy. Defaults to the source's name.")
      .optional(),
    library: s
      .string()
      .trim()
      .describe("Symbol library (.kicad_sym) stem. Defaults to the project's own name.")
      .optional()
  }),
  examples: [
    { args: { symbol: 'Regulator_Linear:AMS1117-3.3' }, note: 'an editable copy' },
    {
      args: { symbol: 'Device:R', name: 'R_Sense' },
      note: 'a copy under another name'
    }
  ],
  request(args) {
    if (!args.symbol.includes(':')) {
      return refused(
        `"${args.symbol}" is not a library id.`,
        'Pass "Nickname:Name" as symbol_search reports it.'
      )
    }
    return {
      kind: 'copy-symbol',
      libId: args.symbol,
      ...(args.name ? { name: args.name } : {}),
      ...(args.library ? { library: args.library } : {})
    }
  }
})
