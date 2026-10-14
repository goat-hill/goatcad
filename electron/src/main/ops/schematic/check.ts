/**
 * `schematic.check` — the electrical rule checks (ERC) over a sheet: what is
 * wrong with it, and what is left unconnected, in the vocabulary the writes use.
 *
 * Every row carries the pin ids an agent already addresses items by, so a
 * finding is actionable without a second lookup. A write runs these only with
 * `checks: true`; this is the whole picture — before starting, after a burst
 * of writes, and before reporting the sheet done.
 */
import { defineDesignOp } from '../registry'
import { s } from '../schema'
import { codesArg } from '../checksArg'
import { SHEET_FILE } from '../fileArgs'

export const schematicCheck = defineDesignOp({
  name: 'schematic.check',
  scope: 'schematic',
  mutates: false,
  summary:
    'Run the electrical rule checks (ERC) on a sheet, one row per rule with the pins and nets it names.',
  guidance:
    'Call after a burst of writes; writes run no checks unless asked. Before reporting a schematic done, render every sheet at a scale its text reads at (render_schematic by box), run this check, and show the user the renders with the findings that remain. The answer carries a revision: pass it later as since to get only what changed. For what is left to wire, pass codes ["unconnected-pin", "unconnected-wire-end"]; a pin left open on purpose takes a no-connect flag. A library symbol\'s checks are symbol_check.',
  input: s.object({
    sheet: s
      .string()
      .trim()
      .describe(
        `${SHEET_FILE}: answer its findings, on every instance of it, with counts.elsewhere for the rest. Default: the design's findings, from the root sheet, else the only open sheet.`
      )
      .optional(),
    codes: codesArg,
    since: s
      .integer()
      .describe(
        'Revision from an earlier schematic_check of this sheet; answers only what changed since, under checks.'
      )
      .optional()
  }),
  examples: [
    { args: {}, note: 'every finding' },
    {
      args: { codes: ['unconnected-pin', 'unconnected-wire-end'] },
      note: 'what is left to wire'
    },
    { args: { since: 42 }, note: 'changes since revision 42' }
  ],
  request: (args) => ({
    kind: 'check-schematic',
    ...(args.sheet ? { sheet: args.sheet } : {}),
    ...(args.codes ? { codes: args.codes } : {}),
    ...(args.since !== undefined ? { since: args.since } : {})
  })
})
