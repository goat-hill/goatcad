/**
 * `route.finish` — the PCB editor's Attempt Finish Selected (router-behavior.md
 * R46, KiCad's Autoroute Selected) from pads and vias by id.
 *
 * The window runs the editor's own finish (`RouteController.finishFrom`) along
 * each start's ratsnest lines in turn, over the board the last landing left
 * (`renderer/src/lib/board/boardAgent.ts`, `finishRoutes`).
 */
import { defineDesignOp } from '../registry'
import { s } from '../schema'
import { checksArg } from '../checksArg'
import { viewportArg } from '../viewport/open'
import { actionArg } from '../viewport/action'
import { settingsArg } from './args'
import { BOARD_FILE } from '../fileArgs'

export const routeFinish = defineDesignOp({
  name: 'route.finish',
  lists: ['arrived', 'dropped'],
  scope: 'board',
  mutates: true,
  summary:
    "Finish routes from pads and vias with the editor's Attempt Finish: each that arrives lands.",
  guidance:
    "From each start in turn, one route along each ratsnest line that ends on it, as the canvas draws them: begun at the start and finished as route_step's finish attempt does, toward the net's copper nearest the start on the start's layer. Each that arrives lands as its own undo step on the board tab, unsaved, and leaves every zone fill stale; each that does not is dropped, nothing of it kept. Sizes are a new route's, as route_begin's with none given. A start no ratsnest line ends on is dropped as joined. To steer a route, use route_begin and route_step.",
  input: s.object({
    board: s
      .string()
      .trim()
      .describe(`${BOARD_FILE}; omit for the project's one board.`)
      .optional(),
    starts: s
      .array(s.string().trim())
      .min(1)
      .max(256)
      .describe(
        'Pad, via or footprint ids, e.g. U1.3; a footprint stands for its pads with a net.'
      ),
    layer: s
      .string()
      .trim()
      .describe(
        'The copper layer a through pad or via routes on; default the first. An SMD pad routes on its own.'
      )
      .optional(),
    settings: settingsArg,
    viewport: viewportArg,
    action: actionArg,
    checks: checksArg
  }),
  examples: [
    {
      args: { starts: ['U1.3', 'U1.4'], viewport: 'viewport-2', action: 'Finish U1.3 and U1.4' },
      note: 'two pads'
    },
    {
      args: { starts: ['C4'], checks: true, viewport: 'viewport-2', action: 'Finish C4' },
      note: "a footprint's pads, checked"
    }
  ],
  request: (args) => ({
    kind: 'finish-routes',
    starts: args.starts,
    ...(args.board ? { board: args.board } : {}),
    ...(args.layer !== undefined ? { layer: args.layer } : {}),
    ...(args.settings ? { settings: args.settings } : {}),
    ...(args.checks ? { checks: true } : {})
  })
})
