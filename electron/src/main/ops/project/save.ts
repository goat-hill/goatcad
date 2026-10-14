/**
 * `project.save` — write open tabs with unsaved edits to disk.
 *
 * Every other mutation lands
 * on a dirty tab where Ctrl+Z reverses it; this is the one that crosses that
 * line, and it exists because the scripted loop cannot ask — a script that
 * wants `kicad-cli` on the result needs a file. The guard is the answer: it
 * lists exactly what was written, and the guidance tells the model that most
 * edits are not its to save. Works for any document kind a tab can hold.
 */
import { defineDesignOp } from '../registry'
import { s } from '../schema'

export const projectSave = defineDesignOp({
  name: 'project.save',
  scope: 'project',
  mutates: true,
  summary: 'Write open tabs with unsaved edits to disk: the named files, or every dirty one.',
  guidance:
    'Save only when the user asks or the next step needs the file on disk (kicad-cli, a script), and say which; unsaved edits stay undoable for the user. Any open document saves: schematic, board, library, text. The answer lists what was written and what is still unsaved; tell the user.',
  input: s.object({
    files: s
      .array(s.string().trim())
      .min(1)
      .describe(
        'Open tabs to save, as absolute paths or bare file names. Default: every tab with unsaved edits.'
      )
      .optional()
  }),
  examples: [
    { args: {}, note: 'save every dirty tab' },
    {
      args: { files: ['phoneamenal.kicad_sch'] },
      note: 'one sheet, before kicad-cli'
    }
  ],
  request: (args) => ({ kind: 'save-files', ...(args.files ? { files: args.files } : {}) })
})
