// Parts follow KiCad's source, named below: Copyright The KiCad Developers, GPL-3.0-or-later.
/**
 * Creepage: the shortest way over the board's surface from the copper of one
 * net to the copper of another on a layer — the distance a leakage current
 * would creep along the laminate. KiCad 10's creepage check is the spec
 * (`drc_test_provider_creepage.cpp`); the rule module is
 * `drc/rules/creepage.ts`.
 *
 * A path is straight where it can be and bends only round the board's edges:
 * the outline's corners, and its circles and arcs — cutouts, rounded corners,
 * unplated holes. So the shortest path is found over a graph whose nodes are
 * those corners and the points where a path meets a curved edge tangentially,
 * joined by straight runs that stay on the board and by runs along the curve
 * between two such points. The copper of each net joins the graph by its
 * nearest approach to a corner, its tangents to a curve, and its nearest
 * approach to the other net's copper.
 *
 * What makes a straight run admissible is KiCad's: it crosses no edge
 * (touching one at either end is fine), its midpoint lies on the board, and —
 * for a run that leaves or reaches copper — it crosses no track's centerline
 * on the layer. Where the outline does not close, every run is admissible.
 * Grooves are not bridged (KiCad's slot handling is off by default).
 * World space: millimeters, y up.
 */
import type { KicadBoard } from '../kicad/board'
import type {
  KicadFpArc,
  KicadFpCircle,
  KicadFpLine,
  KicadFpPoly,
  KicadFpRect
} from '../kicad/footprint'
import { rectOutline } from '../kicad/footprint'
import type { Nm } from '../kicad/coordinates'
import { nmToMm } from '../kicad/coordinates'
import { EDGE_CUTS, buildBoardOutline, type OutlineRegion } from '../engine/board3d/boardOutline'
import { arcContainsMidCCW, circumscribedCircle } from '../engine/arcGeometry'
import { footprintTransform, tfPoint } from '../schematic/placement'
import { PackedRTree } from '../geometry/packedRTree'
import { padHoleShape, rrectCore, sampleArc, type CopperShape, type Pt } from './spatialIndex'

/** A piece of copper as a creepage path meets it: a segment grown by a radius (a disc when its ends meet). */
export interface CreepCopper {
  a: Pt
  b: Pt
  r: number
  /** Which item it belongs to, the caller's index. */
  item: number
}

/** A curved edge: a circle, or an arc from `start` sweeping `sweep` radians counterclockwise. */
interface Curve {
  c: Pt
  r: number
  /** Null for a whole circle. */
  arc: { start: number; sweep: number } | null
}

type EdgePiece = { kind: 'segment'; a: Pt; b: Pt } | ({ kind: 'curve' } & Curve)

/** A run's two ends need not cross an edge where they touch it: KiCad's 50 nm. */
const TOUCH = 5e-5
/** A run's midpoint this close to the board's boundary is on the board: KiCad's 100 nm. */
const ON_EDGE = 1e-4
const SAME = 1e-9
/** Two paths this close in length are as long as each other: KiCad measures in whole nanometers. */
const TIE = 1e-7

interface Node {
  p: Pt
  /** The curve it lies on, for runs along it; -1 for a corner. */
  curve: number
}

interface Link {
  to: number
  w: number
}

export interface CreepPath {
  distance: number
  /** The items it runs between, by the caller's index. */
  from: number
  to: number
  /** Where it leaves the first item's copper. */
  start: Pt
}

/**
 * A board's surface as creepage paths cross it: its edges, the region they
 * enclose, and the graph of runs between corners and curves that no copper
 * changes — built once per board, up to `limit` long.
 */
export class CreepSurface {
  private readonly edges: EdgePiece[] = []
  private readonly edgeTree: PackedRTree
  private readonly edgeBoxes: Float64Array
  private readonly corners: Pt[] = []
  private readonly cornerTree: PackedRTree
  private readonly curves: Curve[] = []
  /** The graph: corners first, then points on curves. */
  private readonly nodes: Node[] = []
  private readonly links: Link[][] = []
  /** Each curve's nodes, for runs along it. */
  private readonly onCurve: number[][] = []
  private readonly regions: OutlineRegion[]
  private readonly holes: Array<{ a: Pt; b: Pt; r: number }> = []
  /** False where the outline does not close: then every run is admissible. */
  readonly closed: boolean
  private readonly tracks = new Map<string, { tree: PackedRTree; segments: Array<[Pt, Pt]> }>()

