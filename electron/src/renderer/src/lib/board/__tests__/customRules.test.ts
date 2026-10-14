/**
 * Custom rules (`.kicad_dru`) at KiCad's reading of them: the functions that
 * name a footprint's sheet, fields, group, classes and library, the path
 * between two pads, a rule's own severity, the project's text variables and
 * component class assignments. Each fixture's findings were held against
 * kicad-cli 10.0.4 where it reads the feature (kicad-parity.md).
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
import { boardRules } from '../rules/boardRules'

const settings = (over: Partial<BoardDesignSettings> = {}): BoardDesignSettings => ({
  rules: { ...DEFAULT_DESIGN_RULES },
  classes: DEFAULT_NET_CLASSES.map((cls) => ({ ...cls })),
  patterns: [],
  assignments: [],
  ...over
})

const HEAD = `(kicad_pcb (version 20250401) (generator "test")
  (general (thickness 1.6))
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (5 "F.SilkS" user "F.Silkscreen") (1 "F.Mask" user) (35 "F.Fab" user) (25 "Edge.Cuts" user))
  (net 0 "") (net 1 "A") (net 2 "B")
  (gr_rect (start 100 100) (end 200 140) (stroke (width 0.1)) (fill no) (layer "Edge.Cuts") (uuid "edge"))`

/** A one-pad footprint, `U<n>`, with what the test gives it. */
const fp = (n: number, x: number, libId: string, sheet: string, extra = '', net = ''): string => `
  (footprint "${libId}" (layer "F.Cu") (uuid "fp${n}") (at ${x} 120)
    (property "Reference" "U${n}" (at 0 -2) (layer "F.SilkS") (hide yes) (effects (font (size 1 1) (thickness 0.15))))
    (property "Value" "V" (at 0 2) (layer "F.Fab") (hide yes) (effects (font (size 1 1) (thickness 0.15))))
    ${extra}
    (sheetname "${sheet}") (sheetfile "x.kicad_sch")
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu" "F.Mask") ${net} (uuid "p${n}")))`

const disallowed = (
  body: string,
  rules: string,
  over: Partial<BoardDesignSettings> = {}
): Array<[string, string, boolean]> => {
  const board = parseKicadBoard(`${HEAD}${body}\n)`)
  const index = BoardSpatialIndex.build(board)
  return boardChecks({
    board,
    index,
    connectivity: computeConnectivity(board, index),
    settings: settings(over),
    customRules: `(version 1)\n${rules}`
  })
    .filter((r) => r.code === 'items-not-allowed')
    .map((r): [string, string, boolean] => [r.items[0], r.severity, !!r.excluded])
    .sort(([a], [b]) => (a < b ? -1 : 1))
}

