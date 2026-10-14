/**
 * `footprint.delete` — remove a footprint from the project library.
 *
 * Project tier only;
 * the file goes to the OS trash, and the `.pretty` and its table row stay.
 */
import { defineDesignOp } from '../registry'
import { s } from '../schema'
import { refused } from '../errors'

export const footprintDelete = defineDesignOp({
  name: 'footprint.delete',
  scope: 'project',
  mutates: true,
  summary: "Remove a footprint from the project's own footprint library.",
  guidance:
    'Only the project library is writable. The file goes to the trash; refused while its tab has unsaved edits. Placed footprints keep their board copy; Footprint fields naming it stop resolving (bom_get finds them).',
  input: s.object({
    footprint: s.string().trim().describe('A project library id "Nickname:Name".')
  }),
  examples: [{ args: { footprint: 'board:SOT-23-5' }, note: 'a project footprint' }],
  request: (args) =>
    args.footprint.includes(':')
      ? { kind: 'delete-footprint', footprint: args.footprint }
      : refused(
          `"${args.footprint}" is not a library id.`,
          'Pass "Nickname:Name" as footprint_list_library reports it.'
        )
})
