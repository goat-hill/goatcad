/**
 * Via drag (docs/router-behavior.md D6–D10).
 *
 * The via follows the cursor, and each track of its net ending on it — on
 * any layer — re-draws its last bend to meet it, its far end pinned (D2's
 * neighbors). Collisions go through the machinery routing uses (D8):
 * Highlight marks; Avoid holds the via where it last stood clear and bends
 * its tracks round what they meet, both ends held; Push moves other copper
 * aside on every layer the via spans and along each track, and where that
 * cannot be done does as Avoid does (P5).
 */

import type { CopperItem, Pt } from '../spatialIndex'
import type { RouteCornerMode } from '../pcbTools'
import type { RouterWorld, ObstacleQuery, HoleConflict } from './world'
import { assembleLine, type AssembledLine } from './lines'
import {
  followEnd,
  ShoveSession,
  type DisplacedPreview,
  type GroupHead,
  type ShoveDelta,
  type ShoveOptions
} from './shove'
import { walkAround } from './walkaround'
import { samePt, tidyPath } from './geometry'
import {
  areaMark,
  clearanceMarks,
  holeMark,
  viaSpotNear,
  type RouteMode,
  type ViolationMark
} from './engine'

export interface ViaDragUpdate {
  /** Where the via stands. */
  at: Pt
  /** Each carried track's proposed geometry, with which of its segments violate. */
  lines: Array<{ path: Pt[]; width: number; layer: string; violations: boolean[] }>
  /** The via breaks clearance on a layer it spans, or a keepout that forbids vias. */
  viaViolation: boolean
  blocked: boolean
  /** Other-net copper the proposal violates, as base refs (F2). */
  violators: Array<{ type: string; index: number }>
  marks: ViolationMark[]
  /** Scene suppression + displaced copper; the dragged via and its tracks among the hidden. */
  preview: DisplacedPreview
}

export class ViaDragSession {
  readonly net: number
  /** The tracks the via carries, each ending on it. */
  readonly lines: AssembledLine[]
  private readonly world: RouterWorld
  private readonly shove: ShoveSession
  private readonly origin: Pt
  private readonly radius: number
  /** Where the via last stood clear (Avoid holds it there). */
  private lastClear: Pt
  /** The sides each carried track took round what it walked last frame (R8). */
  private lastUpdate: ViaDragUpdate | null = null

  constructor(
    baseWorld: RouterWorld,
    readonly via: CopperItem,
    private readonly clearance: number,
    options: ShoveOptions = {}
  ) {
    this.net = via.net
    const shape = via.shape
    this.radius = shape.kind === 'circle' ? shape.r : 0
    this.origin = shape.kind === 'circle' ? { x: shape.cx, y: shape.cy } : { x: 0, y: 0 }
    this.lastClear = { ...this.origin }
    const lines: AssembledLine[] = []
    const seen = new Set<number>()
    for (const item of baseWorld.itemsNear(this.origin, this.radius)) {
      const s = item.shape
      if (seen.has(item.id) || item.ref.type !== 'segment' || s.kind !== 'capsule') continue
      if (item.net !== via.net) continue
      const ends = [
        { x: s.x0, y: s.y0 },
        { x: s.x1, y: s.y1 }
      ]
      if (!ends.some((p) => samePt(p, this.origin))) continue
      const line = assembleLine(baseWorld, item)
      line.ids.forEach((id) => seen.add(id))
      // Oriented to end on the via.
      if (!samePt(line.path[line.path.length - 1], this.origin)) line.path.reverse()
      if (samePt(line.path[line.path.length - 1], this.origin)) lines.push(line)
    }
    this.lines = lines
    // What moves must not obstruct itself.
    this.world = baseWorld.branch()
    this.world.remove(via.id)
    for (const line of lines) for (const id of line.ids) this.world.remove(id)
    this.shove = new ShoveSession(this.world, options)
  }

  get valid(): boolean {
    return this.via.shape.kind === 'circle' && this.via.ref.type === 'via'
  }

