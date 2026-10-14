import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseKicadBoard } from '../../../kicad/board'
import { buildBoardOutline, chainEdges, nestRings } from '../boardOutline'
import { signedArea, type Pt } from '../flatMesh'
import { CANARY_BOARD } from '../../../__tests__/canaryFixture'

const ring = (...points: [number, number][]): Pt[] => points.map(([x, y]) => ({ x, y }))

const edgeCut = (x1: number, y1: number, x2: number, y2: number): string =>
  `(gr_line (start ${x1} ${y1}) (end ${x2} ${y2}) (layer "Edge.Cuts") (stroke (width 0.1) (type solid)))`

const boardWith = (body: string): string => `
(kicad_pcb (version 20221018) (generator pcbnew)
  (general (thickness 1.6))
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))
  (net 0 "")
  ${body})
`

describe('chainEdges', () => {
  it('walks scattered, arbitrarily-directed edges into one ring', () => {
    // Deliberately out of order, and two of them pointing "backwards".
    const { rings, open } = chainEdges([
      [
        { x: 10, y: 0 },
        { x: 10, y: 10 }
      ],
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 }
      ],
      [
        { x: 0, y: 10 },
        { x: 0, y: 0 }
      ],
      [
        { x: 0, y: 10 },
        { x: 10, y: 10 }
      ]
    ])
    expect(open).toEqual([])
    expect(rings).toHaveLength(1)
    expect(rings[0]).toHaveLength(4)
    expect(Math.abs(signedArea(rings[0]))).toBeCloseTo(100, 6)
  })

  it('closes a ring whose corners are within the join tolerance', () => {
    const { rings, open } = chainEdges([
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 }
      ],
      [
        { x: 10.004, y: 0 },
        { x: 10, y: 10 }
      ],
      [
        { x: 10, y: 10 },
        { x: 0, y: 10 }
      ],
      [
        { x: 0, y: 10 },
        { x: 0, y: 0.003 }
      ]
    ])
    expect(open).toEqual([])
    expect(rings).toHaveLength(1)
  })

  it('reports a chain with a real gap as open rather than inventing a ring', () => {
    const { rings, open } = chainEdges([
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 }
      ],
      [
        { x: 10, y: 0 },
        { x: 10, y: 10 }
      ],
      [
        { x: 10, y: 10 },
        { x: 0, y: 10 }
      ]
      // The closing edge is missing.
    ])
    expect(rings).toEqual([])
    expect(open).toHaveLength(1)
  })

  it('separates two disjoint rings', () => {
    const { rings } = chainEdges([
      [
        { x: 0, y: 0 },
        { x: 1, y: 0 }
      ],
      [
        { x: 1, y: 0 },
        { x: 0, y: 1 }
      ],
      [
        { x: 0, y: 1 },
        { x: 0, y: 0 }
      ],
      [
        { x: 5, y: 0 },
        { x: 6, y: 0 }
      ],
      [
        { x: 6, y: 0 },
        { x: 5, y: 1 }
      ],
      [
        { x: 5, y: 1 },
        { x: 5, y: 0 }
      ]
    ])
    expect(rings).toHaveLength(2)
  })
})

describe('nestRings', () => {
  it('makes a contained ring a cutout of its container', () => {
    const regions = nestRings([
      ring([0, 0], [10, 0], [10, 10], [0, 10]),
      ring([2, 2], [4, 2], [4, 4], [2, 4])
    ])
    expect(regions).toHaveLength(1)
    expect(regions[0].holes).toHaveLength(1)
    expect(Math.abs(signedArea(regions[0].holes[0]))).toBeCloseTo(4, 6)
  })

  it('counts depth, so an island inside a cutout is board again', () => {
    const regions = nestRings([
      ring([0, 0], [20, 0], [20, 20], [0, 20]),
      ring([2, 2], [12, 2], [12, 12], [2, 12]),
      ring([4, 4], [8, 4], [8, 8], [4, 8])
    ])
    expect(regions).toHaveLength(2)
    const island = regions.find((r) => Math.abs(signedArea(r.outer)) === 16)
    expect(island).toBeDefined()
    expect(island?.holes).toEqual([])
  })

  it('keeps disjoint rings as separate regions (a panelized board)', () => {
    const regions = nestRings([
      ring([0, 0], [5, 0], [5, 5], [0, 5]),
      ring([10, 0], [15, 0], [15, 5], [10, 5])
    ])
    expect(regions).toHaveLength(2)
    expect(regions.every((r) => r.holes.length === 0)).toBe(true)
  })

  it('ignores rings with no area', () => {
    expect(nestRings([ring([0, 0], [1, 0], [2, 0])])).toEqual([])
  })
})

