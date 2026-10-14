/**
 * The lines a dimension draws, as KiCad 10 builds them (`PCB_DIMENSION_BASE`
 * and its five kinds): what the board scene draws, and what DRC and the zone
 * filler measure (`boardDrawings.ts`).
 *
 * - **Aligned / orthogonal:** two extension lines from a gap at the measured
 *   points to past the crossbar, the crossbar broken round inline text, and an
 *   arrowhead at each end — outward, or inward with a tail.
 * - **Leader:** a line from its arrow to the text's frame, then on to the text
 *   when it stops short, and the frame itself (a rectangle or circle).
 * - **Radial:** a cross at the center, and a leader from the measured point.
 * - **Center:** a cross whose arms reach the second point.
 *
 * The text is the file's own (`gr_text` inside the dimension): KiCad writes it
 * where its layout put it, so its string and position are read, not recomputed.
 * Its box, which breaks the crossbar and frames a leader, is the glyphs' extent
 * in the text's own frame, turned about its center as KiCad turns it.
 *
 * File space: nanometers, y down — the frame the dimension is written in, which
 * is the board's even inside a footprint. Lines have no width here: DRC measures
 * their centerlines, the filler and the scene give them the style's thickness.
 */
import type { KicadDimension } from '../kicad/footprint'
import { getTextStrokes, strokeOptionsFromEffects } from '../kicad/newstroke'
import { mmToNm } from '../kicad/coordinates'

export interface Pt {
  x: number
  y: number
}

export interface DimensionGeometry {
  lines: Array<{ a: Pt; b: Pt }>
  circles: Array<{ center: Pt; radius: number }>
}

/** The half-angle of an arrowhead's barbs. */
const BARB = (27.5 * Math.PI) / 180

/** An inward arrow's tail, in arrow lengths. */
const INWARD_TAIL = 2

/** KiCad's defaults for a dimension that names no style. */
const DEFAULT_ARROW = mmToNm(1.27)
const DEFAULT_EXTENSION_OFFSET = mmToNm(0.5)

const add = (a: Pt, b: Pt): Pt => ({ x: a.x + b.x, y: a.y + b.y })
const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y })
const scale = (v: Pt, s: number): Pt => ({ x: v.x * s, y: v.y * s })
const len = (v: Pt): number => Math.hypot(v.x, v.y)
/** `v` stretched to a length; a negative length reverses it, a zero vector stays zero. */
const resize = (v: Pt, length: number): Pt => {
  const l = len(v)
  return l === 0 ? { x: 0, y: 0 } : scale(v, length / l)
}
const same = (a: Pt, b: Pt): boolean => Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6

/** A turn of `v` by `angle` radians, counterclockwise on screen (y down). */
const turn = (v: Pt, angle: number): Pt => {
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  return { x: v.x * cos + v.y * sin, y: -v.x * sin + v.y * cos }
}

/**
 * The dimension text's box, turned as KiCad turns it: its extent in the text's
 * own frame, grown by `grow` (x, y; a negative y shrinks it), then turned by
 * the text's angle about its own center. Null when there is no text.
 */
function textBox(dim: KicadDimension, grow: (pen: number, width: number) => Pt): Pt[] | null {
  const text = dim.text
  if (!text?.text || !text.position) return null
  const options = strokeOptionsFromEffects(text.fontEffects)
  const { strokes } = getTextStrokes(text.text, options)
  if (strokes.length === 0) return null
  // Stroke extents are millimeters, y up, about the anchor; the box is file nm, y down.
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const s of strokes) {
    minX = Math.min(minX, s.x1, s.x2)
    maxX = Math.max(maxX, s.x1, s.x2)
    minY = Math.min(minY, -s.y1, -s.y2)
    maxY = Math.max(maxY, -s.y1, -s.y2)
  }
  const pen = mmToNm(options.thickness)
  const g = grow(pen, mmToNm(options.width))
  const half = pen / 2
  const anchor = { x: text.position.x, y: text.position.y }
  const x0 = anchor.x + mmToNm(minX) - half - g.x
  const x1 = anchor.x + mmToNm(maxX) + half + g.x
  const y0 = anchor.y + mmToNm(minY) - half - g.y
  const y1 = anchor.y + mmToNm(maxY) + half + g.y
  const center = { x: (x0 + x1) / 2, y: (y0 + y1) / 2 }
  const angle = ((text.position.angle ?? 0) * Math.PI) / 180
  return [
    { x: x0, y: y0 },
    { x: x0, y: y1 },
    { x: x1, y: y1 },
    { x: x1, y: y0 }
  ].map((p) => add(center, turn(sub(p, center), angle)))
}

