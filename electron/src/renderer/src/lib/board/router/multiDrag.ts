/**
 * Several tracks dragged at once (docs/router-behavior.md D14), as KiCad's
 * multi-drag does (`MULTI_DRAGGER`): `D` with tracks of several lines
 * selected drags the line under the cursor, the primary, as D2 drags a
 * segment, and every other selected line whose grabbed segment runs
 * parallel to it by the same amount, so a bus keeps its spacing. Grabbed at a
 * free end (D12), the lines' free ends move together instead, each by its
 * offset across the primary's last segment.
 *
 * The collision mode applies to all of them together: Highlight marks, Avoid
 * walks each round what it meets with the others as obstacles, Push pushes
 * for all of them at once (`ShoveSession.proposeGroup`, each keeping clear of
 * the others), and where that push cannot be done the drag is blocked, as
 * KiCad's multi-drag shove is: no line falls back to walking.
 */

import type { CopperItem, Pt } from '../spatialIndex'
import type { RouteCornerMode } from '../pcbTools'
import type { ObstacleQuery, RouterWorld } from './world'
import { assembleLine, type AssembledLine } from './lines'
import {
  overlaySegment,
  ShoveSession,
  type GroupHead,
  type ShoveDelta,
  type ShoveOptions
} from './shove'
import { walkAround } from './walkaround'
import { dragGeometry, snapDragCursor, type DragGrab, type DragOptions } from './drag'
import { samePt, tidyPath } from './geometry'
import { clearanceMarks, type RouteMode, type ViolationMark } from './engine'

export interface MultiDragUpdate {
  /** Each dragged line's proposed geometry, with which of its segments violate. */
  lines: Array<{ path: Pt[]; width: number; layer: string; violations: boolean[] }>
  blocked: boolean
  violators: Array<{ type: string; index: number }>
  marks: ViolationMark[]
  /** The dragged lines and what was pushed, hidden where they were; pushed copper to draw. */
  preview: ReturnType<ShoveSession['displaced']>
}

interface Dragged {
  line: AssembledLine
  grab: DragGrab
  /** How far across the primary's grabbed segment this line's lies. */
  offset: number
  /** Whether it runs with the primary, and so moves at all. */
  follows: boolean
}

const unit = (v: Pt): Pt => {
  const len = Math.hypot(v.x, v.y)
  return len < 1e-12 ? { x: 1, y: 0 } : { x: v.x / len, y: v.y / len }
}

export class MultiDragSession {
  private readonly world: RouterWorld
  private readonly shove: ShoveSession
  private readonly dragged: Dragged[]
  /** Across the primary's grabbed segment, toward positive offsets. */
  private readonly across: Pt
  private last: MultiDragUpdate | null = null