  constructor(
    private readonly board: KicadBoard,
    private readonly limit: number
  ) {
    const outline = buildBoardOutline(board)
    this.closed = !outline.fallback && outline.openCount === 0 && outline.regions.length > 0
    this.regions = outline.regions
    this.collectEdges()
    this.edgeBoxes = new Float64Array(this.edges.length * 4)
    this.edges.forEach((edge, i) => this.edgeBoxes.set(boxOf(edge), i * 4))
    this.edgeTree = new PackedRTree(this.edgeBoxes, this.edges.length)
    for (const p of this.corners) this.addNode(p, -1)
    const cornerBoxes = new Float64Array(this.corners.length * 4)
    this.corners.forEach((p, i) => cornerBoxes.set([p.x, p.y, p.x, p.y], i * 4))
    this.cornerTree = new PackedRTree(cornerBoxes, this.corners.length)
    this.curves.forEach(() => this.onCurve.push([]))
    this.linkEdgesToEdges()
  }

  /**
   * The shortest admissible path from any of `from` to any of `to` on a layer,
   * no longer than `limit`; null when none is.
   */
  shortest(
    from: readonly CreepCopper[],
    to: readonly CreepCopper[],
    layer: string,
    limit: number,
    /** Which of two items a tie goes to: the one ranked higher. */
    rank: (item: number) => string
  ): CreepPath | null {
    const wins = (item: number, over: number): boolean => rank(item) > rank(over)
    const extraNodes: Node[] = []
    const extraLinks = new Map<number, Link[]>()
    const base = this.nodes.length
    const nodeAt = (p: Pt, curve: number): number => {
      const list = this.onCurve[curve]
      for (const id of list) {
        const q = this.nodeOf(id, extraNodes, base)
        if (Math.abs(q.p.x - p.x) < SAME && Math.abs(q.p.y - p.y) < SAME) return id
      }
      const id = base + extraNodes.length
      extraNodes.push({ p, curve })
      list.push(id)
      return id
    }
    const addedToCurve: number[] = []
    const link = (a: number, b: number, w: number): void => {
      for (const [x, y] of [
        [a, b],
        [b, a]
      ]) {
        const list = extraLinks.get(x) ?? []
        list.push({ to: y, w })
        extraLinks.set(x, list)
      }
    }

    // Where each side's copper joins the graph: by node, the shortest run and the item.
    const joins = (
      copper: readonly CreepCopper[]
    ): Map<number, { w: number; item: number; at: Pt }> => {
      const out = new Map<number, { w: number; item: number; at: Pt }>()
      const offer = (node: number, w: number, item: number, at: Pt): void => {
        const known = out.get(node)
        if (!known || w < known.w - TIE || (w <= known.w + TIE && wins(item, known.item)))
          out.set(node, { w, item, at })
      }
      // Each corner takes its nearest admissible run: candidates nearest first, the
      // admissibility test (the costly part) only until one passes and its ties.
      const candidates: Array<Array<{ w: number; item: number; s: Pt }>> = this.corners.map(
        () => []
      )
      for (const piece of copper) {
        // Nothing farther than the limit from the piece's box is reached.
        const reach = limit + piece.r
        const minX = Math.min(piece.a.x, piece.b.x) - reach
        const maxX = Math.max(piece.a.x, piece.b.x) + reach
        const minY = Math.min(piece.a.y, piece.b.y) - reach
        const maxY = Math.max(piece.a.y, piece.b.y) + reach
        this.cornerTree.search(minX, minY, maxX, maxY, (id) => {
          const run = copperToPoint(piece, this.corners[id])
          if (run && run.w <= limit) candidates[id].push({ w: run.w, item: piece.item, s: run.s })
        })
        this.curves.forEach((curve, index) => {
          if (
            curve.c.x + curve.r < minX ||
            curve.c.x - curve.r > maxX ||
            curve.c.y + curve.r < minY ||
            curve.c.y - curve.r > maxY
          )
            return
          for (const run of copperToCurve(piece, curve)) {
            if (run.w > limit || !this.admissible(run.s, run.t, layer)) continue
            const node = nodeAt(run.t, index)
            if (node >= base && !addedToCurve.includes(node)) addedToCurve.push(node)
            offer(node, run.w, piece.item, run.s)
          }
        })
      }
      candidates.forEach((list, id) => {
        list.sort((x, y) => x.w - y.w)
        let found = Infinity
        for (const run of list) {
          if (run.w > found + TIE) break
          if (!this.admissible(run.s, this.corners[id], layer)) continue
          found = Math.min(found, run.w)
          offer(id, run.w, run.item, run.s)
        }
      })
      return out
    }
    const sources = joins(from)
    const targets = joins(to)
    // New points on a curve run along it to every other point there.
    for (const id of addedToCurve) {
      const node = this.nodeOf(id, extraNodes, base)
      for (const other of this.onCurve[node.curve]) {
        if (
          other === id ||
          (other >= base && addedToCurve.indexOf(other) > addedToCurve.indexOf(id))
        )
          continue
        const w = alongCurve(
          this.curves[node.curve],
          node.p,
          this.nodeOf(other, extraNodes, base).p
        )
        if (w !== null && w <= limit) link(id, other, w)
      }
    }

    // Straight from one net's copper to the other's.
    let best: CreepPath | null = null
    /** Whether a path beats the best so far: shorter, or as short and between higher-ranked items. */
    const better = (distance: number, a: number, b: number): boolean => {
      if (!best) return true
      if (distance < best.distance - TIE) return true
      if (distance > best.distance + TIE) return false
      return b !== best.to ? wins(b, best.to) : wins(a, best.from)
    }
    const boxes = new Float64Array(to.length * 4)
    to.forEach((b, i) =>
      boxes.set(
        [
          Math.min(b.a.x, b.b.x) - b.r,
          Math.min(b.a.y, b.b.y) - b.r,
          Math.max(b.a.x, b.b.x) + b.r,
          Math.max(b.a.y, b.b.y) + b.r
        ],
        i * 4
      )
    )
    const toTree = new PackedRTree(boxes, to.length)
    for (const a of from) {
      // Only what lies within the best so far (or the limit) of this piece can beat it.
      const sofar = best as CreepPath | null
      const reach = Math.min(limit, sofar ? sofar.distance + TIE : limit) + a.r
      toTree.search(
        Math.min(a.a.x, a.b.x) - reach,
        Math.min(a.a.y, a.b.y) - reach,
        Math.max(a.a.x, a.b.x) + reach,
        Math.max(a.a.y, a.b.y) + reach,
        (i) => {
          const b = to[i]
          const run = copperToCopper(a, b)
          if (!run || run.w > limit || !better(run.w, a.item, b.item)) return
          if (!this.admissible(run.s, run.t, layer)) return
          best = { distance: run.w, from: a.item, to: b.item, start: run.s }
        }
      )
    }

    // Dijkstra over the graph, from every node the first net's copper reaches.
    const total = base + extraNodes.length
    const dist = new Float64Array(total).fill(Infinity)
    const origin = new Int32Array(total).fill(-1)
    const startAt: Pt[] = new Array(total)
    const heap = new MinHeap()
    for (const [node, join] of sources) {
      dist[node] = join.w
      origin[node] = join.item
      startAt[node] = join.at
      heap.push(node, join.w)
    }
    while (heap.size > 0) {
      const [node, d] = heap.pop()
      if (d > dist[node]) continue
      if (best && d > best.distance + TIE) break
      const target = targets.get(node)
      if (target && d + target.w <= limit && better(d + target.w, origin[node], target.item))
        best = { distance: d + target.w, from: origin[node], to: target.item, start: startAt[node] }
      const relax = (next: Link): void => {
        const nd = d + next.w
        const known = dist[next.to]
        const tie = Math.abs(nd - known) <= TIE && origin[next.to] !== origin[node]
        if ((nd < known - TIE || (tie && wins(origin[node], origin[next.to]))) && nd <= limit) {
          dist[next.to] = nd
          origin[next.to] = origin[node]
          startAt[next.to] = startAt[node]
          heap.push(next.to, nd)
        }
      }
      if (node < base) for (const next of this.links[node]) relax(next)
      for (const next of extraLinks.get(node) ?? []) relax(next)
    }
    for (const id of addedToCurve) {
      const list = this.onCurve[this.nodeOf(id, extraNodes, base).curve]
      list.splice(list.indexOf(id), 1)
    }
    return best
  }

