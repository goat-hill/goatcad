/**
 * A finding's `targets` — uuids — as the board editor's selection
 * (`BoardItemRef`, ARCHITECTURE §3.7). A pad's finding names its footprint,
 * since pads are not selectable on the board, and so does a footprint's zone;
 * an id nothing carries is dropped.
 */
import { allZones, type KicadBoard } from '../kicad/board'
import { nmToMm, type Nm } from '../kicad/coordinates'
import type { BoardItemRef } from '../engine/BoardScene'

const LISTS: Array<[type: string, items: (board: KicadBoard) => ReadonlyArray<{ uuid?: string }>]> =
  [
    ['footprint', (board) => board.footprints],
    ['segment', (board) => board.segments],
    ['tarc', (board) => board.trackArcs],
    ['via', (board) => board.vias],
    ['zone', (board) => board.zones],
    ['gr_line', (board) => board.grLines],
    ['gr_arc', (board) => board.grArcs],
    ['gr_circle', (board) => board.grCircles],
    ['gr_rect', (board) => board.grRects],
    ['gr_poly', (board) => board.grPolys],
    ['gr_text', (board) => board.grTexts]
  ]

export const locateBoardItems = (board: KicadBoard, uuids: readonly string[]): BoardItemRef[] => {
  const wanted = new Set(uuids)
  const selection: BoardItemRef[] = []
  for (const [type, items] of LISTS) {
    items(board).forEach((item, index) => {
      if (item.uuid && wanted.has(item.uuid)) selection.push({ type, index })
    })
  }
  // A footprint's zone selects its footprint, as in KiCad.
  board.footprints.forEach((footprint, index) => {
    if (selection.some((ref) => ref.type === 'footprint' && ref.index === index)) return
    if (footprint.footprint.zones.some((zone) => zone.uuid && wanted.has(zone.uuid)))
      selection.push({ type: 'footprint', index })
  })
  return selection
}

/** Where a located item is, in board millimeters (y down), for bringing it into view. */
export const boardItemPosition = (
  board: KicadBoard,
  ref: BoardItemRef
): { x: number; y: number } | null => {
  const mm = (p: { x: number; y: number }): { x: number; y: number } => ({
    x: nmToMm(p.x as Nm),
    y: nmToMm(p.y as Nm)
  })
  switch (ref.type) {
    case 'footprint':
      return board.footprints[ref.index] ? mm(board.footprints[ref.index].position) : null
    case 'via':
      return board.vias[ref.index] ? mm(board.vias[ref.index].position) : null
    case 'segment': {
      const seg = board.segments[ref.index]
      return seg ? mm({ x: (seg.start.x + seg.end.x) / 2, y: (seg.start.y + seg.end.y) / 2 }) : null
    }
    case 'tarc':
      return board.trackArcs[ref.index] ? mm(board.trackArcs[ref.index].mid) : null
    case 'zone': {
      const first = allZones(board)[ref.index]?.points[0]
      return first ? mm(first) : null
    }
    default:
      return null
  }
}
