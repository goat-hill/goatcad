/**
 * Footprint drag (docs/router-behavior.md D13): `D` on a footprint moves it
 * with the cursor and brings the tracks that end on its pads along, as
 * KiCad's drag of a footprint does (`COMPONENT_DRAGGER`).
 *
 * Each track ending in one of the footprint's pads has that end carried with
 * the pad, its last bend re-drawn from the corner before in the corner mode,
 * the rest of it pinned (D6's rule for a via's tracks). A track running from
 * one of its pads to another moves with it whole. Nothing is pushed or walked
 * round: what the moved copper comes too near is marked, and the drop is
 * refused as any violating drag is (D9).
 */

import {
  pointToShape,
  shapeOn,
  shapeToShape,
  type CopperItem,
  type CopperShape,
  type Pt
} from '../spatialIndex'
import type { RouteCornerMode } from '../pcbTools'
import type { ObstacleQuery, RouterWorld } from './world'
import { nextOverlayId } from './world'
import { assembleLine, type AssembledLine } from './lines'
import { followEnd, overlaySegment, type ShoveDelta } from './shove'
import { samePt } from './geometry'
import { clearanceMarks, type ViolationMark } from './engine'
import { ROUTER_EPSILON } from './hulls'

export interface ComponentDragUpdate {
  /** How far the footprint has moved, scene mm. */
  delta: Pt
  /** Each carried track's proposed geometry, with which of its segments violate. */
  lines: Array<{ path: Pt[]; width: number; layer: string; violations: boolean[] }>
  /** A moved pad, or a carried track, breaks clearance. */
  blocked: boolean
  /** Other copper the drag violates, as base refs (F2). */
  violators: Array<{ type: string; index: number }>
  marks: ViolationMark[]
  /** The carried tracks, hidden where they were. */
  hiddenRefs: Array<{ type: string; index: number }>
}

interface Carried {
  line: AssembledLine
  /** True: both ends on the dragged pads, so it moves whole. Else its last point rides a pad. */
  rigid: boolean
}

export class ComponentDragSession {
  private readonly world: RouterWorld
  private readonly carried: Carried[] = []
  private last: ComponentDragUpdate | null = null

  constructor(
    baseWorld: RouterWorld,
    /** The pads of the footprints being dragged. */
    private readonly pads: readonly CopperItem[],
    private readonly grab: Pt,
    private readonly clearance: number
  ) {
    const inPad = (p: Pt, layer: string): boolean =>
      pads.some(
        (pad) =>
          pad.layers.includes(layer) &&
          pointToShape(shapeOn(pad, layer), p.x, p.y) <= ROUTER_EPSILON
      )
    const seen = new Set<number>()
    for (const pad of pads) {
      if (pad.net <= 0) continue
      const reach = Math.hypot(pad.maxX - pad.minX, pad.maxY - pad.minY) / 2
      const center = { x: (pad.minX + pad.maxX) / 2, y: (pad.minY + pad.maxY) / 2 }
      for (const item of baseWorld.itemsNear(center, reach)) {
        if (seen.has(item.id) || item.net !== pad.net) continue
        if (item.ref.type !== 'segment' || item.shape.kind !== 'capsule') continue
        const layer = item.layers[0]
        const s = item.shape
        const a = { x: s.x0, y: s.y0 }
        const b = { x: s.x1, y: s.y1 }
        if (!inPad(a, layer) && !inPad(b, layer)) continue
        const line = assembleLine(baseWorld, item)
        line.ids.forEach((id) => seen.add(id))
        const first = inPad(line.path[0], line.layer)
        const last = inPad(line.path[line.path.length - 1], line.layer)
        if (!first && !last) continue
        if (first && !last) line.path.reverse()
        this.carried.push({ line, rigid: first && last })
      }
    }
    this.world = baseWorld.branch()
    for (const pad of pads) this.world.remove(pad.id)
    for (const { line } of this.carried) for (const id of line.ids) this.world.remove(id)
  }

