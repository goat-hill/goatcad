/**
 * Solder-mask bridges against fixtures drawn from first principles
 * (`drc/rules/solderMask.ts`): two openings too close for the mask web,
 * copper too close to another net's opening, and an opening of no copper of
 * its own baring two nets.
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

const head = (setup = ''): string => `(kicad_pcb (version 20241229) (generator "test")
  (general (thickness 1.6))
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (1 "F.Mask" user) (3 "B.Mask" user) (25 "Edge.Cuts" user))
  (setup (pad_to_mask_clearance 0) ${setup})
  (net 0 "") (net 1 "A") (net 2 "B")`

const settings = (): BoardDesignSettings => ({
  rules: { ...DEFAULT_DESIGN_RULES },
  classes: DEFAULT_NET_CLASSES.map((cls) => ({ ...cls })),
  patterns: [],
  assignments: []
})

const bridges = (body: string, setup = ''): string[][] => {
  const board = parseKicadBoard(`${head(setup)}${body}\n)`)
  const index = BoardSpatialIndex.build(board)
  return boardChecks({
    board,
    index,
    connectivity: computeConnectivity(board, index),
    settings: settings()
  })
    .filter((r: CheckResult) => r.code === 'solder-mask-bridge')
    .map((r) => r.items)
}

/** Two 1 mm pads of nets A and B, `gap` apart, each in a footprint of its own. */
const twoPads = (gap: number, attr = ''): string => `
  (footprint "T:P" (layer "F.Cu") (uuid "f1") (at 120 120) ${attr}
    (property "Reference" "R1" (at 0 3) (layer "F.Fab") (uuid "r1"))
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu" "F.Mask") (net 1 "A") (uuid "p1")))
  (footprint "T:P" (layer "F.Cu") (uuid "f2") (at ${121 + gap} 120) ${attr}
    (property "Reference" "R2" (at 0 3) (layer "F.Fab") (uuid "r2"))
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu" "F.Mask") (net 2 "B") (uuid "p2")))`

beforeAll(async () => {
  await loadClipper()
})

describe('opening against opening', () => {
  test('two openings of different nets closer than the minimum web bridge', () => {
    expect(bridges(twoPads(0.1), '(solder_mask_min_width 0.2)')).toEqual([['R1.1', 'R2.1']])
    expect(bridges(twoPads(0.3), '(solder_mask_min_width 0.2)')).toEqual([])
  })

  test('with no minimum web, openings bridge only where they meet', () => {
    expect(bridges(twoPads(0.1))).toEqual([])
    expect(bridges(twoPads(-0.1))).toEqual([['R1.1', 'R2.1']])
  })

  test('a footprint that allows bridges excuses its own openings, not two footprints', () => {
    const one = `
  (footprint "T:P" (layer "F.Cu") (uuid "f1") (at 120 120) (attr smd allow_soldermask_bridges)
    (property "Reference" "U1" (at 0 3) (layer "F.Fab") (uuid "r1"))
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu" "F.Mask") (net 1 "A") (uuid "p1"))
    (pad "2" smd rect (at 1.05 0) (size 1 1) (layers "F.Cu" "F.Mask") (net 2 "B") (uuid "p2")))`
    expect(bridges(one, '(solder_mask_min_width 0.2)')).toEqual([])
    expect(
      bridges(one.replace(' allow_soldermask_bridges', ''), '(solder_mask_min_width 0.2)')
    ).toEqual([['U1.1', 'U1.2']])
  })
})

describe('copper against an opening', () => {
  test("a track of another net under a pad's mask margin is bared with it", () => {
    const pad = `
  (footprint "T:P" (layer "F.Cu") (uuid "f1") (at 120 120)
    (property "Reference" "R1" (at 0 3) (layer "F.Fab") (uuid "r1"))
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu" "F.Mask") (net 1 "A") (solder_mask_margin 0.3) (uuid "p1")))`
    const track = (y: number, net: number): string =>
      `(segment (start 118 ${y}) (end 122 ${y}) (width 0.2) (layer "F.Cu") (net ${net}) (uuid "t1"))`
    expect(bridges(`${pad}\n  ${track(120.7, 2)}`)).toEqual([['R1.1', 't1']])
    expect(bridges(`${pad}\n  ${track(120.7, 1)}`)).toEqual([])
    expect(bridges(`${pad}\n  ${track(121.2, 2)}`)).toEqual([])
  })
})

describe('an opening of no copper of its own', () => {
  test('bares two nets: the finding names the opening and both', () => {
    const body = `
  (gr_rect (start 119 119) (end 124 121) (stroke (width 0)) (fill yes) (layer "F.Mask") (uuid "m1"))
  (segment (start 120 120) (end 120 125) (width 0.2) (layer "F.Cu") (net 1) (uuid "t1"))
  (segment (start 123 120) (end 123 125) (width 0.2) (layer "F.Cu") (net 2) (uuid "t2"))`
    expect(bridges(body)).toEqual([['m1', 't1', 't2']])
    expect(bridges(body.replace('(net 2) (uuid "t2")', '(net 1) (uuid "t2")'))).toEqual([])
  })
})
