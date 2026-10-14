/**
 * `board.place_footprint` — one library footprint put on the board by hand.
 *
 * Design: `docs/libraries-workstream.md` §4; the placement is
 * `renderer/src/lib/board/footprintPlace.ts`, which the PCB editor's Place
 * Footprint runs too. A verb above `items.create` because it resolves an id the
 * model should not compute (the lib id to its library file, the next free
 * reference) and holds an invariant: the footprint is marked board-only, so a
 * sync keeps it.
 */
import { defineDesignOp } from '../registry'
import { s } from '../schema'
import { checksArg } from '../checksArg'
import { viewportArg } from '../viewport/open'
import { actionArg } from '../viewport/action'
import { BOARD_FILE } from '../fileArgs'

export const boardPlaceFootprint = defineDesignOp({
  name: 'board.place_footprint',
  scope: 'board',
  mutates: true,
  summary:
    'Place a library footprint no schematic symbol owns, such as a mounting hole, test point or fiducial.',
  guidance:
    'Read board_describe first: at is not checked against the outline. A schematic part arrives by board_sync instead. One undo step on the board tab, unsaved. Marked board-only (KiCad\'s "Not in schematic"), so a sync keeps it. Its pads have no net; set one with items_update. side "back" flips it as the editor\'s flip does, then turns it to angle, as items_update does.',
  input: s.object({
    board: s
      .string()
      .trim()
      .describe(`${BOARD_FILE}; omit for the project's one board.`)
      .optional(),
    footprint: s
      .string()
      .trim()
      .describe('Lib id, e.g. MountingHole:MountingHole_3.2mm_M3; find one with footprint_search.'),
    at: s
      .object({
        x: s.number().describe('mm'),
        y: s.number().describe('mm, y down')
      })
      .describe("The footprint's origin, board mm, y down."),
    angle: s.number().describe('Degrees counterclockwise; default 0.').optional(),
    side: s
      .enum(['front', 'back'] as const)
      .describe('Default front.')
      .optional(),
    reference: s
      .string()
      .trim()
      .describe('Default: the next free one for its prefix (H, TP, FID).')
      .optional(),
    dryRun: s.boolean().describe('Answer with the placement and write nothing.').optional(),
    viewport: viewportArg,
    action: actionArg,
    checks: checksArg
  }),
  examples: [
    {
      args: {
        footprint: 'MountingHole:MountingHole_3.2mm_M3',
        at: { x: 3.5, y: 3.5 },
        viewport: 'viewport-2',
        action: 'Place a mounting hole'
      },
      note: 'a mounting hole in a corner'
    },
    {
      args: {
        footprint: 'Fiducial:Fiducial_1mm_Mask2mm',
        at: { x: 5, y: 45 },
        dryRun: true,
        viewport: 'viewport-2',
        action: 'Preview a fiducial'
      },
      note: "preview a fiducial's reference"
    },
    {
      args: {
        footprint: 'TestPoint:TestPoint_Pad_D1.0mm',
        at: { x: 20, y: 30 },
        side: 'back',
        viewport: 'viewport-2',
        action: 'Place a back test point'
      },
      note: 'a test point on the back'
    }
  ],
  request: (args) => ({
    kind: 'place-footprint-board',
    footprint: args.footprint,
    at: args.at,
    ...(args.board ? { board: args.board } : {}),
    ...(args.angle !== undefined ? { angle: args.angle } : {}),
    ...(args.side ? { side: args.side } : {}),
    ...(args.reference ? { reference: args.reference } : {}),
    ...(args.dryRun ? { dryRun: true } : {})
  })
})
