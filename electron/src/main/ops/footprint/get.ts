/**
 * `footprint.get` — one footprint's pads, courtyard and 3D models: a library
 * footprint, or the copy a board holds for a placed one.
 *
 * The index holds a header scan of every footprint (name, description, pad
 * count, model paths); the pads themselves need the parser, which lives in
 * the renderer, so this is a design request served by the library door.
 */
import { defineDesignOp } from '../registry'
import { s } from '../schema'
import { refused } from '../errors'
import { footprintTarget, isTargetRefusal, modelFitArg } from '../items/footprint'
import { BOARD_FILE } from '../fileArgs'

/** Pads past this are counted, not listed — a BGA is hundreds of rows nobody
 *  reads, and the courtyard and the count are what a package check needs. */
export const FOOTPRINT_PAD_ROWS = 200

export const footprintGet = defineDesignOp({
  name: 'footprint.get',
  scope: 'project',
  mutates: false,
  summary:
    "Read one footprint's properties, pads, courtyard and fab boxes, and linked 3D models with their resolved files.",
  guidance: `Read it before writing a Footprint field: pad numbers must match the symbol's pin numbers. Millimeters in the footprint's own frame, y down, origin at its anchor; a board's copy is read in that frame too. Properties and pads are in the records items_get answers for "footprint" and each pad. A model with resolved null is linked but not installed. Pads past ${FOOTPRINT_PAD_ROWS} are counted, not listed.`,
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
    detail: s
      .enum(['pads', 'full'] as const)
      .describe(
        'pads (default): pads, boxes and models. full adds every graphic, text and property as items_get records.'
      )
      .optional(),
    modelFit: modelFitArg
  }),
  examples: [
    { args: { footprint: 'Resistor_SMD:R_0402_1005Metric' }, note: 'the pads of a chip resistor' },
    {
      args: { footprint: 'Package_QFP:LQFP-64_10x10mm_P0.5mm' },
      note: 'pad count and courtyard'
    },
    { args: { footprint: 'J1', board: 'bitclock.kicad_pcb' }, note: "the board's copy of J1" }
  ],
  request(args) {
    if (!args.footprint) {
      return refused(
        'footprint is required and must not be empty.',
        'Find the real id with footprint_search or footprint_list_library.'
      )
    }
    const target = footprintTarget(args)
    if (isTargetRefusal(target)) return target
    return {
      kind: 'get-footprint',
      ...target,
      maxPads: FOOTPRINT_PAD_ROWS,
      ...(args.detail === 'full' ? { detail: 'full' as const } : {}),
      ...(args.modelFit ? { modelFit: true } : {})
    }
  }
})
