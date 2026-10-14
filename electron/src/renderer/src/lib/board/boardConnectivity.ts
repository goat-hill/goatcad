/**
 * Board connectivity engine — which copper is electrically joined, and the
 * airwires (ratsnest) spanning what is not.
 *
 * Derived entirely from the board + spatial index: per net, items that touch
 * (edge separation ≤ CONNECT_EPSILON on a shared copper layer) merge into
 * clusters via union-find; zone fills join clusters without spawning anchors
 * of their own; each net with clusters left over gets minimum-spanning
 * airwires between its clusters' nearest anchor pairs. Coordinates are the
 * index's y-up world space throughout.
 *
 * KiCad semantics are the contract (a KiCad-routed board must read as
 * identically connected): touch means shape collision — a track ending
 * mid-segment on another same-net track connects; different layers never
 * connect except through the copper (vias, through-pads) that spans them.
 * A board graphic on copper conducts too (`drawingItems.ts`): it clusters
 * with its net's copper and its connection points are ratsnest anchors.
 */

import { allZones, type KicadBoard, type KicadBoardZone } from '../kicad/board'
import {
  segmentToShape,
  shapeOn,
  shapeToShape,
  snapPointsOf,
  type BoardSpatialIndex,
  type CopperItem,
  type CopperItemRef,
  type CopperShape,
  type Pt
} from './spatialIndex'
import { YStripes } from '../geometry/yStripes'
import { distanceToSegment } from '../geometry/distance'
import { isCopperLayer } from '../kicad/layers'
import { nm, nmToMm } from '../kicad/coordinates'
import { parseFlag } from '../kicad/footprint'
import { findChild, getAtomValues, type SExprNode } from '../kicad/sexpr'
import { drawingItems, type DrawingSet } from './drawingItems'

/**
 * Touch tolerance (mm). The DOMAIN is exact integer nanometers now, but this
 * engine works in the index's world-mm floats — placement transforms divide
 * by 1e6 and rotate, so touching copper can still sit a few ulps apart here.
 * 0.1 µm is far below manufacturable copper and far above that float noise.
 * (Going exact would mean an nm-native index — a named follow-up, not this.)
 */
export const CONNECT_EPSILON = 1e-4

/** What an airwire endpoint lands on — indexed copper, or a zone's outline. */
export type AirwireRef = CopperItemRef | { type: 'zone'; index: number }

export interface Airwire {
  net: number
  from: Pt
  to: Pt
  /** The items whose anchors the wire spans (for highlight/cross-probe). */
  fromRef: AirwireRef
  toRef: AirwireRef
}

/** One island of a zone's stored fill, as KiCad's DRC reads it (`FillIsolatedIslandsMap`). */
export interface ZoneIsland {
  zoneIndex: number
  /** Its index in the zone's `filledPolys`. */
  polyIndex: number
  /** No pad is in its cluster: dead copper (KiCad isolated_copper). */
  orphaned: boolean
  /** Copper of its net that touches it directly — items and other islands. */
  connections: number
}

export interface NetConnectivity {
  net: number
  /** Electrically distinct islands of copper on this net. */
  clusterCount: number
  /** Cluster ordinal per member item id (index into `BoardSpatialIndex.items`). */
  clusterOfItem: Map<number, number>
  airwires: Airwire[]
  islands: ZoneIsland[]
  /** Each cluster's anchors: only for a `detached` compute, which the drag ratsnest builds on. */
  clusters?: Anchor[][]
}

/** A point an airwire may end on, and the copper it belongs to. */
export interface Anchor {
  p: Pt
  ref: AirwireRef
}

export interface BoardConnectivity {
  nets: Map<number, NetConnectivity>
  /** Every net's airwires, flattened for display. */
  airwires: Airwire[]
  /** Total missing connections (Σ per net: clusters − 1). */
  unrouted: number
}

/**
 * The cluster, as `clusterOfItem` numbers it, that an airwire's end lands
 * in; undefined for a zone's. A copper drawing's id follows the index's items
 * (`drawingItems.ts`).
 */
