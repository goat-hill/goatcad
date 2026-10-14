/**
 * The PCB editor's selection edits — Move, Rotate, Flip, Mirror and Duplicate
 * — as functions of a board and a selection, so the editor's gestures and the
 * agent's `items.transform` (`boardItemsTransform.ts`) run the same code. Each
 * edits the board's AST in place; the caller runs it inside its command and
 * decides the pivot (`transformCenter`, `mirrorCenter`) before it does, so an
 * edit with nothing to act on never becomes an empty step.
 *
 * Domain space throughout (integer nm, y down); degrees counterclockwise.
 */
import {
  moveBoardFootprintInAST,
  rotateBoardFootprintInAST,
  setBoardZoneOutlineInAST,
  translateBoardZoneInAST,
  updateGrTextInAST,
  updateSegmentInAST,
  updateTrackArcInAST,
  updateViaInAST,
  type KicadBoard,
  type KicadBoardFootprint,
  type KicadGrText
} from '../kicad/board'
import {
  setAtChild,
  translateGraphicInAST,
  updateArcInAST,
  updateCircleInAST,
  updateLineInAST,
  updatePolyInAST,
  updatePropertyInAST,
  updateRectInAST,
  updateTextInAST,
  type KicadExtraGraphic
} from '../kicad/footprint'
import { markNodeDirty, type SExprList, type SExprNode } from '../kicad/sexpr'
import { nm, type Nm } from '../kicad/coordinates'
import { rotateAbout } from '../kicad/kicadArc'
import { boardLayerFlipper } from '../kicad/layers'
import {
  NODE_TRANSFORM_TYPES,
  rawOf,
  replaceBoardNode,
  rotatedBoardItemNode
} from './boardItemTransform'
import {
  flipBoardFootprintInAST,
  flippedBoardItemNode,
  footprintFlippable,
  mapTuningPatternPoints
} from './footprintFlip'
import {
  mirrorPoint,
  mirrorShape,
  mirrorTextJustify,
  selectionMirrorPoint,
  shapeExtentPoints,
  shapeMirrorPoint,
  type MirrorAxis
} from './boardMirror'
import {
  boardVertexShape,
  isVertexItemType,
  type VertexItemType,
  type VertexShape
} from './graphicVertices'
import { boardDeltaInFootprint, footprintTextOf } from './footprintChildren'
import { boardCollection } from './pcbPropertySchema'
import { copyBoardItems, prepareBoardPaste } from './pcbClipboard'

type Pt = { x: Nm; y: Nm }

/** A selected item as the board editor names it (`BoardScene.BoardItemRef`). */
export interface SelectionRef {
  type: string
  index: number
  child?: number
}

// ---------------------------------------------------------------------------
// Move
// ---------------------------------------------------------------------------

/** The item types whose every position moves as one (`translateGraphicInAST`). */
const EXTRA_GRAPHIC_TYPES = new Set(['gr_curve', 'gr_text_box', 'table', 'point'])

/** Where an item stood when a move began: a move lands it at this plus the delta. */
export interface MoveElement {
  type: string
  index: number
  child?: number
  pos?: { x: number; y: number }
  start?: { x: number; y: number }
  mid?: { x: number; y: number }
  end?: { x: number; y: number }
  center?: { x: number; y: number }
  points?: Array<{ x: number; y: number }>
}

