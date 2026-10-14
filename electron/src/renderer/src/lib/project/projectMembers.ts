/**
 * Which boards belong to a project.
 *
 * The Project pane resolves each kind of member by its own explicit link
 * (docs/projects.md): schematics through the project's root-sheet
 * uuid and the sheet hierarchy, libraries through the `sym-lib-table` /
 * `fp-lib-table` entries the index reads. Boards are the exception — a
 * `.kicad_pro` carries board *settings* but never a board *filename*, and its
 * `boards` array is empty outside multi-board projects — so they are found on
 * disk and matched by stem, which is the rule KiCad's own project manager uses.
 *
 * That makes this a filesystem walk rather than a graph traversal, which is why
 * it lives here rather than alongside the other membership rules.
 */

export interface FileNode {
  name: string
  path: string
  isDirectory: boolean
  children?: FileNode[]
}

export interface ProjectMember {
  name: string
  path: string
}

const SEP = /[/\\]/

const norm = (p: string): string[] =>
  p
    .replace(/[/\\]+$/, '')
    .split(SEP)
    .filter(Boolean)

/**
 * Is `path` at or below `dir`?
 *
 * Segment-wise and case-insensitive, for the same reasons as `depthBelow` in
 * projectDetect.ts: a raw prefix compare would call `/hw-other/x` a child of
 * `/hw`, and macOS/Windows resolve case-differing paths to the same file.
 */
export function isUnder(path: string, dir: string): boolean {
  const a = norm(path)
  const b = norm(dir)
  if (a.length < b.length) return false
  return b.every((seg, i) => seg.toLowerCase() === a[i].toLowerCase())
}

/** Every `.kicad_pcb` at or below `projectDir`, in the loaded workspace tree. */
export function collectBoards(files: FileNode[], projectDir: string): ProjectMember[] {
  const boards: ProjectMember[] = []

  const visit = (node: FileNode): void => {
    if (node.isDirectory) {
      for (const child of node.children ?? []) visit(child)
      return
    }
    if (isUnder(node.path, projectDir) && node.name.toLowerCase().endsWith('.kicad_pcb')) {
      boards.push({ name: node.name, path: node.path })
    }
  }

  for (const node of files) visit(node)
  return boards.sort((a, b) => a.name.localeCompare(b.name))
}
