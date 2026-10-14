/**
 * `footprint.compute_land_pattern` — the IPC standards' pads from a package drawing.
 *
 * A handshake read,
 * like `parts.list_filters`: it answers with a pad table the agent reads and
 * then passes to `footprint.create`, so the write never holds a pad
 * nobody saw. The density defaults to the project's.
 */
import { defineOp } from '../registry'
import { s } from '../schema'
import { design } from '../design'
import { projectFootprintStyle } from './create'

const tol = s
  .object({
    nominal: s.number().describe('Nominal, millimeters.').optional(),
    tolerance: s.number().min(0).describe('Plus or minus, millimeters.').optional(),
    min: s.number().describe('Minimum, millimeters.').optional(),
    max: s.number().describe('Maximum, millimeters.').optional()
  })
  .describe('A drawing dimension: nominal with tolerance, or min and max.')

type TolArg = { nominal?: number; tolerance?: number; min?: number; max?: number }
type Tol = { nominal: number; tolerance?: number } | { min: number; max: number }

/** A dimension in one of its two forms, or the reason it is neither. */
const toTol = (value: TolArg, path: string): Tol | string => {
  if (value.min !== undefined && value.max !== undefined) {
    if (value.nominal !== undefined || value.tolerance !== undefined) {
      return `${path}: pass min and max, or nominal and tolerance, not both.`
    }
    return value.max < value.min ? `${path}: max is below min.` : { min: value.min, max: value.max }
  }
  if (value.nominal !== undefined && value.min === undefined && value.max === undefined) {
    return {
      nominal: value.nominal,
      ...(value.tolerance !== undefined ? { tolerance: value.tolerance } : {})
    }
  }
  return `${path}: pass min and max, or nominal (with tolerance).`
}

