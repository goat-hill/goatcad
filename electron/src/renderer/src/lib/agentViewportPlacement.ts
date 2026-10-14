/**
 * Where an agent viewport shows on a canvas (`AgentViewportOverlay.vue`): its
 * box where the box is in sight, else a marker at the view's edge on the line
 * from the view's center toward the box, pointing at it.
 */

/** A rectangle in the overlay's pixels. */
export interface ScreenRect {
  left: number
  top: number
  width: number
  height: number
}

export type ViewportPlacement =
  | { kind: 'box'; rect: ScreenRect }
  /** The marker's center, and the direction to the box in degrees, clockwise from right (y down). */
  | { kind: 'marker'; x: number; y: number; angle: number }

/** How far a marker's center keeps inside each edge of the view, px. */
export interface MarkerInsets {
  top: number
  right: number
  bottom: number
  left: number
}

/**
 * Place a viewport's box on a view `width` × `height` pixels. A box that
 * touches the view shows as itself; one wholly outside, as a marker where the
 * line from the view's center to the box's meets the view inset by `insets`
 * (the canvas's own chrome, so the marker never hides under a toolbar).
 */
export function placeAgentViewport(
  view: { width: number; height: number },
  rect: ScreenRect,
  insets: MarkerInsets
): ViewportPlacement {
  const inSight =
    rect.left < view.width &&
    rect.left + rect.width > 0 &&
    rect.top < view.height &&
    rect.top + rect.height > 0
  if (inSight) return { kind: 'box', rect }
  const cx = view.width / 2
  const cy = view.height / 2
  const dx = rect.left + rect.width / 2 - cx
  const dy = rect.top + rect.height / 2 - cy
  // How far along the ray to the box's center the inset frame is, per axis.
  const reach = (delta: number, before: number, after: number): number =>
    delta > 0 ? after / delta : delta < 0 ? before / -delta : Infinity
  const scale = Math.max(
    0,
    Math.min(
      reach(dx, cx - insets.left, view.width - insets.right - cx),
      reach(dy, cy - insets.top, view.height - insets.bottom - cy)
    )
  )
  return {
    kind: 'marker',
    x: cx + dx * scale,
    y: cy + dy * scale,
    angle: (Math.atan2(dy, dx) * 180) / Math.PI
  }
}
