/**
 * Gesture machinery shared by the editors' insert tools.
 *
 * Every canvas tool collects clicks the same three ways — `drop` (one click
 * places the thing), `span` (a fixed number of points, each click setting
 * one), `chain` (a point per vertex, unbounded, ended by a gesture) — and the
 * rules for when a draft becomes a commit depend only on that gesture and the
 * point count, never on what the tool draws. Stating them once here is what
 * keeps a rectangle in the symbol editor and a rectangle on a board the same
 * gesture; the per-editor tool modules (`symbolTools.ts`, `kicad/pcbTools.ts`)
 * own what the committed points *mean*.
 *
 * The functions are generic over the point type and unit-agnostic: the one
 * place a unit appears is the same-spot test `gestureClick` needs, and that
 * comes in as the `equal` predicate so a caller could compare in its own
 * domain. Every editor's draft is integer-nm now, so the default — exact
 * integer equality — is what they all use.
 *
 * The semantics are documented at the wrappers that made them (symbolTools):
 * a chain ends by clicking the last point placed (which is also what makes a
 * double-click finish), and clicking back on the start closes the outline by
 * keeping the repeated point — the caller decides whether "closed" means a
 * repeated vertex (KiCad polyline) or a polygon.
 */

import { pointsEqualNm } from './kicad/coordinates'

export interface Point2 {
  x: number
  y: number
}

export type ToolGesture = 'drop' | 'span' | 'chain'

/** What a click or a drag does to the points a tool has collected. */
export interface GestureResult<P extends Point2 = Point2> {
  draft: P[]
  commit: P[] | null
}

/**
 * Fold a click into the points an armed tool holds. Pure and total.
 *
 * `equal` decides when two clicks name the same spot — exact integer
 * equality by default, since every editor's draft is domain nm.
 */
export function gestureClick<P extends Point2>(
  gesture: ToolGesture,
  pointCount: number,
  draft: P[],
  point: P,
  equal: (a: Point2, b: Point2) => boolean = pointsEqualNm
): GestureResult<P> {
  if (gesture === 'drop') return { draft: [], commit: [point] }
  if (draft.length === 0) return { draft: [point], commit: null }
  if (gesture === 'span') {
    // One click per point, committing on the one that completes the count.
    const points = [...draft, point]
    return points.length >= pointCount
      ? { draft: [], commit: points }
      : { draft: points, commit: null }
  }
  // Under two points there is no segment, so finishing inserts nothing.
  const finish = (): GestureResult<P> => ({ draft: [], commit: draft.length >= 2 ? draft : null })
  // Clicking the vertex just placed ends the chain — which is also what makes a
  // double-click finish it, the second press landing on the point the first left.
  if (equal(draft[draft.length - 1], point)) return finish()
  if (equal(draft[0], point)) {
    // Clicking back on the start CLOSES the chain by keeping the repeated
    // point. It needs an area to close: with only a segment down, A→B→A
    // doubles back on itself and encloses nothing, so that click finishes.
    return draft.length >= 3 ? { draft: [], commit: [...draft, point] } : finish()
  }
  return { draft: [...draft, point], commit: null }
}

/**
 * End a chain in progress without adding a point — what right-click does.
 * Anything else keeps its points, so the caller can tell "finished" from
 * "there was nothing to finish" and unwind a level instead.
 */
export function gestureFinish<P extends Point2>(
  gesture: ToolGesture,
  draft: P[]
): GestureResult<P> {
  if (gesture !== 'chain' || draft.length < 2) return { draft, commit: null }
  return { draft: [], commit: draft }
}
