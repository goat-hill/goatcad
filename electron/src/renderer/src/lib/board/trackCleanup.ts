// Parts follow KiCad's source, named below: Copyright The KiCad Developers, GPL-3.0-or-later.
/**
 * Cleanup Tracks & Vias: the debris a board collects from imports, agents
 * and hand edits, found and removed in one undo step. KiCad's
 * `TRACKS_CLEANER` (`pcbnew/tracks_cleaner.cpp`) sets the passes, their
 * options and their defaults; the tests are designed here, over the same
 * geometry the checks read:
 *
 * - redundant vias: one at the same point, type and layers as another, or
 *   one whose center is in a through-hole pad that reaches every copper layer;
 * - zero-length tracks, and a track drawn twice over the same two ends;
 * - shorts: a track or via with an end (a via's center) in copper of another
 *   net, or another net's end in it, both nets named — pads stay;
 * - tracks inside pads: a straight track whose whole copper lies in one pad;
 * - dangling copper, decided by DRC's own test (`danglingProbe`), asked again
 *   of whatever a removed piece touched until nothing more dangles;
 * - co-linear merges: two straight tracks of one net, width and layer meeting
 *   end to end where nothing else is, carrying straight on, become one.
 *
 * Locked copper and copper outside the filter are never removed or merged.
 * The plan reads the board's stored fills: dangling copper is only right
 * against a fresh fill, so callers refill first.
 *
 * Board coordinates are integer nm; the index's shapes are world mm, y up.
 */

import type { Nm } from '../kicad/coordinates'
import { nmToMm } from '../kicad/coordinates'
import { removeBoardNodeFromAST, updateSegmentInAST, type KicadBoard } from '../kicad/board'
import { isCopperLayer } from '../kicad/layers'
import {
  pointToShape,
  resolvePadCopperLayers,
  shapeOn,
  type CopperItem,
  type CopperShape,
  type Pt
} from './spatialIndex'
import { CONNECT_EPSILON, connectShape } from './boardConnectivity'
import type { BoardCheckInput } from './boardChecks'
import { buildDrcContext, type DrcContext } from './drc/context'
import { danglingProbe } from './drc/rules/dangling'

/** Which passes run: KiCad's dialog's options, by its defaults. */
export interface CleanupOptions {
  /** Delete tracks and vias connecting different nets. */
  shorts: boolean
  /** Delete vias over another via or a through-hole pad. */
  redundantVias: boolean
  /** Delete vias connected on fewer than two layers. */
  danglingVias: boolean
  /** Merge co-linear tracks (and remove zero-length ones). */
  mergeTracks: boolean
  /** Delete tracks with an end that connects to nothing. */
  danglingTracks: boolean
  /** Delete tracks whose copper lies wholly inside a pad. */
  tracksInPads: boolean
}

export const DEFAULT_CLEANUP_OPTIONS: Readonly<CleanupOptions> = {
  shorts: true,
  redundantVias: true,
  danglingVias: true,
  mergeTracks: true,
  danglingTracks: true,
  tracksInPads: false
}

export const CLEANUP_OPTION_KEYS = Object.keys(DEFAULT_CLEANUP_OPTIONS) as Array<
  keyof CleanupOptions
>

/** A track, track arc or via, as the board's arrays hold it. */
export interface TrackRef {
  type: 'segment' | 'tarc' | 'via'
  index: number
}

export type CleanupKind =
  | 'shorting-track'
  | 'shorting-via'
  | 'redundant-via'
  | 'duplicate-track'
  | 'zero-length-track'
  | 'track-in-pad'
  | 'dangling-track'
  | 'dangling-via'
  | 'merge-tracks'

/** One change the plan makes, in the order found. */
export interface CleanupChange {
  kind: CleanupKind
  /** What it removes; a merge's is the track kept, then the one merged into it. */
  items: TrackRef[]
  /** Where, in board nm. */
  at: { x: Nm; y: Nm }
  layer: string
}

export interface CleanupPlan {
  changes: CleanupChange[]
  /** Indices to remove, ascending. */
  remove: { segments: number[]; arcs: number[]; vias: number[] }
  /** Tracks a merge lengthened: their new ends. */
  update: Array<{ index: number; start: { x: Nm; y: Nm }; end: { x: Nm; y: Nm } }>
}

/** Whether a track or via is in the cleanup's scope. */
export type CleanupScope = (ref: TrackRef) => boolean

