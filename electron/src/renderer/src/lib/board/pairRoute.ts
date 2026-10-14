/**
 * The route-a-pair tool's steps (docs/router-behavior.md PR1–PR6), shared by
 * the editor's `6` and an agent's pair session (`routeAgentTools.ts`): where a
 * pair starts, what a click lays, what Backspace takes back and what lands.
 * The engine is `router/diffPair.ts`; this is the tool round it, scene mm.
 */
import { addSegmentToBoardAST, addViaToBoardAST, getNetName, type KicadBoard } from '../kicad/board'
import { isCopperLayer } from '../kicad/layers'
import { mmToNm } from '../kicad/coordinates'
import { shapeCenter, type BoardSpatialIndex, type CopperItem, type Pt } from './spatialIndex'
import {
  DiffPairSession,
  padFan,
  type PairPrimitive,
  type PairProposal,
  type PairRequest,
  type PairViaSpec,
  type PrimitivePair
} from './router/diffPair'
import { matchDiffPair } from './rules/diffPairs'
import { applyRouterDelta } from './routeLanding'
import type { ShoveDelta } from './router/shove'
import type { LayerPair } from './viaPlacement'

/** One half's laid segment, scene mm. */
export interface PairSegment {
  x0: number
  y0: number
  x1: number
  y1: number
  width: number
  layer: string
  violation?: boolean
}

/** A pair drawn so far: each half's laid segments, its vias and its click stops. */
export interface PairDraft {
  nets: { p: number; n: number }
  layer: string
  /** Each half's laid segments, scene mm. */
  p: PairSegment[]
  n: PairSegment[]
  vias: Array<{
    x: number
    y: number
    size: number
    drill: number
    net: number
    layers: readonly string[]
  }>
  /** Counts before each click, for Backspace. */
  stops: Array<{ p: number; n: number; vias: number; layer: string }>
  /** `V` armed: the next click lays the head and a via pair at its end (PR5). */
  armedVia: boolean
  /** Armed by a layer key: the layer the pair goes on on past the vias; else the layer pair's other. */
  viaTarget?: string
  /** The layer when the pair began: its end hands it back, as a route's does. */
  originLayer: string
  /** The copper it started from. */
  start: PrimitivePair
}

/** The sizes a pair draws with (PR6): width, gap and the via pair's gap. */
export interface PairDimensions {
  width: number
  gap: number
  viaGap: number
}

/**
 * The pair sizes in force: typed, else a row of the project's list past the
 * first, else the first: what the rules give the pair on its layer (S13).
 */
export function pairSizesOf(
  own: { width: number; gap: number },
  list: readonly PairDimensions[],
  row: number,
  override: PairDimensions | null
): PairDimensions {
  return (
    override ??
    (row > 0 ? list[row - 1] : undefined) ?? { width: own.width, gap: own.gap, viaGap: own.gap }
  )
}

/** Copper a pair may start from (PR1): its kind, its layers, and its point — a track's loose end, null without one. */
export interface PairStartItem {
  kind: 'pad' | 'via' | 'track'
  layers: readonly string[]
  at: Pt | null
}

/**
 * The partner a pair starts with (PR1, KiCad's `FindDpPrimitivePair`): of the
 * other half's copper, the nearest of the same kind — a pad or via on the same
 * layers, a track by its loose end — however far.
 */
export function pairPartner<T extends PairStartItem>(start: T, mates: readonly T[]): T | null {
  const from = start.at
  if (!from) return null
  const sameLayers = (a: readonly string[], b: readonly string[]): boolean =>
    a.length === b.length && a.every((l) => b.includes(l))
  let best: T | null = null
  let bestD = Infinity
  for (const m of mates) {
    if (m.kind !== start.kind || !m.at) continue
    if (m.kind !== 'track' && !sameLayers(m.layers, start.layers)) continue
    const d = Math.hypot(m.at.x - from.x, m.at.y - from.y)
    if (d < bestD) {
      best = m
      bestD = d
    }
  }
  return best
}

/**
 * Copper as a pair start (PR1): a pad or via at its anchor, a track at its
 * loose end — the first end no other copper of its net meets — else none.
 */