export function clusterOfRef(
  conn: NetConnectivity,
  index: BoardSpatialIndex,
  ref: AirwireRef
): number | undefined {
  if (ref.type === 'zone') return undefined
  if (ref.type === 'drawing') return conn.clusterOfItem.get(index.items.length + ref.index)
  for (const id of conn.clusterOfItem.keys()) {
    const item = index.items[id]
    if (
      item?.ref.type === ref.type &&
      item.ref.index === ref.index &&
      (item.ref.type !== 'pad' || ref.type !== 'pad' || item.ref.pad === ref.pad)
    )
      return conn.clusterOfItem.get(id)
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Union-find
// ---------------------------------------------------------------------------

class UnionFind {
  private parent: number[]

  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i)
  }

  find(i: number): number {
    let root = i
    while (this.parent[root] !== root) root = this.parent[root]
    while (this.parent[i] !== root) {
      const next = this.parent[i]
      this.parent[i] = root
      i = next
    }
    return root
  }

  union(a: number, b: number): void {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra !== rb) this.parent[ra] = rb
  }
}

// ---------------------------------------------------------------------------
// Zones as connectors
// ---------------------------------------------------------------------------

/** A zone's stored fills, converted once to world space (y negated). */
export interface ZoneFill {
  net: number
  layer: string
  points: Pt[]
  /** Y-stripe edge index over `points` — every containment/edge probe against
   *  a fill goes through it; the raw ring is O(V) per probe and fills are the
   *  largest rings on the board by far. */
  stripes: YStripes
  minX: number
  minY: number
  maxX: number
  maxY: number
  zoneIndex: number
  polyIndex: number
}

/** A fill ring (world mm, y up) as connectivity probes it. */
export function connectFill(
  points: Pt[],
  net: number,
  layer: string,
  zoneIndex = -1,
  polyIndex = -1
): ZoneFill {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of points) {
    minX = Math.min(minX, p.x)
    minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x)
    maxY = Math.max(maxY, p.y)
  }
  return {
    net,
    layer,
    points,
    stripes: new YStripes(points),
    minX,
    minY,
    maxX,
    maxY,
    zoneIndex,
    polyIndex
  }
}

/** One zone's fills — the per-zone unit the cooperative generator chunks on. */
function zoneFillsOf(zone: KicadBoardZone, zoneIndex: number): ZoneFill[] {
  const fills: ZoneFill[] = []
  if (zone.isKeepout || !zone.net || zone.net <= 0) return fills
  for (let polyIndex = 0; polyIndex < zone.filledPolys.length; polyIndex++) {
    const poly = zone.filledPolys[polyIndex]
    const layer = poly.layer ?? zone.layers[0]
    if (!layer || !isCopperLayer(layer)) continue
    const points = poly.points.map((p) => ({ x: nmToMm(p.x), y: -nmToMm(p.y) }))
    if (points.length < 3) continue
    fills.push(connectFill(points, zone.net, layer, zoneIndex, polyIndex))
  }
  return fills
}

/**
 * Whether an item touches a fill polygon: a probe point inside the ring, or
 * the item's shape within epsilon of the ring's boundary. Both tests are
 * needed — a thermal-relief pad sits in a hole of the fill with only spokes
 * overlapping its outline, so containment alone reads every thermal pad as
 * disconnected; a small item swallowed whole by the pour never crosses the
 * boundary, so the edge test alone misses it.
 */
export function itemTouchesFill(
  item: CopperItem,
  fill: ZoneFill,
  anchors: readonly Pt[] = snapPointsOf(item)
): boolean {
  if (!item.layers.includes(fill.layer)) return false
  if (
    item.maxX < fill.minX ||
    item.minX > fill.maxX ||
    item.maxY < fill.minY ||
    item.minY > fill.maxY
  ) {
    return false
  }
  // KiCad's `checkZoneItemConnection`: an anchor in the fill, else the copper meeting it.
  const probes = [...anchors]
  const s = shapeOn(item, fill.layer)
  if (s.kind === 'capsule') probes.push({ x: (s.x0 + s.x1) / 2, y: (s.y0 + s.y1) / 2 })
  if (probes.some((p) => fill.stripes.contains(p))) return true

  return fill.stripes.someEdgeInYRange(
    item.minY - CONNECT_EPSILON,
    item.maxY + CONNECT_EPSILON,
    (a, b) => {
      if (
        Math.max(a.x, b.x) < item.minX - CONNECT_EPSILON ||
        Math.min(a.x, b.x) > item.maxX + CONNECT_EPSILON
      ) {
        return false
      }
      return segmentToShape(s, a.x, a.y, b.x, b.y, 0) <= CONNECT_EPSILON
    }
  )
}

/**
 * KiCad's zone-to-pad/via rule (`CN_VISITOR::checkZoneItemConnection`): a via
 * or pad that drops its unused layers is only conditionally flashed away from
 * the ends it keeps, and there a `zone_layer_connections` list — which the
 * filler writes — names the only layers a zone may join it on.
 */
