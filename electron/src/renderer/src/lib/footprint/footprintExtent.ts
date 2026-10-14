/**
 * The boxes a footprint occupies, in its own frame: integer nanometres, y down.
 *
 * Pure and parser-only, so the agent's footprint read and the board's 3D
 * stand-ins (`engine/board3d/placementBodies.ts`) compute the same box from
 * the same rule: the courtyard is the room the part is entitled to, the fab
 * layer draws its actual outline, and pads are what is left when a footprint
 * carries neither. Text is deliberately excluded — the reference designator is
 * printed beside a part, not part of its body.
 */
import type { KicadFootprint } from '../kicad/footprint'

export interface FootprintExtent {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export const isCourtyardLayer = (layer: string | undefined): boolean => !!layer?.endsWith('.CrtYd')
export const isFabLayer = (layer: string | undefined): boolean => !!layer?.endsWith('.Fab')

const grow = (extent: FootprintExtent | null, x: number, y: number, pad = 0): FootprintExtent => ({
  minX: Math.min(extent?.minX ?? Infinity, x - pad),
  minY: Math.min(extent?.minY ?? Infinity, y - pad),
  maxX: Math.max(extent?.maxX ?? -Infinity, x + pad),
  maxY: Math.max(extent?.maxY ?? -Infinity, y + pad)
})

/** Extent of the graphics on the layers `accept` picks. */
export function graphicsExtent(
  fp: KicadFootprint,
  accept: (layer: string | undefined) => boolean
): FootprintExtent | null {
  let extent: FootprintExtent | null = null
  for (const line of fp.fpLines) {
    if (!accept(line.layer)) continue
    extent = grow(grow(extent, line.start.x, line.start.y), line.end.x, line.end.y)
  }
  for (const arc of fp.fpArcs) {
    if (!accept(arc.layer)) continue
    extent = grow(
      grow(grow(extent, arc.start.x, arc.start.y), arc.mid.x, arc.mid.y),
      arc.end.x,
      arc.end.y
    )
  }
  for (const circle of fp.fpCircles) {
    if (!accept(circle.layer)) continue
    const r = Math.hypot(circle.end.x - circle.center.x, circle.end.y - circle.center.y)
    extent = grow(extent, circle.center.x, circle.center.y, r)
  }
  for (const rect of fp.fpRects) {
    if (!accept(rect.layer)) continue
    extent = grow(grow(extent, rect.start.x, rect.start.y), rect.end.x, rect.end.y)
  }
  for (const poly of fp.fpPolys) {
    if (!accept(poly.layer)) continue
    for (const point of poly.points) extent = grow(extent, point.x, point.y)
  }
  return extent
}

/** Just the pads — the last resort, and never empty for a real part. Half the
 *  longer side, so a rotated pad still fits inside its own box. */
export function padExtent(fp: KicadFootprint): FootprintExtent | null {
  let extent: FootprintExtent | null = null
  for (const pad of fp.pads) {
    extent = grow(extent, pad.position.x, pad.position.y, Math.max(pad.size.w, pad.size.h) / 2)
  }
  return extent
}

/** The three boxes an agent reads, each null when the footprint draws none. */
export const footprintExtents = (
  fp: KicadFootprint
): {
  courtyard: FootprintExtent | null
  fab: FootprintExtent | null
  pads: FootprintExtent | null
} => ({
  courtyard: graphicsExtent(fp, isCourtyardLayer),
  fab: graphicsExtent(fp, isFabLayer),
  pads: padExtent(fp)
})
