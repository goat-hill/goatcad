import { describe, expect, test } from 'vitest'
import { nm, type Nm } from '../../kicad/coordinates'
import {
  mirrorPoint,
  mirrorShape,
  mirrorTextJustify,
  selectionMirrorPoint,
  shapeMirrorPoint
} from '../boardMirror'

const P = (x: number, y: number): { x: Nm; y: Nm } => ({ x: nm(x), y: nm(y) })

describe('mirrorPoint', () => {
  test('horizontal flips x about the center, vertical flips y', () => {
    expect(mirrorPoint(P(3, 5), P(10, 0), 'horizontal')).toEqual(P(17, 5))
    expect(mirrorPoint(P(3, 5), P(0, 10), 'vertical')).toEqual(P(3, 15))
  })
})

describe('mirrorShape', () => {
  test('a line mirrors both ends', () => {
    const line = { kind: 'line' as const, start: P(0, 0), end: P(10, 4) }
    expect(mirrorShape(line, P(0, 0), 'horizontal')).toEqual({
      kind: 'line',
      start: P(0, 0),
      end: P(-10, 4)
    })
  })

  test('an arc swaps its ends, as KiCad does', () => {
    const arc = { kind: 'arc' as const, start: P(10, 0), mid: P(7, 7), end: P(0, 10) }
    expect(mirrorShape(arc, P(0, 0), 'vertical')).toEqual({
      kind: 'arc',
      start: P(0, -10),
      mid: P(7, -7),
      end: P(10, 0)
    })
  })

  test('a polygon mirrors every vertex', () => {
    const poly = { kind: 'poly' as const, points: [P(0, 0), P(4, 0), P(4, 2)] }
    expect(mirrorShape(poly, P(2, 0), 'horizontal')).toEqual({
      kind: 'poly',
      points: [P(4, 0), P(0, 0), P(0, 2)]
    })
  })
})

describe('shapeMirrorPoint', () => {
  test('one item mirrors about its own position', () => {
    expect(shapeMirrorPoint({ kind: 'line', start: P(1, 2), end: P(5, 5) })).toEqual(P(1, 2))
    expect(shapeMirrorPoint({ kind: 'circle', center: P(3, 3), end: P(5, 3) })).toEqual(P(3, 3))
    // An arc's position is its center.
    const arc = { kind: 'arc' as const, start: P(10, 0), mid: P(0, 10), end: P(-10, 0) }
    expect(shapeMirrorPoint(arc)).toEqual(P(0, 0))
  })
})

describe('selectionMirrorPoint', () => {
  test('the bounding box center, snapped to the grid', () => {
    expect(selectionMirrorPoint([P(0, 0), P(10, 6)], 0)).toEqual(P(5, 3))
    expect(selectionMirrorPoint([P(0, 0), P(10, 6)], 4)).toEqual(P(4, 4))
    expect(selectionMirrorPoint([], 0)).toBeNull()
  })
})

describe('mirrorTextJustify', () => {
  test('horizontal text trades left and right in a left-right mirror', () => {
    expect(mirrorTextJustify('left', 0, 'horizontal')).toBe('right')
    expect(mirrorTextJustify('right', undefined, 'horizontal')).toBe('left')
    expect(mirrorTextJustify(undefined, 0, 'horizontal')).toBeUndefined()
  })

  test('text along the axis keeps its justification', () => {
    expect(mirrorTextJustify('left', 90, 'horizontal')).toBe('left')
    expect(mirrorTextJustify('left', 0, 'vertical')).toBe('left')
    expect(mirrorTextJustify('left', 90, 'vertical')).toBe('right')
  })
})
