/**
 * The board checks as the project's rules and KiCad's effective shapes steer
 * them: custom rules, vias that drop their unused layers, teardrops, outlines.
 * Each fixture is drawn from first principles, to the behaviour it pins.
 */
import { describe, expect, test } from 'vitest'
import { parseKicadBoard } from '../../kicad/board'
import {
  DEFAULT_DESIGN_RULES,
  DEFAULT_NET_CLASSES,
  type BoardDesignSettings
} from '../../kicad/project'
import { BoardSpatialIndex } from '../spatialIndex'
import { computeConnectivity } from '../boardConnectivity'
import { boardChecks } from '../boardChecks'
import type { CheckResult } from '../../schematic/checks'

const HEAD = `(kicad_pcb (version 20241229) (generator "test")
  (general (thickness 1.6))
  (layers (0 "F.Cu" signal) (4 "In1.Cu" signal) (6 "In2.Cu" signal) (2 "B.Cu" signal)
    (25 "Edge.Cuts" user) (31 "F.CrtYd" user))
  (net 0 "") (net 1 "A") (net 2 "B")`

const OUTLINE = `
  (gr_rect (start 100 100) (end 140 140) (stroke (width 0.05)) (fill no) (layer "Edge.Cuts") (uuid "edge"))`

const settings = (customRules?: string): BoardDesignSettings => ({
  rules: { ...DEFAULT_DESIGN_RULES, minClearance: 0.1 },
  classes: DEFAULT_NET_CLASSES.map((cls) => ({ ...cls, clearance: 0.2 })),
  patterns: [],
  assignments: [],
  customRules
})

const run = (body: string, customRules?: string): CheckResult[] => {
  const board = parseKicadBoard(`${HEAD}${OUTLINE}${body}\n)`)
  const index = BoardSpatialIndex.build(board)
  return boardChecks({
    board,
    index,
    connectivity: computeConnectivity(board, index),
    settings: settings(customRules)
  }).filter((r) => r.code !== 'track-dangling' && r.code !== 'via-dangling')
}

const codes = (results: CheckResult[]): string[] => [...new Set(results.map((r) => r.code))].sort()

describe('custom rules', () => {
  const tracks = `
  (segment (start 110 110) (end 130 110) (width 0.2) (layer "F.Cu") (net 1) (uuid "a"))
  (segment (start 110 110.5) (end 130 110.5) (width 0.2) (layer "F.Cu") (net 2) (uuid "b"))`

  test('a rule widens the clearance for the nets it names, and the finding says which rule', () => {
    // 0.3 mm apart: the class's 0.2 passes, the rule's 0.5 does not.
    expect(run(tracks)).toEqual([])
    const results = run(
      tracks,
      `(version 1)
(rule "wide" (condition "A.NetName == 'A'") (constraint clearance (min 0.5mm)))`
    )
    expect(codes(results)).toEqual(['copper-clearance'])
    expect(results[0].message).toContain("rule 'wide' needs 0.5000 mm")
  })

  test('a rule file with an error applies nothing and says why', () => {
    const results = run(tracks, `(rule "no version" (constraint clearance (min 0.5mm)))`)
    expect(codes(results)).toEqual(['custom-rules'])
    expect(results[0].message).toMatch(/version/)
  })

  test('a disallow rule flags what it names where its condition holds', () => {
    const via = `
  (via (at 120 120) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 1) (uuid "v"))`
    const results = run(
      via,
      `(version 1)
(rule "no vias here" (condition "A.NetName == 'A'") (constraint disallow via))`
    )
    expect(codes(results)).toEqual(['items-not-allowed'])
    expect(results[0].message).toContain("rule 'no vias here'")
  })
})

