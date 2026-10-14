/**
 * A footprint's fields and texts as board items: the ones KiCad's board editor
 * lets a click land on besides pads (`PCB_SELECTION_TOOL::Selectable`), each
 * moving and turning on its own while it stays part of its footprint.
 *
 * A board file keeps a footprint child's position relative to the footprint
 * and unrotated, and its angle absolute (`rotateBoardFootprintInAST`), so a
 * board-space position or move goes through the placement both ways here —
 * the same transform `BoardScene.tfPoint` draws with. Integer nm, y down.
 */
import type { KicadBoard, KicadBoardFootprint } from '../kicad/board'
import type { KicadFpText, KicadProperty } from '../kicad/footprint'
import { nm, type Nm } from '../kicad/coordinates'

/** A field or text, by the ref the board selects it with. */
export interface FootprintChildRef {
  type: string
  index: number
  child?: number
}

export type FootprintTextItem =
  | { kind: 'field'; footprint: KicadBoardFootprint; item: KicadProperty }
  | { kind: 'text'; footprint: KicadBoardFootprint; item: KicadFpText }

/** The field or text a ref names, or undefined for anything else or a stale ref. */
export function footprintTextOf(
  board: KicadBoard,
  ref: FootprintChildRef
): FootprintTextItem | undefined {
  const footprint = board.footprints[ref.index]
  if (!footprint || ref.child === undefined) return undefined
  if (ref.type === 'fp_field') {
    const item = footprint.footprint.properties[ref.child]
    return item ? { kind: 'field', footprint, item } : undefined
  }
  if (ref.type === 'fp_text') {
    const item = footprint.footprint.fpTexts[ref.child]
    return item ? { kind: 'text', footprint, item } : undefined
  }
  return undefined
}

/** Rounded to the nanometre, never `-0` (which would print as `-0` in a file). */
const whole = (v: number): Nm => nm(Math.round(v) + 0)

const turn = (bfp: KicadBoardFootprint): { c: number; s: number } => {
  const a = ((bfp.position.angle ?? 0) * Math.PI) / 180
  return { c: Math.cos(a), s: Math.sin(a) }
}

/** A board-space move, as the move of a child stored in this footprint's frame. */
export function boardDeltaInFootprint(
  bfp: KicadBoardFootprint,
  dx: number,
  dy: number
): { x: Nm; y: Nm } {
  const { c, s } = turn(bfp)
  return { x: whole(dx * c - dy * s), y: whole(dx * s + dy * c) }
}

/** Where a child at `local` in this footprint's frame sits on the board. */
export function footprintPointOnBoard(
  bfp: KicadBoardFootprint,
  local: { x: number; y: number }
): { x: Nm; y: Nm } {
  const { c, s } = turn(bfp)
  return {
    x: whole(bfp.position.x + local.x * c + local.y * s),
    y: whole(bfp.position.y - local.x * s + local.y * c)
  }
}

/** A board point, in this footprint's frame: `footprintPointOnBoard` undone. */
export function boardPointInFootprint(
  bfp: KicadBoardFootprint,
  point: { x: number; y: number }
): { x: Nm; y: Nm } {
  return boardDeltaInFootprint(bfp, point.x - bfp.position.x, point.y - bfp.position.y)
}
