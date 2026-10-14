// Parts follow KiCad's source, named below: Copyright The KiCad Developers, GPL-3.0-or-later.
/**
 * How the board's router meets other copper, as persisted state.
 *
 * EDITING preferences — how a route or a track drag treats what is in its way,
 * never what the board contains — so they are never written to the board
 * file; KiCad, too, keeps router settings with the user. They live in the
 * main-process config store rather than `localStorage` (RULES.md §8) because
 * every window shares one set, and this file lives in preload because that is
 * the one directory both tsconfigs can see (§9).
 *
 * The renderer-side store is `renderer/src/lib/pcbRouter.ts`; the control is
 * the router pill in the board's corner (`components/pcb/CollisionModeControl.vue`).
 */

export interface PcbRouterState {
  /**
   * What a route or a track drag does on meeting other copper: push it aside,
   * bend round it, or only mark the collision (KiCad's Shove, Walkaround and
   * Highlight collisions). Highlight refuses to commit a violation unless
   * `settings.allowViolations` is on.
   */
  mode: PcbRouterMode
  /** The route's corners (KiCad's corner mode); absent is 45°. */
  corner?: PcbRouterCorner
  /**
   * The router's behaviour switches, KiCad's Interactive Router Settings
   * (`pcbnew/router/pns_routing_settings.cpp`), each absent until changed and
   * then KiCad's default when read (`routerSettings`, renderer
   * `lib/pcbRouter.ts`). docs/router-behavior.md says what each governs.
   */
  settings?: Partial<PcbRouterSettings>
}

export interface PcbRouterSettings {
  /** Push vias (P1); off, they are walked round as what cannot move. */
  shoveVias: boolean
  /** Pushed copper that meets what cannot move is walked on round it, behind it, rather than holding (P10). */
  jumpOverObstacles: boolean
  /** A route removes the connection it replaces (R27). */
  removeLoops: boolean
  /** Routes leave and enter pads by their cleanest exit (R38). */
  smartPads: boolean
  /** A dragged segment snaps into line with its neighbours, a dragged corner onto where they meet (D11). */
  smoothDragged: boolean
  /** The whole dragged line is tidied, not only the part the drag re-drew (D10). */
  optimizeDragged: boolean
  /** The posture follows the mouse (R4); off, it is the one `startDiagonal` names, `/` flipping it. */
  autoPosture: boolean
  /** Without auto posture, routes start with the diagonal. */
  startDiagonal: boolean
  /** A click fixes the whole head; off, the segment nearest the cursor stays free (R18). */
  fixAllSegments: boolean
  /** In Highlight, a click or a drop commits copper that breaks clearance (R19, D9). */
  allowViolations: boolean
  /** In Highlight, the head is one straight segment at any angle (R3). */
  freeAngle: boolean
}

export type PcbRouterMode = 'shove' | 'walkaround' | 'highlight'

/** 45°, 45° with arcs, 90°, 90° with arcs: KiCad's Mitered and Rounded 45 and 90. */
export type PcbRouterCorner = '45' | 'arc45' | '90' | 'arc90'