  private nodeOf(id: number, extra: readonly Node[], base: number): Node {
    return id < base ? this.nodes[id] : extra[id - base]
  }

  private addNode(p: Pt, curve: number): number {
    if (curve >= 0) {
      for (const id of this.onCurve[curve]) {
        const q = this.nodes[id].p
        if (Math.abs(q.x - p.x) < SAME && Math.abs(q.y - p.y) < SAME) return id
      }
    }
    const id = this.nodes.length
    this.nodes.push({ p, curve })
    this.links.push([])
    if (curve >= 0) this.onCurve[curve].push(id)
    return id
  }

  private linkBase(a: number, b: number, w: number): void {
    this.links[a].push({ to: b, w })
    this.links[b].push({ to: a, w })
  }

  /** The runs between edges: corner to corner, corner to curve, curve to curve, and along each curve. */
  private linkEdgesToEdges(): void {
    const limit = this.limit
    const corners = this.corners.length
    for (let i = 0; i < corners; i++)
      for (let j = i + 1; j < corners; j++) {
        const p = this.corners[i]
        const q = this.corners[j]
        const w = Math.hypot(q.x - p.x, q.y - p.y)
        if (w <= limit && this.admissible(p, q, null)) this.linkBase(i, j, w)
      }
    this.curves.forEach((curve, index) => {
      for (let i = 0; i < corners; i++)
        for (const t of pointTangents(this.corners[i], curve)) {
          const w = Math.hypot(t.x - this.corners[i].x, t.y - this.corners[i].y)
          if (w <= limit && this.admissible(this.corners[i], t, null))
            this.linkBase(i, this.addNode(t, index), w)
        }
      for (let other = index + 1; other < this.curves.length; other++)
        for (const [s, t] of curveTangents(curve, this.curves[other])) {
          const w = Math.hypot(t.x - s.x, t.y - s.y)
          if (w <= limit && this.admissible(s, t, null))
            this.linkBase(this.addNode(s, index), this.addNode(t, other), w)
        }
    })
    // An arc's ends are corners too: the way along it reaches them.
    this.curves.forEach((curve, index) => {
      if (!curve.arc) return
      for (const angle of [curve.arc.start, curve.arc.start + curve.arc.sweep]) {
        const p = onCircle(curve, angle)
        const corner = this.corners.findIndex((q) => samePoint(q, p))
        if (corner >= 0) this.linkBase(corner, this.addNode(p, index), 0)
      }
    })
    this.curves.forEach((curve, index) => {
      const ids = this.onCurve[index]
      for (let i = 0; i < ids.length; i++)
        for (let j = i + 1; j < ids.length; j++) {
          const w = alongCurve(curve, this.nodes[ids[i]].p, this.nodes[ids[j]].p)
          if (w !== null && w <= limit) this.linkBase(ids[i], ids[j], w)
        }
    })
  }