export function zoneMayConnect(board: KicadBoard, ref: CopperItemRef, layer: string): boolean {
  let raw: SExprNode
  let ends: string[]
  if (ref.type === 'via') {
    const via = board.vias[ref.index]
    raw = via._raw
    ends = [via.layers[0], via.layers[via.layers.length - 1]]
  } else if (ref.type === 'pad') {
    raw = board.footprints[ref.index].footprint.pads[ref.pad]._raw
    const copper = board.layers.filter((l) => isCopperLayer(l.name)).map((l) => l.name)
    ends = [copper[0], copper[copper.length - 1]]
  } else return true
  if (raw.type !== 'list') return true
  const startEndOnly = parseFlag(raw, 'start_end_only')
  if (!startEndOnly && !parseFlag(raw, 'remove_unused_layers')) return true
  if ((startEndOnly || parseFlag(raw, 'keep_end_layers')) && ends.includes(layer)) return true
  const listed = findChild(raw, 'zone_layer_connections')
  return !listed || getAtomValues(listed).includes(layer)
}

/**
 * KiCad's `PCB_VIA::FlashLayer`: whether a via has a ring on a layer. A via
 * marked `remove_unused_layers` has one only at its ends (with
 * `keep_end_layers`), on the layers its `zone_layer_connections` name, and
 * where a track, pad or via of its net that connectivity joins to it — on any
 * layer — spans this one (`CONNECTIVITY_DATA::IsConnectedOnLayer` asks where
 * the other item is, not where they meet); zones do not flash it.
 * `layersOf` is every layer an item may have copper on (a plated pad's hole
 * passes them all). Shared by DRC and the Gerber writer.
 */
export function viaFlashedOn(
  board: KicadBoard,
  index: BoardSpatialIndex,
  item: CopperItem,
  layer: string,
  layersOf: (item: CopperItem) => readonly string[]
): boolean {
  if (item.ref.type !== 'via') return true
  const via = board.vias[item.ref.index]
  const raw = via._raw
  const ends = [via.layers[0], via.layers[via.layers.length - 1]]
  if (parseFlag(raw, 'start_end_only')) return ends.includes(layer)
  if (!parseFlag(raw, 'remove_unused_layers')) return true
  if (parseFlag(raw, 'keep_end_layers') && ends.includes(layer)) return true
  const forced = findChild(raw, 'zone_layer_connections')
  if (forced && getAtomValues(forced).includes(layer)) return true
  if (item.net <= 0) return false
  return index
    .query(item.minX, item.minY, item.maxX, item.maxY)
    .some(
      (other) =>
        other.id !== item.id &&
        other.net === item.net &&
        layersOf(other).includes(layer) &&
        (other.ref.type === 'via'
          ? viasJoin(board, item, other)
          : itemsConnect(board, item, other).length > 0)
    )
}

/**
 * Whether two vias join as KiCad's connectivity joins them for a ring's
 * flash: their copper overlapping on a layer they share, strictly — rings that
 * only touch, or miss by a hair the connectivity tolerance would bridge, do not.
 */
function viasJoin(board: KicadBoard, a: CopperItem, b: CopperItem): boolean {
  if (a.ref.type !== 'via' || b.ref.type !== 'via') return false
  const va = board.vias[a.ref.index]
  const vb = board.vias[b.ref.index]
  const apart = nmToMm(nm(Math.hypot(va.position.x - vb.position.x, va.position.y - vb.position.y)))
  return a.layers.some((layer) => {
    if (!b.layers.includes(layer)) return false
    const ra = connectShape(board, a, layer)
    const rb = connectShape(board, b, layer)
    const radius = (shape: CopperShape): number => (shape.kind === 'circle' ? shape.r : 0)
    return apart < radius(ra) + radius(rb)
  })
}

/**
 * The copper an item connects with on one layer (`CN_VISITOR`, which collides
 * items layer by layer). A via that drops its unused layers is only its hole
 * on a layer where it is conditionally flashed — every layer, or every layer
 * but its ends with `keep_end_layers` or `start_end_only` — so a track there
 * joins it only by reaching the hole. Anything else is its indexed copper.
 */
