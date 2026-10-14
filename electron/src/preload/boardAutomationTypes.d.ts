/**
 * How each board's zone fill and design checks run on their own — the
 * persisted shape, shared across the process boundary. Semantics in renderer
 * `lib/board/boardAutomation.ts`.
 *
 * Per board, by file path, in the config store beside the panel layout: editor
 * state, not the design's, so nothing is written into the KiCad files. A board
 * on the defaults has no entry.
 */

/** The least work that gives the whole answer; the whole board every time; nothing on its own. */
export type AutoMode = 'greedy' | 'full' | 'off'

/** The zone fill has no partial refill: every zone, or none on its own. */
export type ZoneFillMode = 'full' | 'off'

export interface BoardAutomationState {
  zoneFill?: ZoneFillMode
  drc?: AutoMode
}

/** Board file path → its settings, oldest first; bounded on write. */
export type BoardAutomationConfig = Record<string, BoardAutomationState>
