/**
 * Line assembly: a board stores individual `(segment …)` nodes, but shove
 * displaces whole LINES — chains of same-net/layer/width segments joined end
 * to end through trivial joints (PNS `NODE::AssembleLine`).
 *
 * A joint is trivial when exactly two such segments meet there and nothing
 * else does (no pad, via, third track, or width change) — those are the
 * corners a shove may move. Chain endpoints anchor wherever the joint is
 * NOT trivial, and the shove must leave them in place.
 */

import type { CopperItem, Pt } from '../spatialIndex'
import type { RouterWorld } from './world'
import { arcPolyline } from './geometry'

/** Endpoint-identity tolerance (mm) — matches the kernel's vertex EPS. */
const JOINT_EPS = 1e-6

export interface AssembledLine {
  /** World item ids of the chained segments, in path order. */
  ids: number[]
  /** The polyline through the chain (segment endpoints, in order). */
  path: Pt[]
  width: number
  layer: string
  net: number
  /**
   * Arcs in the chain, when assembled through them: each stands in `path`
   * as the chords from `from` to `to`, through `mid`.
   */
  arcs?: LineArc[]
}

export interface LineArc {
  id: number
  from: number
  to: number
  mid: Pt
}

/** How finely an arc is laid in a line's path: chords per arc. */
export const ARC_CHORDS = 8

const samePoint = (a: Pt, b: Pt): boolean =>
  Math.abs(a.x - b.x) <= JOINT_EPS && Math.abs(a.y - b.y) <= JOINT_EPS

interface SegEnds {
  a: Pt
  b: Pt
}

const capsuleEnds = (item: CopperItem): SegEnds | null => {
  const s = item.shape
  if (s.kind === 'capsule') return { a: { x: s.x0, y: s.y0 }, b: { x: s.x1, y: s.y1 } }
  if (s.kind === 'arc') return { a: { x: s.x0, y: s.y0 }, b: { x: s.x1, y: s.y1 } }
  return null
}

const halfWidthOf = (item: CopperItem): number | null =>
  item.shape.kind === 'capsule' || item.shape.kind === 'arc' ? item.shape.halfWidth : null

const isTrack = (item: CopperItem, arcs: boolean): boolean =>
  (item.ref.type === 'segment' && item.shape.kind === 'capsule') ||
  (arcs && item.ref.type === 'tarc' && item.shape.kind === 'arc')

const isChainable = (item: CopperItem, seed: CopperItem, arcs = false): boolean =>
  isTrack(item, arcs) &&
  isTrack(seed, arcs) &&
  item.net === seed.net &&
  Math.abs((halfWidthOf(item) ?? -1) - (halfWidthOf(seed) ?? -2)) <= JOINT_EPS &&
  item.layers.length === seed.layers.length &&
  item.layers.every((l) => seed.layers.includes(l))

/** How far a point is from a segment's centerline. */
function centerlineDistance(p: Pt, { a, b }: SegEnds): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const l2 = dx * dx + dy * dy
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0
  return Math.hypot(a.x + dx * t - p.x, a.y + dy * t - p.y)
}

/**
 * The single chainable continuation at a joint, or null when the joint is
 * non-trivial (anything else lands there, or 0/2+ continuations).
 */
function continuationAt(
  world: RouterWorld,
  at: Pt,
  from: CopperItem,
  seed: CopperItem,
  arcs: boolean
): CopperItem | null {
  const layer = seed.layers[0]
  const near = world.itemsNear(at, JOINT_EPS * 4, layer)
  let continuation: CopperItem | null = null
  for (const item of near) {
    if (item.id === from.id) continue
    const ends = capsuleEnds(item)
    if (ends && isChainable(item, seed, arcs)) {
      if (!samePoint(ends.a, at) && !samePoint(ends.b, at)) {
        // Only its copper reaches here (a short neighbor on a tight bend):
        // it does not land on the joint.
        if (centerlineDistance(at, ends) > JOINT_EPS) continue
        // Same-net copper touching mid-segment: a T — not trivial.
        return null
      }
      if (continuation) return null
      continuation = item
      continue
    }
    // A pad, via, arc, or foreign-width segment at the joint anchors it.
    return null
  }
  return continuation
}

/**
 * Assemble the line through `seed` (a track segment). With `arcs`, it runs
 * on through the track arcs of its width that it meets, each laid in the
 * path as chords (`ARC_CHORDS`), and the seed may be an arc.
 */
export function assembleLine(
  world: RouterWorld,
  seed: CopperItem,
  options: { arcs?: boolean } = {}
): AssembledLine {
  const withArcs = options.arcs ?? false
  const seedEnds = capsuleEnds(seed)
  const half = halfWidthOf(seed)
  const width = half !== null ? half * 2 : 0
  const layer = seed.layers[0]
  if (!seedEnds || !isTrack(seed, withArcs))
    return { ids: [seed.id], path: [], width, layer, net: seed.net }

  // Each piece in order: its id, and its points from one end to the other.
  type Piece = { id: number; pts: Pt[]; mid?: Pt }
  const piece = (item: CopperItem, from: Pt): Piece => {
    const s = item.shape
    const ends = capsuleEnds(item)!
    const to = samePoint(ends.a, from) ? ends.b : ends.a
    if (s.kind !== 'arc') return { id: item.id, pts: [from, to] }
    const mid = { x: s.mx, y: s.my }
    return { id: item.id, pts: arcPolyline(from, mid, to, ARC_CHORDS), mid }
  }
  const pieces: Piece[] = [piece(seed, seedEnds.a)]
  const ids = new Set<number>([seed.id])

  const extend = (fromEnd: 'a' | 'b'): void => {
    let current = seed
    let at = fromEnd === 'a' ? seedEnds.a : seedEnds.b
    let guard = 4096
    for (;;) {
      if (--guard === 0) return
      const next = continuationAt(world, at, current, seed, withArcs)
      if (!next || ids.has(next.id)) return
      ids.add(next.id)
      const p = piece(next, at)
      if (fromEnd === 'a') pieces.unshift({ ...p, pts: [...p.pts].reverse() })
      else pieces.push(p)
      current = next
      at = p.pts[p.pts.length - 1]
    }
  }
  extend('a')
  extend('b')

  const path: Pt[] = [pieces[0].pts[0]]
  const arcs: LineArc[] = []
  for (const p of pieces) {
    const from = path.length - 1
    path.push(...p.pts.slice(1))
    if (p.mid) arcs.push({ id: p.id, from, to: path.length - 1, mid: p.mid })
  }
  return {
    ids: pieces.map((p) => p.id),
    path,
    width,
    layer,
    net: seed.net,
    ...(withArcs ? { arcs } : {})
  }
}