  /**
   * Whether a straight run is admissible: it crosses no edge, its midpoint is
   * on the board, and — `layer` given, for a run from copper — it crosses no
   * track's centerline there.
   */
  private admissible(p: Pt, q: Pt, layer: string | null): boolean {
    if (!this.closed) return true
    let crosses = false
    this.edgeTree.search(
      Math.min(p.x, q.x),
      Math.min(p.y, q.y),
      Math.max(p.x, q.x),
      Math.max(p.y, q.y),
      (i) => {
        if (!crosses && edgeCrossed(this.edges[i], p, q)) crosses = true
      }
    )
    if (crosses) return false
    if (!this.onBoard({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 })) return false
    if (layer === null) return true
    const tracks = this.tracksOn(layer)
    let blocked = false
    tracks.tree.search(
      Math.min(p.x, q.x),
      Math.min(p.y, q.y),
      Math.max(p.x, q.x),
      Math.max(p.y, q.y),
      (i) => {
        if (!blocked && segmentsTouch(p, q, tracks.segments[i][0], tracks.segments[i][1]))
          blocked = true
      }
    )
    return !blocked
  }

  /** On the board, its unplated holes cut out: inside, or within KiCad's 100 nm of the boundary. */
  private onBoard(p: Pt): boolean {
    const inside = this.regions.some(
      (region) => inRing(region.outer, p) && !region.holes.some((hole) => inRing(hole, p))
    )
    if (
      !inside &&
      !this.regions.some((region) =>
        [region.outer, ...region.holes].some((ring) => ringDistance(ring, p) <= ON_EDGE)
      )
    )
      return false
    for (const hole of this.holes) {
      const d = segmentPointDistance(hole.a, hole.b, p) - hole.r
      if (d < -ON_EDGE) return false
    }
    return true
  }