  constructor(
    baseWorld: RouterWorld,
    /** One segment of each line to drag; the one nearest `grabPoint` leads. */
    seeds: readonly CopperItem[],
    grabPoint: Pt,
    private readonly clearance: number,
    private readonly options: DragOptions & ShoveOptions = {}
  ) {
    const lines: Array<{ line: AssembledLine; seed: CopperItem }> = []
    const seen = new Set<number>()
    for (const seed of seeds) {
      if (seen.has(seed.id) || seed.shape.kind !== 'capsule') continue
      const line = assembleLine(baseWorld, seed)
      line.ids.forEach((id) => seen.add(id))
      lines.push({ line, seed })
    }
    this.world = baseWorld.branch()
    for (const { line } of lines) for (const id of line.ids) this.world.remove(id)
    this.shove = new ShoveSession(this.world, options)

    const segIndex = (line: AssembledLine, seed: CopperItem): number => {
      const s = seed.shape
      if (s.kind !== 'capsule') return 0
      for (let i = 0; i < line.path.length - 1; i++) {
        const a = line.path[i]
        const b = line.path[i + 1]
        const same = (p: Pt, q: Pt): boolean => samePt(p, q)
        if (
          (same(a, { x: s.x0, y: s.y0 }) && same(b, { x: s.x1, y: s.y1 })) ||
          (same(b, { x: s.x0, y: s.y0 }) && same(a, { x: s.x1, y: s.y1 }))
        )
          return i
      }
      return 0
    }
    // The primary: the line whose seed is nearest the grab.
    const distTo = (seed: CopperItem): number => {
      const s = seed.shape
      if (s.kind !== 'capsule') return Infinity
      const dx = s.x1 - s.x0
      const dy = s.y1 - s.y0
      const l2 = dx * dx + dy * dy
      const t =
        l2 > 0
          ? Math.max(0, Math.min(1, ((grabPoint.x - s.x0) * dx + (grabPoint.y - s.y0) * dy) / l2))
          : 0
      return Math.hypot(s.x0 + dx * t - grabPoint.x, s.y0 + dy * t - grabPoint.y)
    }
    lines.sort((a, b) => distTo(a.seed) - distTo(b.seed))
    const primary = lines[0]
    // Grabbed at a free end of the primary: ends move together (D12's rule for each).
    const freeEnd = (line: AssembledLine, p: Pt): boolean =>
      this.world.itemsNear(p, line.width / 2).every((item) => item.net !== line.net)
    const pPath = primary?.line.path ?? []
    const atEnd =
      primary !== undefined &&
      [0, pPath.length - 1].find(
        (i) =>
          Math.hypot(pPath[i].x - grabPoint.x, pPath[i].y - grabPoint.y) <=
            Math.max(primary.line.width / 2, 0.05) && freeEnd(primary.line, pPath[i])
      )

    if (!primary) {
      this.dragged = []
      this.across = { x: 0, y: 1 }
      return
    }
    if (atEnd !== undefined && atEnd !== false) {
      // Across the primary's last segment, at the grabbed end.
      const end = pPath[atEnd]
      const before = atEnd === 0 ? pPath[1] : pPath[pPath.length - 2]
      const u = unit({ x: end.x - before.x, y: end.y - before.y })
      this.across = { x: -u.y, y: u.x }
      this.dragged = lines.map(({ line }) => {
        const p = line.path
        const ends = [0, p.length - 1].filter((i) => freeEnd(line, p[i]))
        const index = ends.sort(
          (a, b) =>
            Math.hypot(p[a].x - end.x, p[a].y - end.y) - Math.hypot(p[b].x - end.x, p[b].y - end.y)
        )[0]
        if (index === undefined)
          return { line, grab: { kind: 'end', index: 0 }, offset: 0, follows: false }
        const offset = (p[index].x - end.x) * this.across.x + (p[index].y - end.y) * this.across.y
        return { line, grab: { kind: 'end', index }, offset, follows: true }
      })
    } else {
      const k = segIndex(primary.line, primary.seed)
      const a = pPath[k]
      const u = unit({ x: pPath[k + 1].x - a.x, y: pPath[k + 1].y - a.y })
      this.across = { x: -u.y, y: u.x }
      this.dragged = lines.map(({ line, seed }) => {
        const i = segIndex(line, seed)
        const p = line.path
        const v = unit({ x: p[i + 1].x - p[i].x, y: p[i + 1].y - p[i].y })
        // Only a segment running the same way, either direction, follows.
        const follows = Math.abs(u.x * v.y - u.y * v.x) < 1e-6
        const offset = (p[i].x - a.x) * this.across.x + (p[i].y - a.y) * this.across.y
        return { line, grab: { kind: 'segment', index: i }, offset, follows }
      })
    }
  }

  get valid(): boolean {
    return this.dragged.length >= 2
  }

  /** The primary's net, for the focus dim (F8). */
  get net(): number {
    return this.dragged[0]?.line.net ?? 0
  }

