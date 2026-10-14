/**
 * `schematic.annotate` — KiCad's Annotate Schematic, as a verb.
 *
 * Design: `docs/agent-api.md`. Placement numbers
 * every part as it lands, in the order the agent placed them — dependency
 * order, not reading order — so by the end of a board the designators are
 * scattered across the page and gapped wherever a part was removed. This is
 * the tidy-up, and the repair for a duplicate that a copied sheet or an older
 * file brought in. The plan is `lib/schematic/annotate.ts`, the same one the
 * editor's dialog runs; it lands as one undo entry across every sheet it
 * touches.
 *
 * The answer carries the old-to-new map, because every id the agent holds
 * changes with it, and a check delta (`checks`) is computed through that map so a
 * renamed pin does not read as a resolved finding and a new one.
 */
import { defineDesignOp } from '../registry'
import { s } from '../schema'
import { refused } from '../errors'
import { checksArg } from '../checksArg'
import { sheetFileArg } from '../fileArgs'

export const schematicAnnotate = defineDesignOp({
  name: 'schematic.annotate',
  lists: ['renamed'],
  scope: 'schematic',
  mutates: true,
  summary:
    'Renumber reference designators in reading order across the design, a sheet, or named symbols.',
  guidance:
    'Run once layout settles, before reporting a design finished. One undo step across every sheet touched. Designators stay unique across the design; sheets outside the scope keep their numbers. By default only unannotated and duplicate references change. Units of a part move together. Ids held from before the call may name a different part after it: read `renamed` for the old-to-new map. Not allowed in schematic_batch.',
  input: s.object({
    scope: s
      .enum(['design', 'sheet'] as const)
      .describe(
        'Default "design": every sheet, in hierarchy order. "sheet": the sheet named by `sheet`, else the open or root sheet.'
      )
      .optional(),
    recurse: s
      .boolean()
      .describe('With scope sheet, also the sheets beneath it. Default false.')
      .optional(),
    symbols: s
      .array(s.string().trim())
      .describe(
        'Only these references on the sheet, e.g. ["R?", "R3"]; the rest keep their numbers. Implies scope sheet.'
      )
      .optional(),
    order: s
      .enum(['xy', 'yx'] as const)
      .describe(
        'Default "xy": left to right, then top to bottom. "yx": top to bottom, then left to right.'
      )
      .optional(),
    numbering: s
      .enum(['sequential', 'sheet100', 'sheet1000'] as const)
      .describe(
        'Default "sequential": first free number after start. "sheet100"/"sheet1000": first free after page number × 100 or × 1000.'
      )
      .optional(),
    start: s
      .number()
      .describe('Sequential numbering: new numbers begin above this. Default 0.')
      .optional(),
    reset: s
      .boolean()
      .describe('Renumber everything in scope from scratch. Default false.')
      .optional(),
    dryRun: s.boolean().describe('Return the old-to-new map without changing anything.').optional(),
    sheet: sheetFileArg('The sheet for scope sheet or symbols. '),
    checks: checksArg
  }),
  examples: [
    { args: {}, note: 'number new parts, fix duplicates' },
    {
      args: { reset: true, numbering: 'sheet100' },
      note: 'renumber all by page'
    },
    {
      args: { scope: 'sheet', dryRun: true },
      note: 'preview one sheet'
    }
  ],
  request(args) {
    if (args.start !== undefined && (!Number.isFinite(args.start) || args.start < 0)) {
      return refused(
        `start must be a whole number of 0 or more, not ${args.start}.`,
        'Omit it to start at 1.'
      )
    }
    if (args.symbols && args.symbols.length === 0) {
      return refused('symbols names nothing.', 'Omit it to annotate the whole sheet.')
    }
    return {
      kind: 'annotate-schematic',
      scope: args.symbols ? 'sheet' : (args.scope ?? 'design'),
      recurse: args.recurse ?? false,
      order: args.order ?? 'xy',
      numbering: args.numbering ?? 'sequential',
      start: Math.floor(args.start ?? 0),
      reset: args.reset ?? false,
      dryRun: args.dryRun ?? false,
      ...(args.symbols ? { symbols: args.symbols } : {}),
      ...(args.sheet ? { sheet: args.sheet } : {})
    }
  }
})
