/**
 * `schematic.place_symbol` — a symbol on the sheet, bound to a real part.
 *
 * This is a real edit, not a
 * proposal: it lands in the editor as an undoable step on an unsaved tab, which
 * is both what makes it visible and the whole consent model.
 *
 * Position is the caller's, always (`agent-api.md`).
 * Layout is design work the agent does from the numbers the app gives it, and
 * a slot picked for it was never where the part belonged — every auto-placed
 * part cost a second call to move. Requiring `at` is what makes reading the
 * sheet first structural rather than advice. The one thing the app still
 * polices is the wiring grid, because an origin that leaves a pin off it is a
 * part nothing can wire to.
 */
import { defineDesignOp } from '../registry'
import { s } from '../schema'
import { refused } from '../errors'
import { partProperties } from '../design'
import { footprintVeto } from '../libraryRecords'
import { checksArg } from '../checksArg'
import { viewportArg } from '../viewport/open'
import { actionArg } from '../viewport/action'
import { sheetFileArg } from '../fileArgs'

export const schematicPlaceSymbol = defineDesignOp({
  name: 'schematic.place_symbol',
  scope: 'schematic',
  mutates: true,
  summary: 'Place a symbol on a schematic sheet at a given point, bound to a real part.',
  guidance:
    "One undo step on the sheet's tab. Read the pins of the part it serves with items_get first. Place a passive by its pin: pin plus at puts that pin one grid step out from the served pin, then schematic_wire draws the run. Place a main part by its origin. A library symbol is placed as its file is saved: after editing one, save its library (project_save) first. The reference is assigned from what the design already uses; reference with unit adds that unit to an existing part, which it takes its fields from. A pin that lands on an existing wire or pin joins that net; the answer's `touching` lists them, and a later move drags that wire along. Take mpn and manufacturer from a parts_search result, never from memory; the BOM reads them. A part without a footprint is skipped at board layout.",
  input: s.object({
    symbol: s
      .string()
      .trim()
      .describe('Library id "Nickname:Name" as symbol_search reports it, e.g. "Device:R".'),
    value: s
      .string()
      .describe(
        'Value field. A passive takes the value alone ("10k", "100nF"); tolerance and rating go in other fields. Defaults to the symbol name. Follow board-intent.md spelling when the project has one.'
      )
      .optional(),
    footprint: s
      .string()
      .trim()
      .describe(
        'Footprint field, "Nickname:Name" as footprint_search reports it. An unknown id is refused with candidates; pads that do not match the symbol\'s pins come back as a pad-count or pin-mismatch warning. footprint_create draws one when no library has it.'
      )
      .optional(),
    mpn: s.string().describe('Manufacturer part number; the field the BOM resolves.').optional(),
    manufacturer: s.string().describe('Manufacturer name, paired with mpn.').optional(),
    datasheet: s.string().describe('Datasheet URL.').optional(),
    properties: s
      .record(s.string())
      .describe('Further fields by name, e.g. {"LCSC": "C25804"}.')
      .optional(),
    reference: s
      .string()
      .trim()
      .describe(
        'Reference instead of the assigned one, e.g. "U1". A used one is refused unless unit names a free unit of that part.'
      )
      .optional(),
    at: s
      .object({ x: s.number(), y: s.number() })
      .describe(
        'Origin in sheet mm, or with pin, where that pin lands. Pins belong on the 2.54 mm grid: a passive with pins at ±3.81 mm takes an origin on an odd multiple of 1.27 mm. A pin off the 1.27 mm grid is refused with the nearest valid point.'
      ),
    pin: s
      .string()
      .trim()
      .describe(
        'Pin number ("1", "A1") that at places; the origin follows from the symbol and angle. Refused with the unit\'s pins when it has no such pin.'
      )
      .optional(),
    angle: s
      .number()
      .describe(
        'Degrees counter-clockwise: 0 (default), 90, 180 or 270. A two-pin passive has pin 1 up at 0, left at 90, down at 180, right at 270.'
      )
      .optional(),
    unit: s.integer().min(1).describe('Unit of a multi-unit part. Default 1.').optional(),
    sheet: sheetFileArg(),
    viewport: viewportArg,
    action: actionArg,
    checks: checksArg
  }),
  examples: [
    {
      args: {
        symbol: 'Device:C',
        value: '100nF',
        footprint: 'Capacitor_SMD:C_0603_1608Metric',
        mpn: 'CL10B104KB8NNNC',
        manufacturer: 'Samsung',
        at: { x: 116.84, y: 71.12 },
        viewport: 'viewport-1',
        action: 'Place C decoupling U1'
      },
      note: 'decoupling capacitor with its part number'
    },
    {
      args: {
        symbol: 'Device:R',
        value: '10k',
        pin: '1',
        at: { x: 92.71, y: 71.12 },
        angle: 90,
        viewport: 'viewport-1',
        action: 'Place series R'
      },
      note: 'series resistor placed by pin 1, lying horizontal'
    },
    {
      args: {
        symbol: 'Amplifier_Operational:LM358',
        reference: 'U5',
        unit: 2,
        at: { x: 139.7, y: 71.12 },
        viewport: 'viewport-1',
        action: 'Place U5 unit B'
      },
      note: 'unit B of the existing op amp U5'
    }
  ],
  validate: (args, ctx) => footprintVeto(ctx, partProperties(args).Footprint),
  request(args) {
    if (!args.symbol) {
      return refused(
        'symbol is required and must not be empty.',
        'Find the real id with symbol_search or symbol_list_library — ids are exact and case-sensitive.'
      )
    }
    return {
      kind: 'place-symbol',
      libId: args.symbol,
      ...(args.sheet ? { sheet: args.sheet } : {}),
      at: { x: args.at.x, y: args.at.y },
      ...(args.pin ? { pin: args.pin } : {}),
      ...(args.angle !== undefined ? { angle: args.angle } : {}),
      ...(args.unit !== undefined ? { unit: args.unit } : {}),
      ...(args.reference ? { reference: args.reference } : {}),
      ...(args.value !== undefined ? { value: args.value } : {}),
      properties: partProperties(args)
    }
  }
})
