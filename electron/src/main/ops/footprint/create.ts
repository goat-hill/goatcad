/**
 * `footprint.create` — a footprint for a part no library has.
 *
 * The boundary is the
 * symbol generator's: the agent supplies what only a datasheet reader can —
 * the pads, the body outline, pin 1 — and GoatCAD draws everything else to the
 * library's style. There is no style argument; the project's two choices come
 * from `board-intent.md` and are echoed in the answer.
 */
import { defineOp } from '../registry'
import { s } from '../schema'
import { refused } from '../errors'
import { design } from '../design'
import type { OpContext } from '../context'
import { readFootprintStyle, readProjectContext, type FootprintStyle } from '../../partsMcpProject'
import { FOOTPRINT_PAD_ROWS } from './get'

const mm = (text: string): ReturnType<typeof s.number> => s.number().describe(text)

const point = s.object({
  x: mm('Millimeters right of the origin.'),
  y: mm('Millimeters below the origin.')
})

export const padSchema = s.object({
  number: s
    .string()
    .trim()
    .describe(
      'Pad number as printed: "1", "A3", "MP" (mounting), "SH" (shield). Blank only for an unconnected mechanical hole.'
    ),
  type: s
    .enum(['smd', 'thru_hole', 'np_thru_hole'] as const)
    .describe('smd surface pad, thru_hole plated hole, np_thru_hole unplated hole.'),
  shape: s
    .enum(['rect', 'roundrect', 'circle', 'oval'] as const)
    .describe(
      'Pad shape. roundrect is the library default for a rectangular SMD pad (radius set for you); an exposed pad is usually rect.'
    ),
  at: s
    .object({
      x: mm('Center, millimeters.'),
      y: mm('Center, millimeters, y down.'),
      angle: s.number().describe('Degrees, counter-clockwise as drawn.').optional()
    })
    .describe("Pad center; origin at the part's center, y down."),
  size: s
    .object({
      width: s.number().min(0).describe('Along x before rotation, millimeters.'),
      height: s.number().min(0).describe('Along y before rotation, millimeters.')
    })
    .describe('Copper size.'),
  drill: s
    .object({
      diameter: s.number().min(0).describe('Finished hole, millimeters.'),
      oval: s
        .object({ width: s.number().min(0), height: s.number().min(0) })
        .describe('Slot size, millimeters, instead of a round hole.')
        .optional(),
      offset: point.describe('Hole offset from the pad center.').optional()
    })
    .describe('Required for thru_hole and np_thru_hole.')
    .optional(),
  layers: s
    .array(s.string())
    .describe(
      'Defaults: F.Cu F.Paste F.Mask for smd, *.Cu *.Mask for a hole. Pass to drop paste or put a pad on the back.'
    )
    .optional(),
  array: s
    .object({
      count: s.integer().min(2).describe('Pads in the row, this one included.'),
      dx: mm('Step along x, millimeters.'),
      dy: mm('Step along y, millimeters.'),
      numberStep: s
        .integer()
        .describe('Added to the number per pad. Defaults to 1; -1 counts down.')
        .optional()
    })
    .describe(
      'A row of identical pads starting at this one. The number must end in digits (7, A1).'
    )
    .optional()
})

/** The project's footprint choices, as the intent file states them. */
export const projectFootprintStyle = (ctx: OpContext): FootprintStyle =>
  readFootprintStyle(ctx.project ? readProjectContext(ctx.project).content : null)

