/**
 * Which project is a window looking at?
 *
 * The workspace (an opened folder) and the project (a `.kicad_pro` and the graph
 * it roots) are different scopes — see docs/projects.md. A workspace
 * may hold several projects: design variants sharing a directory (KiCad's own
 * `demos/ecc83` has two) or a sub-board nested inside a parent board
 * (`demos/royalblue54L_feather`). Only one is ever active.
 *
 * Everything here is pure: paths and parsed values in, a choice out. The rules
 * are small but easy to get subtly wrong, so they live behind tests rather than
 * inline in a component.
 */

export interface ProjectCandidate {
  /** Absolute path to the `.kicad_pro`. */
  path: string
  /**
   * The file stem. Not a display name — a `.kicad_pro` carries no name field —
   * but it *is* KiCad's project name, and the only thing associating a board
   * with a project (`psu.kicad_pro` ↔ `psu.kicad_pcb`). Show `fileName`.
   */
  name: string
  /** `psu.kicad_pro` — what the UI shows, since that is all the file really is. */
  fileName: string
  /** Directory holding the project file; the base for `${KIPRJMOD}`. */
  dir: string
  /** Path segments between the workspace root and `dir`; 0 means at the root. */
  depth: number
}

const SEP = /[/\\]/

const stripTrailingSep = (p: string): string => p.replace(/[/\\]+$/, '')

export const dirNameOf = (filePath: string): string =>
  filePath.split(SEP).slice(0, -1).join('/') || '/'

export const projectNameOf = (filePath: string): string =>
  (filePath.split(SEP).pop() ?? '').replace(/\.kicad_pro$/i, '')

/**
 * Depth of `dir` below `root`, or -1 when it isn't below it at all.
 *
 * The comparison is case-insensitive because macOS and Windows resolve
 * case-differing paths to the same directory; treating them as unrelated would
 * wrongly report a project as outside its own workspace.
 */
export function depthBelow(dir: string, root: string): number {
  const a = stripTrailingSep(dir).split(SEP).filter(Boolean)
  const b = stripTrailingSep(root).split(SEP).filter(Boolean)
  if (a.length < b.length) return -1
  for (let i = 0; i < b.length; i++) {
    if (a[i].toLowerCase() !== b[i].toLowerCase()) return -1
  }
  return a.length - b.length
}

/** Builds candidates from discovered `.kicad_pro` paths, nearest-first. */
export function projectCandidates(projectFilePaths: string[], root: string): ProjectCandidate[] {
  return projectFilePaths
    .map((path) => {
      const dir = dirNameOf(path)
      return {
        path,
        name: projectNameOf(path),
        fileName: path.split(SEP).pop() ?? path,
        dir,
        depth: depthBelow(dir, root)
      }
    })
    .filter((c) => c.depth >= 0)
    .sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path))
}

/**
 * The active project on opening a workspace, or null when the answer is
 * ambiguous.
 *
 * A project at the workspace root wins over nested ones: putting a project file
 * at the top of a folder is a deliberate statement that the folder *is* that
 * design, and a sub-board inside it doesn't compete with that. Anything else
 * ambiguous — several at the root, or several nested with none at the root —
 * yields null, and the user picks. Guessing is worse than asking here, because
 * a wrong guess silently applies another design's libraries and design rules
 * rather than failing visibly.
 */
export function chooseActiveProject(candidates: ProjectCandidate[]): ProjectCandidate | null {
  if (candidates.length === 0) return null
  if (candidates.length === 1) return candidates[0]
  const atRoot = candidates.filter((c) => c.depth === 0)
  return atRoot.length === 1 ? atRoot[0] : null
}

/**
 * Does `project` own `schematicUuid`?
 *
 * Ownership is a property of the design graph, not of the filesystem. The
 * obvious rule — nearest ancestor `.kicad_pro` — fails on the real case: in
 * `demos/ecc83` both schematics sit beside both project files, so path
 * proximity cannot distinguish them. A project's `sheets` entry names its root
 * sheet by uuid, and that is the authoritative link.
 *
 * This answers only for the *root* sheet. Child sheets are owned transitively
 * through the hierarchy, which needs the sheet graph rather than a uuid compare.
 */
export const ownsRootSheet = (projectRootUuid: string | null, schematicUuid: string): boolean =>
  projectRootUuid !== null && projectRootUuid.toLowerCase() === schematicUuid.toLowerCase()

/**
 * Root sheet uuid recorded in a parsed `.kicad_pro`, or null if absent.
 *
 * KiCad v3 writes `sheets: [[uuid, name], …]` with the root first. Older files
 * (and the ones GoatCAD itself wrote before P0.8) may carry a filename in that
 * slot instead, which is not a uuid — those return null rather than a value
 * that would compare falsely against a real uuid.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function rootSheetUuid(project: unknown): string | null {
  if (typeof project !== 'object' || project === null) return null
  const sheets = (project as { sheets?: unknown }).sheets
  if (!Array.isArray(sheets) || sheets.length === 0) return null
  const first = sheets[0]
  const id = Array.isArray(first) ? first[0] : undefined
  return typeof id === 'string' && UUID_RE.test(id) ? id : null
}