  /** The nets the drag moves copper of, for the focus dim (F8): the first pad's. */
  get net(): number {
    return this.pads.find((p) => p.net > 0)?.net ?? 0
  }

  update(cursor: Pt, cornerMode: RouteCornerMode = '45'): ComponentDragUpdate {
    const d = { x: cursor.x - this.grab.x, y: cursor.y - this.grab.y }
    const lines = this.carried.map(({ line, rigid }) => {
      const path = rigid
        ? line.path.map((p) => ({ x: p.x + d.x, y: p.y + d.y }))
        : followEnd(
            line.path,
            {
              x: line.path[line.path.length - 1].x + d.x,
              y: line.path[line.path.length - 1].y + d.y
            },
            cornerMode
          )
      return { path, width: line.width, layer: line.layer, net: line.net }
    })

    // The moved copper stands in the world, each piece judged against the rest.
    const judge = this.world.branch()
    const moved = this.pads.map((pad) => movedItem(pad, d))
    for (const item of moved) judge.add(item)
    for (const l of lines)
      for (let k = 0; k < l.path.length - 1; k++)
        judge.add(overlaySegment(l.path[k], l.path[k + 1], l.width, l.layer, l.net))

    const violators = new Map<number, CopperItem>()
    const marks: ViolationMark[] = []
    const outLines = lines.map((l) => {
      const q: ObstacleQuery = { layer: l.layer, excludeNet: l.net }
      const violations: boolean[] = []
      for (let k = 0; k < l.path.length - 1; k++) {
        const hits = judge.collisions(l.path[k], l.path[k + 1], l.width / 2, this.clearance, q)
        const fresh = hits.map((h) => h.item).filter((item) => !violators.has(item.id))
        for (const item of fresh) violators.set(item.id, item)
        marks.push(...clearanceMarks(judge, fresh, this.clearance, q))
        violations.push(hits.length > 0)
      }
      return { path: l.path, width: l.width, layer: l.layer, violations }
    })
    let padsViolate = false
    for (const pad of moved)
      for (const layer of pad.layers) {
        const shape = shapeOn(pad, layer)
        const q: ObstacleQuery = { layer, excludeNet: pad.net }
        const reach = Math.hypot(pad.maxX - pad.minX, pad.maxY - pad.minY) / 2
        const center = { x: (pad.minX + pad.maxX) / 2, y: (pad.minY + pad.maxY) / 2 }
        for (const other of judge.itemsNear(center, reach + judge.reach(this.clearance), layer)) {
          if (other.id === pad.id || (pad.net > 0 && other.net === pad.net)) continue
          if (moved.some((m) => m.id === other.id)) continue // the footprint's own pads
          const gap = judge.clearanceFor(other, this.clearance, q)
          if (shapeToShape(shape, shapeOn(other, layer)) >= gap - ROUTER_EPSILON) continue
          padsViolate = true
          if (violators.has(other.id)) continue
          violators.set(other.id, other)
          marks.push(...clearanceMarks(judge, [other], this.clearance, q))
        }
      }

    const update: ComponentDragUpdate = {
      delta: d,
      lines: outLines,
      blocked: padsViolate || outLines.some((l) => l.violations.some(Boolean)),
      violators: [...violators.values()]
        .filter((item) => item.ref.index >= 0)
        .map((item) => ({ type: item.ref.type, index: item.ref.index })),
      marks,
      hiddenRefs: this.carried.flatMap(({ line }) =>
        line.ids
          .map((id) => this.world.base.items[id]?.ref)
          .filter((ref): ref is CopperItem['ref'] => ref !== undefined)
          .map((ref) => ({ type: ref.type, index: ref.index }))
      )
    }
    this.last = update
    return update
  }

