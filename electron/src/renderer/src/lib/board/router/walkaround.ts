/**
 * Avoid mode (walkaround): bend a route around every obstacle it meets
 * (docs/router-behavior.md R6–R14), as KiCad's `WALKAROUND` does.
 *
 * The loop: find the first obstacle along the path, bend the path around
 * its hulls with the kernel (hullWalk), repeat until nothing is hit. Nothing
 * is remembered from one frame to the next (R8). A walk has one policy:
 *
 * - a winding, clockwise or anticlockwise: every obstacle on that side, as
 *   KiCad's `WP_CW` and `WP_CCW`; the router walks both and takes the
 *   shorter (R7). A side that cannot be walked, or would leave the board,
 *   leaves the walk stuck.
 * - the shortest (no winding): each obstacle on its shorter side, as KiCad's
 *   `WP_SHORTEST`, which drags and pushed copper use; a side that cannot be
 *   walked gives way to the other (R16).
 *
 * Either way, obstacles whose outlines meet leave no room between them, so
 * a walk passes them on the same side, as KiCad walks a cluster.
 */

import type { Pt } from '../spatialIndex'
import type { RouteCornerMode } from '../pcbTools'
import type { RouterWorld, ObstacleQuery } from './world'
import type { Hull } from './hulls'
import { walkPathAroundHull } from './hullWalk'
import { convexOverlap, mergeColinear, pathLength, samePt } from './geometry'

/** `true`: the obstacle on the route's right (the kernel's clockwise walk). */
export type Side = boolean

export interface WalkOptions extends ObstacleQuery {
  halfWidth: number
  clearance: number
  cornerMode: RouteCornerMode
  iterationLimit?: number
  /** Give up (as `almost`) past this multiple of the starting length. */
  lengthFactorLimit?: number
  /** Every obstacle on this side (KiCad's `WP_CW`/`WP_CCW`); unset, each on its shorter. */
  winding?: Side
}

export type WalkStatus = 'done' | 'almost' | 'stuck'

export interface WalkResult {
  status: WalkStatus
  path: Pt[]
  /** The obstacles walked round. */
  walked: number[]
}

/** Bend a path round all of an item's hulls on one side. */
export function walkHulls(path: readonly Pt[], hulls: readonly Hull[], cw: Side): Pt[] | null {
  let bent: Pt[] | null = [...path]
  for (const hull of hulls) {
    bent = walkPathAroundHull(bent, hull, cw)
    if (!bent) return null
  }
  return mergeColinear(bent)
}

/** The obstacles one walk has gone round so far: their sides and outlines. */
export type Walked = Map<number, { side: Side; hulls: Hull[] }>

/**
 * The side this walk already gave an obstacle, or anything it touches: obstacles
 * whose outlines meet leave no room between them, so a route passes them on
 * the same side. Null to take the shorter.
 */
export function clusterSide(hulls: readonly Hull[], id: number, walked: Walked): Side | null {
  const own = walked.get(id)
  if (own) return own.side
  for (const other of walked.values()) {
    if (hulls.some((h) => other.hulls.some((o) => convexOverlap(h, o)))) return other.side
  }
  return null
}

/**
 * Bend a path round one obstacle: on the preferred side, falling back to the
 * other unless `only`; with no preference, the shorter. A side whose new
 * corners are off the board will not do; null when neither will.
 */
export function walkObstacle(
  world: RouterWorld,
  path: readonly Pt[],
  hulls: readonly Hull[],
  preferred: Side | null,
  only = false
): { path: Pt[]; side: Side } | null {
  const walk = (side: Side): Pt[] | null => {
    const bent = walkHulls(path, hulls, side)
    if (!bent || bent.length < 2) return null
    const had = new Set(path.map(pointKey))
    if (bent.some((p) => !had.has(pointKey(p)) && !world.onBoard(p))) return null
    return bent
  }
  if (preferred !== null) {
    const bent = walk(preferred)
    if (bent) return { path: bent, side: preferred }
    if (only) return null
    const other = walk(!preferred)
    return other ? { path: other, side: !preferred } : null
  }
  const cw = walk(true)
  const ccw = walk(false)
  if (cw && (!ccw || pathLength(cw) <= pathLength(ccw))) return { path: cw, side: true }
  return ccw ? { path: ccw, side: false } : null
}

export function walkAround(
  world: RouterWorld,
  initial: readonly Pt[],
  opts: WalkOptions
): WalkResult {
  const iterationLimit = opts.iterationLimit ?? 60
  const lengthFactorLimit = opts.lengthFactorLimit ?? 10
  const initialLength = Math.max(pathLength(initial), 1e-6)
  const walked: Walked = new Map()
  let path = mergeColinear(initial)
  let status: WalkStatus = 'done'
  let clearBefore = 0

  for (let iter = 0; ; iter++) {
    if (iter === iterationLimit) {
      status = 'almost'
      break
    }
    const hit = world.firstObstacleFrom(path, opts.halfWidth, opts.clearance, opts, clearBefore)
    if (!hit) break
    const obstacle = hit.item
    const hulls = world.hullsOf(obstacle, opts.clearance, opts.halfWidth, opts.cornerMode, opts)
    const winding = opts.winding
    const bent =
      winding === undefined
        ? walkObstacle(world, path, hulls, clusterSide(hulls, obstacle.id, walked))
        : walkObstacle(world, path, hulls, winding, true)
    if (!bent) return { status: 'stuck', path, walked: [...walked.keys()] }
    walked.set(obstacle.id, { side: bent.side, hulls })
    // The segments before the one that met it were clear, and stay so where
    // the bend left them as they were.
    let same = 0
    while (same < path.length && same < bent.path.length && samePt(path[same], bent.path[same]))
      same++
    clearBefore = Math.min(hit.segment, Math.max(0, same - 1))
    path = bent.path
    if (pathLength(path) > initialLength * lengthFactorLimit) {
      status = 'almost'
      break
    }
  }

  const ids = [...walked.keys()]
  if (path.length < 2 || !samePt(path[0], initial[0])) return { status: 'stuck', path, walked: ids }
  if (status === 'done' && !samePt(path[path.length - 1], initial[initial.length - 1])) {
    status = 'almost'
  }
  if (status === 'done' && world.pathViolates(path, opts.halfWidth, opts.clearance, opts)) {
    status = 'almost'
  }
  return { status, path, walked: ids }
}

/** A point's identity to a micron, as `samePt` judges it near enough. */
const pointKey = (p: Pt): string => `${Math.round(p.x * 1e6)},${Math.round(p.y * 1e6)}`
