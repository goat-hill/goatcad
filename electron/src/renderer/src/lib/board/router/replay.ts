/**
 * Deterministic replay for the router engine. PNS ships a replayable event
 * log, and its authors' verdict is that the interactive algorithms are
 * undebuggable without one.
 *
 * A replay is a world plus a cursor-event list; the runner drives the same
 * `RouteSession` the editor drives, with the editor's click-folding: a click
 * commits the current proposal (unless blocked) and advances the tail. Tests
 * pin engine behavior as (fixture board + events) → golden segments, which
 * is exactly how a misbehaving interactive session gets turned into a
 * regression test.
 */

import type { Pt } from '../spatialIndex'
import type { RouterWorld } from './world'
import { RouteSession, type ProposedSegment, type RouteRequest } from './engine'

export interface ReplayEvent {
  type: 'move' | 'click'
  x: number
  y: number
}

export type ReplaySettings = Omit<RouteRequest, 'tail' | 'cursor'>

export interface ReplayState {
  /** Committed segments, in commit order. */
  committed: ProposedSegment[]
  /** The pending tail after the last event (null before the first click). */
  tail: Pt | null
  /** The live proposal after the last move (what the preview would show). */
  preview: ProposedSegment[]
  /** Clicks refused because the proposal was blocked. */
  refusals: number
}

export function replayRoute(
  world: RouterWorld,
  settings: ReplaySettings,
  events: readonly ReplayEvent[]
): ReplayState {
  const state: ReplayState = { committed: [], tail: null, preview: [], refusals: 0 }
  // One session for the whole replay, as the editor keeps one per trace:
  // what a frame decided carries into the next.
  const session = new RouteSession(world)
  for (const event of events) {
    const cursor = { x: event.x, y: event.y }
    if (!state.tail) {
      if (event.type === 'click') state.tail = cursor
      continue
    }
    const proposal = session.propose({ ...settings, tail: state.tail, cursor })
    if (event.type === 'move') {
      state.preview = proposal.segments
      continue
    }
    if (proposal.blocked) {
      state.refusals++
      continue
    }
    session.markClick()
    state.committed.push(...proposal.segments)
    state.tail = proposal.endsAt
  }
  return state
}
