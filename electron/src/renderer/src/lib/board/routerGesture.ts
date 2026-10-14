/**
 * What the mouse and Esc do while routing, pairing, dragging or tuning
 * (docs/router-behavior.md R21, R23, D9, T1, PR6), and the router's
 * right-click menu: KiCad's Interactive Router menu, the items we support.
 * The editor turns these answers into actions; this file only decides.
 */
import type { HotkeyActionId } from '../hotkeys'
import type { PcbRouterMode } from '../pcbRouter'

/** The router gesture a right-click or Esc lands in. */
export type RouterGesture = 'route' | 'pair' | 'drag' | 'tune'

export interface RouterMenuContext {
  gesture: RouterGesture
  /** A route or pair has its start (the route tool may be armed with none). */
  started: boolean
  /** A click has laid something: Undo Last Segment has a step to take. */
  clicked: boolean
  /** The net has copper the route has not joined (KiCad's "has other end"). */
  hasOtherEnd: boolean
}

export type RouterMenuId =
  | 'cancel'
  | 'finish'
  | 'undoSegment'
  | 'routeFromOtherEnd'
  | 'attemptFinish'
  | 'viaThrough'
  | 'viaBlind'
  | 'viaMicro'
  | 'viaPickThrough'
  | 'viaPickBlind'
  | 'posture'
  | 'corner'
  | 'sizes'
  | 'pairDimensions'
  | 'tuneSettings'
  | 'mode'

export type RouterMenuRow =
  { id: RouterMenuId; hotkey?: HotkeyActionId; disabled?: boolean } | { divider: true }

const DIVIDER = { divider: true } as const

/**
 * The rows of the router's context menu, in KiCad's order: Cancel, then
 * finishing and stepping back, then vias and the track's shape, then sizes
 * and the mode. `corner`, `sizes` and `mode` are submenus the editor fills.
 */
export function routerMenuRows(ctx: RouterMenuContext): RouterMenuRow[] {
  const idle = !ctx.started
  switch (ctx.gesture) {
    case 'route':
      return [
        { id: 'cancel', hotkey: 'editor.cancel' },
        DIVIDER,
        { id: 'finish', hotkey: 'pcb.endRoute', disabled: idle },
        { id: 'undoSegment', hotkey: 'pcb.unrouteLast', disabled: !ctx.clicked },
        ...(ctx.started && ctx.hasOtherEnd
          ? ([
              { id: 'routeFromOtherEnd', hotkey: 'pcb.routeFromOtherEnd' },
              { id: 'attemptFinish', hotkey: 'pcb.finishRoute' }
            ] as const)
          : []),
        DIVIDER,
        // With no route yet, V arms a via for the next one (R37).
        { id: 'viaThrough', hotkey: 'pcb.routeVia' },
        { id: 'viaBlind', hotkey: 'pcb.routeBlindVia', disabled: idle },
        { id: 'viaMicro', hotkey: 'pcb.paste', disabled: idle },
        { id: 'viaPickThrough', hotkey: 'pcb.routeViaPickLayer', disabled: idle },
        { id: 'viaPickBlind', hotkey: 'pcb.routeBlindViaPickLayer', disabled: idle },
        { id: 'posture', hotkey: 'pcb.routePosture', disabled: idle },
        { id: 'corner' },
        DIVIDER,
        { id: 'sizes' },
        { id: 'mode' }
      ]
    case 'pair':
      return [
        { id: 'cancel', hotkey: 'editor.cancel' },
        DIVIDER,
        { id: 'finish', hotkey: 'pcb.endRoute', disabled: idle },
        { id: 'undoSegment', hotkey: 'pcb.unrouteLast', disabled: !ctx.clicked },
        DIVIDER,
        { id: 'viaThrough', hotkey: 'pcb.routeVia', disabled: idle },
        { id: 'posture', hotkey: 'pcb.routePosture', disabled: idle },
        DIVIDER,
        { id: 'pairDimensions' },
        { id: 'mode' }
      ]
    case 'drag':
      return [
        { id: 'cancel', hotkey: 'editor.cancel' },
        DIVIDER,
        { id: 'finish' },
        DIVIDER,
        { id: 'corner' },
        { id: 'mode' }
      ]
    case 'tune':
      return [
        { id: 'cancel', hotkey: 'editor.cancel' },
        DIVIDER,
        { id: 'finish' },
        DIVIDER,
        { id: 'tuneSettings' }
      ]
  }
}

export interface EscapeContext {
  drag: boolean
  tune: boolean
  pair: boolean
  /** A route has its start. */
  route: boolean
  /** A graphics tool has points down. */
  draft: boolean
  /** A tool other than select is armed. */
  toolArmed: boolean
}

export type EscapeAction =
  'endDrag' | 'endTune' | 'endPair' | 'endRoute' | 'clearDraft' | 'putToolAway' | 'clearSelection'

/**
 * Esc (R21, KiCad's cancel): the gesture in hand ends at once — a drag or a
 * tune leaving the board as it was, a route or pair keeping what was clicked,
 * its head and any armed via dropped. With none, the tool is put away, a via
 * armed for the next route with it; with no tool, the selection goes.
 */
export function escapeAction(ctx: EscapeContext): EscapeAction {
  if (ctx.drag) return 'endDrag'
  if (ctx.tune) return 'endTune'
  if (ctx.pair) return 'endPair'
  if (ctx.route) return 'endRoute'
  if (ctx.draft) return 'clearDraft'
  if (ctx.toolArmed) return 'putToolAway'
  return 'clearSelection'
}

/**
 * A route click with nothing to lay — on the route's own end (R21, KiCad's
 * FixRoute of an empty line): it does nothing, unless a via is armed, which is
 * placed there alone and ends the route (a via down to a plane).
 */
export const emptyRouteClick = (viaArmed: boolean): 'nothing' | 'placeViaAndFinish' =>
  viaArmed ? 'placeViaAndFinish' : 'nothing'

export interface DropContext {
  /** What the drop would commit violates clearance. */
  blocked: boolean
  mode: PcbRouterMode
  /** Highlight with *Allow DRC violations* on: a violating drop lands. */
  allowViolations: boolean
  /** The drag pushes or walks (Push, Avoid) and can be redrawn at a cursor. */
  resolves: boolean
  /** A cursor the drag was last legal at, other than the drop's. */
  lastValid: boolean
  /** Ctrl (Cmd) held at the drop: commit anyway. */
  commitAnyway: boolean
  /** The mouse button came up (a press-drag), rather than a click ending a `D` drag. */
  release: boolean
}

export type DropOutcome = 'commit' | 'commitLastValid' | 'stay' | 'revert'

/**
 * What a drag's drop does (D9), as KiCad's dragger: legal, it commits. In
 * Highlight a violating drop commits only with violations allowed. A Push or
 * Avoid drag commits where it was last legal; with no such place, Ctrl
 * commits it anyway (KiCad's commit of a drag fallen back to marking).
 * Otherwise a click leaves the drag going and a release springs it back.
 */
export function dropOutcome(d: DropContext): DropOutcome {
  if (!d.blocked) return 'commit'
  if (d.mode === 'highlight') {
    if (d.allowViolations) return 'commit'
    return d.release ? 'revert' : 'stay'
  }
  if (d.resolves && d.lastValid) return 'commitLastValid'
  if (d.commitAnyway) return 'commit'
  return d.release ? 'revert' : 'stay'
}
