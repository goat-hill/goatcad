/**
 * Recently opened projects and files.
 *
 * One thing you can reopen. Reopening always needs the same context — a
 * workspace root plus which project is active — so a file entry is a project
 * entry with one more field rather than a separate shape.
 *
 * Which section of the UI an entry belongs to is read off the record, not
 * tracked separately: a folder opened where a project resolved *is* a project
 * entry, and a folder with none sits with the files, because both are "a thing
 * I looked at outside a project."
 *
 * Lives here rather than in `main/appConfig.ts` because both processes need it —
 * main owns the store, the renderer renders it (RULES.md §9).
 */
export interface RecentEntry {
  kind: 'project' | 'file'
  /** The project file, the folder, or the file — whatever was opened. */
  path: string
  /** Folder to open as the workspace when restoring this entry. */
  workspaceRoot: string
  /** `.kicad_pro` that was active, or null when none was. */
  projectPath: string | null
}
