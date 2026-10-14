/**
 * A selection of board items turned or flipped as one, as KiCad's Rotate and
 * Flip do (`EDIT_TOOL::Rotate`, `EDIT_TOOL::Flip`, `updateModificationPoint`):
 * - one item turns and flips about its own position — a track arc or graphic
 *   arc its center, a zone its first corner, a polygon its first vertex — and
 *   a rectangle or polygon turns about its middle, a rectangle flips about it;
 * - several turn about the middle of their bounding box, snapped to the grid,
 *   and flip about that middle unsnapped.
 * The box is taken over the points items store (a footprint's anchor and
 * pads), where KiCad takes each item's full outline.
 *
 * A turned item is a new node (`rotatedBoardItemNode`), as a flipped one is
 * (`flippedBoardItemNode`): written in the old one's place, the command's
 * remap parses it fresh. Footprints turn through their own mutators.
 *
 * Domain space throughout (integer nm, y down); degrees run as KiCad's do.
 */
import { nm, type Nm } from '../kicad/coordinates'
import type { KicadBoard } from '../kicad/board'
import { arcCenterFromPoints, rotateAbout } from '../kicad/kicadArc'
import { cloneNodeDeep, findChild, findChildren, getToken, type SExprList } from '../kicad/sexpr'
import {
  atAngle,
  footprintExtentPoints,
  mapChildXY,
  mapPts,
  mapTuningPatternPoints,
  normalize,
  setAtAngle,
  writeXY,
  xyOf
} from './footprintFlip'
import { selectionMirrorPoint } from './boardMirror'

type Pt = { x: Nm; y: Nm }

/** Board items, by selection type, that turn and flip as nodes of their own. */
export const NODE_TRANSFORM_TYPES: ReadonlySet<string> = new Set([
  'segment',
  'tarc',
  'via',
  'zone',
  'gr_line',
  'gr_rect',
  'gr_circle',
  'gr_arc',
  'gr_poly',
  'gr_curve',
  'gr_text',
  'point',
  'tuning_pattern'
])

/** Every point an item node stores, in the order KiCad reads them. */
const nodePoints = (node: SExprList): Pt[] => {
  const points: Pt[] = []
  const take = (p: Pt): Pt => {
    points.push(p)
    return p
  }
  for (const t of ['at', 'start', 'mid', 'end', 'center']) mapChildXY(node, t, take)
  const pts = findChild(node, 'pts')
  if (pts) mapPts(pts, take)
  for (const polygon of findChildren(node, 'polygon')) {
    const outline = findChild(polygon, 'pts')
    if (outline) mapPts(outline, take)
  }
  return points
}

const middle = (points: readonly Pt[]): Pt | null => selectionMirrorPoint(points, 0)

/** One item's own reference point (`updateModificationPoint`), for a turn or a flip. */
function itemReference(
  board: KicadBoard,
  ref: { type: string; index: number },
  op: 'rotate' | 'flip'
): Pt | null {
  if (ref.type === 'footprint') {
    const fp = board.footprints[ref.index]
    return fp ? { x: fp.position.x, y: fp.position.y } : null
  }
  const node = rawOf(board, ref)
  if (!node) return null
  const points = nodePoints(node)
  switch (ref.type) {
    case 'gr_rect':
      return middle(points)
    case 'gr_poly':
      return op === 'rotate' ? middle(points) : (points[0] ?? null)
    case 'tarc':
    case 'gr_arc': {
      const [start, mid, end] = points
      if (!start || !mid || !end) return points[0] ?? null
      const c = arcCenterFromPoints(start, mid, end)
      return { x: nm(c.x), y: nm(c.y) }
    }
    default:
      return points[0] ?? null
  }
}