export function connectShape(board: KicadBoard, item: CopperItem, layer: string): CopperShape {
  const shape = shapeOn(item, layer)
  if (item.ref.type !== 'via' || shape.kind !== 'circle') return shape
  const via = board.vias[item.ref.index]
  const raw = via._raw
  const ends = [via.layers[0], via.layers[via.layers.length - 1]]
  const startEndOnly = parseFlag(raw, 'start_end_only')
  if (!startEndOnly && !parseFlag(raw, 'remove_unused_layers')) return shape
  if ((startEndOnly || parseFlag(raw, 'keep_end_layers')) && ends.includes(layer)) return shape
  return { kind: 'circle', cx: shape.cx, cy: shape.cy, r: nmToMm(via.drill) / 2 }
}

/** Whether two items' copper meets on a layer they share, as connectivity reads it. */
export function itemsConnect(board: KicadBoard, a: CopperItem, b: CopperItem): string[] {
  const shared = a.layers.filter((layer) => b.layers.includes(layer))
  if (shared.length === 0) return []
  // One shape on every layer: one test answers them all.
  const plain = a.ref.type !== 'via' && b.ref.type !== 'via' && !a.shapes && !b.shapes
  if (plain) return shapeToShape(a.shape, b.shape) <= CONNECT_EPSILON ? shared : []
  return shared.filter(
    (layer) =>
      shapeToShape(connectShape(board, a, layer), connectShape(board, b, layer)) <= CONNECT_EPSILON
  )
}

/**
 * Whether a point is on a fill, its boundary included — KiCad's
 * `CN_ZONE_LAYER::ContainsPoint`, which joins two islands that share a vertex.
 */
export function fillHasPoint(fill: ZoneFill, p: Pt): boolean {
  if (p.x < fill.minX || p.x > fill.maxX || p.y < fill.minY || p.y > fill.maxY) return false
  if (fill.stripes.contains(p)) return true
  return fill.stripes.someEdgeInYRange(
    p.y - CONNECT_EPSILON,
    p.y + CONNECT_EPSILON,
    (a, b) => distanceToSegment(p, a, b) <= CONNECT_EPSILON
  )
}

/**
 * The jumpers a pad is joined by inside its footprint, as keys shared with
 * the pads it joins (KiCad 10's `updateJumperPads`): each group of
 * `(jumper_pad_groups ("1" "2") …)`, and with `(duplicate_pad_numbers_are_jumpers
 * yes)` every pad sharing its number.
 */
