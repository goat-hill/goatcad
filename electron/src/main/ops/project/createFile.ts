/** `project.create_file` — the old name of `workspace.create_file`, kept for one release. */
import { defineDesignOp } from '../registry'
import { s } from '../schema'

export const projectCreateFile = defineDesignOp({
  name: 'project.create_file',
  scope: 'project',
  mutates: true,
  summary: 'Deprecated: use workspace_create_file, which this is.',
  input: s.object({
    kind: s
      .enum(['schematic', 'board', 'symbol_library', 'footprint_library'] as const)
      .describe('What to create.'),
    name: s
      .string()
      .trim()
      .describe(
        "File stem, without extension (.kicad_sch, .kicad_pcb, .kicad_sym or .pretty is added); a library's nickname too."
      )
  }),
  examples: [
    { args: { kind: 'board', name: 'phone-v2' }, note: 'a fresh board beside the old one' },
    { args: { kind: 'schematic', name: 'power' }, note: 'a sheet for a sheet symbol to name' },
    { args: { kind: 'footprint_library', name: 'phone' }, note: 'a registered .pretty' }
  ],
  request: (args) => ({ kind: 'create-file', fileKind: args.kind, name: args.name })
})
