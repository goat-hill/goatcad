/**
 * `schematic.update_symbols` — placed symbols redrawn from a library: each
 * from its own lib id (Update Symbols from Library), or changed to another
 * (Change Symbols), across every sheet of the design, as one undo step.
 *
 * The swap is `renderer/src/lib/schematic/symbolUpdate.ts`
 * (`updateSymbolsWithWires`), which the schematic editor's Update and Change
 * run too; `board.update_footprints` is its board twin.
 */
import { defineDesignOp } from '../registry'
import { s, type OptionalSchema } from '../schema'
import { checksArg } from '../checksArg'
import { sheetFileArg } from '../fileArgs'
import { invalidArgs } from '../errors'

const option = (describe: string): OptionalSchema<boolean> =>
  s.boolean().describe(describe).optional()

export const schematicUpdateSymbols = defineDesignOp({
  name: 'schematic.update_symbols',
  lists: ['symbols', 'skipped', 'notFound'],
  scope: 'schematic',
  mutates: true,
  summary:
    "Redraw placed symbols from their library, or change them to another lib id, across the design's sheets.",
  guidance:
    "One undo step, unsaved; a sheet without a tab opens behind the active one. Without symbol, each target takes its own lib id's current definition; with symbol, targets change to that lib id. Position, angle, mirror, unit and references stay; pins keep their uuids by number, and a wire on a pin that moves follows it. Targets: references (every unit of each part), else every symbol whose lib id is match, else (an update only) every symbol. A unit the new symbol lacks stays as it was, on its old symbol, as in KiCad; skipped names it, and the part's other units are written. options defaults follow KiCad: an update takes field text only; a change also takes field look and place, attributes, pin text visibility and alternates. symbols has a row per part: moved, dropped, added and unwired pins (on a wire or label before, on nothing after). Run with dryRun first.",
  input: s.object({
    sheet: sheetFileArg('Any sheet of the project, to pick the project. '),
    references: s
      .array(s.string().trim())
      .min(1)
      .describe('Parts to update, by reference (U2, R7); every unit of each.')
      .optional(),
    match: s
      .string()
      .trim()
      .describe('Update every symbol with this lib id, when references is absent.')
      .optional(),
    symbol: s.string().trim().describe('Change the targets to this lib id.').optional(),
    options: s
      .object({
        updateReference: option('Take the reference prefix from the library; the number stays.'),
        updateValue: option('Take the Value from the library.'),
        resetFieldText: option('Take field text from the library, where it has text.'),
        resetEmptyFields: option('Take field text the library leaves empty, clearing it.'),
        removeExtraFields: option('Drop fields the library symbol lacks (never a mandatory one).'),
        resetFieldVisibility: option('Take field visibility from the library.'),
        resetFieldEffects: option('Take field sizes and styles from the library.'),
        resetFieldPositions: option('Take field positions from the library.'),
        resetAttributes: option('Take in BOM, on board and exclude from simulation.'),
        resetPinTextVisibility: option('Take pin name and number visibility from the library.'),
        resetAlternatePins: option('Clear chosen alternate pin functions.'),
        resetCustomPower: option("Take a power symbol's Value from the library."),
        fields: s
          .array(s.string().trim())
          .describe('Only these fields, besides Reference and Value; absent, every field.')
          .optional()
      })
      .describe('What to take from the library instead of keeping.')
      .optional(),
    dryRun: s.boolean().describe('Answer with what would change and write nothing.').optional(),
    checks: checksArg
  }),
  examples: [
    {
      args: { references: ['U2'], dryRun: true },
      note: 'preview updating U2'
    },
    {
      args: { match: 'Device:R', symbol: 'Device:R_Small' },
      note: 'swap every resistor for the small symbol'
    }
  ],
  request: (args) =>
    // A change of every symbol in the design is never what a caller means.
    args.symbol && !args.references?.length && !args.match
      ? invalidArgs(
          'symbol changes the targets, and none are named.',
          'symbol',
          'Pass references or match with symbol, as Change Symbols picks its targets.'
        )
      : {
          kind: 'update-symbols-schematic',
          ...(args.sheet ? { sheet: args.sheet } : {}),
          ...(args.references?.length ? { references: args.references } : {}),
          ...(args.match ? { match: args.match } : {}),
          ...(args.symbol ? { symbol: args.symbol } : {}),
          ...(args.options ? { options: args.options } : {}),
          ...(args.dryRun ? { dryRun: true } : {})
        }
})
