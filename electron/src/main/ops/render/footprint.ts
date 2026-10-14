/**
 * `render.footprint` — a picture of one library footprint, as the editor draws it.
 *
 * The footprint-shaped sibling of `render.symbol`: the same answer, no
 * board involved. It exists for the judgment a pad table cannot give — is
 * this the package I think it is, is the pitch right by eye.
 */
import { defineDesignOp } from '../registry'
import { s } from '../schema'
import { RENDER_DEFAULT_MAX_PIXELS } from './schematic'
import { footprintTarget, isTargetRefusal } from '../items/footprint'
import { BOARD_FILE } from '../fileArgs'

export const renderFootprint = defineDesignOp({
  name: 'render.footprint',
  scope: 'project',
  mutates: false,
  summary:
    'Render one footprint to a PNG: its layers as the footprint editor draws them, or the part in 3D.',
  guidance:
    "Drawn alone at its origin, front side, unrotated; a board's copy too. Framed to the courtyard (or pads and fab) with a 2 mm margin, so long text may be cut. Millimeters in the footprint's frame, y down, as footprint_get reports.",
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
    maxPixels: s
      .integer()
      .min(256)
      .max(16384)
      .describe(`Longest PNG edge, pixels. Defaults to ${RENDER_DEFAULT_MAX_PIXELS}.`)
      .optional(),
    view: s
      .enum(['layers', 'model'] as const)
      .describe(
        'layers (default): 2D pads, silk, fab and courtyard. model: four 3D views on a board piece, to check an attached model; refused without an installed model.'
      )
      .optional()
  }),
  examples: [
    {
      args: { footprint: 'Package_TO_SOT_SMD:SOT-23-5' },
      note: 'a library package'
    },
    {
      args: { footprint: 'board:SOT-23-5', view: 'model' },
      note: 'the part in 3D with its model'
    }
  ],
  request(args) {
    const target = footprintTarget(args)
    if (isTargetRefusal(target)) return target
    return {
      kind: 'render-footprint',
      ...target,
      maxPixels: args.maxPixels ?? RENDER_DEFAULT_MAX_PIXELS,
      ...(args.view === 'model' ? { view: 'model' as const } : {})
    }
  }
})
