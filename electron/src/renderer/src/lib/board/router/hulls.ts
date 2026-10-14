/**
 * Obstacle hulls for the router engine.
 *
 * A hull is an obstacle's outline inflated by `obstacle half-width +
 * clearance + routed half-width`, so the routed line — walked as a zero-width
 * centerline along the hull boundary — sits exactly at clearance. The shapes
 * follow KiCad's PNS: octagonal sweeps, always wound clockwise (in this y-up
 * world: negative signed area), because the walk kernel encodes direction as
 * ring order.
 *
 * The ε discipline (PNS's single most important robustness idea): hulls are
 * built at FULL clearance while collision tests run at `clearance − ε`, so a
 * line standing on a hull boundary can never re-collide with the hull's own
 * item and re-trigger the walk forever.
 */

import type { CopperShape, Pt } from '../spatialIndex'
import { sampleArc } from '../spatialIndex'
import type { RouteCornerMode } from '../pcbTools'
import { AXIS_NORMALS, OCTILINEAR_NORMALS, boundByDirections } from './geometry'

/** KiCad's DRC epsilon: 0.5 µm, far below manufacturable clearance. */
export const ROUTER_EPSILON = 0.0005

/** A closed ring (implicit last→first edge), clockwise in y-up space. */
export type Hull = Pt[]

/** Octagon vertex chamfer: a regular octagon with every edge at distance d. */
const chamferHalf = (d: number): number => d * (Math.SQRT2 - 1)

/**
 * Regular octagon around a point, every edge at distance `d` — circumscribes
 * the disc of radius d (vertices at d/cos 22.5°), so clearance errs safe.
 * Wound clockwise for y-up (x right, y up).
 */
export function octagonHull(cx: number, cy: number, d: number): Hull {
  const h = chamferHalf(d)
  return [
    { x: cx - h, y: cy + d },
    { x: cx + h, y: cy + d },
    { x: cx + d, y: cy + h },
    { x: cx + d, y: cy - h },
    { x: cx + h, y: cy - d },
    { x: cx - h, y: cy - d },
    { x: cx - d, y: cy - h },
    { x: cx - d, y: cy + h }
  ]
}

/**
 * Eight-point hull of a segment swept by the octagon of edge-distance `d` —
 * the Minkowski sum's convex outline in the segment's own frame (u along,
 * v across). Degenerate segments fall back to the octagon.
 */
export function segmentHull(a: Pt, b: Pt, d: number): Hull {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.hypot(dx, dy)
  if (len < 1e-9) return octagonHull(a.x, a.y, d)
  const ux = dx / len
  const uy = dy / len
  // v = u rotated +90° (CCW in y-up); with the point order below the ring
  // winds clockwise.
  const vx = -uy
  const vy = ux
  const h = chamferHalf(d)
  const pt = (base: Pt, du: number, dv: number): Pt => ({
    x: base.x + ux * du + vx * dv,
    y: base.y + uy * du + vy * dv
  })
  return [
    pt(a, -h, d),
    pt(b, h, d),
    pt(b, d, h),
    pt(b, d, -h),
    pt(b, h, -d),
    pt(a, -h, -d),
    pt(a, -d, -h),
    pt(a, -d, h)
  ]
}

/**
 * Hull of a rotated rounded rect (every pad, as the index resolves them): the
 * shrunk rect swept by the octagon of `cornerR + d`. Eight points — the
 * octagon's axis edges merge with the rect's own edges, leaving one chamfer
 * per corner. The octagon rotates with the pad, which still circumscribes
 * the swept disc, so clearance errs safe. Clockwise like every hull.
 */
