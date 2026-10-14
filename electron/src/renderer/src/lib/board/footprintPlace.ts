/**
 * Place Footprint: a library footprint landed on the board by hand, and the
 * ghost that follows the cursor before it lands
 * (docs/libraries-workstream.md §4). Pure; the PCB editor and the
 * agent's `board.place_footprint` both run `placeFootprintNode` inside their
 * command, and the ghost is that node too.
 *
 * The footprint is annotated (never `REF**`) and marked `board_only` — KiCad's
 * "Not in schematic" — so a sync from the schematic keeps it and schematic
 * parity does not report it.
 */
import { formatNmAtom, nm, type Nm } from '../kicad/coordinates'
import { parseKicadBoard, serializeKicadBoard, type KicadBoardFootprint } from '../kicad/board'
import { makeAtom, type KicadFootprint } from '../kicad/footprint'
import { findChild, findChildren, getAtomValues, type SExprList } from '../kicad/sexpr'
import { nextReference } from '../schematic/schematicTools'
import { flippedFootprintNode } from './footprintFlip'
import {
  instantiateLibraryFootprint,
  mapFootprintNodeZones,
  setFootprintAttributes
} from './boardSync'
import type { Point2 } from './pcbTools'

/** Designator prefixes by library, for footprints whose own reference is the bare `REF**`. */
const LIBRARY_PREFIXES: ReadonlyArray<[RegExp, string]> = [
  [/^MountingHole/i, 'H'],
  [/^TestPoint/i, 'TP'],
  [/^Fiducial/i, 'FID'],
  [/^Connector/i, 'J'],
  [/^Capacitor/i, 'C'],
  [/^Resistor/i, 'R'],
  [/^Inductor/i, 'L'],
  [/^(Diode|LED)/i, 'D'],
  [/^(Crystal|Oscillator)/i, 'Y'],
  [/^(Button_Switch|Switch)/i, 'SW'],
  [/^Fuse/i, 'F'],
  [/^Jumper/i, 'JP'],
  [/^Symbol/i, 'LOGO']
]

/** The footprint's reference text: `(property "Reference" …)`, or the older `(fp_text reference …)`. */
export const referenceNode = (node: SExprList): SExprList | null =>
  findChildren(node, 'property').find((child) => getAtomValues(child)[0] === 'Reference') ??
  findChildren(node, 'fp_text').find((child) => getAtomValues(child)[0] === 'reference') ??
  null

/** The designator prefix a placed footprint takes: its own reference's, else its library's. */
export function referencePrefix(libId: string, library: KicadFootprint): string {
  const node = referenceNode(library._raw as SExprList)
  const own = (node ? (getAtomValues(node)[1] ?? '') : '').replace(/[*?\d]+$/, '')
  if (own && own.toUpperCase() !== 'REF') return own
  const nickname = libId.split(':')[0] ?? ''
  return LIBRARY_PREFIXES.find(([pattern]) => pattern.test(nickname))?.[1] ?? 'U'
}

/** The next free reference on the board for this footprint. */
export function placedReference(
  libId: string,
  library: KicadFootprint,
  existing: readonly string[]
): string {
  return nextReference([...existing], referencePrefix(libId, library))
}

const normalizeAngle = (degrees: number): number => ((degrees % 360) + 360) % 360

const formatAngle = (degrees: number): string =>
  Number.isInteger(degrees) ? String(degrees) : degrees.toFixed(4).replace(/\.?0+$/, '')

const NUMBER = /^-?\d+(\.\d+)?$/

/** Turn an `(at x y [angle])` by `by` degrees, writing no angle for 0 as KiCad does. */
const turnAt = (at: SExprList | null, by: number): void => {
  if (!at) return
  const third = at.children[3]
  const current = third?.type === 'atom' && NUMBER.test(third.value) ? Number(third.value) : null
  const next = normalizeAngle((current ?? 0) + by)
  if (next === 0) {
    if (current !== null) at.children.splice(3, 1)
  } else if (third?.type === 'atom' && current !== null) third.value = formatAngle(next)
  else at.children.splice(3, 0, makeAtom(formatAngle(next), false, 0))
}