const refKey = (ref: { type: string; index: number }): string => `${ref.type}:${ref.index}`
const nmKey = (p: { x: Nm; y: Nm }, layer: string): string => `${p.x},${p.y},${layer}`
const sameNm = (a: { x: Nm; y: Nm }, b: { x: Nm; y: Nm }): boolean => a.x === b.x && a.y === b.y
const world = (p: { x: Nm; y: Nm }): Pt => ({ x: nmToMm(p.x), y: -nmToMm(p.y) })

/** How far off a straight line a joint may round and still carry straight on. */
const ON_LINE_NM = 2

/** Whether b→c carries straight on from a→b, the same way. */
const straightOn = (a: { x: Nm; y: Nm }, b: { x: Nm; y: Nm }, c: { x: Nm; y: Nm }): boolean => {
  const ux = b.x - a.x
  const uy = b.y - a.y
  const vx = c.x - b.x
  const vy = c.y - b.y
  const lu = Math.hypot(ux, uy)
  const lv = Math.hypot(vx, vy)
  if (lu === 0 || lv === 0) return false
  return Math.abs(ux * vy - uy * vx) <= ON_LINE_NM * Math.max(lu, lv) && ux * vx + uy * vy > 0
}

/** Whether a disc of radius `r` at `p` lies inside a round or rounded-rectangle pad. */
const discInside = (shape: CopperShape, p: Pt, r: number): boolean => {
  if (shape.kind === 'circle') return Math.hypot(p.x - shape.cx, p.y - shape.cy) + r <= shape.r
  if (shape.kind !== 'rrect') return false
  const c = Math.cos(-shape.rotation)
  const s = Math.sin(-shape.rotation)
  const dx = p.x - shape.cx
  const dy = p.y - shape.cy
  const ax = Math.abs(dx * c - dy * s)
  const ay = Math.abs(dx * s + dy * c)
  if (ax + r > shape.halfW || ay + r > shape.halfH) return false
  const cornerX = shape.halfW - shape.cornerR
  const cornerY = shape.halfH - shape.cornerR
  if (ax <= cornerX || ay <= cornerY) return true
  return Math.hypot(ax - cornerX, ay - cornerY) + r <= shape.cornerR
}

/**
 * The cleanup of a board: what it would change, and the edit that makes it.
 * Yields between slices of work, as the checks do. With `seeds`, dangling
 * copper is asked of those first and then only of what their removal leaves
 * hanging: a finding's quick fix, which takes its stub and nothing else.
 */
