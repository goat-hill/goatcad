/**
 * What a click or a rubber band tests a schematic sheet item against: its real
 * outline, as KiCad's `HitTest` does — distance to the stroke for a line or an
 * unfilled shape, the interior too for a filled one, and the bounding box for
 * text and the rectangular items (text boxes, tables, images) KiCad tests that
 * way. Engine space throughout: millimeters, y-up.
 */

export interface XY {
  x: number
  y: number
}

export interface HitBox {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export type HitShape =
  /**
   * A stroked run; `closed` joins the last point to the first. A filled one
   * is inside its points, or inside `fillPolygon` when the fill is not the
   * run itself — an arc fills as a pie slice through its center.
   */
  | {
      kind: 'path'
      points: XY[]
      closed: boolean
      halfWidth: number
      filled: boolean
      fillPolygon?: XY[]
    }
  | { kind: 'circle'; center: XY; radius: number; halfWidth: number; filled: boolean }
  /** Small text-like items: anywhere in the box is the item itself. */
  | { kind: 'box'; box: HitBox }
  /** Large rectangular items (text box, table, image): their interior. */
  | { kind: 'area'; box: HitBox }

/**
 * How a point meets a shape: on its outline (`edge`, which ranks with the
 * other strokes) or only inside a filled body (`inside`, which ranks behind
 * them — a filled rectangle must not swallow the wires drawn over it).
 */
export type HitKind = 'edge' | 'inside'

export const segmentDistance = (point: XY, a: XY, b: XY): number => {
  const abx = b.x - a.x
  const aby = b.y - a.y
  const apx = point.x - a.x
  const apy = point.y - a.y
  const lengthSq = abx * abx + aby * aby
  if (lengthSq < 1e-12) return Math.hypot(apx, apy)
  const t = Math.max(0, Math.min(1, (apx * abx + apy * aby) / lengthSq))
  return Math.hypot(apx - t * abx, apy - t * aby)
}

/** Even-odd point-in-polygon; the polygon closes implicitly. */
export const pointInPolygon = (point: XY, polygon: XY[]): boolean => {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]
    const b = polygon[j]
    if (a.y > point.y !== b.y > point.y) {
      const x = ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
      if (point.x < x) inside = !inside
    }
  }
  return inside
}

const segmentsOf = (points: XY[], closed: boolean): Array<[XY, XY]> => {
  const segments: Array<[XY, XY]> = []
  for (let i = 1; i < points.length; i++) segments.push([points[i - 1], points[i]])
  if (closed && points.length > 2) segments.push([points[points.length - 1], points[0]])
  if (points.length === 1) segments.push([points[0], points[0]])
  return segments
}

const inBox = (point: XY, box: HitBox, pad: number): boolean =>
  point.x >= box.minX - pad &&
  point.x <= box.maxX + pad &&
  point.y >= box.minY - pad &&
  point.y <= box.maxY + pad

/** Whether `point` hits `shape` within `threshold`, and how. */
export function hitShape(shape: HitShape, point: XY, threshold: number): HitKind | null {
  switch (shape.kind) {
    case 'path': {
      const reach = threshold + shape.halfWidth
      for (const [a, b] of segmentsOf(shape.points, shape.closed)) {
        if (segmentDistance(point, a, b) <= reach) return 'edge'
      }
      const polygon = shape.fillPolygon ?? shape.points
      return shape.filled && polygon.length > 2 && pointInPolygon(point, polygon) ? 'inside' : null
    }
    case 'circle': {
      const distance = Math.hypot(point.x - shape.center.x, point.y - shape.center.y)
      if (Math.abs(distance - shape.radius) <= threshold + shape.halfWidth) return 'edge'
      return shape.filled && distance < shape.radius ? 'inside' : null
    }
    case 'box':
      return inBox(point, shape.box, threshold * 0.5) ? 'edge' : null
    case 'area':
      return inBox(point, shape.box, threshold * 0.5) ? 'inside' : null
  }
}

/** The box a shape's geometry spans (stroke width included). */
export function shapeBounds(shape: HitShape): HitBox {
  switch (shape.kind) {
    case 'path': {
      const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
      for (const p of shape.points) {
        box.minX = Math.min(box.minX, p.x - shape.halfWidth)
        box.minY = Math.min(box.minY, p.y - shape.halfWidth)
        box.maxX = Math.max(box.maxX, p.x + shape.halfWidth)
        box.maxY = Math.max(box.maxY, p.y + shape.halfWidth)
      }
      return box
    }
    case 'circle': {
      const r = shape.radius + shape.halfWidth
      return {
        minX: shape.center.x - r,
        minY: shape.center.y - r,
        maxX: shape.center.x + r,
        maxY: shape.center.y + r
      }
    }
    case 'box':
    case 'area':
      return shape.box
  }
}

