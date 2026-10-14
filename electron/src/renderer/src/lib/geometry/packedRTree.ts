/**
 * A static R-tree packed into typed arrays: build once over a set of boxes,
 * then ask which boxes meet a query box. Each box is stored once, so a query
 * needs no deduplication (a grid does, for every item spanning cells), and the
 * whole tree is a few flat arrays — cheap to rebuild on every edit.
 *
 * Boxes are sorted along a Hilbert curve by their centers, packed into leaves
 * of `NODE_SIZE`, and each level above holds the bounds of `NODE_SIZE`
 * children, up to one root. A query walks down from the root through every
 * node whose bounds meet the query box.
 */

const NODE_SIZE = 16

export class PackedRTree {
  /** Per slot, its bounds: minX, minY, maxX, maxY. Leaves first, then each level up. */
  private readonly bounds: Float64Array
  /** Per slot: an item id for a leaf slot, the first child's slot for a node. */
  private readonly refs: Uint32Array
  /** Where each level starts in the slot arrays, leaves first; the last entry is the end. */
  private readonly levels: number[]

  constructor(boxes: ArrayLike<number>, count: number) {
    // Level starts: the leaves, then each level of nodes above, up to one root.
    this.levels = [0]
    let size = count
    let start = 0
    for (;;) {
      start += size
      this.levels.push(start)
      if (size <= 1) break
      size = Math.ceil(size / NODE_SIZE)
    }
    const total = this.levels[this.levels.length - 1]
    this.bounds = new Float64Array(total * 4)
    this.refs = new Uint32Array(total)
    if (count === 0) return

    // Leaves, in Hilbert order of their centers.
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (let i = 0; i < count; i++) {
      minX = Math.min(minX, boxes[i * 4])
      minY = Math.min(minY, boxes[i * 4 + 1])
      maxX = Math.max(maxX, boxes[i * 4 + 2])
      maxY = Math.max(maxY, boxes[i * 4 + 3])
    }
    const width = maxX - minX || 1
    const height = maxY - minY || 1
    const HILBERT_MAX = (1 << 16) - 1
    const keys = new Uint32Array(count)
    const order = new Uint32Array(count)
    for (let i = 0; i < count; i++) {
      const cx = (boxes[i * 4] + boxes[i * 4 + 2]) / 2
      const cy = (boxes[i * 4 + 1] + boxes[i * 4 + 3]) / 2
      keys[i] = hilbert(
        Math.floor((HILBERT_MAX * (cx - minX)) / width),
        Math.floor((HILBERT_MAX * (cy - minY)) / height)
      )
      order[i] = i
    }
    order.sort((a, b) => keys[a] - keys[b])
    for (let slot = 0; slot < count; slot++) {
      const id = order[slot]
      for (let k = 0; k < 4; k++) this.bounds[slot * 4 + k] = boxes[id * 4 + k]
      this.refs[slot] = id
    }

    // Each level up: a node per NODE_SIZE children, holding their union.
    for (let level = 0; level + 1 < this.levels.length - 1; level++) {
      const childStart = this.levels[level]
      const childEnd = this.levels[level + 1]
      let parent = childEnd
      for (let child = childStart; child < childEnd; child += NODE_SIZE) {
        const last = Math.min(child + NODE_SIZE, childEnd)
        let nMinX = Infinity
        let nMinY = Infinity
        let nMaxX = -Infinity
        let nMaxY = -Infinity
        for (let c = child; c < last; c++) {
          nMinX = Math.min(nMinX, this.bounds[c * 4])
          nMinY = Math.min(nMinY, this.bounds[c * 4 + 1])
          nMaxX = Math.max(nMaxX, this.bounds[c * 4 + 2])
          nMaxY = Math.max(nMaxY, this.bounds[c * 4 + 3])
        }
        this.bounds[parent * 4] = nMinX
        this.bounds[parent * 4 + 1] = nMinY
        this.bounds[parent * 4 + 2] = nMaxX
        this.bounds[parent * 4 + 3] = nMaxY
        this.refs[parent] = child
        parent++
      }
    }
  }

  /** Call `visit` with the id of every box that meets the query box, edges included. */
  search(
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
    visit: (id: number) => void
  ): void {
    const top = this.levels.length - 2
    if (top < 0 || this.levels[this.levels.length - 1] === 0) return
    // A stack of (slot, level) pairs, starting from the root.
    const stack: number[] = [this.levels[top], top]
    while (stack.length > 0) {
      const level = stack.pop()!
      const slot = stack.pop()!
      const b = slot * 4
      if (
        this.bounds[b + 2] < minX ||
        this.bounds[b] > maxX ||
        this.bounds[b + 3] < minY ||
        this.bounds[b + 1] > maxY
      )
        continue
      if (level === 0) {
        visit(this.refs[slot])
        continue
      }
      const first = this.refs[slot]
      const end = Math.min(first + NODE_SIZE, this.levels[level])
      for (let child = first; child < end; child++) stack.push(child, level - 1)
    }
  }
}

/** The index of (x, y) along a Hilbert curve over a 2^16 grid. */
function hilbert(x: number, y: number): number {
  const n = 1 << 16
  let d = 0
  for (let s = n >> 1; s > 0; s >>= 1) {
    const rx = (x & s) > 0 ? 1 : 0
    const ry = (y & s) > 0 ? 1 : 0
    d += s * s * ((3 * rx) ^ ry)
    // Rotate the quadrant so the curve stays continuous.
    if (ry === 0) {
      if (rx === 1) {
        x = n - 1 - x
        y = n - 1 - y
      }
      const t = x
      x = y
      y = t
    }
  }
  return d >>> 0
}