/** A point turned about the origin, y down as the file is: positive turns counterclockwise on screen. */
const turnPoint = (p: Point2, degrees: number): Point2 => {
  const rad = (degrees * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  return { x: p.x * cos + p.y * sin, y: -p.x * sin + p.y * cos }
}

export interface PlaceFootprint {
  libId: string
  /** Where the footprint's origin lands, board nm. */
  at: { x: Nm; y: Nm }
  /** Degrees, counterclockwise, as the footprint reads on the board, back or front. */
  angle?: number
  reference: string
  /**
   * Set to land the footprint on the back: flipped left to right about its
   * origin with the board's layer pairs (`boardLayerFlipper`).
   */
  flipLayer?: (layer: string) => string
}

/**
 * The board node for a library footprint placed by hand: instanced as sync
 * instances one, then annotated, marked board-only, turned, and flipped if it
 * goes on the back. Pad and text angles in a board file include the
 * footprint's, so they turn with it; its zones are board-absolute, so their
 * points turn about its origin.
 */
export function placeFootprintNode(library: KicadFootprint, place: PlaceFootprint): SExprList {
  const origin = { x: nm(0), y: nm(0) }
  let node = instantiateLibraryFootprint(library, place.libId, origin)
  const reference = referenceNode(node)
  if (reference?.children[2]?.type === 'atom') reference.children[2].value = place.reference
  setFootprintAttributes(node, (want) => want.add('board_only'))
  if (!place.flipLayer) {
    landFootprintNode(node, place.at, place.angle ?? 0)
    return node
  }
  // As a front footprint turned the other way and flipped where it stands
  // would read (`flippedPlacementAngle`), its texts' angles included.
  landFootprintNode(node, origin, flippedPlacementAngle(place.angle ?? 0))
  node = flippedFootprintNode(node, origin, 'leftRight', place.flipLayer)
  landFootprintNode(node, place.at, 0)
  return node
}

/**
 * The turn a footprint in hand keeps when F flips it: a left-right flip of
 * one turned by `angle` is the flipped one turned by `-angle`
 * (`FOOTPRINT::Flip`), so the flip is of what the ghost shows.
 */
export const flippedPlacementAngle = (angle: number): number => normalizeAngle(-angle)

/**
 * Turn a footprint node instanced at the origin by `degrees` and move it to
 * `at`. Pad and text angles in a board file include the footprint's, so they
 * turn with it; its zones are board-absolute, so their points turn about its
 * origin and move with it. Shared with the footprint swap (`footprintExchange.ts`).
 */
export function landFootprintNode(node: SExprList, at: { x: Nm; y: Nm }, degrees: number): void {
  const angle = normalizeAngle(degrees)
  if (angle) {
    turnAt(findChild(node, 'at'), angle)
    for (const token of ['pad', 'property', 'fp_text'])
      for (const child of findChildren(node, token)) turnAt(findChild(child, 'at'), angle)
  }
  mapFootprintNodeZones(node, (p) => {
    const turned = turnPoint(p, angle)
    return { x: nm(turned.x + at.x), y: nm(turned.y + at.y) }
  })
  const own = findChild(node, 'at')
  if (own?.children[1]?.type === 'atom' && own.children[2]?.type === 'atom') {
    own.children[1].value = formatNmAtom(at.x)
    own.children[2].value = formatNmAtom(at.y)
  }
}

// ---------------------------------------------------------------------------
// The ghost
// ---------------------------------------------------------------------------

const GHOST_BOARD = `(kicad_pcb (version 20241229) (generator "goatcad") (layers (0 "F.Cu" signal) (31 "B.Cu" signal)))`

/**
 * What follows the cursor while Place Footprint is armed: the footprint the
 * click will land — the same node, turned and annotated — at the origin, as a
 * board footprint the scene draws like any other (`BoardScene.setFootprintGhost`).
 */
export function placementFootprint(
  library: KicadFootprint,
  place: Omit<PlaceFootprint, 'at'>
): KicadBoardFootprint | null {
  const board = parseKicadBoard(GHOST_BOARD)
  const node = placeFootprintNode(library, { ...place, at: { x: nm(0), y: nm(0) } })
  ;(board._raw as SExprList).children.push(node)
  return parseKicadBoard(serializeKicadBoard(board)).footprints[0] ?? null
}