/** Where each item of a selection stands now: what a move shifts by its delta. */
export const snapshotMoveElements = (b: KicadBoard, refs: readonly SelectionRef[]): MoveElement[] =>
  refs
    .map(({ type, index, child }) => {
      // A footprint's field or text: its position in the footprint's frame.
      if (type === 'fp_field' || type === 'fp_text') {
        const at = footprintTextOf(b, { type, index, child })?.item.position
        return at ? { type, index, child, pos: { ...at } } : null
      }
      // Moved by the final delta alone, so nothing to snapshot.
      if (EXTRA_GRAPHIC_TYPES.has(type))
        return boardCollection(b, type)?.[index] ? { type, index } : null
      switch (type) {
        // Moved by the final delta alone (T4).
        case 'tuning_pattern':
          return b.tuningPatterns[index] ? { type, index } : null
        case 'footprint': {
          const fp = b.footprints[index]
          return fp ? { type, index, pos: { ...fp.position } } : null
        }
        case 'segment': {
          const seg = b.segments[index]
          return seg ? { type, index, start: { ...seg.start }, end: { ...seg.end } } : null
        }
        case 'tarc': {
          const arc = b.trackArcs[index]
          return arc
            ? { type, index, start: { ...arc.start }, mid: { ...arc.mid }, end: { ...arc.end } }
            : null
        }
        case 'via': {
          const via = b.vias[index]
          return via ? { type, index, pos: { ...via.position } } : null
        }
        case 'zone': {
          const zone = b.zones[index]
          return zone ? { type, index, points: zone.points.map((p) => ({ ...p })) } : null
        }
        case 'gr_line': {
          const line = b.grLines[index]
          return line ? { type, index, start: { ...line.start }, end: { ...line.end } } : null
        }
        case 'gr_arc': {
          const arc = b.grArcs[index]
          return arc
            ? { type, index, start: { ...arc.start }, mid: { ...arc.mid }, end: { ...arc.end } }
            : null
        }
        case 'gr_circle': {
          const circle = b.grCircles[index]
          return circle
            ? { type, index, center: { ...circle.center }, end: { ...circle.end } }
            : null
        }
        case 'gr_rect': {
          const rect = b.grRects[index]
          return rect ? { type, index, start: { ...rect.start }, end: { ...rect.end } } : null
        }
        case 'gr_poly': {
          const poly = b.grPolys[index]
          return poly ? { type, index, points: poly.points.map((p) => ({ ...p })) } : null
        }
        case 'gr_text': {
          const text = b.grTexts[index]
          return text && text.position ? { type, index, pos: { ...text.position } } : null
        }
      }
      return null
    })
    .filter(Boolean) as MoveElement[]

