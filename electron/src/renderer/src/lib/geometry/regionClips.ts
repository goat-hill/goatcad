/**
 * Reusable clip filters over the Clipper2 kernel (`clip.ts`), built so that
 * scale comes from making the common case free: each filter keeps a coarse
 * grid index and answers "keep, untouched" for any region whose bounding box
 * lands in empty cells. Only regions that genuinely meet clip geometry pay
 * for a boolean, which Clipper2 does in microseconds.
 *
 * Consumers: the 3D board (copper stops at drill bores, silk at the board
 * edge — `engine/board3d/layerClips.ts`) and the Gerber writer (silkscreen
 * minus mask openings, clipped to the outline — `gerber/write.ts`).
 *
 * Every filter degrades rather than fails: if a boolean throws, the region
 * passes through unclipped — pre-clipping behavior, never missing geometry.
 */

import { difference, intersection, type ClipPt, type ClipRegion } from './clip'

/**
 * A geometric filter applied to one region at a time. `clip` returns `null`
 * to keep the region untouched (the common fast path), `[]` to drop it, or
 * the regions that replace it. A filter whose worst case is expensive (one
 * region against thousands of cuts) also offers `clipSteps`, the same result
 * with yields between booleans, so a cooperative driver never runs one long
 * task.
 */
export interface ShapeClip {
  clip(region: ClipRegion): ClipRegion[] | null
  clipSteps?(region: ClipRegion): Generator<void, ClipRegion[] | null>
}

/** Run a region through a clip stack, each stage consuming the previous
 *  stage's output. `null` means no stage touched it. */
export function applyShapeClips(
  region: ClipRegion,
  clips: readonly ShapeClip[]
): ClipRegion[] | null {
  return drainSteps(applyShapeClipsSteps(region, clips))
}

/** Stepwise `applyShapeClips`: yields wherever the stack's filters can. */
export function* applyShapeClipsSteps(
  region: ClipRegion,
  clips: readonly ShapeClip[]
): Generator<void, ClipRegion[] | null> {
  let regions: ClipRegion[] = [region]
  let touched = false
  for (const clip of clips) {
    const next: ClipRegion[] = []
    for (const r of regions) {
      const replaced = clip.clipSteps ? yield* clip.clipSteps(r) : clip.clip(r)
      if (replaced === null) next.push(r)
      else {
        touched = true
        next.push(...replaced)
      }
    }
    regions = next
  }
  return touched ? regions : null
}

interface BBox {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

const bboxOf = (ring: readonly ClipPt[]): BBox => {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of ring) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  return { minX, minY, maxX, maxY }
}

const overlaps = (a: BBox, b: BBox): boolean =>
  a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY

/** Grid pitch, mm. Pads, drills and board-edge features are a few mm at most. */
const CELL = 2

/** A uniform grid over ids with bounding boxes — coarse, conservative, O(1). */
class GridIndex {
  private readonly cells = new Map<string, number[]>()

  constructor(private readonly cell: number) {}

  insert(id: number, box: BBox): void {
    this.eachCell(box, (key) => {
      let ids = this.cells.get(key)
      if (!ids) {
        ids = []
        this.cells.set(key, ids)
      }
      ids.push(id)
    })
  }

  /** Every id whose box shares a cell with `box` — a superset of true hits. */
  query(box: BBox): number[] {
    const seen = new Set<number>()
    this.eachCell(box, (key) => {
      const ids = this.cells.get(key)
      if (ids) for (const id of ids) seen.add(id)
    })
    return [...seen]
  }

  private eachCell(box: BBox, visit: (key: string) => void): void {
    const x0 = Math.floor(box.minX / this.cell)
    const x1 = Math.floor(box.maxX / this.cell)
    const y0 = Math.floor(box.minY / this.cell)
    const y1 = Math.floor(box.maxY / this.cell)
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) visit(`${x}:${y}`)
    }
  }
}

/**
 * How many cut contours one boolean — and, more importantly, one downstream
 * earcut — is allowed to see. Earcut's cost grows superlinearly with hole
 * count: a ground plane minus 2 700 drill bores triangulates in ~3 s as one
 * region but in ~0.3 s as ~100 pieces of ≤48 holes each. The booleans that do
 * the splitting are grid-pruned and cost microseconds by comparison.
 */
const MAX_CUTS_PER_PIECE = 48

/** Splits stop making progress below this many mm — degenerate input guard. */
const MIN_SPLIT_SPAN_MM = 0.05

/** Bisection depth cap: 2^24 pieces is far past any real board. */
const MAX_SPLIT_DEPTH = 24

