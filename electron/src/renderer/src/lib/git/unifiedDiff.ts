/**
 * `git diff` unified output → rows the diff tab draws.
 *
 * git does the hunking (in a child process, `git:diff`); this only reads its
 * output, so the cost here is linear in the diff, never in the file.
 */

export type DiffLineKind = 'context' | 'add' | 'del'

export interface DiffLine {
  kind: DiffLineKind
  text: string
  /** 1-based line number on the old side; absent on an added line. */
  oldNo?: number
  /** 1-based line number on the new side; absent on a deleted line. */
  newNo?: number
}

export interface DiffHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  /** The text after the second `@@`: git's guess at the enclosing context. */
  section: string
  lines: DiffLine[]
}

export interface ParsedDiff {
  /** git reported `Binary files … differ`: there are no lines to show. */
  binary: boolean
  hunks: DiffHunk[]
  added: number
  removed: number
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/

/** Parse one file's unified diff. Header lines before the first hunk are skipped. */
export function parseUnifiedDiff(text: string): ParsedDiff {
  const result: ParsedDiff = { binary: false, hunks: [], added: 0, removed: 0 }
  let hunk: DiffHunk | null = null
  let oldNo = 0
  let newNo = 0
  const lines = text.split('\n')
  // The final newline ends the last line; it does not open another.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  for (const raw of lines) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    const header = HUNK_HEADER.exec(line)
    if (header) {
      hunk = {
        oldStart: Number(header[1]),
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        section: header[5] ?? '',
        lines: []
      }
      oldNo = hunk.oldStart
      newNo = hunk.newStart
      result.hunks.push(hunk)
      continue
    }
    if (!hunk) {
      if (line.startsWith('Binary files ') || line === 'GIT binary patch') result.binary = true
      continue
    }
    const mark = line[0]
    const body = line.slice(1)
    if (mark === '+') {
      hunk.lines.push({ kind: 'add', text: body, newNo: newNo++ })
      result.added++
    } else if (mark === '-') {
      hunk.lines.push({ kind: 'del', text: body, oldNo: oldNo++ })
      result.removed++
    } else if (mark === ' ' || line === '') {
      hunk.lines.push({ kind: 'context', text: body, oldNo: oldNo++, newNo: newNo++ })
    } else if (mark === '\\') {
      // "\ No newline at end of file" annotates the line before it; not content.
    } else {
      // The next file's `diff --git` header (a rename pair can print two).
      hunk = null
    }
  }
  return result
}

/** One row of the side-by-side view. A missing side is blank filler. */
export interface SplitRow {
  left?: DiffLine
  right?: DiffLine
}

/**
 * Pair a hunk's lines for side-by-side display. Within each run of changes the
 * deletions line up against the additions in order, and whichever side is
 * longer runs on against blanks — how every side-by-side diff reads a block
 * that was rewritten.
 */
export function splitRows(hunk: DiffHunk): SplitRow[] {
  const rows: SplitRow[] = []
  let dels: DiffLine[] = []
  let adds: DiffLine[] = []
  const flush = (): void => {
    const n = Math.max(dels.length, adds.length)
    for (let i = 0; i < n; i++) rows.push({ left: dels[i], right: adds[i] })
    dels = []
    adds = []
  }
  for (const line of hunk.lines) {
    if (line.kind === 'del') {
      // A deletion after additions starts a new block rather than joining this one.
      if (adds.length > 0) flush()
      dels.push(line)
    } else if (line.kind === 'add') {
      adds.push(line)
    } else {
      flush()
      rows.push({ left: line, right: line })
    }
  }
  flush()
  return rows
}

/** The row count past which the tab stops drawing and says so. */
export const MAX_RENDERED_DIFF_LINES = 5000

/** Total drawn lines of a parse, for the render cap. */
export const diffLineCount = (diff: ParsedDiff): number =>
  diff.hunks.reduce((sum, hunk) => sum + hunk.lines.length + 1, 0)
