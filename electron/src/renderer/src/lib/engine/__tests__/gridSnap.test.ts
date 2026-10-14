import { describe, expect, test } from 'vitest'
import { snapToGrid } from '../ViewportEngine'

// KiCad's grid origin moves the lines a cursor snaps to without moving the
// document's own origin: a 1 mm grid laid from 0.5 snaps to …, -0.5, 0.5, 1.5, ….
describe('snapToGrid', () => {
  test('snaps to the nearest line through the document origin by default', () => {
    expect(snapToGrid(1.4, 1)).toBe(1)
    expect(snapToGrid(-1.6, 1)).toBe(-2)
  })

  test('lays the lines from a moved grid origin', () => {
    expect(snapToGrid(1.4, 1, 0.5)).toBe(1.5)
    expect(snapToGrid(0.9, 1, 0.5)).toBe(0.5)
    expect(snapToGrid(-0.2, 1, 0.5)).toBe(-0.5)
  })

  test('leaves the value alone on a degenerate grid', () => {
    expect(snapToGrid(1.23, 0, 0.5)).toBe(1.23)
  })
})
