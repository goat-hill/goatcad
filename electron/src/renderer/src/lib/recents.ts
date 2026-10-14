/**
 * How the recents list divides in two.
 *
 * Not `kind` alone, which is the mistake this module exists to stop repeating:
 * a folder opened where no project resolved is *stored* as a project-kind entry
 * (it is a thing you reopen as a workspace), but it belongs with the files, not
 * above them. What separates the groups is whether the entry has a **project
 * context** — that is what the top group is advertising.
 *
 * Pure, and shared by both surfaces (the Welcome page and File ▸ Open Recent) so
 * they cannot drift.
 */
import type { RecentEntry } from '../../../preload/recentTypes'

/** A design you can reopen with its project active. */
export const isProjectEntry = (entry: RecentEntry): boolean =>
  entry.kind === 'project' && entry.projectPath !== null

export interface SplitRecents {
  /** Projects, most-recent-first. Shown above the rest. */
  projects: RecentEntry[]
  /** Files, and folders that held no project. */
  files: RecentEntry[]
}

export const splitRecents = (recents: readonly RecentEntry[]): SplitRecents => ({
  projects: recents.filter(isProjectEntry),
  files: recents.filter((entry) => !isProjectEntry(entry))
})