/** Run a generator to completion synchronously and take its return value. */
export function drainSteps<T, R>(steps: Generator<T, R>): R {
  let result = steps.next()
  while (!result.done) result = steps.next()
  return result.value
}

/**
 * `difference(subject, cuts)`, but the subject is recursively bisected (with
 * the cuts distributed to the halves they touch) until no piece carries more
 * than `maxCuts` cut contours. The result covers the same area as the plain
 * difference; the extra vertices along the split lines are invisible in a
 * filled rendering, and every returned region is cheap to triangulate.
 *
 * Degrades like everything else here: with no engine, or if a boolean throws,
 * the plain single-call difference (or the unclipped subject) is returned.
 */
export function subtractInPieces(
  subject: ClipRegion,
  cuts: readonly ClipRegion[],
  maxCuts = MAX_CUTS_PER_PIECE
): ClipRegion[] {
  return drainSteps(subtractInPiecesSteps(subject, cuts, maxCuts))
}

/**
 * The stepwise form of `subtractInPieces`: yields between booleans so an
 * async driver can hand the thread back mid-subtraction. Each step is one
 * split or one leaf difference — a few milliseconds at most.
 */
export function* subtractInPiecesSteps(
  subject: ClipRegion,
  cuts: readonly ClipRegion[],
  maxCuts = MAX_CUTS_PER_PIECE
): Generator<void, ClipRegion[]> {
  interface Node {
    region: ClipRegion
    cuts: readonly ClipRegion[]
    depth: number
  }
  const stack: Node[] = [{ region: subject, cuts, depth: 0 }]
  const out: ClipRegion[] = []
  try {
    while (stack.length > 0) {
      const node = stack.pop() as Node
      const box = bboxOf(node.region.outer)
      const horizontal = box.maxX - box.minX >= box.maxY - box.minY
      const span = horizontal ? box.maxX - box.minX : box.maxY - box.minY
      if (
        node.cuts.length <= maxCuts ||
        node.depth >= MAX_SPLIT_DEPTH ||
        span < MIN_SPLIT_SPAN_MM
      ) {
        if (node.cuts.length === 0) out.push(node.region)
        else out.push(...difference([node.region], node.cuts))
        yield
        continue
      }

      // Split at the median cut centroid so the halves carry similar cut
      // counts; a cut straddling the line lands in both halves, which the
      // leaf difference handles (each half subtracts its side of it).
      const centers = node.cuts
        .map((cut) => {
          const b = bboxOf(cut.outer)
          return horizontal ? (b.minX + b.maxX) / 2 : (b.minY + b.maxY) / 2
        })
        .sort((a, b) => a - b)
      let mid = centers[Math.floor(centers.length / 2)]
      const lo = horizontal ? box.minX : box.minY
      const hi = horizontal ? box.maxX : box.maxY
      // A degenerate median (all cuts piled at one end) would keep one half
      // unchanged forever; the box midpoint always removes area from both.
      if (mid <= lo || mid >= hi) mid = (lo + hi) / 2

      for (const [from, to] of [
        [lo - 1, mid],
        [mid, hi + 1]
      ]) {
        const rect: ClipPt[] = horizontal
          ? [
              { x: from, y: box.minY - 1 },
              { x: to, y: box.minY - 1 },
              { x: to, y: box.maxY + 1 },
              { x: from, y: box.maxY + 1 }
            ]
          : [
              { x: box.minX - 1, y: from },
              { x: box.maxX + 1, y: from },
              { x: box.maxX + 1, y: to },
              { x: box.minX - 1, y: to }
            ]
        const inHalf = (b: BBox): boolean =>
          horizontal ? b.maxX >= from && b.minX <= to : b.maxY >= from && b.minY <= to
        // Only geometry that can touch this half crosses the wasm boundary —
        // this pruning is what keeps the split O(n log n) instead of O(n²).
        const half: ClipRegion = {
          outer: node.region.outer,
          holes: node.region.holes.filter((h) => inHalf(bboxOf(h)))
        }
        const localCuts = node.cuts.filter((cut) => inHalf(bboxOf(cut.outer)))
        for (const piece of intersection([half], [{ outer: rect, holes: [] }])) {
          stack.push({ region: piece, cuts: localCuts, depth: node.depth + 1 })
        }
        yield
      }
    }
  } catch (error) {
    console.warn('partitioned subtraction failed; falling back to one boolean', error)
    return difference([subject], cuts)
  }
  return out
}

/** Subtracts a fixed set of regions from whatever overlaps one of them. */
export class SubtractRegions implements ShapeClip {
  private readonly cuts: ClipRegion[]
  private readonly boxes: BBox[]
  private readonly index = new GridIndex(CELL)