describe('vias that drop their unused layers', () => {
  // A via on A, fed on F.Cu only: on In1.Cu it has no ring, only its 0.3 mm hole.
  // A track of B on In1.Cu passes 0.15 mm from the ring (0.6 mm across), too
  // close for the 0.2 mm clearance, and 0.3 mm from the hole, clear of it.
  const board = (flag: string): string => `
  (via (at 120 120) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") ${flag} (net 1) (uuid "v"))
  (segment (start 110 120) (end 120 120) (width 0.2) (layer "F.Cu") (net 1) (uuid "feed"))
  (segment (start 115 120.55) (end 125 120.55) (width 0.2) (layer "In1.Cu") (net 2) (uuid "t"))`

  test('are measured by their hole where they are not flashed', () => {
    expect(codes(run(board('')))).toEqual(['copper-clearance'])
    expect(run(board('(remove_unused_layers yes)'))).toEqual([])
  })
})

describe('teardrops', () => {
  test('copper of another net is held clear of a teardrop, as of any fill', () => {
    const teardrop = `
  (zone (net 1) (net_name "A") (layer "F.Cu") (uuid "td") (hatch edge 0.5)
    (attr (teardrop (type padvia)))
    (connect_pads yes (clearance 0)) (min_thickness 0.1) (filled_areas_thickness no)
    (fill yes (thermal_gap 0.5) (thermal_bridge_width 0.5))
    (polygon (pts (xy 118 119) (xy 122 119) (xy 122 121) (xy 118 121)))
    (filled_polygon (layer "F.Cu") (pts (xy 118 119) (xy 122 119) (xy 122 121) (xy 118 121))))
  (segment (start 110 121.15) (end 130 121.15) (width 0.1) (layer "F.Cu") (net 2) (uuid "t"))`
    expect(codes(run(teardrop))).toContain('copper-clearance')
  })

  test('a finding names a teardrop on the via it widens, and selects that', () => {
    const teardrop = `
  (via (at 120 120) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") (net 1) (uuid "v1"))
  (zone (net 1) (net_name "A") (layer "F.Cu") (hatch edge 0.5)
    (attr (teardrop (type padvia)))
    (connect_pads yes (clearance 0)) (min_thickness 0.1) (filled_areas_thickness no)
    (fill yes (thermal_gap 0.5) (thermal_bridge_width 0.5))
    (polygon (pts (xy 119.6 119.5) (xy 122 119.8) (xy 122 120.2) (xy 119.6 120.5)))
    (filled_polygon (layer "F.Cu") (pts (xy 119.6 119.5) (xy 122 119.8) (xy 122 120.2) (xy 119.6 120.5))))
  (segment (start 110 120.3) (end 130 120.3) (width 0.1) (layer "F.Cu") (net 2) (uuid "t"))`
    const found = run(teardrop).find((r) => r.message.includes('teardrop'))
    expect(found?.message).toContain('teardrop on via')
    expect(found?.items).toContain('v1')
  })
})

describe('the outline', () => {
  test('a stray open line beside a closed outline makes it invalid', () => {
    const stray = `
  (gr_line (start 105 105) (end 110 105) (stroke (width 0.05)) (layer "Edge.Cuts") (uuid "s"))`
    const results = run(stray)
    expect(codes(results)).toEqual(['invalid-outline'])
    expect(results[0].message).toContain('is not closed')
  })

  test('two closed shapes that cross make it invalid; one inside another does not', () => {
    const crossing = `
  (gr_circle (center 110 110) (end 111 110) (stroke (width 0.05)) (fill no) (layer "Edge.Cuts") (uuid "c1"))
  (gr_circle (center 111.5 110) (end 112.5 110) (stroke (width 0.05)) (fill no) (layer "Edge.Cuts") (uuid "c2"))`
    expect(codes(run(crossing))).toEqual(['invalid-outline'])
    const cutout = `
  (gr_circle (center 110 110) (end 111 110) (stroke (width 0.05)) (fill no) (layer "Edge.Cuts") (uuid "c1"))`
    expect(run(cutout)).toEqual([])
  })
})

describe('nets', () => {
  test('a net named empty is no net', () => {
    const board = parseKicadBoard(`${HEAD}${OUTLINE}
  (via (at 120 120) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net "") (uuid "v"))\n)`)
    expect(board.vias[0].net).toBe(0)
  })
})
