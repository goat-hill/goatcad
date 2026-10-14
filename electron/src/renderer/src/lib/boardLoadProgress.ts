/**
 * Opening a board runs two phases the user must read as one bar: the chunked
 * parse, then the 2D scene build. This folds them onto a single fraction so
 * the bar only ever moves forward — EditorArea maps the result onto the tail
 * of its read → parse → build bar.
 */

/** Share of the bar the parse owns; the scene build takes the rest. */
export const PARSE_SLICE = 0.7

/**
 * `null` when nothing is loading. `awaitingScene` covers the handoff — the
 * parse has settled and the viewport has not reported its first build slice
 * yet — without which the bar would blink off between the two phases.
 */
export function mergeBoardLoadProgress(
  parse: number | null,
  scene: number | null,
  awaitingScene: boolean
): number | null {
  if (scene !== null) return PARSE_SLICE + scene * (1 - PARSE_SLICE)
  if (awaitingScene) return PARSE_SLICE
  if (parse !== null) return parse * PARSE_SLICE
  return null
}
