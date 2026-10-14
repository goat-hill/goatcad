/**
 * Y-stripe index over a closed polygon ring (after tidwall/tg — the same
 * structure KiCad adopted as poly_ystripes_index): edges are bucketed into
 * horizontal stripes spanning the ring's y-extent, so a containment ray cast
 * or an edge-range scan touches only the edges whose y-range overlaps the
 * query instead of walking the whole ring. On the huge zone-fill rings this
 * exists for (tens of thousands of points), that is the difference between
 * O(V) and O(√V) per probe.
 */

export interface StripePt {
  x: number
  y: number
}

export class YStripes {
  private readonly ring: readonly StripePt[]
  private readonly minY: number
  /** Stripes per world unit; 0 when the ring is degenerate (flat in y). */
  private readonly invHeight: number
  /** Edge start indices per stripe (edge i runs ring[i] → ring[(i+1)%n]). */
  private readonly stripes: number[][]
  /** Per-edge visit stamps so multi-stripe range scans see each edge once. */
  private readonly visited: Int32Array
  private generation = 0

  constructor(ring: readonly StripePt[]) {
    this.ring = ring
    const n = ring.length
    let minY = Infinity
    let maxY = -Infinity
    for (const p of ring) {
      minY = Math.min(minY, p.y)
      maxY = Math.max(maxY, p.y)
    }
    this.minY = minY
    const count = Math.max(1, Math.min(4096, Math.round(Math.sqrt(n))))
    const span = maxY - minY
    this.invHeight = span > 0 ? count / span : 0
    this.stripes = Array.from({ length: count }, () => [])
    this.visited = new Int32Array(n)
    for (let i = 0; i < n; i++) {
      const a = ring[i]
      const b = ring[(i + 1) % n]
      const s0 = this.stripeOf(Math.min(a.y, b.y))
      const s1 = this.stripeOf(Math.max(a.y, b.y))
      for (let s = s0; s <= s1; s++) this.stripes[s].push(i)
    }
  }

  private stripeOf(y: number): number {
    const s = Math.floor((y - this.minY) * this.invHeight)
    return Math.max(0, Math.min(this.stripes.length - 1, s))
  }

  /**
   * Even-odd containment, mirroring regionClips.pointInPolygon exactly: only
   * edges straddling p.y can flip the crossing parity, and every such edge is
   * bucketed into p.y's stripe, so scanning that one stripe is exhaustive.
   */
  contains(p: StripePt): boolean {
    const ring = this.ring
    let inside = false
    for (const i of this.stripes[this.stripeOf(p.y)]) {
      const a = ring[(i + 1) % ring.length]
      const b = ring[i]
      if (a.y > p.y !== b.y > p.y) {
        const x = ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x
        if (p.x < x) inside = !inside
      }
    }
    return inside
  }

  /**
   * Invoke `fn` once per edge whose stripe range intersects [minY, maxY],
   * stopping early (and returning true) when `fn` returns true.
   */
  someEdgeInYRange(minY: number, maxY: number, fn: (a: StripePt, b: StripePt) => boolean): boolean {
    const ring = this.ring
    const stamp = ++this.generation
    const s0 = this.stripeOf(minY)
    const s1 = this.stripeOf(maxY)
    for (let s = s0; s <= s1; s++) {
      for (const i of this.stripes[s]) {
        if (this.visited[i] === stamp) continue
        this.visited[i] = stamp
        if (fn(ring[i], ring[(i + 1) % ring.length])) return true
      }
    }
    return false
  }
}