  /** True while the footprint is where it was (D7). */
  unchanged(): boolean {
    const last = this.last
    return !last || (Math.abs(last.delta.x) < 1e-9 && Math.abs(last.delta.y) < 1e-9)
  }

  /** The carried tracks' commit diff for the last update; the footprint's move is the caller's. */
  delta(): (ShoveDelta & { blocked: boolean; move: Pt }) | null {
    const last = this.last
    if (!last) return null
    const added: ShoveDelta['added'] = []
    last.lines.forEach((l, i) => {
      const net = this.carried[i].line.net
      for (let k = 0; k < l.path.length - 1; k++)
        if (!samePt(l.path[k], l.path[k + 1]))
          added.push({
            start: { ...l.path[k] },
            end: { ...l.path[k + 1] },
            width: l.width,
            layer: l.layer,
            net
          })
    })
    return { removed: last.hiddenRefs, added, blocked: last.blocked, move: last.delta }
  }
}

/**
 * A footprint moved by `move` (scene mm) with no cursor, as the drag lands it:
 * the commit diff of the tracks its pads carry. What the moved copper comes
 * near is the checks' to report, not a reason to refuse (an agent's
 * `items.update` with `tracks: "follow"`).
 */
export function carriedTracks(
  world: RouterWorld,
  pads: readonly CopperItem[],
  move: Pt,
  cornerMode: RouteCornerMode = '45'
): ShoveDelta | null {
  const session = new ComponentDragSession(world, pads, { x: 0, y: 0 }, 0)
  session.update(move, cornerMode)
  return session.delta()
}

/** An item moved by `d`, as an overlay copy keeping its board ref. */
function movedItem(item: CopperItem, d: Pt): CopperItem {
  const shapes = item.shapes
    ? new Map([...item.shapes].map(([layer, shape]) => [layer, translateShape(shape, d)]))
    : undefined
  return {
    ...item,
    id: nextOverlayId(),
    shape: translateShape(item.shape, d),
    ...(shapes ? { shapes } : {}),
    ...(item.anchor ? { anchor: { x: item.anchor.x + d.x, y: item.anchor.y + d.y } } : {}),
    minX: item.minX + d.x,
    minY: item.minY + d.y,
    maxX: item.maxX + d.x,
    maxY: item.maxY + d.y
  }
}

/** A copper shape moved by `d`. */
export function translateShape(shape: CopperShape, d: Pt): CopperShape {
  switch (shape.kind) {
    case 'capsule':
      return {
        ...shape,
        x0: shape.x0 + d.x,
        y0: shape.y0 + d.y,
        x1: shape.x1 + d.x,
        y1: shape.y1 + d.y
      }
    case 'circle':
      return { ...shape, cx: shape.cx + d.x, cy: shape.cy + d.y }
    case 'rrect':
      return { ...shape, cx: shape.cx + d.x, cy: shape.cy + d.y }
    case 'arc':
      return {
        ...shape,
        x0: shape.x0 + d.x,
        y0: shape.y0 + d.y,
        mx: shape.mx + d.x,
        my: shape.my + d.y,
        x1: shape.x1 + d.x,
        y1: shape.y1 + d.y
      }
    case 'poly':
      return {
        ...shape,
        rings: shape.rings.map((ring) => ring.map((p) => ({ x: p.x + d.x, y: p.y + d.y }))),
        minX: shape.minX + d.x,
        minY: shape.minY + d.y,
        maxX: shape.maxX + d.x,
        maxY: shape.maxY + d.y,
        ...(shape.frame
          ? { frame: { ...shape.frame, cx: shape.frame.cx + d.x, cy: shape.frame.cy + d.y } }
          : {})
      }
    case 'compound':
      return {
        ...shape,
        parts: shape.parts.map((part) => translateShape(part, d)),
        ...(shape.frame
          ? { frame: { ...shape.frame, cx: shape.frame.cx + d.x, cy: shape.frame.cy + d.y } }
          : {})
      }
  }
}
