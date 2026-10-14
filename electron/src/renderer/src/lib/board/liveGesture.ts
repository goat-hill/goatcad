/**
 * What undo and redo act on while a router gesture is live (docs/router-behavior.md
 * R22): the gesture in hand first, then history. A gesture holds board indices
 * from when it began, so history must never move under it — undo steps the
 * gesture back or ends it, and redo waits until it is over.
 */

export interface LiveGestures {
  /** A track, via, arc or footprint drag. */
  drag: boolean
  /** A differential pair armed or in hand (PR1). */
  pair: boolean
  /** A length or skew tune (T1). */
  tune: boolean
  /** A route with a start laid. */
  route: boolean
}

export type UndoTarget = 'drag' | 'pair' | 'tune' | 'route' | 'history'

/** Undo takes back the gesture in hand, innermost first; with none, history. */
export function undoTarget(live: LiveGestures): UndoTarget {
  if (live.drag) return 'drag'
  if (live.pair) return 'pair'
  if (live.tune) return 'tune'
  if (live.route) return 'route'
  return 'history'
}

/** Redo only with no gesture live: nothing a gesture took back comes back mid-gesture. */
export const redoAllowed = (live: LiveGestures): boolean =>
  !live.drag && !live.pair && !live.tune && !live.route

/** A new gesture starts only with none other live, so no two hold the board's indices at once. */
export const gestureFree = (live: LiveGestures): boolean => redoAllowed(live)
