/**
 * Which file an agent's library write lands in: the active project's own
 * symbol library or footprint library, named after the project unless the
 * caller names one.
 *
 * Resolved from the window's active project (`projects.md` §3), never
 * from a scan of the workspace folder: a folder can hold several projects, and
 * a scan that found none or two once wrote a generated symbol into a library
 * no tab held and no table named. With no
 * active project the write is refused rather than guessed.
 */
export interface ProjectLibraryContext {
  /** The workspace folder, or null. */
  projectPath: string | null
  /** The active project's `.kicad_pro`, or null when none is active. */
  projectFile: string | null
}

export type LibraryFileKind = 'symbol' | 'footprint'

export type ProjectLibraryTarget =
  | {
      ok: true
      projectFile: string
      projectDir: string
      /** The library's file stem, which is also its nickname when it is new. */
      stem: string
      /** `<dir>/<stem>.kicad_sym`, or the `<dir>/<stem>.pretty` folder. */
      path: string
    }
  | { ok: false; error: 'no-project' | 'no-active-project'; remedy: string }

const parts = (path: string): string[] => path.split(/[/\\]/)

export const resolveProjectLibrary = (
  context: ProjectLibraryContext,
  kind: LibraryFileKind,
  library?: string
): ProjectLibraryTarget => {
  if (!context.projectPath && !context.projectFile) {
    return {
      ok: false,
      error: 'no-project',
      remedy: 'No project is open, so there is no library to write into.'
    }
  }
  if (!context.projectFile) {
    return {
      ok: false,
      error: 'no-active-project',
      remedy:
        'The open folder has no single active project, so there is no one library to write into. Ask the user to choose the active project in the sidebar.'
    }
  }
  const segments = parts(context.projectFile)
  const projectDir = segments.slice(0, -1).join('/')
  const projectStem = (segments[segments.length - 1] ?? '').replace(/\.kicad_pro$/i, '')
  const stem = (library?.trim() || projectStem).replace(/\.(kicad_sym|pretty)$/i, '')
  const extension = kind === 'symbol' ? '.kicad_sym' : '.pretty'
  return {
    ok: true,
    projectFile: context.projectFile,
    projectDir,
    stem,
    path: `${projectDir}/${stem}${extension}`
  }
}

/** The names most like `wanted`: those containing it or contained in it, else all; eight at most. */
export const nearNames = (wanted: string, names: string[]): string[] => {
  const needle = wanted.toLowerCase()
  const close = names.filter((entry) => {
    const lower = entry.toLowerCase()
    return lower.includes(needle) || needle.includes(lower)
  })
  return (close.length ? close : names).slice(0, 8)
}
