// Parts follow KiCad's source, named below: Copyright The KiCad Developers, GPL-3.0-or-later.
/**
 * Line modes — KiCad's free / 90° / 45° angle constraint for drawn graphics,
 * shared by the board and footprint editors (KiCad's `LEADER_MODE` and the
 * left toolbar's three Line Modes buttons, cycled by Shift+Space).
 *
 * A constrained mode acts on a chain tool's next point, not on the corners
 * between points: the segment from the last point placed is turned onto the
 * nearest allowed direction, as KiCad's line tool does (`GetVectorSnapped90`,
 * `GetVectorSnapped45` in `geometry_utils.h`). Snapping the vector rather than
 * its angle keeps a point that was on the grid on the grid. KiCad's polygon
 * and zone tools draw an elbowed leader instead; one rule for every chain tool
 * is the simpler thing to learn, so ours use the line tool's.
 *
 * The board's route tool reads the same mode for its corners (`routeElbow`,
 * `pcbTools.ts`), so one chip and one key serve both. Space-agnostic plain
 * point math, like the tool modules that call it.
 */

export interface LinePoint {
  x: number
  y: number
}

export type LineMode = '45' | '90' | 'free'

/** Shift+Space order, from the tool's default. */
export const LINE_MODES: readonly LineMode[] = ['45', '90', 'free']

export const nextLineMode = (mode: LineMode): LineMode =>
  LINE_MODES[(LINE_MODES.indexOf(mode) + 1) % LINE_MODES.length]

/**
 * `to`, moved so the segment from `from` runs in a direction `mode` allows:
 * horizontal or vertical for 90°, those or a diagonal for 45°. KiCad's rule
 * for 45°: an axis wins while it is more than twice the other extent, the
 * diagonal otherwise, taking the larger extent for both.
 */
export function constrainLinePoint<P extends LinePoint>(mode: LineMode, from: LinePoint, to: P): P {
  if (mode === 'free') return to
  const dx = to.x - from.x
  const dy = to.y - from.y
  const ax = Math.abs(dx)
  const ay = Math.abs(dy)
  if (mode === '90') {
    return ax >= ay ? { ...to, y: from.y } : { ...to, x: from.x }
  }
  if (ax > ay * 2) return { ...to, y: from.y }
  if (ay > ax * 2) return { ...to, x: from.x }
  // Math.sign(0) would drop the diagonal onto an axis; a zero extent leans positive.
  const sign = (v: number): number => (v < 0 ? -1 : 1)
  return ax > ay ? { ...to, y: from.y + sign(dy) * ax } : { ...to, x: from.x + sign(dx) * ay }
}

/**
 * A chain tool's next point under `mode`: constrained from the last point in
 * the draft. The first point is free (there is nothing to measure from), and
 * so is a click back on the start, which closes an outline — constraining it
 * would move it off the point that closes.
 */
export function constrainChainPoint<P extends LinePoint>(
  mode: LineMode,
  draft: readonly LinePoint[],
  point: P
): P {
  const first = draft[0]
  const last = draft[draft.length - 1]
  if (!first || !last) return point
  if (point.x === first.x && point.y === first.y) return point
  return constrainLinePoint(mode, last, point)
}
