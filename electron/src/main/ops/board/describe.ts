/**
 * `board.describe` — what is on the board and what is left to route.
 *
 * Design: `docs/agent-api.md`. The one board verb that
 * works before a sync has ever run, on a board KiCad authored: the read that
 * gives every later board verb its vocabulary, the way `schematic.describe`
 * does for a sheet.
 */
import { defineDesignOp } from '../registry'
import { s } from '../schema'
import { BOARD_FILE } from '../fileArgs'

export const boardDescribe = defineDesignOp({
  name: 'board.describe',
  scope: 'board',
  mutates: false,
  summary: 'Read a board: layers, outline, footprints, item counts and unrouted connections.',
  guidance:
    'Read first, and after board_sync to see what landed. Positions are millimeters in board space, y down. path links a footprint to its schematic symbol; absent on one placed by hand. unrouted counts missing connections; zero means every net is complete. Reads the open tab when there is one, else the file. An open board answers with revision: pass it as since for only what moved. stale names zones whose fill predates an edit.',
  input: s.object({
    board: s
      .string()
      .trim()
      .describe(
        `${BOARD_FILE}; omit for the project's one board (refused with candidates when there are several).`
      )
      .optional(),
    since: s
      .integer()
      .min(0)
      .describe('A revision from an earlier answer: only what moved since.')
      .optional(),
    lengths: s
      .array(s.string().trim())
      .min(1)
      .max(64)
      .describe(
        "Nets whose whole routed length to answer, mm: tracks, via heights and pad-to-die, with the length rule; a pair half adds its partner's skew."
      )
      .optional()
  }),
  request: (args) => ({
    kind: 'describe-board',
    ...(args.board ? { board: args.board } : {}),
    ...(args.since !== undefined ? { since: args.since } : {}),
    ...(args.lengths ? { lengths: args.lengths } : {})
  })
})
