/**
 * A pad's copper as the polygon KiCad's length calculator clips tracks
 * against (`PAD::GetEffectivePolygon(layer, ERROR_INSIDE)`): every curve cut
 * in chords whose vertices lie on it, so the polygon sits just inside the
 * true shape, in KiCad's integer coordinates. Round, oval, rectangular and
 * rounded-rectangle pads are built as KiCad builds them
 * (`TransformCircleToPolygon`, `TransformOvalToPolygon`,
 * `TransformRoundChamferedRectToPolygon`); a chamfered, trapezoid or custom
 * pad is none of these, and the caller falls back to the exact shape.
 * Coordinates are the file's: integer nanometers, y down.
 */
import type { KicadPad } from '../kicad/footprint'

export interface IPt {
  x: number
  y: number
}

/** KiCad's `KiROUND`: half away from zero. */
const kiRound = (v: number): number => (v < 0 ? -Math.round(-v) : Math.round(v))

/** KiCad's `RotatePoint` on integers, y down: exact at right angles, else rounded. */
export function rotatePoint(p: IPt, degrees: number): IPt {
  let a = degrees % 360
  if (a < 0) a += 360
  if (a === 0) return { x: p.x, y: p.y }
  if (a === 90) return { x: p.y, y: -p.x }
  if (a === 180) return { x: -p.x, y: -p.y }
  if (a === 270) return { x: -p.y, y: p.x }
  const rad = (a * Math.PI) / 180
  const s = Math.sin(rad)
  const c = Math.cos(rad)
  return { x: kiRound(p.y * s + p.x * c), y: kiRound(p.y * c - p.x * s) }
}

/** KiCad's `GetArcToSegmentCount` for a full turn. */
function segmentCount(radius: number, error: number): number {
  const r = Math.max(1, radius)
  const e = Math.max(1, error)
  const increment = Math.min(360 / 8, (180 / Math.PI) * Math.acos(1 - e / r) * 2)
  return Math.max(kiRound(360 / increment), 2)
}

/** KiCad's `VECTOR2I::Resize` on integers. */
function resize(v: IPt, length: number): IPt {
  if (v.x === 0 && v.y === 0) return { x: 0, y: 0 }
  let nx: number
  let ny: number
  if (Math.abs(v.x) === Math.abs(v.y)) nx = ny = Math.abs(length) * Math.SQRT1_2
  else {
    const l2 = v.x * v.x + v.y * v.y
    const n2 = length * length
    nx = Math.sqrt(Math.round((n2 * v.x * v.x) / l2))
    ny = Math.sqrt(Math.round((n2 * v.y * v.y) / l2))
  }
  const sign = length < 0 ? -1 : 1
  return {
    x: (v.x < 0 ? -kiRound(nx) : kiRound(nx)) * sign,
    y: (v.y < 0 ? -kiRound(ny) : kiRound(ny)) * sign
  }
}

/** The point mirrored across the line through a and b (`SEG::ReflectPoint`). */
function reflect(a: IPt, b: IPt, p: IPt): IPt {
  const d = { x: b.x - a.x, y: b.y - a.y }
  const l2 = d.x * d.x + d.y * d.y
  if (!l2) return p
  const t = d.x * (p.x - a.x) + d.y * (p.y - a.y)
  const c = { x: a.x + kiRound((t * d.x) / l2), y: a.y + kiRound((t * d.y) / l2) }
  return { x: 2 * c.x - p.x, y: 2 * c.y - p.y }
}

function circle(center: IPt, radius: number, error: number): IPt[] {
  let n = Math.max(16, segmentCount(radius, error))
  n = Math.ceil(n / 8) * 8
  const delta = 360 / n
  const out: IPt[] = []
  for (let angle = delta / 2; angle < 360; angle += delta) {
    const p = rotatePoint({ x: radius, y: 0 }, angle)
    out.push({ x: p.x + center.x, y: p.y + center.y })
  }
  return out
}

function oval(start: IPt, end: IPt, width: number, error: number): IPt[] {
  const radius = Math.trunc(width / 2)
  let n = Math.max(16, segmentCount(radius, error))
  n = Math.ceil(n / 8) * 8
  const delta = 360 / n
  let endp = { x: end.x - start.x, y: end.y - start.y }
  let origin = start
  if (endp.x < 0) {
    endp = { x: start.x - end.x, y: start.y - end.y }
    origin = end
  }
  const turn = (Math.atan2(endp.y, endp.x) * 180) / Math.PI
  const len = kiRound(Math.hypot(endp.x, endp.y))
  const local: IPt[] = [{ x: len, y: radius }]
  for (let angle = delta / 2; angle < 180; angle += delta) {
    const p = rotatePoint({ x: 0, y: radius }, angle)
    local.push({ x: p.x + len, y: p.y })
  }
  local.push({ x: len, y: -radius }, { x: 0, y: -radius })
  for (let angle = delta / 2; angle < 180; angle += delta)
    local.push(rotatePoint({ x: 0, y: -radius }, angle))
  local.push({ x: 0, y: radius })
  return local.map((p) => {
    const q = rotatePoint(p, -turn)
    return { x: q.x + origin.x, y: q.y + origin.y }
  })
}

