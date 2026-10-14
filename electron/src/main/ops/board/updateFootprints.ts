/**
 * `board.update_footprints` — placed footprints rebuilt from a library: each
 * from its own lib id (Update Footprints from Library), or changed to another
 * (Change Footprints).
 *
 * Design: `docs/libraries-workstream.md` §5; the swap is
 * `renderer/src/lib/board/footprintExchange.ts`, which the PCB editor's
 * Update and Change and board.sync's replaced footprints run too.
 */
import { defineDesignOp } from '../registry'
import { s, type OptionalSchema } from '../schema'
import { checksArg } from '../checksArg'
import { BOARD_FILE } from '../fileArgs'

const option = (describe: string): OptionalSchema<boolean> =>
  s.boolean().describe(describe).optional()

export const boardUpdateFootprints = defineDesignOp({
  name: 'board.update_footprints',
  lists: ['footprints', 'notFound'],
  scope: 'board',
  mutates: true,
  summary:
    'Rebuild placed footprints from their library, or change board-only footprints to another lib id.',
  guidance:
    'One undo step on the board tab, unsaved. Without footprint, each target is rebuilt from its own lib id: geometry, pads and graphics come from the library; position, angle, side, lock, reference, value, user fields, sheet link and pad nets (by pad number) stay. With footprint, targets change to that lib id; only board-only footprints change here. For a schematic part, write its Footprint field with bom_update and run board_sync. Targets: references, else every footprint whose lib id is match, else the whole board. options defaults follow KiCad: an update keeps text edits and fabrication flags and takes clearance overrides and 3D models; a change takes everything but extra texts. footprints has a row per target: droppedPads (nets with no pad now; their tracks dangle) and addedPads (pads with no net). Run with dryRun first.',
  input: s.object({
    board: s
      .string()
      .trim()
      .describe(`${BOARD_FILE}; omit for the project's one board.`)
      .optional(),
    references: s
      .array(s.string().trim())
      .describe('Footprints to rebuild, by reference (U2, H1).')
      .optional(),
    match: s
      .string()
      .trim()
      .describe('Rebuild every footprint with this lib id, when references is absent.')
      .optional(),
    footprint: s.string().trim().describe('Change the targets to this lib id.').optional(),
    options: s
      .object({
        removeExtraTexts: option('Drop texts the footprint has and the library one lacks.'),
        resetTextLayers: option('Take text layers and visibility from the library.'),
        resetTextEffects: option('Take text sizes and styles from the library.'),
        resetTextPositions: option('Take text positions from the library.'),
        resetTextContent: option('Take field text (not reference or value) from the library.'),
        resetFabricationAttributes: option(
          'Take SMD/through-hole and the position-file and courtyard flags from the library.'
        ),
        resetClearanceOverrides: option(
          'Take clearance, mask and paste overrides from the library.'
        ),
        reset3DModels: option('Take the 3D models from the library.')
      })
      .describe('What to take from the library instead of keeping.')
      .optional(),
    dryRun: s.boolean().describe('Answer with what would be rebuilt and write nothing.').optional(),
    checks: checksArg
  }),
  examples: [
    {
      args: { references: ['U2'], dryRun: true },
      note: 'preview updating U2'
    },
    {
      args: {
        match: 'MountingHole:MountingHole_3.2mm_M3',
        footprint: 'MountingHole:MountingHole_3.2mm_M3_Pad'
      },
      note: 'swap bare mounting holes for plated'
    }
  ],
  request: (args) => ({
    kind: 'update-footprints-board',
    ...(args.board ? { board: args.board } : {}),
    ...(args.references?.length ? { references: args.references } : {}),
    ...(args.match ? { match: args.match } : {}),
    ...(args.footprint ? { footprint: args.footprint } : {}),
    ...(args.options ? { options: args.options } : {}),
    ...(args.dryRun ? { dryRun: true } : {})
  })
})
