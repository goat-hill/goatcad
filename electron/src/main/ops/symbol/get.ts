/**
 * `symbol.get` — one symbol definition's geometry: a library symbol before it
 * is placed, or the copy a sheet holds for a placed one.
 *
 * The library twin of `items.get` on a placed symbol, and the read that ends
 * place-read-delete probing: every pin relative to the
 * origin at angle 0, the body box, the fields and the footprint filters.
 * Served by the window's library door, which holds the parsed tiers.
 */
import type { McpSymbolColumn } from '../../../preload/mcpTypes'
import { defineDesignOp } from '../registry'
import { s } from '../schema'
import { bodyStyleArg, isSymbolRefusal, placedSheetArg, symbolArg, symbolTarget } from './target'

const SYMBOL_COLUMNS = [
  'description',
  'isPower',
  'units',
  'unit',
  'styles',
  'style',
  'box',
  'pins',
  'fields',
  'footprintFilters'
] as const satisfies readonly McpSymbolColumn[]

export const symbolGet = defineDesignOp({
  name: 'symbol.get',
  scope: 'project',
  mutates: false,
  summary:
    "Read one symbol definition's pins, body box, fields and footprint filters, before or after placing it.",
  guidance:
    "Pin offsets are millimeters in sheet space, y down, from the origin at angle 0; a placed pin is at origin + offset, turned by schematic_place_symbol's angle. Footprint filters are the intended packages; pass one to footprint_search. A placed reference reads the sheet's copy, which may differ from the library.",
  input: s.object({
    symbol: symbolArg,
    sheet: placedSheetArg,
    unit: s
      .integer()
      .min(1)
      .describe('Unit (gate) of a multi-unit symbol. Defaults to 1.')
      .optional(),
    style: bodyStyleArg,
    columns: s
      .array(s.enum(SYMBOL_COLUMNS))
      .min(1)
      .describe(
        'Keys to answer; default all. libId, tier and the placed reference are always kept.'
      )
      .optional()
  }),
  examples: [
    {
      args: { symbol: 'Regulator_Linear:AMS1117-3.3' },
      note: 'pins before placing'
    },
    {
      args: { symbol: 'Amplifier_Operational:LM358', unit: 2 },
      note: 'the second op-amp of a dual'
    },
    { args: { symbol: 'U3' }, note: "the open sheet's copy of U3" },
    { args: { symbol: 'Device:R', columns: ['pins'] }, note: 'only the pins' }
  ],
  request(args) {
    const target = symbolTarget(args)
    if (isSymbolRefusal(target)) return target
    return {
      kind: 'get-symbol',
      ...target,
      ...(args.unit ? { unit: args.unit } : {}),
      ...(args.style ? { style: args.style } : {}),
      ...(args.columns ? { columns: [...args.columns] } : {})
    }
  }
})