const boxContains = (outer: HitBox, inner: HitBox): boolean =>
  inner.minX >= outer.minX &&
  inner.maxX <= outer.maxX &&
  inner.minY >= outer.minY &&
  inner.maxY <= outer.maxY

const boxesIntersect = (a: HitBox, b: HitBox): boolean =>
  a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY

/** Liang–Barsky: does segment ab pass through the box? */
const segmentCrossesBox = (a: XY, b: XY, box: HitBox): boolean => {
  let t0 = 0
  let t1 = 1
  const dx = b.x - a.x
  const dy = b.y - a.y
  const edges: Array<[number, number]> = [
    [-dx, a.x - box.minX],
    [dx, box.maxX - a.x],
    [-dy, a.y - box.minY],
    [dy, box.maxY - a.y]
  ]
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return false
      continue
    }
    const r = q / p
    if (p < 0) t0 = Math.max(t0, r)
    else t1 = Math.min(t1, r)
    if (t0 > t1) return false
  }
  return true
}

/**
 * Whether a rubber band takes the shape. A window (`crossing` false) must
 * enclose all of it; a crossing band takes whatever it touches — the stroke
 * of an outline, not the empty middle of an unfilled one, as KiCad sweeps.
 */
export function shapeInBox(shape: HitShape, box: HitBox, crossing: boolean): boolean {
  const bounds = shapeBounds(shape)
  if (!crossing) return boxContains(box, bounds)
  if (!boxesIntersect(box, bounds)) return false
  switch (shape.kind) {
    case 'path': {
      for (const [a, b] of segmentsOf(shape.points, shape.closed)) {
        if (segmentCrossesBox(a, b, box)) return true
      }
      const corner = { x: box.minX, y: box.minY }
      const polygon = shape.fillPolygon ?? shape.points
      return shape.filled && polygon.length > 2 && pointInPolygon(corner, polygon)
    }
    case 'circle': {
      const { center, radius } = shape
      const nearX = Math.max(box.minX, Math.min(center.x, box.maxX))
      const nearY = Math.max(box.minY, Math.min(center.y, box.maxY))
      const near = Math.hypot(nearX - center.x, nearY - center.y)
      if (near > radius + shape.halfWidth) return false
      if (shape.filled) return true
      const far = Math.max(
        ...[
          [box.minX, box.minY],
          [box.maxX, box.minY],
          [box.maxX, box.maxY],
          [box.minX, box.maxY]
        ].map(([x, y]) => Math.hypot(x - center.x, y - center.y))
      )
      return far >= radius - shape.halfWidth
    }
    case 'box':
    case 'area':
      return true
  }
}

/** The circle through three points, or null when they are collinear. */
export const circleThroughPoints = (a: XY, b: XY, c: XY): { center: XY; radius: number } | null => {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y))
  if (Math.abs(d) < 1e-9) return null
  const aa = a.x * a.x + a.y * a.y
  const bb = b.x * b.x + b.y * b.y
  const cc = c.x * c.x + c.y * c.y
  const center = {
    x: (aa * (b.y - c.y) + bb * (c.y - a.y) + cc * (a.y - b.y)) / d,
    y: (aa * (c.x - b.x) + bb * (a.x - c.x) + cc * (b.x - a.x)) / d
  }
  return { center, radius: Math.hypot(a.x - center.x, a.y - center.y) }
}

const positiveSweep = (from: number, to: number): number => {
  let sweep = to - from
  while (sweep < 0) sweep += Math.PI * 2
  return sweep
}

/**
 * A three-point arc flattened from start through mid to end, or null when the
 * points are collinear (the caller strokes the chord). One definition for the
 * stroke, the fill and the hit-test, so none can describe a different curve.
 */
export function arcPath(start: XY, mid: XY, end: XY): { points: XY[]; center: XY } | null {
  const circle = circleThroughPoints(start, mid, end)
  if (!circle) return null
  const startAngle = Math.atan2(start.y - circle.center.y, start.x - circle.center.x)
  const midAngle = Math.atan2(mid.y - circle.center.y, mid.x - circle.center.x)
  const endAngle = Math.atan2(end.y - circle.center.y, end.x - circle.center.x)
  const ccw = positiveSweep(startAngle, endAngle)
  const useCcw = positiveSweep(startAngle, midAngle) <= ccw
  const sweep = useCcw ? ccw : ccw - Math.PI * 2
  const segments = Math.max(8, Math.ceil(Math.abs(sweep) / (Math.PI / 16)))
  const points: XY[] = [start]
  for (let i = 1; i <= segments; i++) {
    const angle = startAngle + (sweep * i) / segments
    points.push({
      x: circle.center.x + Math.cos(angle) * circle.radius,
      y: circle.center.y + Math.sin(angle) * circle.radius
    })
  }
  return { points, center: circle.center }
}