export function pairStartItem(
  index: BoardSpatialIndex,
  item: CopperItem
): PairStartItem & { item: CopperItem } {
  const s = item.shape
  if (item.ref.type !== 'segment' && item.ref.type !== 'tarc')
    return {
      item,
      kind: item.ref.type === 'via' ? 'via' : 'pad',
      layers: item.layers,
      at: item.anchor ?? shapeCenter(s)
    }
  const loose = (p: Pt): boolean =>
    !index.near(p.x, p.y, 1e-6, { net: item.net }).some((h) => h.item.id !== item.id)
  const ends =
    s.kind === 'capsule' || s.kind === 'arc'
      ? [
          { x: s.x0, y: s.y0 },
          { x: s.x1, y: s.y1 }
        ]
      : []
  return { item, kind: 'track', layers: item.layers, at: ends.find(loose) ?? null }
}

/** A pair half's copper as the router sees it: a pad by its fan-out, a via, a track by its ends. */
function primitiveOf(item: CopperItem, layer: string): PairPrimitive {
  if (item.ref.type === 'via') return { kind: 'via', layers: item.layers }
  const s = item.shape
  if (
    (item.ref.type === 'segment' || item.ref.type === 'tarc') &&
    (s.kind === 'capsule' || s.kind === 'arc')
  )
    return { kind: 'track', a: { x: s.x0, y: s.y0 }, b: { x: s.x1, y: s.y1 } }
  return { kind: 'pad', fan: padFan(item, layer) }
}

/**
 * The pair end at a point (PR1): a pad, via or track of a net whose name is a
 * pair half, with its complement net on the board, and the complement's
 * nearest copper of the same kind (`pairPartner`, KiCad's). `layer` is the
 * routed one: the active layer where the copper has it. `onLayer` asks only
 * for copper on that layer: a pair arrives on the layer it is routed on (PR4).
 */
export function pairEndAt(
  board: KicadBoard,
  index: BoardSpatialIndex,
  point: Pt,
  activeLayer: string,
  onLayer?: string
): { pair: PrimitivePair; nets: { p: number; n: number }; layer: string } | null {
  const under = index
    .near(point.x, point.y, 0, onLayer ? { layer: onLayer } : {})
    .map((h) => h.item)
  const hit =
    under.find((item) => (item.ref.type === 'pad' || item.ref.type === 'via') && item.net > 0) ??
    under.find((item) => (item.ref.type === 'segment' || item.ref.type === 'tarc') && item.net > 0)
  if (!hit) return null
  const pair = matchDiffPair(getNetName(board, hit.net))
  const other = pair ? board.nets.find((n) => n.name === pair.complement) : undefined
  if (!pair || !other) return null
  const start = pairStartItem(index, hit)
  const mates = index.items.flatMap((item) =>
    item && item.net === other.number && item.ref.type !== 'drawing'
      ? [pairStartItem(index, item)]
      : []
  )
  const mate = pairPartner(start, mates)
  if (!mate || !start.at || !mate.at) return null
  const layer = hit.layers.includes(activeLayer)
    ? activeLayer
    : (hit.layers.find((l) => isCopperLayer(l)) ?? activeLayer)
  const positive = pair.polarity === 1
  const [pItem, nItem] = positive ? [start, mate] : [mate, start]
  return {
    pair: {
      anchorP: pItem.at!,
      anchorN: nItem.at!,
      p: primitiveOf(pItem.item, layer),
      n: primitiveOf(nItem.item, layer)
    },
    nets: { p: pItem.item.net, n: nItem.item.net },
    layer
  }
}

/**
 * PR6: the other half's track running beside a pair half's: of the
 * complement net, on its layer, parallel, within a little over the pair's
 * pitch (`pitchOf`, from the half's net name) — the coupled segment a drag
 * carries along and a pair tune meanders with.
 */
export function pairMateOf(
  board: KicadBoard,
  index: BoardSpatialIndex,
  seg: CopperItem,
  pitchOf: (netName: string) => number
): CopperItem | null {
  const s = seg.shape
  if (seg.ref.type !== 'segment' || s.kind !== 'capsule') return null
  const pair = matchDiffPair(getNetName(board, seg.net))
  const other = pair ? board.nets.find((n) => n.name === pair.complement) : undefined
  if (!other) return null
  const pitch = pitchOf(getNetName(board, seg.net))
  const ux = s.x1 - s.x0
  const uy = s.y1 - s.y0
  const len = Math.hypot(ux, uy)
  if (len < 1e-9) return null
  const mid = { x: (s.x0 + s.x1) / 2, y: (s.y0 + s.y1) / 2 }
  let best: { item: CopperItem; d: number } | null = null
  for (const h of index.near(mid.x, mid.y, pitch * 2, {
    layer: seg.layers[0],
    net: other.number
  })) {
    const o = h.item.shape
    if (h.item.ref.type !== 'segment' || o.kind !== 'capsule') continue
    const vx = o.x1 - o.x0
    const vy = o.y1 - o.y0
    if (Math.abs(ux * vy - uy * vx) > 1e-6 * len * Math.hypot(vx, vy)) continue
    // Across from it, by its line's distance.
    const d = Math.abs((o.x0 - s.x0) * uy - (o.y0 - s.y0) * ux) / len
    if (d > pitch * 1.5) continue
    if (!best || d < best.d) best = { item: h.item, d }
  }
  return best?.item ?? null
}