  update(cursor: Pt, mode: RouteMode, cornerMode: RouteCornerMode = '45'): ViaDragUpdate {
    const layers = this.via.layers
    const size = this.radius * 2
    const draw = (at: Pt): Pt[][] => this.lines.map((line) => followEnd(line.path, at, cornerMode))

    let at = { ...cursor }
    let paths = draw(at)
    let world = this.world
    let avoid = mode === 'walkaround'
    if (mode === 'shove') {
      const heads: GroupHead[] = [
        ...layers.map((layer) => ({ path: [at, at], width: size, layer, kind: 'via' as const })),
        ...this.lines.map((line, i) => ({
          path: paths[i],
          width: line.width,
          layer: line.layer,
          kind: 'track' as const
        }))
      ]
      const r = this.world.viaKeepoutsAt(at, this.radius, layers).length
        ? null
        : this.shove.proposeGroup(heads, { clearance: this.clearance, net: this.net }, cornerMode)
      // Holes do not move: copper the via pushed is judged where it went.
      if (r && r.status !== 'failed' && this.holeHits(this.shove.currentWorld(), at).length === 0) {
        paths = r.paths.slice(layers.length)
        world = this.shove.currentWorld()
      } else {
        this.shove.dropHead()
        avoid = true
      }
    } else {
      this.shove.dropHead()
    }
    const clear = this.standsClear(cursor)
    if (avoid) {
      // The via cannot bend round anything: it slides to the spot nearest the
      // cursor where it stands clear, on the side it came from, or else stays
      // where it last stood clear.
      at = { ...cursor }
      if (!clear) {
        const spot = viaSpotNear(this.world, cursor, {
          radius: this.radius,
          clearance: this.clearance,
          net: this.net,
          layers,
          drill: this.world.bounds().viaDrill(this.via.ref.index),
          holes: (p) => this.holeHits(this.world, p),
          from: this.lastClear
        })
        at = this.standsClear(spot) ? spot : { ...this.lastClear }
      }
      paths = draw(at).map((path, i) => this.walk(path, i, cornerMode) ?? path)
    }
    if (this.standsClear(at)) this.lastClear = { ...at }

    const violators = new Map<number, CopperItem>()
    const marks: ViolationMark[] = []
    const viaHits = this.viaHits(world, at)
    for (const { item, asker } of viaHits) {
      if (violators.has(item.id)) continue
      violators.set(item.id, item)
      marks.push(...clearanceMarks(world, [item], this.clearance, asker))
    }
    const holeHits = this.holeHits(world, at)
    for (const hole of holeHits) {
      if (hole.item) violators.set(hole.item.id, hole.item)
      marks.push(holeMark(hole, layers[0]))
    }
    const keepouts = this.world.viaKeepoutsAt(at, this.radius, layers)
    for (const region of keepouts) marks.push(areaMark(region, layers[0]))
    const viaViolation = viaHits.length > 0 || holeHits.length > 0 || keepouts.length > 0

    const lines = this.lines.map((line, i) => {
      const path = paths[i]
      const q: ObstacleQuery = { layer: line.layer, excludeNet: this.net }
      const violations: boolean[] = []
      for (let k = 0; k < path.length - 1; k++) {
        const hits = world.collisions(path[k], path[k + 1], line.width / 2, this.clearance, q)
        const fresh = hits.map((h) => h.item).filter((item) => !violators.has(item.id))
        for (const item of fresh) violators.set(item.id, item)
        marks.push(...clearanceMarks(world, fresh, this.clearance, q))
        violations.push(hits.length > 0)
      }
      return { path, width: line.width, layer: line.layer, violations }
    })

    const displaced = this.shove.displaced()
    const own = [
      this.via,
      ...this.lines.flatMap((l) => l.ids.map((id) => this.world.base.items[id]))
    ]
    const update: ViaDragUpdate = {
      at,
      lines,
      viaViolation,
      blocked: viaViolation || lines.some((l) => l.violations.some(Boolean)),
      violators: [...violators.values()]
        .filter((item) => item.ref.index >= 0)
        .map((item) => ({ type: item.ref.type, index: item.ref.index })),
      marks,
      preview: {
        ...displaced,
        hiddenRefs: [
          ...displaced.hiddenRefs,
          ...own
            .filter((item): item is CopperItem => item !== undefined)
            .map((item) => ({ type: item.ref.type, index: item.ref.index }))
        ]
      }
    }
    this.lastUpdate = update
    return update
  }

