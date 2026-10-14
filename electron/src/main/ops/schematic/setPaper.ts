/**
 * `schematic.set_paper` — the page a sheet is drawn on.
 *
 * Design: `docs/agent-api.md`. The page is a KiCad
 * compatibility field: it is where a print or a plot cuts, and nothing in
 * GoatCAD is bound to it — the drawing may run past the edge and `render.schematic`
 * still frames the content. It is a verb because the first outside design had
 * to close the project and hand-edit the file to get from A4 to A3.
 */
import { defineDesignOp } from '../registry'
import { s } from '../schema'
import { refused } from '../errors'
import { checksArg } from '../checksArg'
import { sheetFileArg } from '../fileArgs'

/** KiCad's own page names (`PAGE_INFO`), plus `User` for a size of your own. */
const PAGE_NAMES = [
  'A0',
  'A1',
  'A2',
  'A3',
  'A4',
  'A5',
  'A',
  'B',
  'C',
  'D',
  'E',
  'USLetter',
  'USLegal',
  'USLedger',
  'User'
] as const

export const schematicSetPaper = defineDesignOp({
  name: 'schematic.set_paper',
  lists: ['outside'],
  scope: 'schematic',
  mutates: true,
  summary: 'Set the page size and orientation of a schematic sheet.',
  guidance:
    'The page is where a print or plot cuts; items outside it still work. Set it when the user asks or the sheet will be printed. For a crowded sheet, split blocks out with schematic_add_sheet instead. One undo step. The answer gives the new page box and what lies outside it.',
  input: s.object({
    size: s.enum(PAGE_NAMES).describe('KiCad page name; "User" takes width and height.'),
    portrait: s.boolean().describe('Portrait orientation. Default false: landscape.').optional(),
    width: s.number().min(1).max(2000).describe('User page width, mm.').optional(),
    height: s.number().min(1).max(2000).describe('User page height, mm.').optional(),
    sheet: sheetFileArg(),
    checks: checksArg
  }),
  examples: [
    { args: { size: 'A3' }, note: 'A3 landscape' },
    { args: { size: 'User', width: 600, height: 400 }, note: 'custom size in mm' }
  ],
  request(args) {
    if (args.size === 'User') {
      if (args.width === undefined || args.height === undefined) {
        return refused(
          'A User page needs width and height.',
          'Give both in millimeters, or name a standard size such as A3.'
        )
      }
    } else if (args.width !== undefined || args.height !== undefined) {
      return refused(
        `${args.size} has its own size; width and height are for "User".`,
        `Pass size "${args.size}" alone, or size "User" with width and height.`
      )
    }
    return {
      kind: 'set-paper',
      size: args.size,
      ...(args.portrait !== undefined ? { portrait: args.portrait } : {}),
      ...(args.width !== undefined ? { width: args.width } : {}),
      ...(args.height !== undefined ? { height: args.height } : {}),
      ...(args.sheet ? { sheet: args.sheet } : {})
    }
  }
})