/** A pair begun at `found` (PR1): its session and an empty draft; `origin` is the layer to hand back. */
export function beginPair(
  session: DiffPairSession,
  found: NonNullable<ReturnType<typeof pairEndAt>>,
  origin: string
): PairDraft {
  session.begin(found.pair)
  return {
    nets: found.nets,
    layer: found.layer,
    p: [],
    n: [],
    vias: [],
    stops: [],
    armedVia: false,
    originLayer: origin,
    start: found.pair
  }
}

/** A path as segments of one width on one layer, each flagged where `flags` says it violates. */
export function pairSegments(
  path: ReadonlyArray<Pt>,
  width: number,
  layer: string,
  flags: readonly boolean[] = []
): PairSegment[] {
  return path.slice(1).map((q, i) => ({
    x0: path[i].x,
    y0: path[i].y,
    x1: q.x,
    y1: q.y,
    width,
    layer,
    ...(flags[i] ? { violation: true } : {})
  }))
}

/**
 * Where a move over `over` heads (PR4): the far end of this pair, which it
 * arrives at; never the copper it started from before anything is laid.
 */
export function pairTarget(
  over: ReturnType<typeof pairEndAt>,
  draft: PairDraft
): PrimitivePair | undefined {
  return over &&
    over.nets.p === draft.nets.p &&
    over.nets.n === draft.nets.n &&
    !(
      Math.hypot(
        over.pair.anchorP.x - draft.start.anchorP.x,
        over.pair.anchorP.y - draft.start.anchorP.y
      ) < 1e-6 && draft.p.length === 0
    )
    ? over.pair
    : undefined
}

/**
 * The via pair `V` arms (PR5): `via` at the pair's via gap, through every
 * copper layer (KiCad's through via, its default type).
 */
export function throughViaSpec(
  board: KicadBoard,
  via: { diameter: number; drill: number },
  gap: number
): PairViaSpec {
  return {
    size: via.diameter,
    drill: via.drill,
    gap,
    layers: board.layers.filter((l) => isCopperLayer(l.name)).map((l) => l.name)
  }
}

/** The pair proposed toward `cursor`, over the draft laid so far. */
export function proposePair(
  session: DiffPairSession,
  draft: PairDraft,
  req: Omit<PairRequest, 'layer' | 'nets' | 'via'>,
  target: PrimitivePair | undefined,
  via: PairViaSpec | null
): PairProposal {
  return session.propose(
    {
      ...req,
      layer: draft.layer,
      nets: draft.nets,
      ...(draft.armedVia && via ? { via } : {})
    },
    target
  )
}

/**
 * A click with a pair in hand (R18, PR5, PR6): the head laid as KiCad's
 * `FixRoute` lays it, and with a via pair at its end the pair goes on across
 * the layer pair (R40) from them. Null when nothing could be laid. The
 * answer's `layer` is the one it goes on on.
 */
export function clickPair(
  session: DiffPairSession,
  draft: PairDraft,
  proposal: PairProposal,
  req: Pick<PairRequest, 'postureFlipped' | 'sizes'>,
  layerPair: LayerPair,
  opts: { fixAll: boolean; finish?: boolean }
): PairDraft | null {
  const laid = session.fix(proposal, { ...req, layer: draft.layer, nets: draft.nets }, opts)
  if (!laid) return null
  const stop = { p: draft.p.length, n: draft.n.length, vias: draft.vias.length, layer: draft.layer }
  const next: PairDraft = {
    ...draft,
    p: [...draft.p, ...pairSegments(laid.p, req.sizes.width, draft.layer)],
    n: [...draft.n, ...pairSegments(laid.n, req.sizes.width, draft.layer)],
    stops: [...draft.stops, stop],
    armedVia: false
  }
  const v = proposal.vias
  if (v) {
    next.vias = [
      ...next.vias,
      { ...v.p, size: v.spec.size, drill: v.spec.drill, net: draft.nets.p, layers: v.spec.layers },
      { ...v.n, size: v.spec.size, drill: v.spec.drill, net: draft.nets.n, layers: v.spec.layers }
    ]
    // Across the layer pair (R40), as `V` takes a single route, or to the layer a key named.
    next.layer =
      draft.viaTarget ?? (draft.layer === layerPair.top ? layerPair.bottom : layerPair.top)
  }
  delete next.viaTarget
  return next
}