  /** The track centerlines on a layer that a run from copper may not cross. */
  private tracksOn(layer: string): { tree: PackedRTree; segments: Array<[Pt, Pt]> } {
    let found = this.tracks.get(layer)
    if (!found) {
      const segments: Array<[Pt, Pt]> = this.board.segments
        .filter((seg) => seg.layer === layer)
        .map((seg) => [world(seg.start), world(seg.end)])
      const boxes = new Float64Array(segments.length * 4)
      segments.forEach(([a, b], i) =>
        boxes.set(
          [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y)],
          i * 4
        )
      )
      found = { tree: new PackedRTree(boxes, segments.length), segments }
      this.tracks.set(layer, found)
    }
    return found
  }

  /**
   * The board's edges as KiCad's creepage reads them: every Edge.Cuts line,
   * rectangle, polygon, circle and arc, the board's and its footprints' (a
   * curve on Edge.Cuts is not read), and each unplated hole's wall.
   */
  private collectEdges(): void {
    const corner = (p: Pt): void => {
      if (!this.corners.some((q) => Math.abs(q.x - p.x) < SAME && Math.abs(q.y - p.y) < SAME))
        this.corners.push(p)
    }
    const segment = (a: Pt, b: Pt): void => {
      this.edges.push({ kind: 'segment', a, b })
      corner(a)
      corner(b)
    }
    const curve = (c: Curve): void => {
      this.edges.push({ kind: 'curve', ...c })
      this.curves.push(c)
      if (c.arc) {
        corner(onCircle(c, c.arc.start))
        corner(onCircle(c, c.arc.start + c.arc.sweep))
      }
    }
    const arc3 = (a: Pt, m: Pt, b: Pt): void => {
      const circle = circumscribedCircle(a.x, a.y, m.x, m.y, b.x, b.y)
      if (!circle) {
        segment(a, b)
        return
      }
      const c = { x: circle.cx, y: circle.cy }
      const ccw = arcContainsMidCCW(a, m, b, c.x, c.y)
      const [from, to] = ccw ? [a, b] : [b, a]
      const start = Math.atan2(from.y - c.y, from.x - c.x)
      let sweep = Math.atan2(to.y - c.y, to.x - c.x) - start
      if (sweep <= 0) sweep += 2 * Math.PI
      curve({ c, r: circle.r, arc: { start, sweep } })
    }
    const read = (
      shapes: {
        lines: readonly KicadFpLine[]
        arcs: readonly KicadFpArc[]
        circles: readonly KicadFpCircle[]
        rects: readonly KicadFpRect[]
        polys: readonly KicadFpPoly[]
      },
      at: (p: { x: Nm; y: Nm }) => Pt
    ): void => {
      for (const line of shapes.lines)
        if (line.layer === EDGE_CUTS) segment(at(line.start), at(line.end))
      for (const arc of shapes.arcs)
        if (arc.layer === EDGE_CUTS) arc3(at(arc.start), at(arc.mid), at(arc.end))
      for (const circle of shapes.circles) {
        if (circle.layer !== EDGE_CUTS) continue
        const c = at(circle.center)
        const e = at(circle.end)
        const r = Math.hypot(e.x - c.x, e.y - c.y)
        if (r > 0) curve({ c, r, arc: null })
      }
      for (const rect of shapes.rects) {
        if (rect.layer !== EDGE_CUTS) continue
        const outline = rectOutline(rect)
        const on = (p: { x: number; y: number }): Pt => at(p as { x: Nm; y: Nm })
        if (outline.kind === 'corners') {
          const ring = outline.corners.map(on)
          ring.forEach((p, i) => segment(p, ring[(i + 1) % ring.length]))
          continue
        }
        // Rounded: each corner's arc, and the sides between them that have length.
        outline.arcs.forEach((arc, i) => {
          arc3(on(arc.start), on(arc.mid), on(arc.end))
          const next = outline.arcs[(i + 1) % outline.arcs.length]
          const a = on(arc.end)
          const b = on(next.start)
          if (Math.hypot(b.x - a.x, b.y - a.y) > SAME) this.edges.push({ kind: 'segment', a, b })
        })
      }
      for (const poly of shapes.polys) {
        if (poly.layer !== EDGE_CUTS || poly.points.length < 2) continue
        const ring = poly.points.map(at)
        ring.forEach((p, i) => segment(p, ring[(i + 1) % ring.length]))
      }
    }
    read(
      {
        lines: this.board.grLines,
        arcs: this.board.grArcs,
        circles: this.board.grCircles,
        rects: this.board.grRects,
        polys: this.board.grPolys
      },
      world
    )
    for (const bfp of this.board.footprints) {
      const tf = footprintTransform(bfp)
      const fp = bfp.footprint
      read(
        {
          lines: fp.fpLines,
          arcs: fp.fpArcs,
          circles: fp.fpCircles,
          rects: fp.fpRects,
          polys: fp.fpPolys
        },
        (p) => tfPoint(tf, p.x, p.y)
      )
      // An unplated hole's wall is an edge: a round one a circle, a slot its sides and caps.
      for (const pad of fp.pads) {
        if (pad.type !== 'np_thru_hole') continue
        const hole = padHoleShape(pad, tfPoint(tf, pad.position.x, pad.position.y))
        if (!hole || hole.kind !== 'capsule') continue
        const a = { x: hole.x0, y: hole.y0 }
        const b = { x: hole.x1, y: hole.y1 }
        const r = hole.halfWidth
        this.holes.push({ a, b, r })
        if (Math.hypot(b.x - a.x, b.y - a.y) < SAME) {
          curve({ c: a, r, arc: null })
          continue
        }
        const along = Math.atan2(b.y - a.y, b.x - a.x)
        const n = { x: -Math.sin(along) * r, y: Math.cos(along) * r }
        segment({ x: a.x + n.x, y: a.y + n.y }, { x: b.x + n.x, y: b.y + n.y })
        segment({ x: a.x - n.x, y: a.y - n.y }, { x: b.x - n.x, y: b.y - n.y })
        curve({ c: a, r, arc: { start: along + Math.PI / 2, sweep: Math.PI } })
        curve({ c: b, r, arc: { start: along - Math.PI / 2, sweep: Math.PI } })
      }
    }
  }
}

