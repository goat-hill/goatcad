/**
 * The audit's cases (design-health-workstream.md), each drawn from first
 * principles; every board's findings are what kicad-cli 10.0.6 reports for it,
 * under KiCad's compiled-in rules as a board with no project gets them.
 */
import { describe, expect, test } from 'vitest'
import { parseKicadBoard } from '../../kicad/board'
import { DEFAULT_NET_CLASSES } from '../../kicad/project'
import { KICAD_DEFAULTS } from '../../__tests__/kicadDefaults'
import { BoardSpatialIndex } from '../spatialIndex'
import { computeConnectivity } from '../boardConnectivity'
import { BOARD_KICAD_KEYS, boardChecks } from '../boardChecks'

const head = (
  nets: string[],
  version = 20250401
): string => `(kicad_pcb (version ${version}) (generator "test")
  (general (thickness 1.6))
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user))
  ${['', ...nets].map((name, i) => `(net ${i} "${name}")`).join(' ')}
  (gr_rect (start 0 0) (end 40 30) (stroke (width 0.05)) (fill no) (layer "Edge.Cuts") (uuid "edge"))`

const footprint = (at: [number, number], pads: string, extra = ''): string => `
  (footprint "L:F" (layer "F.Cu") (uuid "fp") (at ${at[0]} ${at[1]}) ${extra}
    (property "Reference" "U1" (at 0 -3) (layer "F.SilkS") (hide yes) (uuid "ref") (effects (font (size 1 1) (thickness 0.15))))
    ${pads})`

const track = (
  a: [number, number],
  b: [number, number],
  width: number,
  net: number,
  id: string
): string =>
  `(segment (start ${a[0]} ${a[1]}) (end ${b[0]} ${b[1]}) (width ${width}) (layer "F.Cu") (net ${net}) (uuid "${id}"))`

/** KiCad's keys for what the board raises, the rules a placeholder footprint trips left out. */
const IGNORED = new Set([
  'silk_over_copper',
  'lib_footprint_issues',
  'footprint_type_mismatch',
  'missing_courtyard',
  'lib_footprint_mismatch',
  'unconnected_items'
])
const keys = (text: string, customRules?: string): string[] => {
  const board = parseKicadBoard(`${text}\n)`)
  const index = BoardSpatialIndex.build(board)
  return boardChecks({
    board,
    index,
    connectivity: computeConnectivity(board, index),
    settings: {
      rules: { ...KICAD_DEFAULTS },
      classes: DEFAULT_NET_CLASSES.map((cls) => ({ ...cls })),
      patterns: [],
      assignments: [],
      ...(customRules ? { customRules } : {})
    }
  })
    .map((r) => BOARD_KICAD_KEYS[r.code] ?? r.code)
    .filter((key) => !IGNORED.has(key))
    .sort()
}

