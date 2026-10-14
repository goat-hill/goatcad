/**
 * `render.gerbers` — a fab set drawn back, for a model that cannot see
 * the Gerber viewer: what a fab's own viewer will read from the files, so an
 * agent checks what it exported, or any set it was handed, before an order.
 */
import { defineDesignOp } from '../registry'
import { s } from '../schema'
import { RENDER_DEFAULT_MAX_PIXELS } from './schematic'
import { BOARD_FILE } from '../fileArgs'

export const renderGerbers = defineDesignOp({
  name: 'render.gerbers',
  scope: 'board',
  mutates: false,
  summary:
    'Render a folder of Gerber and drill files to a PNG, as the Gerber viewer composites them.',
  guidance:
    'Reads the files, not the board: each Gerber (identified by its X2 FileFunction, else its name) and Excellon .drl, holes on top. Use after export_gerbers or export_package to check what the fab receives. Name layers to read one at a time; frame a box for detail.',
  input: s.object({
    board: s
      .string()
      .trim()
      .describe(
        `The board whose folder a relative directory resolves against. ${BOARD_FILE}; omit for the project's one board.`
      )
      .optional(),
    directory: s
      .string()
      .trim()
      .min(1)
      .describe("Folder of files, absolute or relative to the board's folder; default fab.")
      .optional(),
    layers: s
      .array(s.string().trim())
      .min(1)
      .describe(
        'Only these, by KiCad layer name (F.Cu) or file name (demo-PTH.drl); default every file.'
      )
      .optional(),
    box: s
      .object({ x: s.number(), y: s.number(), width: s.number(), height: s.number() })
      .describe("Frame this rectangle, in the files' mm, y up.")
      .optional(),
    maxPixels: s
      .integer()
      .min(256)
      .max(16384)
      .describe(`Longest PNG edge in pixels; default ${RENDER_DEFAULT_MAX_PIXELS}.`)
      .optional()
  }),
  examples: [
    { args: {}, note: 'the set in fab/' },
    { args: { layers: ['F.Cu', 'Edge.Cuts'] }, note: 'front copper and outline' }
  ],
  request: (args) => ({
    kind: 'render-gerbers',
    ...(args.board ? { board: args.board } : {}),
    ...(args.directory ? { directory: args.directory } : {}),
    ...(args.layers ? { layers: args.layers } : {}),
    ...(args.box ? { box: args.box } : {}),
    maxPixels: args.maxPixels ?? RENDER_DEFAULT_MAX_PIXELS
  })
})
