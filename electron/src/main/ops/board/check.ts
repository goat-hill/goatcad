/**
 * `board.check` — the design rule checks (DRC) over a board, as its health
 * pill reads them.
 */
import { defineDesignOp } from '../registry'
import { s } from '../schema'
import { codesArg } from '../checksArg'
import { BOARD_FILE } from '../fileArgs'

export const boardCheck = defineDesignOp({
  name: 'board.check',
  scope: 'board',
  mutates: false,
  summary:
    "Run DRC on a board: clearances, shorts, unrouted connections, size minimums, courtyards and KiCad's other rules.",
  guidance:
    'Call after a burst of writes and before reporting a board finished; writes run no checks unless asked. One row per rule with the items it names, and each finding with its items, location, layer and measured vs required: ids are the ones items_get and board_explain_limits take. Without codes a row lists its first 20 findings. unrouted counts connections left to route. Findings that read a stale zone fill are held back until board_refill. For a delta over a burst, call it first, then again with since set to the revision it answered with.',
  input: s.object({
    board: s
      .string()
      .trim()
      .describe(`${BOARD_FILE}; omit for the project's one board.`)
      .optional(),
    codes: codesArg,
    since: s
      .integer()
      .describe(
        'A revision from an earlier board_check: answer only what changed since, under checks.'
      )
      .optional()
  }),
  examples: [
    { args: {}, note: 'every finding' },
    { args: { codes: ['copper-clearance', 'copper-short'] }, note: 'only clearance and shorts' }
  ],
  request: (args) => ({
    kind: 'check-board',
    ...(args.board ? { board: args.board } : {}),
    ...(args.codes ? { codes: args.codes } : {}),
    ...(args.since !== undefined ? { since: args.since } : {})
  })
})
