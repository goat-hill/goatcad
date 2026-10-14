/**
 * The rules that read an item's own properties — its text, its pads, its
 * layer, its footprint's attributes — each against a fixture drawn from
 * first principles (KiCad's behavior is named in each rule's module).
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
import { boardTexts, shownText } from '../boardTexts'
import type { CheckResult } from '../../schematic/checks'

const HEAD = `(kicad_pcb (version 20241229) (generator "test")
  (general (thickness 1.6))
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (5 "F.SilkS" user "F.Silkscreen")
    (7 "B.SilkS" user "B.Silkscreen") (25 "Edge.Cuts" user))
  (setup (pad_to_mask_clearance 0))
  (title_block (title "Board") (comment 1 "\${SPEC}"))
  (net 0 "") (net 1 "A")`

const settings = (
  over: Partial<BoardDesignSettings> = {},
  rules: Partial<BoardDesignSettings['rules']> = {}
): BoardDesignSettings => ({
  rules: { ...DEFAULT_DESIGN_RULES, minTextHeight: 0.8, minTextThickness: 0.08, ...rules },
  classes: DEFAULT_NET_CLASSES.map((cls) => ({ ...cls })),
  patterns: [],
  assignments: [],
  textVariables: { SPEC: 'rev A' },
  ...over
})

const run = (
  body: string,
  over?: Partial<BoardDesignSettings>,
  customRules?: string
): CheckResult[] => {
  const board = parseKicadBoard(`${HEAD}${body}\n)`)
  const index = BoardSpatialIndex.build(board)
  return boardChecks({
    board,
    index,
    connectivity: computeConnectivity(board, index),
    settings: settings(over),
    customRules
  })
}

const found = (results: CheckResult[], code: string): string[][] =>
  results.filter((r) => r.code === code).map((r) => r.items)

const text = (uuid: string, body: string, layer = 'F.SilkS', extra = ''): string =>
  `(gr_text "${body}" (at 110 110) (layer "${layer}") (uuid "${uuid}")
    (effects (font (size 1 1)${extra})))`

describe('text size', () => {
  test('silkscreen text under the minimum height is flagged; copper text is not held to it', () => {
    const results = run(`
  ${text('small', 'A', 'F.SilkS').replace('(size 1 1)', '(size 0.6 0.6)')}
  ${text('copper', 'B', 'F.Cu').replace('(size 1 1)', '(size 0.6 0.6)')}`)
    expect(found(results, 'text-height')).toEqual([['small']])
  })

  test("the pen is the file's thickness, else width / 8 — not height / 8", () => {
    // 0.875 tall, 0.5 wide: an automatic pen of 0.0625, under the 0.08 minimum.
    const results = run(`
  ${text('auto', 'A').replace('(size 1 1)', '(size 0.875 0.5)')}
  ${text('set', 'B').replace('(size 1 1)', '(size 0.875 0.5) (thickness 0.1)')}`)
    expect(found(results, 'text-thickness')).toEqual([['auto']])
  })

  test('a hidden footprint field is not held to the size rules', () => {
    const results = run(`
  (footprint "T:P" (layer "F.Cu") (uuid "fp") (at 120 120)
    (property "Reference" "R1" (at 0 0) (layer "F.SilkS") (uuid "ref")
      (effects (font (size 0.5 0.5))))
    (property "Value" "10k" (at 0 1) (layer "F.SilkS") (hide yes) (uuid "val")
      (effects (font (size 0.5 0.5)))))`)
    expect(found(results, 'text-height')).toEqual([['R1#Reference']])
  })

  test("a field is named <reference>#<field>, an older file's reference text too, and a shared reference's by uuid", () => {
    const small = '(effects (font (size 0.5 0.5)))'
    const results = run(`
  (footprint "T:P" (layer "F.Cu") (uuid "fp1") (at 120 120)
    (fp_text reference "R1" (at 0 0) (layer "F.SilkS") ${small}))
  (footprint "T:P" (layer "F.Cu") (uuid "fp2") (at 130 120)
    (property "Reference" "R2" (at 0 0) (layer "F.SilkS") (uuid "r2a") ${small}))
  (footprint "T:P" (layer "F.Cu") (uuid "fp3") (at 140 120)
    (property "Reference" "R2" (at 0 0) (layer "F.SilkS") (uuid "r2b") ${small}))`)
    expect(found(results, 'text-height')).toEqual([['R1#Reference'], ['r2a'], ['r2b']])
  })
})

describe('text mirroring', () => {
  test('mirrored on the front and plain on the back both read backwards', () => {
    const results = run(`
  ${text('front', 'A', 'F.SilkS', ') (justify mirror')}
  ${text('back', 'B', 'B.SilkS')}
  ${text('fine', 'C', 'B.SilkS', ') (justify mirror')}`)
    expect(found(results, 'mirrored-text-on-front')).toEqual([['front']])
    expect(found(results, 'nonmirrored-text-on-back')).toEqual([['back']])
  })
})

describe('text on the board edge', () => {
  test('text on Edge.Cuts is flagged, a line there is outline', () => {
    const results = run(`
  ${text('edge', 'A', 'Edge.Cuts')}
  (gr_line (start 100 100) (end 140 100) (stroke (width 0.05)) (layer "Edge.Cuts") (uuid "line"))`)
    expect(found(results, 'text-on-edge-cuts')).toEqual([['edge']])
  })
})

describe('text variables', () => {
  test("a footprint's text resolves its own fields, the board's title block and the project's variables", () => {
    const board = parseKicadBoard(`${HEAD}
  (footprint "Lib:Part" (layer "F.Cu") (uuid "fp") (at 120 120)
    (property "Reference" "R1" (at 0 0) (layer "F.SilkS") (uuid "ref"))
    (property "MPN" "RC0603" (at 0 0) (layer "F.Fab") (hide yes) (uuid "mpn"))
    (fp_text user "\${REFERENCE} \${MPN} \${TITLE} \${SPEC} \${FOOTPRINT_NAME} \${LAYER}" (at 0 1)
      (layer "F.SilkS") (uuid "user")))
)`)
    const user = boardTexts(board).find((t) => t.uuid === 'user')!
    expect(shownText(board, user, { variables: { SPEC: 'rev A' } })).toBe(
      'R1 RC0603 Board rev A Part F.Silkscreen'
    )
  })

  test('a variable nothing defines is flagged; a marker raises its own finding instead', () => {
    const results = run(`
  ${text('missing', '${NOPE}')}
  ${text('known', '${SPEC}')}
  ${text('marker', 'x ${DRC_ERROR fix me}')}
  ${text('warn', '${DRC_WARNING check}')}`)
    expect(found(results, 'unresolved-variable')).toEqual([['missing']])
    expect(results.find((r) => r.code === 'drc-error')?.message).toBe('fix me')
    expect(found(results, 'drc-warning')).toEqual([['warn']])
  })

  test('a cross-reference resolves, and names an unknown reference in the text rather than leaving ${…}', () => {
    const results = run(`
  (footprint "Lib:Part" (layer "F.Cu") (uuid "fp") (at 120 120)
    (property "Reference" "R1" (at 0 0) (layer "F.SilkS") (uuid "ref")))
  ${text('xref', '${R1:VALUE} ${U9:VALUE}')}`)
    expect(found(results, 'unresolved-variable')).toEqual([])
  })

  test("the title block resolves from the project's variables, not the board's properties", () => {
    expect(found(run(''), 'unresolved-variable')).toEqual([])
    const withoutProject = run(`\n  (property "SPEC" "from the board")`, { textVariables: {} })
    expect(found(withoutProject, 'unresolved-variable')).toEqual([[]])
  })
})

describe('pads', () => {
  const footprint = (pad: string): string => `
  (footprint "T:P" (layer "F.Cu") (uuid "fp") (at 120 120)
    (property "Reference" "U1" (at 0 0) (layer "F.Fab") (uuid "ref"))
    ${pad})`

  test('a padstack layer of negative size is invalid and leaves no copper round its hole', () => {
    const results = run(
      footprint(`(pad "1" thru_hole rect (at 0 0) (size 1 1) (drill 0.5) (layers "*.Cu" "*.Mask") (uuid "p1")
      (padstack (mode custom)
        (layer "B.Cu" (shape rect) (size 1.27 -1.27))))`)
    )
    expect(found(results, 'padstack-invalid')).toEqual([['U1.1']])
    expect(results.find((r) => r.code === 'padstack')?.message).toContain('leaves no copper')
  })

  test('an SMD pad with copper on both sides is questionable', () => {
    const results = run(
      footprint(`(pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu" "B.Cu") (uuid "p1"))`)
    )
    expect(results.find((r) => r.code === 'padstack')?.message).toContain('both sides')
  })

  test('a net-tie group naming a pad the footprint lacks', () => {
    const results = run(`
  (footprint "T:Tie" (layer "F.Cu") (uuid "fp") (at 120 120)
    (property "Reference" "NT1" (at 0 0) (layer "F.Fab") (uuid "ref"))
    (net_tie_pad_groups "1, 3")
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (uuid "p1"))
    (pad "2" smd rect (at 2 0) (size 1 1) (layers "F.Cu") (uuid "p2")))`)
    expect(found(results, 'footprint')).toEqual([['NT1']])
  })

  test('a type the pads contradict, and no courtyard, are off until the project turns them on', () => {
    const body = `
  (footprint "T:P" (layer "F.Cu") (uuid "fp") (at 120 120)
    (property "Reference" "J1" (at 0 0) (layer "F.Fab") (uuid "ref"))
    (attr smd)
    (pad "1" thru_hole circle (at 0 0) (size 1.6 1.6) (drill 0.8) (layers "*.Cu") (uuid "p1")))`
    expect(found(run(body), 'part-type-mismatch')).toEqual([])
    const on = run(body, {
      severities: { footprint_type_mismatch: 'warning', missing_courtyard: 'warning' }
    })
    expect(found(on, 'part-type-mismatch')).toEqual([['J1']])
    expect(found(on, 'no-courtyard')).toEqual([['J1']])
  })
})

describe('layers and projects', () => {
  test('a track on a copper layer the board does not have', () => {
    const results = run(`
  (segment (start 110 110) (end 120 110) (width 0.25) (layer "In3.Cu") (net 1) (uuid "t1"))`)
    expect(found(results, 'item-on-disabled-layer')).toEqual([['t1']])
  })

  test('a net class naming a tuning profile the project lacks', () => {
    const results = run('', {
      tuning: { classProfiles: { Default: '', Fast: 'DDR' }, profiles: ['USB'] }
    })
    expect(results.find((r) => r.code === 'missing-tuning-profile')?.subject).toBe('Net class Fast')
  })
})

describe('custom rules', () => {
  test('an assertion fails on the items its condition picks', () => {
    const results = run(
      `
  (footprint "T:P" (layer "F.Cu") (uuid "fp1") (at 110 110 90)
    (property "Reference" "R1" (at 0 0) (layer "F.Fab") (uuid "r1")))
  (footprint "T:P" (layer "F.Cu") (uuid "fp2") (at 120 110)
    (property "Reference" "R2" (at 0 0) (layer "F.Fab") (uuid "r2")))`,
      undefined,
      `(version 1)
(rule "upright"
  (condition "A.Type == 'Footprint'")
  (constraint assertion "A.Orientation == 0 deg"))`
    )
    expect(found(results, 'assertion-failure')).toEqual([['R1']])
  })

  test('a segment shorter than the rule allows, and two joined at a forbidden angle', () => {
    const results = run(
      `
  (segment (start 110 110) (end 110.2 110) (width 0.25) (layer "F.Cu") (net 1) (uuid "short"))
  (segment (start 110.2 110) (end 115 110) (width 0.25) (layer "F.Cu") (net 1) (uuid "long"))
  (segment (start 115 110) (end 115 115) (width 0.25) (layer "F.Cu") (net 1) (uuid "turn"))`,
      undefined,
      `(version 1)
(rule "segments" (constraint track_segment_length (min 0.5mm)))
(rule "angles" (constraint track_angle (min 135deg)))`
    )
    expect(found(results, 'track-segment-length')).toEqual([['short']])
    expect(found(results, 'track-angle')).toEqual([['long', 'turn']])
  })
})
