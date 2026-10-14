/**
 * The minimum connection width and copper slivers against fixtures drawn from
 * first principles (`necks.ts`, `drc/rules/connectionWidth.ts`,
 * `drc/rules/copperSliver.ts`).
 */
import { beforeAll, describe, expect, test } from 'vitest'
import { parseKicadBoard } from '../../kicad/board'
import {
  DEFAULT_DESIGN_RULES,
  DEFAULT_NET_CLASSES,
  type BoardDesignSettings
} from '../../kicad/project'
import { BoardSpatialIndex } from '../spatialIndex'
import { computeConnectivity } from '../boardConnectivity'
import { boardChecks } from '../boardChecks'
import { findNecks, findSlivers } from '../necks'
import { loadClipper } from '../../geometry/clip'
import { YStripes } from '../../geometry/yStripes'
import type { CheckResult } from '../../schematic/checks'

const HEAD = `(kicad_pcb (version 20241229) (generator "test")
  (general (thickness 1.6))
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user))
  (setup (pad_to_mask_clearance 0))
  (net 0 "") (net 1 "A") (net 2 "B")`

const run = (body: string, minConnection: number): CheckResult[] => {
  const settings: BoardDesignSettings = {
    rules: { ...DEFAULT_DESIGN_RULES, minConnectionWidth: minConnection },
    classes: DEFAULT_NET_CLASSES.map((cls) => ({ ...cls })),
    patterns: [],
    assignments: []
  }
  const board = parseKicadBoard(`${HEAD}${body}\n)`)
  const index = BoardSpatialIndex.build(board)
  return boardChecks({ board, index, connectivity: computeConnectivity(board, index), settings })
}

const found = (results: CheckResult[], code: string): string[][] =>
  results.filter((r) => r.code === code).map((r) => r.items)

beforeAll(async () => {
  await loadClipper()
})

describe('necks', () => {
  // Two squares joined by a bridge 0.1 wide.
  const dumbbell = {
    outer: [
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 2, y: 0.95 },
      { x: 3, y: 0.95 },
      { x: 3, y: 0 },
      { x: 5, y: 0 },
      { x: 5, y: 2 },
      { x: 3, y: 2 },
      { x: 3, y: 1.05 },
      { x: 2, y: 1.05 },
      { x: 2, y: 2 },
      { x: 0, y: 2 }
    ],
    holes: []
  }

  test('a bridge between two wide pieces is a neck its width across', () => {
    const necks = findNecks(dumbbell, 0.2)
    expect(necks.length).toBeGreaterThan(0)
    expect(Math.min(...necks.map((n) => n.width))).toBeCloseTo(0.1, 6)
    expect(findNecks(dumbbell, 0.05)).toEqual([])
  })

  test('a long narrow strip is no neck: nothing spreads out past its ends', () => {
    const strip = {
      outer: [
        { x: 0, y: 0 },
        { x: 5, y: 0 },
        { x: 5, y: 0.1 },
        { x: 0, y: 0.1 }
      ],
      holes: []
    }
    expect(findNecks(strip, 0.2)).toEqual([])
  })
})

describe('connection width', () => {
  const tracks = (gap: number): string => `
  (segment (start 100 100) (end 105 100) (width 0.25) (layer "F.Cu") (net 1) (uuid "t1"))
  (segment (start ${105 + gap} 100) (end 110 100) (width 0.25) (layer "F.Cu") (net 1) (uuid "t2"))`

  test('two tracks whose round ends barely overlap narrow below the minimum', () => {
    expect(found(run(tracks(0.2286), 0.12), 'connection-width')).toEqual([['t1', 't2']])
    expect(found(run(tracks(0.2032), 0.12), 'connection-width')).toEqual([])
  })

  test('nothing is measured where no rule sets a width', () => {
    expect(found(run(tracks(0.2286), 0), 'connection-width')).toEqual([])
  })
})

describe('copper slivers', () => {
  test('a spike sharper than 20° is a sliver; a right angle is not', () => {
    const ring = [
      { x: 0, y: 0 },
      { x: 5, y: 0 },
      { x: 5, y: 1 },
      { x: 3, y: 1 },
      { x: 0, y: 1.4 },
      { x: 2.8, y: 1 },
      { x: 0, y: 1 }
    ]
    const inside = (ring: { x: number; y: number }[]) => {
      const stripes = new YStripes(ring)
      return (p: { x: number; y: number }): boolean => stripes.contains(p)
    }
    expect(findSlivers(ring, inside(ring), { angle: 20, mouth: 0.08, merge: 0.0008 }).length).toBe(
      1
    )
    const square = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0.5, y: 1 },
      { x: 0, y: 1 },
      { x: 0, y: 0.5 }
    ]
    expect(findSlivers(square, inside(square), { angle: 20, mouth: 0.08, merge: 0.0008 })).toEqual(
      []
    )
  })

  test('a copper polygon ending in a spike is flagged on its layer, naming no item', () => {
    const results = run(
      `
  (gr_poly (pts (xy 100 100) (xy 110 100) (xy 110 102) (xy 104 102) (xy 100 103.5) (xy 103 102) (xy 100 102) (xy 100 101))
    (stroke (width 0)) (fill yes) (layer "F.Cu") (uuid "g1"))`,
      0
    )
    expect(results.filter((r) => r.code === 'copper-sliver').map((r) => r.items)).toEqual([[]])
  })
})