/** A rectangle with every corner rounded by `radius` (`CornerListToPolygon`, error inside). */
function roundRect(
  center: IPt,
  w: number,
  h: number,
  angle: number,
  radius: number,
  error: number
): IPt[] {
  const sx = Math.trunc(w / 2)
  const sy = Math.trunc(h / 2)
  const corners: IPt[] = [
    { x: -sx, y: -sy },
    { x: sx, y: -sy },
    { x: sx, y: sy },
    { x: -sx, y: sy }
  ]
  const out: IPt[] = []
  let incoming = { x: corners[0].x - corners[3].x, y: corners[0].y - corners[3].y }
  for (let i = 0; i < 4; i++) {
    const cur = corners[i]
    const next = corners[(i + 1) % 4]
    const outgoing = { x: next.x - cur.x, y: next.y - cur.y }
    if (!radius) out.push(cur)
    else {
      const n = Math.max(16, segmentCount(radius, error))
      const delta = 360 / n
      let lastSeg = 90
      while (lastSeg > delta) lastSeg -= delta
      let angPos = lastSeg === 0 ? delta : (delta + lastSeg) / 2
      const start = { x: cur.x - resize(incoming, radius).x, y: cur.y - resize(incoming, radius).y }
      const perp = resize({ x: -incoming.y, y: incoming.x }, radius)
      const arcCenter = { x: start.x + perp.x, y: start.y + perp.y }
      const end = reflect(cur, arcCenter, start)
      const origin = { x: start.x - arcCenter.x, y: start.y - arcCenter.y }
      out.push(start)
      for (; angPos < 90; angPos += delta) {
        const p = rotatePoint(origin, -angPos)
        out.push({ x: p.x + arcCenter.x, y: p.y + arcCenter.y })
      }
      out.push(end)
    }
    incoming = outgoing
  }
  return out.map((p) => {
    const q = rotatePoint(p, angle)
    return { x: q.x + center.x, y: q.y + center.y }
  })
}

/**
 * A pad's copper on one layer (`onLayer`: its padstack's entry there) as
 * KiCad's error-inside polygon, placed at `position` (its anchor, board nm)
 * turned by its board angle; null for a shape built otherwise.
 */
export function padPolygon(onLayer: KicadPad, position: IPt, maxError: number): IPt[] | null {
  const angle = onLayer.position.angle ?? 0
  const offset = onLayer.drill?.offset
  const shift = offset ? rotatePoint({ x: offset.x, y: offset.y }, angle) : { x: 0, y: 0 }
  const center = { x: position.x + shift.x, y: position.y + shift.y }
  const dx = Math.trunc(onLayer.size.w / 2)
  const dy = Math.trunc(onLayer.size.h / 2)
  switch (onLayer.shape) {
    case 'circle':
      return circle(center, dx, maxError)
    case 'oval': {
      if (dx === dy) return circle(center, dx, maxError)
      const half = Math.min(dx, dy)
      const d = rotatePoint({ x: dx - half, y: dy - half }, angle)
      return oval(
        { x: center.x - d.x, y: center.y - d.y },
        { x: center.x + d.x, y: center.y + d.y },
        half * 2,
        maxError
      )
    }
    case 'rect':
      // A named chamfer, even at a ratio of 0, makes it a chamfered rect, built otherwise.
      if (onLayer.chamfer?.length) return null
      return roundRect(center, onLayer.size.w, onLayer.size.h, angle, 0, maxError)
    case 'roundrect': {
      if (onLayer.chamfer?.length) return null
      const radius = kiRound(
        Math.min(onLayer.size.w, onLayer.size.h) * (onLayer.roundrectRatio ?? 0)
      )
      return roundRect(center, onLayer.size.w, onLayer.size.h, angle, radius, maxError)
    }
    default:
      return null
  }
}

/** Whether a point lies in a polygon, its edge included (even-odd). */
export function inPolygon(ring: readonly IPt[], p: IPt): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]
    const b = ring[j]
    // On an edge counts as inside.
    const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)
    if (
      cross === 0 &&
      p.x >= Math.min(a.x, b.x) &&
      p.x <= Math.max(a.x, b.x) &&
      p.y >= Math.min(a.y, b.y) &&
      p.y <= Math.max(a.y, b.y)
    )
      return true
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x)
      inside = !inside
  }
  return inside
}

/** Where the segment from `outside` to `inside` first meets a polygon's edge, rounded. */
export function polygonCrossing(ring: readonly IPt[], outside: IPt, inside: IPt): IPt | null {
  let best: IPt | null = null
  let bestT = Infinity
  const r = { x: inside.x - outside.x, y: inside.y - outside.y }
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j]
    const b = ring[i]
    const s = { x: b.x - a.x, y: b.y - a.y }
    const denom = r.x * s.y - r.y * s.x
    if (denom === 0) continue
    const qp = { x: a.x - outside.x, y: a.y - outside.y }
    const t = (qp.x * s.y - qp.y * s.x) / denom
    const u = (qp.x * r.y - qp.y * r.x) / denom
    if (t < 0 || t > 1 || u < 0 || u > 1) continue
    if (t < bestT) {
      bestT = t
      best = { x: kiRound(outside.x + t * r.x), y: kiRound(outside.y + t * r.y) }
    }
  }
  return best
}