export function rrectHull(
  cx: number,
  cy: number,
  halfW: number,
  halfH: number,
  cornerR: number,
  rotation: number,
  d: number
): Hull {
  const hw = Math.max(0, halfW - cornerR)
  const hh = Math.max(0, halfH - cornerR)
  const r = cornerR + d
  const h = chamferHalf(r)
  const cos = Math.cos(rotation)
  const sin = Math.sin(rotation)
  const pt = (lx: number, ly: number): Pt => ({
    x: cx + lx * cos - ly * sin,
    y: cy + lx * sin + ly * cos
  })
  if (hw < 1e-9 && hh < 1e-9) return octagonHull(cx, cy, r)
  // Local frame is y-up too; clockwise = top edge left→right, then down the
  // right side. Three octagon vertices per rect corner.
  return [
    pt(-hw - h, hh + r),
    pt(hw + h, hh + r),
    pt(hw + r, hh + h),
    pt(hw + r, -hh - h),
    pt(hw + h, -hh - r),
    pt(-hw - h, -hh - r),
    pt(-hw - r, -hh - h),
    pt(-hw - r, hh + h)
  ]
}

/**
 * The hulls a copper shape contributes. One for pads/vias/segments; an arc
 * yields one segment hull per sampled piece (the walk kernel takes hulls
 * sequentially, so a ribbon outline is not required).
 */
export function shapeHulls(
  shape: CopperShape,
  clearance: number,
  routedHalfWidth: number,
  cornerMode: RouteCornerMode = '45'
): Hull[] {
  const exact = exactHulls(shape, clearance, routedHalfWidth)
  // A route walked along a hull takes the hull's edge directions, so the
  // hull is fitted to the corner mode: every edge at a multiple of 45° (or
  // 90°), grown just enough to still contain the exact outline.
  if (cornerMode === 'free') return exact
  const normals = cornerMode === '90' ? AXIS_NORMALS : OCTILINEAR_NORMALS
  return exact.map((h) => boundByDirections(h, normals))
}

function exactHulls(shape: CopperShape, clearance: number, routedHalfWidth: number): Hull[] {
  switch (shape.kind) {
    case 'capsule': {
      const d = shape.halfWidth + clearance + routedHalfWidth
      return [segmentHull({ x: shape.x0, y: shape.y0 }, { x: shape.x1, y: shape.y1 }, d)]
    }
    case 'circle': {
      const d = shape.r + clearance + routedHalfWidth
      return [octagonHull(shape.cx, shape.cy, d)]
    }
    case 'rrect': {
      const d = clearance + routedHalfWidth
      return [
        rrectHull(shape.cx, shape.cy, shape.halfW, shape.halfH, shape.cornerR, shape.rotation, d)
      ]
    }
    case 'arc': {
      const d = shape.halfWidth + clearance + routedHalfWidth
      const pts = sampleArc(shape.x0, shape.y0, shape.mx, shape.my, shape.x1, shape.y1, 12)
      const hulls: Hull[] = []
      for (let i = 0; i < pts.length - 1; i++) hulls.push(segmentHull(pts[i], pts[i + 1], d))
      return hulls
    }
    case 'poly': {
      // Each edge as a segment hull, as an arc's pieces are.
      const d = clearance + routedHalfWidth
      const hulls: Hull[] = []
      for (const ring of shape.rings)
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++)
          hulls.push(segmentHull(ring[j], ring[i], d))
      return hulls
    }
    case 'compound':
      return shape.parts.flatMap((part) => exactHulls(part, clearance, routedHalfWidth))
  }
}

/**
 * One convex outline round a set of points, fitted to the corner mode as a
 * hull is: an area obstacle walked round as a whole.
 */
export function convexOutline(points: readonly Pt[], cornerMode: RouteCornerMode): Hull {
  if (cornerMode === '45') return boundByDirections(points, OCTILINEAR_NORMALS)
  if (cornerMode === '90') return boundByDirections(points, AXIS_NORMALS)
  return convexHull(points)
}

/** Andrew's monotone chain, wound clockwise (y up). */
function convexHull(points: readonly Pt[]): Hull {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y)
  if (sorted.length < 3) return sorted
  const cross = (o: Pt, a: Pt, b: Pt): number =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
  const half = (pts: readonly Pt[]): Pt[] => {
    const out: Pt[] = []
    for (const p of pts) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], p) >= 0) out.pop()
      out.push(p)
    }
    out.pop()
    return out
  }
  // Keeping right turns only gives the clockwise chain.
  return [...half(sorted), ...half([...sorted].reverse())]
}
