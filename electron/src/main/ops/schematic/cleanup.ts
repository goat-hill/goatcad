/**
 * `schematic.cleanup` — KiCad's after-every-edit tidy, as a verb.
 *
 * Design: `docs/agent-api.md`. Every
 * write that touches a wire already runs `lib/schematic/wireCleanup.ts` on the
 * sheet it edited, inside its own undo step. This is the same pass on demand,
 * for a sheet that was drawn before the tidy existed or in another tool.
 */
import { defineDesignOp } from '../registry'
import { s } from '../schema'
import { checksArg } from '../checksArg'
import { sheetFileArg } from '../fileArgs'

export const schematicCleanup = defineDesignOp({
  name: 'schematic.cleanup',
  scope: 'schematic',
  mutates: true,
  summary: "Tidy a sheet's wires: drop duplicates, join overlapping runs, fix junction dots.",
  guidance:
    'Writes that touch wires already tidy their sheet; use this on a sheet drawn elsewhere or edited by hand. Joins same-net wires only, never two nets. One undo step. The answer counts wires removed and merged and junctions removed and added.',
  input: s.object({
    sheet: sheetFileArg(),
    checks: checksArg
  }),
  examples: [{ args: {}, note: 'tidy the open sheet' }],
  request(args) {
    return {
      kind: 'cleanup-schematic',
      ...(args.sheet ? { sheet: args.sheet } : {})
    }
  }
})
