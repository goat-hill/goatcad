/**
 * The one KiCad placement transform: board file coordinates → the y-up world
 * every consumer works in — and, since the coordinate-units migration, the
 * one nm→mm boundary on the board side.
 *
 * The domain model is integer nanometers, y-down; the fabrication writers
 * (Gerber/Excellon), the spatial index, the router, zone fill and the 3D board
 * scene are all millimeters, y-up — so these helpers scale by 1e-6 and negate
 * y. Keeping one implementation is what makes a via flash and its drill hit
 * land on the same point, and what makes an exported layer match the board on
 * screen — the 2D `BoardScene.tfPoint` is the same math, expressed against its
 * own batch.
 */

import type { KicadBoardFootprint } from '../kicad/board'
import { NM_PER_MM, type Nm } from '../kicad/coordinates'

/** A world-space point: millimeters, y-up. */
export interface Pt {
  x: number
  y: number
}

/** World-mm translation + rotation for a placed footprint. */
export interface FpTransform {
  tx: number
  ty: number
  cos: number
  sin: number
}

/** Placement transform for a footprint (nm board space → y-up mm world). */
export function footprintTransform(bfp: KicadBoardFootprint): FpTransform {
  const angleRad = ((bfp.position.angle ?? 0) * Math.PI) / 180
  return {
    tx: bfp.position.x / NM_PER_MM,
    ty: -bfp.position.y / NM_PER_MM,
    cos: Math.cos(angleRad),
    sin: Math.sin(angleRad)
  }
}

/**
 * Map a footprint-local KiCad point (nm, x right, y down, unrotated) to world
 * mm. Identical to BoardScene.tfPoint.
 */
export function tfPoint(tf: FpTransform, x: Nm, y: Nm): Pt {
  const sx = x / NM_PER_MM
  const sy = -y / NM_PER_MM
  return { x: tf.tx + sx * tf.cos - sy * tf.sin, y: tf.ty + sx * tf.sin + sy * tf.cos }
}

/** A board-absolute domain point (nm, y-down) → world (mm, y-up). */
export const worldPoint = (p: { x: Nm; y: Nm }): Pt => ({
  x: p.x / NM_PER_MM,
  y: -p.y / NM_PER_MM
})

/**
 * Map a pad-local offset (nm, relative to the pad center, KiCad frame) to
 * world mm, given the pad's already-transformed center and its absolute angle.
 * Mirrors BoardScene's pad-local transform, so rotated pad outlines match.
 */
export function padLocal(center: Pt, cos: number, sin: number, x: Nm, y: Nm): Pt {
  const mx = x / NM_PER_MM
  const my = y / NM_PER_MM
  return { x: center.x + mx * cos + my * sin, y: center.y + mx * sin - my * cos }
}