/** Whether a point is inside a polygon (even-odd). */
function contains(poly: readonly Pt[], p: Pt): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]
    const b = poly[j]
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x)
      inside = !inside
  }
  return inside
}

/** Where two segments meet, if they do. */
function crossing(a: Pt, b: Pt, c: Pt, d: Pt): Pt | null {
  const r = sub(b, a)
  const s = sub(d, c)
  const denom = r.x * s.y - r.y * s.x
  if (denom === 0) return null
  const q = sub(c, a)
  const t = (q.x * s.y - q.y * s.x) / denom
  const u = (q.x * r.y - q.y * r.x) / denom
  if (t < 0 || t > 1 || u < 0 || u > 1) return null
  return add(a, scale(r, t))
}

/**
 * From `from` toward `to`, where the line first meets a polygon's edge; null
 * when `from` is inside it or the line starts on it.
 */
function toPolygon(poly: readonly Pt[], from: Pt, to: Pt): Pt | null {
  if (contains(poly, from)) return null
  let end = to
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const hit = crossing(poly[j], poly[i], from, to)
    if (hit && len(sub(hit, from)) < len(sub(end, from))) end = hit
  }
  return same(from, end) ? null : end
}

/** From `from` toward `to`, where the line first meets a circle; null when `from` is inside it. */
function toCircle(center: Pt, radius: number, from: Pt, to: Pt): Pt | null {
  if (len(sub(from, center)) < radius) return null
  const d = sub(to, from)
  const f = sub(from, center)
  const a = d.x * d.x + d.y * d.y
  let end = to
  if (a > 0) {
    const b = f.x * d.x + f.y * d.y
    const disc = b * b - a * (f.x * f.x + f.y * f.y - radius * radius)
    if (disc >= 0) {
      const root = Math.sqrt(disc)
      for (const t of [(-b - root) / a, (-b + root) / a]) {
        if (t < 0 || t > 1) continue
        const hit = add(from, scale(d, t))
        if (len(sub(hit, from)) < len(sub(end, from))) end = hit
      }
    }
  }
  return same(from, end) ? null : end
}

/** A segment less where it passes through a polygon: none, one or two pieces. */
function knockedOut(poly: readonly Pt[] | null, a: Pt, b: Pt): Array<{ a: Pt; b: Pt }> {
  if (!poly) return [{ a, b }]
  const out: Array<{ a: Pt; b: Pt }> = []
  const fromA = toPolygon(poly, a, b)
  const fromB = toPolygon(poly, b, a)
  if (fromA) out.push({ a, b: fromA })
  if (
    fromB &&
    !(fromA && ((same(fromB, a) && same(fromA, b)) || (same(fromA, fromB) && same(a, b))))
  )
    out.push({ a: fromB, b })
  return out
}

