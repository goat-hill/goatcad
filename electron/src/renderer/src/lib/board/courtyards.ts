/**
 * Each footprint's courtyards on the board, front and back: its closed shapes
 * and chained strokes on F.CrtYd and B.CrtYd, nested into outlines and
 * cutouts as KiCad builds them (`FOOTPRINT::BuildCourtyardCaches`). The
 * courtyard checks read them, and so do the rules' `intersectsCourtyard`
 * conditions. World space: millimeters, y up.
 */
import type { KicadBoard, KicadBoardFootprint } from '../kicad/board'
import { mmToNm, nmToMm, type Nm } from '../kicad/coordinates'
import { footprintStrokes } from '../footprint/footprintShapes'
import { isCourtyardLayer } from '../footprint/footprintExtent'
import { chainEdges, nestRings, type Edge } from '../engine/board3d/boardOutline'
import { footprintTransform, tfPoint } from '../schematic/placement'
import { ringBox, type Box, type Region } from '../geometry/polygon'
import type { Pt } from './spatialIndex'
import { footprintShapes } from './outlineShapes'
import { outlineProblems, type OutlineProblem } from './outlineValidation'

/** KiCad's courtyard `chainingEpsilon` (mm): how far apart outline ends may be and still join. */
const COURTYARD_JOIN = nmToMm(mmToNm(0.02))

/**
 * How far KiCad shrinks a built courtyard (mm), its polygonization error, so
 * courtyards that touch, or sit at a clearance, are legal. The zone fill's
 * courtyard cut reads it so (`BuildCourtyardCaches`).
 */
export const COURTYARD_SHRINK = nmToMm(mmToNm(0.005))

export interface FootprintCourtyard {
  /** Index into the board's footprints. */
  fp: number
  front: Region[]
  back: Region[]
  /** Which sides' outlines are malformed: one that does not close, branches or crosses itself. */
  malformed: { front: boolean; back: boolean }
  /** Each side's outline problems, one finding each (`outlineValidation.ts`). */
  problems: { front: OutlineProblem[]; back: OutlineProblem[] }
  /** Both sides' bounds; null when the footprint has no courtyard. */
  box: Box | null
}

const samePt = (a: Pt, b: Pt): boolean => Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9

const unionBox = (a: Box, b: Box): Box => ({
  minX: Math.min(a.minX, b.minX),
  minY: Math.min(a.minY, b.minY),
  maxX: Math.max(a.maxX, b.maxX),
  maxY: Math.max(a.maxY, b.maxY)
})

/** Each footprint's courtyards, built once per board: the checks, the rules and the layer index share them. */
export function boardCourtyards(board: KicadBoard): FootprintCourtyard[] {
  let built = cache.get(board)
  if (!built) cache.set(board, (built = buildCourtyards(board)))
  return built
}

const cache = new WeakMap<KicadBoard, FootprintCourtyard[]>()

/**
 * The courtyards of a board an edit made from another: the last board's for
 * each footprint the edit left alone, built afresh for the rest. `raws` are the
 * AST nodes the edit changed (a footprint's is its own node).
 */
export function boardCourtyardsFrom(
  prev: KicadBoard,
  board: KicadBoard,
  raws: ReadonlySet<unknown>
): FootprintCourtyard[] {
  const cached = cache.get(board)
  if (cached) return cached
  const before = cache.get(prev)
  if (!before) return boardCourtyards(board)
  const byRaw = new Map(prev.footprints.map((bfp, fp) => [bfp._raw, before[fp]]))
  const built = board.footprints.map((bfp, fp) => {
    const kept = raws.has(bfp._raw) ? undefined : byRaw.get(bfp._raw)
    return kept ? (kept.fp === fp ? kept : { ...kept, fp }) : courtyardOf(bfp, fp)
  })
  cache.set(board, built)
  return built
}

function buildCourtyards(board: KicadBoard): FootprintCourtyard[] {
  return board.footprints.map(courtyardOf)
}

function courtyardOf(bfp: KicadBoardFootprint, fp: number): FootprintCourtyard {
  const tf = footprintTransform(bfp)
  const strokes = footprintStrokes(bfp.footprint).filter((stroke) => isCourtyardLayer(stroke.layer))
  const side = (
    prefix: 'F' | 'B'
  ): { regions: Region[]; malformed: boolean; problems: OutlineProblem[] } => {
    const rings: Pt[][] = []
    const edges: Edge[] = []
    for (const stroke of strokes) {
      if (!stroke.layer.startsWith(prefix)) continue
      const path = stroke.path.map((p) => tfPoint(tf, p.x as Nm, p.y as Nm))
      if (stroke.closed) {
        const ring =
          path.length > 1 && samePt(path[0], path[path.length - 1]) ? path.slice(0, -1) : path
        if (ring.length >= 3) rings.push(ring)
      } else if (path.length >= 2) {
        // A stroke joins the chain whole, by its ends (an arc's short chords would not).
        edges.push([path[0], path[path.length - 1], path])
      }
    }
    const chained = chainEdges(edges, COURTYARD_JOIN)
    const problems = outlineProblems(footprintShapes(bfp, `${prefix}.CrtYd`), {
      epsilon: COURTYARD_JOIN
    })
    return {
      regions: nestRings([...rings, ...chained.rings]),
      malformed: problems.length > 0,
      problems
    }
  }
  const front = side('F')
  const back = side('B')
  const all = [...front.regions, ...back.regions]
  return {
    fp,
    front: front.regions,
    back: back.regions,
    malformed: { front: front.malformed, back: back.malformed },
    problems: { front: front.problems, back: back.problems },
    box: all.length ? all.map((region) => ringBox(region.outer)).reduce(unionBox) : null
  }
}
