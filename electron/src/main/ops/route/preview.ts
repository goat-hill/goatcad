/**
 * `route.preview` — several candidate gesture lists, each run from a routing
 * session's state without changing it, compared in one turn.
 *
 * Design: docs/agent-api.md, "Routing sessions"; the window replays
 * the session's log into a throwaway run per candidate
 * (`renderer/src/lib/board/routeAgent.ts`).
 */
import { defineDesignOp } from '../registry'
import { s } from '../schema'
import { actionArg } from '../viewport/action'
import { gestureArg, maxPixelsArg, renderArg, sessionArg } from './args'

/** Each candidate's tile; the window's fallback is `ROUTE_PREVIEW_TILE_PIXELS` (boardAgent.ts). */
export const ROUTE_PREVIEW_TILE = 512

export const routePreview = defineDesignOp({
  name: 'route.preview',
  scope: 'board',
  mutates: false,
  summary:
    "Run candidate gesture lists from a routing session's state and compare them; nothing changes.",
  guidance:
    'Each candidate answers its gesture results and the router state at its end; arrives: true where it would land the route. length is the track its own gestures laid, mm: clicked, finished or landed, and not undone; a head not clicked is not laid. commit, cancel and finish "here" are refused: step with the candidate to keep. With render, one picture holds a tile per candidate, left to right, all in one frame.',
  input: s.object({
    session: sessionArg,
    action: actionArg,
    candidates: s
      .array(s.array(gestureArg).min(1).max(64))
      .min(1)
      .max(4)
      .describe('Gesture lists, as route_step takes them.'),
    render: renderArg,
    maxPixels: maxPixelsArg(ROUTE_PREVIEW_TILE)
  }),
  examples: [
    {
      args: {
        session: 'route-1',
        action: 'Compare postures to U2.5',
        candidates: [[{ to: 'U2.5' }], [{ posture: 'flip' }, { to: 'U2.5' }]],
        render: true
      },
      note: 'the two postures to a pad'
    }
  ],
  request: (args) => ({
    kind: 'preview-route',
    session: args.session,
    candidates: args.candidates,
    ...(args.render ? { render: true, maxPixels: args.maxPixels ?? ROUTE_PREVIEW_TILE } : {})
  })
})