  /** True while the board would be untouched: no update yet, or the via back where it was with nothing displaced (D7). */
  unchanged(): boolean {
    const last = this.lastUpdate
    if (!last) return true
    if (this.shove.displaced().segments.length > 0) return false
    if ((this.shove.displaced().vias?.length ?? 0) > 0) return false
    return samePt(last.at, this.origin)
  }

  /** The commit diff for the last update: the via moved, its tracks re-drawn, and what they pushed. */
  delta(): (ShoveDelta & { blocked: boolean }) | null {
    const last = this.lastUpdate
    if (!last) return null
    const shoveDelta = this.shove.delta()
    const removed = [...shoveDelta.removed]
    const added = [...shoveDelta.added]
    for (const [i, line] of this.lines.entries()) {
      for (const id of line.ids) {
        const item = this.world.base.items[id]
        if (item) removed.push({ type: item.ref.type, index: item.ref.index })
      }
      const path = last.lines[i].path
      for (let k = 0; k < path.length - 1; k++) {
        added.push({
          start: { ...path[k] },
          end: { ...path[k + 1] },
          width: line.width,
          layer: line.layer,
          net: this.net
        })
      }
    }
    const movedVias = [
      ...(shoveDelta.movedVias ?? []),
      { index: this.via.ref.index, x: last.at.x, y: last.at.y }
    ]
    return {
      removed,
      added,
      ...(shoveDelta.addedArcs ? { addedArcs: shoveDelta.addedArcs } : {}),
      movedVias,
      blocked: last.blocked
    }
  }

  private viaHits(world: RouterWorld, at: Pt): Array<{ item: CopperItem; asker: ObstacleQuery }> {
    const out: Array<{ item: CopperItem; asker: ObstacleQuery }> = []
    for (const layer of this.via.layers) {
      const asker: ObstacleQuery = { layer, excludeNet: this.net, kind: 'via' }
      for (const h of world.collisions(at, at, this.radius, this.clearance, asker))
        out.push({ item: h.item, asker })
    }
    return out
  }

  /** What the via's hole at `at` comes too close to (R24). */
  private holeHits(world: RouterWorld, at: Pt): HoleConflict[] {
    return world.viaHoleConflicts({
      at,
      drill: world.bounds().viaDrill(this.via.ref.index),
      net: this.net,
      layers: this.via.layers
    })
  }

  /** Whether the via stands clear at `at` over the board as it was: every layer, its hole, keepouts, the board. */
  private standsClear(at: Pt): boolean {
    return (
      this.world.onBoard(at) &&
      this.viaHits(this.world, at).length === 0 &&
      this.holeHits(this.world, at).length === 0 &&
      this.world.viaKeepoutsAt(at, this.radius, this.via.layers).length === 0
    )
  }

  /**
   * Carried track `i` walked round what it meets, both ends held, each
   * obstacle on the side it had last frame (R8); null when it cannot.
   */
  private walk(path: Pt[], i: number, cornerMode: RouteCornerMode): Pt[] | null {
    const line = this.lines[i]
    const halfWidth = line.width / 2
    const q: ObstacleQuery = { layer: line.layer, excludeNet: this.net }
    if (!this.world.pathViolates(path, halfWidth, this.clearance, q)) {
      return path
    }
    const r = walkAround(this.world, path, {
      ...q,
      halfWidth,
      clearance: this.clearance,
      cornerMode
    })
    if (r.status !== 'done') return null
    const walked = tidyPath(r.path)
    if (!samePt(walked[walked.length - 1], path[path.length - 1])) return null
    return walked
  }
}