  constructor(cuts: readonly ClipRegion[]) {
    this.cuts = cuts.filter((cut) => cut.outer.length >= 3)
    this.boxes = this.cuts.map((cut) => bboxOf(cut.outer))
    this.boxes.forEach((box, id) => this.index.insert(id, box))
  }

  clip(region: ClipRegion): ClipRegion[] | null {
    return drainSteps(this.clipSteps(region))
  }

  // Partitioned so a plane-sized region over thousands of drills comes back
  // as many small pieces instead of one untriangulatable monster — and, in
  // the stepwise form, so no single call blocks for the whole plane.
  *clipSteps(region: ClipRegion): Generator<void, ClipRegion[] | null> {
    const box = bboxOf(region.outer)
    const hits = this.index.query(box).filter((id) => overlaps(box, this.boxes[id]))
    if (hits.length === 0) return null
    try {
      return yield* subtractInPiecesSteps(
        region,
        hits.map((id) => this.cuts[id])
      )
    } catch (error) {
      console.warn('region subtraction failed; region kept unclipped', error)
      return null
    }
  }
}

/** Keeps only what lies inside a fixed coverage: regions are cut at its border. */
export class KeepWithinRegions implements ShapeClip {
  private readonly coverage: ClipRegion[]
  private readonly edges = new GridIndex(CELL)
  private hasEdges = false

  constructor(coverage: readonly ClipRegion[]) {
    this.coverage = coverage.filter((region) => region.outer.length >= 3)
    let id = 0
    for (const region of this.coverage) {
      for (const ring of [region.outer, ...region.holes]) {
        for (let i = 0; i < ring.length; i++) {
          const a = ring[i]
          const b = ring[(i + 1) % ring.length]
          this.edges.insert(id++, {
            minX: Math.min(a.x, b.x),
            minY: Math.min(a.y, b.y),
            maxX: Math.max(a.x, b.x),
            maxY: Math.max(a.y, b.y)
          })
          this.hasEdges = true
        }
      }
    }
  }

  clip(region: ClipRegion): ClipRegion[] | null {
    if (!this.hasEdges) return null
    // No coverage edge near the region means it cannot straddle the border:
    // it is wholly inside or wholly outside, and one point tells which.
    if (this.edges.query(bboxOf(region.outer)).length === 0) {
      return this.contains(region.outer[0]) ? null : []
    }
    try {
      return intersection([region], this.coverage)
    } catch (error) {
      console.warn('region clipping failed; region kept unclipped', error)
      return null
    }
  }

  private contains(point: ClipPt): boolean {
    return this.coverage.some(
      (region) =>
        pointInPolygon(point, region.outer) &&
        !region.holes.some((hole) => pointInPolygon(point, hole))
    )
  }
}

/** Ray-cast containment test for a closed ring. */
export function pointInPolygon(point: ClipPt, ring: readonly ClipPt[]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]
    const b = ring[j]
    if (a.y > point.y !== b.y > point.y) {
      const x = ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
      if (point.x < x) inside = !inside
    }
  }
  return inside
}

/**
 * A holed region as one self-touching contour, for consumers that only take a
 * single ring (a Gerber G36 region). Each hole is spliced into the outer ring
 * through a zero-width cut at the closest vertex pair — the standard Gerber
 * "cut-in" that plotters and our own parser fill correctly under even-odd.
 */
export function singleContour(region: ClipRegion): ClipPt[] {
  let contour = [...region.outer]
  for (const rawHole of region.holes) {
    if (rawHole.length < 3) continue
    // The cut-in only reads as a hole when it is traversed against the outer
    // ring's direction.
    const hole = ringIsCCW(rawHole) === ringIsCCW(contour) ? [...rawHole].reverse() : rawHole
    let best = { d: Infinity, ci: 0, hi: 0 }
    for (let ci = 0; ci < contour.length; ci++) {
      for (let hi = 0; hi < hole.length; hi++) {
        const dx = contour[ci].x - hole[hi].x
        const dy = contour[ci].y - hole[hi].y
        const d = dx * dx + dy * dy
        if (d < best.d) best = { d, ci, hi }
      }
    }
    // Walk the outer to the bridge point, around the hole, and back.
    contour = [
      ...contour.slice(0, best.ci + 1),
      ...hole.slice(best.hi),
      ...hole.slice(0, best.hi + 1),
      ...contour.slice(best.ci)
    ]
  }
  return contour
}

function ringIsCCW(ring: readonly ClipPt[]): boolean {
  let sum = 0
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]
    const b = ring[(i + 1) % ring.length]
    sum += a.x * b.y - b.x * a.y
  }
  return sum > 0
}
