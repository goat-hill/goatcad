/**
 * Drilled holes, as the 2D board and footprint views draw them.
 *
 * A hole is three concentric shapes: the copper it bores through, a wall in
 * the plating color, and the bore itself painted in the canvas color so it
 * reads as a void rather than a filled disc. The wall is what tells a plated
 * hole from an `np_thru_hole`, which is the same distinction KiCad draws with
 * its separate hole-wall layers.
 */

import * as THREE from 'three'
import type { KicadDrill, KicadPad } from '../kicad/footprint'
import { themeColor } from '../theme'
import { nmToMm } from '../kicad/coordinates'

/** A drill as a rounded rect: circular drills are the square case. */
export interface HoleShape {
  /** Scene-space offset from the pad center — a drill may be offset in its pad. */
  dx: number
  dy: number
  /** How far off center it is, whatever direction — copper it eats on one side. */
  offset: number
  halfW: number
  halfH: number
  cornerR: number
}

export interface HolePalette {
  /** The bore: the canvas seen through the board. */
  bore: THREE.Color
  /** Plating in a plated barrel — a thru-hole pad or a via. */
  plated: THREE.Color
  /** Bare laminate in an unplated barrel (`np_thru_hole`). */
  unplated: THREE.Color
  /** A via the router has not placed yet: no layer's copper, since it spans none so far. */
  pendingVia: THREE.Color
}

export const holePalette = (): HolePalette => ({
  bore: new THREE.Color(themeColor('--vscode-canvas-hole', '#0b100e')),
  plated: new THREE.Color(themeColor('--vscode-canvas-hole-plated', '#c8ab63')),
  unplated: new THREE.Color(themeColor('--vscode-canvas-hole-unplated', '#8e9d95')),
  pendingVia: new THREE.Color(themeColor('--vscode-canvas-via', '#b9c2bd'))
})

/**
 * Where a pad's drill sits and what it cuts, in scene space relative to the
 * pad center. `rotation` is the pad's own scene rotation, which the drill
 * offset and an oval bore both turn with.
 */
export function padHoleShape(pad: KicadPad, rotation: number): HoleShape | null {
  if (pad.type !== 'thru_hole' && pad.type !== 'np_thru_hole') return null
  return pad.drill ? drillShape(pad.drill, rotation) : null
}

/** A plain round bore, centered — a via's drill is a single diameter. */
export const roundHole = (diameter: number): HoleShape => ({
  dx: 0,
  dy: 0,
  offset: 0,
  halfW: diameter / 2,
  halfH: diameter / 2,
  cornerR: diameter / 2
})

export function drillShape(drill: KicadDrill, rotation: number): HoleShape | null {
  // Domain nm in, scene mm out.
  const halfW = nmToMm(drill.oval ? drill.oval.width : drill.diameter) / 2
  const halfH = nmToMm(drill.oval ? drill.oval.height : drill.diameter) / 2
  if (!(halfW > 0) || !(halfH > 0)) return null

  // The offset is pad-local and y-down, like every KiCad coordinate; the
  // scenes mirror y, so it is mirrored here before the pad's rotation.
  const ox = drill.offset ? nmToMm(drill.offset.x) : 0
  const oy = drill.offset ? -nmToMm(drill.offset.y) : 0
  const cos = Math.cos(rotation)
  const sin = Math.sin(rotation)

  return {
    dx: ox * cos - oy * sin,
    dy: ox * sin + oy * cos,
    offset: Math.hypot(ox, oy),
    halfW,
    halfH,
    cornerR: Math.min(halfW, halfH)
  }
}

/** Wall thickness, in mm: proportional to the bore, legible at either extreme. */
const WALL_RATIO = 0.25
const WALL_MIN = 0.04
const WALL_MAX = 0.15
/** How much of the copper ring the wall may take before it reads as the pad. */
const WALL_ANNULUS_SHARE = 0.6

/**
 * Radial width of the wall drawn around a bore. `annulus` is the narrowest
 * copper the bore leaves behind: a pad barely wider than its drill gets a
 * proportionally thinner wall, but never a vanishing one — the wall is what
 * marks the hole's edge, and a mounting hole whose bore covers its whole pad
 * has nothing else to show for itself.
 */
export function holeWallWidth(hole: HoleShape, annulus: number): number {
  const want = Math.min(WALL_MAX, Math.max(WALL_MIN, Math.min(hole.halfW, hole.halfH) * WALL_RATIO))
  if (!(annulus > 0)) return want
  return Math.max(WALL_MIN, Math.min(want, annulus * WALL_ANNULUS_SHARE))
}

/** The narrowest copper a bore leaves around itself inside a pad this size. */
export function holeAnnulus(hole: HoleShape, padHalfW: number, padHalfH: number): number {
  return Math.min(padHalfW - hole.halfW, padHalfH - hole.halfH) - hole.offset
}