export const footprintComputeLandPattern = defineOp({
  name: 'footprint.compute_land_pattern',
  scope: 'app',
  mutates: false,
  summary:
    "Compute IPC land pattern pads from a package drawing's dimensions, as a pad table for footprint_create.",
  guidance:
    "Only when the datasheet has no recommended land pattern; otherwise transcribe the vendor's. Read every dimension and tolerance off the package drawing, never from memory. body.x and span.x run across the left and right sides, whose pins are pins.y; pins.x counts the top and bottom rows. chip: body.x is the length, lead.length the terminal. grid: ball.diameter, pitch, pins.x columns by pins.y rows, empty positions in skip; land is IPC-7352's ratio of the ball. through_hole: lead.diameter or lead.width and thickness, pitch, pins.y per column, rowSpacing for two columns; only hole and land are computed. The answer is a read: check its pads and notes against the drawing before footprint_create.",
  input: s.object({
    leadType: s
      .enum(['gullwing', 'flat', 'no_lead', 'j_lead', 'chip', 'grid', 'through_hole'] as const)
      .describe(
        'gullwing: SOIC, QFP. j_lead: SOJ, PLCC. no_lead: QFN, DFN. flat: molded leads at the body edge. chip: two-terminal R and C. grid: BGA, WLCSP, LGA. through_hole: DIP, SIP, headers.'
      ),
    density: s
      .enum(['least', 'nominal', 'most'] as const)
      .describe(
        "IPC density (levels A, B, C = most, nominal, least): most for hand soldering, nominal for reflow, least for dense boards. Defaults to board-intent.md's."
      )
      .optional(),
    body: s
      .object({ x: tol, y: tol })
      .describe("Package body; x across the left and right sides, a chip's length."),
    span: s
      .object({ x: tol.optional(), y: tol.optional() })
      .describe('Lead tip to tip, for leads past the body (gullwing, j_lead).')
      .optional(),
    lead: s
      .object({
        width: tol.optional(),
        length: tol
          .describe(
            "Foot length along the axis, or a chip's terminal length. Required for surface mount."
          )
          .optional(),
        thickness: tol
          .describe(
            "A rectangular through-hole lead's other side; equal to width for a square pin."
          )
          .optional(),
        diameter: tol.describe('Round through-hole lead diameter.').optional()
      })
      .describe("Lead dimensions. A chip's width defaults to its body's. Not for a grid.")
      .optional(),
    pitch: s.number().min(0).describe('Lead pitch, millimeters. Not for a chip.').optional(),
    pins: s
      .object({
        x: s.integer().min(0).describe("Pins per top and bottom row; a grid's columns.").optional(),
        y: s
          .integer()
          .min(0)
          .describe("Pins per left and right column; a grid's rows; through-hole pins per column.")
          .optional()
      })
      .describe(
        'Pins per side: SOIC-8 { y: 4 }, QFN-20 { x: 5, y: 5 }, 10 × 10 BGA { x: 10, y: 10 }.'
      )
      .optional(),
    rowSpacing: s
      .number()
      .min(0)
      .describe(
        'through_hole: column center to center, millimeters (7.62 for a narrow DIP). Omit for one column.'
      )
      .optional(),
    numbering: s
      .enum(['ccw', 'zigzag'] as const)
      .describe(
        'Two-column through_hole. ccw (default): down the left, up the right (DIP). zigzag: alternating sides (headers).'
      )
      .optional(),
    ball: s
      .object({
        diameter: tol.describe('Ball diameter, or LGA land diameter.'),
        type: s
          .enum(['collapsible', 'non_collapsible'] as const)
          .describe(
            'collapsible (default): solder ball, land smaller than the ball. non_collapsible: column, hard ball or LGA, land larger.'
          )
          .optional()
      })
      .describe('grid only.')
      .optional(),
    skip: s
      .array(s.string())
      .describe(
        'grid: empty positions as seen from the top, e.g. "A1" or a block "E5:K11". Rows skip I, O, Q, S, X, Z.'
      )
      .optional(),
    exposedPad: s
      .object({ x: s.number().min(0), y: s.number().min(0) })
      .describe('Thermal pad size, millimeters; signal pads are kept 0.2 mm clear of it.')
      .optional()
  }),
  examples: [
    {
      args: {
        leadType: 'gullwing',
        body: { x: { nominal: 3.9, tolerance: 0.1 }, y: { min: 4.8, max: 5 } },
        span: { x: { nominal: 6, tolerance: 0.2 } },
        lead: { width: { min: 0.31, max: 0.51 }, length: { min: 0.4, max: 1.27 } },
        pitch: 1.27,
        pins: { y: 4 }
      },
      note: 'a SOIC-8 from JEDEC MS-012'
    },
    {
      args: {
        leadType: 'grid',
        body: { x: { nominal: 1.2, tolerance: 0.03 }, y: { nominal: 1.2, tolerance: 0.03 } },
        ball: { diameter: { nominal: 0.25, tolerance: 0.03 } },
        pitch: 0.4,
        pins: { x: 3, y: 3 },
        skip: ['B2']
      },
      note: 'a 3 × 3 WLCSP, no center ball'
    },
    {
      args: {
        leadType: 'through_hole',
        body: { x: { min: 6.1, max: 7.11 }, y: { min: 9.02, max: 10.16 } },
        lead: { width: { min: 0.36, max: 0.56 }, thickness: { min: 0.2, max: 0.36 } },
        pitch: 2.54,
        pins: { y: 4 },
        rowSpacing: 7.62
      },
      note: 'a DIP-8 from JEDEC MS-001'
    }
  ],
  async run(args, ctx) {
    const problems: string[] = []
    const read = (value: TolArg | undefined, path: string): Tol | undefined => {
      if (!value) return undefined
      const result = toTol(value, path)
      if (typeof result === 'string') {
        problems.push(result)
        return undefined
      }
      return result
    }
    const body = { x: read(args.body.x, 'body.x'), y: read(args.body.y, 'body.y') }
    const span = args.span
      ? { x: read(args.span.x, 'span.x'), y: read(args.span.y, 'span.y') }
      : undefined
    const lead = {
      width: read(args.lead?.width, 'lead.width'),
      length: read(args.lead?.length, 'lead.length'),
      thickness: read(args.lead?.thickness, 'lead.thickness'),
      diameter: read(args.lead?.diameter, 'lead.diameter')
    }
    const ballDiameter = read(args.ball?.diameter, 'ball.diameter')
    if (problems.length || !body.x || !body.y) {
      return {
        ok: false,
        error: {
          code: 'invalid-args',
          kind: 'bad-dimension',
          message: problems.join(' ') || 'A dimension is missing.',
          fix: 'Give each dimension as { nominal, tolerance } or { min, max }, as the drawing prints it.'
        }
      }
    }
    const style = projectFootprintStyle(ctx)
    return design(ctx, {
      kind: 'land-pattern',
      leadType: args.leadType,
      density: args.density ?? style.density,
      densitySource: args.density ? 'argument' : style.source,
      body: { x: body.x, y: body.y },
      lead: {
        ...(lead.length ? { length: lead.length } : {}),
        ...(lead.width ? { width: lead.width } : {}),
        ...(lead.thickness ? { thickness: lead.thickness } : {}),
        ...(lead.diameter ? { diameter: lead.diameter } : {})
      },
      ...(span && (span.x || span.y)
        ? { span: { ...(span.x ? { x: span.x } : {}), ...(span.y ? { y: span.y } : {}) } }
        : {}),
      ...(args.pitch !== undefined ? { pitch: args.pitch } : {}),
      ...(args.pins ? { pins: args.pins } : {}),
      ...(args.exposedPad ? { exposedPad: args.exposedPad } : {}),
      ...(args.rowSpacing !== undefined ? { rowSpacing: args.rowSpacing } : {}),
      ...(args.numbering ? { numbering: args.numbering } : {}),
      ...(ballDiameter
        ? { ball: { diameter: ballDiameter, ...(args.ball?.type ? { type: args.ball.type } : {}) } }
        : {}),
      ...(args.skip?.length ? { skip: args.skip } : {})
    })
  }
})