  update(cursor: Pt, mode: RouteMode, cornerMode: RouteCornerMode = '45'): MultiDragUpdate {
    const primary = this.dragged[0]
    const at =
      this.options.smoothDragged === false || cornerMode === 'free' || !primary
        ? cursor
        : // D11: a quarter width in every mode, as KiCad's multi-drag snaps.
          snapDragCursor(primary.line.path, primary.grab, cursor, primary.line.width / 4)
    const drawn = this.dragged.map((d) => {
      if (!d.follows) return [...d.line.path]
      const c = { x: at.x + this.across.x * d.offset, y: at.y + this.across.y * d.offset }
      return dragGeometry(d.line.path, d.grab, c, cornerMode) ?? [...d.line.path]
    })

    let paths = drawn
    let world: RouterWorld = this.world
    let failed = false
    if (mode === 'shove') {
      const heads: GroupHead[] = this.dragged.map((d, i) => ({
        path: drawn[i],
        width: d.line.width,
        layer: d.line.layer,
        kind: 'track',
        net: d.line.net
      }))
      const r = this.shove.proposeGroup(
        heads,
        { clearance: this.clearance, net: this.net },
        cornerMode
      )
      // One push for all of them; where it cannot be done the drag is
      // blocked, not walked line by line (KiCad's multi-drag shove).
      if (r.status === 'failed') {
        this.shove.dropHead()
        failed = true
      } else {
        paths = r.paths
        world = this.shove.currentWorld()
      }
    } else {
      this.shove.dropHead()
    }
    if (mode === 'walkaround') paths = this.walkAll(drawn, cornerMode)

    // Judged together: each against the board and the others.
    const judge = world.branch()
    paths.forEach((path, i) => {
      const d = this.dragged[i]
      for (let k = 0; k < path.length - 1; k++)
        judge.add(overlaySegment(path[k], path[k + 1], d.line.width, d.line.layer, d.line.net))
    })
    const violators = new Map<number, CopperItem>()
    const marks: ViolationMark[] = []
    const lines = paths.map((path, i) => {
      const d = this.dragged[i]
      const q: ObstacleQuery = { layer: d.line.layer, excludeNet: d.line.net }
      const violations: boolean[] = []
      for (let k = 0; k < path.length - 1; k++) {
        const hits = judge.collisions(path[k], path[k + 1], d.line.width / 2, this.clearance, q)
        const fresh = hits.map((h) => h.item).filter((item) => !violators.has(item.id))
        for (const item of fresh) violators.set(item.id, item)
        marks.push(...clearanceMarks(judge, fresh, this.clearance, q))
        violations.push(hits.length > 0)
      }
      return { path, width: d.line.width, layer: d.line.layer, violations }
    })

    const displaced = this.shove.displaced()
    const own = this.dragged.flatMap((d) =>
      d.line.ids
        .map((id) => this.world.base.items[id]?.ref)
        .filter((ref): ref is CopperItem['ref'] => ref !== undefined)
        .map((ref) => ({ type: ref.type, index: ref.index }))
    )
    const update: MultiDragUpdate = {
      lines,
      blocked: failed || lines.some((l) => l.violations.some(Boolean)),
      violators: [...violators.values()]
        .filter((item) => item.ref.index >= 0)
        .map((item) => ({ type: item.ref.type, index: item.ref.index })),
      marks,
      preview: { ...displaced, hiddenRefs: [...displaced.hiddenRefs, ...own] }
    }
    this.last = update
    return update
  }

  /** True while nothing would change (D7). */
  unchanged(): boolean {
    const last = this.last
    if (!last) return true
    if (last.preview.segments.length > 0 || (last.preview.vias?.length ?? 0) > 0) return false
    return last.lines.every(
      (l, i) =>
        l.path.length === this.dragged[i].line.path.length &&
        l.path.every((p, k) => samePt(p, this.dragged[i].line.path[k]))
    )
  }

  /** The commit diff: what was pushed, and every dragged line replaced. */
  delta(): (ShoveDelta & { blocked: boolean }) | null {
    const last = this.last
    if (!last) return null
    // The push's diff already names the dragged lines: they are out of the world it pushed in.
    const shoveDelta = this.shove.delta()
    const added = [...shoveDelta.added]
    last.lines.forEach((l, i) => {
      const d = this.dragged[i]
      for (let k = 0; k < l.path.length - 1; k++)
        added.push({
          start: { ...l.path[k] },
          end: { ...l.path[k + 1] },
          width: l.width,
          layer: l.layer,
          net: d.line.net
        })
    })
    return {
      removed: shoveDelta.removed,
      added,
      ...(shoveDelta.addedArcs ? { addedArcs: shoveDelta.addedArcs } : {}),
      movedVias: shoveDelta.movedVias,
      blocked: last.blocked
    }
  }

  /** Avoid: each line walked round what it meets, the others' new shapes in the way; ends held. */
  private walkAll(drawn: Pt[][], cornerMode: RouteCornerMode): Pt[][] {
    const out: Pt[][] = []
    drawn.forEach((path, i) => {
      const d = this.dragged[i]
      const w = this.world.branch()
      drawn.forEach((other, j) => {
        if (j === i) return
        const o = this.dragged[j]
        const shape = j < i ? out[j] : other
        for (let k = 0; k < shape.length - 1; k++)
          w.add(overlaySegment(shape[k], shape[k + 1], o.line.width, o.line.layer, o.line.net))
      })
      const halfWidth = d.line.width / 2
      const q: ObstacleQuery = { layer: d.line.layer, excludeNet: d.line.net }
      if (!w.pathViolates(path, halfWidth, this.clearance, q)) {
        out.push(path)
        return
      }
      const r = walkAround(w, path, { ...q, halfWidth, clearance: this.clearance, cornerMode })
      const walked = tidyPath(r.path)
      if (r.status === 'done' && samePt(walked[walked.length - 1], path[path.length - 1])) {
        out.push(walked)
      } else out.push(path)
    })
    return out
  }
}
