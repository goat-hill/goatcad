// Renderer-side unified-diff parser for the Git Diff view. Main hands over the
// raw `git diff` text and this turns it into numbered rows — pure string work,
// so it lives here where it can be tested without spawning git.

export type DiffLineType = 'add' | 'del' | 'context' | 'meta'

export interface DiffLine {
  type: DiffLineType
  /** Line number on the pre-image side, null on an added line. */
  oldNo: number | null
  /** Line number on the post-image side, null on a deleted line. */
  newNo: number | null
  text: string
}

export interface DiffHunk {
  oldStart: number
  newStart: number
  /** The trailing text of the `@@` header — git's guess at the enclosing scope. */
  heading: string
  lines: DiffLine[]
}

export interface ParsedPatch {
  hunks: DiffHunk[]
  /** git reported a binary difference rather than a text patch. */
  binary: boolean
  /** Total rows the hunks would render, so the view can cap what it mounts. */
  lineCount: number
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/

export function parsePatch(patch: string): ParsedPatch {
  const hunks: DiffHunk[] = []
  let hunk: DiffHunk | null = null
  let binary = false
  let oldNo = 0
  let newNo = 0
  let lineCount = 0

  // git terminates the patch with a newline; splitting on it as-is would leave a
  // trailing empty field that renders as a phantom blank context row.
  const body = patch.endsWith('\n') ? patch.slice(0, -1) : patch

  for (const line of body.split('\n')) {
    // A file header ends the previous hunk: without this, the next file's
    // `--- a/…` and `+++ b/…` would read as a deletion and an addition.
    if (line.startsWith('diff --git ') || line.startsWith('diff --no-index')) {
      hunk = null
      continue
    }
    const header = HUNK_HEADER.exec(line)
    if (header) {
      oldNo = Number(header[1])
      newNo = Number(header[2])
      hunk = { oldStart: oldNo, newStart: newNo, heading: header[3], lines: [] }
      hunks.push(hunk)
      continue
    }
    if (!hunk) {
      if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) binary = true
      continue
    }
    lineCount++
    if (line.startsWith('+')) {
      hunk.lines.push({ type: 'add', oldNo: null, newNo: newNo++, text: line.slice(1) })
    } else if (line.startsWith('-')) {
      hunk.lines.push({ type: 'del', oldNo: oldNo++, newNo: null, text: line.slice(1) })
    } else if (line.startsWith('\\')) {
      // "\ No newline at end of file" — annotates the line above, numbers neither side.
      hunk.lines.push({ type: 'meta', oldNo: null, newNo: null, text: line.slice(2) })
    } else {
      // Context lines carry a leading space; a stripped-trailing-whitespace patch
      // can leave an empty line where a blank context line was.
      hunk.lines.push({ type: 'context', oldNo: oldNo++, newNo: newNo++, text: line.slice(1) })
    }
  }

  return { hunks, binary, lineCount }
}
