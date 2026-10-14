/**
 * `bom.get` — the design's parts as a table: every sheet, the columns asked
 * for, filtered and optionally grouped.
 *
 * Design: `docs/agent-api.md`. KiCad's BOM export takes the
 * same shape — ordered fields, group-by, sort — and answers with a file; this
 * answers with rows, and filters on field values where KiCad's filter matches
 * the reference only. The rows are the Components table's own
 * (`lib/componentsTable.ts`), so the agent and the panel read one BOM.
 */
import { defineDesignOp } from '../registry'
import { s } from '../schema'
import { bomFilters, filterRefusal } from './shared'
import { sheetFileArg } from '../fileArgs'

export const bomGet = defineDesignOp({
  name: 'bom.get',
  scope: 'schematic',
  mutates: false,
  summary:
    "Read the design's bill of materials across every sheet: the columns you name, filtered and optionally grouped.",
  guidance:
    "Use it to find what parts still lack (a footprint before layout, an MPN before ordering) and the target for bom_update. Power symbols are left out. Rows are arrays in `columns` order; a group's Reference cell is its references compressed, and a null cell is a column its parts disagree on. `parts` counts the parts kept, `total` the rows, `available` every column the design has. A column the design lacks is refused.",
  input: s.object({
    fields: s
      .array(s.string().trim())
      .describe(
        'Columns after Reference, which is always first. Default Value, Footprint, Datasheet, MPN, Manufacturer. Generated columns, with or without ${}: QUANTITY (parts per row); DNP, EXCLUDE_FROM_BOM, EXCLUDE_FROM_BOARD ("yes"/"no"); Sheet; MODEL, whether the footprint\'s 3D model file is on this machine: resolved, missing, not-installed, none (no model linked), unknown (no such footprint), or empty (no footprint). MODEL reads the saved footprint, so a model attached on an unsaved tab shows after project_save.'
      )
      .optional(),
    groupBy: s
      .array(s.string().trim())
      .describe(
        'Fields whose matching values merge parts into one row: ["Value", "Footprint"] before MPNs, ["MPN"] after. Default one row per part.'
      )
      .optional(),
    where: bomFilters.optional(),
    sortBy: s
      .string()
      .trim()
      .describe(
        'Column to sort by, natural order (R2 before R10). Default Reference; a group sorts by its first part.'
      )
      .optional(),
    limit: s.integer().min(1).max(400).describe('Rows to return. Default 400.').optional(),
    sheet: sheetFileArg('Any sheet of the project, to pick the project. ')
  }),
  examples: [
    {
      args: {
        fields: ['Value', 'QUANTITY'],
        groupBy: ['Value', 'Footprint'],
        where: [{ field: 'Footprint', match: 'empty' }]
      },
      note: 'parts without a footprint, by value'
    },
    {
      args: {
        fields: ['Value', 'MPN', 'Manufacturer'],
        where: [{ field: 'Reference', match: 'matches', value: 'U*' }]
      },
      note: 'ICs and their MPNs'
    },
    {
      args: {
        fields: ['Footprint', 'MODEL', 'QUANTITY'],
        groupBy: ['Footprint'],
        where: [{ field: 'MODEL', match: 'notEquals', value: 'resolved' }]
      },
      note: 'parts missing a 3D model, by footprint'
    }
  ],
  request(args) {
    const refusal = filterRefusal(args.where)
    if (refusal) return refusal
    return {
      kind: 'get-bom',
      ...(args.sheet ? { sheet: args.sheet } : {}),
      ...(args.fields ? { fields: args.fields } : {}),
      ...(args.groupBy ? { groupBy: args.groupBy } : {}),
      ...(args.where ? { where: args.where } : {}),
      ...(args.sortBy ? { sortBy: args.sortBy } : {}),
      ...(args.limit !== undefined ? { limit: args.limit } : {})
    }
  }
})