/**
 * A layer key with a pair in hand: going on from vias that span it, the
 * layer simply changes (KiCad's `SetLayer`); else the key arms a via pair to
 * it, as it arms a via mid-route (R24).
 */
export function switchPairLayer(
  session: DiffPairSession,
  draft: PairDraft,
  target: string
): PairDraft {
  if (target === draft.layer) return draft
  if (session.canSwitchTo(target)) return { ...draft, layer: target, armedVia: false }
  return { ...draft, armedVia: true, viaTarget: target }
}

/**
 * Backspace with a pair in hand (R22): the armed via pair goes, else the
 * last click with its via pair. Null when nothing was clicked: the pair ends.
 */
export function undoPair(session: DiffPairSession, draft: PairDraft): PairDraft | null {
  if (draft.armedVia) {
    const next = { ...draft, armedVia: false }
    delete next.viaTarget
    return next
  }
  const stop = draft.stops[draft.stops.length - 1]
  if (!stop) return null
  session.undoClick()
  return {
    ...draft,
    p: draft.p.slice(0, stop.p),
    n: draft.n.slice(0, stop.n),
    vias: draft.vias.slice(0, stop.vias),
    stops: draft.stops.slice(0, -1),
    layer: stop.layer
  }
}

/** Whether the draft has laid anything to land. */
export const pairLaid = (draft: PairDraft): boolean => draft.p.length > 0 || draft.n.length > 0

/** The pushes the pair made, its head dropped first: what lands with it. */
export function pairPushes(session: DiffPairSession): ShoveDelta {
  return session.pushes()
}

/** The pair written to the board, its pushes with it (R25): one undo step's body. */
export function writePair(b: KicadBoard, draft: PairDraft, pushed: ShoveDelta): void {
  applyRouterDelta(b, pushed)
  for (const [net, segs] of [
    [draft.nets.p, draft.p],
    [draft.nets.n, draft.n]
  ] as const)
    for (const s of mergeStraight(segs))
      addSegmentToBoardAST(b, {
        start: { x: mmToNm(s.x0), y: mmToNm(-s.y0) },
        end: { x: mmToNm(s.x1), y: mmToNm(-s.y1) },
        width: mmToNm(s.width),
        layer: s.layer,
        net
      })
  for (const v of draft.vias)
    addViaToBoardAST(b, {
      position: { x: mmToNm(v.x), y: mmToNm(-v.y) },
      size: mmToNm(v.size),
      drill: mmToNm(v.drill),
      layers: [v.layers[0], v.layers[v.layers.length - 1]],
      net: v.net
    })
}

/** Straight runs of one half merged, as a route's are (R26). */
export function mergeStraight(segs: readonly PairSegment[]): PairSegment[] {
  const out: PairSegment[] = []
  for (const s of segs) {
    if (Math.hypot(s.x1 - s.x0, s.y1 - s.y0) < 1e-6) continue
    const last = out[out.length - 1]
    const joins =
      last &&
      last.layer === s.layer &&
      Math.abs(last.width - s.width) < 1e-9 &&
      Math.hypot(last.x1 - s.x0, last.y1 - s.y0) < 1e-6 &&
      Math.abs((last.x1 - last.x0) * (s.y1 - s.y0) - (last.y1 - last.y0) * (s.x1 - s.x0)) <
        1e-9 *
          Math.hypot(last.x1 - last.x0, last.y1 - last.y0) *
          Math.hypot(s.x1 - s.x0, s.y1 - s.y0) &&
      (last.x1 - last.x0) * (s.x1 - s.x0) + (last.y1 - last.y0) * (s.y1 - s.y0) > 0
    if (joins) out[out.length - 1] = { ...last, x1: s.x1, y1: s.y1 }
    else out.push({ ...s })
  }
  return out
}
