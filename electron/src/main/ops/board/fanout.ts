/**
 * `board.fanout` — one footprint's pads each taken to a via.
 *
 * Design: `docs/agent-api.md`; the pattern is
 * `renderer/src/lib/board/fanout.ts`, which the PCB editor's Fan out runs too.
 * A verb above `items.create` because it places many items atomically and
 * holds an invariant the model should not compute by hand: every via clears
 * the board's rules. The choices are the caller's (which pads, which style,
 * which way); the geometry is the rules'. A via that does not fit is refused
 * with the gap it measured, and the rest still land.
 */
import { defineDesignOp } from '../registry'
import { s } from '../schema'
import { checksArg } from '../checksArg'
import { viewportArg } from '../viewport/open'
import { actionArg } from '../viewport/action'
import { BOARD_FILE } from '../fileArgs'

export const boardFanout = defineDesignOp({
  name: 'board.fanout',
  lists: ['escapes', 'surface', 'skipped', 'refused'],
  scope: 'board',
  mutates: true,
  summary:
    'Fan out one footprint: give each pad a via and a short track, by dogbone, rows of vias or via-in-pad.',
  guidance:
    "One undo step on the board tab, unsaved. Fan out once placement is final, before routing. The board's clearances, hole rules and edge clearance are never loosened. Vias are the net class's unless overridden; stubs take its width, no wider than the pad. escapes lists each new via's id and position: route onward from there. A pad whose via would break a rule is under refused, with the measured gap; the rest still land. For each, choose a surface route, under-pads (via-in-pad, which costs more at the fab: tell the user), or a smaller via override. skipped names pads with nothing to fan out: joined, a pad whose own copper already reaches the rest of its net; via, one whose copper already reaches a via (zones read from their stored fills); surface, the rows surfaceRows kept. New vias report via-dangling until routed, and the zone fills go stale until board_refill. Run with dryRun first.",
  input: s.object({
    board: s
      .string()
      .trim()
      .describe(`${BOARD_FILE}; omit for the project's one board.`)
      .optional(),
    footprint: s.string().trim().describe('Footprint reference, e.g. U1.'),
    pads: s
      .array(s.string().trim())
      .min(1)
      .describe('Only these pads, e.g. U1.A1; default every pad with a net.')
      .optional(),
    nets: s
      .array(s.string().trim())
      .min(1)
      .describe('Only pads on these nets, e.g. ["GND", "+3V3"].')
      .optional(),
    style: s
      .enum(['auto', 'dogbone', 'under-pads', 'inline', 'staggered'] as const)
      .describe(
        "dogbone: a via between four balls (grids). under-pads: via-in-pad. inline / staggered: a via off each pad's end, in one line or alternating. auto (default): dogbone for grids, staggered for rows."
      )
      .optional(),
    direction: s
      .enum(['out', 'in', 'ne', 'se', 'sw', 'nw'] as const)
      .describe(
        "Where each via sits from its pad. out (default): away from the part's center; in: toward it; both fall back to another corner when taken. A compass corner (grids only) is fixed."
      )
      .optional(),
    surfaceRows: s
      .integer()
      .min(0)
      .max(8)
      .describe('Outer grid rows left without vias for surface routing; 2 is common for a BGA.')
      .optional(),
    via: s
      .object({
        size: s.number().min(0.05).describe('Diameter, mm.').optional(),
        drill: s.number().min(0.05).describe('Drill diameter, mm.').optional()
      })
      .describe("Override the net class's via.")
      .optional(),
    dryRun: s.boolean().describe('Answer with the fanout and write nothing.').optional(),
    viewport: viewportArg,
    action: actionArg,
    checks: checksArg
  }),
  examples: [
    {
      args: { footprint: 'U1', dryRun: true, viewport: 'viewport-2', action: 'Preview U1 fanout' },
      note: 'preview what lands and what is refused'
    },
    {
      args: { footprint: 'U1', surfaceRows: 2, viewport: 'viewport-2', action: 'Fan out U1' },
      note: 'a BGA, outer two rows left for the surface'
    },
    {
      args: {
        footprint: 'U3',
        nets: ['GND', '+3V3'],
        viewport: 'viewport-2',
        action: 'Fan out U3 power'
      },
      note: 'only the rails, down to their planes'
    }
  ],
  request: (args) => ({
    kind: 'fanout-board',
    footprint: args.footprint,
    ...(args.board ? { board: args.board } : {}),
    ...(args.pads ? { pads: args.pads } : {}),
    ...(args.nets ? { nets: args.nets } : {}),
    ...(args.style ? { style: args.style } : {}),
    ...(args.direction ? { direction: args.direction } : {}),
    ...(args.surfaceRows !== undefined ? { surfaceRows: args.surfaceRows } : {}),
    ...(args.via ? { via: args.via } : {}),
    ...(args.dryRun ? { dryRun: true } : {})
  })
})
