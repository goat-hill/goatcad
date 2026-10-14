/**
 * The arguments the `route.*` ops share: a gesture, the session's view and its
 * router settings. Design: docs/agent-api.md, "Routing sessions";
 * the window side is `renderer/src/lib/board/routeAgent.ts`.
 */
import { s, type OptionalSchema, type Schema } from '../schema'

const point = (): Schema<{ x: number; y: number }> =>
  s.object({ x: s.number(), y: s.number() }).describe('A point, board mm, y down.')

const corner = (): Schema<'45' | 'arc45' | '90' | 'arc90'> =>
  s.enum(['45', 'arc45', '90', 'arc90'] as const)
const mode = (): Schema<'shove' | 'walkaround' | 'highlight'> =>
  s.enum(['shove', 'walkaround', 'highlight'] as const)

export const viaSizeArg = s
  .object({
    size: s.number().min(0.05).describe('Diameter, mm.'),
    drill: s.number().min(0.05).describe('mm.')
  })
  .describe("A via size; one of the list's rows is picked, any other is a custom size.")
  .optional()

export const widthArg = s
  .number()
  .min(0.01)
  .describe("Track width, mm; a list row's width picks the row, any other is a custom size.")
  .optional()

export const widthRowArg = s
  .integer()
  .min(0)
  .describe(
    "A row of the width list route_begin answers (widths); 0 is the rules' for the layer (net class, tuning profile). A pair: a row of pair.sizes."
  )
  .optional()

export const viaRowArg = s
  .integer()
  .min(0)
  .describe('A row of the via list route_begin answers (vias); 0 is the net class.')
  .optional()

/** One step of a route, as the route tool's mouse and hotkeys give it. */
export const gestureArg = s.object({
  to: s
    .string()
    .trim()
    .describe(
      'Move the cursor onto a pad, via or track by id (a track: its end nearest the head). A point goes in at.'
    )
    .optional(),
  at: point().optional(),
  click: s
    .boolean()
    .describe('Click where the cursor is: lay what the router proposed.')
    .optional(),
  via: s
    .object({
      type: s.enum(['through', 'blind', 'micro'] as const).optional(),
      to: s
        .string()
        .trim()
        .describe('The copper layer it goes to; default where V sends it.')
        .optional()
    })
    .describe(
      "Arm a via at the head; with no route, a start via. A click on the route's end then places it alone and ends the route (ended); any other click lays the head, places it where the head ends and goes on on its layer (laid). A pair: {} arms or disarms a via pair."
    )
    .optional(),
  layer: s
    .string()
    .trim()
    .describe('A copper layer, or next / prev. Mid-route it arms a via there.')
    .optional(),
  posture: s
    .enum(['flip'] as const)
    .describe("Flip the head's posture (/) until the next click; a flipped head takes no pad exit.")
    .optional(),
  corner: corner().describe('Corner mode from here on.').optional(),
  mode: mode().describe('Router mode from here on.').optional(),
  width: widthArg,
  widthRow: widthRowArg,
  viaSize: viaSizeArg,
  viaRow: viaRowArg,
  undo: s.boolean().describe('Take back the last click, or an armed via (Backspace).').optional(),
  finish: s
    .enum(['attempt', 'here'] as const)
    .describe(
      'attempt: route on to the unjoined copper nearest the head (F). here: lay the head and end (End), an armed via placed at its end.'
    )
    .optional(),
  commit: s
    .boolean()
    .describe('Land what was clicked as one undo step and end the route; an armed via is dropped.')
    .optional(),
  cancel: s
    .boolean()
    .describe(
      'End the route as Esc does: what was clicked lands as one undo step, the head is dropped.'
    )
    .optional()
})

export const gesturesArg = s
  .array(gestureArg)
  .min(1)
  .max(64)
  .describe('Applied in order. Each holds one action, or to/at with click.')

export const viewArg = s
  .object({
    layers: s
      .array(s.string().trim())
      .min(1)
      .describe('Layers drawn; default every layer.')
      .optional(),
    otherLayers: s
      .enum(['show', 'dim', 'hide'] as const)
      .describe('How layers other than the routed one draw; default dim.')
      .optional(),
    side: s
      .enum(['front', 'back'] as const)
      .describe('back mirrors, as the flip view.')
      .optional(),
    frame: s
      .object({
        x: s.number(),
        y: s.number(),
        width: s.number().min(0.1),
        height: s.number().min(0.1)
      })
      .describe('Frame this rectangle, board mm, y down.')
      .optional(),
    follow: s
      .number()
      .min(1)
      .max(500)
      .describe(
        'Margin, mm, added across the frame round the head and the route laid so far; default 12.'
      )
      .optional(),
    ratsnest: s.boolean().describe('Draw the ratsnest; default on.').optional(),
    highlight: s.boolean().describe('Dim all but the routed net; default on.').optional()
  })
  .describe('How pictures draw; kept for the session.')
  .optional()

export const renderArg = s.boolean().describe('Answer with a picture of the work.').optional()

export const maxPixelsArg = (fallback: number): OptionalSchema<number> =>
  s
    .integer()
    .min(128)
    .max(4096)
    .describe(`Longest PNG edge in pixels; default ${fallback}.`)
    .optional()

export const settingsArg = s
  .object({
    mode: mode().optional(),
    corner: corner().optional(),
    shoveVias: s.boolean().optional(),
    jumpOverObstacles: s.boolean().optional(),
    removeLoops: s.boolean().optional(),
    smartPads: s
      .boolean()
      .describe('Pad exits, in the 45° corner modes; false lets any bend leave a pad.')
      .optional(),
    autoPosture: s.boolean().optional(),
    startDiagonal: s.boolean().optional(),
    fixAllSegments: s.boolean().optional(),
    allowViolations: s.boolean().optional(),
    useConnectedWidth: s
      .boolean()
      .describe("A start on a track draws at its width; default the project's (.kicad_prl).")
      .optional()
  })
  .describe("Router settings for this session; default the user's, which are never written.")
  .optional()

export const sessionArg = s.string().trim().describe('The session route_begin answered.')
