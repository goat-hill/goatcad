/**
 * Pad exits (docs/router-behavior.md R38): where a route leaving a pad, or
 * arriving at one, crosses the pad's edge, straight out from its anchor along
 * one of the pad's own axes.
 */

import { padFrame, type CopperItem, type Pt } from '../spatialIndex'

/** Below this ratio of long side to short a pad is square. */
const SQUARE_RATIO = 1.2
/** On a near tie (in cosine) the long axis is taken over the short. */
const LONG_AXIS_BIAS = 0.05
/** A direction is kept until another points this much more nearly (in cosine) where the route goes. */
const KEEP_MARGIN = 0.1

export interface PadExit {
  /** Where the exit meets the pad's edge. */
  at: Pt
  /** Which of the pad's directions: its rotation plus this many quarter turns. */
  direction: number
}

/**
 * The exit from `pad` at `anchor` toward `toward`, or null where the pad sets
 * no direction: round, square at a multiple of 45°, or `toward` inside it.
 * `keep` is the direction taken last frame, held unless another is clearly
 * nearer.
 */
export function padExit(pad: CopperItem, anchor: Pt, toward: Pt, keep?: number): PadExit | null {
  const frame = padFrame(pad.shape)
  if (!frame) return null
  const { cx, cy, halfW, halfH, cornerR, rotation } = frame
  const long = Math.max(halfW, halfH)
  const short = Math.min(halfW, halfH)
  if (short <= 0) return null
  const square = long / short < SQUARE_RATIO
  if (square && cornerR >= short - 1e-9) return null
  const eighth = Math.PI / 4
  const offEighth = Math.abs(rotation / eighth - Math.round(rotation / eighth))
  if (square && offEighth < 1e-6) return null

  const cos = Math.cos(rotation)
  const sin = Math.sin(rotation)
  const local = (p: Pt): Pt => ({
    x: (p.x - cx) * cos + (p.y - cy) * sin,
    y: -(p.x - cx) * sin + (p.y - cy) * cos
  })
  const a = local(anchor)
  const t = local(toward)
  if (Math.abs(t.x) <= halfW && Math.abs(t.y) <= halfH) return null
  const dx = t.x - a.x
  const dy = t.y - a.y
  const len = Math.hypot(dx, dy)
  if (len === 0) return null

  const axes: Pt[] = [
    { x: 1, y: 0 },
    { x: 0, y: 1 },
    { x: -1, y: 0 },
    { x: 0, y: -1 }
  ]
  const longX = !square && halfW > halfH
  const longY = !square && halfH > halfW
  const score = axes.map(
    (u, k) => (u.x * dx + u.y * dy) / len + ((k % 2 === 0 ? longX : longY) ? LONG_AXIS_BIAS : 0)
  )
  let best = score.indexOf(Math.max(...score))
  if (keep !== undefined && score[keep] >= score[best] - KEEP_MARGIN) best = keep
  const u = axes[best]
  const reach = u.x !== 0 ? halfW - u.x * a.x : halfH - u.y * a.y
  if (reach <= 0 || reach >= len) return null
  const lx = a.x + u.x * reach
  const ly = a.y + u.y * reach
  return { at: { x: cx + lx * cos - ly * sin, y: cy + lx * sin + ly * cos }, direction: best }
}

/** One way out of a pad: from its anchor to where it leaves the copper. */
export interface PadExitPath {
  /** From the anchor to the pad's edge. */
  points: Pt[]
  /** 0–3: the pad's axes, as `PadExit.direction`; 4–7: out through its corners. */
  direction: number
}

/**
 * Every way out of `pad` from `anchor` (R38): straight along each of its
 * axes to the edge, and from an oblong pad along its long axis then out at
 * 45° through each corner. Empty where the pad sets no direction: round, or
 * square at a multiple of 45°, which any bend leaves squarely.
 */
export function padExits(pad: CopperItem, anchor: Pt): PadExitPath[] {
  const frame = padFrame(pad.shape)
  if (!frame) return []
  const { cx, cy, halfW, halfH, cornerR, rotation } = frame
  const long = Math.max(halfW, halfH)
  const short = Math.min(halfW, halfH)
  if (short <= 0) return []
  const square = long / short < SQUARE_RATIO
  if (square && cornerR >= short - 1e-9) return []
  const eighth = Math.PI / 4
  if (square && Math.abs(rotation / eighth - Math.round(rotation / eighth)) < 1e-6) return []

  const cos = Math.cos(rotation)
  const sin = Math.sin(rotation)
  const world = (p: Pt): Pt => ({ x: cx + p.x * cos - p.y * sin, y: cy + p.x * sin + p.y * cos })
  const a = {
    x: (anchor.x - cx) * cos + (anchor.y - cy) * sin,
    y: -(anchor.x - cx) * sin + (anchor.y - cy) * cos
  }
  if (Math.abs(a.x) > halfW || Math.abs(a.y) > halfH) return []
  const out: PadExitPath[] = []
  const axes = [
    { x: 1, y: 0 },
    { x: 0, y: 1 },
    { x: -1, y: 0 },
    { x: 0, y: -1 }
  ]
  axes.forEach((u, k) => {
    const edge = u.x !== 0 ? { x: u.x * halfW, y: a.y } : { x: a.x, y: u.y * halfH }
    if (Math.hypot(edge.x - a.x, edge.y - a.y) > 1e-9)
      out.push({ points: [{ ...anchor }, world(edge)], direction: k })
  })
  // Out through each corner at 45°, from the point on the long axis's line
  // through the anchor where a 45° line meets the corner. Rounded corners
  // are left inside their round, near enough to their edge.
  if (!square && cornerR < short - 1e-9) {
    const alongX = halfW > halfH
    let k = 4
    for (const sx of [1, -1])
      for (const sy of [1, -1]) {
        const corner = { x: sx * halfW, y: sy * halfH }
        const turn = alongX
          ? { x: corner.x - sx * Math.abs(corner.y - a.y), y: a.y }
          : { x: a.x, y: corner.y - sy * Math.abs(corner.x - a.x) }
        const ok = alongX
          ? Math.abs(turn.x) <= halfW && sx * (turn.x - a.x) >= -1e-9
          : Math.abs(turn.y) <= halfH && sy * (turn.y - a.y) >= -1e-9
        if (ok)
          out.push({
            points: [{ ...anchor }, ...(samePoint(turn, a) ? [] : [world(turn)]), world(corner)],
            direction: k
          })
        k++
      }
  }
  return out
}

const samePoint = (p: Pt, q: Pt): boolean =>
  Math.abs(p.x - q.x) < 1e-9 && Math.abs(p.y - q.y) < 1e-9