describe('buildBoardOutline', () => {
  it('turns four Edge.Cuts lines into a y-up region', () => {
    const board = parseKicadBoard(
      boardWith(
        [
          edgeCut(0, 0, 40, 0),
          edgeCut(40, 0, 40, 30),
          edgeCut(40, 30, 0, 30),
          edgeCut(0, 30, 0, 0)
        ].join('\n  ')
      )
    )
    const outline = buildBoardOutline(board)
    expect(outline.fallback).toBe(false)
    expect(outline.regions).toHaveLength(1)
    // KiCad y runs down, so the board occupies negative world y.
    const ys = outline.regions[0].outer.map((p) => p.y)
    expect(Math.min(...ys)).toBeCloseTo(-30, 6)
    expect(Math.max(...ys)).toBeCloseTo(0, 6)
    expect(Math.abs(signedArea(outline.regions[0].outer))).toBeCloseTo(1200, 4)
  })

  it('takes an Edge.Cuts circle as a ring on its own', () => {
    const board = parseKicadBoard(
      boardWith('(gr_circle (center 0 0) (end 10 0) (layer "Edge.Cuts") (stroke (width 0.1)))')
    )
    const outline = buildBoardOutline(board)
    expect(outline.fallback).toBe(false)
    // Tessellated, so the inscribed polygon is just under the true π·r².
    const area = Math.abs(signedArea(outline.regions[0].outer))
    expect(area).toBeLessThan(Math.PI * 100)
    expect(area).toBeGreaterThan(Math.PI * 100 * 0.998)
  })

  it('reads a footprint-level Edge.Cuts cutout as a hole in the board', () => {
    const board = parseKicadBoard(
      boardWith(
        [
          edgeCut(0, 0, 40, 0),
          edgeCut(40, 0, 40, 30),
          edgeCut(40, 30, 0, 30),
          edgeCut(0, 30, 0, 0),
          `(footprint "MountingHole" (layer "F.Cu") (at 20 15)
             (fp_circle (center 0 0) (end 2 0) (layer "Edge.Cuts") (stroke (width 0.1))))`
        ].join('\n  ')
      )
    )
    const outline = buildBoardOutline(board)
    expect(outline.regions).toHaveLength(1)
    expect(outline.regions[0].holes).toHaveLength(1)
  })

  it('falls back to a padded bounding box, and says so, with no outline at all', () => {
    const board = parseKicadBoard(
      boardWith('(segment (start 5 5) (end 15 5) (width 0.25) (layer "F.Cu") (net 0))')
    )
    const outline = buildBoardOutline(board)
    expect(outline.fallback).toBe(true)
    expect(outline.regions).toHaveLength(1)
    const xs = outline.regions[0].outer.map((p) => p.x)
    expect(Math.min(...xs)).toBeCloseTo(4, 6)
    expect(Math.max(...xs)).toBeCloseTo(16, 6)
  })

  it('has nothing to show for an empty board', () => {
    const outline = buildBoardOutline(parseKicadBoard(boardWith('')))
    expect(outline.fallback).toBe(true)
    expect(outline.regions).toEqual([])
  })
})

const FIXTURE = CANARY_BOARD

describe('smoke test — a real KiCad board', () => {
  it('recovers a single closed outline with no open chains', () => {
    const board = parseKicadBoard(readFileSync(FIXTURE, 'utf8'))
    const outline = buildBoardOutline(board)
    expect(outline.fallback).toBe(false)
    expect(outline.openCount).toBe(0)
    expect(outline.regions.length).toBeGreaterThanOrEqual(1)
    expect(Math.abs(signedArea(outline.regions[0].outer))).toBeGreaterThan(100)
  })
})
