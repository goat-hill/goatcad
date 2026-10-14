/**
 * `board.update_tuning_patterns` — every tuning pattern laid again where it
 * lies, to the rules as they are now: KiCad's Update All Tuning Patterns.
 *
 * Design: `docs/router-behavior.md` T4; the re-tune is
 * `renderer/src/lib/board/patternRetune.ts`, which the PCB editor's command,
 * a pattern's Properties rows and handles, and `items.update` on a pattern run too.
 */
import { defineDesignOp } from '../registry'
import { s } from '../schema'
import { checksArg } from '../checksArg'
import { BOARD_FILE } from '../fileArgs'
import { viewportArg } from '../viewport/open'
import { actionArg } from '../viewport/action'

export const boardUpdateTuningPatterns = defineDesignOp({
  name: 'board.update_tuning_patterns',
  lists: ['patterns'],
  scope: 'board',
  mutates: true,
  summary:
    'Lay every tuning pattern on a board again, to its length and skew rules as they are now.',
  guidance:
    "Call after a rule, net class, tuning profile or stackup change. Each pattern keeps its settings and ends; its meanders are re-laid to its net's rule, or its own target where it overrides the rules. One undo step on the board tab, unsaved; zone fills go stale. patterns has a row per pattern: length (skew), target, status, blocked where the meanders break a rule; laid: false where the tuner could not lay it, its settings kept. One pattern changes with items_update.",
  input: s.object({
    board: s
      .string()
      .trim()
      .describe(`${BOARD_FILE}; omit for the project's one board.`)
      .optional(),
    dryRun: s
      .boolean()
      .describe('Answer with what each pattern would lay and write nothing.')
      .optional(),
    viewport: viewportArg,
    action: actionArg,
    checks: checksArg
  }),
  examples: [
    {
      args: { dryRun: true, viewport: 'viewport-2', action: 'Preview re-tune' },
      note: 'what each pattern would lay'
    },
    {
      args: { checks: true, viewport: 'viewport-2', action: 'Re-tune to new rules' },
      note: 'and what the new meanders broke or fixed'
    }
  ],
  request: (args) => ({
    kind: 'update-tuning-patterns-board',
    ...(args.board ? { board: args.board } : {}),
    ...(args.dryRun ? { dryRun: true } : {})
  })
})
