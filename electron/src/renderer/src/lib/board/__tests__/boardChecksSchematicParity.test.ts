/**
 * The board against its schematic (`drc/rules/schematicParity.ts`): each rule
 * against a netlist and a board drawn from first principles.
 */
import { describe, expect, test } from 'vitest'
import { parseKicadBoard } from '../../kicad/board'
import {
  DEFAULT_DESIGN_RULES,
  DEFAULT_NET_CLASSES,
  type BoardDesignSettings
} from '../../kicad/project'
import { BoardSpatialIndex } from '../spatialIndex'
import { boardChecks } from '../boardChecks'
import { filterMatches } from '../drc/rules/schematicParity'
import type { NetlistPart, SchematicNetlist } from '../schematicNetlist'
import type { CheckResult } from '../../schematic/checks'

const HEAD = `(kicad_pcb (version 20241229) (generator "test")
  (general (thickness 1.6))
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (37 "F.Fab" user))
  (setup (pad_to_mask_clearance 0))
  (net 0 "") (net 1 "/A") (net 2 "/B")`

const PARITY = new Set([
  'duplicate-footprints',
  'missing-footprint',
  'extra-footprint',
  'footprint-symbol-mismatch',
  'footprint-symbol-field-mismatch',
  'footprint-filters-mismatch',
  'net-conflict'
])

const settings = (severities: BoardDesignSettings['severities'] = {}): BoardDesignSettings => ({
  rules: { ...DEFAULT_DESIGN_RULES },
  classes: DEFAULT_NET_CLASSES.map((cls) => ({ ...cls })),
  patterns: [],
  assignments: [],
  severities
})

const run = (
  body: string,
  schematic: SchematicNetlist | null,
  severities?: BoardDesignSettings['severities']
): CheckResult[] => {
  const board = parseKicadBoard(`${HEAD}${body}\n)`)
  const index = BoardSpatialIndex.build(board)
  return boardChecks({
    board,
    index,
    connectivity: null,
    settings: settings(severities),
    schematic
  }).filter((r) => PARITY.has(r.code))
}

const part = (over: Partial<NetlistPart> & { reference: string }): NetlistPart => ({
  value: '10k',
  libId: 'R:R_0603',
  filters: [],
  fields: [
    ['Datasheet', ''],
    ['Description', '']
  ],
  dnp: false,
  excludeFromBom: false,
  pins: new Map([
    ['1', '/A'],
    ['2', '/B']
  ]),
  ...over
})

const footprint = (
  reference: string,
  uuid: string,
  extra = '',
  pads = `(pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 1 "/A") (uuid "${uuid}-1"))
    (pad "2" smd rect (at 2 0) (size 1 1) (layers "F.Cu") (net 2 "/B") (uuid "${uuid}-2"))`
): string => `
  (footprint "R:R_0603" (layer "F.Cu") (uuid "${uuid}") (at 110 110)
    (property "Reference" "${reference}" (at 0 0) (layer "F.Fab"))
    (property "Value" "10k" (at 0 1) (layer "F.Fab"))
    ${extra}
    ${pads})`

const found = (results: CheckResult[]): Array<[string, string[]]> =>
  results.map((r) => [r.code, r.items] as [string, string[]])

