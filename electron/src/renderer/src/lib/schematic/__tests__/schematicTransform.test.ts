import { describe, expect, test } from 'vitest'
import { mmToNm, nm } from '../../kicad/coordinates'
import type { KicadSchematicSymbol, Point } from '../../kicad/schematic'
import { placedPoint } from '../connectivity'
import {
  transformAngle,
  transformOrientation,
  transformPivot,
  transformPoint,
  transformedSymbol,
  type TransformOp
} from '../schematicTransform'

const p = (x: number, y: number): Point => ({ x: mmToNm(x), y: mmToNm(y) })

describe('transformPoint', () => {
  const pivot = p(10, 10)
  test('a quarter turn counter-clockwise carries right to up on a y-down sheet', () => {
    expect(transformPoint(p(15, 10), pivot, 'rotateCCW')).toEqual(p(10, 5))
    expect(transformPoint(p(15, 10), pivot, 'rotateCW')).toEqual(p(10, 15))
  })
  test('mirrors flip one axis about the pivot', () => {
    expect(transformPoint(p(15, 12), pivot, 'mirrorHorizontal')).toEqual(p(5, 12))
    expect(transformPoint(p(15, 12), pivot, 'mirrorVertical')).toEqual(p(15, 8))
  })
})

describe('transformAngle', () => {
  test('a turn adds a quarter, a flip reflects the reading direction', () => {
    expect(transformAngle(0, 'rotateCCW')).toBe(90)
    expect(transformAngle(0, 'rotateCW')).toBe(270)
    expect(transformAngle(0, 'mirrorHorizontal')).toBe(180)
    expect(transformAngle(90, 'mirrorHorizontal')).toBe(90)
    expect(transformAngle(90, 'mirrorVertical')).toBe(270)
    expect(transformAngle(0, 'mirrorVertical')).toBe(0)
  })
})

describe('transformOrientation', () => {
  /** A resistor-shaped symbol: its pin 1 sits above the origin in the library. */
  const symbolAt = (angle: number, mirror?: 'x' | 'y'): KicadSchematicSymbol =>
    ({
      libId: 'Device:R',
      position: { ...p(0, 0), angle },
      unit: 1,
      mirror,
      properties: [],
      instances: []
    }) as unknown as KicadSchematicSymbol
  const topPin = p(0, 3.81)
  /** Where the top pin lands on the sheet for an orientation. */
  const landing = (angle: number, mirror?: 'x' | 'y'): Point =>
    placedPoint(symbolAt(angle, mirror), topPin)

  test('the stored orientation moves the body exactly as the sheet-space operation does', () => {
    const ops: TransformOp[] = ['rotateCCW', 'rotateCW', 'mirrorHorizontal', 'mirrorVertical']
    const starts: Array<[number, 'x' | 'y' | undefined]> = [
      [0, undefined],
      [90, undefined],
      [180, undefined],
      [270, undefined],
      [0, 'x'],
      [90, 'x'],
      [0, 'y'],
      [270, 'y']
    ]
    for (const [angle, mirror] of starts) {
      for (const op of ops) {
        const next = transformOrientation({ angle, mirror }, op)
        const expected = transformPoint(landing(angle, mirror), p(0, 0), op)
        // Trig leaves a -0 behind on some axes; the coordinates are what matter.
        const plain = (point: Point): Point => ({ x: nm(point.x + 0), y: nm(point.y + 0) })
        expect(plain(landing(next.angle, next.mirror))).toEqual(plain(expected))
      }
    }
  })

  test('two like flips cancel; two unlike flips are a half turn', () => {
    expect(transformOrientation({ angle: 0, mirror: 'y' }, 'mirrorHorizontal')).toEqual({
      angle: 0
    })
    expect(transformOrientation({ angle: 0, mirror: 'x' }, 'mirrorHorizontal')).toEqual({
      angle: 180
    })
  })
})

describe('transformedSymbol', () => {
  test('turns the origin about the pivot and composes the orientation', () => {
    const symbol = {
      libId: 'Device:R',
      position: { ...p(20, 10), angle: 0 },
      unit: 1,
      properties: [],
      instances: []
    } as unknown as KicadSchematicSymbol
    const turned = transformedSymbol(symbol, p(10, 10), 'rotateCCW')
    expect(turned.position).toEqual({ ...p(10, 0), angle: 90 })
    expect(turned.mirror).toBeUndefined()
  })
})

describe('transformPivot', () => {
  test('a lone symbol turns about itself; a group about its snapped middle', () => {
    expect(transformPivot([p(0, 0), p(10, 0)], mmToNm(1.27), p(3, 3))).toEqual(p(3, 3))
    expect(transformPivot([p(0, 0), p(10, 0), p(10, 6)], mmToNm(1.27))).toEqual(p(5.08, 2.54))
  })
})
