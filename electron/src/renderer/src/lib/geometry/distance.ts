/**
 * Point-to-shape distances for hit-testing.
 *
 * The point-segment rule in particular had been written inline in every scene
 * that hit-tests (`FootprintScene`, `BoardScene`, `SchematicScene`, the symbol
 * viewport). This is its home; those copies migrate as they are touched rather
 * than in one sweep.
 */

export interface Point2 {
  x: number
  y: number
}

/** Distance from `p` to the segment `a`–`b`, zero-length included. */
export function distanceToSegment(p: Point2, a: Point2, b: Point2): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lengthSq = dx * dx + dy * dy
  if (lengthSq === 0) return Math.hypot(p.x - a.x, p.y - a.y)
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}