function jumpersOf(board: KicadBoard): (item: CopperItem) => readonly string[] {
  const byFootprint = new Map<number, Map<string, string[]>>()
  const keysOf = (fp: number): Map<string, string[]> => {
    let keys = byFootprint.get(fp)
    if (keys) return keys
    keys = new Map()
    byFootprint.set(fp, keys)
    const footprint = board.footprints[fp].footprint
    const raw = footprint._raw
    if (raw.type !== 'list') return keys
    const join = (number: string, key: string): void => {
      const list = keys!.get(number)
      if (list) list.push(key)
      else keys!.set(number, [key])
    }
    findChild(raw, 'jumper_pad_groups')?.children.forEach((group, g) => {
      if (group.type !== 'list') return
      for (const pad of group.children) if (pad.type === 'atom') join(pad.value, `${fp}:${g}`)
    })
    if (parseFlag(raw, 'duplicate_pad_numbers_are_jumpers'))
      for (const number of new Set(footprint.pads.map((pad) => pad.number)))
        join(number, `${fp}:#${number}`)
    return keys
  }
  return (item) => {
    if (item.ref.type !== 'pad') return []
    const pad = board.footprints[item.ref.index].footprint.pads[item.ref.pad]
    return keysOf(item.ref.index).get(pad.number) ?? []
  }
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

const sharesLayer = (a: CopperItem, b: CopperItem): boolean =>
  a.layers.some((layer) => b.layers.includes(layer))

/** The index's copper and the board graphics beside it, by id and by box. */
interface Copper {
  item(id: number): CopperItem
  query(minX: number, minY: number, maxX: number, maxY: number): CopperItem[]
  /** Where an item connects: a graphic's own points, else its snap points. */
  anchors(item: CopperItem): readonly Pt[]
}

function copperOf(index: BoardSpatialIndex, drawings: DrawingSet): Copper {
  return {
    item: (id) => index.items[id] ?? drawings.byId(id)!,
    query: (minX, minY, maxX, maxY) => [
      ...index.query(minX, minY, maxX, maxY),
      ...drawings.query(minX, minY, maxX, maxY).filter((d) => d.connected)
    ],
    anchors: (item) => drawings.byId(item.id)?.anchors ?? snapPointsOf(item)
  }
}

/** Connectivity of one net's items (ids into `index.items`, then its graphics) + fills. */
function computeNet(
  net: number,
  itemIds: number[],
  index: Copper,
  fills: ZoneFill[],
  mayConnect: (item: CopperItem, layer: string) => boolean,
  connect: (a: CopperItem, b: CopperItem) => boolean,
  jumpered: (item: CopperItem) => readonly string[],
  keepClusters = false
): NetConnectivity {
  // Nodes 0..n-1 are items; n..n+f-1 are this net's zone fills.
  const netFills = fills.filter((f) => f.net === net)
  const n = itemIds.length
  const uf = new UnionFind(n + netFills.length)
  const nodeOfId = new Map<number, number>()
  itemIds.forEach((id, node) => nodeOfId.set(id, node))

  for (let i = 0; i < n; i++) {
    const item = index.item(itemIds[i])
    const candidates = index.query(
      item.minX - CONNECT_EPSILON,
      item.minY - CONNECT_EPSILON,
      item.maxX + CONNECT_EPSILON,
      item.maxY + CONNECT_EPSILON
    )
    for (const other of candidates) {
      const j = nodeOfId.get(other.id)
      // Each unordered pair once; the id order also skips self.
      if (j === undefined || other.id <= item.id) continue
      if (uf.find(i) === uf.find(j)) continue
      if (!sharesLayer(item, other)) continue
      if (connect(item, other)) uf.union(i, j)
    }
  }

  // Pads a footprint jumpers join wherever they lie.
  const jumperNode = new Map<string, number>()
  for (let i = 0; i < n; i++) {
    for (const key of jumpered(index.item(itemIds[i]))) {
      const j = jumperNode.get(key)
      if (j === undefined) jumperNode.set(key, i)
      else uf.union(i, j)
    }
  }

  const connections = new Array<number>(netFills.length).fill(0)
  netFills.forEach((fill, f) => {
    for (let i = 0; i < n; i++) {
      const item = index.item(itemIds[i])
      if (itemTouchesFill(item, fill, index.anchors(item)) && mayConnect(item, fill.layer)) {
        uf.union(i, n + f)
        connections[f]++
      }
    }
    // Overlapping same-net fills join each other (probe: any vertex inside).
    // Every pair is probed, joined or not, so each island's count is exact.
    for (let g = 0; g < f; g++) {
      const other = netFills[g]
      if (fill.layer !== other.layer) continue
      if (
        fill.maxX < other.minX ||
        fill.minX > other.maxX ||
        fill.maxY < other.minY ||
        fill.minY > other.maxY
      ) {
        continue
      }
      if (
        fill.points.some((p) => fillHasPoint(other, p)) ||
        other.points.some((p) => fillHasPoint(fill, p))
      ) {
        uf.union(n + f, n + g)
        connections[f]++
        connections[g]++
      }
    }
  })

  // Roots → dense cluster ordinals, items first so every cluster that has
  // real copper anchors is keyed by it.
  const clusterOfRoot = new Map<number, number>()
  const clusterOfItem = new Map<number, number>()
  const anchorsOf: Array<Array<{ p: Pt; ref: AirwireRef }>> = []
  for (let i = 0; i < n; i++) {
    const root = uf.find(i)
    let cluster = clusterOfRoot.get(root)
    if (cluster === undefined) {
      cluster = anchorsOf.length
      clusterOfRoot.set(root, cluster)
      anchorsOf.push([])
    }
    clusterOfItem.set(itemIds[i], cluster)
    const item = index.item(itemIds[i])
    for (const p of index.anchors(item)) anchorsOf[cluster].push({ p, ref: item.ref })
  }
  // A cluster of zone copper alone is not in the ratsnest, however many
  // islands it joins, as in KiCad's DRC (a full connectivity build gives zone
  // islands no anchors): nothing on it needs connecting, and an island no pad
  // reaches is `isolated_copper`'s to report.
  const spanned = anchorsOf.filter((anchors) => anchors.length > 0)

  // KiCad's orphaned cluster: one no pad belongs to.
  const padded = new Set<number>()
  for (let i = 0; i < n; i++) if (index.item(itemIds[i]).ref.type === 'pad') padded.add(uf.find(i))
  const islands = netFills.map((fill, f) => ({
    zoneIndex: fill.zoneIndex,
    polyIndex: fill.polyIndex,
    orphaned: !padded.has(uf.find(n + f)),
    connections: connections[f]
  }))

  return {
    net,
    clusterCount: spanned.length,
    clusterOfItem,
    airwires: spanningAirwires(net, spanned),
    islands,
    ...(keepClusters ? { clusters: spanned } : {})
  }
}

/**
 * Minimum-spanning airwires between clusters: Prim over the complete cluster
 * graph, edge weight = nearest anchor pair. O(k² · a·b) pairwise distances —
 * fine at real cluster counts (an unrouted net of k pads is k clusters of one
 * anchor each); revisit with a spatial prune if profiling says otherwise.
 */
function spanningAirwires(
  net: number,
  anchorsOf: Array<Array<{ p: Pt; ref: AirwireRef }>>
): Airwire[] {
  return spanningPairs(anchorsOf).map(([a, b]) => ({
    net,
    from: a.p,
    to: b.p,
    fromRef: a.ref,
    toRef: b.ref
  }))
}

/** The anchor pairs of the minimum spanning tree over `anchorsOf`'s clusters (see above). */
export function spanningPairs<A extends { p: Pt }>(
  anchorsOf: ReadonlyArray<readonly A[]>
): Array<[A, A]> {
  return spanningEdges(anchorsOf).map((edge) => edge.pair)
}

/** One spanning-tree edge: the clusters it joins, its anchor pair and its length. */
interface SpanningEdge<A> {
  from: number
  to: number
  pair: [A, A]
  d: number
}

function spanningEdges<A extends { p: Pt }>(
  anchorsOf: ReadonlyArray<readonly A[]>
): Array<SpanningEdge<A>> {
  const k = anchorsOf.length
  if (k < 2) return []
  const inTree = new Array<boolean>(k).fill(false)
  const bestDist = new Array<number>(k).fill(Infinity)
  const bestPair = new Array<[A, A] | null>(k).fill(null)
  const bestFrom = new Array<number>(k).fill(-1)
  inTree[0] = true
  const pairs: Array<SpanningEdge<A>> = []

  const relax = (from: number): void => {
    for (let to = 0; to < k; to++) {
      if (inTree[to]) continue
      for (const a of anchorsOf[from]) {
        for (const b of anchorsOf[to]) {
          const d = Math.hypot(a.p.x - b.p.x, a.p.y - b.p.y)
          if (d < bestDist[to]) {
            bestDist[to] = d
            bestPair[to] = [a, b]
            bestFrom[to] = from
          }
        }
      }
    }
  }

  relax(0)
  for (let added = 1; added < k; added++) {
    let next = -1
    for (let c = 0; c < k; c++) {
      if (!inTree[c] && (next === -1 || bestDist[c] < bestDist[next])) next = c
    }
    if (next === -1 || !bestPair[next]) break
    inTree[next] = true
    pairs.push({ from: bestFrom[next], to: next, pair: bestPair[next]!, d: bestDist[next] })
    relax(next)
  }
  return pairs
}

/**
 * Full-board connectivity as a cooperative generator: yields progress (0–1)
 * between work units — per zone while converting fills, per net while
 * clustering — so a caller can drive it under a frame budget and the compute
 * never lands as one long task. `nets` restricts the recompute (the dynamic
 * ratsnest path: a drag re-derives only the dragged items' nets); omitted, it
 * computes every net present on the copper. `detached` copper connects to
 * nothing outside itself, fills included: the board as it will be once a
 * drag has pulled it off what stays put.
 */
export function* computeConnectivitySteps(
  board: KicadBoard,
  index: BoardSpatialIndex,
  nets?: ReadonlySet<number>,
  detached?: (ref: AirwireRef) => boolean
): Generator<number, BoardConnectivity> {
  const idsByNet = new Map<number, number[]>()
  const drawings = drawingItems(board, index)
  const copper = copperOf(index, drawings)
  const conducting = drawings.items.filter((d) => d.connected)
  for (const item of [...index.items, ...conducting]) {
    if (item.net <= 0) continue
    if (nets && !nets.has(item.net)) continue
    const ids = idsByNet.get(item.net)
    if (ids) ids.push(item.id)
    else idsByNet.set(item.net, [item.id])
  }

  // Fill conversion (world-space points + stripe indices) is O(total fill
  // vertices) — on a dense board that alone outweighs many nets.
  const FILL_PHASE = 0.3
  const fills: ZoneFill[] = []
  const zones = allZones(board)
  for (let z = 0; z < zones.length; z++) {
    const zone = zones[z]
    if (!nets || (zone.net !== undefined && nets.has(zone.net))) fills.push(...zoneFillsOf(zone, z))
    yield (FILL_PHASE * (z + 1)) / zones.length
  }
  if (!nets) {
    // A net that exists only as zone copper still clusters, for its islands.
    for (const fill of fills) {
      if (!idsByNet.has(fill.net)) idsByNet.set(fill.net, [])
    }
  }

  const result: BoardConnectivity = { nets: new Map(), airwires: [], unrouted: 0 }
  const jumpered = jumpersOf(board)
  let done = 0
  for (const [net, itemIds] of idsByNet) {
    const netConn = computeNet(
      net,
      itemIds,
      copper,
      fills,
      (item, layer) => !detached?.(item.ref) && zoneMayConnect(board, item.ref, layer),
      (a, b) =>
        (!detached || detached(a.ref) === detached(b.ref)) && itemsConnect(board, a, b).length > 0,
      jumpered,
      !!detached
    )
    result.nets.set(net, netConn)
    result.airwires.push(...netConn.airwires)
    result.unrouted += netConn.clusterCount > 0 ? netConn.clusterCount - 1 : 0
    yield FILL_PHASE + ((1 - FILL_PHASE) * ++done) / idsByNet.size
  }
  return result
}

/** One-shot form: drains `computeConnectivitySteps` synchronously. */
export function computeConnectivity(
  board: KicadBoard,
  index: BoardSpatialIndex,
  nets?: ReadonlySet<number>,
  detached?: (ref: AirwireRef) => boolean
): BoardConnectivity {
  const gen = computeConnectivitySteps(board, index, nets, detached)
  let step = gen.next()
  while (!step.done) step = gen.next()
  return step.value
}

// ---------------------------------------------------------------------------
// Live-drag support (the dynamic ratsnest)
// ---------------------------------------------------------------------------

/**
 * A predicate for "does this airwire endpoint ride the current drag" from the
 * editor's selection refs. Selection speaks in board items (a footprint, a
 * segment); airwires speak in copper (a pad names its owning footprint), so a
 * selected footprint claims every pad anchored on it.
 */
export function draggedRefPredicate(
  selected: ReadonlyArray<{ type: string; index: number }>
): (ref: AirwireRef) => boolean {
  const byType = new Map<string, Set<number>>()
  for (const item of selected) {
    const set = byType.get(item.type) ?? new Set<number>()
    set.add(item.index)
    byType.set(item.type, set)
  }
  return (ref) => {
    const type = ref.type === 'pad' ? 'footprint' : ref.type
    return byType.get(type)?.has(ref.index) ?? false
  }
}

/** A still cluster's anchors sorted by x, for the nearest-anchor sweep. */
interface SortedCluster {
  anchors: Anchor[]
  xs: Float64Array
}

/** One dragged net, as `dragAirwires` re-derives it each frame. */
interface DragNet {
  net: number
  /** Clusters that stay put: numbered 0..still.length-1. */
  still: SortedCluster[]
  /** Clusters riding the drag, at their start positions: numbered after `still`. */
  moving: Anchor[][]
  /**
   * The spanning edges among the still clusters and among the moving ones.
   * A drag changes no distance within either side, so by the cycle property
   * no other edge inside a side can join the tree: only edges across need
   * looking at each frame.
   */
  fixed: Array<SpanningEdge<Anchor> & { movingFrom: boolean; movingTo: boolean }>
}

/**
 * The dynamic ratsnest of a drag (KiCad's `ComputeLocalRatsnest`): the
 * dragged copper's nets with that copper pulled free of everything that stays
 * put, ready for `dragAirwires` to re-span each frame. Built once per drag —
 * and again whenever the board changes under it, a turn or a flip mid-drag.
 */
export interface DragRatsnest {
  /** The nets whose airwires this replaces while the drag is on. */
  nets: Set<number>
  parts: DragNet[]
}

export function startDragRatsnest(
  board: KicadBoard,
  index: BoardSpatialIndex,
  isDragged: (ref: AirwireRef) => boolean
): DragRatsnest {
  const nets = new Set<number>()
  for (const item of index.items) if (item.net > 0 && isDragged(item.ref)) nets.add(item.net)
  if (nets.size === 0) return { nets, parts: [] }
  const conn = computeConnectivity(board, index, nets, isDragged)
  const parts: DragNet[] = []
  for (const [net, netConn] of conn.nets) {
    // Detached, a cluster is all dragged copper or none.
    const clusters = netConn.clusters ?? []
    const stillAnchors = clusters.filter((c) => !isDragged(c[0].ref))
    const moving = clusters.filter((c) => isDragged(c[0].ref))
    const still = stillAnchors.map((anchors) => {
      const sorted = [...anchors].sort((a, b) => a.p.x - b.p.x)
      return { anchors: sorted, xs: Float64Array.from(sorted, (a) => a.p.x) }
    })
    const offset = still.length
    parts.push({
      net,
      still,
      moving,
      fixed: [
        ...spanningEdges(stillAnchors).map((e) => ({ ...e, movingFrom: false, movingTo: false })),
        ...spanningEdges(moving).map((e) => ({
          ...e,
          from: e.from + offset,
          to: e.to + offset,
          movingFrom: true,
          movingTo: true
        }))
      ]
    })
  }
  return { nets, parts }
}

/**
 * The nearest anchor of a still cluster to `(x, y)`, closer than `best`: a
 * binary search on x, then outward both ways until the x gap alone exceeds
 * the best distance (KiCad's `NearestBicoloredPair` sweep).
 */
function nearestIn(
  cluster: SortedCluster,
  x: number,
  y: number,
  best: number
): { anchor: Anchor; d: number } | null {
  const { xs, anchors } = cluster
  let lo = 0
  let hi = xs.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (xs[mid] < x) lo = mid + 1
    else hi = mid
  }
  let found: { anchor: Anchor; d: number } | null = null
  const visit = (i: number): boolean => {
    if (Math.abs(xs[i] - x) > best) return false
    const a = anchors[i]
    const d = Math.hypot(a.p.x - x, a.p.y - y)
    if (d < best) {
      best = d
      found = { anchor: a, d }
    }
    return true
  }
  for (let i = lo; i < xs.length && visit(i); i++);
  for (let i = lo - 1; i >= 0 && visit(i); i--);
  return found
}

