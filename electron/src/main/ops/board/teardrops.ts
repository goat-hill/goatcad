/**
 * `board.set_teardrops` — the PCB editor's Edit teardrops, as a verb.
 *
 * Design: `docs/pcb-editor-workstream.md` (Teardrops); the edit is
 * `renderer/src/lib/board/teardrop/edit.ts`, KiCad's Edit Teardrops dialog.
 * A teardrop is a pad's or via's setting; this turns it on, sets it or turns
 * it off for many at once and rebuilds every teardrop, in one undo step.
 */
import { defineDesignOp } from '../registry'
import { s } from '../schema'
import { checksArg } from '../checksArg'
import { viewportArg } from '../viewport/open'
import { actionArg } from '../viewport/action'
import { BOARD_FILE } from '../fileArgs'

const TARGETS = ['vias', 'pthPads', 'smdPads', 'trackToTrack'] as const

export const boardSetTeardrops = defineDesignOp({
  name: 'board.set_teardrops',
  scope: 'board',
  mutates: true,
  summary: "Add, set or remove teardrops on the board's pads and vias, and rebuild them all.",
  guidance:
    "One undo step on the board tab, unsaved; the targets are saved to the project, as KiCad's dialog saves them. add takes each shape's defaults (board_get_setup's teardrops); set writes only the values given. A pad or via placed later gets none until this runs again. Fills go stale: board_refill after.",
  input: s.object({
    board: s
      .string()
      .trim()
      .describe(`${BOARD_FILE}; omit for the project's one board.`)
      .optional(),
    mode: s
      .enum(['add', 'set', 'remove', 'removeAll'])
      .describe('removeAll clears every pad and via, whatever the targets and filters.'),
    targets: s
      .array(s.enum(TARGETS))
      .describe(
        "What gets teardrops: trackToTrack is the board-wide one where a track meets a wider one. Default the project's last."
      )
      .optional(),
    values: s
      .object({
        bestLengthRatio: s
          .number()
          .min(0)
          .describe('Length, as a share of the pad or via size.')
          .optional(),
        maxLength: s.number().min(0).describe('mm.').optional(),
        bestWidthRatio: s
          .number()
          .min(0)
          .max(1)
          .describe('Width, as a share of the pad or via size.')
          .optional(),
        maxWidth: s.number().min(0).describe('mm.').optional(),
        curvedEdges: s.boolean().optional(),
        filterRatio: s
          .number()
          .min(0)
          .max(1)
          .describe('A track at least this share of the pad or via size gets none.')
          .optional(),
        allowTwoSegments: s.boolean().describe('Span a short track and the next.').optional(),
        preferZoneConnections: s
          .boolean()
          .describe('Skip a pad a zone of its net already joins to the track.')
          .optional()
      })
      .describe('For set: the values written; an absent one keeps each item its own.')
      .optional(),
    nets: s
      .array(s.string().trim())
      .min(1)
      .describe('Only pads and vias on these nets.')
      .optional(),
    layers: s
      .array(s.string().trim())
      .min(1)
      .describe('Only pads and vias on these copper layers.')
      .optional(),
    items: s
      .array(s.string().trim())
      .min(1)
      .describe('Only these pads and vias, by id.')
      .optional(),
    roundOnly: s.boolean().describe('Only round pads, and vias.').optional(),
    existingOnly: s.boolean().describe('Only pads and vias that have teardrops.').optional(),
    dryRun: s.boolean().describe('Answer with what would change and write nothing.').optional(),
    viewport: viewportArg,
    action: actionArg,
    checks: checksArg
  }),
  examples: [
    {
      args: {
        mode: 'add',
        targets: ['vias', 'pthPads', 'smdPads'],
        viewport: 'viewport-2',
        action: 'Add teardrops'
      },
      note: 'every pad and via'
    },
    {
      args: {
        mode: 'set',
        nets: ['USB_D+', 'USB_D-'],
        values: { curvedEdges: true },
        viewport: 'viewport-2',
        action: 'Curve USB teardrops'
      },
      note: 'some nets'
    }
  ],
  request: (args) => ({
    kind: 'set-teardrops-board',
    mode: args.mode,
    ...(args.board ? { board: args.board } : {}),
    ...(args.targets ? { targets: args.targets } : {}),
    ...(args.values ? { values: args.values } : {}),
    ...(args.nets ? { nets: args.nets } : {}),
    ...(args.layers ? { layers: args.layers } : {}),
    ...(args.items ? { items: args.items } : {}),
    ...(args.roundOnly ? { roundOnly: true } : {}),
    ...(args.existingOnly ? { existingOnly: true } : {}),
    ...(args.dryRun ? { dryRun: true } : {})
  })
})
