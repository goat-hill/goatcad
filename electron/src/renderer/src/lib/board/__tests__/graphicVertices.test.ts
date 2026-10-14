import { describe, expect, test } from 'vitest'
import { mmToNm as mm } from '../../kicad/coordinates'
import {
  moveShapeVertex,
  normalizedShape,
  shapeVertices,
  vertexShapeGhost,
  type VertexShape
} from '../graphicVertices'

const p = (x: number, y: number): { x: ReturnType<typeof mm>; y: ReturnType<typeof mm> } => ({
  x: mm(x),
  y: mm(y)
})

const rect: VertexShape = { kind: 'rect', start: p(0, 0), end: p(10, 6) }

describe('shapeVertices', () => {
  test('a rectangle is reshaped by all four corners, not the two it stores', () => {
    expect(shapeVertices(rect)).toEqual([p(0, 0), p(10, 0), p(10, 6), p(0, 6)])
  })

  test('every other shape is reshaped by the points its node stores', () => {
    expect(shapeVertices({ kind: 'line', start: p(0, 0), end: p(1, 1) })).toHaveLength(2)
    expect(shapeVertices({ kind: 'arc', start: p(0, 0), mid: p(1, 1), end: p(2, 0) })).toHaveLength(
      3
    )
    expect(shapeVertices({ kind: 'poly', points: [p(0, 0), p(1, 0), p(1, 1)] })).toHaveLength(3)
  })
})

describe('moveShapeVertex', () => {
  test('each handle moves exactly the point it is drawn at', () => {
    const shapes: VertexShape[] = [
      { kind: 'line', start: p(0, 0), end: p(4, 4) },
      { kind: 'arc', start: p(0, 0), mid: p(2, 1), end: p(4, 0) },
      rect,
      { kind: 'poly', points: [p(0, 0), p(5, 0), p(5, 5), p(0, 5)] }
    ]
    for (const shape of shapes) {
      shapeVertices(shape).forEach((before, vertex) => {
        const after = shapeVertices(moveShapeVertex(shape, vertex, mm(1), mm(-2)))[vertex]
        expect(after).toEqual({ x: before.x + mm(1), y: before.y + mm(-2) })
      })
    }
  })

  test('a rectangle corner leaves the opposite corner where it was', () => {
    // Corner 1 is (end.x, start.y); its opposite is corner 3, (start.x, end.y).
    const moved = moveShapeVertex(rect, 1, mm(2), mm(1))
    expect(shapeVertices(moved)[3]).toEqual(p(0, 6))
    expect(moved).toEqual({ kind: 'rect', start: p(0, 1), end: p(12, 6) })
  })

  test('a circle center carries the rim: the radius holds', () => {
    const circle: VertexShape = { kind: 'circle', center: p(5, 5), end: p(8, 5) }
    expect(moveShapeVertex(circle, 0, mm(1), mm(1))).toEqual({
      kind: 'circle',
      center: p(6, 6),
      end: p(9, 6)
    })
    expect(moveShapeVertex(circle, 1, mm(1), mm(0))).toEqual({
      kind: 'circle',
      center: p(5, 5),
      end: p(9, 5)
    })
  })

  test('the shape it was given is left alone', () => {
    const poly: VertexShape = { kind: 'poly', points: [p(0, 0), p(1, 0), p(1, 1)] }
    moveShapeVertex(poly, 0, mm(3), mm(3))
    expect(poly.points[0]).toEqual(p(0, 0))
  })
})

describe('normalizedShape', () => {
  test('a rectangle dragged through itself comes back min → max', () => {
    const crossed = moveShapeVertex(rect, 0, mm(15), mm(9)) // start now past end
    expect(normalizedShape(crossed)).toEqual({ kind: 'rect', start: p(10, 6), end: p(15, 9) })
  })
})

describe('vertexShapeGhost', () => {
  test('draws through the tool pipeline: a line is one segment, a rectangle normalized', () => {
    expect(vertexShapeGhost({ kind: 'line', start: p(0, 0), end: p(1, 1) })).toEqual({
      kind: 'lines',
      segments: [{ start: p(0, 0), end: p(1, 1) }]
    })
    const crossed: VertexShape = { kind: 'rect', start: p(4, 4), end: p(0, 0) }
    expect(vertexShapeGhost(crossed)).toEqual({ kind: 'rect', start: p(0, 0), end: p(4, 4) })
  })
})
