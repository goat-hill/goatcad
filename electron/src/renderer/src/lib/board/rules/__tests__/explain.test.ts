import { describe, expect, test } from 'vitest'
import { parseKicadBoard } from '../../../kicad/board'
import { DEFAULT_DESIGN_RULES, DEFAULT_NET_CLASSES, makeNetClass } from '../../../kicad/project'
import { BoardSpatialIndex } from '../../spatialIndex'
import { boardItems, resolveItem } from '../../boardItems'
import { boardRules } from '../boardRules'
import { explainLimits, explainTarget } from '../explain'

const BOARD = `(kicad_pcb (version 20250401) (generator "test")
  (general (thickness 1.6))
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user))
  (net 0 "") (net 1 "GND") (net 2 "VCC")
  (footprint "Lib:Pin" (layer "F.Cu") (uuid "fp1") (at 10 10)
    (property "Reference" "J1" (at 0 -2) (layer "F.Cu") (hide yes) (effects (font (size 1 1) (thickness 0.15))))
    (pad "1" thru_hole circle (at 0 0) (size 1.7 1.7) (drill 1) (layers "*.Cu" "*.Mask") (net 1 "GND") (clearance 0.3) (uuid "p1")))
  (segment (start 0 5) (end 20 5) (width 0.25) (layer "F.Cu") (net 2) (uuid "t-vcc"))
  (segment (start 0 15) (end 20 15) (width 0.25) (layer "F.Cu") (net 1) (uuid "t-gnd"))
  (via (at 15 20) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 2) (uuid "v1"))
)`

const setup = (
  text = BOARD,
  custom?: string
): {
  explain: (a: string, b?: string) => ReturnType<typeof explainLimits>
} => {
  const board = parseKicadBoard(text)
  const index = BoardSpatialIndex.build(board)
  const rules = boardRules(
    board,
    {
      rules: { ...DEFAULT_DESIGN_RULES, minClearance: 0.1 },
      classes: [
        ...DEFAULT_NET_CLASSES.map((cls) => ({ ...cls, clearance: 0.2 })),
        { ...makeNetClass('Power'), clearance: 0.4, priority: 0 }
      ],
      patterns: [{ pattern: 'VCC', netClass: 'Power' }],
      assignments: []
    },
    custom
  )
  const items = boardItems(board)
  const target = (id: string): NonNullable<ReturnType<typeof explainTarget>> => {
    const found = resolveItem(items, id)
    if (!found.ok) throw new Error(id)
    return explainTarget(board, index, rules, found.item)!
  }
  return { explain: (a, b) => explainLimits(rules, target(a), b ? target(b) : null) }
}

describe('why this limit', () => {
  test('two tracks: the larger class clearance, named for its class, with the steps', () => {
    const [clearance] = setup().explain('t-vcc', 't-gnd')
    expect(clearance).toMatchObject({
      constraint: 'clearance',
      layer: 'F.Cu',
      min: 0.4,
      source: "netclass 'Power'"
    })
    expect(clearance.steps.length).toBeGreaterThan(0)
  })

  test("a pad's own clearance pre-empts the rules; its hole adds hole clearance", () => {
    const limits = setup().explain('J1.1', 't-vcc')
    expect(limits.find((l) => l.constraint === 'clearance')).toMatchObject({
      min: 0.3,
      source: 'J1.1 clearance'
    })
    expect(setup().explain('J1.1', 't-gnd')[0]).toMatchObject({ sameNet: true, min: 0 })
    expect(limits.some((l) => l.constraint === 'hole_clearance')).toBe(true)
  })

  test('one item: the sizes its kind is checked for', () => {
    const { explain } = setup()
    expect(explain('t-vcc').map((l) => l.constraint)).toEqual(['track_width'])
    expect(explain('v1').map((l) => l.constraint)).toEqual([
      'via_diameter',
      'annular_width',
      'hole_size'
    ])
  })

  test('a pad is read as DRC reads it, so an area rule that holds it to more is named', () => {
    const area = `
  (zone (net 0) (net_name "") (layer "F.Cu") (uuid "x") (name "X") (hatch edge 0.5) (connect_pads (clearance 0))
    (min_thickness 0.25) (keepout (tracks allowed) (vias allowed) (pads allowed) (copperpour not_allowed) (footprints allowed))
    (fill (thermal_gap 0.5) (thermal_bridge_width 0.5))
    (polygon (pts (xy 8 8) (xy 12 8) (xy 12 12) (xy 8 12))))`
    const custom = `(version 1)
(rule big (condition "A.intersectsArea('X')") (constraint clearance (min 5mm)))`
    const text = BOARD.replace(/\)$/, `${area}\n)`).replace('(clearance 0.3) ', '')
    const clearance = setup(text, custom)
      .explain('J1.1', 't-vcc')
      .find((l) => l.constraint === 'clearance')
    expect(clearance).toMatchObject({ min: 5, source: "rule 'big'" })
  })

  test('two pads a net tie joins are held to 0, named as the tie', () => {
    const tie = `
  (footprint "Lib:Tie" (layer "F.Cu") (uuid "fp2") (at 30 10)
    (property "Reference" "NT1" (at 0 -2) (layer "F.Cu") (hide yes) (effects (font (size 1 1) (thickness 0.15))))
    (net_tie_pad_groups "1,2")
    (pad "1" smd rect (at -0.5 0) (size 0.8 0.8) (layers "F.Cu") (net 1 "GND") (uuid "n1"))
    (pad "2" smd rect (at 0.5 0) (size 0.8 0.8) (layers "F.Cu") (net 2 "VCC") (uuid "n2")))`
    const text = BOARD.replace(/\)$/, `${tie}\n)`)
    expect(setup(text).explain('NT1.1', 'NT1.2')[0]).toMatchObject({
      constraint: 'clearance',
      min: 0,
      source: 'net tie'
    })
  })
})