/** The collection a selection type indexes, by the board's array name. */
const ARRAY_OF: Record<string, keyof KicadBoard> = {
  segment: 'segments',
  tarc: 'trackArcs',
  via: 'vias',
  zone: 'zones',
  gr_line: 'grLines',
  gr_rect: 'grRects',
  gr_circle: 'grCircles',
  gr_arc: 'grArcs',
  gr_poly: 'grPolys',
  gr_curve: 'grCurves',
  gr_text: 'grTexts',
  point: 'points',
  tuning_pattern: 'tuningPatterns'
}

/** An item's file node, for the types that turn and flip as nodes. */
export function rawOf(board: KicadBoard, ref: { type: string; index: number }): SExprList | null {
  const name = ARRAY_OF[ref.type]
  if (!name) return null
  const item = (board[name] as ReadonlyArray<{ _raw: unknown }>)[ref.index]
  return (item?._raw as SExprList | undefined) ?? null
}

/**
 * Where a selection turns or flips about. `grid` (nm, 0 for none) snaps a
 * turn of several items, as KiCad snaps its reference point; a flip of
 * several takes the box's middle as it falls.
 */
export function transformCenter(
  board: KicadBoard,
  refs: ReadonlyArray<{ type: string; index: number }>,
  op: 'rotate' | 'flip',
  grid: number
): Pt | null {
  if (refs.length === 0) return null
  if (refs.length === 1) return itemReference(board, refs[0], op)
  const points = refs.flatMap((ref) => {
    if (ref.type === 'footprint') {
      const fp = board.footprints[ref.index]
      return fp ? footprintExtentPoints(fp) : []
    }
    const node = rawOf(board, ref)
    return node ? nodePoints(node) : []
  })
  return selectionMirrorPoint(points, op === 'rotate' ? grid : 0)
}

/**
 * A board item — not a footprint — turned `degrees` about `center`, as a new
 * node, or null for one this does not take (`NODE_TRANSFORM_TYPES`). Every
 * point it stores turns (a zone's fill too, as `ZONE::Rotate` turns it); a
 * text's angle turns with it (`PCB_TEXT::Rotate`). Turns are quarter turns,
 * so a rectangle stays one.
 */
export function rotatedBoardItemNode(node: SExprList, center: Pt, degrees: number): SExprList {
  const item = cloneNodeDeep(node) as SExprList
  const turn = (p: Pt): Pt => {
    const r = rotateAbout(p, center, degrees)
    return { x: nm(r.x), y: nm(r.y) }
  }
  if (getToken(item) === 'generated') {
    mapTuningPatternPoints(item, turn)
    return item
  }
  for (const t of ['start', 'mid', 'end', 'center']) mapChildXY(item, t, turn)
  const at = findChild(item, 'at')
  if (at) {
    const p = xyOf(at)
    if (p) writeXY(at, turn(p))
    if (getToken(item) === 'gr_text') setAtAngle(at, normalize((atAngle(at) ?? 0) + degrees))
  }
  const pts = findChild(item, 'pts')
  if (pts) mapPts(pts, turn)
  for (const token of ['polygon', 'filled_polygon']) {
    for (const holder of findChildren(item, token)) {
      const outline = findChild(holder, 'pts')
      if (outline) mapPts(outline, turn)
    }
  }
  // A TrueType text's cached outlines are board-absolute: they turn with it.
  const cache = findChild(item, 'render_cache')
  if (cache) {
    const angle = cache.children[2]
    if (angle?.type === 'atom') angle.value = String(normalize(Number(angle.value) + degrees))
    for (const polygon of findChildren(cache, 'polygon')) {
      const outline = findChild(polygon, 'pts')
      if (outline) mapPts(outline, turn)
    }
  }
  return item
}

/** Write `next` in `old`'s place among the board's top-level nodes. */
export function replaceBoardNode(board: KicadBoard, old: SExprList, next: SExprList): boolean {
  const root = board._raw as SExprList
  const idx = root.children.indexOf(old)
  if (idx === -1) return false
  root.children[idx] = next
  return true
}
