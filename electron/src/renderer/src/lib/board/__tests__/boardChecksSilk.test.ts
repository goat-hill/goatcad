/**
 * The silkscreen rules against fixtures drawn from first principles: silk on
 * silk, silk on a mask opening, silk across the edge (`drc/rules/silk.ts`).
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
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (1 "F.Mask" user) (5 "F.SilkS" user)
    (25 "Edge.Cuts" user))
  (setup (pad_to_mask_clearance 0))
  (net 0 "") (net 1 "A")
  (gr_rect (start 100 100) (end 140 140) (stroke (width 0.05)) (fill no) (layer "Edge.Cuts") (uuid "edge"))`

const settings = (): BoardDesignSettings => ({
  rules: { ...DEFAULT_DESIGN_RULES, minSilkClearance: 0, minTextHeight: 0, minTextThickness: 0 },
  classes: DEFAULT_NET_CLASSES.map((cls) => ({ ...cls })),
  patterns: [],
  assignments: []
})

const run = (body: string): CheckResult[] => {
  const board = parseKicadBoard(`${HEAD}${body}\n)`)
  const index = BoardSpatialIndex.build(board)
  return boardChecks({
    board,
    index,
    connectivity: computeConnectivity(board, index),
    settings: settings()
  })
}

const found = (results: CheckResult[], code: string): string[][] =>
  results.filter((r) => r.code === code).map((r) => r.items)

const line = (
  uuid: string,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  layer = 'F.SilkS'
): string =>
  `(gr_line (start ${x0} ${y0}) (end ${x1} ${y1}) (stroke (width 0.2)) (layer "${layer}") (uuid "${uuid}"))`

beforeAll(async () => {
  await loadClipper()
})

describe('silk against silk', () => {
  test('a text over a line overlaps it; two board lines are one drawing and never do', () => {
    const results = run(`
  ${line('l1', 110, 110, 120, 110)}
  ${line('l2', 115, 105, 115, 115)}
  (gr_text "X" (at 115 110) (layer "F.SilkS") (uuid "t1") (effects (font (size 1 1) (thickness 0.15))))`)
    expect(found(results, 'silk-overlap')).toEqual([
      ['l1', 't1'],
      ['l2', 't1']
    ])
  })

  test('two strokes that only touch do not overlap', () => {
    const results = run(`
  ${line('l1', 110, 110, 120, 110)}
  (gr_text "I" (at 115 110.95) (layer "F.SilkS") (uuid "t1") (effects (font (size 1 1) (thickness 0.1))))`)
    expect(found(results, 'silk-overlap')).toEqual([])
  })
})

describe('silk against the mask', () => {
  const pad = (layers: string): string => `
  (footprint "T:P" (layer "F.Cu") (uuid "fp") (at 120 120)
    (property "Reference" "R1" (at 0 5) (layer "F.Fab") (uuid "ref"))
    (pad "1" smd rect (at 0 0) (size 2 2) (layers ${layers}) (net 1 "A") (uuid "p1")))`

  test('silk across a pad opening is clipped; one on a pad with no opening is not', () => {
    const across = `\n  ${line('l1', 118, 120, 122, 120)}`
    expect(found(run(pad('"F.Cu" "F.Mask"') + across), 'silk-over-copper')).toEqual([
      ['R1.1', 'l1']
    ])
    expect(found(run(pad('"F.Cu"') + across), 'silk-over-copper')).toEqual([])
  })

  test('a pad drawn on the silkscreen too is one overlap, not a clip as well', () => {
    const results = run(`${pad('"F.Cu" "F.Mask" "F.SilkS"')}\n  ${line('l1', 118, 120, 122, 120)}`)
    expect(found(results, 'silk-overlap')).toEqual([['R1.1', 'l1']])
    expect(found(results, 'silk-over-copper')).toEqual([])
  })
})

describe('silk against the edge', () => {
  test('silk crossing the board edge is clipped; silk inside it is not', () => {
    const results = run(`
  ${line('out', 95, 120, 105, 120)}
  ${line('in', 110, 120, 115, 120)}`)
    expect(found(results, 'silk-edge-clearance')).toEqual([['edge', 'out']])
  })
})

describe('knockout text', () => {
  test('is its box, so a line through a gap between its glyphs still meets it', () => {
    const results = run(`
  ${line('l1', 114.5, 105, 114.5, 115)}
  (gr_text "I I" (at 115 110) (layer "F.SilkS" knockout) (uuid "t1")
    (effects (font (size 1 1) (thickness 0.15))))`)
    expect(found(results, 'silk-overlap')).toEqual([['l1', 't1']])
  })
})
