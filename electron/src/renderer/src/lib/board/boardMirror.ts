/**
 * Mirror for board graphics — KiCad's Mirror Horizontally / Vertically
 * (`EDIT_TOOL::Mirror`), for the free shapes, board text and zones.
 *
 * KiCad's rules, kept:
 * - One item mirrors about its own position (`updateModificationPoint`): a
 *   line's or rectangle's start, a circle's or an arc's center, a polygon's
 *   first vertex, a text's anchor. Several mirror about the grid-snapped
 *   center of their bounding box.
 * - An arc swaps its ends after mirroring, as `EDA_SHAPE::flip` does, so its
 *   start → end still runs the way KiCad draws it.
 * - Text mirrors its position and its justification, never its glyphs
 *   (`PCB_TEXT::Mirror`): the justification flips only when the text runs
 *   across the mirror axis — horizontal text for a left-right mirror, vertical
 *   text for a top-bottom one.
 * - Footprints do not mirror (KiCad flips them to the other side instead); a
 *   caller simply leaves them out.
 *
 * The bounding box is taken over the points a shape stores (an arc's three,
 * a text's anchor) rather than KiCad's exact outline; the center it gives
 * differs only for a selection bounded by an arc's bulge or a text's extent.
 *
 * Domain space throughout (integer nm, y down).
 */

import { circumscribedCircle } from '../engine/arcGeometry'
import { nm, type Nm } from '../kicad/coordinates'
import type { VertexShape } from './graphicVertices'

type Pt = { x: Nm; y: Nm }

/** `horizontal` mirrors left-right (x flips), `vertical` top-bottom (y flips). */
export type MirrorAxis = 'horizontal' | 'vertical'

export const mirrorPoint = (p: Pt, center: Pt, axis: MirrorAxis): Pt =>
  axis === 'horizontal'
    ? { x: nm(2 * center.x - p.x), y: p.y }
    : { x: p.x, y: nm(2 * center.y - p.y) }

export function mirrorShape(shape: VertexShape, center: Pt, axis: MirrorAxis): VertexShape {
  const m = (p: Pt): Pt => mirrorPoint(p, center, axis)
  switch (shape.kind) {
    case 'line':
      return { kind: 'line', start: m(shape.start), end: m(shape.end) }
    case 'rect':
      return { kind: 'rect', start: m(shape.start), end: m(shape.end) }
    case 'circle':
      return { kind: 'circle', center: m(shape.center), end: m(shape.end) }
    case 'arc':
      return { kind: 'arc', start: m(shape.end), mid: m(shape.mid), end: m(shape.start) }
    case 'poly':
      return { kind: 'poly', points: shape.points.map(m) }
    case 'tuning':
      return {
        ...shape,
        origin: m(shape.origin),
        end: m(shape.end),
        amplitude: m(shape.amplitude),
        spacing: m(shape.spacing),
        base: shape.base.map(m),
        ...(shape.tuned ? { tuned: shape.tuned.map(m) } : {})
      }
  }
}

/** The point one shape mirrors about when it is the whole selection. */
export function shapeMirrorPoint(shape: VertexShape): Pt {
  switch (shape.kind) {
    case 'line':
    case 'rect':
      return shape.start
    case 'circle':
      return shape.center
    case 'poly':
      return shape.points[0] ?? { x: nm(0), y: nm(0) }
    case 'tuning':
      return shape.origin
    case 'arc': {
      const { start: a, mid: b, end: c } = shape
      const circle = circumscribedCircle(a.x, a.y, b.x, b.y, c.x, c.y)
      // `+ 0` turns a -0 the solve can produce into the 0 a file writes.
      return circle ? { x: nm(Math.round(circle.cx) + 0), y: nm(Math.round(circle.cy) + 0) } : b
    }
  }
}

/** The points a shape's bounding box is taken over. */
export function shapeExtentPoints(shape: VertexShape): Pt[] {
  switch (shape.kind) {
    case 'line':
    case 'rect':
      return [shape.start, shape.end]
    case 'arc':
      return [shape.start, shape.mid, shape.end]
    case 'circle': {
      const r = Math.hypot(shape.end.x - shape.center.x, shape.end.y - shape.center.y)
      const { x, y } = shape.center
      return [
        { x: nm(x - r), y: nm(y - r) },
        { x: nm(x + r), y: nm(y + r) }
      ]
    }
    case 'poly':
      return shape.points
    case 'tuning':
      return [shape.origin, shape.end]
  }
}

/**
 * The center several items mirror about: their bounding box's middle, snapped
 * to `grid` (nm; 0 leaves it where it falls). Null for no points.
 */
export function selectionMirrorPoint(points: readonly Pt[], grid: number): Pt | null {
  if (points.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of points) {
    minX = Math.min(minX, p.x)
    minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x)
    maxY = Math.max(maxY, p.y)
  }
  const snap = (v: number): Nm => nm(grid > 0 ? Math.round(v / grid) * grid : v)
  return { x: snap((minX + maxX) / 2), y: snap((minY + maxY) / 2) }
}

/**
 * A text's horizontal justification after a mirror: left and right trade
 * places when the text runs across the axis, and stay otherwise. `undefined`
 * is centered, which no mirror changes.
 */
export function mirrorTextJustify(
  hAlign: 'left' | 'right' | undefined,
  angle: number | undefined,
  axis: MirrorAxis
): 'left' | 'right' | undefined {
  const a = (((angle ?? 0) % 360) + 360) % 360
  const across = axis === 'horizontal' ? a === 0 : a === 90
  if (!across || hAlign === undefined) return hAlign
  return hAlign === 'left' ? 'right' : 'left'
}
