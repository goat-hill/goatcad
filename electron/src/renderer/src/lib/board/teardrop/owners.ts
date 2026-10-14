/**
 * Which pads, vias and tracks each teardrop belongs to: KiCad's question to
 * its connectivity graph before a commit rebuilds it (`RemoveTeardrops`,
 * `CONNECTIVITY_DATA::GetConnectedPadsAndVias` of the teardrop zone). Keyed by
 * AST node, which an edit in place keeps and a removal leaves in the command's
 * touched set, so an edit finds the teardrops it made stale by what it touched,
 * never by where things were.
 *
 * A teardrop the commit builds records its owners as it is made. The ones a
 * file brings are read once, by geometry, before the first edit that needs
 * them: a pad or via whose centre the teardrop holds, a track with an end in
 * it. That pass walks the board's copper once, bucketed, with no polygon
 * booleans; after it, an edit costs only what it touched.
 */
import { isTeardropZone, type KicadBoard, type KicadBoardZone } from '../../kicad/board'
import type { SExprNode } from '../../kicad/sexpr'
import { pointInside, segmentHit, type IPt } from './kicadMath'
import { padBoardPosition } from './manager'

const CELL = 1_000_000 // 1 mm buckets, in nm

export class TeardropOwners {
  /** The board the map is true for; any other needs a rebuild first. */
  private board: KicadBoard | null = null
  private byZone = new Map<SExprNode, readonly SExprNode[]>()
  private byOwner = new Map<SExprNode, Set<SExprNode>>()

  /** Whether the map holds for `board`. */
  holds(board: KicadBoard): boolean {
    return this.board === board
  }

  /** Forget everything: a load, an undo or a redo replaced the board's nodes. */
  invalidate(): void {
    this.board = null
    this.byZone.clear()
    this.byOwner.clear()
  }

  /** The teardrop zones (nodes) any of these owners has. */
  zonesOf(owners: Iterable<SExprNode>): Set<SExprNode> {
    const out = new Set<SExprNode>()
    for (const owner of owners) for (const zone of this.byOwner.get(owner) ?? []) out.add(zone)
    return out
  }

  /** What a teardrop belongs to. */
  ownersOf(zone: SExprNode): readonly SExprNode[] {
    return this.byZone.get(zone) ?? []
  }

  /** A teardrop gone. */
  drop(zone: SExprNode): void {
    for (const owner of this.byZone.get(zone) ?? []) this.byOwner.get(owner)?.delete(zone)
    this.byZone.delete(zone)
  }

  /** A teardrop made, with what it belongs to. */
  add(zone: SExprNode, owners: readonly SExprNode[]): void {
    this.byZone.set(zone, owners)
    for (const owner of owners) {
      let zones = this.byOwner.get(owner)
      if (!zones) this.byOwner.set(owner, (zones = new Set()))
      zones.add(zone)
    }
  }

  /** The map now holds for this board (the one a command left). */
  heldFor(board: KicadBoard): void {
    this.board = board
  }

  /** Read every teardrop's owners off the board's geometry, once. */
  build(board: KicadBoard): void {
    this.invalidate()
    const teardrops = board.zones.filter(isTeardropZone)
    if (teardrops.length > 0) {
      const points = new Map<
        string,
        Array<{ owner: SExprNode; p: IPt; layers: readonly string[] | null }>
      >()
      const segments = new Map<
        string,
        Array<{ owner: SExprNode; a: IPt; b: IPt; reach: number; layer: string }>
      >()
      const key = (x: number, y: number): string =>
        `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`
      const putPoint = (owner: SExprNode, p: IPt, layers: readonly string[] | null): void => {
        const k = key(p.x, p.y)
        const list = points.get(k)
        if (list) list.push({ owner, p, layers })
        else points.set(k, [{ owner, p, layers }])
      }
      for (const fp of board.footprints)
        for (const pad of fp.footprint.pads) putPoint(pad._raw, padBoardPosition(fp, pad), null)
      for (const via of board.vias) putPoint(via._raw, via.position, null)
      for (const t of [...board.segments, ...board.trackArcs]) {
        const reach = Math.trunc(t.width / 2)
        const entry = { owner: t._raw, a: t.start, b: t.end, reach, layer: t.layer }
        for (const p of [t.start, t.end]) {
          const k = key(p.x, p.y)
          const list = segments.get(k)
          if (list) list.push(entry)
          else segments.set(k, [entry])
        }
      }
      for (const zone of teardrops) this.add(zone._raw, ownersOf(zone, points, segments, key))
    }
    this.board = board
  }
}

function ownersOf(
  zone: KicadBoardZone,
  points: Map<string, Array<{ owner: SExprNode; p: IPt; layers: readonly string[] | null }>>,
  segments: Map<string, Array<{ owner: SExprNode; a: IPt; b: IPt; reach: number; layer: string }>>,
  key: (x: number, y: number) => string
): SExprNode[] {
  const ring = zone.points
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of ring) {
    minX = Math.min(minX, p.x)
    minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x)
    maxY = Math.max(maxY, p.y)
  }
  const layer = zone.layers[0]
  const owners = new Set<SExprNode>()
  const near = (p: IPt, reach: number): boolean =>
    pointInside(ring, p) ||
    ring.some((a, i) => segmentHit(p, a, ring[(i + 1) % ring.length], reach))
  for (let cx = Math.floor(minX / CELL); cx <= Math.floor(maxX / CELL); cx++)
    for (let cy = Math.floor(minY / CELL); cy <= Math.floor(maxY / CELL); cy++) {
      const k = key(cx * CELL, cy * CELL)
      for (const pt of points.get(k) ?? [])
        if ((!pt.layers || pt.layers.includes(layer)) && pointInside(ring, pt.p))
          owners.add(pt.owner)
      for (const seg of segments.get(k) ?? [])
        if (seg.layer === layer && (near(seg.a, seg.reach) || near(seg.b, seg.reach)))
          owners.add(seg.owner)
    }
  return [...owners]
}
