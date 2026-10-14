/**
 * `route.step` — gestures applied to a routing session, as the route tool's
 * mouse and hotkeys apply them: move, click, via, layer, posture, sizes,
 * Backspace, finish, commit or cancel.
 *
 * Design: docs/agent-api.md, "Routing sessions"; the window side is
 * `renderer/src/lib/board/routeAgent.ts`.
 */
import { defineDesignOp } from '../registry'
import { s } from '../schema'
import { actionArg } from '../viewport/action'
import { checksArg } from '../checksArg'
import { gesturesArg, maxPixelsArg, renderArg, sessionArg, viewArg } from './args'
import { ROUTE_MAX_PIXELS } from './begin'

export const routeStep = defineDesignOp({
  name: 'route.step',
  scope: 'board',
  mutates: true,
  summary:
    'Apply gestures to a routing session: move, click, via, layer, size, undo, finish or commit.',
  guidance:
    'Gestures mirror the route tool: { to } or { at } moves the cursor and the router proposes; { click: true } lays exactly that proposal, and a blocked one lays nothing. A click on unjoined copper of the net arrives and lands the route; so do commit, cancel (Esc: what was clicked), finish, and a click on the end of the route with a via armed. A landing is one undo step on the board tab, unsaved, and leaves every zone fill stale. It ends the step: the gestures after it are not applied (skipped counts them), and the session stays, ready for the next route. A gesture that fails puts the session back as it was. If the board was edited since the last call, the route is replayed over it (rebased).',
  input: s.object({
    session: sessionArg,
    action: actionArg,
    gestures: gesturesArg,
    view: viewArg,
    render: renderArg,
    maxPixels: maxPixelsArg(ROUTE_MAX_PIXELS),
    checks: checksArg
  }),
  examples: [
    {
      args: { session: 'route-1', action: 'Route to U2.5', gestures: [{ to: 'U2.5' }] },
      note: 'propose to a pad'
    },
    {
      args: {
        session: 'route-1',
        action: 'Corner, then a via',
        gestures: [{ at: { x: 121, y: 80 }, click: true }, { via: {} }]
      },
      note: 'click a corner, then arm a via'
    },
    {
      args: {
        session: 'route-1',
        action: 'Land the route',
        gestures: [{ commit: true }],
        checks: true
      },
      note: 'land it, checked'
    }
  ],
  request: (args) => ({
    kind: 'step-route',
    session: args.session,
    gestures: args.gestures,
    ...(args.view ? { view: args.view } : {}),
    ...(args.render ? { render: true, maxPixels: args.maxPixels ?? ROUTE_MAX_PIXELS } : {}),
    ...(args.checks ? { checks: true } : {})
  })
})