export function* planTrackCleanup(
  input: BoardCheckInput,
  options: CleanupOptions,
  inScope: CleanupScope = () => true,
  seeds?: readonly TrackRef[]
): Generator<void, CleanupPlan> {
  const { board, index } = input
  const changes: CleanupChange[] = []
  const gone = new Set<string>()
  let sliceStart = performance.now()
  const sliceDone = (): boolean => {
    const now = performance.now()
    if (now - sliceStart < 4) return false
    sliceStart = now
    return true
  }

  const itemOf = new Map<string, CopperItem>()
  for (const item of index.items) itemOf.set(refKey(item.ref), item)
  const locked = (ref: TrackRef): boolean =>
    (ref.type === 'segment'
      ? board.segments[ref.index]
      : ref.type === 'tarc'
        ? board.trackArcs[ref.index]
        : board.vias[ref.index]
    ).locked
  /** Whether the plan may remove or merge it. */
  const removable = (ref: TrackRef): boolean =>
    !gone.has(refKey(ref)) && !locked(ref) && inScope(ref)
  const removeRef = (
    kind: CleanupKind,
    ref: TrackRef,
    at: { x: Nm; y: Nm },
    layer: string
  ): void => {
    gone.add(refKey(ref))
    changes.push({ kind, items: [ref], at, layer })
  }
  const live = (item: CopperItem): boolean => !gone.has(refKey(item.ref))
  const near = (item: CopperItem): CopperItem[] =>
    index
      .query(
        item.minX - CONNECT_EPSILON,
        item.minY - CONNECT_EPSILON,
        item.maxX + CONNECT_EPSILON,
        item.maxY + CONNECT_EPSILON
      )
      .filter((other) => other.id !== item.id && live(other))
  const copperLayers = board.layers.filter((l) => isCopperLayer(l.name)).map((l) => l.name)

  if (options.redundantVias) {
    const first = new Map<string, number>()
    for (const [i, via] of board.vias.entries()) {
      if (sliceDone()) yield
      const ref: TrackRef = { type: 'via', index: i }
      const key = `${via.position.x},${via.position.y},${via.type ?? 'through'},${via.layers.join(' ')}`
      const before = first.get(key)
      if (before === undefined) {
        first.set(key, i)
        continue
      }
      // Of two alike, the earlier stays unless only it can go.
      const drop = removable(ref) ? ref : { type: 'via' as const, index: before }
      if (!removable(drop)) continue
      if (drop.index === before) first.set(key, i)
      removeRef('redundant-via', drop, board.vias[drop.index].position, via.layers[0])
    }
    for (const [i, via] of board.vias.entries()) {
      if (sliceDone()) yield
      const ref: TrackRef = { type: 'via', index: i }
      const item = itemOf.get(refKey(ref))
      if (!item || !removable(ref)) continue
      const center = world(via.position)
      const onPad = near(item).some((other) => {
        if (other.ref.type !== 'pad') return false
        const pad = board.footprints[other.ref.index].footprint.pads[other.ref.pad]
        if (!pad.drill) return false
        if (resolvePadCopperLayers(pad, copperLayers).length < copperLayers.length) return false
        return other.layers.some(
          (layer) => pointToShape(shapeOn(other, layer), center.x, center.y) <= CONNECT_EPSILON
        )
      })
      if (onPad) removeRef('redundant-via', ref, via.position, via.layers[0])
    }
  }

  if (options.mergeTracks || options.shorts) {
    for (const [i, seg] of board.segments.entries()) {
      const ref: TrackRef = { type: 'segment', index: i }
      if (sameNm(seg.start, seg.end) && removable(ref))
        removeRef('zero-length-track', ref, seg.start, seg.layer)
    }
    for (const [i, arc] of board.trackArcs.entries()) {
      const ref: TrackRef = { type: 'tarc', index: i }
      if (sameNm(arc.start, arc.end) && sameNm(arc.start, arc.mid) && removable(ref))
        removeRef('zero-length-track', ref, arc.start, arc.layer)
    }
  }

  // A track drawn twice over the same two ends is always removed, as KiCad's is.
  {
    const first = new Map<string, number>()
    for (const [i, seg] of board.segments.entries()) {
      const ref: TrackRef = { type: 'segment', index: i }
      if (gone.has(refKey(ref)) || sameNm(seg.start, seg.end)) continue
      const [a, b] = [nmKey(seg.start, ''), nmKey(seg.end, '')].sort()
      const key = `${seg.layer}|${seg.width}|${a}|${b}`
      const before = first.get(key)
      if (before === undefined) {
        first.set(key, i)
        continue
      }
      const drop = removable(ref) ? ref : { type: 'segment' as const, index: before }
      if (!removable(drop)) continue
      if (drop.index === before) first.set(key, i)
      removeRef('duplicate-track', drop, seg.start, seg.layer)
    }
  }

  if (options.shorts) {
    /** The points a piece of copper joins others by: a track's ends, a via's or pad's center. */
    const anchorsOf = (item: CopperItem): Pt[] => {
      const shape = item.shape
      if (shape.kind === 'capsule' || shape.kind === 'arc')
        return [
          { x: shape.x0, y: shape.y0 },
          { x: shape.x1, y: shape.y1 }
        ]
      if (item.anchor) return [item.anchor]
      return shape.kind === 'circle' ? [{ x: shape.cx, y: shape.cy }] : []
    }
    const meets = (a: CopperItem, b: CopperItem): boolean =>
      a.layers.some(
        (layer) =>
          b.layers.includes(layer) &&
          (anchorsOf(a).some(
            (p) => pointToShape(connectShape(board, b, layer), p.x, p.y) <= CONNECT_EPSILON
          ) ||
            anchorsOf(b).some(
              (p) => pointToShape(connectShape(board, a, layer), p.x, p.y) <= CONNECT_EPSILON
            ))
      )
    const shorting: Array<{ ref: TrackRef; item: CopperItem }> = []
    for (const item of index.items) {
      if (sliceDone()) yield
      const type = item.ref.type
      if ((type !== 'segment' && type !== 'tarc' && type !== 'via') || item.net <= 0) continue
      const ref: TrackRef = { type, index: item.ref.index }
      if (!removable(ref)) continue
      const other = near(item).find(
        (o) => o.ref.type !== 'drawing' && o.net > 0 && o.net !== item.net && meets(item, o)
      )
      if (other) shorting.push({ ref, item })
    }
    // Every side of a short goes, found before any is removed, as KiCad's does.
    for (const { ref, item } of shorting) {
      const at = trackAt(board, ref)
      removeRef(ref.type === 'via' ? 'shorting-via' : 'shorting-track', ref, at, item.layers[0])
    }
  }

  if (options.tracksInPads) {
    for (const [i, seg] of board.segments.entries()) {
      if (sliceDone()) yield
      const ref: TrackRef = { type: 'segment', index: i }
      const item = itemOf.get(refKey(ref))
      if (!item || !removable(ref) || item.shape.kind !== 'capsule') continue
      const shape = item.shape
      const inPad = near(item).some(
        (other) =>
          other.ref.type === 'pad' &&
          other.layers.includes(seg.layer) &&
          discInside(shapeOn(other, seg.layer), { x: shape.x0, y: shape.y0 }, shape.halfWidth) &&
          discInside(shapeOn(other, seg.layer), { x: shape.x1, y: shape.y1 }, shape.halfWidth)
      )
      if (inPad) removeRef('track-in-pad', ref, seg.start, seg.layer)
    }
  }

  const merging = options.mergeTracks
  const ctx =
    options.danglingTracks || options.danglingVias || merging ? yield* buildDrcContext(input) : null

  if (ctx && (options.danglingTracks || options.danglingVias)) {
    const probe = yield* danglingProbe(ctx)
    for (const item of index.items) if (!live(item)) probe.remove(item.id)
    const tests = (item: CopperItem): boolean => {
      const type = item.ref.type
      if (type === 'via') return options.danglingVias
      return (type === 'segment' || type === 'tarc') && options.danglingTracks
    }
    const dangles = (item: CopperItem): boolean => {
      if (item.ref.type !== 'via') return probe.openEnd(item) !== null
      const layers = probe.viaLayers(item)
      return layers.size < 2 && !(layers.size === 0 && item.net <= 0)
    }
    const queue = seeds
      ? seeds.flatMap((ref) => itemOf.get(refKey(ref)) ?? []).filter((item) => tests(item))
      : index.items.filter((item) => tests(item))
    const queued = new Set(queue.map((item) => item.id))
    while (queue.length > 0) {
      if (sliceDone()) yield
      const item = queue.shift()!
      queued.delete(item.id)
      const ref = item.ref as TrackRef
      if (!removable(ref)) continue
      if (!dangles(item)) continue
      // What it touched may dangle once it is gone: ask again. Seeded, only
      // what this removal leaves hanging, never what already hung on its own.
      const touched = probe
        .touching(item)
        .map(({ other }) => other)
        .filter((other) => tests(other) && !queued.has(other.id))
        .filter((other) => !seeds || !dangles(other))
      removeRef(
        ref.type === 'via' ? 'dangling-via' : 'dangling-track',
        ref,
        trackAt(board, ref),
        item.layers[0]
      )
      probe.remove(item.id)
      for (const other of touched) {
        queue.push(other)
        queued.add(other.id)
      }
    }
  }

  const update = new Map<number, { start: { x: Nm; y: Nm }; end: { x: Nm; y: Nm } }>()
  if (ctx && merging) yield* mergeTracks(board, ctx, gone, removable, update, changes, sliceDone)

  const removed = (type: TrackRef['type']): number[] =>
    [...gone]
      .filter((key) => key.startsWith(`${type}:`))
      .map((key) => Number(key.slice(type.length + 1)))
      .sort((a, b) => a - b)
  return {
    changes,
    remove: { segments: removed('segment'), arcs: removed('tarc'), vias: removed('via') },
    update: [...update].map(([i, ends]) => ({ index: i, ...ends }))
  }
}

