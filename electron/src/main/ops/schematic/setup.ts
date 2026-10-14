/**
 * `schematic.get_setup` and `schematic.update_setup` — Schematic Setup: the
 * ERC's rule severities, read and written, and its KiCad exclusions, read
 * (`lib/schematic/schematicSetupAgent.ts`). Design: `docs/agent-api.md`.
 */
import { defineDesignOp } from '../registry'
import { s } from '../schema'
import { refused } from '../errors'
import { checksArg } from '../checksArg'

export const schematicGetSetup = defineDesignOp({
  name: 'schematic.get_setup',
  scope: 'project',
  mutates: false,
  summary: "Read Schematic Setup: ERC rule severities and the project's KiCad exclusions.",
  guidance:
    'severities.rules lists every rule; changed is what the project set, notChecked what is not run. Each exclusion counts the current findings it hides from schematic_check. Net classes are in board_get_setup.',
  input: s.object({
    sections: s
      .array(s.enum(['severities', 'exclusions'] as const))
      .min(1)
      .describe('Sections to read. Default: both.')
      .optional()
  }),
  request: (args) => ({
    kind: 'get-schematic-setup',
    ...(args.sections ? { sections: args.sections } : {})
  })
})

export const schematicUpdateSetup = defineDesignOp({
  name: 'schematic.update_setup',
  scope: 'project',
  mutates: true,
  summary: "Change ERC rule severities, as Schematic Setup's Electrical Rules page does.",
  guidance:
    "Read keys with schematic_get_setup first. Written to the project file at once and not undoable; the answer's before holds every severity replaced. A rule that grades its own findings (the pin conflict matrix) only turns off or on. Exclusions are read-only.",
  input: s.object({
    severities: s.json().describe('Map of KiCad rule key to "error", "warning" or "ignore".'),
    dryRun: s.boolean().describe('Return what would change without writing.').optional(),
    checks: checksArg
  }),
  examples: [
    {
      args: { severities: { lib_symbol_mismatch: 'ignore' } },
      note: 'stop flagging library mismatches'
    }
  ],
  request: (args) =>
    args.severities === null || typeof args.severities !== 'object'
      ? refused(
          'severities is a map of rule keys to severities.',
          'Read them with schematic_get_setup.'
        )
      : {
          kind: 'update-schematic-setup',
          changes: { severities: args.severities },
          ...(args.dryRun ? { dryRun: true } : {})
        }
})
