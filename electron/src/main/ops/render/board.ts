/**
 * `render.board` — a picture of the board, for a model that cannot see it.
 *
 * The board-shaped sibling of `render.schematic`: the same audit step, one document
 * over. What text cannot say about a layout is whether it *reads* — whether a
 * part sits where its airwires want it, whether two packages collide, whether
 * the copper goes where `board.describe` says it does.
 *
 * It draws the parsed board into an off-screen target sized from the request
 * (`lib/engine/boardCapture.ts`), never the editor's own scene: a picture is an
 * audit of the document, and the editor's scene carries the session's
 * selection, active layer and any route in flight. Nothing is drawn to a
 * visible canvas and no tab changes, so the person's view never moves.
 *
 * Unlike the other 2D renders it takes how to draw as well as what to frame:
 * every layer at full strength with every pour filled reads as mud, so the
 * caller names its layers, zones draw as outlines unless asked, and an active
 * layer can stand over the dimmed rest as it does on the canvas.
 */
import { invalidArgs } from '../errors'
import { defineDesignOp } from '../registry'
import { s } from '../schema'
import { RENDER_DEFAULT_MAX_PIXELS } from './schematic'
import { BOARD_FILE } from '../fileArgs'
import { viewportArg } from '../viewport/open'
import { actionArg } from '../viewport/action'

/** The canvas's non-active dim (`DIM_ALPHA_FACTOR`, `renderer/src/lib/kicad/layers.ts`); change both together. */
const CANVAS_DIM = 0.3

export const renderBoard = defineDesignOp({
  name: 'render.board',
  scope: 'board',
  mutates: false,
  summary: 'Render chosen board layers to a PNG, whole or framed on named footprints.',
  guidance:
    "Draws the board as the PCB editor does (copper, silkscreen, pads, zone outlines, ratsnest) from the file or the tab's unsaved buffer; the editor's view and selection are untouched. Pass layers or preset, not both. A whole board at the default size shows layout, not pad numbers: to read detail, name footprints or a box rather than raising maxPixels.",
  input: s.object({
    board: s
      .string()
      .trim()
      .describe(`${BOARD_FILE}; omit for the project's one board.`)
      .optional(),
    footprints: s
      .array(s.string().trim())
      .min(1)
      .describe('Frame these references with a margin, e.g. ["U2", "C1"].')
      .optional(),
    box: s
      .object({ x: s.number(), y: s.number(), width: s.number(), height: s.number() })
      .describe('Frame this rectangle, board mm, y down; wins over footprints.')
      .optional(),
    side: s
      .enum(['front', 'back'] as const)
      .describe(
        "back mirrors the board, as the editor's flip does, to read back-side placement; frame stays in board coordinates. Default back for the back preset, else front."
      )
      .optional(),
    layers: s
      .array(s.string().trim())
      .min(1)
      .describe(
        'These layers, e.g. ["In1.Cu", "Edge.Cuts"]; vias draw with any copper they reach, the ratsnest only with copper. Required unless preset.'
      )
      .optional(),
    preset: s
      .enum(['front', 'back', 'copper', 'silk', 'all'] as const)
      .describe(
        'A fixed layer list; required unless layers. front: F.Cu, F.SilkS, F.Fab, F.CrtYd, Edge.Cuts. back: the same on B. copper: every copper layer the board has, Edge.Cuts. silk: F. and B. SilkS, Fab, CrtYd and Mask (pads as their mask openings), Edge.Cuts. all: every layer.'
      )
      .optional(),
    fills: s
      .boolean()
      .describe(
        'Pour zone fills as stored, stale ones included. Default false: zones draw as outlines.'
      )
      .optional(),
    activeLayer: s
      .string()
      .trim()
      .describe(
        'Draw this layer on top and dim the rest, as the editor does for its active layer; one of the layers drawn.'
      )
      .optional(),
    dim: s
      .number()
      .min(0)
      .max(1)
      .describe(
        `How much of each other layer survives, 0 to 1; only with activeLayer. Default ${CANVAS_DIM}, the editor's dimming.`
      )
      .optional(),
    maxPixels: s
      .integer()
      .min(256)
      .max(16384)
      .describe(
        `Longest PNG edge in pixels; default ${RENDER_DEFAULT_MAX_PIXELS}. Capped by the GPU, which the answer reports. Vision models downscale past about 1600, so frame smaller instead.`
      )
      .optional(),
    viewport: viewportArg,
    action: actionArg
  }),
  examples: [
    {
      args: { preset: 'front', viewport: 'viewport-2', action: 'Review placement' },
      note: 'whole board placement, too small for pads'
    },
    {
      args: { preset: 'front', footprints: ['U2'], viewport: 'viewport-2', action: 'Review U2' },
      note: 'one part and its surroundings'
    },
    {
      args: {
        preset: 'copper',
        activeLayer: 'B.Cu',
        viewport: 'viewport-2',
        action: 'Review back copper'
      },
      note: 'back routing over the other copper'
    }
  ],
  request(args) {
    if (!args.layers && !args.preset)
      return invalidArgs(
        'Pass `layers` or `preset` to say what to draw.',
        '/preset',
        'Send preset "front" for placement or "copper" for routing, or layers with the layer names.'
      )
    if (args.layers && args.preset)
      return invalidArgs(
        '`layers` and `preset` both say what to draw; pass one.',
        '/preset',
        'Drop preset to draw exactly the layers named, or drop layers to draw the preset.'
      )
    if (args.dim !== undefined && !args.activeLayer)
      return invalidArgs(
        '`dim` sets how far the layers other than `activeLayer` fade, and no activeLayer was given.',
        '/dim',
        'Pass activeLayer with dim, or drop dim.'
      )
    const side = args.side ?? (args.preset === 'back' ? 'back' : 'front')
    return {
      kind: 'render-board',
      ...(args.board ? { board: args.board } : {}),
      ...(args.footprints ? { footprints: args.footprints } : {}),
      ...(args.box ? { box: args.box } : {}),
      ...(side === 'back' ? { side: 'back' as const } : {}),
      ...(args.layers ? { layers: args.layers } : {}),
      ...(args.preset ? { preset: args.preset } : {}),
      ...(args.fills ? { fills: true } : {}),
      ...(args.activeLayer ? { activeLayer: args.activeLayer } : {}),
      ...(args.activeLayer ? { dim: args.dim ?? CANVAS_DIM } : {}),
      maxPixels: args.maxPixels ?? RENDER_DEFAULT_MAX_PIXELS
    }
  }
})