/**
 * A drag's airwires with its copper moved by `(dx, dy)`, scene space:
 * re-spanned every frame, so each moving cluster's wire lands on whatever
 * copper of its net is nearest now, as KiCad's does. Per frame the work is a
 * sweep per moving anchor and still cluster, plus a Kruskal over a few edges.
 */
export function dragAirwires(drag: DragRatsnest, dx: number, dy: number): Airwire[] {
  const out: Airwire[] = []
  const shift = (p: Pt): Pt => ({ x: p.x + dx, y: p.y + dy })
  for (const part of drag.parts) {
    const offset = part.still.length
    const edges: Array<{
      from: number
      to: number
      pair: [Anchor, Anchor]
      d: number
      movingFrom: boolean
      movingTo: boolean
    }> = [...part.fixed]
    part.moving.forEach((anchors, m) => {
      part.still.forEach((cluster, s) => {
        let best = Infinity
        let pair: [Anchor, Anchor] | null = null
        for (const a of anchors) {
          const hit = nearestIn(cluster, a.p.x + dx, a.p.y + dy, best)
          if (hit) {
            best = hit.d
            pair = [a, hit.anchor]
          }
        }
        if (pair)
          edges.push({ from: offset + m, to: s, pair, d: best, movingFrom: true, movingTo: false })
      })
    })
    edges.sort((a, b) => a.d - b.d)
    const uf = new UnionFind(offset + part.moving.length)
    for (const edge of edges) {
      if (uf.find(edge.from) === uf.find(edge.to)) continue
      uf.union(edge.from, edge.to)
      const [a, b] = edge.pair
      out.push({
        net: part.net,
        from: edge.movingFrom ? shift(a.p) : a.p,
        to: edge.movingTo ? shift(b.p) : b.p,
        fromRef: a.ref,
        toRef: b.ref
      })
    }
  }
  return out
}

/**
 * The dragged selection's airwires, endpoints translated by the live drag
 * delta (scene space, y up). Rigid translation, recomputed per frame by the
 * caller — nearest-anchor re-derivation waits for a measured need; KiCad's
 * dynamic ratsnest is similarly a cheap rubber band, not a re-MST.
 */
export function translateAirwires(
  airwires: readonly Airwire[],
  isDragged: (ref: AirwireRef) => boolean,
  dx: number,
  dy: number
): Airwire[] {
  if (dx === 0 && dy === 0) return [...airwires]
  return airwires.map((wire) => {
    const fromDragged = isDragged(wire.fromRef)
    const toDragged = isDragged(wire.toRef)
    if (!fromDragged && !toDragged) return wire
    return {
      ...wire,
      from: fromDragged ? { x: wire.from.x + dx, y: wire.from.y + dy } : wire.from,
      to: toDragged ? { x: wire.to.x + dx, y: wire.to.y + dy } : wire.to
    }
  })
}
