/**
 * What a route or a drag writes to the board when it lands: the router's
 * diff of pushed copper, and a finished route's own tracks, arcs and vias,
 * tidied as `routeCommit.ts` plans (router-behavior.md R25–R27, R32).
 *
 * Pure AST writes over the editor's own mutators, run inside one board
 * command by whoever lands the route: the PCB editor's route and drag
 * gestures, and an agent's routing session (`routeAgent.ts`). Router
 * space is world mm, y up; the file is nm, y down, and the conversion is here.
 */
import {
  addSegmentToBoardAST,
  addTrackArcToBoardAST,
  addViaToBoardAST,
  removeBoardNodeFromAST,
  updateSegmentInAST,
  updateTrackArcInAST,
  updateViaInAST,
  type KicadBoard
} from '../kicad/board'
import { mmToNm, nmToMm, type Nm } from '../kicad/coordinates'
import type { PreviewSegment, ShoveDelta } from './router/shove'
import {
  planRouteCommit,
  type Anchored,
  type NmPt,
  type RouteCommitPlan
} from './router/routeCommit'
import type { BoardSpatialIndex } from './spatialIndex'
import { viaFileForm, type RouteViaType } from './viaPlacement'

/** A segment of a route in progress, scene space; `mid` makes it an arc through it (R3). */
export interface RouteDraftSegment {
  x0: number
  y0: number
  x1: number
  y1: number
  layer: string
  width: number
  mid?: { x: number; y: number }
}

/** A via a route placed; its type and the copper it spans (R41), absent a through via. */
export interface RouteDraftVia {
  x: number
  y: number
  size: number
  drill: number
  type?: RouteViaType
  layers?: string[]
}

/**
 * Write a router diff into the board: moved vias in place, and each removed
 * segment re-used for an added one of the same net, layer and width, so a
 * track that only changed shape keeps its node (uuid, lock, anything else
 * it carries). What is left over is deleted or inserted.
 */
export function applyRouterDelta(b: KicadBoard, delta: ShoveDelta): void {
  for (const v of delta.movedVias ?? []) {
    const via = b.vias[v.index]
    if (via) updateViaInAST(via, { position: { x: mmToNm(v.x), y: mmToNm(-v.y) } }, b)
  }
  // Each removed track once, however many parts of the diff name it.
  const spare = [
    ...new Set(delta.removed.filter((ref) => ref.type === 'segment').map((ref) => ref.index))
  ]
    .map((index) => b.segments[index])
    .filter((seg): seg is NonNullable<typeof seg> => seg !== undefined)
  for (const seg of delta.added) {
    const start = { x: mmToNm(seg.start.x), y: mmToNm(-seg.start.y) }
    const end = { x: mmToNm(seg.end.x), y: mmToNm(-seg.end.y) }
    const width = mmToNm(seg.width)
    const reuse = spare.findIndex(
      (old) => old.net === seg.net && old.layer === seg.layer && old.width === width
    )
    if (reuse >= 0) {
      updateSegmentInAST(spare[reuse], { start, end }, b)
      spare.splice(reuse, 1)
    } else {
      addSegmentToBoardAST(b, { start, end, width, layer: seg.layer, net: seg.net })
    }
  }
  for (const old of spare) removeBoardNodeFromAST(b, old._raw)
  // Arcs a push moved go; those it kept are not in the diff at all (P11).
  const arcs = [
    ...new Set(delta.removed.filter((ref) => ref.type === 'tarc').map((ref) => ref.index))
  ]
    .map((index) => b.trackArcs[index])
    .filter((arc): arc is NonNullable<typeof arc> => arc !== undefined)
  for (const arc of arcs) removeBoardNodeFromAST(b, arc._raw)
  for (const a of delta.addedArcs ?? [])
    addTrackArcToBoardAST(b, {
      start: { x: mmToNm(a.start.x), y: mmToNm(-a.start.y) },
      mid: { x: mmToNm(a.mid.x), y: mmToNm(-a.mid.y) },
      end: { x: mmToNm(a.end.x), y: mmToNm(-a.end.y) },
      width: mmToNm(a.width),
      layer: a.layer,
      net: a.net
    })
}

/**
 * Whether a pad or via of the route's net holds a point (board nm) on a
 * layer — the route's own new vias included — where two tracks meeting end to
 * end stay two (R26).
 */
export const routeAnchored =
  (
    index: BoardSpatialIndex | null,
    net: number,
    vias: ReadonlyArray<{ x: number; y: number }>
  ): Anchored =>
  (p, layer) => {
    const x = nmToMm(p.x)
    const y = -nmToMm(p.y)
    const via = vias.findIndex((v) => Math.abs(v.x - x) < 1e-6 && Math.abs(v.y - y) < 1e-6)
    if (via >= 0) return `route-via:${via}`
    if (!index) return false
    // The route preview plans a landing every move: the board's answers are
    // kept for as long as its index is.
    let known = boardAnchors.get(index)
    if (!known) boardAnchors.set(index, (known = new Map()))
    const key = `${p.x},${p.y},${layer},${net}`
    let found = known.get(key)
    if (found === undefined) {
      const hit = index
        .near(x, y, 1e-6, { layer, net })
        .find((h) => h.item.ref.type === 'pad' || h.item.ref.type === 'via')
      found = hit ? `item:${hit.item.id}` : false
      known.set(key, found)
    }
    return found
  }

