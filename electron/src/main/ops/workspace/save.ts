/**
 * `workspace.save` — write open documents with unsaved edits to disk. Every
 * other mutation lands on a dirty tab where Ctrl+Z reverses it; this is the one
 * that crosses that line, and it exists because a scripted loop cannot ask. The
 * guard is the answer: it lists exactly what was written.
 */
import { defineDesignOp } from '../registry'
import { s } from '../schema'

export const workspaceSave = defineDesignOp({
  name: 'workspace.save',
  scope: 'project',
  mutates: true,
  summary: 'Write open documents with unsaved edits to disk: the named files, or every dirty one.',
  guidance:
    'Save only when the user asks or the next step needs the file on disk (kicad-cli, a script), and say which; unsaved edits stay undoable for the user. Any open document saves: schematic, board, library, text. The answer lists what was written and what is still unsaved; tell the user.',
  input: s.object({
    files: s
      .array(s.string().trim())
      .min(1)
      .describe(
        'Open documents to save, as absolute paths or bare file names. Default: every one with unsaved edits.'
      )
      .optional()
  }),
  examples: [
    { args: {}, note: 'save every dirty tab' },
    { args: { files: ['phoneamenal.kicad_sch'] }, note: 'one sheet, before kicad-cli' }
  ],
  request: (args) => ({ kind: 'save-files', ...(args.files ? { files: args.files } : {}) })
})
