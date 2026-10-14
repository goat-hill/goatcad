import { describe, expect, test } from 'vitest'
import { mmToNm } from '../../kicad/coordinates'
import type { Point } from '../../kicad/schematic'
import {
  directionOf,
  labelPortDirection,
  reshapeWires,
  type Direction,
  type ReshapeGeometry,
  type ReshapeResult
} from '../wireReshape'

/** A sheet point from mm coordinates — the tests speak mm, the domain nm. */
const p = (x: number, y: number): Point => ({ x: mmToNm(x), y: mmToNm(y) })
const GRID = mmToNm(1.27)

const pin = (x: number, y: number, direction: Direction): ReshapeGeometry['pins'][number] => ({
  position: p(x, y),
  direction
})

const geometry = (partial: Partial<ReshapeGeometry>): ReshapeGeometry => ({
  wires: [],
  junctions: [],
  pins: [],
  anchors: [],
  ...partial
})

/** Every wire as it ends up: edits applied, removed ones gone, added ones after. */
const finalWires = (input: ReshapeGeometry, result: ReshapeResult): Point[][] => {
  const wires = input.wires.map((wire) => [...wire])
  for (const edit of result.edits) wires[edit.index] = edit.points
  return [...wires.filter((wire) => wire.length >= 2), ...result.added]
}