export const footprintCreate = defineOp({
  name: 'footprint.create',
  scope: 'project',
  mutates: true,
  summary:
    "Draw a footprint for a part no library has from its land pattern, into the project's footprint library.",
  guidance:
    "You supply pads, body and pin 1; GoatCAD draws silk, pin 1 marker, courtyard, fab outline, texts, corner radii and layers in KiCad's library style, then checks it. It adds no pads. First footprint_search with the package and pitch; draw only when nothing matches or the vendor's pattern differs. Read pads from parts_read_datasheet: query 'recommended land pattern', then that page as an image. Transcribe every pad center and size in millimeters, origin at the part's center; never recall. With no recommended pattern, footprint_compute_land_pattern computes one. Name it as the library names neighbors ('QFN-20-1EP_3x3mm_P0.4mm_EP1.65x1.65mm'). Density and pin 1 marker come from board-intent.md, echoed in the answer. Opens the library as a tab behind.",
  input: s.object({
    name: s
      .string()
      .trim()
      .describe("Footprint name in its family's library pattern; also the file name."),
    library: s
      .string()
      .trim()
      .describe("Footprint library (.pretty) stem. Defaults to the project's own name.")
      .optional(),
    attributes: s
      .enum(['smd', 'tht'] as const)
      .describe('smd when every soldered pad is surface-mount, else tht.'),
    description: s.string().describe('One line: family, part, pitch, datasheet URL.').optional(),
    tags: s.string().describe('Space-separated search keywords.').optional(),
    datasheet: s.string().describe('Datasheet URL or the cached local path.').optional(),
    courtyard: s
      .enum(['default', 'connector', 'bga', 'crystal'] as const)
      .describe('Courtyard clearance class: default 0.25 mm, connector 0.5, crystal 0.5, bga 1.0.')
      .optional(),
    pads: s
      .array(padSchema)
      .min(1)
      .describe("Every pad on the land pattern, in footprint_get's record shape plus array."),
    body: s
      .object({
        rect: s
          .object({
            x: mm('Left edge, millimeters.'),
            y: mm('Top edge, millimeters.'),
            width: s.number().min(0).describe('Millimeters.'),
            height: s.number().min(0).describe('Millimeters.')
          })
          .describe('Rectangular outline.')
          .optional(),
        polygon: s.array(point).min(3).describe('Other outline, corners in order.').optional()
      })
      .describe(
        'Package outline from the top view, not the pad extent; exactly one of rect or polygon. Fab, silk and courtyard derive from it.'
      ),
    pin1: s
      .string()
      .trim()
      .describe('Pad number the drawing marks as pin 1. Required with more than one pad.')
      .optional(),
    symbol: s
      .string()
      .trim()
      .describe('Symbol id "Nickname:Name" whose pin numbers the answer compares with the pads.')
      .optional(),
    overwrite: s
      .boolean()
      .describe('Replace a footprint of the same name, discarding hand edits to it.')
      .optional()
  }),
  async run(args, ctx) {
    if (!args.name) {
      return refused(
        'name is required and must not be empty.',
        'Name the footprint the way the library names its neighbors.'
      )
    }
    const { rect, polygon } = args.body
    if ((rect ? 1 : 0) + (polygon ? 1 : 0) !== 1) {
      return refused(
        'body needs exactly one of rect or polygon.',
        'Pass the package outline from the top view: rect for a rectangular body, polygon for anything else.',
        { kind: 'bad-body' }
      )
    }
    return design(ctx, {
      kind: 'create-footprint',
      name: args.name,
      attributes: args.attributes,
      pads: args.pads,
      body: rect ? { rect } : { polygon: polygon ?? [] },
      ...(args.library ? { library: args.library } : {}),
      ...(args.description !== undefined ? { description: args.description } : {}),
      ...(args.tags !== undefined ? { tags: args.tags } : {}),
      ...(args.datasheet !== undefined ? { datasheet: args.datasheet } : {}),
      ...(args.courtyard ? { courtyard: args.courtyard } : {}),
      ...(args.pin1 !== undefined ? { pin1: args.pin1 } : {}),
      ...(args.symbol ? { symbol: args.symbol } : {}),
      ...(args.overwrite === true ? { overwrite: true } : {}),
      style: projectFootprintStyle(ctx),
      maxPads: FOOTPRINT_PAD_ROWS
    })
  }
})
