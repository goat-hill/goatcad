/**
 * `bom.update` — field values and placement flags onto many parts at once,
 * named by reference or by the conditions `bom.get` filters with, across every
 * sheet, as one undoable step.
 *
 * Design: `docs/agent-api.md`. A write by condition is the
 * one edit whose reach the caller did not list, so it must say how many parts
 * it expects, and the answer names every non-empty value it replaced.
 */
import { defineDesignOp } from '../registry'
import { s } from '../schema'
import { refused } from '../errors'
import { footprintVeto } from '../libraryRecords'
import { bomFilters, filterRefusal } from './shared'
import { sheetFileArg } from '../fileArgs'

/** Columns the BOM generates rather than stores, under either spelling. */
const GENERATED = new Set([
  'Sheet',
  'QUANTITY',
  'MODEL',
  'DNP',
  'EXCLUDE_FROM_BOM',
  'EXCLUDE_FROM_BOARD'
])

export const bomUpdate = defineDesignOp({
  name: 'bom.update',
  scope: 'schematic',
  mutates: true,
  summary:
    'Write field values or DNP/BOM flags onto many parts across every sheet, by reference or bom_get conditions.',
  guidance:
    'Read with bom_get first, then pass the same where with expect set to its part count, or list references. Every matched part gets the same values; one undo step, and a sheet without a tab opens behind the active one, unsaved. A Footprint must be an id footprint_search or footprint_list_library reported. A Datasheet is a URL or ${KIPRJMOD}/datasheets/<file>.pdf. `overwrote` lists every non-empty value replaced; check it. dryRun previews. Renumber with schematic_annotate.',
  input: s.object({
    references: s
      .array(s.string().trim())
      .describe(
        'Parts by reference, any sheet: ["C3", "U4"]. A reference a reused sheet repeats names every instance.'
      )
      .optional(),
    where: bomFilters.optional(),
    expect: s
      .integer()
      .min(0)
      .describe('Part count the target must match, or nothing is written. Required with where.')
      .optional(),
    fields: s
      .record(s.string())
      .describe(
        'Values by field name, e.g. {"MPN": "GRM155R71C104KA88D", "Manufacturer": "Murata"}. "" clears a field; a missing field is added; a name the design spells differently ("mpn" beside "MPN") is refused.'
      )
      .optional(),
    dnp: s.boolean().describe('Do not populate.').optional(),
    inBom: s.boolean().describe('Include in the BOM.').optional(),
    onBoard: s.boolean().describe('Include on the board.').optional(),
    dryRun: s.boolean().describe('Report what would change without writing.').optional(),
    sheet: sheetFileArg('Any sheet of the project, to pick the project. ')
  }),
  examples: [
    {
      args: {
        where: [
          { field: 'Value', match: 'equals', value: '100nF' },
          { field: 'Footprint', match: 'empty' }
        ],
        expect: 10,
        fields: { Footprint: 'Capacitor_SMD:C_0402_1005Metric' }
      },
      note: 'footprint onto the ten bare 100nF capacitors'
    },
    {
      args: {
        references: ['U4'],
        fields: {
          MPN: 'LE9641PQC',
          Manufacturer: 'Microchip Technology',
          Datasheet: '${KIPRJMOD}/datasheets/LE9641PQC.pdf'
        }
      },
      note: 'identify one part'
    }
  ],
  validate: (args, ctx) => footprintVeto(ctx, args.fields?.Footprint?.trim()),
  request(args) {
    if (!args.references === !args.where) {
      return refused(
        'Name the parts one way: references or where.',
        'Pass references, or where with expect.',
        { kind: 'target-required' }
      )
    }
    if (args.references && !args.references.length) {
      return refused('references is empty.', 'List at least one reference from bom_get.', {
        kind: 'target-required'
      })
    }
    if (args.where && args.expect === undefined) {
      return refused(
        'A write by where needs expect.',
        'Run bom_get with the same where and pass its part count as expect.',
        { kind: 'expect-required' }
      )
    }
    const refusal = filterRefusal(args.where)
    if (refusal) return refusal

    const fields = Object.fromEntries(
      Object.entries(args.fields ?? {}).map(([key, value]) => [key.trim(), value])
    )
    if (Object.keys(fields).some((key) => !key)) {
      return refused('A field name is empty.', 'Name every field you set.', {
        kind: 'not-applicable'
      })
    }
    if ('Reference' in fields) {
      return refused(
        'Reference is the designator, not a field this writes.',
        'Renumber with schematic_annotate.',
        { kind: 'not-applicable' }
      )
    }
    const generated = Object.keys(fields).find((key) =>
      GENERATED.has(key.replace(/^\$\{(.*)\}$/, '$1'))
    )
    if (generated) {
      return refused(
        `${generated} is a column the BOM generates, not a field on a part.`,
        'Set dnp, inBom and onBoard as flags; Sheet, QUANTITY and MODEL are read-only. A 3D model goes on the footprint: footprint_cache_model, then items_create on it.',
        { kind: 'not-applicable' }
      )
    }
    if (
      !Object.keys(fields).length &&
      args.dnp === undefined &&
      args.inBom === undefined &&
      args.onBoard === undefined
    ) {
      return refused(
        'This update would write nothing.',
        'Pass fields, or at least one of dnp, inBom and onBoard.',
        { kind: 'nothing-to-write' }
      )
    }
    return {
      kind: 'update-bom',
      ...(args.sheet ? { sheet: args.sheet } : {}),
      ...(args.references ? { references: args.references } : {}),
      ...(args.where ? { where: args.where } : {}),
      ...(args.expect !== undefined ? { expect: args.expect } : {}),
      ...(Object.keys(fields).length ? { fields } : {}),
      ...(args.dnp !== undefined ? { dnp: args.dnp } : {}),
      ...(args.inBom !== undefined ? { inBom: args.inBom } : {}),
      ...(args.onBoard !== undefined ? { onBoard: args.onBoard } : {}),
      dryRun: args.dryRun === true
    }
  }
})
