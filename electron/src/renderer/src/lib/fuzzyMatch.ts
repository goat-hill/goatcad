/**
 * Fuzzy filename matcher for the Quick Open palette (Ctrl/Cmd+P).
 *
 * Query characters must appear in order in the candidate (case-insensitive
 * subsequence); the score prefers the alignments a person means when typing
 * a filename: runs of consecutive characters, characters that start a word
 * (after a path separator, `.`, `_`, `-` or space), and characters inside
 * the basename over ones buried in parent directory names.
 *
 * Matching is a single greedy left-to-right scan with one lookahead rule:
 * for each query character, the next occurrence is taken when it continues
 * the current run, otherwise a later word-boundary occurrence wins over an
 * arbitrary mid-word one. That keeps `readme` from matching the `r` inside
 * `hardware/` when `hardware/readme.md` has the real word start later.
 * Deliberately not an optimal-alignment DP — candidates are short paths and
 * this runs per keystroke over the whole project listing.
 */

export interface FuzzyMatch {
  score: number
  /** Ascending candidate indices of the matched query characters. */
  indices: number[]
}

const WORD_SEPARATORS = new Set(['/', '\\', '.', '_', '-', ' '])

const isWordStart = (candidate: string, index: number): boolean =>
  index === 0 || WORD_SEPARATORS.has(candidate[index - 1])

const BONUS_WORD_START = 6
// Above BONUS_WORD_START: a typed run (`sch` → `.kicad_sch`) must outrank
// the same letters scattered across word starts (`silk-copper-hole`).
const BONUS_CONSECUTIVE = 8
const BONUS_BASENAME = 2

export const fuzzyMatch = (query: string, candidate: string): FuzzyMatch | null => {
  const q = query.toLowerCase()
  const c = candidate.toLowerCase()
  if (q.length === 0) return { score: 0, indices: [] }
  if (q.length > c.length) return null

  const basenameStart = Math.max(candidate.lastIndexOf('/'), candidate.lastIndexOf('\\')) + 1

  let score = 0
  const indices: number[] = []
  let searchFrom = 0
  for (const ch of q) {
    const first = c.indexOf(ch, searchFrom)
    if (first === -1) return null
    let match = first
    const prev = indices.length > 0 ? indices[indices.length - 1] : -2
    // A continued run beats everything; otherwise hop to a word start if
    // this character has one further along.
    if (first !== prev + 1 && !isWordStart(c, first)) {
      for (let i = first + 1; i < c.length; i++) {
        if (c[i] === ch && isWordStart(c, i)) {
          match = i
          break
        }
      }
    }
    score += 1
    if (isWordStart(c, match)) score += BONUS_WORD_START
    if (match === prev + 1) score += BONUS_CONSECUTIVE
    if (match >= basenameStart) score += BONUS_BASENAME
    indices.push(match)
    searchFrom = match + 1
  }
  return { score, indices }
}