describe('what a rule may ask of a footprint', () => {
  const footprints = [
    fp(1, 105, 'Lib:A', '/Power/'),
    fp(2, 115, 'Lib:A', '/Power/Sub/'),
    fp(3, 125, 'Lib:A', '/IO/', '(property "MPN" "ABC" (at 0 0) (layer "F.Fab") (hide yes))'),
    fp(4, 135, 'Lib:Special', '/IO/'),
    fp(5, 145, 'Lib:A', '/IO/', '(component_classes (class "ANALOG"))'),
    fp(6, 155, 'Lib:A', '/IO/', '(component_classes (class "DIGITAL") (class "POWER"))'),
    fp(7, 165, 'Lib:A', '/'),
    fp(8, 175, 'Lib:A', '/IO/')
  ].join('')

  test('its sheet, a field, its library, its classes, a text variable; a rule ranks its own', () => {
    const rules = `
(rule sliver (constraint solder_mask_sliver (min 0.1mm)))
(rule sheet (constraint disallow footprint) (condition "A.memberOfSheet('/Power')"))
(rule children (constraint disallow footprint) (condition "A.memberOfSheetOrChildren('/Power') && A.Reference == 'U2'"))
(rule field (severity warning) (constraint disallow footprint) (condition "A.getField('MPN') == 'abc'"))
(rule lib (severity exclusion) (constraint disallow pad) (condition "A.memberOfFootprint('Lib:Spe*')"))
(rule cls (constraint disallow footprint) (condition "A.hasComponentClass('ANALOG')"))
(rule clsp (constraint disallow pad) (condition "A.hasComponentClass('POWER')"))
(rule own (constraint disallow footprint) (condition "A.memberOfFootprint('U6')"))
(rule root (constraint disallow footprint) (condition "A.memberOfSheet('/')"))
(rule var (constraint disallow footprint) (condition "A.Reference == '\${MYREF}'"))`
    // A footprint belongs to no footprint of its own: `own` names nothing.
    expect(disallowed(footprints, rules, { textVariables: { MYREF: 'U8' } })).toEqual([
      ['U1', 'error', false],
      ['U2', 'error', false],
      ['U3', 'warning', false],
      ['U4.1', 'error', true],
      ['U5', 'error', false],
      ['U6.1', 'error', false],
      ['U7', 'error', false],
      ['U8', 'error', false]
    ])
  })

  test('a token KiCad reads and checks nothing by does not set the file aside', () => {
    const board = parseKicadBoard(`${HEAD}\n)`)
    const parsed = boardRules(
      board,
      settings(),
      '(version 1)\n(rule s (constraint solder_mask_sliver (min 0.1mm)))'
    ).customRules
    expect(parsed).toMatchObject({ errors: [], count: 1 })
  })

  test("the project's class assignments, and a class read whole or one at a time", () => {
    const classes: BoardDesignSettings['componentClasses'] = {
      assignments: [
        {
          className: 'Connector',
          all: false,
          conditions: [{ type: 'REFERENCE', primary: 'U1,U3', secondary: '' }]
        },
        {
          className: 'Special',
          all: true,
          conditions: [
            { type: 'FOOTPRINT', primary: 'Lib:Special', secondary: '' },
            { type: 'SIDE', primary: 'Front', secondary: '' }
          ]
        }
      ],
      sheetClasses: true
    }
    const rules = `
(rule whole (constraint disallow footprint) (condition "A.Component_Class == '/IO/,Connector'"))
(rule any (constraint disallow pad) (condition "A.ComponentClass == 'Special'"))
(rule sheet (constraint disallow pad) (condition "A.hasComponentClass('/Power/') && A.Reference == 'U1'"))`
    expect(disallowed(footprints, rules, { componentClasses: classes })).toEqual([
      ['U1.1', 'error', false],
      ['U3', 'error', false],
      ['U4.1', 'error', false]
    ])
  })

  test('a pad reads its footprint, a graphic its own shape', () => {
    const body = `${fp(1, 105, 'Lib:A', '/', '(attr smd dnp)')}${fp(2, 115, 'Lib:B', '/')}
  (gr_line (start 110 110) (end 120 110) (stroke (width 0.3)) (layer "F.SilkS") (uuid "wide"))
  (gr_line (start 110 112) (end 120 112) (stroke (width 0.1)) (layer "F.SilkS") (uuid "thin"))`
    const rules = `
(rule dnp (constraint disallow pad) (condition "A.Do_not_Populate"))
(rule lib (constraint disallow pad) (condition "A.Library_Link == 'Lib:B'"))
(rule wide (constraint disallow graphic) (condition "A.Line_Width > 0.2mm"))`
    expect(disallowed(body, rules).map(([item]) => item)).toEqual(['U1.1', 'U2.1', 'wide'])
  })
})

