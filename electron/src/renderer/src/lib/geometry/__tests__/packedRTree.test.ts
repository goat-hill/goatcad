import { describe, expect, test } from 'vitest'
import { PackedRTree } from '../packedRTree'

/** A deterministic sequence, so a failure reproduces. */
const random = (seed: number): (() => number) => {
  let state = seed
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

const boxesOf = (count: number, next: () => number): Float64Array => {
  const boxes = new Float64Array(count * 4)
  for (let i = 0; i < count; i++) {
    const x = next() * 200
    const y = next() * 200
    // Mostly small items, a few long ones (a track across the board).
    const w = next() < 0.05 ? next() * 150 : next() * 3
    const h = next() * 3
    boxes.set([x, y, x + w, y + h], i * 4)
  }
  return boxes
}

const found = (tree: PackedRTree, q: number[]): number[] => {
  const ids: number[] = []
  tree.search(q[0], q[1], q[2], q[3], (id) => ids.push(id))
  return ids.sort((a, b) => a - b)
}

const bruteForce = (boxes: Float64Array, count: number, q: number[]): number[] => {
  const ids: number[] = []
  for (let i = 0; i < count; i++) {
    const [minX, minY, maxX, maxY] = boxes.subarray(i * 4, i * 4 + 4)
    if (maxX >= q[0] && minX <= q[2] && maxY >= q[1] && minY <= q[3]) ids.push(i)
  }
  return ids
}

describe('PackedRTree', () => {
  test('finds exactly the boxes a brute-force scan finds, each once', () => {
    for (const count of [0, 1, 15, 16, 17, 257, 5000]) {
      const next = random(count + 7)
      const boxes = boxesOf(count, next)
      const tree = new PackedRTree(boxes, count)
      for (let k = 0; k < 50; k++) {
        const x = next() * 220 - 10
        const y = next() * 220 - 10
        const q = [x, y, x + next() * 30, y + next() * 30]
        expect(found(tree, q)).toEqual(bruteForce(boxes, count, q))
      }
    }
  })

  test('a query touching a box only at its edge still finds it', () => {
    const tree = new PackedRTree(new Float64Array([0, 0, 1, 1]), 1)
    expect(found(tree, [1, 1, 2, 2])).toEqual([0])
    expect(found(tree, [1.0001, 1, 2, 2])).toEqual([])
  })
})
