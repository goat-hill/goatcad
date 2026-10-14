/**
 * One symbol's share of a `.kicad_sym` text diff: where its definition sits in
 * each version, and git's hunks trimmed to those lines.
 */
import { getFirstAtomValue, getToken, parseSExpr, positionAt, type SExprList } from '../kicad/sexpr'
import type { DiffHunk } from './unifiedDiff'

/** 1-based inclusive line span. */
export interface LineRange {
  first: number
  last: number
}

/**
 * The lines a top-level symbol's definition spans, or null when the library
 * has no such symbol (or does not parse). Pure; exported for tests.
 */
export function symbolLineRange(source: string | null, name: string): LineRange | null {
  if (source === null) return null
  let root
  try {
    root = parseSExpr(source)
  } catch {
    return null
  }
  if (root.type !== 'list') return null
  for (const child of root.children) {
    if (child.type !== 'list' || getToken(child) !== 'symbol') continue
    if (getFirstAtomValue(child as SExprList) !== name) continue
    return {
      first: positionAt(source, child.start).line,
      last: positionAt(source, Math.max(child.start, child.end - 1)).line
    }
  }
  return null
}

const within = (line: number | undefined, range: LineRange | null): boolean =>
  line !== undefined && range !== null && line >= range.first && line <= range.last

/**
 * Keep only the lines of each hunk that belong to the symbol — a deletion by
 * its old line, an addition by its new one, context by either — and drop a
 * hunk left with no change in it. Pure; exported for tests.
 */
export function hunksWithin(
  hunks: readonly DiffHunk[],
  before: LineRange | null,
  after: LineRange | null
): DiffHunk[] {
  const out: DiffHunk[] = []
  for (const hunk of hunks) {
    const lines = hunk.lines.filter((line) =>
      line.kind === 'del'
        ? within(line.oldNo, before)
        : line.kind === 'add'
          ? within(line.newNo, after)
          : within(line.oldNo, before) || within(line.newNo, after)
    )
    if (!lines.some((line) => line.kind !== 'context')) continue
    const first = lines[0]
    const oldLines = lines.filter((l) => l.kind !== 'add').length
    const newLines = lines.filter((l) => l.kind !== 'del').length
    out.push({
      oldStart: first.oldNo ?? hunk.oldStart,
      oldLines,
      newStart: first.newNo ?? hunk.newStart,
      newLines,
      section: hunk.section,
      lines
    })
  }
  return out
}
