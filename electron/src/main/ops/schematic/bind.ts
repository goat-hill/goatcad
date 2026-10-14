/**
 * `schematic.bind` — part identity onto a symbol that is already placed.
 *
 * It never moves or replaces the
 * symbol: if the part needs a different symbol, that is a placement, not a
 * binding.
 */
import { defineDesignOp } from '../registry'
import { s } from '../schema'
import { refused } from '../errors'
import { partProperties } from '../design'
import { footprintVeto } from '../libraryRecords'
import { checksArg } from '../checksArg'
import { sheetFileArg } from '../fileArgs'

export const schematicBind = defineDesignOp({
  name: 'schematic.bind',
  scope: 'schematic',
  mutates: true,
  summary:
    'Write part fields (value, footprint, MPN, manufacturer) onto a placed symbol by reference.',
  guidance:
    "One undo step on the sheet's tab. Only the fields given change; the symbol is never moved or replaced (a different symbol is a schematic_place_symbol). For many parts at once, bom_update is one undo step.",
  input: s.object({
    reference: s.string().trim().describe('Reference on the sheet, e.g. "U1"; case-sensitive.'),
    value: s.string().describe('Value field.').optional(),
    footprint: s
      .string()
      .trim()
      .describe(
        'Footprint field, "Nickname:Name" as footprint_search reports it. An unknown id is refused with candidates; pads that do not match the symbol\'s pins come back as a pad-count or pin-mismatch warning.'
      )
      .optional(),
    mpn: s.string().describe('Manufacturer part number, from a parts_search row.').optional(),
    manufacturer: s.string().describe('Manufacturer name.').optional(),
    datasheet: s.string().describe('Datasheet URL.').optional(),
    properties: s
      .record(s.string())
      .describe('Further fields by name, e.g. {"LCSC": "C25804"}.')
      .optional(),
    sheet: sheetFileArg('The sheet the symbol is on. '),
    checks: checksArg
  }),
  examples: [
    {
      args: { reference: 'C4', footprint: 'Capacitor_SMD:C_0402_1005Metric' },
      note: 'footprint for a passive placed by value'
    },
    {
      args: { reference: 'U2', mpn: 'TPS62933DRLR', manufacturer: 'Texas Instruments' },
      note: 'part number from parts_search'
    }
  ],
  validate: (args, ctx) => footprintVeto(ctx, partProperties(args).Footprint),
  request(args) {
    if (!args.reference) {
      return refused(
        'reference is required and must not be empty.',
        'Call schematic_describe to see the references that are actually on the sheet.'
      )
    }
    const properties = partProperties(args)
    if (!Object.keys(properties).length && args.value === undefined) {
      return refused(
        'This bind would write nothing.',
        'Pass at least one of value, footprint, mpn, manufacturer, datasheet or properties. A bind that writes nothing would still cost the user an undo step.',
        { kind: 'nothing-to-write' }
      )
    }
    return {
      kind: 'bind-part',
      reference: args.reference,
      ...(args.sheet ? { sheet: args.sheet } : {}),
      ...(args.value !== undefined ? { value: args.value } : {}),
      properties
    }
  }
})