/** Copper as creepage paths meet it: strokes and discs, an outline by its edges. */
export function creepCopper(shape: CopperShape, item: number): CreepCopper[] {
  switch (shape.kind) {
    case 'capsule':
      return [
        {
          a: { x: shape.x0, y: shape.y0 },
          b: { x: shape.x1, y: shape.y1 },
          r: shape.halfWidth,
          item
        }
      ]
    case 'circle':
      return [
        { a: { x: shape.cx, y: shape.cy }, b: { x: shape.cx, y: shape.cy }, r: shape.r, item }
      ]
    case 'rrect':
      return edges(rrectCore(shape), shape.cornerR, item)
    case 'arc': {
      const points = sampleArc(shape.x0, shape.y0, shape.mx, shape.my, shape.x1, shape.y1)
      return points.slice(1).map((b, i) => ({ a: points[i], b, r: shape.halfWidth, item }))
    }
    case 'poly':
      return shape.rings.flatMap((ring) => edges(ring, 0, item))
    case 'compound':
      return shape.parts.flatMap((part) => creepCopper(part, item))
  }
}

const edges = (ring: readonly Pt[], r: number, item: number): CreepCopper[] =>
  ring.map((a, i) => ({ a, b: ring[(i + 1) % ring.length], r, item }))

const world = (p: { x: Nm; y: Nm }): Pt => ({ x: nmToMm(p.x), y: -nmToMm(p.y) })

const onCircle = (c: Curve, angle: number): Pt => ({
  x: c.c.x + c.r * Math.cos(angle),
  y: c.c.y + c.r * Math.sin(angle)
})

