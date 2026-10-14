/**
 * Creepage over the board's surface (`board/creepage.ts`, `drc/rules/creepage.ts`),
 * each against a fixture whose shortest path is worked out by hand.
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
import { loadClipper } from '../../geometry/clip'
import type { CheckResult } from '../../schematic/checks'

const HEAD = `(kicad_pcb (version 20241229) (generator "test")
  (general (thickness 1.6))
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user))
  (setup (pad_to_mask_clearance 0))
  (net 0 "") (net 1 "A") (net 2 "B") (net 3 "C")`

/** A 40 × 40 mm board from (100,100). */
const OUTLINE = `
  (gr_rect (start 100 100) (end 140 140) (stroke (width 0.05)) (layer "Edge.Cuts") (uuid "edge"))`

/** Two 1 mm round SMD pads, net A at (110,120) and net B at (120,120): 9 mm apart edge to edge. */
const PADS = `
  (footprint "T:P" (layer "F.Cu") (uuid "fp1") (at 110 120)
    (property "Reference" "P1" (at 0 0) (layer "F.Fab") (uuid "r1"))
    (pad "1" smd circle (at 0 0) (size 1 1) (layers "F.Cu") (net 1 "A") (uuid "pa")))
  (footprint "T:P" (layer "F.Cu") (uuid "fp2") (at 120 120)
    (property "Reference" "P2" (at 0 0) (layer "F.Fab") (uuid "r2"))
    (pad "1" smd circle (at 0 0) (size 1 1) (layers "F.Cu") (net 2 "B") (uuid "pb")))`

const rule = (min: number): string =>
  `(version 1)\n(rule "creep" (constraint creepage (min ${min}mm)) (condition "A.NetName == 'A' && B.NetName == 'B'"))`

const settings = (): BoardDesignSettings => ({
  rules: { ...DEFAULT_DESIGN_RULES },
  classes: DEFAULT_NET_CLASSES.map((cls) => ({ ...cls })),
  patterns: [],
  assignments: []
})

const creepage = (body: string, customRules: string, outline = OUTLINE): CheckResult[] => {
  const board = parseKicadBoard(`${HEAD}${outline}${body}\n)`)
  const index = BoardSpatialIndex.build(board)
  return boardChecks({
    board,
    index,
    connectivity: computeConnectivity(board, index),
    settings: settings(),
    customRules
  }).filter((r) => r.code === 'creepage')
}

/** The distance a finding reports, mm. */
const actual = (result: CheckResult): number => Number(/are ([\d.]+) mm/.exec(result.message)![1])

beforeAll(async () => {
  await loadClipper()
})

describe('creepage', () => {
  test('in the open the path is straight: 9 mm, under a 10 mm rule and over an 8 mm one', () => {
    const found = creepage(PADS, rule(10))
    expect(found.map((r) => r.items)).toEqual([['P1.1', 'P2.1']])
    expect(actual(found[0])).toBeCloseTo(9, 4)
    expect(creepage(PADS, rule(8))).toEqual([])
    // Another net's pair gets no rule, so nothing is checked for it.
    expect(creepage(PADS, rule(10).replace("'B'", "'C'"))).toEqual([])
  })

  test('a slot between them sends the path round its end', () => {
    // A 0.2 mm slot from y 112 to 128 at x 115: round a corner at (114.9, 128)
    // and (115.1, 128), each √(4.9² + 8²) from a pad's center.
    const slot = `
  (gr_rect (start 114.9 112) (end 115.1 128) (stroke (width 0.05)) (layer "Edge.Cuts") (uuid "slot"))`
    const around = 2 * (Math.hypot(4.9, 8) - 0.5) + 0.2
    expect(creepage(PADS + slot, rule(17.9))).toEqual([])
    const found = creepage(PADS + slot, rule(18))
    expect(actual(found[0])).toBeCloseTo(around, 3)
  })

  test('round an unplated hole, the path hugs its wall between the two tangents', () => {
    // A 4 mm hole at (115,120): tangents from each pad's center, then the arc between.
    const hole = `
  (footprint "T:H" (layer "F.Cu") (uuid "fp3") (at 115 120)
    (property "Reference" "H1" (at 0 0) (layer "F.Fab") (uuid "r3"))
    (pad "" np_thru_hole circle (at 0 0) (size 4 4) (drill 4) (layers "*.Cu") (uuid "ph")))`
    const d = 5
    const r = 2
    const tangent = Math.sqrt(d * d - r * r)
    const wrap = 2 * r * (Math.PI / 2 - Math.acos(r / d))
    const around = 2 * (tangent - 0.5) + wrap
    const found = creepage(PADS + hole, rule(12))
    expect(actual(found[0])).toBeCloseTo(around, 3)
  })

  test("a path may not cross another net's track, whatever runs round it", () => {
    // A track of net C from edge to edge between the pads: no path is left.
    const fence = `
  (segment (start 115 100) (end 115 140) (width 0.2) (layer "F.Cu") (net 3) (uuid "fence"))`
    expect(creepage(PADS + fence, rule(40))).toEqual([])
    // On the other layer it is no fence.
    expect(creepage(PADS + fence.replace('"F.Cu"', '"B.Cu"'), rule(10))).toHaveLength(1)
  })

  test('where the outline does not close, every path is straight', () => {
    const slot = `
  (gr_rect (start 114.9 112) (end 115.1 128) (stroke (width 0.05)) (layer "Edge.Cuts") (uuid "slot"))`
    const open = `
  (gr_line (start 100 100) (end 140 100) (stroke (width 0.05)) (layer "Edge.Cuts") (uuid "e1"))
  (gr_line (start 140 100) (end 140 140) (stroke (width 0.05)) (layer "Edge.Cuts") (uuid "e2"))`
    const found = creepage(PADS + slot, rule(10), open)
    expect(actual(found[0])).toBeCloseTo(9, 4)
  })
})