/** Land each snapshotted item `fdx, fdy` nm from where it stood. */
export function moveElements(
  b: KicadBoard,
  elements: readonly MoveElement[],
  fdx: number,
  fdy: number
): void {
  const by = (p: { x: number; y: number }): Pt => ({ x: nm(p.x + fdx), y: nm(p.y + fdy) })
  for (const item of elements) {
    const { type, index } = item
    const owned = footprintTextOf(b, item)
    if (owned && item.pos) {
      // The footprint is the board's top-level node: dirty it so it reserializes.
      markNodeDirty(owned.footprint.footprint._raw)
      // The board move, turned into the footprint's frame its text is kept in.
      const d = boardDeltaInFootprint(owned.footprint, fdx, fdy)
      const position = { ...item.pos, x: nm(item.pos.x + d.x), y: nm(item.pos.y + d.y) }
      if (owned.kind === 'field') updatePropertyInAST(owned.item, { position })
      else updateTextInAST(owned.item, { position })
    } else if (type === 'tuning_pattern') {
      const pattern = b.tuningPatterns[index]
      if (pattern) {
        markNodeDirty(pattern._raw)
        mapTuningPatternPoints(pattern._raw, by)
      }
    } else if (type === 'footprint' && item.pos) {
      const fp = b.footprints[index]
      if (fp) moveBoardFootprintInAST(fp, nm(item.pos.x + fdx), nm(item.pos.y + fdy))
    } else if (type === 'segment' && item.start && item.end) {
      const seg = b.segments[index]
      if (seg) updateSegmentInAST(seg, { start: by(item.start), end: by(item.end) })
    } else if (type === 'tarc' && item.start && item.mid && item.end) {
      const arc = b.trackArcs[index]
      if (arc)
        updateTrackArcInAST(arc, { start: by(item.start), mid: by(item.mid), end: by(item.end) })
    } else if (type === 'via' && item.pos) {
      const via = b.vias[index]
      if (via) updateViaInAST(via, { position: by(item.pos) })
    } else if (type === 'zone' && item.points) {
      const zone = b.zones[index]
      if (zone) {
        // Restore the snapshot, then translate once by the final delta
        zone.points = item.points.map((p) => ({ x: nm(p.x), y: nm(p.y) }))
        translateBoardZoneInAST(zone, nm(fdx), nm(fdy))
      }
    } else if (type === 'gr_line' && item.start && item.end) {
      const line = b.grLines[index]
      if (line) updateLineInAST(line, { start: by(item.start), end: by(item.end) })
    } else if (type === 'gr_arc' && item.start && item.mid && item.end) {
      const arc = b.grArcs[index]
      if (arc) updateArcInAST(arc, { start: by(item.start), mid: by(item.mid), end: by(item.end) })
    } else if (type === 'gr_circle' && item.center && item.end) {
      const circle = b.grCircles[index]
      if (circle) updateCircleInAST(circle, { center: by(item.center), end: by(item.end) })
    } else if (type === 'gr_rect' && item.start && item.end) {
      const rect = b.grRects[index]
      if (rect) updateRectInAST(rect, { start: by(item.start), end: by(item.end) })
    } else if (type === 'gr_poly' && item.points) {
      const poly = b.grPolys[index]
      if (poly) updatePolyInAST(poly, { points: item.points.map(by) })
    } else if (EXTRA_GRAPHIC_TYPES.has(type)) {
      const extra = boardCollection(b, type)?.[index] as KicadExtraGraphic | undefined
      if (extra) translateGraphicInAST(extra, nm(fdx), nm(fdy))
    } else if (type === 'gr_text' && item.pos) {
      const text = b.grTexts[index]
      if (text && text.position) {
        text.position = { ...text.position, x: nm(item.pos.x + fdx), y: nm(item.pos.y + fdy) }
        setAtChild(text._raw as SExprList, text.position.x, text.position.y, text.position.angle)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Rotate and flip
// ---------------------------------------------------------------------------

/** What turns as a unit about the pivot: footprints and the items that turn as nodes. */
export const rotateUnits = <T extends SelectionRef>(refs: readonly T[]): T[] =>
  refs.filter((i) => i.type === 'footprint' || NODE_TRANSFORM_TYPES.has(i.type))

/**
 * Turn a selection `degrees` about `center`: footprints through their own
 * mutators, other items as new nodes. A footprint's own field or text turns
 * about itself (its angle is absolute), with or without a center.
 */
export function rotateBoardItems(
  b: KicadBoard,
  refs: readonly SelectionRef[],
  center: Pt | null,
  degrees: number
): void {
  const units = rotateUnits(refs)
  const texts = refs.flatMap((ref) => footprintTextOf(b, ref) ?? [])
  for (const ref of center ? units : []) {
    if (ref.type === 'footprint') {
      const bfp = b.footprints[ref.index]
      if (!bfp) continue
      const at = rotateAbout(bfp.position, center!, degrees)
      moveBoardFootprintInAST(bfp, nm(at.x), nm(at.y))
      rotateBoardFootprintInAST(bfp, (bfp.position.angle ?? 0) + degrees)
      continue
    }
    const node = rawOf(b, ref)
    if (node) replaceBoardNode(b, node, rotatedBoardItemNode(node, center!, degrees))
  }
  for (const owned of texts) {
    const at = owned.item.position
    if (!at) continue
    markNodeDirty(owned.footprint.footprint._raw)
    const turned = ((((at.angle ?? 0) + degrees) % 360) + 360) % 360
    const position = { ...at, angle: turned }
    if (owned.kind === 'field') updatePropertyInAST(owned.item, { position })
    else updateTextInAST(owned.item, { position })
  }
}

/**
 * What a flip takes from a selection: the footprints that can change side (a
 * footprint holding a table cannot), the other items that flip as nodes, and
 * the two together, the unit the pivot is found over.
 */
export function flipUnits<T extends SelectionRef>(
  b: KicadBoard,
  refs: readonly T[]
): { footprints: KicadBoardFootprint[]; others: T[]; units: T[] } {
  const footprints = refs
    .filter((i) => i.type === 'footprint')
    .flatMap((i) => b.footprints[i.index] ?? [])
    .filter(footprintFlippable)
  const others = refs.filter((i) => NODE_TRANSFORM_TYPES.has(i.type))
  const units = [
    ...refs.filter((i) => i.type === 'footprint' && footprints.includes(b.footprints[i.index]!)),
    ...others
  ]
  return { footprints, others, units }
}

/** KiCad's Flip: footprints change side and the other items flip as nodes, left-right about `center`. */
export function flipBoardItems(
  b: KicadBoard,
  footprints: readonly KicadBoardFootprint[],
  others: readonly SelectionRef[],
  center: Pt
): void {
  const flipLayer = boardLayerFlipper(b.layers)
  for (const bfp of footprints) flipBoardFootprintInAST(b, bfp, center)
  for (const ref of others) {
    const node = rawOf(b, ref)
    const next = node && flippedBoardItemNode(node, center, 'leftRight', flipLayer)
    if (node && next) replaceBoardNode(b, node, next)
  }
}

// ---------------------------------------------------------------------------
// Mirror
// ---------------------------------------------------------------------------

/** Items Mirror reflects: the free shapes, board text and zones — never a footprint. */
export const MIRROR_TYPES: ReadonlySet<string> = new Set([
  'gr_line',
  'gr_arc',
  'gr_circle',
  'gr_rect',
  'gr_poly',
  'gr_text',
  'zone'
])

/** One item a mirror reflects: its shape, or a text. */
export interface MirrorEntry {
  ref: SelectionRef
  shape: VertexShape | null
  text: KicadGrText | undefined
}

/** The items of a selection that Mirror takes, read as shapes and texts. */
export const mirrorEntries = (b: KicadBoard, refs: readonly SelectionRef[]): MirrorEntry[] =>
  refs
    .filter((r) => MIRROR_TYPES.has(r.type))
    .map((ref) => ({
      ref,
      shape: isVertexItemType(ref.type) ? boardVertexShape(b, ref.type, ref.index) : null,
      text: ref.type === 'gr_text' ? b.grTexts[ref.index] : undefined
    }))

/**
 * Where a mirror reflects about: a lone item (`single`) its own position,
 * several the middle of their points snapped to `grid` (nm, 0 for none).
 */
export function mirrorCenter(
  entries: readonly MirrorEntry[],
  single: boolean,
  grid: number
): Pt | null {
  const one = single ? entries[0] : null
  if (one) {
    if (one.shape) return shapeMirrorPoint(one.shape)
    return one.text?.position ? { x: one.text.position.x, y: one.text.position.y } : null
  }
  return selectionMirrorPoint(
    entries.flatMap(({ shape, text }) =>
      shape
        ? shapeExtentPoints(shape)
        : text?.position
          ? [{ x: text.position.x, y: text.position.y }]
          : []
    ),
    grid
  )
}

/** KiCad's Mirror Horizontally / Vertically (`boardMirror.ts`) about `center`. */
export function mirrorBoardItems(
  b: KicadBoard,
  entries: readonly MirrorEntry[],
  center: Pt,
  axis: MirrorAxis
): void {
  for (const { ref, shape, text } of entries) {
    if (shape && isVertexItemType(ref.type)) {
      writeVertexShape(b, ref.type, ref.index, mirrorShape(shape, center, axis))
    } else if (text?.position) {
      const at = mirrorPoint({ x: text.position.x, y: text.position.y }, center, axis)
      const effects = text.fontEffects
      const hAlign = mirrorTextJustify(effects?.hAlign, text.position.angle, axis)
      updateGrTextInAST(text, {
        position: { ...text.position, ...at },
        ...(effects && hAlign !== effects.hAlign ? { fontEffects: { ...effects, hAlign } } : {})
      })
    }
  }
}

/** Write a reshaped item back, through the mutator its kind already has. */
export const writeVertexShape = (
  b: KicadBoard,
  type: VertexItemType,
  index: number,
  shape: VertexShape
): void => {
  if (type === 'zone' && shape.kind === 'poly') {
    const zone = b.zones[index]
    if (zone) setBoardZoneOutlineInAST(zone, shape.points)
  } else if (type === 'gr_line' && shape.kind === 'line') {
    const line = b.grLines[index]
    if (line) updateLineInAST(line, { start: shape.start, end: shape.end })
  } else if (type === 'gr_arc' && shape.kind === 'arc') {
    const arc = b.grArcs[index]
    if (arc) updateArcInAST(arc, { start: shape.start, mid: shape.mid, end: shape.end })
  } else if (type === 'gr_circle' && shape.kind === 'circle') {
    const circle = b.grCircles[index]
    if (circle) updateCircleInAST(circle, { center: shape.center, end: shape.end })
  } else if (type === 'gr_rect' && shape.kind === 'rect') {
    const rect = b.grRects[index]
    if (rect) updateRectInAST(rect, { start: shape.start, end: shape.end })
  } else if (type === 'gr_poly' && shape.kind === 'poly') {
    const poly = b.grPolys[index]
    if (poly) updatePolyInAST(poly, { points: shape.points })
  }
}

// ---------------------------------------------------------------------------
// Duplicate
// ---------------------------------------------------------------------------

/**
 * KiCad's Duplicate: the nodes copied as the clipboard copies them (unlocked,
 * nets by name) and prepared as a board-to-board paste, ready for
 * `insertIntoBoard` with the duplicate's offset.
 */
export function duplicateNodes(b: KicadBoard, raws: readonly SExprNode[]): SExprList[] {
  const names = new Map(b.nets.map((net) => [net.number, net.name]))
  return prepareBoardPaste({ kind: 'board', items: copyBoardItems(raws, names) }).nodes
}