/** Run a plan in slices between frames, so a large board never holds the UI. */
export async function planInSlices(steps: Generator<void, CleanupPlan>): Promise<CleanupPlan> {
  let started = performance.now()
  for (;;) {
    const step = steps.next()
    if (step.done) return step.value
    if (performance.now() - started > 12) {
      await new Promise((resolve) => setTimeout(resolve))
      started = performance.now()
    }
  }
}

/** Where a track or via is named: a track's start, a via's center. */
function trackAt(board: KicadBoard, ref: TrackRef): { x: Nm; y: Nm } {
  return ref.type === 'segment'
    ? board.segments[ref.index].start
    : ref.type === 'tarc'
      ? board.trackArcs[ref.index].start
      : board.vias[ref.index].position
}

/**
 * Join straight tracks end to end: at a point where exactly two tracks of
 * one net, width and layer end, carrying straight on, and no other copper
 * (a pad, via, arc, graphic or a third track through it) is there. The
 * earlier track keeps its node and takes the other's far end; runs repeat
 * until no joint is left, so a chain becomes one track.
 */
function* mergeTracks(
  board: KicadBoard,
  { index, drawingSet }: Pick<DrcContext, 'index' | 'drawingSet'>,
  gone: Set<string>,
  removable: (ref: TrackRef) => boolean,
  update: Map<number, { start: { x: Nm; y: Nm }; end: { x: Nm; y: Nm } }>,
  changes: CleanupChange[],
  sliceDone: () => boolean
): Generator<void> {
  /** The track a merged-away one now lies inside. */
  const into = new Map<number, number>()
  const owner = (i: number): number => {
    let at = i
    while (into.has(at)) at = into.get(at)!
    return at
  }
  const ends = (i: number): { start: { x: Nm; y: Nm }; end: { x: Nm; y: Nm } } =>
    update.get(i) ?? board.segments[i]
  for (;;) {
    const at = new Map<string, number[]>()
    for (const [i, seg] of board.segments.entries()) {
      if (gone.has(`segment:${i}`)) continue
      const { start, end } = ends(i)
      if (sameNm(start, end)) continue
      for (const p of [start, end]) {
        const key = nmKey(p, seg.layer)
        const list = at.get(key)
        if (list) list.push(i)
        else at.set(key, [i])
      }
    }
    const changed = new Set<number>()
    for (const [key, there] of at) {
      if (sliceDone()) yield
      if (there.length !== 2) continue
      const [a, b] = there[0] < there[1] ? there : [there[1], there[0]]
      if (a === b || changed.has(a) || changed.has(b)) continue
      const sa = board.segments[a]
      const sb = board.segments[b]
      if (sa.net !== sb.net || sa.width !== sb.width || sa.layer !== sb.layer) continue
      if (!removable({ type: 'segment', index: a }) || !removable({ type: 'segment', index: b }))
        continue
      const ea = ends(a)
      const eb = ends(b)
      const joint = sameNm(ea.start, eb.start) || sameNm(ea.start, eb.end) ? ea.start : ea.end
      if (nmKey(joint, sa.layer) !== key) continue
      const farA = sameNm(ea.start, joint) ? ea.end : ea.start
      const farB = sameNm(eb.start, joint) ? eb.end : eb.start
      if (!straightOn(farA, joint, farB)) continue
      const p = world(joint)
      const blocked = [
        ...index.query(p.x, p.y, p.x, p.y),
        ...drawingSet.query(p.x, p.y, p.x, p.y).filter((d) => d.connected)
      ].some((other) => {
        if (!other.layers.includes(sa.layer)) return false
        if (other.ref.type === 'segment') {
          // A piece merged away is still copper of the track it joined, unless that is a or b.
          const o = owner(other.ref.index)
          if (o === a || o === b) return false
          if (o === other.ref.index && gone.has(`segment:${o}`)) return false
        } else if (gone.has(refKey(other.ref))) return false
        return pointToShape(connectShape(board, other, sa.layer), p.x, p.y) <= CONNECT_EPSILON
      })
      if (blocked) continue
      update.set(
        a,
        sameNm(ea.start, joint) ? { start: farB, end: ea.end } : { start: ea.start, end: farB }
      )
      update.delete(b)
      gone.add(`segment:${b}`)
      into.set(b, a)
      changed.add(a)
      changed.add(b)
      changes.push({
        kind: 'merge-tracks',
        items: [
          { type: 'segment', index: a },
          { type: 'segment', index: b }
        ],
        at: joint,
        layer: sa.layer
      })
    }
    if (changed.size === 0) break
  }
  // A track whose ends came back where they were is not changed.
  for (const [i, e] of update) {
    const seg = board.segments[i]
    if (sameNm(e.start, seg.start) && sameNm(e.end, seg.end)) update.delete(i)
  }
}

/** Make a plan's edit on the board's AST: lengthen what merged, then remove. */
export function applyTrackCleanup(board: KicadBoard, plan: CleanupPlan): void {
  for (const { index, start, end } of plan.update)
    updateSegmentInAST(board.segments[index], { start, end }, board)
  const raws = [
    ...plan.remove.segments.map((i) => board.segments[i]._raw),
    ...plan.remove.arcs.map((i) => board.trackArcs[i]._raw),
    ...plan.remove.vias.map((i) => board.vias[i]._raw)
  ]
  for (const raw of raws) removeBoardNodeFromAST(board, raw)
}