/** Whether a point on a curve's circle lies on the curve. */
const onCurveAt = (c: Curve, p: Pt): boolean => {
  if (!c.arc) return true
  let t = Math.atan2(p.y - c.c.y, p.x - c.c.x) - c.arc.start
  t = ((t % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
  return t <= c.arc.sweep + 1e-9 || t >= 2 * Math.PI - 1e-9
}

/** The way along a curve between two points on it: the shorter arc of a circle, the arc's own span; null off it. */
function alongCurve(c: Curve, p: Pt, q: Pt): number | null {
  if (!c.arc) {
    const chord = Math.hypot(q.x - p.x, q.y - p.y)
    return 2 * c.r * Math.asin(Math.min(1, chord / (2 * c.r)))
  }
  const param = (x: Pt): number => {
    let t = Math.atan2(x.y - c.c.y, x.x - c.c.x) - c.arc!.start
    t = ((t % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
    return t > c.arc!.sweep + 1e-9 ? t - 2 * Math.PI : t
  }
  return Math.abs(param(q) - param(p)) * c.r
}

/** The points where lines through `p` touch a curve (none from inside its circle). */
function pointTangents(p: Pt, c: Curve): Pt[] {
  const dx = p.x - c.c.x
  const dy = p.y - c.c.y
  const d = Math.hypot(dx, dy)
  if (d <= c.r) return []
  const base = Math.atan2(dy, dx)
  const spread = Math.acos(c.r / d)
  return [base + spread, base - spread]
    .map((angle) => onCircle(c, angle))
    .filter((t) => onCurveAt(c, t))
}

/** The runs tangent to two curves: the outer and the crossed bitangents, each end on its curve. */
function curveTangents(a: Curve, b: Curve): Array<[Pt, Pt]> {
  const dx = b.c.x - a.c.x
  const dy = b.c.y - a.c.y
  const d = Math.hypot(dx, dy)
  const out: Array<[Pt, Pt]> = []
  if (d < SAME) return out
  const base = Math.atan2(dy, dx)
  // Outer: normals at angle base ± acos((ra - rb) / d); crossed: ± acos((ra + rb) / d), the far one turned.
  for (const [k, crossed] of [
    [(a.r - b.r) / d, false],
    [(a.r + b.r) / d, true]
  ] as const) {
    if (Math.abs(k) > 1) continue
    const spread = Math.acos(k)
    for (const sign of [1, -1]) {
      const n = base + sign * spread
      const s = onCircle(a, n)
      const t = onCircle(b, crossed ? n + Math.PI : n)
      if (onCurveAt(a, s) && onCurveAt(b, t)) out.push([s, t])
    }
  }
  return out
}

/** A run from copper to a point: from the copper's nearest approach. */
function copperToPoint(piece: CreepCopper, p: Pt): { s: Pt; w: number } | null {
  const q = closestOnSegment(piece.a, piece.b, p)
  const d = Math.hypot(p.x - q.x, p.y - q.y)
  if (d <= piece.r) return null
  return { s: toward(q, p, piece.r), w: d - piece.r }
}

/**
 * The runs from copper that touch a curve: along a line through either end's
 * center tangent to it, or square off a straight side to where a line
 * parallel to the side's normal touches it.
 */
function copperToCurve(piece: CreepCopper, c: Curve): Array<{ s: Pt; t: Pt; w: number }> {
  const out: Array<{ s: Pt; t: Pt; w: number }> = []
  const ends = samePoint(piece.a, piece.b) ? [piece.a] : [piece.a, piece.b]
  for (const e of ends)
    for (const t of pointTangents(e, c)) {
      const length = Math.hypot(t.x - e.x, t.y - e.y)
      if (length > piece.r) out.push({ s: toward(e, t, piece.r), t, w: length - piece.r })
    }
  if (ends.length === 2) {
    const len = Math.hypot(piece.b.x - piece.a.x, piece.b.y - piece.a.y)
    const u = { x: (piece.b.x - piece.a.x) / len, y: (piece.b.y - piece.a.y) / len }
    for (const sign of [1, -1]) {
      const t = { x: c.c.x + sign * c.r * u.x, y: c.c.y + sign * c.r * u.y }
      if (!onCurveAt(c, t)) continue
      const along = (t.x - piece.a.x) * u.x + (t.y - piece.a.y) * u.y
      if (along < 0 || along > len) continue
      const foot = { x: piece.a.x + along * u.x, y: piece.a.y + along * u.y }
      const d = Math.hypot(t.x - foot.x, t.y - foot.y)
      if (d <= piece.r) continue
      out.push({ s: toward(foot, t, piece.r), t, w: d - piece.r })
    }
  }
  return out
}

/** The straight run between two pieces of copper: their nearest approach. */
function copperToCopper(a: CreepCopper, b: CreepCopper): { s: Pt; t: Pt; w: number } | null {
  const [p, q] = closestBetween(a.a, a.b, b.a, b.b)
  const d = Math.hypot(q.x - p.x, q.y - p.y)
  if (d <= a.r + b.r) {
    // Copper that meets is a short, not a creepage path — but for two strokes KiCad reads it as a path of no length.
    if (samePoint(a.a, a.b) && samePoint(b.a, b.b)) return null
    return { s: p, t: q, w: 0 }
  }
  return { s: toward(p, q, a.r), t: toward(q, p, b.r), w: d - a.r - b.r }
}

const samePoint = (a: Pt, b: Pt): boolean =>
  Math.abs(a.x - b.x) < SAME && Math.abs(a.y - b.y) < SAME

const toward = (from: Pt, to: Pt, by: number): Pt => {
  const d = Math.hypot(to.x - from.x, to.y - from.y) || 1
  return { x: from.x + ((to.x - from.x) / d) * by, y: from.y + ((to.y - from.y) / d) * by }
}

function closestOnSegment(a: Pt, b: Pt, p: Pt): Pt {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return a
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2))
  return { x: a.x + t * dx, y: a.y + t * dy }
}

const segmentPointDistance = (a: Pt, b: Pt, p: Pt): number => {
  const q = closestOnSegment(a, b, p)
  return Math.hypot(p.x - q.x, p.y - q.y)
}

/** The nearest pair of points of two segments. */
function closestBetween(a: Pt, b: Pt, c: Pt, d: Pt): [Pt, Pt] {
  const hit = intersection(a, b, c, d)
  if (hit) return [hit, hit]
  const options: Array<[Pt, Pt]> = [
    [closestOnSegment(a, b, c), c],
    [closestOnSegment(a, b, d), d],
    [a, closestOnSegment(c, d, a)],
    [b, closestOnSegment(c, d, b)]
  ]
  return options.reduce((best, pair) =>
    Math.hypot(pair[1].x - pair[0].x, pair[1].y - pair[0].y) <
    Math.hypot(best[1].x - best[0].x, best[1].y - best[0].y)
      ? pair
      : best
  )
}

const cross = (o: Pt, a: Pt, b: Pt): number => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)

/** Where two segments meet, their ends included; null when apart or collinear. */
function intersection(p: Pt, q: Pt, c: Pt, d: Pt): Pt | null {
  const r = { x: q.x - p.x, y: q.y - p.y }
  const s = { x: d.x - c.x, y: d.y - c.y }
  const denom = r.x * s.y - r.y * s.x
  if (Math.abs(denom) < 1e-18) return null
  const t = ((c.x - p.x) * s.y - (c.y - p.y) * s.x) / denom
  const u = ((c.x - p.x) * r.y - (c.y - p.y) * r.x) / denom
  const eps = 1e-12
  if (t < -eps || t > 1 + eps || u < -eps || u > 1 + eps) return null
  return { x: p.x + t * r.x, y: p.y + t * r.y }
}

/** Whether two segments touch or cross (KiCad's `SEG::Intersects`), collinear overlap included. */
function segmentsTouch(p: Pt, q: Pt, c: Pt, d: Pt): boolean {
  const d1 = cross(c, d, p)
  const d2 = cross(c, d, q)
  const d3 = cross(p, q, c)
  const d4 = cross(p, q, d)
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0)))
    return true
  const within = (a: Pt, b: Pt, x: Pt): boolean =>
    Math.min(a.x, b.x) - SAME <= x.x &&
    x.x <= Math.max(a.x, b.x) + SAME &&
    Math.min(a.y, b.y) - SAME <= x.y &&
    x.y <= Math.max(a.y, b.y) + SAME
  const tiny = 1e-15
  return (
    (Math.abs(d1) < tiny && within(c, d, p)) ||
    (Math.abs(d2) < tiny && within(c, d, q)) ||
    (Math.abs(d3) < tiny && within(p, q, c)) ||
    (Math.abs(d4) < tiny && within(p, q, d))
  )
}

