/**
 * `render.schematic` — a picture of the sheet, for a model that cannot see it.
 *
 * Design: `docs/agent-api.md`. Everything else on
 * this surface answers in text, and for facts — what is placed, what is on
 * which net, what a check found — text is the better answer: exact and cheap.
 * What text cannot say is whether the drawing *reads*: whether a label sits
 * over a body, whether the passives are anywhere near the part they serve,
 * whether an engineer would accept the sheet. That is what this is for. It is
 * the audit step, not the working one.
 *
 * It draws into an off-screen target sized from the request, so the picture is
 * what the editor would draw, at the resolution asked for rather than the
 * window's. The active tab is drawn from its editor's own scene; any other
 * sheet from a scene the window keeps for documents with no editor
 * (`lib/engine/schematicCapture.ts`). Nothing is drawn to a visible canvas and
 * no tab changes, so the person's view never moves.
 */
import { defineDesignOp } from '../registry'
import { s } from '../schema'
import { sheetFileArg } from '../fileArgs'
import { viewportArg } from '../viewport/open'
import { actionArg } from '../viewport/action'

/** Longer edge of the PNG when the caller does not say. Enough to read pin
 *  names on a dense part at full-sheet zoom, small enough to be one image. */
export const RENDER_DEFAULT_MAX_PIXELS = 1600

export const renderSchematic = defineDesignOp({
  name: 'render.schematic',
  scope: 'schematic',
  mutates: false,
  summary: 'Render a schematic sheet to PNG or SVG, whole or framed on symbols or a box.',
  guidance:
    "Use it to check how the drawing reads; facts come from schematic_describe. Draw a sheet one block at a time: after placing and wiring a block, render it by box and look for text through a body, overlapping labels, a passive away from the pin it serves, a wire crossing a body, a dangling end and an open pin without a no-connect; fix them before the next block. The answer gives the frame in sheet mm. A whole sheet shows layout only; its text does not resolve at the default size. To read text, frame symbols or a box rather than raising maxPixels. The user's view does not move; a sheet no tab holds opens behind the active one.",
  input: s.object({
    sheet: sheetFileArg(),
    symbols: s
      .array(s.string().trim())
      .min(1)
      .describe('References to frame with a margin, e.g. ["U1", "C8"].')
      .optional(),
    box: s
      .object({ x: s.number(), y: s.number(), width: s.number(), height: s.number() })
      .describe('Rectangle to frame, in sheet mm. Wins over symbols.')
      .optional(),
    maxPixels: s
      .integer()
      .min(256)
      .max(16384)
      .describe(
        `Longest PNG edge in pixels. Default ${RENDER_DEFAULT_MAX_PIXELS}. Past what the GPU can draw, the answer says what it did.`
      )
      .optional(),
    format: s
      .enum(['png', 'svg'] as const)
      .describe(
        'Default "png", to look at. "svg" is vector for export, one unit per mm; a whole sheet runs to hundreds of kilobytes.'
      )
      .optional(),
    background: s
      .boolean()
      .describe('SVG only: paint the editor background. Default true; false is transparent.')
      .optional(),
    viewport: viewportArg,
    action: actionArg
  }),
  examples: [
    {
      args: { viewport: 'viewport-1', action: 'Review the sheet' },
      note: 'whole sheet, layout only'
    },
    {
      args: {
        symbols: ['U1', 'C8', 'C9'],
        viewport: 'viewport-1',
        action: 'Review U1 and its caps'
      },
      note: 'one part and its decoupling'
    }
  ],
  request(args) {
    return {
      kind: 'render-sheet',
      ...(args.sheet ? { sheet: args.sheet } : {}),
      ...(args.symbols ? { symbols: args.symbols } : {}),
      ...(args.box ? { box: args.box } : {}),
      maxPixels: args.maxPixels ?? RENDER_DEFAULT_MAX_PIXELS,
      ...(args.format ? { format: args.format } : {}),
      ...(args.background !== undefined ? { background: args.background } : {})
    }
  }
})
