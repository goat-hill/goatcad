/**
 * The signal rules — a net's length and delay, skew between nets, via
 * counts, and a differential pair's gap and uncoupled length — each against
 * a fixture drawn from first principles (KiCad's behavior is named in each
 * rule's module and in `netLength.ts`).
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
import { lineLength, netLength, stackupHeights } from '../netLength'
import { padPolygon } from '../padPolygon'
import type { KicadPad } from '../../kicad/footprint'
import type { CheckResult } from '../../schematic/checks'

const HEAD = `(kicad_pcb (version 20241229) (generator "test")
  (general (thickness 1.6))
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (1 "F.Mask" user) (3 "B.Mask" user) (25 "Edge.Cuts" user))
  (setup (pad_to_mask_clearance 0))
  (net 0 "") (net 1 "SIG") (net 2 "OTHER") (net 3 "D_P") (net 4 "D_N") (net 5 "E")`

const settings = (over: Partial<BoardDesignSettings> = {}): BoardDesignSettings => ({
  rules: { ...DEFAULT_DESIGN_RULES, minClearance: 0 },
  classes: DEFAULT_NET_CLASSES.map((cls) => ({ ...cls })),
  patterns: [],
  assignments: [],
  ...over
})

/** The signal rules' findings alone: the fixtures are bare tracks, which the rest flag freely. */
const SIGNAL = new Set([
  'length-out-of-range',
  'skew-out-of-range',
  'too-many-vias',
  'diff-pair-gap',
  'diff-pair-uncoupled-length'
])

const run = (
  body: string,
  customRules: string,
  over?: Partial<BoardDesignSettings>
): CheckResult[] => {
  const board = parseKicadBoard(`${HEAD}${body}\n)`)
  const index = BoardSpatialIndex.build(board)
  return boardChecks({
    board,
    index,
    connectivity: computeConnectivity(board, index),
    settings: settings(over),
    customRules
  }).filter((r) => SIGNAL.has(r.code))
}

const messages = (results: CheckResult[], code: string): string[] =>
  results.filter((r) => r.code === code).map((r) => r.message)

const seg = (
  uuid: string,
  net: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  layer = 'F.Cu'
): string =>
  `(segment (start ${x0} ${y0}) (end ${x1} ${y1}) (width 0.2) (layer "${layer}") (net ${net}) (uuid "${uuid}"))`

/** SIG: 10 mm, then 5 mm, one run. */
const SIG = `
  ${seg('s1', 1, 100, 100, 110, 100)}
  ${seg('s2', 1, 110, 100, 110, 105)}`

const rule = (name: string, condition: string, constraint: string): string =>
  `(version 1)\n(rule ${name} (condition "${condition}") (constraint ${constraint}))`

describe('length', () => {
  test("a net's tracks add up; outside the rule's range is a finding", () => {
    const over = run(SIG, rule('len', "A.NetName == 'SIG'", 'length (max 14mm)'))
    expect(messages(over, 'length-out-of-range')).toEqual([
      "The net SIG is 15.0000 mm long; rule 'len' needs at most 14.0000 mm."
    ])
    expect(run(SIG, rule('len', "A.NetName == 'SIG'", 'length (min 14mm) (max 16mm)'))).toEqual([])
  })

  test("a via counts the board's height between the layers its tracks use, and is counted", () => {
    const body = `${SIG}
  (via (at 110 105) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 1) (uuid "v1"))
  ${seg('s3', 1, 110, 105, 115, 105, 'B.Cu')}`
    // Default stackup: 1.6 mm less two 10 µm masks, so 1.58 mm of copper and dielectric.
    const results = run(body, rule('len', "A.NetName == 'SIG'", 'length (max 21.5mm)'))
    expect(messages(results, 'length-out-of-range')[0]).toContain('21.5800 mm')
    const vias = run(body, rule('vias', "A.NetName == 'SIG'", 'via_count (max 0)'))
    expect(messages(vias, 'too-many-vias')).toEqual([
      "The net SIG has 1 via; rule 'vias' allows at most 0."
    ])
  })

  test("in picoseconds, the length is the net class's tuning profile's delay", () => {
    const tuning = {
      classProfiles: { Default: 'FAST' },
      profiles: ['FAST'],
      delays: { FAST: { timeDomain: true, layers: { 'F.Cu': 6_000_000 }, via: 0, overrides: [] } }
    }
    const results = run(SIG, rule('delay', "A.NetName == 'SIG'", 'length (max 80ps)'), { tuning })
    expect(messages(results, 'length-out-of-range')).toEqual([
      "The net SIG is 90.00 ps long; rule 'delay' needs at most 80.00 ps."
    ])
  })
})

