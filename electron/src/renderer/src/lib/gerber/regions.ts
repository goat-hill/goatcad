/**
 * A parsed Gerber image as the area it covers: one set of non-overlapping
 * regions (mm, y-up), painted in item order so a clear item erases what came
 * before it. What two Gerbers of one layer are compared by — the export against
 * `kicad-cli`'s, and later one revision against another. Needs the Clipper
 * engine loaded (`loadClipper`).
 *
 * Curves become chords no more than `sag` mm inside the true edge.
 */

import { difference, merged, type ClipPt, type ClipRegion } from '../geometry/clip'
import type { GerberImage } from './parse'
import { capsuleOutline, rectOutline, tessellateArc, type GerberShape } from './shapes'

const DEFAULT_SAG = 0.001

/** Chord count for a full turn of radius `r` within `sag`. */
const segmentsFor = (r: number, sag: number): number =>
  r <= sag ? 8 : Math.max(8, Math.ceil(Math.PI / Math.acos(1 - sag / r)))

const circle = (cx: number, cy: number, r: number, sag: number): ClipPt[] => {
  const n = segmentsFor(r, sag)
  return Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * i) / n
    return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }
  })
}

/** The regions one shape covers (several for a stroked arc, one per chord). */
export function shapeRegions(shape: GerberShape, sag = DEFAULT_SAG): ClipRegion[] {
  switch (shape.kind) {
    case 'circle':
      return [{ outer: circle(shape.cx, shape.cy, shape.r, sag), holes: [] }]
    case 'ring': {
      const outer = circle(shape.cx, shape.cy, shape.radius + shape.halfStroke, sag)
      const inner = shape.radius - shape.halfStroke
      return [{ outer, holes: inner > 0 ? [circle(shape.cx, shape.cy, inner, sag)] : [] }]
    }
    case 'rect':
      return [
        {
          outer: rectOutline(shape.cx, shape.cy, shape.halfW, shape.halfH, shape.rotation),
          holes: []
        }
      ]
    case 'capsule': {
      const caps = Math.ceil(segmentsFor(shape.halfWidth, sag) / 2)
      const outline = capsuleOutline(
        { x: shape.x0, y: shape.y0 },
        { x: shape.x1, y: shape.y1 },
        shape.halfWidth,
        caps
      )
      return [{ outer: outline, holes: [] }]
    }
    case 'arc': {
      const points = tessellateArc(
        shape.cx,
        shape.cy,
        shape.radius,
        shape.startAngle,
        shape.sweep,
        sag
      )
      const caps = Math.ceil(segmentsFor(shape.halfWidth, sag) / 2)
      const out: ClipRegion[] = []
      for (let i = 1; i < points.length; i++)
        out.push({
          outer: capsuleOutline(points[i - 1], points[i], shape.halfWidth, caps),
          holes: []
        })
      return out
    }
    case 'poly':
      return [{ outer: shape.outline, holes: shape.holes }]
  }
}

/** Everything the image paints, as non-overlapping regions. */
export function gerberRegions(image: GerberImage, sag = DEFAULT_SAG): ClipRegion[] {
  let painted: ClipRegion[] = []
  let batch: ClipRegion[] = []
  let batchPolarity: 'dark' | 'clear' = 'dark'
  const flush = (): void => {
    if (batch.length === 0) return
    painted =
      batchPolarity === 'dark' ? merged([...painted, ...batch]) : difference(painted, merged(batch))
    batch = []
  }
  for (const item of image.items) {
    if (item.polarity !== batchPolarity) {
      flush()
      batchPolarity = item.polarity
    }
    batch.push(...shapeRegions(item.shape, sag))
  }
  flush()
  return painted
}
