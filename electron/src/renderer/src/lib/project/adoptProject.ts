/**
 * What a folder offers a new project.
 *
 * Creating a project has two shapes, and which one applies is a property of the
 * target folder, not a mode the user picks: an empty folder gets a scaffolded
 * blank design, while a folder already holding loose `.kicad_sch` / `.kicad_pcb`
 * files gets a `.kicad_pro` that *adopts* them. The second is the case KiCad
 * handles poorly — "someone emailed me a schematic" — and the one that turns a
 * second-class starting point into a first-class one
 * (docs/projects.md §4).
 *
 * Only the folder's own top level is scanned. A project adopts what sits beside
 * it: `${KIPRJMOD}` is directory-relative and board membership is by location
 * (projectMembers.ts), so a schematic two directories down is not a candidate
 * root sheet for a project file up here.
 *
 * Pure — a listing in, a plan out.
 */

export interface FolderEntry {
  name: string
  isDirectory: boolean
}

export interface DesignFile {
  name: string
  /** The name without its extension — what a `.kicad_pro` would be named to match. */
  stem: string
}

export interface AdoptionScan {
  /**
   * A `.kicad_pro` already here. Creating into this folder is really *opening*,
   * and saying so beats silently doing one when the user asked for the other.
   */
  existingProject: string | null
  /** Candidate root sheets, in listing order. */
  schematics: DesignFile[]
  /**
   * Boards found beside them. Informational only: a `.kicad_pro` stores no board
   * path, so a board in the folder is a member by being there — there is no
   * choice here to store, and offering one would imply a link we cannot write.
   */
  boards: DesignFile[]
  /** Default project name. The folder's own name, as KiCad would have it. */
  suggestedName: string
  /** Pre-selected root sheet: the one named after the folder, else the first. */
  suggestedRootSheet: string | null
}

const stemOf = (fileName: string): string => fileName.replace(/\.[^.]+$/, '')

const matching = (entries: FolderEntry[], extension: string): DesignFile[] =>
  entries
    .filter((entry) => !entry.isDirectory && entry.name.toLowerCase().endsWith(extension))
    .map((entry) => ({ name: entry.name, stem: stemOf(entry.name) }))

/**
 * `folderName` is the containing directory's own name — the default project
 * name, and the tiebreak for which schematic is the likely root sheet.
 */
export function scanForAdoption(entries: FolderEntry[], folderName: string): AdoptionScan {
  const schematics = matching(entries, '.kicad_sch')
  const existing = entries.find(
    (entry) => !entry.isDirectory && entry.name.toLowerCase().endsWith('.kicad_pro')
  )

  // A sheet named after its folder is the root by convention — it is what our
  // own scaffold writes, and what KiCad's project manager produces.
  const namesake = schematics.find((file) => file.stem.toLowerCase() === folderName.toLowerCase())

  return {
    existingProject: existing?.name ?? null,
    schematics,
    boards: matching(entries, '.kicad_pcb'),
    suggestedName: folderName,
    suggestedRootSheet: namesake?.name ?? schematics[0]?.name ?? null
  }
}
