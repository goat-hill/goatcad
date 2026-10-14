/**
 * A board's own copy of a placed footprint, as Edit footprint… opens it in
 * the footprint editor (`lib/designCopy.ts`, docs/libraries-workstream.md §5).
 *
 * A board holds a footprint placed: turned, maybe flipped to the back, its
 * rule areas board-absolute. The editor wants it as a library holds it, so
 * the copy is brought back to the origin, unturned and on the front; a write
 * places the edited footprint again exactly where and as the board had it,
 * by the same steps a placement or a swap takes (`landFootprintNode`,
 * `flippedFootprintNode`). Pads keep their nets through the round trip.
 */
import type { KicadBoard, KicadBoardFootprint } from '../kicad/board'
import { nm } from '../kicad/coordinates'
import { boardLayerFlipper } from '../kicad/layers'
import {
  cloneNodeDeep,
  findChild,
  getAtomValues,
  getToken,
  parseSExpr,
  serializeSExpr,
  type SExprList,
  type SExprNode
} from '../kicad/sexpr'
import { mapFootprintNodeZones } from './boardSync'
import { flippedFootprintNode } from './footprintFlip'
import { landFootprintNode } from './footprintPlace'

const ORIGIN = { x: nm(0), y: nm(0) }

const uuidOf = (node: SExprNode): string => {
  if (node.type !== 'list') return ''
  const uuid = findChild(node, 'uuid')
  return uuid ? (getAtomValues(uuid)[0] ?? '') : ''
}

/** A placed footprint's uuid, which names its copy (`designCopyPath`). */
export const placedFootprintUuid = (footprint: KicadBoardFootprint): string =>
  uuidOf(footprint._raw)

/** The placed footprint whose uuid is `uuid`. */
export const footprintByUuid = (board: KicadBoard, uuid: string): KicadBoardFootprint | null =>
  (uuid && board.footprints.find((footprint) => uuidOf(footprint._raw) === uuid)) || null

/** A placed footprint's node brought to the library frame: at the origin, unturned, on the front. */
function libraryFrameNode(board: KicadBoard, placed: KicadBoardFootprint): SExprList {
  let node = cloneNodeDeep(placed._raw) as SExprList
  const { x, y } = placed.position
  mapFootprintNodeZones(node, (p) => ({ x: nm(p.x - x), y: nm(p.y - y) }))
  landFootprintNode(node, ORIGIN, -(placed.position.angle ?? 0))
  if (placed.layer === 'B.Cu')
    node = flippedFootprintNode(node, ORIGIN, 'topBottom', boardLayerFlipper(board.layers))
  return node
}

/** The board's copy of the footprint with this uuid as footprint-file text; null when the board lacks it. */
export function projectFootprintCopy(board: KicadBoard, uuid: string): string | null {
  const placed = footprintByUuid(board, uuid)
  return placed ? projectPlacedCopy(board, placed) : null
}

/** A placed footprint's copy as footprint-file text, in the library frame. */
export const projectPlacedCopy = (board: KicadBoard, placed: KicadBoardFootprint): string =>
  `${serializeSExpr(libraryFrameNode(board, placed))}\n`

/**
 * Put the edited footprint back where and as the board holds it — flipped to
 * the back if it was there, turned and moved to its place — in place of the
 * board's node. False when the board lacks it or the text is not a footprint.
 */
export function writeFootprintCopy(board: KicadBoard, uuid: string, text: string): boolean {
  const placed = footprintByUuid(board, uuid)
  return placed ? writePlacedCopy(board, placed, text) : false
}

/** `writeFootprintCopy` for a placed footprint in hand; false when the text is not a footprint. */
export function writePlacedCopy(
  board: KicadBoard,
  placed: KicadBoardFootprint,
  text: string
): boolean {
  let node: SExprNode
  try {
    node = parseSExpr(text)
  } catch {
    return false
  }
  if (node.type !== 'list' || getToken(node) !== 'footprint') return false
  let fresh = node
  if (placed.layer === 'B.Cu')
    fresh = flippedFootprintNode(fresh, ORIGIN, 'topBottom', boardLayerFlipper(board.layers))
  landFootprintNode(fresh, placed.position, placed.position.angle ?? 0)
  const root = board._raw as SExprList
  const index = root.children.indexOf(placed._raw as SExprNode)
  if (index < 0) return false
  root.children[index] = fresh
  return true
}
