/**
 * `symbol.create` — a symbol for a part no library has.
 *
 * The boundary that makes this
 * work: **GoatCAD draws, the agent reads.** The agent supplies the pin table and
 * the functional groups — the one thing only a datasheet reader can supply — and
 * every coordinate is computed here, so every generated symbol matches every
 * other one.
 */
import { defineDesignOp } from '../registry'
import { s } from '../schema'
import { refused } from '../errors'
import { partProperties } from '../design'
import { PIN_TYPES } from '../../../shared/itemRecords'

export const symbolCreate = defineDesignOp({
  name: 'symbol.create',
  scope: 'project',
  mutates: true,
  summary:
    "Draw a symbol for a part no library has from its pin table, or a blank one, into the project's own symbol library.",
  guidance:
    "GoatCAD computes every coordinate; you supply pins and groups. First symbol_search for the part number and family; a generic passive (Device:R with a Value) is refused. Read pins from parts_cache_datasheet then parts_read_datasheet: query 'pin configuration', then that page as an image, since pin numbers are in the package drawing. A family datasheet: take the chosen variant's row. Never invent a pad number; if unreadable, ask. A pad to leave open is omitted; one tied to ground is a ground pin; pads on one net stack with stackWith. Groups are functional: a bus in its conventional order (SDA, SCL), rails power, grounds ground, the rest signal by function. A group stays on one side, so split banks into runs of six to ten. Opens the library as a tab behind. Report pads omitted, stacked or merged. Blank: omit pins and groups for fields only (a power port with power, Reference #PWR), then draw with symbol_batch.",
  input: s.object({
    name: s
      .string()
      .trim()
      .describe('Symbol name, normally the manufacturer part number, e.g. "SGP41-D-R4".'),
    groups: s
      .array(
        s.object({
          id: s.string().describe("Your label, matched by the pins' group field."),
          role: s
            .enum(['power', 'ground', 'signal'] as const)
            .describe(
              'power on top, ground on the bottom, signal on a side. Required: VDD and GND are both power_in.'
            ),
          side: s
            .enum(['left', 'right', 'top', 'bottom'] as const)
            .describe(
              "Fix the group to one side, overriding role and balancing. Only for a convention, e.g. a regulator's VIN on the left."
            )
            .optional()
        })
      )
      .describe('Functional pin groups; each is kept together on one side.')
      .optional(),
    pins: s
      .array(
        s.object({
          number: s.string().describe('Pad number as the datasheet prints it.'),
          name: s
            .string()
            .describe('Signal name; stacked pads share the net name (three pads all "GND").'),
          type: s.enum(PIN_TYPES).describe('KiCad electrical type.'),
          group: s.string().describe('A group id; required on every pin.'),
          stackWith: s
            .string()
            .describe(
              'Pad number on the same net. Stacked at one point; all but the first become passive.'
            )
            .optional(),
          omit: s
            .boolean()
            .describe(
              'Leave off the symbol: a pad the datasheet says to leave open. The footprint keeps it.'
            )
            .optional()
        })
      )
      .describe('Every pad on the part, from the datasheet.')
      .optional(),
    power: s
      .enum(['global', 'local'] as const)
      .describe('Blank only: make it a power port, its net global or local to its sheet.')
      .optional(),
    reference: s
      .string()
      .describe('Reference prefix. Defaults to "U", or "#PWR" for a power port.')
      .optional(),
    value: s.string().describe('Value field. Defaults to the symbol name.').optional(),
    description: s.string().describe('One line, as the library shows it.').optional(),
    keywords: s.string().describe('Space-separated search keywords.').optional(),
    datasheet: s.string().describe('Datasheet URL or the cached local path.').optional(),
    properties: s
      .record(s.string())
      .describe('Further fields, e.g. {"MPN": "...", "Manufacturer": "..."}.')
      .optional(),
    library: s
      .string()
      .trim()
      .describe("Library file stem. Defaults to the project's own name.")
      .optional(),
    overwrite: s
      .boolean()
      .describe('Replace a symbol of the same name, discarding hand edits to it.')
      .optional()
  }),
  examples: [
    {
      args: {
        name: 'TMP117',
        groups: [
          { id: 'pwr', role: 'power' },
          { id: 'gnd', role: 'ground' },
          { id: 'i2c', role: 'signal' }
        ],
        pins: [
          { number: '5', name: 'V+', type: 'power_in', group: 'pwr' },
          { number: '2', name: 'GND', type: 'power_in', group: 'gnd' },
          { number: '6', name: 'SDA', type: 'bidirectional', group: 'i2c' },
          { number: '1', name: 'SCL', type: 'input', group: 'i2c' }
        ]
      },
      note: 'a part from its pin table'
    },
    { args: { name: '+3V3_AUX', power: 'global' }, note: 'a blank power port to draw' }
  ],
  request(args) {
    if (!args.name) {
      return refused(
        'name is required and must not be empty.',
        'Name the symbol after the manufacturer part number.'
      )
    }
    const blank = !args.pins?.length && !args.groups?.length
    if (args.power && !blank) {
      return refused(
        'power is for a blank symbol.',
        'Drop power, or omit pins and groups and draw the port with symbol_batch.'
      )
    }
    return {
      kind: 'create-symbol',
      name: args.name,
      ...(args.groups ? { groups: args.groups } : {}),
      ...(args.pins ? { pins: args.pins } : {}),
      ...(args.power ? { power: args.power } : {}),
      ...(args.library ? { library: args.library } : {}),
      ...(args.reference !== undefined ? { reference: args.reference } : {}),
      ...(args.value !== undefined ? { value: args.value } : {}),
      ...(args.description !== undefined ? { description: args.description } : {}),
      ...(args.keywords !== undefined ? { keywords: args.keywords } : {}),
      ...(args.datasheet !== undefined ? { datasheet: args.datasheet } : {}),
      ...(args.overwrite === true ? { overwrite: true } : {}),
      properties: partProperties(args)
    }
  }
})