describe('groups', () => {
  test('a group holding the item, or one above it, or its footprint, names it', () => {
    const body = `${fp(1, 105, 'Lib:A', '/')}${fp(2, 115, 'Lib:A', '/')}
  (gr_line (start 110 110) (end 120 110) (stroke (width 0.1)) (layer "F.SilkS") (uuid "g1"))
  (gr_line (start 110 112) (end 120 112) (stroke (width 0.1)) (layer "F.SilkS") (uuid "g2"))
  (group "inner" (uuid "grp-inner") (members g1 fp1))
  (group "outer" (uuid "grp-outer") (members grp-inner))
  (group "other" (uuid "grp-other") (members g2))`
    const rules = `
(rule g (constraint disallow graphic) (condition "A.memberOfGroup('out*')"))
(rule p (constraint disallow pad) (condition "A.memberOf('inner')"))`
    expect(disallowed(body, rules).map(([item]) => item)).toEqual(['U1.1', 'g1'])
  })
})

describe('fromTo', () => {
  test('a length rule holds the copper on the one path between two pads', () => {
    // U1.1 → t1 → t2 → U2.1, with a branch t3 from their joint (and a via) to U3.1.
    const body = `${fp(1, 110, 'Lib:A', '/', '', '(net 1 "A")')}${fp(2, 130, 'Lib:A', '/', '', '(net 1 "A")')}${fp(3, 120, 'Lib:A', '/', '', '(net 1 "A")').replace('(at 120 120)', '(at 120 130)')}
  (segment (start 110 120) (end 120 120) (width 0.25) (layer "F.Cu") (net 1) (uuid "t1"))
  (via (at 120 120) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 1) (uuid "v1"))
  (segment (start 120 120) (end 130 120) (width 0.25) (layer "F.Cu") (net 1) (uuid "t2"))
  (segment (start 120 120) (end 120 130) (width 0.25) (layer "F.Cu") (net 1) (uuid "t3"))`
    const length = (from: string, to: string, constraint = 'length (max 1mm)'): string[] => {
      const board = parseKicadBoard(`${HEAD}${body}\n)`)
      const index = BoardSpatialIndex.build(board)
      return boardChecks({
        board,
        index,
        connectivity: computeConnectivity(board, index),
        settings: settings(),
        customRules: `(version 1)\n(rule path (constraint ${constraint}) (condition "A.fromTo('${from}', '${to}')"))`
      })
        .filter((r) => r.code === 'length-out-of-range' || r.code === 'items-not-allowed')
        .map((r) => r.message.replace(/^.* runs? /, ''))
    }
    // As kicad-cli 10.0.4 measures them: 20 mm each way.
    expect(length('U1-1', 'U2-1')).toEqual([expect.stringContaining('20.0000 mm')])
    expect(length('u1', 'U3')).toEqual([expect.stringContaining('20.0000 mm')])
    // A far end two pads answer to has no path (KiCad 10.0.6's FROM_TO_CACHE).
    expect(length('U1-1', 'U*')).toEqual([])
    // Any other check finds no path at all, as KiCad builds none for it.
    expect(length('U1-1', 'U2-1', 'disallow track')).toEqual([])
  })
})

describe("a rule's own severity", () => {
  test('outranks the project, but not a check the project turns off', () => {
    const body = `
  (segment (start 110 110) (end 120 110) (width 0.25) (layer "F.Cu") (net 1) (uuid "a"))
  (segment (start 110 110.3) (end 120 110.3) (width 0.25) (layer "F.Cu") (net 2) (uuid "b"))`
    const run = (severities: Record<string, 'error' | 'warning' | 'ignore'>): string[] => {
      const board = parseKicadBoard(`${HEAD}${body}\n)`)
      const index = BoardSpatialIndex.build(board)
      return boardChecks({
        board,
        index,
        connectivity: null,
        settings: settings({ severities }),
        customRules:
          '(version 1)\n(rule near (severity warning) (constraint clearance (min 0.5mm)))'
      })
        .filter((r) => r.code === 'copper-clearance')
        .map((r) => r.severity)
    }
    expect(run({})).toEqual(['warning'])
    expect(run({ clearance: 'error' })).toEqual(['warning'])
    expect(run({ clearance: 'ignore' })).toEqual([])
  })
})
