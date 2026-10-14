/**
 * `schematic.add_sheet` — a hierarchical sheet on this page, and the file
 * behind it.
 *
 * Design: `docs/agent-api.md`. The largest cost in
 * the first design done from outside this repo was five functional blocks
 * fitted onto one page: the machinery for sheets was all present — the parser,
 * the resolver, the editor's own sheet tool — and none of it was reachable.
 *
 * Two writes, only one of them undoable: the child file is created on disk (as
 * the sheet tool does, and as `project.create` would), then the `(sheet ...)`
 * node lands on the open page as one history entry. A failure to create the
 * file stops before the node is written, so the page never names a file that
 * is not there.
 */
import { defineDesignOp } from '../registry'
import { LABEL_SHAPES } from '../../../shared/itemRecords'
import { s } from '../schema'
import { refused } from '../errors'
import { checksArg } from '../checksArg'
import { viewportArg } from '../viewport/open'
import { actionArg } from '../viewport/action'
import { sheetFileArg } from '../fileArgs'

const SIDES = ['left', 'right', 'top', 'bottom'] as const

export const schematicAddSheet = defineDesignOp({
  name: 'schematic.add_sheet',
  scope: 'schematic',
  mutates: true,
  summary: 'Add a hierarchical sheet to a schematic page and create the child file behind it.',
  guidance:
    'Use one sheet per functional block once a design has more than two. The child file is written to disk beside this one and opened as a tab; name it with `sheet` in later calls. The sheet box is one undo step on this page; the file is not undone. Each pin needs a hierarchical label of the same name inside the child: items_create on the child with kind "label", labelKind "hierarchical". Give pins to signals only; power symbols and global labels already join rails across sheets. Position and size default to free space and a box that fits the pins.',
  input: s.object({
    name: s.string().trim().describe('Block name shown on the sheet box, e.g. "Power".'),
    file: s
      .string()
      .trim()
      .describe(
        'Child file name, e.g. "power.kicad_sch". Default: the name, lowercased. Refused when another file has that name.'
      )
      .optional(),
    at: s
      .object({ x: s.number(), y: s.number() })
      .describe(
        'Top-left corner in sheet mm, on the 2.54 mm grid. Off the 1.27 mm grid is refused with the nearest valid point. Default: free space.'
      )
      .optional(),
    size: s
      .object({ width: s.number(), height: s.number() })
      .describe('Box size in mm. Default: fits the pins.')
      .optional(),
    pins: s
      .array(
        s.object({
          name: s
            .string()
            .trim()
            .describe('Signal name; matches a hierarchical label in the child.'),
          shape: s
            .enum(LABEL_SHAPES)
            .describe('Signal direction seen from the child. Default "passive".')
            .optional(),
          side: s
            .enum(SIDES)
            .describe('Edge of the box. Default: right for an output, left otherwise.')
            .optional()
        })
      )
      .describe("Signals crossing the block's boundary, one pin each.")
      .optional(),
    sheet: sheetFileArg('The parent sheet. '),
    viewport: viewportArg,
    action: actionArg,
    checks: checksArg
  }),
  examples: [
    {
      args: {
        name: 'Sensors',
        pins: [
          { name: 'I2C_SCL', shape: 'bidirectional', side: 'left' },
          { name: 'I2C_SDA', shape: 'bidirectional', side: 'left' },
          { name: 'ALERT', shape: 'output', side: 'right' }
        ],
        viewport: 'viewport-1',
        action: 'Add the Sensors sheet'
      },
      note: 'a block with I2C in and an alert out'
    }
  ],
  request(args) {
    if (args.file !== undefined && !/\.kicad_sch$/i.test(args.file)) {
      return refused(
        `A sheet file is a .kicad_sch: ${args.file}`,
        `Pass "${args.file}.kicad_sch", or omit file and let the name decide.`
      )
    }
    const names = new Set<string>()
    for (const pin of args.pins ?? []) {
      if (names.has(pin.name)) {
        return refused(
          `Two pins are called ${pin.name}.`,
          'A sheet pin names a signal, and one signal crosses the boundary once.'
        )
      }
      names.add(pin.name)
    }
    return {
      kind: 'add-sheet',
      name: args.name,
      ...(args.file ? { file: args.file } : {}),
      ...(args.at ? { at: args.at } : {}),
      ...(args.size ? { size: args.size } : {}),
      ...(args.pins ? { pins: args.pins } : {}),
      ...(args.sheet ? { sheet: args.sheet } : {})
    }
  }
})
