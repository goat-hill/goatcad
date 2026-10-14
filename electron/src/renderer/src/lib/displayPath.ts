/**
 * Paths as the UI shows them.
 *
 * A full path is the only thing that distinguishes two projects with the same
 * folder name, so surfaces that list projects print it — but most of a path is
 * the same home prefix on every row, which is noise that pushes the part that
 * differs off the end. Abbreviating it to `~` is the convention every editor
 * uses, and it buys back the width where it matters.
 *
 * Pure: a path and a home directory in, a display string out.
 */

const segments = (path: string): string[] =>
  path
    .replace(/[/\\]+$/, '')
    .split(/[/\\]/)
    .filter(Boolean)

/**
 * `/home/ada/pcb/psu` → `~/pcb/psu`, given a home of `/home/ada`.
 *
 * Returns `path` untouched when it isn't under `home`. The comparison is
 * case-insensitive for the same reason `depthBelow` in projectDetect.ts is:
 * macOS and Windows resolve case-differing paths to the same directory, so a
 * strict compare would leave a home path unabbreviated on two of three
 * platforms. The original separator style is preserved, so a Windows path stays
 * backslashed.
 */
export function abbreviateHome(path: string, home: string | null | undefined): string {
  if (!home) return path
  const parts = segments(path)
  const homeParts = segments(home)
  if (homeParts.length === 0 || parts.length < homeParts.length) return path
  for (let i = 0; i < homeParts.length; i++) {
    if (parts[i].toLowerCase() !== homeParts[i].toLowerCase()) return path
  }
  const separator = path.includes('\\') ? '\\' : '/'
  const rest = parts.slice(homeParts.length)
  return rest.length === 0 ? '~' : `~${separator}${rest.join(separator)}`
}

/**
 * `/home/ada/pcb/psu/boards/main.kicad_pcb` → `boards/main.kicad_pcb`, given a
 * project at `/home/ada/pcb/psu`: a file inside the project as its path from
 * the project folder, forward slashes whatever the platform. Null when the
 * file is outside the project. Compared case-insensitively, as `abbreviateHome`
 * compares.
 */
export function pathInProject(path: string, projectDir: string | null | undefined): string | null {
  if (!projectDir) return null
  const parts = segments(path)
  const projectParts = segments(projectDir)
  if (projectParts.length === 0 || parts.length <= projectParts.length) return null
  for (let i = 0; i < projectParts.length; i++) {
    if (parts[i].toLowerCase() !== projectParts[i].toLowerCase()) return null
  }
  return parts.slice(projectParts.length).join('/')
}

/** A file as a dialog names it: from the project folder when inside it, else with home as `~`. */
export function displayFilePath(
  path: string,
  projectDir: string | null | undefined,
  home: string | null | undefined
): string {
  return pathInProject(path, projectDir) ?? abbreviateHome(path, home)
}
