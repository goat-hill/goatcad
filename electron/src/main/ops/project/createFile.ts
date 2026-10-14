/**
 * `project.create_file` — New ▸ for an agent: a blank sheet, board, symbol
 * library or footprint library in the active project, as the GUI makes each
 * (`renderer/src/lib/project/createFileForAgent.ts`). A `project` verb beside
 * create, open, close and save: it makes a file of the project, while
 * `symbol.create` and `footprint.create` make a definition inside a library.
 */
import { defineDesignOp } from '../registry'
import { s } from '../schema'

export const projectCreateFile = defineDesignOp({
  name: 'project.create_file',
  scope: 'project',
  mutates: true,
  summary:
    'Create a blank schematic sheet, board, symbol library or footprint library in the project.',
  guidance:
    "Written in the active project's folder at once, with no undo, and opened in a tab behind the active one (a footprint library is a folder, not a tab). A library is registered in the project's sym-lib-table or fp-lib-table under its name. A name already in the folder or the table is refused. For a child sheet, schematic_add_sheet makes the file and its sheet symbol together. A board starts with no outline: set its layers and rules with board_update_setup.",
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
