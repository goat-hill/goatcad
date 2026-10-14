/**
 * What a route in progress adds to its net's length, mm, read as the tuner
 * reads committed copper (docs/router-behavior.md T2, `tuneLength.ts`): its
 * tracks and arcs, and each via's height between the layers its tracks join.
 * Added to the net's routed length, it is the live readout (S11).
 */
import { arcPieceLength } from './netLength'

interface Pt {
  x: number
  y: number
}

/** A straight piece, or an arc through `mid` (R3). */
export interface LengthChord {
  x0: number
  y0: number
  x1: number
  y1: number
  mid?: Pt
}

const near = (a: Pt, b: Pt): boolean => Math.hypot(a.x - b.x, a.y - b.y) < 1e-6

/** The pieces' length, mm. */
export function chordsLength(chords: readonly LengthChord[]): number {
  let total = 0
  for (const c of chords) {
    const a = { x: c.x0, y: c.y0 }
    const b = { x: c.x1, y: c.y1 }
    total += c.mid ? arcPieceLength(a, c.mid, b) : Math.hypot(b.x - a.x, b.y - a.y)
  }
  return total
}

/**
 * The clicked copper plus the head: `head` is the head's length, on `headLayer`
 * from `tail`. A via counts the distance between the outermost layers its
 * tracks reach (`layerDistance`, mm), or nothing when vias add no height.
 */
export function pendingRouteLength(
  draft: {
    segments: readonly (LengthChord & { layer: string })[]
    vias: readonly Pt[]
    tail: Pt | null
  },
  head: { length: number; layer: string },
  layerDistance: ((a: string, b: string) => number) | null
): number {
  let total = chordsLength(draft.segments) + head.length
  if (!layerDistance) return total
  for (const via of draft.vias) {
    const layers = new Set<string>()
    for (const s of draft.segments)
      if (near(via, { x: s.x0, y: s.y0 }) || near(via, { x: s.x1, y: s.y1 })) layers.add(s.layer)
    if (draft.tail && near(via, draft.tail)) layers.add(head.layer)
    const list = [...layers]
    let height = 0
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++)
        height = Math.max(height, layerDistance(list[i], list[j]))
    total += height
  }
  return total
}
