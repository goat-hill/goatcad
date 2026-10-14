/**
 * Stand-in bodies for parts that have no 3D model to load.
 *
 * A linked `(model …)` resolves only when the referenced library is actually
 * installed, so on most machines a board renders as bare copper with nothing
 * standing on it. For judging placement — how much room is between two parts,
 * what hangs over an edge — that is the wrong answer to give: the part is
 * there, we just cannot draw its likeness.
 *
 * So we draw its footprint instead. The courtyard is the region KiCad already
 * reserves for the part, which makes it a better clearance answer than a
 * photoreal mesh would be, and every footprint carries one. Extents are read
 * in the footprint's own KiCad frame (y-down nanometers) and converted on the
 * way out, matching `componentModels.ts`.
 */

import * as THREE from 'three'
import type { KicadBoardFootprint } from '../../kicad/board'
import type { KicadFootprint } from '../../kicad/footprint'
import { nm, nmToMm } from '../../kicad/coordinates'
import type { ComponentClass } from './componentModels'
import { EDGE_CUTS } from './boardOutline'
import type { Extent } from './footprintBoard'
import {
  graphicsExtent,
  isCourtyardLayer,
  isFabLayer,
  padExtent
} from '../../footprint/footprintExtent'

/**
 * Body heights, millimeters. A top-down orthographic view has no perspective
 * to reveal height, so these read as a shading and stacking cue rather than a
 * measurement — the same footing as the surface heights in `BoardScene3D`.
 * Through-hole parts stand taller than surface-mount because they generally do.
 */
const HEIGHT_MM: Record<ComponentClass, number> = {
  smd: 0.8,
  tht: 2.4,
  unspecified: 0.8
}

/** Below this a "courtyard" is a stray mark, not an outline worth extruding. */
const MIN_BODY_MM = 0.05

/**
 * Not every footprint is a part. Boards carry footprints that exist to mark a
 * region — a keepout, an antenna area, the board outline itself — and those
 * have courtyards the size of the area they describe, so extruding one buries
 * the board under a slab. **A part has pads**; a region marker does not, and a
 * footprint drawing its own `Edge.Cuts` is board geometry by definition.
 */
export function isPlaceablePart(fp: KicadFootprint): boolean {
  if (fp.pads.length === 0) return false
  return !fp.fpLines.some((line) => line.layer === EDGE_CUTS)
}

/**
 * The footprint's body outline, best source first: the courtyard is the room
 * the part is entitled to, the fab layer draws its actual outline, and pads
 * are what is left when a footprint carries neither.
 */
export function standInExtent(fp: KicadFootprint): Extent | null {
  if (!isPlaceablePart(fp)) return null
  return graphicsExtent(fp, isCourtyardLayer) ?? graphicsExtent(fp, isFabLayer) ?? padExtent(fp)
}

export const standInHeightMm = (cls: ComponentClass): number => HEIGHT_MM[cls]

/**
 * A placed stand-in, nested exactly like `placeComponentModel`'s result so the
 * two are interchangeable in the scene: board placement, then the back-side
 * turn-over, then the body in the footprint's own frame.
 */
export function buildStandInBody(
  bfp: KicadBoardFootprint,
  boardThickness: number,
  cls: ComponentClass,
  material: THREE.Material
): THREE.Group | null {
  const extent = standInExtent(bfp.footprint)
  if (!extent) return null

  const width = nmToMm(nm(extent.maxX - extent.minX))
  const depth = nmToMm(nm(extent.maxY - extent.minY))
  if (width < MIN_BODY_MM || depth < MIN_BODY_MM) return null
  const height = standInHeightMm(cls)

  const flipped = bfp.layer === 'B.Cu'
  const surface = boardThickness / 2

  const placement = new THREE.Group()
  placement.name = `standin:${bfp.reference ?? bfp.libId}`
  placement.position.set(
    nmToMm(bfp.position.x),
    -nmToMm(bfp.position.y),
    flipped ? -surface : surface
  )
  placement.rotation.z = THREE.MathUtils.degToRad(bfp.position.angle ?? 0)

  const side = new THREE.Group()
  if (flipped) side.rotation.x = Math.PI
  placement.add(side)

  const box = new THREE.Mesh(new THREE.BoxGeometry(width, depth, height), material)
  // The extent is y-down local; negate to reach the y-up model frame. But the
  // side group above turns a back-side body over as if it held unmirrored
  // model geometry, while a back-side footprint's locals are stored already
  // flipped — so pre-negate y once more, and the turn-over lands the box where
  // the 2D footprint draws. The box is centered on its own origin, so it lifts
  // by half its height to stand on the board rather than sink halfway into it.
  const centerY = nmToMm(nm(extent.minY + extent.maxY)) / 2
  box.position.set(
    nmToMm(nm(extent.minX + extent.maxX)) / 2,
    flipped ? centerY : -centerY,
    height / 2
  )
  side.add(box)

  return placement
}