/**
 * Whether a run crosses an edge: meets it anywhere but at the run's own ends
 * (a segment sharing an end with the run is not crossed).
 */
function edgeCrossed(edge: EdgePiece, p: Pt, q: Pt): boolean {
  if (edge.kind === 'segment') {
    if (
      samePoint(p, edge.a) ||
      samePoint(p, edge.b) ||
      samePoint(q, edge.a) ||
      samePoint(q, edge.b)
    )
      return false
    const hit = intersection(p, q, edge.a, edge.b)
    return hit !== null
  }
  // A run against a circle: where the line meets it, inside the run and not at its ends.
  const dx = q.x - p.x
  const dy = q.y - p.y
  const fx = p.x - edge.c.x
  const fy = p.y - edge.c.y
  const a = dx * dx + dy * dy
  if (a === 0) return false
  const b = 2 * (fx * dx + fy * dy)
  const c = fx * fx + fy * fy - edge.r * edge.r
  const disc = b * b - 4 * a * c
  if (disc < 0) return false
  const root = Math.sqrt(disc)
  const length = Math.sqrt(a)
  for (const t of [(-b - root) / (2 * a), (-b + root) / (2 * a)]) {
    if (t < 0 || t > 1) continue
    if (t * length <= TOUCH || (1 - t) * length <= TOUCH) continue
    const hit = { x: p.x + t * dx, y: p.y + t * dy }
    if (onCurveAt(edge, hit)) return true
  }
  return false
}

function boxOf(edge: EdgePiece): [number, number, number, number] {
  if (edge.kind === 'segment')
    return [
      Math.min(edge.a.x, edge.b.x),
      Math.min(edge.a.y, edge.b.y),
      Math.max(edge.a.x, edge.b.x),
      Math.max(edge.a.y, edge.b.y)
    ]
  return [edge.c.x - edge.r, edge.c.y - edge.r, edge.c.x + edge.r, edge.c.y + edge.r]
}

function inRing(ring: readonly Pt[], p: Pt): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]
    const b = ring[j]
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x)
      inside = !inside
  }
  return inside
}

function ringDistance(ring: readonly Pt[], p: Pt): number {
  let best = Infinity
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++)
    best = Math.min(best, segmentPointDistance(ring[j], ring[i], p))
  return best
}

/** A binary heap of nodes by distance. */
class MinHeap {
  private readonly ids: number[] = []
  private readonly keys: number[] = []
  get size(): number {
    return this.ids.length
  }
  push(id: number, key: number): void {
    this.ids.push(id)
    this.keys.push(key)
    let i = this.ids.length - 1
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (this.keys[parent] <= this.keys[i]) break
      this.swap(i, parent)
      i = parent
    }
  }
  pop(): [number, number] {
    const top: [number, number] = [this.ids[0], this.keys[0]]
    const lastId = this.ids.pop()!
    const lastKey = this.keys.pop()!
    if (this.ids.length > 0) {
      this.ids[0] = lastId
      this.keys[0] = lastKey
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        const r = l + 1
        let m = i
        if (l < this.ids.length && this.keys[l] < this.keys[m]) m = l
        if (r < this.ids.length && this.keys[r] < this.keys[m]) m = r
        if (m === i) break
        this.swap(i, m)
        i = m
      }
    }
    return top
  }
  private swap(a: number, b: number): void {
    ;[this.ids[a], this.ids[b]] = [this.ids[b], this.ids[a]]
    ;[this.keys[a], this.keys[b]] = [this.keys[b], this.keys[a]]
  }
}
