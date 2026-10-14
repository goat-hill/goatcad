/**
 * `schematic.wire` — a drawn line between two pins or points.
 *
 * Design: `docs/agent-api.md`. `connect` is
 * netlist-correct and draws nothing; this is what a reader expects to see
 * between a part and the passive beside it. Straight or one bend, leaving a
 * pin along its free side, with the junction dots KiCad's rules require. A run
 * that would cross another symbol or pass over another pin is refused rather
 * than drawn — the first draws over a part, the second is a connection KiCad
 * would make and nothing here would show. So is a run along another net's
 * wire, and one that would join two named nets (the merge `connect`
 * refuses); a segment already on the sheet is not drawn twice, and the sheet is
 * tidied after the draw (`lib/schematic/wireCleanup.ts`).
 */
import { defineDesignOp } from '../registry'
import { s } from '../schema'
import { refused } from '../errors'
import { checksArg } from '../checksArg'
import { viewportArg } from '../viewport/open'
import { actionArg } from '../viewport/action'
import { sheetFileArg } from '../fileArgs'

const wireEnd = s.object({
  pin: s
    .string()
    .trim()
    .describe(
      'Pin id, <reference>.<pad>, e.g. "C8.1"; a sheet pin by its item id, <sheet id>#<pin name>.'
    )
    .optional(),
  x: s.number().optional(),
  y: s.number().optional()
})

export const schematicWire = defineDesignOp({
  name: 'schematic.wire',
  scope: 'schematic',
  mutates: true,
  summary: 'Draw a wire or bus between two pins or points on a sheet, straight or with one bend.',
  guidance:
    "One undo step on the sheet's tab. Points are sheet mm on the 2.54 mm grid. Aligned ends draw straight; otherwise one bend, leaving a pin along its free side. Refused, naming the obstacle, when the run crosses another symbol or another pin's connection point: move the part with items_update, or wire in two runs through a free point. Also refused along another net's wire, and when it joins two named nets unless merge is true. Existing segments are not redrawn; overlaps are joined and junction dots added, counted in the answer's `cleanup`. Use wires within a block and schematic_connect labels between blocks. Bus: drawn as the editor's bus tool draws, with no dots and no tidy; name it with a label on it (items_create, text such as D[0..7] or {SDA SCL}) and join each member with a bus_entry, a wire and a label of the member's name.",
  input: s.object({
    sheet: sheetFileArg(),
    start: wireEnd.describe('First end: pin, or x and y in sheet mm.'),
    end: wireEnd.describe('Second end: pin, or x and y in sheet mm.'),
    posture: s
      .enum(['hv', 'vh'] as const)
      .describe('At a bend, which leg comes first (hv: horizontal). Default: chosen from the pins.')
      .optional(),
    merge: s
      .boolean()
      .describe(
        'Allow joining two already-named nets. Default false: refused, naming both, unless every name on both comes from sheet pins and hierarchical labels of one spelling.'
      )
      .optional(),
    bus: s
      .boolean()
      .describe(
        'Draw a bus: ends are points or sheet pins, never a symbol pin. Default false, a wire.'
      )
      .optional(),
    viewport: viewportArg,
    action: actionArg,
    checks: checksArg
  }),
  examples: [
    {
      args: {
        start: { pin: 'U3.2' },
        end: { pin: 'C8.1' },
        viewport: 'viewport-1',
        action: 'Wire U3.2 to C8.1'
      },
      note: 'supply pin to its decoupling capacitor'
    },
    {
      args: {
        start: { pin: 'C8.2' },
        end: { x: 248.92, y: 58.42 },
        viewport: 'viewport-1',
        action: 'Wire C8.2 up'
      },
      note: 'pin to a point'
    },
    {
      args: {
        start: { x: 152.4, y: 76.2 },
        end: { x: 152.4, y: 127 },
        bus: true,
        viewport: 'viewport-1',
        action: 'Draw the data bus'
      },
      note: 'a bus between two points'
    }
  ],
  request(args) {
    if (args.bus && args.merge)
      return refused(
        'merge is for wires; a bus joins by the names on it.',
        'Drop merge, or rename the labels on the buses.'
      )
    for (const [name, value] of [
      ['start', args.start],
      ['end', args.end]
    ] as const) {
      const hasPin = Boolean(value.pin)
      const hasPoint = value.x !== undefined && value.y !== undefined
      if (hasPin === hasPoint) {
        return refused(
          `${name} needs either pin or both x and y.`,
          'Name the pin the wire ends on, or give a point in sheet millimeters.'
        )
      }
    }
    return {
      kind: 'draw-wire',
      start: args.start,
      end: args.end,
      ...(args.sheet ? { sheet: args.sheet } : {}),
      ...(args.posture ? { posture: args.posture } : {}),
      ...(args.merge ? { merge: true } : {}),
      ...(args.bus ? { bus: true } : {})
    }
  }
})
