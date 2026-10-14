/**
 * `render.symbol` — a picture of one symbol definition, as the editor draws it.
 *
 * The symbol-shaped sibling of `render.schematic`: same answer (a PNG with its frame
 * in millimeters), same rules about what a picture is for, no sheet involved.
 * It exists because a symbol is made blind — generated from a pin table, or
 * drawn by hand — and the only way to know whether it reads is to look at it.
 * Placing it on a sheet just to render the sheet was three calls and a sheet
 * that had to exist; this is one call against the library.
 *
 * `render.*` is where pictures live: this one and the sheet's today, a footprint
 * and a board when those editors have a door. Each takes the thing it draws by
 * the id its own domain uses, and answers in the one shape.
 */
import { defineDesignOp } from '../registry'
import { s } from '../schema'
import { RENDER_DEFAULT_MAX_PIXELS } from './schematic'
import {
  bodyStyleArg,
  isSymbolRefusal,
  placedSheetArg,
  symbolArg,
  symbolTarget
} from '../symbol/target'

export const renderSymbol = defineDesignOp({
  name: 'render.symbol',
  scope: 'project',
  mutates: false,
  summary: 'Render one symbol definition to a PNG as the symbol editor draws it.',
  guidance:
    'Render after symbol_create, before placing. Drawn alone at the origin with reference and value; the frame is millimeters in symbol space.',
  input: s.object({
    symbol: symbolArg,
    sheet: placedSheetArg,
    unit: s
      .integer()
      .min(1)
      .describe('Unit (gate) of a multi-unit symbol. Defaults to 1.')
      .optional(),
    style: bodyStyleArg,
    maxPixels: s
      .integer()
      .min(256)
      .max(16384)
      .describe(`Longest PNG edge, pixels. Defaults to ${RENDER_DEFAULT_MAX_PIXELS}.`)
      .optional()
  }),
  examples: [
    {
      args: { symbol: 'phoneamenal:ES8388' },
      note: 'a generated symbol'
    },
    {
      args: { symbol: 'Regulator_Linear:AP2112K-3.3', maxPixels: 600 },
      note: 'a standard symbol, small'
    },
    { args: { symbol: 'Amplifier_Operational:LM358', unit: 3 }, note: 'the power unit of a dual' }
  ],
  request(args) {
    const target = symbolTarget(args)
    if (isSymbolRefusal(target)) return target
    return {
      kind: 'render-symbol',
      ...target,
      ...(args.unit ? { unit: args.unit } : {}),
      ...(args.style ? { style: args.style } : {}),
      maxPixels: args.maxPixels ?? RENDER_DEFAULT_MAX_PIXELS
    }
  }
})