const boardAnchors = new WeakMap<BoardSpatialIndex, Map<string, string | false>>()

/**
 * What landing a route would do to the board's copper beyond adding the
 * route's arcs and vias (R26, R27, R32): planned on the board as it stands, the
 * route's straight segments in file space.
 */
export function planLanding(
  b: KicadBoard,
  route: {
    segments: readonly RouteDraftSegment[]
    vias: ReadonlyArray<{ x: number; y: number }>
    net: number
  },
  options: { removeLoops: boolean; index: BoardSpatialIndex | null }
): RouteCommitPlan {
  const { segments, vias, net } = route
  return planRouteCommit(
    segments
      .filter((s) => !s.mid)
      .map((s) => ({
        start: { x: mmToNm(s.x0), y: mmToNm(-s.y0) },
        end: { x: mmToNm(s.x1), y: mmToNm(-s.y1) },
        width: mmToNm(s.width),
        layer: s.layer
      })),
    net > 0 ? b.segments.flatMap((seg, index) => (seg.net === net ? [{ ...seg, index }] : [])) : [],
    net,
    routeAnchored(options.index, net, vias),
    net > 0
      ? b.trackArcs.flatMap((arc, index) => (arc.net === net ? [{ ...arc, index }] : []))
      : [],
    { removeLoops: options.removeLoops }
  )
}

/**
 * A landing plan as the route preview shows it (R26, R27): the board tracks
 * and arcs it changes or removes hidden, and what it leaves of them drawn in
 * their place. The route's own segments are the route preview's.
 */
export function landingPreview(
  b: KicadBoard,
  plan: RouteCommitPlan
): { hiddenRefs: Array<{ type: string; index: number }>; segments: PreviewSegment[] } {
  const piece = (start: NmPt, end: NmPt, width: Nm, layer: string): PreviewSegment => ({
    x0: nmToMm(start.x),
    y0: -nmToMm(start.y),
    x1: nmToMm(end.x),
    y1: -nmToMm(end.y),
    width: nmToMm(width),
    layer
  })
  const segments: PreviewSegment[] = []
  for (const u of plan.update) {
    const seg = b.segments[u.index]
    if (seg) segments.push(piece(u.start, u.end, seg.width, seg.layer))
  }
  for (const a of plan.add)
    if (a.from !== undefined) segments.push(piece(a.start, a.end, a.width, a.layer))
  return {
    hiddenRefs: [
      ...plan.update.map((u) => ({ type: 'segment', index: u.index })),
      ...plan.remove.segments.map((index) => ({ type: 'segment', index })),
      ...plan.remove.arcs.map((index) => ({ type: 'tarc', index }))
    ],
    segments
  }
}

/**
 * Land a finished route: its pushes (`delta`), then its own copper, tidied as
 * it lands — straight runs merged, tees split, copper it lies over to a dead
 * end removed (R26, R32), a rounded corner as a track arc (R3), the
 * connection it replaces removed unless `removeLoops` is off (R27), and its
 * vias in the file's form for their span (R41).
 */
export function landRoute(
  b: KicadBoard,
  route: {
    segments: readonly RouteDraftSegment[]
    vias: readonly RouteDraftVia[]
    net: number
  },
  options: {
    delta?: ShoveDelta
    removeLoops: boolean
    copper: readonly string[]
    index: BoardSpatialIndex | null
  }
): void {
  const { segments, vias, net } = route
  if (options.delta) applyRouterDelta(b, options.delta)
  for (const s of segments) {
    if (!s.mid) continue
    addTrackArcToBoardAST(b, {
      start: { x: mmToNm(s.x0), y: mmToNm(-s.y0) },
      mid: { x: mmToNm(s.mid.x), y: mmToNm(-s.mid.y) },
      end: { x: mmToNm(s.x1), y: mmToNm(-s.y1) },
      width: mmToNm(s.width),
      layer: s.layer,
      net
    })
  }
  const plan = planLanding(b, route, options)
  // Every node the plan names, before any write moves an index.
  const removed = plan.remove.segments.map((index) => b.segments[index])
  const removedArcs = plan.remove.arcs.map((index) => b.trackArcs[index])
  for (const { index, start, end } of plan.update) {
    const seg = b.segments[index]
    if (seg) updateSegmentInAST(seg, { start, end })
  }
  for (const { index, pieces } of plan.arcSplits) {
    const arc = b.trackArcs[index]
    if (!arc) continue
    const { width, layer } = arc
    updateTrackArcInAST(arc, pieces[0])
    for (const piece of pieces.slice(1)) addTrackArcToBoardAST(b, { ...piece, width, layer, net })
  }
  for (const { start, end, width, layer } of plan.add)
    addSegmentToBoardAST(b, { start, end, width, layer, net })
  for (const seg of removed) if (seg) removeBoardNodeFromAST(b, seg._raw)
  for (const arc of removedArcs) if (arc) removeBoardNodeFromAST(b, arc._raw)
  for (const v of vias) {
    const form = viaFileForm(v.type ?? 'through', v.layers ?? options.copper, options.copper)
    addViaToBoardAST(b, {
      position: { x: mmToNm(v.x), y: mmToNm(-v.y) },
      size: mmToNm(v.size),
      drill: mmToNm(v.drill),
      layers: form.layers,
      net,
      ...(form.type ? { type: form.type } : {})
    })
  }
}