describe('the audit, held to kicad-cli', () => {
  test('a free pad takes the net of the track that reaches it', () => {
    const pad = `(pad "1" smd rect (at 0 0) (size 1.5 1.5) (layers "F.Cu") (net 2 "unconnected-(U1-Pad1)") (pintype "free") (uuid "p"))`
    expect(
      keys(
        head(['GND', 'unconnected-(U1-Pad1)']) +
          footprint([10, 10], pad) +
          track([10, 10], [20, 10], 0.25, 1, 't')
      )
    ).toEqual(['track_dangling'])
  })

  test("a track may meet the edge inside a castellated pad's hole", () => {
    const pad = `(pad "1" thru_hole circle (at 0 0) (size 1.6 1.6) (drill 1) (property pad_prop_castellated) (layers "*.Cu" "*.Mask") (net 1 "SIG") (uuid "p"))`
    expect(
      keys(head(['SIG']) + footprint([40, 15], pad) + track([39.5, 15], [40.2, 15], 0.2, 1, 't'))
    ).toEqual([])
  })

  test("a pad's (clearance 0) masks its footprint's in a current file, and is unset in an older one", () => {
    const pad = `(pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 1 "A") (clearance 0) (uuid "p"))`
    const body = (version: number): string =>
      head(['A', 'B'], version) +
      footprint([10, 10], pad, '(clearance 0.5)') +
      track([10.8, 8], [10.8, 12], 0.2, 2, 't')
    expect(keys(body(20241229))).toEqual(['track_dangling'])
    expect(keys(body(20231014))).toEqual(['clearance', 'track_dangling'])
  })

  test('pads of one number are one pad: their copper makes the ring', () => {
    const smd = (at: string, size: string): string =>
      `(pad "EP" smd rect (at ${at}) (size ${size}) (layers "F.Cu") (net 1 "GND") (uuid "s${at}"))`
    const tht = (at: string, size: string, drill: number, shape = 'circle'): string =>
      `(pad "EP" thru_hole ${shape} (at ${at}) (size ${size}) (drill ${drill}) (layers "*.Cu") (net 1 "GND") (uuid "t${at}"))`
    const ring = (pads: string): string[] => keys(head(['GND']) + footprint([10, 10], pads))
    expect(ring(smd('0 0', '3 3') + tht('0 0', '0.5 0.5', 0.3))).toEqual([])
    expect(ring(smd('0 0', '3 3') + tht('1.4 0', '0.5 0.5', 0.3))).toEqual([])
    expect(ring(smd('0 0', '3 3') + tht('0 0', '0.4 0.4', 0.3))).toEqual([])
    expect(ring(tht('0 0', '1 1', 0.6) + tht('0.5 0', '1 1', 0.6))).toEqual([
      'annular_width',
      'annular_width',
      'hole_to_hole'
    ])
    expect(ring(tht('0 0', '0.6 2', 0.5, 'rect') + smd('0.8 0', '1.2 1.2'))).toEqual([
      'annular_width'
    ])
    // A round pad only partly overlapped keeps its own ring (KiCad's issue 24340).
    expect(ring(tht('-1.4 0', '0.3 0.3', 0.2) + smd('-1 0', '1 1'))).toEqual([
      'annular_width',
      'drill_out_of_range'
    ])
  })

  test('a teardrop reaching into an area that forbids tracks is not allowed', () => {
    const teardrop = `
  (zone (net 1) (net_name "SIG") (layer "F.Cu") (uuid "td") (name "$teardrop_padvia$") (hatch edge 0.5)
    (priority 30000) (attr (teardrop (type padvia))) (connect_pads yes (clearance 0))
    (min_thickness 0.0254) (filled_areas_thickness no)
    (fill yes (thermal_gap 0.5) (thermal_bridge_width 0.5) (island_removal_mode 1) (island_area_min 10))
    (polygon (pts (xy 11 14) (xy 11 16) (xy 13 15.125) (xy 13 14.875)))
    (filled_polygon (layer "F.Cu") (pts (xy 11 14) (xy 11 16) (xy 13 15.125) (xy 13 14.875))))`
    const area = (tracks: string): string => `
  (zone (net 0) (net_name "") (layer "F.Cu") (uuid "k") (hatch edge 0.5) (connect_pads (clearance 0))
    (min_thickness 0.25) (keepout (tracks ${tracks}) (vias allowed) (pads allowed) (copperpour allowed) (footprints allowed))
    (fill (thermal_gap 0.5) (thermal_bridge_width 0.5))
    (polygon (pts (xy 11.5 14.2) (xy 12.5 14.2) (xy 12.5 14.7) (xy 11.5 14.7))))`
    const pad = `(pad "1" smd rect (at 0 0) (size 2 2) (layers "F.Cu") (net 1 "SIG") (uuid "p"))`
    const board = (tracks: string): string[] =>
      keys(
        head(['SIG']) +
          footprint([10, 15], pad) +
          track([10, 15], [25, 15], 0.25, 1, 't') +
          teardrop +
          area(tracks)
      )
    expect(board('not_allowed')).toEqual(['items_not_allowed', 'track_dangling'])
    expect(board('allowed')).toEqual(['track_dangling'])
  })

  test("an area test reads a zone by its fill, not its outline, and touching the area's edge is not entering it", () => {
    const zone = (fill: string): string => `
  (zone (net 1) (net_name "GND") (layer "F.Cu") (uuid "z") (hatch edge 0.5)
    (connect_pads (clearance 0.2)) (min_thickness 0.25) (filled_areas_thickness no)
    (fill yes (thermal_gap 0.5) (thermal_bridge_width 0.5))
    (polygon (pts (xy 5 5) (xy 30 5) (xy 30 35) (xy 5 35)))
    (filled_polygon (layer "F.Cu") (pts ${fill})))`
    const area = `
  (zone (net 0) (net_name "") (layer "F.Cu") (uuid "x") (name "X") (hatch edge 0.5) (connect_pads (clearance 0))
    (min_thickness 0.25) (keepout (tracks allowed) (vias allowed) (pads allowed) (copperpour not_allowed) (footprints allowed))
    (fill (thermal_gap 0.5) (thermal_bridge_width 0.5))
    (polygon (pts (xy 20 2) (xy 40 2) (xy 40 12) (xy 20 12))))`
    const rule = `(version 1)
(rule big (condition "A.intersectsArea('X')") (constraint clearance (min 5mm)))`
    const board = (fill: string): string[] =>
      keys(
        head(['GND', 'SIG']).replace('(end 40 30)', '(end 60 40)') +
          zone(fill) +
          area +
          track([33, 20], [50, 20], 0.25, 2, 't'),
        rule
      ).filter((key) => key === 'clearance')
    // Kept out of X: the fill runs along its edges, the outline across it.
    expect(board('(xy 5 5) (xy 20 5) (xy 20 12) (xy 30 12) (xy 30 35) (xy 5 35)')).toEqual([])
    // Poured through X.
    expect(board('(xy 5 5) (xy 30 5) (xy 30 35) (xy 5 35)')).toEqual(['clearance'])
  })

  test('a spoke routed by hand on another layer than the pour counts', () => {
    // One spoke from the pour reaches J1; J2 sits in the pour too, so the
    // island it is on joins more than J1.
    const pads = `(pad "1" thru_hole rect (at 0 0) (size 2 2) (drill 1) (layers "*.Cu") (net 1 "GND") (uuid "p"))`
    const other = `
  (footprint "L:F" (layer "F.Cu") (uuid "f2") (at 32 8)
    (property "Reference" "J2" (at 0 -3) (layer "F.SilkS") (hide yes) (uuid "r2") (effects (font (size 1 1) (thickness 0.15))))
    (pad "1" smd rect (at 0 0) (size 2 2) (layers "F.Cu") (net 1 "GND") (uuid "p2")))`
    const pour = `
  (zone (net 1) (net_name "GND") (layer "F.Cu") (uuid "z") (hatch edge 0.5)
    (connect_pads (clearance 0.5)) (min_thickness 0.25) (filled_areas_thickness no)
    (fill yes (thermal_gap 0.5) (thermal_bridge_width 0.5))
    (polygon (pts (xy 2 2) (xy 38 2) (xy 38 28) (xy 2 28)))
    (filled_polygon (layer "F.Cu") (pts (xy 20.9 14.75) (xy 21.5 14.75) (xy 21.5 2) (xy 38 2) (xy 38 28) (xy 21.5 28) (xy 21.5 15.25) (xy 20.9 15.25))))`
    const board = (extra: string): string[] =>
      keys(head(['GND']) + footprint([20, 15], pads) + other + pour + extra).filter(
        (key) => key === 'starved_thermal'
      )
    expect(board('')).toEqual(['starved_thermal'])
    const back = `(segment (start 20 15) (end 25 15) (width 0.3) (layer "B.Cu") (net 1) (uuid "t"))`
    expect(board(back)).toEqual([])
  })

  test("a footprint's copper zone is copper the checks measure", () => {
    const pad = `(pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 2 "SIG") (uuid "p"))
    (zone (net 2) (net_name "SIG") (layer "F.Cu") (uuid "fz") (hatch edge 0.5)
      (connect_pads yes (clearance 0.2)) (min_thickness 0.25) (filled_areas_thickness no)
      (fill yes (thermal_gap 0.5) (thermal_bridge_width 0.5))
      (polygon (pts (xy 8 8) (xy 12 8) (xy 12 12) (xy 8 12)))
      (filled_polygon (layer "F.Cu") (pts (xy 8 8) (xy 12 8) (xy 12 12) (xy 8 12))))`
    // A track of GND 0.1 mm below the zone's fill.
    expect(
      keys(
        head(['GND', 'SIG']) +
          footprint([10, 10], pad) +
          track([5, 12.2], [15, 12.2], 0.2, 1, 't') +
          track([5, 12.2], [5, 20], 0.2, 1, 't2')
      )
    ).toEqual(['clearance', 'track_dangling', 'track_dangling'])
  })

  test("two of a footprint's zones of one net and priority that overlap are reported", () => {
    const zone = (uuid: string, x: number): string => `
    (zone (net 2) (net_name "SIG") (layer "F.Cu") (uuid "${uuid}") (hatch edge 0.5)
      (connect_pads yes (clearance 0.2)) (min_thickness 0.25) (filled_areas_thickness no)
      (fill yes (thermal_gap 0.5) (thermal_bridge_width 0.5))
      (polygon (pts (xy ${x} 8) (xy ${x + 4} 8) (xy ${x + 4} 12) (xy ${x} 12))))`
    const pad = `(pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 2 "SIG") (uuid "p"))`
    expect(
      keys(head(['GND', 'SIG']) + footprint([10, 10], pad + zone('a', 8) + zone('b', 10)))
    ).toEqual(['zones_intersect'])
  })
})
