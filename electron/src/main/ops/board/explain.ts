/**
 * `board.explain_limits` — the limits the rules set on one board item or
 * between two, each with the rule that set it and the resolver's steps
 * (`renderer/src/lib/board/rules/explain.ts`).
 */
import { defineDesignOp } from '../registry'
import { s } from '../schema'
import { BOARD_FILE } from '../fileArgs'

export const boardExplainLimits = defineDesignOp({
  name: 'board.explain_limits',
  scope: 'board',
  mutates: false,
  summary:
    'Explain the clearances and sizes the rules require of one board item or between two, and which rule set each.',
  guidance:
    "Two items: clearance per shared copper layer (0 between copper of one net), how a pad joins a zone of its net, and hole clearance and hole to hole where they have holes. One item: a track's width, a via's diameter, annular width and hole, a drilled pad's annular width and hole. source names what set the value: a rule, a pad's or footprint's own clearance, the board minimum. steps lists what the resolver weighed, in order. Millimeters.",
  input: s.object({
    board: s
      .string()
      .trim()
      .describe(`${BOARD_FILE}; omit for the project's one board.`)
      .optional(),
    items: s
      .array(s.string().trim().min(1))
      .min(1)
      .max(2)
      .describe('One or two item ids, as items_get takes them.'),
    layer: s.string().trim().describe('Only this copper layer, e.g. "F.Cu".').optional()
  }),
  examples: [
    { args: { items: ['U1.3', 'R2.1'] }, note: 'clearance between two pads' },
    { args: { items: ['4f1c…'] }, note: "a track's width" }
  ],
  request: (args) => ({
    kind: 'explain-board-limits',
    ...(args.board ? { board: args.board } : {}),
    items: args.items,
    ...(args.layer ? { layer: args.layer } : {})
  })
})
