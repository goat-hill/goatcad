/**
 * `schematic.describe` — reading the sheet back.
 *
 * Not optional: this
 * is the only source of the references, nets and pin ids every other schematic
 * verb accepts (`docs/agent-api.md`).
 */
import { defineDesignOp } from '../registry'
import { s } from '../schema'
import { sheetFileArg } from '../fileArgs'

export const schematicDescribe = defineDesignOp({
  name: 'schematic.describe',
  scope: 'schematic',
  mutates: false,
  summary:
    "Read a schematic sheet: its symbols and part fields, nets, unconnected pins, and the design's sheets.",
  guidance:
    'Call before writing to a sheet: references, pin ids and net names come from here. The answer carries a revision; pass it as since later to get only what changed.',
  input: s.object({
    sheet: sheetFileArg(),
    since: s
      .integer()
      .min(0)
      .describe(
        'Revision from an earlier answer; returns only changes and removed ids since. An expired revision returns the whole sheet and says so.'
      )
      .optional()
  }),
  request: (args) => ({
    kind: 'describe-schematic',
    ...(args.sheet ? { sheet: args.sheet } : {}),
    ...(args.since !== undefined ? { since: args.since } : {})
  })
})
