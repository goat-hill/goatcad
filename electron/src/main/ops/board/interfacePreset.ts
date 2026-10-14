/**
 * `board.apply_interface_preset` — Board Setup's Apply interface preset, as a verb.
 *
 * The plan is `renderer/src/lib/board/interfacePresets.ts`: an interface's
 * impedance and budgets as a tuning profile solved over the board's stackup, a
 * net class naming it, the patterns that put nets in it and a block of custom
 * rules. The preset never looks for its nets; the caller names them.
 */
import { defineDesignOp } from '../registry'
import { s } from '../schema'
import { BOARD_FILE } from '../fileArgs'

export const boardApplyInterfacePreset = defineDesignOp({
  name: 'board.apply_interface_preset',
  scope: 'board',
  mutates: true,
  summary:
    "Apply an interface's layout budget to nets: a solved tuning profile, a net class and its rules.",
  guidance:
    "Name the nets with net class patterns after reading the schematic; nothing is inferred. A differential preset refuses nets KiCad would not pair (a P/N or +/- suffix), listing them. Writes the project file (profile, class, patterns) and the class's rules in .kicad_dru, named for the class, replacing those an earlier apply wrote; neither is undoable. Run with dryRun first: it answers each layer's width, gap, impedance and delay and the rules.",
  input: s.object({
    board: s
      .string()
      .trim()
      .describe(`${BOARD_FILE}; omit for the project's one board.`)
      .optional(),
    preset: s
      .enum(['usb2', 'rf-50', 'csi2', 'ethernet-mdi', 'rgmii'])
      .describe(
        'usb2: USB 2.0 data pair; rf-50: a 50 Ω coplanar RF feed; csi2: MIPI CSI-2 lanes and clock; ethernet-mdi: PHY-to-magnetics pairs; rgmii: one MII/RGMII group, TX or RX with its clock, applied once per group.'
      ),
    mode: s
      .string()
      .trim()
      .describe(
        "usb2: high (default), full, or full-uncontrolled (the board's sizes, no profile; departs from the spec's 90 Ω); rf-50: sub1g, 2g4 (default) or 5g; csi2: 1g0, 1g5 or 2g5 Gb/s per lane (default 2g5); ethernet-mdi and rgmii: 1g (default) or 100m."
      )
      .optional(),
    netClass: s
      .string()
      .trim()
      .min(1)
      .describe('The class the nets take, made from Default when new.'),
    patterns: s
      .array(s.string().trim().min(1))
      .min(1)
      .describe('Net class patterns, each matching at least one net, e.g. ["/USB_D*"].'),
    gap: s
      .number()
      .min(0)
      .describe(
        "A pair's gap, or a coplanar line's gap to its ground, mm; default the Default class clearance, never under the fab's minimum, widened until the width is buildable."
      )
      .optional(),
    width: s
      .number()
      .min(0)
      .describe(
        "The first layer's track width, mm; the gap is solved for it instead of the width. Wins over gap."
      )
      .optional(),
    layers: s
      .array(s.string().trim())
      .min(1)
      .describe('Signal layers the profile solves; default the outer copper.')
      .optional(),
    dryRun: s.boolean().describe('Answer with the plan and write nothing.').optional()
  }),
  examples: [
    {
      args: { preset: 'usb2', netClass: 'USB', patterns: ['/USB_D*'], dryRun: true },
      note: "the USB pair's sizes and rules"
    },
    {
      args: { preset: 'rf-50', netClass: 'RF', patterns: ['/ANT'], layers: ['F.Cu'] },
      note: 'an antenna feed on the top'
    }
  ],
  request: (args) => ({
    kind: 'apply-interface-preset',
    ...(args.board ? { board: args.board } : {}),
    preset: args.preset,
    ...(args.mode ? { mode: args.mode } : {}),
    netClass: args.netClass,
    patterns: args.patterns,
    ...(args.gap !== undefined ? { gap: args.gap } : {}),
    ...(args.width !== undefined ? { width: args.width } : {}),
    ...(args.layers ? { layers: args.layers } : {}),
    ...(args.dryRun ? { dryRun: true } : {})
  })
})
