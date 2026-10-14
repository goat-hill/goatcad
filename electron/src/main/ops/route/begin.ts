/**
 * `route.begin` — start routing a track with the PCB editor's interactive
 * router, as the route tool's first click does.
 *
 * Design: docs/agent-api.md, "Routing sessions". The window keeps
 * the session (`renderer/src/lib/board/routeAgent.ts` over the editor's own
 * `RouteController`), so later calls propose from the same router state a
 * person's mouse would.
 */
import { defineDesignOp } from '../registry'
import { s } from '../schema'
import {
  maxPixelsArg,
  renderArg,
  settingsArg,
  viaRowArg,
  viaSizeArg,
  viewArg,
  widthArg,
  widthRowArg
} from './args'
import { BOARD_FILE } from '../fileArgs'
import { viewportArg } from '../viewport/open'
import { actionArg } from '../viewport/action'

/** A routing picture's longest edge; the window's own fallback is `ROUTE_DEFAULT_MAX_PIXELS` (boardAgent.ts). */
export const ROUTE_MAX_PIXELS = 768

export const routeBegin = defineDesignOp({
  name: 'route.begin',
  scope: 'board',
  mutates: false,
  summary:
    "Start a routing session: a track begun at a pad, via, track end or point, with the editor's router.",
  guidance:
    "Writes nothing of its own; route_step moves, clicks and commits, route_preview compares candidates. The start takes its copper's net and layer, as the route tool's click does. Sizes follow the GUI: the rules' for the layer (net class, tuning profile), then the board's lists by row, then a value. From a pad the head leaves by the pad's exit facing the cursor; to steer it, aim at that way and click a short stub, flip it with posture: \"flip\", or set settings.smartPads false. The session keeps one route at a time per board. It ends on a new begin, after 10 idle minutes or when its viewport closes, and what it had clicked lands as one undo step, as Esc does; the answer that ends it, else the next begin on the board (ended) or step, says what landed. Its viewport's box follows the head and stays open after the session. targets lists the net's copper not yet joined. Board mm, y down.",
  input: s.object({
    board: s
      .string()
      .trim()
      .describe(`${BOARD_FILE}; omit for the project's one board.`)
      .optional(),
    start: s
      .string()
      .trim()
      .describe('Start on a pad, via or track (its start) by id, e.g. U1.3.')
      .optional(),
    at: s
      .object({ x: s.number(), y: s.number() })
      .describe('Start at a point, board mm, y down; snapped as grid.snap says.')
      .optional(),
    net: s.string().trim().describe("The route's net; default the start copper's.").optional(),
    layer: s
      .string()
      .trim()
      .describe('The copper layer to start on; default the first.')
      .optional(),
    width: widthArg,
    widthRow: widthRowArg,
    viaSize: viaSizeArg,
    viaRow: viaRowArg,
    pair: s
      .object({
        row: s
          .integer()
          .min(0)
          .describe(
            "A row of the pair size list (pair.sizes); 0, the default, is the rules' for the layer: net class or tuning profile."
          )
          .optional(),
        width: s.number().min(0.01).describe('Typed track width, mm; with gap.').optional(),
        gap: s.number().min(0.01).describe('Typed gap between the halves, mm.').optional(),
        viaGap: s.number().min(0.01).describe('Gap between a via pair, mm; default gap.').optional()
      })
      .describe(
        "Route a differential pair (the editor's 6) from start or at: copper of a net named as a pair half; {} draws at the sizes its rules give each layer. Both halves route as one line, arriving over the far pads."
      )
      .optional(),
    tune: s
      .object({
        mode: s
          .enum(['single', 'pair', 'skew'] as const)
          .describe("The editor's 7, 8 or 9: one track's length, a pair's, or a pair half's skew."),
        target: s
          .number()
          .describe(
            "mm; a length, or for skew the difference to its partner. Default the net's length or skew rule."
          )
          .optional(),
        overrideRules: s.boolean().describe('target wins over the net rule.').optional(),
        minAmplitude: s.number().min(0).describe('Least meander height, mm.').optional(),
        maxAmplitude: s.number().min(0).describe('Greatest meander height, mm.').optional(),
        spacing: s.number().min(0.01).describe('Between meanders, mm.').optional(),
        cornerRadiusPercent: s
          .number()
          .min(0)
          .max(100)
          .describe('Corner rounding: 0 square, 100 fully round.')
          .optional(),
        singleSided: s.boolean().describe('Meanders on one side of the track only.').optional()
      })
      .describe(
        "Tune the straight track at start (grabbed at its start) or at (grabbed there) instead of routing. route_step's at sets where the meanders end, a click lays them, tuned answers the length. Meander settings default to the project's for the mode (board_update_setup tuningPatterns)."
      )
      .optional(),
    settings: settingsArg,
    grid: s
      .object({
        spacing: s.number().min(0.001).describe("mm; default the user's board grid.").optional(),
        snap: s
          .enum(['copper', 'grid', 'none'] as const)
          .describe(
            "copper (default): onto pads and track ends within a step, else the grid. Mid-route a grid point takes the start's x or y where that is nearer, as the route tool's does, so a route from an off-grid pad keeps its axis. A move fixes no corner; none keeps points exact."
          )
          .optional()
      })
      .describe("The session's grid, from the board's grid origin.")
      .optional(),
    view: viewArg,
    render: renderArg,
    maxPixels: maxPixelsArg(ROUTE_MAX_PIXELS),
    viewport: viewportArg,
    action: actionArg
  }),
  examples: [
    {
      args: { start: 'U1.3', viewport: 'viewport-2', action: 'Route U1.3' },
      note: 'start on a pad'
    },
    {
      args: { start: 'J1.2', pair: {}, viewport: 'viewport-2', action: 'Route USB_D+/-' },
      note: 'a differential pair from a pad of one half'
    },
    {
      args: {
        at: { x: 120.5, y: 84 },
        tune: { mode: 'single', target: 42 },
        viewport: 'viewport-2',
        action: 'Tune CLK'
      },
      note: 'tune the track under a point to 42 mm'
    }
  ],
  request: (args) => ({
    kind: 'begin-route',
    ...(args.board ? { board: args.board } : {}),
    ...(args.start !== undefined ? { start: args.start } : {}),
    ...(args.at ? { at: args.at } : {}),
    ...(args.net !== undefined ? { net: args.net } : {}),
    ...(args.layer !== undefined ? { layer: args.layer } : {}),
    ...(args.width !== undefined ? { width: args.width } : {}),
    ...(args.widthRow !== undefined ? { widthRow: args.widthRow } : {}),
    ...(args.viaSize ? { viaSize: args.viaSize } : {}),
    ...(args.viaRow !== undefined ? { viaRow: args.viaRow } : {}),
    ...(args.pair ? { pair: args.pair } : {}),
    ...(args.tune ? { tune: args.tune } : {}),
    ...(args.settings ? { settings: args.settings } : {}),
    ...(args.grid ? { grid: args.grid } : {}),
    ...(args.view ? { view: args.view } : {}),
    ...(args.render ? { render: true, maxPixels: args.maxPixels ?? ROUTE_MAX_PIXELS } : {}),
    viewport: args.viewport
  })
})