describe('schematic parity', () => {
  test('a board that matches its schematic has no findings, and none without one', () => {
    const board = footprint('R1', 'fp1')
    expect(run(board, { parts: [part({ reference: 'R1' })] })).toEqual([])
    expect(run(footprint('R9', 'fp1'), null)).toEqual([])
  })

  test('a part with no footprint, a footprint with no part, a board-only one needing none', () => {
    const results = run(
      `${footprint('R2', 'fp2')}${footprint('MH1', 'fp3', '(attr board_only)')}`,
      { parts: [part({ reference: 'R1' }), part({ reference: 'R2' })] }
    )
    expect(found(results)).toEqual([['missing-footprint', []]])
    const extra = run(footprint('R3', 'fp4'), { parts: [] })
    expect(found(extra)).toEqual([['extra-footprint', ['R3']]])
  })

  test('two footprints sharing a reference, case aside', () => {
    const results = run(`${footprint('R1', 'fp1')}${footprint('r1', 'fp2')}`, {
      parts: [part({ reference: 'R1' })]
    })
    expect(found(results).filter(([code]) => code === 'duplicate-footprints')).toEqual([
      ['duplicate-footprints', ['R1', 'r1']]
    ])
  })

  test('value, library footprint and attributes differ from the symbol', () => {
    const results = run(footprint('R1', 'fp1', '(attr smd dnp)'), {
      parts: [part({ reference: 'R1', value: '22k', libId: 'R:R_0805' })]
    })
    expect(results.filter((r) => r.code === 'footprint-symbol-mismatch')).toHaveLength(3)
  })

  test('a symbol field the footprint lacks or holds otherwise, the first one only', () => {
    const fields: Array<[string, string]> = [
      ['Datasheet', ''],
      ['Description', ''],
      ['MPN', 'RC0603'],
      ['Tol', '1%']
    ]
    const missing = run(footprint('R1', 'fp1'), { parts: [part({ reference: 'R1', fields })] })
    expect(found(missing)).toEqual([['footprint-symbol-field-mismatch', ['R1']]])
    expect(missing[0].message).toContain('MPN')
    const differs = run(
      footprint(
        'R1',
        'fp1',
        '(property "MPN" "RC0603" (at 0 0) (layer "F.Fab") (hide yes)) (property "Tol" "5%" (at 0 0) (layer "F.Fab") (hide yes))'
      ),
      { parts: [part({ reference: 'R1', fields })] }
    )
    expect(differs[0].message).toContain('Tol')
  })

  test('footprint filters are off until the project ranks them', () => {
    const schematic = { parts: [part({ reference: 'R1', filters: ['C_*'] })] }
    expect(run(footprint('R1', 'fp1'), schematic)).toEqual([])
    expect(
      found(run(footprint('R1', 'fp1'), schematic, { footprint_filters_mismatch: 'warning' }))
    ).toEqual([['footprint-filters-mismatch', ['R1']]])
  })

  test('a filter matches the name, or the whole id when it names a library, case aside', () => {
    expect(filterMatches('r_*', 'R:R_0603')).toBe(true)
    expect(filterMatches('R?0603', 'R:R_0603')).toBe(true)
    expect(filterMatches('R?0805', 'R:R_0603')).toBe(false)
    expect(filterMatches('R:*', 'R:R_0603')).toBe(true)
    expect(filterMatches('C:*', 'R:R_0603')).toBe(false)
  })

  test('pad nets against pin nets, and a pin with no pad', () => {
    const pins = new Map([
      ['1', '/B'],
      ['3', '/A']
    ])
    const results = run(footprint('R1', 'fp1'), { parts: [part({ reference: 'R1', pins })] })
    expect(found(results).sort()).toEqual([
      ['net-conflict', ['R1']],
      ['net-conflict', ['R1.1']],
      ['net-conflict', ['R1.2']]
    ])
  })

  test("a no-connect pad's net named for its pin is not a conflict", () => {
    const pads = `(pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 1 "/A") (uuid "p1"))
    (pad "2" smd rect (at 2 0) (size 1 1) (layers "F.Cu") (net 3 "/NC_1") (pintype "passive+no_connect") (uuid "p2"))`
    const netlist: SchematicNetlist = {
      parts: [
        part({
          reference: 'R1',
          pins: new Map([
            ['1', '/A'],
            ['2', '/NC']
          ])
        })
      ]
    }
    expect(run(footprint('R1', 'fp1', '', pads), netlist)).toEqual([])
    const plain = pads.replace(' (pintype "passive+no_connect")', '')
    expect(found(run(footprint('R1', 'fp1', '', plain), netlist))).toEqual([
      ['net-conflict', ['R1.2']]
    ])
  })
})
