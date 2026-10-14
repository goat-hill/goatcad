/**
 * Smoothing: reduce a walked or pushed line to the fewest, gentlest corners
 * that stay legal (docs/router-behavior.md R6, P2).
 *
 * A walked route follows obstacle outlines corner by corner. Smoothing
 * replaces any run of the line with the plain bend between its ends, in the
 * corner mode, when that bend
 *
 * - makes the line's corners cheaper (`cornerCost`: a 45° turn costs far
 *   less than a right angle, which costs less than an acute one), or keeps
 *   them as cheap and is shorter;
 * - is legal (`collides` says no); and
 * - stays on the same side of everything (`crosses` says no obstacle lies
 *   between the run and its replacement), so smoothing never moves the route
 *   to the other side of an obstacle the person steered it round.
 *
 * Corners decide, not length, as KiCad's optimizer does: a bend joining two
 * of the line's own corners is at most a few percent longer than the run it
 * replaces, and the fewer, gentler corners are what reads as a clean route.
 * Where the line touches an obstacle it still sits at exactly clearance;
 * elsewhere it takes the slack the cleaner shape needs.
 *
 * A forward pass first flattens the small bumps of a line walked round a row
 * of outlines; then the longest runs are tried first, a success keeping to
 * the same span, as KiCad's optimizer does.
 */

import type { Pt } from '../spatialIndex'
import { routeElbow, type RouteCornerMode } from '../pcbTools'
import { mergeColinear, pathLength } from './geometry'

export { mergeColinear }

export interface SmoothChecks {
  /** Whether a candidate run breaks clearance. */
  collides: (run: readonly Pt[]) => boolean
  /** Whether any obstacle lies in the region between `from` and `to`. */
  crosses: (from: readonly Pt[], to: readonly Pt[]) => boolean
}

/**
 * The line's neighbors past the smoothed stretch, when only part of a line is
 * smoothed: their corners count toward the cost, so a cleaner middle does not
 * buy a sharper join.
 */
export interface SmoothContext {
  before?: Pt
  after?: Pt
  /**
   * The stretch's ends stay on the line around it: a bend from its first
   * point leaves along its first segment, and one into its last point
   * arrives along its last segment, as the line had them.
   */
  holdEnds?: boolean
}

const LENGTH_EPS = 1e-6
/** The longest run the first, forward pass replaces. */
const LOCAL_SPAN = 6
/** Bends a long line may try per corner it starts with, past the caller's budget. */
const BUDGET_PER_CORNER = 24
const ANGLE_EPS = 1e-3

/** What a corner costs by how far the line turns there; any other angle (free mode) costs the most. */
const TURN_COSTS: ReadonlyArray<[number, number]> = [
  [Math.PI / 4, 10],
  [Math.PI / 2, 30],
  [(3 * Math.PI) / 4, 50],
  [Math.PI, 60]
]
const ODD_TURN_COST = 100

function turnCost(a: Pt, b: Pt, c: Pt): number {
  const turn = turnAngle(a, b, c)
  if (turn < ANGLE_EPS) return 0
  for (const [angle, cost] of TURN_COSTS) if (Math.abs(turn - angle) < ANGLE_EPS) return cost
  return ODD_TURN_COST
}

/** How far a line turns at `b`, 0 (straight on) to π (straight back). */
function turnAngle(a: Pt, b: Pt, c: Pt): number {
  const ux = b.x - a.x
  const uy = b.y - a.y
  const vx = c.x - b.x
  const vy = c.y - b.y
  const lu = Math.hypot(ux, uy)
  const lv = Math.hypot(vx, vy)
  if (lu < LENGTH_EPS || lv < LENGTH_EPS) return 0
  return Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy) / (lu * lv))))
}

/** The sum of a line's corner costs, its context's joins included. */
export function cornerCost(path: readonly Pt[], context: SmoothContext = {}): number {
  const pts = [
    ...(context.before ? [context.before] : []),
    ...path,
    ...(context.after ? [context.after] : [])
  ]
  let cost = 0
  for (let i = 1; i < pts.length - 1; i++) cost += turnCost(pts[i - 1], pts[i], pts[i + 1])
  return cost
}

export function smoothPath(
  path: readonly Pt[],
  cornerMode: RouteCornerMode,
  checks: SmoothChecks,
  budget = 400,
  context: SmoothContext = {}
): Pt[] {
  let current = mergeColinear(path)
  let cost = cornerCost(current, context)
  let length = pathLength(current)
  const postures = cornerMode === 'free' ? [true] : [true, false]
  budget = Math.max(budget, BUDGET_PER_CORNER * current.length)
  const along = (a: Pt, b: Pt, c: Pt, d: Pt): boolean =>
    Math.abs((b.x - a.x) * (d.y - c.y) - (b.y - a.y) * (d.x - c.x)) <=
      1e-9 * Math.hypot(b.x - a.x, b.y - a.y) * Math.hypot(d.x - c.x, d.y - c.y) &&
    (b.x - a.x) * (d.x - c.x) + (b.y - a.y) * (d.y - c.y) > 0
  const first = current.length > 1 ? [current[0], current[1]] : null
  const last =
    current.length > 1 ? [current[current.length - 2], current[current.length - 1]] : null
  const holds = (bend: readonly Pt[], i: number, j: number): boolean => {
    if (!context.holdEnds) return true
    if (i === 0 && first && !along(first[0], first[1], bend[0], bend[1])) return false
    const n = bend.length
    if (j === current.length - 1 && last && !along(last[0], last[1], bend[n - 2], bend[n - 1]))
      return false
    return true
  }
  // Replace the run of `span` segments from corner `i` with one bend, if that
  // is cleaner and legal; the line as it then is, or null.
  const replace = (i: number, span: number): boolean => {
    const a = current[i]
    const b = current[i + span]
    const run = current.slice(i, i + span + 1)
    // Both bends, the cleaner first: the first that is also legal is taken.
    const options: Array<{ bend: Pt[]; next: Pt[]; cost: number; length: number }> = []
    for (const diagFirst of postures) {
      if (--budget <= 0) return false
      const bend = [a, ...routeElbow(cornerMode, diagFirst, a, b)]
      const next = mergeColinear([...current.slice(0, i), ...bend, ...current.slice(i + span + 1)])
      const nextCost = cornerCost(next, context)
      const nextLength = pathLength(next)
      const better = nextCost < cost || (nextCost === cost && nextLength < length - LENGTH_EPS)
      if (better && holds(bend, i, i + span))
        options.push({ bend, next, cost: nextCost, length: nextLength })
    }
    options.sort((x, y) => x.cost - y.cost || x.length - y.length)
    for (const option of options) {
      if (checks.collides(option.bend) || checks.crosses(run, option.bend)) continue
      current = option.next
      cost = option.cost
      length = option.length
      return true
    }
    return false
  }

  // First pull it taut a few corners at a time, walking forward: a line
  // walked corner by corner round a row of outlines is mostly small bumps,
  // and this flattens them in time that grows with the line, not its square.
  for (let i = 0; i < current.length - 2 && budget > 0;) {
    let pulled = false
    for (let s = Math.min(LOCAL_SPAN, current.length - 1 - i); s >= 2 && !pulled; s--)
      pulled = replace(i, s)
    if (!pulled) i++
  }
  // Then the longest runs first, each span kept while it finds something.
  let span = current.length - 1
  while (span >= 2 && budget > 0) {
    span = Math.min(span, current.length - 1)
    let found = false
    for (let i = 0; i + span < current.length && !found && budget > 0; i++) found = replace(i, span)
    if (!found) span--
  }
  return current
}