/** Dimension geometry of an item; empty for one too short to say anything. */
export function dimensionGeometry(dim: KicadDimension): DimensionGeometry {
  const out: DimensionGeometry = { lines: [], circles: [] }
  const [p0, p1] = dim.points
  if (!p0 || !p1) return out
  const start = { x: p0.x, y: p0.y }
  const end = { x: p1.x, y: p1.y }
  const arrow = dim.style?.arrowLength ?? DEFAULT_ARROW
  const offset = dim.style?.extensionOffset ?? DEFAULT_EXTENSION_OFFSET
  const overshoot = dim.style?.extensionHeight ?? arrow * Math.sin(BARB)
  const line = (a: Pt, b: Pt): void => {
    out.lines.push({ a, b })
  }
  /** An arrowhead at `tip` whose barbs, and tail if it has one, run along `dir`. */
  const arrowhead = (tip: Pt, dir: Pt, tail = 0): void => {
    if (len(dir) === 0) return
    if (tail) line(tip, add(tip, resize(dir, tail)))
    for (const side of [BARB, -BARB]) line(tip, add(tip, resize(turn(dir, side), arrow)))
  }
  /** Arrowheads at a crossbar's ends, pointing out, or in with their tails outside. */
  const crossbarArrows = (a: Pt, b: Pt): void => {
    const along = sub(b, a)
    if (dim.style?.arrowDirection === 'inward') {
      arrowhead(a, scale(along, -1), arrow * INWARD_TAIL)
      arrowhead(b, along, arrow * INWARD_TAIL)
    } else {
      arrowhead(a, along)
      arrowhead(b, scale(along, -1))
    }
  }

  switch (dim.dimensionType) {
    case 'aligned': {
      const span = sub(end, start)
      const height = dim.height ?? 0
      // Toward the crossbar's side, whichever sign the height has.
      const toward = height > 0 ? { x: -span.y, y: span.x } : { x: span.y, y: -span.x }
      const reach = Math.abs(height) - offset + overshoot
      for (const p of [start, end]) {
        const from = add(p, resize(toward, offset))
        line(from, add(from, resize(toward, reach)))
      }
      const shift = resize(toward, Math.abs(height))
      const a = add(start, shift)
      const b = add(end, shift)
      for (const piece of knockedOut(
        textBox(dim, (pen, width) => ({ x: width / 2, y: -pen })),
        a,
        b
      ))
        line(piece.a, piece.b)
      crossbarArrows(a, b)
      break
    }
    case 'orthogonal': {
      const vertical = dim.orientation === 1
      const height = dim.height ?? 0
      const toward = vertical ? { x: height, y: 0 } : { x: 0, y: height }
      const from = add(start, resize(toward, offset))
      line(from, add(from, resize(toward, Math.abs(height) - offset + overshoot)))
      const a = add(start, toward)
      const b = vertical ? { x: a.x, y: end.y } : { x: end.x, y: a.y }
      // The second extension line runs from past the crossbar to a gap short of the end.
      const back = sub(end, b)
      const second = sub(b, resize(back, overshoot))
      line(second, add(second, resize(back, len(back) - offset + overshoot)))
      for (const piece of knockedOut(
        textBox(dim, (pen, width) => ({ x: width / 2, y: pen })),
        a,
        b
      ))
        line(piece.a, piece.b)
      crossbarArrows(a, b)
      break
    }
    case 'leader': {
      const box = textBox(dim, (pen, width) => ({ x: width / 2, y: pen * 2 }))
      const text = dim.text
      const textAt = text?.position ? { x: text.position.x, y: text.position.y } : end
      const first = add(start, resize(sub(end, start), offset))
      const circle = dim.style?.textFrame === 2 && box ? frameCircle(box, dim) : null
      const hit = (from: Pt, to: Pt): Pt | null =>
        circle
          ? toCircle(circle.center, circle.radius, from, to)
          : box
            ? toPolygon(box, from, to)
            : null
      const arrowEnd = hit(start, end) ?? end
      const textEnd = hit(end, textAt)
      line(first, arrowEnd)
      arrowhead(first, sub(end, start))
      if (text?.text && box) {
        if (dim.style?.textFrame === 1)
          box.forEach((p, i) => line(box[(i + box.length - 1) % box.length], p))
        else if (circle) out.circles.push(circle)
      }
      if (textEnd && same(arrowEnd, end)) line(end, textEnd)
      break
    }
    case 'radial': {
      for (const arm of [
        { x: 0, y: arrow },
        { x: arrow, y: 0 }
      ])
        line(sub(start, arm), add(start, arm))
      const radial = resize(sub(end, start), dim.leaderLength ?? 0)
      const knee = add(end, radial)
      const box = textBox(dim, (pen, width) => ({ x: width / 2, y: pen }))
      const textAt = dim.text?.position ? { x: dim.text.position.x, y: dim.text.position.y } : knee
      for (const piece of [...knockedOut(box, end, knee), ...knockedOut(box, knee, textAt)])
        line(piece.a, piece.b)
      arrowhead(end, radial)
      break
    }
    case 'center': {
      const arm = sub(end, start)
      const across = { x: arm.y, y: -arm.x }
      line(sub(start, arm), add(start, arm))
      line(sub(start, across), add(start, across))
      break
    }
  }
  return out
}

/**
 * A leader's circular text frame: about the box's center, its half width (the
 * text's own width, before the turn) less half the pen.
 */
function frameCircle(box: readonly Pt[], dim: KicadDimension): { center: Pt; radius: number } {
  const center = scale(add(box[0], box[2]), 0.5)
  const pen = mmToNm(strokeOptionsFromEffects(dim.text?.fontEffects).thickness)
  return { center, radius: len(sub(box[3], box[0])) / 2 - pen / 2 }
}