describe('skew', () => {
  test('each net against the longest the rule matches', () => {
    const body = `${SIG}
  ${seg('o1', 2, 100, 110, 110, 110)}`
    const results = run(
      body,
      rule('skew', "A.NetName == 'SIG' || A.NetName == 'OTHER'", 'skew (max 1mm)')
    )
    expect(results.filter((r) => r.code === 'skew-out-of-range').map((r) => r.subject)).toEqual([
      'net OTHER'
    ])
  })

  test("within diff pairs, each half against its own pair's other half", () => {
    const body = `
  ${seg('p', 3, 100, 120, 110, 120)}
  ${seg('n', 4, 100, 121, 108, 121)}
  ${seg('e', 5, 100, 130, 130, 130)}`
    const results = run(
      body,
      '(version 1)\n(rule skew (constraint skew (max 1mm) (within_diff_pairs)))'
    )
    expect(results.filter((r) => r.code === 'skew-out-of-range').map((r) => r.subject)).toEqual([
      'net D_N'
    ])
  })
})

describe('differential pairs', () => {
  const pair = `
  ${seg('p1', 3, 100, 120, 110, 120)}
  ${seg('n1', 4, 100, 120.3, 110, 120.3)}`

  test('where the halves run side by side, the gap between their edges is held to the rule', () => {
    const results = run(pair, rule('dp', "A.inDiffPair('D')", 'diff_pair_gap (min 0.15mm)'))
    expect(results.filter((r) => r.code === 'diff-pair-gap').map((r) => r.items)).toEqual([
      ['p1', 'n1']
    ])
    expect(run(pair, rule('dp', "A.inDiffPair('D')", 'diff_pair_gap (min 0.05mm)'))).toEqual([])
  })

  test('the rest of the longer half is uncoupled', () => {
    const body = `${pair}
  ${seg('p2', 3, 110, 120, 110, 130)}`
    const results = run(body, rule('dp', "A.inDiffPair('D')", 'diff_pair_uncoupled (max 5mm)'))
    expect(messages(results, 'diff-pair-uncoupled-length')).toEqual([
      'The pair D_P / D_N runs 10.0000 mm uncoupled; dp allows at most 5.0000 mm.'
    ])
  })

  test('copper across the gap where the halves come nearest means they are not coupled', () => {
    const body = `${pair}
  ${seg('x', 5, 99, 120.15, 111, 120.15)}`
    const results = run(body, rule('dp', "A.inDiffPair('D')", 'diff_pair_uncoupled (max 5mm)'))
    expect(messages(results, 'diff-pair-uncoupled-length')).toHaveLength(1)
  })
})

describe('the length calculator', () => {
  test("KiCad's default stackup: 35 µm copper, 10 µm mask, the rest dielectric", () => {
    const board = parseKicadBoard(`${HEAD}\n)`)
    expect(stackupHeights(board)('F.Cu', 'B.Cu')).toBe(1_580_000)
  })

  test('a run starting inside a via is measured from its center', () => {
    const stats = netLength({
      lines: [
        {
          layer: 'F.Cu',
          pieces: [{ kind: 'seg', a: { x: 100_000, y: 0 }, b: { x: 1_000_000, y: 0 } }]
        }
      ],
      vias: [
        {
          position: { x: 0, y: 0 },
          top: 'F.Cu',
          bottom: 'F.Cu',
          radiusOn: () => 300_000,
          maxRadius: 300_000,
          padSide: null
        }
      ],
      pads: [],
      stackupHeight: () => 0,
      copperOrder: ['F.Cu', 'B.Cu'],
      useHeight: true,
      delays: null
    })
    expect(stats.total).toBe(1_000_000)
    expect(stats.viaCount).toBe(1)
  })

  test('an arc counts its length along the curve', () => {
    const quarter = lineLength([
      {
        kind: 'arc',
        a: { x: 1_000_000, y: 0 },
        m: { x: 707_107, y: 707_107 },
        b: { x: 0, y: 1_000_000 }
      }
    ])
    expect(quarter).toBeGreaterThan(1_570_790)
    expect(quarter).toBeLessThan(1_570_800)
  })

  test("a rounded pad's polygon has its vertices on the rounded corners, inside the shape", () => {
    const pad = {
      shape: 'roundrect',
      size: { w: 1_000_000, h: 1_000_000 },
      roundrectRatio: 0.25,
      position: { x: 0, y: 0, angle: 0 }
    } as unknown as KicadPad
    const ring = padPolygon(pad, { x: 0, y: 0 }, 5_000)!
    const r = 250_000
    for (const p of ring) {
      const cx = Math.sign(p.x) * 250_000
      const cy = Math.sign(p.y) * 250_000
      const onCorner = Math.abs(p.x) > 250_000 && Math.abs(p.y) > 250_000
      if (onCorner) expect(Math.abs(Math.hypot(p.x - cx, p.y - cy) - r)).toBeLessThanOrEqual(1)
      expect(Math.abs(p.x)).toBeLessThanOrEqual(500_000)
      expect(Math.abs(p.y)).toBeLessThanOrEqual(500_000)
    }
  })
})
