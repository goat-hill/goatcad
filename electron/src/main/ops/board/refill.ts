/**
 * `board.refill` — recompute every zone fill.
 *
 * Design: `docs/agent-api.md` ("fast by default; a skipped step is
 * findable"). A write never refills: it leaves every fill stale
 * (`stale.fills`), and this is the step that makes the pours, and the checks
 * that read them, current again. It is the editor's B with a time budget.
 */
import { defineDesignOp } from '../registry'
import { s } from '../schema'
import { checksArg } from '../checksArg'
import { BOARD_FILE } from '../fileArgs'

export const boardRefill = defineDesignOp({
  name: 'board.refill',
  scope: 'board',
  mutates: true,
  summary: 'Refill every zone of a board.',
  guidance:
    'Writes never refill: call once a burst of edits is done, when answers carry stale.fills, and before trusting unrouted or fill checks. Every teardrop is rebuilt first, its own undo step. One undo step on the board tab, unsaved. A dense board can exceed the time budget: what was filled is committed, counts.remaining zones stay stale, and the next call continues with them.',
  input: s.object({
    board: s
      .string()
      .trim()
      .describe(`${BOARD_FILE}; omit for the project's one board.`)
      .optional(),
    checks: checksArg
  }),
  examples: [
    { args: {}, note: 'every zone' },
    { args: { checks: true }, note: 'and what the new fills changed' }
  ],
  request: (args) => ({
    kind: 'refill-board',
    ...(args.board ? { board: args.board } : {})
  })
})
