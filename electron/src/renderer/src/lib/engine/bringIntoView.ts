// Bringing a cross-selected item into view without taking the user's zoom
// (split-view-workstream.md §6, "Reveal without re-framing").
//
// A probe answers a gesture made in the OTHER pane, so the pane it lands in is
// usually the one being read rather than driven, and its zoom is working state:
// someone zoomed in to route a fanout, or out to see a whole sheet. Re-fitting
// to the probed part throws that away on every click, which is what
// `zoomToFit` did here before.
//
// The rule is three disjoint cases, decided by geometry rather than by a
// preference (KiCad spells the same question as two checkboxes, "center view"
// and "zoom to fit", and centers unconditionally):
//
//   fits and is fully visible  → nothing moves
//   fits but is not visible    → pan only; the zoom is untouched
//   does not fit               → zoom OUT until it does, and center it
//
// "Visible" means inside the SAFE rect — the canvas minus the floating
// toolbars and status pills drawn over it — because a part under the toolbar
// is on screen and not in view. The insets come from `viewportInsets.ts`.
//
// When something DOES move it is centered on the canvas, never on the safe rect:
// the chrome is paid for in the zoom instead (`centeredFit`), because a part
// parked off-center to balance a lopsided toolbar reads as a bug.
//
// Pure geometry, no THREE and no engine: the three branches are the whole
// behaviour and they are worth testing directly.

/** Chrome overlaying the canvas, in CSS pixels, per edge. */
export interface ViewInsets {
  top: number
  right: number
  bottom: number
  left: number
}

/** An axis-aligned world rectangle, y-up scene space, millimetres. */
export interface WorldBounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export interface BringIntoViewInput {
  /** What to reveal. */
  target: WorldBounds
  /** What the camera shows right now (`ViewportEngine.visibleWorldBox()`). */
  visible: WorldBounds
  /** Current zoom, in CSS pixels per world millimetre. */
  zoom: number
  /** Canvas size in CSS pixels. */
  viewport: { width: number; height: number }
  /** Toolbars and pills drawn over the canvas. */
  insets: ViewInsets
  /**
   * Floor on the framed extent per axis, world mm. Only reached on the zoom-out
   * branch, and only when the target is larger than the pane at the current
   * zoom yet smaller than this — which a lone symbol never is. It exists so the
   * branch cannot produce an absurd zoom for a degenerate (zero-size) box.
   */
  minExtent?: number
  /** Border left around the target when zooming out. */
  padding?: number
  /** Floor on the zoom the engine will accept. */
  minZoom?: number
}

export type BringIntoViewMove =
  /** Already where it needs to be. The caller must still mark it. */
  | { kind: 'none' }
  /** Same zoom, new center. */
  | { kind: 'pan'; x: number; y: number }
  /** Zoomed out to fit, and centered. */
  | { kind: 'fit'; x: number; y: number; zoom: number }

const centerOf = (bounds: WorldBounds): { x: number; y: number } => ({
  x: (bounds.minX + bounds.maxX) / 2,
  y: (bounds.minY + bounds.maxY) / 2
})

/**
 * The largest CANVAS-CENTERED rectangle that clears every piece of chrome, in
 * pixels.
 *
 * Insets are asymmetric — a 52px top toolbar against a 24px bottom pill — and
 * there are two things one could do with that. Offsetting the camera to center
 * the part in the lopsided gap between them is one, and it is wrong: the part
 * lands visibly off-center, which reads as a bug however correct the arithmetic
 * is, because a person judges "centered" against the canvas they can see and not
 * against a rectangle only this file knows about.
 *
 * So the part is centered on the canvas, and the chrome is paid for in the
 * ZOOM instead. A centered rectangle of width `w` spans `[(W−w)/2, (W+w)/2]`, so
 * clearing a left inset needs `w ≤ W − 2·left` and a right one `w ≤ W − 2·right`
 * — hence twice the LARGER inset, not the sum of the two. The cost is a slightly
 * looser fit when one edge carries much more chrome than its opposite, which is
 * the right thing to trade for a part that sits where the eye expects it.
 */
const centeredFit = (
  viewport: { width: number; height: number },
  insets: ViewInsets
): { width: number; height: number } => ({
  width: viewport.width - 2 * Math.max(insets.left, insets.right),
  height: viewport.height - 2 * Math.max(insets.top, insets.bottom)
})

/**
 * The part of the canvas no chrome covers, in world units, at the current
 * camera. Can come back inverted on a pane narrower than its own toolbars;
 * callers test `fits` before trusting it.
 */
const safeWorldRect = (visible: WorldBounds, insets: ViewInsets, zoom: number): WorldBounds => ({
  minX: visible.minX + insets.left / zoom,
  maxX: visible.maxX - insets.right / zoom,
  // A `bottom` inset is chrome at the bottom of the SCREEN, which is low y.
  minY: visible.minY + insets.bottom / zoom,
  maxY: visible.maxY - insets.top / zoom
})

/**
 * Which of the three cases this probe is, and the camera it wants.
 *
 * The caller decides what to do with it — `ViewportEngine.bringIntoView`
 * applies a `pan` or a `fit` and leaves a `none` alone.
 */
export const bringIntoViewMove = (input: BringIntoViewInput): BringIntoViewMove => {
  const { target, visible, zoom, viewport, insets } = input
  const minExtent = input.minExtent ?? 0
  const padding = input.padding ?? 1.3
  const minZoom = input.minZoom ?? 0

  if (!(zoom > 0)) return { kind: 'none' }

  // Fixed by the pane and its chrome, not by the camera: this is what both the
  // "can it fit" question and the zoom-out branch are answered against, and
  // using the same rectangle for the two is what makes them agree.
  const room = centeredFit(viewport, insets)

  const width = target.maxX - target.minX
  const height = target.maxY - target.minY

  const fits =
    room.width > 0 && room.height > 0 && width * zoom <= room.width && height * zoom <= room.height

  if (fits) {
    // Whether it is visible is asked of where the part ACTUALLY is, against the
    // real lopsided safe rect — a part sitting clear of the chrome near one
    // edge is in view, and the whole point of this branch is not to move a
    // camera that does not need moving. Only once something has to move does
    // the symmetric rectangle above take over and put it in the middle.
    const safe = safeWorldRect(visible, insets, zoom)
    const contained =
      target.minX >= safe.minX &&
      target.maxX <= safe.maxX &&
      target.minY >= safe.minY &&
      target.maxY <= safe.maxY
    if (contained) return { kind: 'none' }
    // Centered on the canvas. Because `fits` was measured against the centered
    // rectangle, this lands clear of every inset, so the next probe on the same
    // part answers `none` — the rule settles instead of nudging.
    return { kind: 'pan', ...centerOf(target) }
  }

  // Too big for the pane as framed: zoom out far enough to hold it, with the
  // usual border. `Math.min(…, zoom)` is the promise the whole rule rests on —
  // this branch can only ever loosen the zoom, never tighten it.
  const widthFit = room.width / (Math.max(width, minExtent) * padding)
  const heightFit = room.height / (Math.max(height, minExtent) * padding)
  const raw = Math.min(widthFit, heightFit)
  const fitted = Math.max(minZoom, Math.min(zoom, Number.isFinite(raw) && raw > 0 ? raw : zoom))

  return { kind: 'fit', ...centerOf(target), zoom: fitted }
}
