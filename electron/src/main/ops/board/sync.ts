/**
 * `board.sync` — the schematic carried onto the board.
 *
 * Design: `docs/agent-api.md`, netlist-sync-workstream.md.
 * It answers the way KiCad's netlist import does: every part with a
 * footprint lands, the parts without one are named and skipped, and the rest
 * still applies. That answer is where an agent learns a part needs a
 * footprint, in the turn it tries, which is why no standing check says so.
 */
import { defineDesignOp } from '../registry'
import { s } from '../schema'
import { checksArg } from '../checksArg'
import { BOARD_FILE } from '../fileArgs'

export const boardSync = defineDesignOp({
  name: 'board.sync',
  lists: [
    'added',
    'updated',
    'unchanged',
    'orphans',
    'skipped',
    'footprintReplaced',
    'removed',
    'nets.added',
    'nets.removed'
  ],
  scope: 'board',
  mutates: true,
  summary:
    'Put the schematic on the board: add missing footprints, update existing ones, and name parts that cannot land.',
  guidance:
    'One undo step on the board tab, unsaved; the tab opens behind when none holds the board. Footprints link to symbols by uuid path, so a re-sync keeps placement and routing and changes only what the schematic changed. A part whose Footprint field is empty or names a footprint no library holds is listed under skipped (a placed one keeps its footprint), and fix says what to write; the rest still lands. New footprints sit unrotated in rows below the outline, grouped by sheet. A footprint whose symbol is gone is an orphan, removed only with prune. A part whose Footprint field names a new footprint is rebuilt from it (footprintReplaced): place, reference and nets stay, and a pad the new one lacks leaves its tracks dangling. Run with dryRun first on a board with work on it.',
  input: s.object({
    board: s
      .string()
      .trim()
      .describe(`${BOARD_FILE}; omit for the project's one board.`)
      .optional(),
    prune: s
      .boolean()
      .describe('Remove footprints whose symbol is gone; default false, as in KiCad.')
      .optional(),
    replaceFootprints: s
      .boolean()
      .describe(
        'Rebuild a footprint whose symbol names another; default true. False keeps the placed one.'
      )
      .optional(),
    updateFields: s
      .boolean()
      .describe(
        'Write symbol fields, Do not populate and Exclude from BOM onto footprints; default true.'
      )
      .optional(),
    dryRun: s.boolean().describe('Answer with what would change and write nothing.').optional(),
    checks: checksArg
  }),
  examples: [
    { args: { dryRun: true }, note: 'preview the sync' },
    { args: {}, note: 'sync the board' }
  ],
  request: (args) => ({
    kind: 'sync-board',
    ...(args.board ? { board: args.board } : {}),
    ...(args.prune !== undefined ? { prune: args.prune } : {}),
    ...(args.replaceFootprints !== undefined ? { replaceFootprints: args.replaceFootprints } : {}),
    ...(args.updateFields !== undefined ? { updateFields: args.updateFields } : {}),
    dryRun: args.dryRun === true
  })
})
