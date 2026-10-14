/**
 * `board.cleanup` — the PCB editor's Cleanup Tracks & Vias, as a verb.
 *
 * Design: `docs/agent-api.md`; the passes are
 * `renderer/src/lib/board/trackCleanup.ts`, KiCad's `TRACKS_CLEANER`. Boards
 * routed by script or imported collect stubs, doubled vias and runs split into
 * many pieces; this removes them in one undo step, and a dry run lists each.
 */
import { defineDesignOp } from '../registry'
import { s } from '../schema'
import { checksArg } from '../checksArg'
import { viewportArg } from '../viewport/open'
import { actionArg } from '../viewport/action'
import { BOARD_FILE } from '../fileArgs'

export const boardCleanup = defineDesignOp({
  name: 'board.cleanup',
  lists: ['changes'],
  scope: 'board',
  mutates: true,
  summary:
    'Clean up tracks and vias: remove dangling, shorting and redundant copper, merge straight runs.',
  guidance:
    'One undo step on the board tab, unsaved. Locked copper is never touched. Dangling copper is judged against the zone fills, so a board with stale fills is refused: board_refill first. changes lists each removal or merge with the ids it names; deleted ids are gone after the write. Narrow with nets, layers or items. Run with dryRun first.',
  input: s.object({
    board: s
      .string()
      .trim()
      .describe(`${BOARD_FILE}; omit for the project's one board.`)
      .optional(),
    passes: s
      .object({
        shorts: s
          .boolean()
          .describe('Remove tracks and vias joining two named nets; default true.')
          .optional(),
        redundantVias: s
          .boolean()
          .describe('Remove a via over another via or over a through-hole pad; default true.')
          .optional(),
        danglingVias: s
          .boolean()
          .describe('Remove vias joining copper on fewer than two layers; default true.')
          .optional(),
        mergeTracks: s
          .boolean()
          .describe(
            'Merge straight tracks meeting end to end, and remove zero-length ones; default true.'
          )
          .optional(),
        danglingTracks: s
          .boolean()
          .describe('Remove tracks with an end that connects to nothing; default true.')
          .optional(),
        tracksInPads: s
          .boolean()
          .describe('Remove tracks lying wholly inside a pad; default false.')
          .optional()
      })
      .describe('Which passes run. Tracks drawn twice are always removed.')
      .optional(),
    nets: s
      .array(s.string().trim())
      .min(1)
      .describe('Only copper on these nets, e.g. ["GND"].')
      .optional(),
    layers: s
      .array(s.string().trim())
      .min(1)
      .describe('Only copper on these copper layers, e.g. ["F.Cu"].')
      .optional(),
    items: s
      .array(s.string().trim())
      .min(1)
      .describe('Only these tracks and vias, by id.')
      .optional(),
    dryRun: s.boolean().describe('Answer with the changes and write nothing.').optional(),
    viewport: viewportArg,
    action: actionArg,
    checks: checksArg
  }),
  examples: [
    {
      args: { dryRun: true, viewport: 'viewport-2', action: 'Preview cleanup' },
      note: 'list what would change'
    },
    {
      args: { nets: ['GND'], viewport: 'viewport-2', action: 'Clean up GND' },
      note: 'one net'
    }
  ],
  request: (args) => ({
    kind: 'cleanup-board',
    ...(args.board ? { board: args.board } : {}),
    ...(args.passes ? { passes: args.passes } : {}),
    ...(args.nets ? { nets: args.nets } : {}),
    ...(args.layers ? { layers: args.layers } : {}),
    ...(args.items ? { items: args.items } : {}),
    ...(args.dryRun ? { dryRun: true } : {})
  })
})