describe('reshapeWires', () => {
  test('a move along the wire lengthens it', () => {
    const input = geometry({ wires: [[p(0, 0), p(10, 0)]] })
    const result = reshapeWires(input, [{ from: p(10, 0), to: p(15, 0), direction: 'left' }], {
      grid: GRID
    })
    expect(result.edits).toEqual([{ index: 0, points: [p(15, 0), p(0, 0)] }])
    expect(result.added).toEqual([])
  })

  test('a dangling end travels with its segment, label and all', () => {
    const input = geometry({ wires: [[p(0, 0), p(10, 0)]], anchors: [p(0, 0), p(5, 0)] })
    const result = reshapeWires(input, [{ from: p(10, 0), to: p(10, 5), direction: 'left' }], {
      grid: GRID
    })
    expect(finalWires(input, result)).toEqual([[p(10, 5), p(0, 5)]])
    expect(result.anchorsMoved).toEqual([
      { from: p(0, 0), to: p(0, 5) },
      { from: p(5, 0), to: p(5, 5) }
    ])
  })

  test('an existing bend slides instead of a new one appearing', () => {
    const input = geometry({
      wires: [
        [p(10, 0), p(5, 0)],
        [p(5, 0), p(5, -10)]
      ]
    })
    const result = reshapeWires(input, [{ from: p(10, 0), to: p(10, 3), direction: 'left' }], {
      grid: GRID
    })
    expect(result.edits).toEqual([
      { index: 0, points: [p(10, 3), p(5, 3)] },
      { index: 1, points: [p(5, 3), p(5, -10)] }
    ])
    expect(result.added).toEqual([])
  })

  test('between two facing pins the wire becomes a Z with the riser off the moved pin', () => {
    const input = geometry({ wires: [[p(0, 0), p(10, 0)]], pins: [pin(0, 0, 'right')] })
    const result = reshapeWires(input, [{ from: p(10, 0), to: p(10, 5), direction: 'left' }], {
      grid: GRID
    })
    expect(finalWires(input, result)).toEqual([
      [p(10, 5), p(8.73, 5)],
      [p(8.73, 5), p(8.73, 0)],
      [p(8.73, 0), p(0, 0)]
    ])
  })

  test('a T onto a bus slides along the bus', () => {
    const input = geometry({
      wires: [
        [p(10, 0), p(0, 0)],
        [p(0, -10), p(0, 10)]
      ],
      junctions: [p(0, 0)]
    })
    const result = reshapeWires(input, [{ from: p(10, 0), to: p(10, 5), direction: 'left' }], {
      grid: GRID
    })
    expect(result.edits).toEqual([{ index: 0, points: [p(10, 5), p(0, 5)] }])
    expect(result.added).toEqual([])
    expect(result.junctionsRemoved).toEqual([p(0, 0)])
    expect(result.junctionsAdded).toEqual([p(0, 5)])
  })

  test('a branch off the middle of a wire keeps the far part of the wire', () => {
    const input = geometry({
      wires: [
        [p(0, 0), p(20, 0)],
        [p(10, 0), p(10, 10)]
      ],
      junctions: [p(10, 0)]
    })
    const result = reshapeWires(input, [{ from: p(20, 0), to: p(20, 5), direction: 'left' }], {
      grid: GRID
    })
    expect(finalWires(input, result)).toEqual([
      [p(10, 0), p(0, 0)],
      [p(10, 0), p(10, 10)],
      [p(20, 5), p(10, 5)]
    ])
    expect(result.junctionsRemoved).toEqual([p(10, 0)])
    expect(result.junctionsAdded).toEqual([p(10, 5)])
  })

  test('sibling wires on one side nest their risers, the leading pin farthest out', () => {
    const input = geometry({
      wires: [
        [p(0, 0), p(10, 0)],
        [p(0, 2.54), p(10, 2.54)]
      ],
      pins: [pin(0, 0, 'right'), pin(0, 2.54, 'right')]
    })
    const result = reshapeWires(
      input,
      [
        { from: p(10, 0), to: p(10, -5.08), direction: 'left' },
        { from: p(10, 2.54), to: p(10, -2.54), direction: 'left' }
      ],
      { grid: GRID }
    )
    const wires = finalWires(input, result)
    // The top pin leads an upward move: its riser is two grid steps out.
    expect(wires).toContainEqual([p(10, -5.08), p(7.46, -5.08)])
    expect(wires).toContainEqual([p(7.46, -5.08), p(7.46, 0)])
    expect(wires).toContainEqual([p(10, -2.54), p(8.73, -2.54)])
    expect(wires).toContainEqual([p(8.73, -2.54), p(8.73, 2.54)])
  })

  test('a wire between two moved points translates rigidly', () => {
    const input = geometry({ wires: [[p(0, 0), p(10, 0)]] })
    const result = reshapeWires(
      input,
      [
        { from: p(0, 0), to: p(3, 4), direction: 'right' },
        { from: p(10, 0), to: p(13, 4), direction: 'left' }
      ],
      { grid: GRID }
    )
    expect(result.edits).toEqual([{ index: 0, points: [p(3, 4), p(13, 4)] }])
  })

  test('pin on pin with no wire gets one drawn', () => {
    const input = geometry({ pins: [pin(0, 0, 'right')] })
    const result = reshapeWires(input, [{ from: p(0, 0), to: p(0, 5), direction: 'left' }], {
      grid: GRID
    })
    // The tips are closer than two stubs, so the wire runs straight between
    // them, sideways off both pins, rather than hooking around itself.
    expect(result.added).toEqual([[p(0, 5), p(0, 0)]])
  })

  test('stacked parts a grid apart get one bend when one slides sideways', () => {
    // Top pin faces down at (10, 0), bottom pin faces up at (10, 1.27), wired
    // straight. The top part moves right: the wire leaves the top pin
    // sideways and arrives at the bottom pin along its axis.
    const input = geometry({ wires: [[p(10, 0), p(10, 1.27)]], pins: [pin(10, 1.27, 'up')] })
    const result = reshapeWires(input, [{ from: p(10, 0), to: p(15.08, 0), direction: 'down' }], {
      grid: GRID
    })
    expect(finalWires(input, result)).toEqual([
      [p(15.08, 0), p(10, 0)],
      [p(10, 0), p(10, 1.27)]
    ])
  })

  test('a label pulled off a bare pin takes a wire along', () => {
    const input = geometry({ pins: [pin(0, 0, 'right')] })
    const result = reshapeWires(input, [{ from: p(0, 0), to: p(10, 5), draws: true }], {
      grid: GRID
    })
    // The wire arrives at the pin along its axis; the label end bends freely.
    expect(result.added).toEqual([
      [p(10, 5), p(10, 0)],
      [p(10, 0), p(0, 0)]
    ])
  })

  test('a label pulled along the wire that ends on its pin adds nothing', () => {
    // The sixth run's VBAT case: label and capacitor pin at the end of a
    // horizontal wire, label dragged right. The wire lengthens through the
    // pin; a second run from pin to label would only double it.
    const input = geometry({
      wires: [[p(0, 0), p(10, 0)]],
      pins: [pin(0, 0, 'right'), pin(10, 0, 'up')]
    })
    const result = reshapeWires(
      input,
      [{ from: p(10, 0), to: p(15, 0), draws: true, direction: 'left' }],
      { grid: GRID }
    )
    expect(result.edits).toEqual([{ index: 0, points: [p(15, 0), p(0, 0)] }])
    expect(result.added).toEqual([])
  })

  test('a label pulled off a pin that also has a wire keeps both joined', () => {
    const input = geometry({ wires: [[p(0, 0), p(0, 10)]], pins: [pin(0, 0, 'right')] })
    const result = reshapeWires(input, [{ from: p(0, 0), to: p(10, 0), draws: true }], {
      grid: GRID
    })
    // The old wire (dangling at its far end) travels with the label; a new
    // wire joins the pin to it.
    expect(result.edits).toEqual([{ index: 0, points: [p(10, 0), p(10, 10)] }])
    expect(result.added).toEqual([[p(10, 0), p(0, 0)]])
    // Two wires and the label meet at the label; nothing but one wire at the pin.
    expect(result.junctionsAdded).toEqual([])
  })

  test('a global label dragged away keeps a stub off its anchor', () => {
    // Label reads left from (0,0), body to the left; the wire comes from the
    // pin on the right. Dragged left and down, the wire leaves the anchor
    // rightward for a grid step before rising, so it never lands on the body.
    const input = geometry({ wires: [[p(0, 0), p(10, 0)]], pins: [pin(10, 0, 'left')] })
    const result = reshapeWires(
      input,
      [{ from: p(0, 0), to: p(-5, 5), draws: true, direction: 'right' }],
      { grid: GRID }
    )
    expect(finalWires(input, result)).toEqual([
      [p(-5, 5), p(-3.73, 5)],
      [p(-3.73, 5), p(-3.73, 0)],
      [p(-3.73, 0), p(10, 0)]
    ])
  })

  test('a local label dragged away bends right at its anchor', () => {
    const input = geometry({ wires: [[p(0, 0), p(10, 0)]], pins: [pin(10, 0, 'left')] })
    const result = reshapeWires(input, [{ from: p(0, 0), to: p(-5, 5), draws: true }], {
      grid: GRID
    })
    expect(finalWires(input, result)).toEqual([
      [p(-5, 5), p(-5, 0)],
      [p(-5, 0), p(10, 0)]
    ])
  })

  test('a global label at the far end stays and gets its stub, and no junction', () => {
    const input = geometry({
      wires: [[p(10, 0), p(0, 0)]],
      pins: [{ position: p(0, 0), direction: 'right', label: true }]
    })
    const result = reshapeWires(input, [{ from: p(10, 0), to: p(10, 5), direction: 'left' }], {
      grid: GRID
    })
    expect(finalWires(input, result)).toEqual([
      [p(10, 5), p(8.73, 5)],
      [p(8.73, 5), p(8.73, 0)],
      [p(8.73, 0), p(0, 0)]
    ])
    expect(result.junctionsAdded).toEqual([])
  })

  test('a part carried past the bus it hangs from steps out beside itself', () => {
    // Resistor above a bus, its bottom pin wired straight down onto it.
    // Moved below the bus, the wire cannot run back up through the body: it
    // leaves the pin downward, steps one grid right, and rises to the bus.
    const input = geometry({
      wires: [
        [p(0, 0), p(0, 10)],
        [p(-10, 10), p(10, 10)]
      ],
      junctions: [p(0, 10)]
    })
    const result = reshapeWires(input, [{ from: p(0, 0), to: p(0, 15), direction: 'down' }], {
      grid: GRID
    })
    expect(finalWires(input, result)).toEqual([
      [p(0, 15), p(0, 16.27)],
      [p(-10, 10), p(10, 10)],
      [p(0, 16.27), p(1.27, 16.27)],
      [p(1.27, 16.27), p(1.27, 10)]
    ])
    expect(result.junctionsRemoved).toEqual([p(0, 10)])
    expect(result.junctionsAdded).toEqual([p(1.27, 10)])
  })

  test('a pin sitting mid-wire splits the wire, and both halves rise to meet it', () => {
    const input = geometry({
      wires: [[p(-10, 10), p(10, 10)]],
      pins: [pin(-10, 10, 'right'), pin(10, 10, 'left')]
    })
    const result = reshapeWires(input, [{ from: p(0, 10), to: p(0, 5), direction: 'down' }], {
      grid: GRID
    })
    expect(finalWires(input, result)).toEqual([
      [p(0, 5), p(0, 10)],
      [p(0, 10), p(-10, 10)],
      [p(0, 10), p(10, 10)]
    ])
    expect(result.junctionsAdded).toEqual([p(0, 10)])
  })

  test("a wire end T'd onto a dragged wire rides along", () => {
    const input = geometry({
      wires: [
        [p(0, 0), p(20, 0)],
        [p(10, 0), p(10, 10)]
      ],
      junctions: [p(10, 0)]
    })
    const result = reshapeWires(
      input,
      [
        { from: p(0, 0), to: p(0, -5) },
        { from: p(20, 0), to: p(20, -5) }
      ],
      { grid: GRID, movedWires: new Set([0]) }
    )
    expect(result.edits).toEqual([{ index: 1, points: [p(10, -5), p(10, 10)] }])
    expect(result.junctionsRemoved).toEqual([p(10, 0)])
    expect(result.junctionsAdded).toEqual([p(10, -5)])
  })

  test('a flag pulled off a pin just leaves it', () => {
    const input = geometry({ pins: [pin(0, 0, 'right')] })
    const result = reshapeWires(input, [{ from: p(0, 0), to: p(10, 5) }], { grid: GRID })
    expect(result.added).toEqual([])
  })

  test('a turned pin leaves along its new axis', () => {
    const input = geometry({ wires: [[p(10, 0), p(0, 0)]], junctions: [p(0, 0)] })
    const result = reshapeWires(
      input,
      [{ from: p(10, 0), to: p(10, 0), direction: 'up', directionBefore: 'left' }],
      {
        grid: GRID
      }
    )
    expect(finalWires(input, result)).toEqual([
      [p(10, 0), p(10, -1.27)],
      [p(10, -1.27), p(0, -1.27)],
      [p(0, -1.27), p(0, 0)]
    ])
  })

  test('a dragged wire end pulls the neighbor it is joined to', () => {
    // A Z: pin — horizontal — riser — horizontal — pin. Dragging the riser
    // sideways lengthens both horizontals; nothing else changes.
    const input = geometry({
      wires: [
        [p(10, 5), p(8, 5)],
        [p(8, 5), p(8, 0)],
        [p(8, 0), p(0, 0)]
      ],
      pins: [pin(10, 5, 'left'), pin(0, 0, 'right')]
    })
    const result = reshapeWires(
      input,
      [
        { from: p(8, 5), to: p(5, 5) },
        { from: p(8, 0), to: p(5, 0) }
      ],
      { grid: GRID, movedWires: new Set([1]) }
    )
    expect(result.edits).toEqual([
      { index: 0, points: [p(5, 5), p(10, 5)] },
      { index: 2, points: [p(5, 0), p(0, 0)] }
    ])
  })

  test('a wire that already left its pin sideways is slid, not redrawn', () => {
    const input = geometry({ wires: [[p(10, 0), p(0, 0)]], junctions: [p(0, 0)] })
    const result = reshapeWires(input, [{ from: p(10, 0), to: p(15, 0), direction: 'up' }], {
      grid: GRID
    })
    expect(result.edits).toEqual([{ index: 0, points: [p(15, 0), p(0, 0)] }])
    expect(result.added).toEqual([])
  })

  test('dragging a wire slides the junction its neighbor makes on a bus', () => {
    // A — corner — B — junction on the bus C. Dragging A along itself shifts
    // B sideways; the junction goes with it.
    const input = geometry({
      wires: [
        [p(0, 0), p(10, 0)],
        [p(10, 0), p(10, 10)],
        [p(-20, 10), p(20, 10)]
      ],
      junctions: [p(10, 10)]
    })
    const result = reshapeWires(
      input,
      [
        { from: p(0, 0), to: p(3, 0) },
        { from: p(10, 0), to: p(13, 0) }
      ],
      { grid: GRID, movedWires: new Set([0]) }
    )
    expect(result.edits).toEqual([{ index: 1, points: [p(13, 0), p(13, 10)] }])
    expect(result.added).toEqual([])
    expect(result.junctionsRemoved).toEqual([p(10, 10)])
    expect(result.junctionsAdded).toEqual([p(13, 10)])
  })

  test('dragging a wire slides the junction where its neighbor meets two wire ends', () => {
    const input = geometry({
      wires: [
        [p(0, 0), p(10, 0)],
        [p(10, 0), p(10, 10)],
        [p(-20, 10), p(10, 10)],
        [p(10, 10), p(20, 10)]
      ],
      junctions: [p(10, 10)]
    })
    const result = reshapeWires(
      input,
      [
        { from: p(0, 0), to: p(3, 0) },
        { from: p(10, 0), to: p(13, 0) }
      ],
      { grid: GRID, movedWires: new Set([0]) }
    )
    expect(result.edits).toEqual([{ index: 1, points: [p(13, 0), p(13, 10)] }])
    expect(result.added).toEqual([])
    expect(result.junctionsRemoved).toEqual([p(10, 10)])
    expect(result.junctionsAdded).toEqual([p(13, 10)])
  })

  test('a moved pin landing mid-wire gets a junction', () => {
    const input = geometry({ wires: [[p(0, 5), p(20, 5)]] })
    const result = reshapeWires(input, [{ from: p(10, 0), to: p(10, 5), direction: 'left' }], {
      grid: GRID
    })
    expect(result.edits).toEqual([])
    expect(result.junctionsAdded).toEqual([p(10, 5)])
  })

  test('the result depends on the final position, not the path', () => {
    const input = geometry({ wires: [[p(0, 0), p(10, 0)]], pins: [pin(0, 0, 'right')] })
    const back = reshapeWires(input, [{ from: p(10, 0), to: p(10, 0), direction: 'left' }], {
      grid: GRID
    })
    expect(back.edits).toEqual([{ index: 0, points: [p(10, 0), p(0, 0)] }])
    expect(back.added).toEqual([])
  })
})

describe('labelPortDirection', () => {
  test('a wire leaves a label back along its reading direction', () => {
    expect(labelPortDirection(0)).toBe('left')
    expect(labelPortDirection(180)).toBe('right')
    expect(labelPortDirection(90)).toBe('down')
  })
})

describe('directionOf', () => {
  test('folds KiCad angles onto the four sides', () => {
    expect(directionOf(0)).toBe('right')
    expect(directionOf(90)).toBe('up')
    expect(directionOf(180)).toBe('left')
    expect(directionOf(270)).toBe('down')
    expect(directionOf(-90)).toBe('down')
  })
})
