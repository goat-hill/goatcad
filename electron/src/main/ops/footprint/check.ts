/**
 * `footprint.check` — KiCad's footprint checker over one footprint: a library
 * footprint, or the copy a board holds for a placed one.
 */
import { defineDesignOp } from '../registry'
import { s } from '../schema'
import { codesArg } from '../checksArg'
import { footprintTarget, isTargetRefusal } from '../items/footprint'
import { BOARD_FILE } from '../fileArgs'

export const footprintCheck = defineDesignOp({
  name: 'footprint.check',
  scope: 'project',
  mutates: false,
  summary:
    "Run KiCad's footprint checker over one footprint: silk, pads, layers, courtyard, text, pad numbers.",
  guidance:
    'One row per rule with the item ids it names (pad:<number> is a pad). A definition has no revision, so no since; a write with checks: true answers the delta. Rules between footprints on a board are board_check.',
  input: s.object({
    footprint: s
      .string()
      .trim()
      .describe(
        'A library id "Nickname:Name", or with board a placed reference ("U1") for the board\'s copy.'
      ),
    board: s
      .string()
      .trim()
      .describe(`With a reference: the board it is placed on. ${BOARD_FILE}.`)
      .optional(),
    codes: codesArg
  }),
  examples: [
    { args: { footprint: 'board:SOT-23-5' }, note: 'a project footprint' },
    { args: { footprint: 'J1', board: 'bitclock.kicad_pcb' }, note: "the board's copy of J1" }
  ],
  request(args) {
    const target = footprintTarget(args)
    if (isTargetRefusal(target)) return target
    return { kind: 'check-footprint', ...target, ...(args.codes ? { codes: args.codes } : {}) }
  }
})
