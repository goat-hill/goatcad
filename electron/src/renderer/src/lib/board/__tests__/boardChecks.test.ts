import { describe, expect, test } from 'vitest'
import { parseKicadBoard } from '../../kicad/board'
import { padOnLayer } from '../../kicad/footprint'
import {
  DEFAULT_DESIGN_RULES,
  DEFAULT_NET_CLASSES,
  type BoardDesignSettings
} from '../../kicad/project'
import { BoardSpatialIndex, shapeOn } from '../spatialIndex'
import { computeConnectivity } from '../boardConnectivity'
import { BOARD_CHECK_RULES, BOARD_KICAD_KEYS, boardChecks } from '../boardChecks'
import { locateBoardItems } from '../boardLocate'
import { boardItems, resolveItem } from '../boardItems'
import { boardField } from '../boardFields'
import { loadClipper } from '../../geometry/clip'
import { findingOf, type CheckResult } from '../../schematic/checks'

const HEAD = `(kicad_pcb (version 20241229) (generator "test")
  (general (thickness 1.6))
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user) (36 "F.CrtYd" user))
  (setup (pad_to_mask_clearance 0))
  (net 0 "") (net 1 "A") (net 2 "B") (net 3 "GND")`

/** A 40 × 40 mm outline from (100,100). */
const OUTLINE = `
  (gr_line (start 100 100) (end 140 100) (stroke (width 0.05)) (layer "Edge.Cuts") (uuid "edge-1"))
  (gr_line (start 140 100) (end 140 140) (stroke (width 0.05)) (layer "Edge.Cuts") (uuid "edge-2"))
  (gr_line (start 140 140) (end 100 140) (stroke (width 0.05)) (layer "Edge.Cuts") (uuid "edge-3"))
  (gr_line (start 100 140) (end 100 100) (stroke (width 0.05)) (layer "Edge.Cuts") (uuid "edge-4"))`

const settings = (over: Partial<BoardDesignSettings['rules']> = {}): BoardDesignSettings => ({
  rules: { ...DEFAULT_DESIGN_RULES, ...over },
  classes: DEFAULT_NET_CLASSES.map((cls) => ({ ...cls })),
  patterns: [],
  assignments: []
})

const DANGLING = new Set(['track-dangling', 'via-dangling'])
/**
 * The text and silkscreen rules: the fixtures' fields are drawn thinner than
 * the default rules ask, and their footprints' silk sits where it lands.
 */
const TEXT = new Set([
  'text-height',
  'text-thickness',
  'mirrored-text-on-front',
  'nonmirrored-text-on-back',
  'silk-overlap',
  'silk-over-copper',
  'silk-edge-clearance'
])

/**
 * The board's findings; dangling copper and text size only when asked, since
 * most fixtures are lone tracks and footprints with library text.
 */
const run = (
  body: string,
  over?: Partial<BoardDesignSettings['rules']>,
  options: { connectivity?: boolean; dangling?: boolean; text?: boolean } = {}
): CheckResult[] => {
  const board = parseKicadBoard(`${HEAD}${OUTLINE}${body}\n)`)
  const index = BoardSpatialIndex.build(board)
  return boardChecks({
    board,
    index,
    connectivity: options.connectivity === false ? null : computeConnectivity(board, index),
    settings: settings(over)
  })
    .filter((r) => options.dangling || !DANGLING.has(r.code))
    .filter((r) => options.text || !TEXT.has(r.code))
}

const codes = (results: CheckResult[]): string[] => [...new Set(results.map((r) => r.code))]

describe('the rule table', () => {
  test('every rule has a KiCad key and a sentence for an agent', () => {
    // A rule file set aside is GoatCAD's to say; KiCad says it in a dialog, not a violation.
    const ours = Object.keys(BOARD_CHECK_RULES).filter((code) => code !== 'custom-rules')
    expect(Object.keys(BOARD_KICAD_KEYS).sort()).toEqual(ours.sort())
  })
})

describe('copper', () => {
  test('a clean board has no findings', () => {
    expect(
      run(`
  (segment (start 110 110) (end 120 110) (width 0.25) (layer "F.Cu") (net 1) (uuid "t1"))
  (segment (start 110 112) (end 120 112) (width 0.25) (layer "F.Cu") (net 2) (uuid "t2"))`)
    ).toEqual([])
  })

  test('two nets closer than the class clearance, with the gap and the rule', () => {
    const results = run(`
  (segment (start 110 110) (end 120 110) (width 0.2) (layer "F.Cu") (net 1) (uuid "t1"))
  (segment (start 110 110.35) (end 120 110.35) (width 0.2) (layer "F.Cu") (net 2) (uuid "t2"))`)
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({
      code: 'copper-clearance',
      severity: 'error',
      items: ['t1', 't2'],
      targets: ['t1', 't2'],
      subject: 'track A · track B',
      position: { x: 115, y: 110.175 }
    })
    expect(results[0].message).toContain(
      "0.1500 mm apart on F.Cu; netclass 'Default' needs 0.2000 mm"
    )
    expect(results[0].measure).toEqual({
      actual: expect.closeTo(0.15, 9),
      limit: 0.2,
      bound: 'min',
      unit: 'mm',
      rule: "netclass 'Default'"
    })
  })

  test('a gap at the clearance passes, and one on another layer is never measured', () => {
    expect(
      run(`
  (segment (start 110 110) (end 120 110) (width 0.2) (layer "F.Cu") (net 1) (uuid "t1"))
  (segment (start 110 110.4) (end 120 110.4) (width 0.2) (layer "F.Cu") (net 2) (uuid "t2"))
  (segment (start 110 110.1) (end 120 110.1) (width 0.2) (layer "B.Cu") (net 3) (uuid "t3"))`)
    ).toEqual([])
  })

  test('touching copper of two nets is a short; tracks whose centerlines meet cross', () => {
    const short = run(`
  (footprint "T:P" (layer "F.Cu") (uuid "fp-1") (at 120 110)
    (property "Reference" "R1" (at 0 0) (layer "F.SilkS"))
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 2 "B") (uuid "p1")))
  (segment (start 110 110) (end 119.6 110) (width 0.2) (layer "F.Cu") (net 1) (uuid "t1"))`)
    expect(codes(short)).toEqual(['copper-short'])
    const crossing = run(`
  (segment (start 110 110) (end 120 110) (width 0.2) (layer "F.Cu") (net 1) (uuid "t1"))
  (segment (start 115 105) (end 115 115) (width 0.2) (layer "F.Cu") (net 2) (uuid "t2"))`)
    expect(crossing).toHaveLength(1)
    expect(crossing[0]).toMatchObject({ code: 'tracks-crossing', position: { x: 115, y: 110 } })
    // End to end, an end on the other's middle, and one line overlapping.
    for (const [second, position] of [
      ['(start 120 110) (end 130 110)', { x: 120, y: 110 }],
      ['(start 115 110) (end 115 120)', { x: 115, y: 110 }],
      ['(start 116 110) (end 126 110)', { x: 118, y: 110 }]
    ] as const) {
      const meeting = run(`
  (segment (start 110 110) (end 120 110) (width 0.2) (layer "F.Cu") (net 1) (uuid "t1"))
  (segment ${second} (width 0.2) (layer "F.Cu") (net 2) (uuid "t2"))`)
      expect(meeting.map((r) => [r.code, r.position])).toEqual([['tracks-crossing', position]])
    }
  })

  test('one pad number on two nets is a short within reach, but not two unconnected pins', () => {
    const twin = (gap: number, nets: [string, string]): string => `
  (footprint "T:P" (layer "F.Cu") (uuid "fp-1") (at 110 120)
    (property "Reference" "J1" (at 0 0) (layer "F.SilkS"))
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") ${nets[0]} (uuid "p1"))
    (pad "1" smd rect (at ${1 + gap} 0) (size 1 1) (layers "F.Cu") ${nets[1]} (uuid "p2")))`
    const near = run(twin(0.1, ['(net 1 "A")', '(net 2 "B")']), {}, { connectivity: false })
    expect(near.map((r) => [r.code, r.position])).toEqual([['copper-short', { x: 111.1, y: 120 }]])
    expect(near[0].message).toContain('one pad on two nets (A and B)')
    expect(run(twin(2, ['(net 1 "A")', '(net 2 "B")']), {}, { connectivity: false })).toEqual([])
    expect(run(twin(0.1, ['(net 1 "A")', '(net 1 "A")']), {}, { connectivity: false })).toEqual([])
    const free = `
  (net 4 "unconnected-(J1-Pad1)") (net 5 "unconnected-(J1-Pad1)_1")${twin(0.1, ['(net 4 "unconnected-(J1-Pad1)")', '(net 5 "unconnected-(J1-Pad1)_1")'])}`
    expect(run(free, {}, { connectivity: false })).toEqual([])
  })

  test("the same net never violates itself, and a pad's own clearance overrides the class", () => {
    const same = run(
      `
  (segment (start 110 110) (end 120 110) (width 0.2) (layer "F.Cu") (net 1) (uuid "t1"))
  (segment (start 110 110.3) (end 120 110.3) (width 0.2) (layer "F.Cu") (net 1) (uuid "t2"))`,
      {},
      { connectivity: false }
    )
    expect(same).toEqual([])
    const local = run(`
  (footprint "T:P" (layer "F.Cu") (uuid "fp-1") (at 110 120)
    (property "Reference" "R1" (at 0 0) (layer "F.SilkS"))
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 1 "A") (clearance 0.5) (uuid "p1")))
  (segment (start 110 121) (end 120 121) (width 0.2) (layer "F.Cu") (net 2) (uuid "t1"))`)
    expect(local).toHaveLength(1)
    expect(local[0]).toMatchObject({
      code: 'copper-clearance',
      items: ['R1.1', 't1'],
      targets: ['fp-1', 't1']
    })
    expect(local[0].message).toContain('R1.1 clearance needs 0.5000 mm')
  })

  test('the halves of a differential pair may sit at their class gap', () => {
    const board = parseKicadBoard(`${HEAD}${OUTLINE}
  (net 4 "/USB_P") (net 5 "/USB_N")
  (segment (start 110 110) (end 120 110) (width 0.2) (layer "F.Cu") (net 4) (uuid "p"))
  (segment (start 110 110.35) (end 120 110.35) (width 0.2) (layer "F.Cu") (net 5) (uuid "n"))
)`)
    const index = BoardSpatialIndex.build(board)
    const usb = { ...DEFAULT_NET_CLASSES[0], name: 'USB', clearance: 0.2, diffPairGap: 0.15 }
    const results = boardChecks({
      board,
      index,
      connectivity: null,
      settings: {
        ...settings({ minClearance: 0.1 }),
        classes: [...DEFAULT_NET_CLASSES, usb],
        patterns: [{ pattern: '/USB_*', netClass: 'USB' }]
      }
    })
    expect(results.filter((r) => !DANGLING.has(r.code))).toEqual([])
  })
})

describe('copper drawings', () => {
  const pads = `
  (footprint "T:P" (layer "F.Cu") (uuid "fp-1") (at 110 120)
    (property "Reference" "R1" (at 0 0) (layer "F.SilkS"))
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 1 "A") (uuid "p1")))
  (footprint "T:P" (layer "F.Cu") (uuid "fp-2") (at 120 120)
    (property "Reference" "R2" (at 0 0) (layer "F.SilkS"))
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 1 "A") (uuid "p2")))`
  const bar = (net: string): string =>
    `(gr_rect (start 109.8 119.8) (end 120.2 120.2) (stroke (width 0.1) (type solid)) (fill yes) (layer "F.Cu")${net} (uuid "g1"))`

  test('a board graphic on copper joins the pads it covers, its net read or propagated', () => {
    expect(codes(run(pads))).toEqual(['unconnected-items'])
    expect(run(`${pads}\n  ${bar(' (net 1)')}`)).toEqual([])
    // With no net of its own it takes the net of the pads it joins, as KiCad propagates it.
    expect(run(`${pads}\n  ${bar('')}`)).toEqual([])
  })

  test('a board graphic keeps its clearance from other nets, and none from its own', () => {
    const near = run(`${pads}
  ${bar(' (net 1)')}
  (segment (start 111 120.4) (end 119 120.4) (width 0.2) (layer "F.Cu") (net 2) (uuid "t1"))`)
    expect(near.map((r) => [r.code, r.items])).toEqual([['copper-clearance', ['g1', 't1']]])
    const same = run(`${pads}
  ${bar(' (net 1)')}
  (segment (start 111 120.4) (end 119 120.4) (width 0.2) (layer "F.Cu") (net 1) (uuid "t1"))`)
    expect(same.filter((r) => r.code.startsWith('copper'))).toEqual([])
  })

  test('a track ending on a board graphic of its net is not dangling', () => {
    const ended = run(
      `${pads}
  ${bar(' (net 1)')}
  (segment (start 115 120) (end 115 125) (width 0.2) (layer "F.Cu") (net 1) (uuid "t1"))`,
      {},
      { dangling: true }
    )
    expect(ended.map((r) => [r.code, r.items])).toEqual([['track-dangling', ['t1']]])
    const joined = run(
      `${pads}
  ${bar(' (net 1)')}
  (segment (start 115 120) (end 120 120) (width 0.2) (layer "F.Cu") (net 1) (uuid "t1"))`,
      {},
      { dangling: true }
    )
    expect(joined).toEqual([])
  })

  test('text is measured by its glyphs, against tracks but never against text', () => {
    const text = (uuid: string, y: number): string =>
      `(gr_text "HI" (at 115 ${y}) (layer "F.Cu") (uuid "${uuid}") (effects (font (size 2 2) (thickness 0.15))))`
    // Ordered by uuid: a short when the later item, the track, has a net; else a clearance.
    const crossing = (uuid: string): string[] =>
      codes(
        run(`
  ${text(uuid, 110)}
  (segment (start 110 110) (end 120 110) (width 0.2) (layer "F.Cu") (net 1) (uuid "t1"))`)
      )
    expect(crossing('a1')).toEqual(['copper-short'])
    expect(crossing('x1')).toEqual(['copper-clearance'])
    // A track through the gap between the glyphs' strokes, inside the text's box, is clear.
    const between = run(
      `
  ${text('x1', 110)}
  (segment (start 115.572 105) (end 115.572 115) (width 0.1) (layer "F.Cu") (net 1) (uuid "t1"))`,
      { minTrackWidth: 0.1 }
    )
    expect(between).toEqual([])
    expect(run(`\n  ${text('x1', 110)}\n  ${text('x2', 110.5)}`)).toEqual([])
  })

  test('knockout text is copper round its glyphs: a track between them runs into it', async () => {
    await loadClipper()
    const knockout = `(gr_text "HI" (at 115 110) (layer "F.Cu" knockout) (uuid "x1") (effects (font (size 2 2) (thickness 0.15))))`
    const between = run(
      `
  ${knockout}
  (segment (start 115.572 105) (end 115.572 115) (width 0.1) (layer "F.Cu") (net 1) (uuid "t1"))`,
      { minTrackWidth: 0.1 }
    )
    expect(codes(between)).toEqual(['copper-clearance'])
  })

  describe('text boxes, tables, dimensions and fields', () => {
    const box = (uuid: string, stroke = '(stroke (width 0.1) (type solid))'): string =>
      `(gr_text_box "HI" (start 110 108) (end 120 112) (margins 0.5 0.5 0.5 0.5) (layer "F.Cu") (uuid "${uuid}")
    (effects (font (size 1 1) (thickness 0.15)) (justify left top)) (border yes) ${stroke})`
    const track = (y: number, net = 1): string =>
      `(segment (start 105 ${y}) (end 125 ${y}) (width 0.2) (layer "F.Cu") (net ${net}) (uuid "t1"))`

    test('a text box is its glyphs and its outline: a track across its outline, not its middle', () => {
      // A board text box has a net, if 0: touching copper is a short whichever side is later.
      expect(codes(run(`${box('a1')}\n  ${track(112)}`))).toEqual(['copper-short'])
      expect(codes(run(`${box('z1')}\n  ${track(112)}`))).toEqual(['copper-short'])
      // Inside the box below its one line of text, clear of glyphs and edges.
      expect(
        run(`${box('a1')}
  (segment (start 112 111) (end 118 111) (width 0.2) (layer "F.Cu") (net 1) (uuid "t1"))`)
      ).toEqual([])
      // With no stroke there is no outline to measure, border or not.
      expect(run(`${box('a1', '')}\n  ${track(112)}`)).toEqual([])
    })

    test('no pad is tested against a text box', () => {
      expect(
        run(`${box('a1')}
  (footprint "T:P" (layer "F.Cu") (uuid "fp-1") (at 115 112)
    (property "Reference" "R1" (at 0 0) (layer "F.SilkS"))
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 1 "A") (uuid "p1")))`)
      ).toEqual([])
    })

    test("a table is its whole area to DRC; a footprint's table meets no copper", () => {
      const table = (fp: boolean): string => {
        const body = `(table (column_count 1) (layer "F.Cu") (uuid "tb1")
      (border (external yes) (header yes) (stroke (width 0.1) (type solid)))
      (separators (rows yes) (cols yes) (stroke (width 0.1) (type solid)))
      (column_widths 10) (row_heights 4)
      (cells (table_cell "" (start ${fp ? '0 0' : '110 108'}) (end ${fp ? '10 4' : '120 112'}) (margins 0.5 0.5 0.5 0.5) (span 1 1) (layer "F.Cu") (uuid "c1")
        (effects (font (size 1 1) (thickness 0.15))))))`
        return fp
          ? `(footprint "T:T" (layer "F.Cu") (uuid "fp-1") (at 110 108)
    (property "Reference" "R1" (at 0 0) (layer "F.SilkS"))
    ${body})`
          : body
      }
      const findings = run(`${table(false)}\n  ${track(110)}`)
      expect(findings.map((r) => [r.code, r.items])).toEqual([['copper-clearance', ['t1', 'tb1']]])
      expect(run(`${table(true)}\n  ${track(110)}`)).toEqual([])
    })

    test("a dimension's lines are bare centerlines, and a pad meets its text", () => {
      const dim = `(dimension (type aligned) (layer "F.Cu") (uuid "d1")
    (pts (xy 110 115) (xy 130 115)) (height -5)
    (format (units 2) (units_format 1) (precision 2))
    (style (thickness 0.4) (arrow_length 1.27) (text_position_mode 0) (extension_height 0.58642) (extension_offset 0.5))
    (gr_text "20.00 mm" (at 120 108.4 0) (layer "F.Cu") (uuid "d1") (effects (font (size 1 1) (thickness 0.15)))))`
      // The crossbar runs at y 110: 0.25 mm from its centerline is clear of a 0.2 mm
      // track's edge by 0.15 mm, which would touch it at the line's 0.4 mm thickness.
      const beside = run(`${dim}
  (segment (start 112 110.25) (end 118 110.25) (width 0.2) (layer "F.Cu") (net 1) (uuid "t1"))`)
      expect(beside.map((r) => [r.code, r.items])).toEqual([['copper-clearance', ['d1', 't1']]])
      expect(beside[0].message).toContain('0.1500 mm apart')
      const pad = run(`${dim}
  (footprint "T:P" (layer "F.Cu") (uuid "fp-1") (at 120 107.6)
    (property "Reference" "R1" (at 0 0) (layer "F.SilkS"))
    (pad "1" smd rect (at 0 0) (size 0.4 0.4) (layers "F.Cu") (net 1 "A") (uuid "p1")))`)
      expect(pad.map((r) => [r.code, r.items])).toEqual([['copper-clearance', ['R1.1', 'd1']]])
    })

    test('every visible field of a footprint on copper is measured, not only its reference and value', () => {
      const part = (hide: string): string => `
  (footprint "T:P" (layer "F.Cu") (uuid "fp-1") (at 115 110)
    (property "Reference" "R1" (at 0 5) (layer "F.SilkS"))
    (property "MPN" "HI" (at 0 0) (layer "F.Cu")${hide} (uuid "z1") (effects (font (size 2 2) (thickness 0.15)))))`
      expect(codes(run(`${part('')}\n  ${track(110)}`))).toEqual(['copper-clearance'])
      expect(run(`${part(' (hide yes)')}\n  ${track(110)}`)).toEqual([])
    })
  })

  test("a footprint's graphic touching its own pad: a short or a clearance by uuid, none in a net tie", () => {
    const part = (graphic: string, tie = ''): string => `
  (footprint "T:P" (layer "F.Cu") (uuid "fp-1") (at 110 120)${tie}
    (property "Reference" "R1" (at 0 0) (layer "F.SilkS"))
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 1 "A") (uuid "p1"))
    (pad "2" smd rect (at 3 0) (size 1 1) (layers "F.Cu") (net 2 "B") (uuid "p2"))
    (fp_line (start 0 0) (end 3 0) (stroke (width 0.2) (type solid)) (layer "F.Cu") (uuid "${graphic}")))`
    // KiCad orders the pair by uuid; when the later one has a net, touching is a short.
    expect(codes(run(part('a1')))).toEqual(['copper-short'])
    expect(codes(run(part('z1')))).toEqual(['copper-clearance'])
    expect(run(part('a1', ' (net_tie_pad_groups "1,2")'))).toEqual([])
  })
})

describe('padstacks', () => {
  const FOUR = `(kicad_pcb (version 20241229) (generator "test")
  (general (thickness 1.6))
  (layers (0 "F.Cu" signal) (1 "In1.Cu" signal) (2 "In2.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))
  (setup (pad_to_mask_clearance 0))
  (net 0 "") (net 1 "A") (net 2 "B")`
  const board4 = (body: string): ReturnType<typeof parseKicadBoard> =>
    parseKicadBoard(`${FOUR}${OUTLINE}${body}\n)`)
  const run4 = (body: string): CheckResult[] => {
    const board = board4(body)
    const index = BoardSpatialIndex.build(board)
    return boardChecks({ board, index, connectivity: null, settings: settings() }).filter(
      (r) => !DANGLING.has(r.code) && !TEXT.has(r.code)
    )
  }
  // A 1 mm pad on the front, 2 mm on the inner layers, 1.5 mm on the back.
  const pad = (mode: string): string => `
  (footprint "T:P" (layer "F.Cu") (uuid "fp-1") (at 120 120)
    (property "Reference" "R1" (at 0 0) (layer "F.SilkS"))
    (pad "1" thru_hole circle (at 0 0) (size 1 1) (drill 0.5) (layers "*.Cu") (net 1 "A") (uuid "p1")
      (padstack (mode ${mode})
        (layer "${mode === 'custom' ? 'In1.Cu' : 'Inner'}" (shape circle) (size 2 2))
        (layer "B.Cu" (shape circle) (size 1.5 1.5)))))`
  const track = (layer: string): string =>
    `(segment (start 118 121.1) (end 122 121.1) (width 0.2) (layer "${layer}") (net 2) (uuid "t1"))`

  test("a pad's copper on each layer is its padstack's there", () => {
    for (const mode of ['front_inner_back', 'custom']) {
      const board = board4(pad(mode))
      const p = board.footprints[0].footprint.pads[0]
      expect(padOnLayer(p, 'F.Cu').size.w).toBe(1000000)
      expect(padOnLayer(p, 'In1.Cu').size.w).toBe(2000000)
      expect(padOnLayer(p, 'B.Cu').size.w).toBe(1500000)
      // front_inner_back gives every inner layer the Inner entry; custom only the layers it names.
      expect(padOnLayer(p, 'In2.Cu').size.w).toBe(mode === 'custom' ? 1000000 : 2000000)
      const item = BoardSpatialIndex.build(board).items.find((i) => i.ref.type === 'pad')!
      expect(shapeOn(item, 'In1.Cu')).toMatchObject({ kind: 'rrect', halfW: 1 })
      expect(shapeOn(item, 'F.Cu')).toBe(item.shape)
      expect(item.maxX - item.minX).toBeGreaterThanOrEqual(2)
    }
  })

  test('clearance is measured on the layer, where the padstack is larger or smaller', () => {
    // The track is 0.4 mm from the inner copper's edge, 0.9 mm from the front's.
    expect(codes(run4(`${pad('front_inner_back')}\n  ${track('F.Cu')}`))).toEqual([])
    expect(codes(run4(`${pad('front_inner_back')}\n  ${track('In1.Cu')}`))).toEqual([
      'copper-short'
    ])
    expect(codes(run4(`${pad('custom')}\n  ${track('In2.Cu')}`))).toEqual([])
  })

  test("a custom pad's primitives are each layer's own", () => {
    // The front is its bare anchor; the back reaches 1.5 mm right with a tab.
    const custom = `
  (footprint "T:P" (layer "F.Cu") (uuid "fp-1") (at 120 120)
    (property "Reference" "R1" (at 0 0) (layer "F.SilkS"))
    (pad "1" thru_hole custom (at 0 0) (size 1 1) (drill 0.5) (layers "*.Cu") (net 1 "A") (uuid "p1")
      (options (anchor circle))
      (padstack (mode custom)
        (layer "B.Cu" (shape custom) (size 1 1) (options (anchor rect))
          (primitives (gr_rect (start 0 -0.25) (end 1.5 0.25) (width 0) (fill yes)))))))`
    const near = (layer: string): string =>
      `(segment (start 121.6 118) (end 121.6 122) (width 0.2) (layer "${layer}") (net 2) (uuid "t1"))`
    expect(codes(run4(`${custom}\n  ${near('F.Cu')}`))).toEqual([])
    expect(codes(run4(`${custom}\n  ${near('B.Cu')}`))).toEqual(['copper-short'])
  })
})

describe('holes', () => {
  test('a hole near copper of another net, at the hole clearance', () => {
    const results = run(
      `
  (via (at 115 110) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") (net 1) (uuid "v1"))
  (segment (start 110 110.7) (end 120 110.7) (width 0.2) (layer "B.Cu") (net 2) (uuid "t1"))`,
      {
        minCopperHoleClearance: 0.5
      }
    )
    // Copper: 0.7 − 0.4 − 0.1 = 0.2 apart, at the class clearance; the hole is 0.4 away, under 0.5.
    expect(codes(results)).toEqual(['hole-clearance'])
    expect(results[0]).toMatchObject({ items: ['t1', 'v1'], targets: ['t1', 'v1'] })
  })

  test('holes too close, holes at one point, and a drill under the minimum', () => {
    const results = run(`
  (via (at 115 110) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") (net 1) (uuid "v1"))
  (via (at 115.6 110) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") (net 1) (uuid "v2"))
  (via (at 115.6 110) (size 0.8) (drill 0.2) (layers "F.Cu" "B.Cu") (net 1) (uuid "v3"))`)
    expect(codes(results).sort()).toEqual([
      'drill-out-of-range',
      'holes-co-located',
      'holes-too-close'
    ])
    const close = results.filter((r) => r.code === 'holes-too-close').map((r) => r.items)
    expect(close).toEqual([
      ['v1', 'v2'],
      ['v1', 'v3']
    ])
    expect(results.find((r) => r.code === 'holes-too-close')?.message).toContain('0.2000 mm apart')
    expect(results.find((r) => r.code === 'drill-out-of-range')?.items).toEqual(['v3'])
  })
})

describe('sizes', () => {
  test('track width, via diameter and annular width against the board minimums', () => {
    const results = run(
      `
  (segment (start 110 110) (end 120 110) (width 0.15) (layer "F.Cu") (net 1) (uuid "t1"))
  (via (at 115 120) (size 0.5) (drill 0.3) (layers "F.Cu" "B.Cu") (net 1) (uuid "v1"))`,
      {},
      { connectivity: false }
    )
    expect(results.map((r) => [r.code, r.items[0]])).toEqual([
      ['annular-width', 'v1'],
      ['track-width', 't1'],
      ['via-diameter', 'v1']
    ])
    expect(results.find((r) => r.code === 'track-width')?.position).toEqual({ x: 115, y: 110 })
  })

  test('a via exactly at the minimums passes', () => {
    expect(
      run(
        `
  (via (at 115 120) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 1) (uuid "v1"))`,
        {
          minViaAnnularWidth: 0.15
        }
      )
    ).toEqual([])
  })
})

describe('physical clearance', () => {
  // Held against kicad-cli 10.0.4 on this board: the same eleven pairs.
  test('every item against every other, nets and owners notwithstanding, holes and the edge piercing', async () => {
    await loadClipper()
    const board = parseKicadBoard(`(kicad_pcb (version 20250401) (generator "test")
  (general (thickness 1.6))
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (5 "F.SilkS" user "F.Silkscreen") (1 "F.Mask" user) (31 "F.CrtYd" user "F.Courtyard") (25 "Edge.Cuts" user))
  (net 0 "") (net 1 "A") (net 2 "B")
  (gr_rect (start 100 100) (end 150 140) (stroke (width 0.1)) (fill no) (layer "Edge.Cuts") (uuid "edge"))
  (segment (start 110 110) (end 115 110) (width 0.25) (layer "F.Cu") (net 1) (uuid "a1"))
  (segment (start 115 110) (end 120 110) (width 0.25) (layer "F.Cu") (net 1) (uuid "a2"))
  (segment (start 110 112) (end 120 112) (width 0.25) (layer "F.Cu") (net 1) (uuid "b1"))
  (segment (start 110 112.3) (end 120 112.3) (width 0.25) (layer "F.Cu") (net 2) (uuid "b2"))
  (segment (start 110 115) (end 120 115) (width 0.25) (layer "F.Cu") (net 0) (uuid "c1"))
  (segment (start 110 115.3) (end 120 115.3) (width 0.25) (layer "F.Cu") (net 0) (uuid "c2"))
  (segment (start 110 100.3) (end 120 100.3) (width 0.25) (layer "B.Cu") (net 1) (uuid "d1"))
  (gr_line (start 110 120) (end 120 120) (stroke (width 0.12)) (layer "F.SilkS") (uuid "s1"))
  (gr_line (start 110 120.2) (end 120 120.2) (stroke (width 0.12)) (layer "F.SilkS") (uuid "s2"))
  (via (at 135 110) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 1) (uuid "v1"))
  (zone (net 1) (net_name "A") (layer "F.Cu") (uuid "z1") (hatch edge 0.5)
    (connect_pads yes (clearance 0.2)) (min_thickness 0.2) (filled_areas_thickness no)
    (fill yes (thermal_gap 0.5) (thermal_bridge_width 0.5))
    (polygon (pts (xy 130 105) (xy 140 105) (xy 140 115) (xy 130 115)))
    (filled_polygon (layer "F.Cu") (pts (xy 130 105) (xy 140 105) (xy 140 115) (xy 130 115))))
  (footprint "T:R" (layer "F.Cu") (uuid "fp") (at 125 130)
    (property "Reference" "R1" (at 0 -3) (layer "F.SilkS") (hide yes) (effects (font (size 1 1) (thickness 0.15))))
    (fp_line (start -2 -1) (end 2 -1) (stroke (width 0.12)) (layer "F.SilkS") (uuid "fs"))
    (fp_rect (start -3 -2) (end 3 2) (stroke (width 0.05)) (fill no) (layer "F.CrtYd") (uuid "cy"))
    (pad "1" smd rect (at -1 -0.7) (size 1 1) (layers "F.Cu" "F.Mask") (net 1 "A") (uuid "p1"))
    (pad "2" thru_hole circle (at 1.5 0) (size 1.2 1.2) (drill 0.6) (layers "*.Cu" "*.Mask") (net 2 "B") (uuid "p2")))
)`)
    const index = BoardSpatialIndex.build(board)
    const results = boardChecks({
      board,
      index,
      connectivity: computeConnectivity(board, index),
      settings: settings(),
      customRules: `(version 1)
(rule mech (constraint physical_clearance (min 0.5mm)))
(rule mechhole (constraint physical_hole_clearance (min 0.5mm)))`
    })
    const physical = results
      .filter((r) => r.message.includes('physical clearance'))
      .map((r) => `${r.code} ${r.items.join(' ')}`)
      .sort()
    expect(physical).toEqual([
      'copper-clearance R1 R1.2',
      'copper-clearance R1 cy',
      'copper-clearance a1 a2',
      'copper-clearance b1 b2',
      'copper-clearance c1 c2',
      'copper-clearance d1 edge',
      'copper-clearance s1 s2',
      'copper-clearance v1 z1',
      'hole-clearance R1 R1.2',
      'hole-clearance v1 z1'
    ])
  })

  test('a polygon is held to the clearance within itself where it folds back, not along its curve', async () => {
    const fold = (points: string): CheckResult[] => {
      const board = parseKicadBoard(`${HEAD}${OUTLINE}
  (gr_poly (pts ${points}) (stroke (width 0.1)) (fill no) (layer "F.Cu") (uuid "poly"))
)`)
      const index = BoardSpatialIndex.build(board)
      return boardChecks({
        board,
        index,
        connectivity: null,
        settings: settings(),
        customRules: '(version 1)\n(rule mech (constraint physical_clearance (min 0.5mm)))'
      }).filter((r) => r.message.includes('of itself'))
    }
    // A U whose arms run 0.3 apart folds back within the clearance; a wide square does not.
    expect(
      fold('(xy 110 110) (xy 120 110) (xy 120 110.3) (xy 110 110.3)').map((r) => r.items)
    ).toEqual([['poly']])
    expect(fold('(xy 110 110) (xy 120 110) (xy 120 120) (xy 110 120)')).toEqual([])
  })
})

describe('tuning profiles', () => {
  // Default names profile P, which gives F.Cu a 0.3 mm track (and a pair a 0.15 mm gap) and B.Cu nothing.
  const tuned = (differential: boolean, severity?: 'error'): Array<[string, string, string]> => {
    const base = settings()
    const board = parseKicadBoard(`${HEAD}${OUTLINE}
  (net 4 "D_P") (net 5 "D_N")
  (segment (start 105 110) (end 120 110) (width 0.1) (layer "F.Cu") (net 1) (uuid "f10"))
  (segment (start 105 112) (end 120 112) (width 0.25) (layer "F.Cu") (net 1) (uuid "f25"))
  (segment (start 105 114) (end 120 114) (width 0.3) (layer "F.Cu") (net 1) (uuid "f30"))
  (segment (start 105 116) (end 120 116) (width 0.35) (layer "F.Cu") (net 1) (uuid "f35"))
  (segment (start 105 110) (end 120 110) (width 0.1) (layer "B.Cu") (net 1) (uuid "b10"))
  (segment (start 105 125) (end 125 125) (width 0.25) (layer "F.Cu") (net 4) (uuid "dp"))
  (segment (start 105 126) (end 125 126) (width 0.25) (layer "F.Cu") (net 5) (uuid "dn"))
)`)
    const index = BoardSpatialIndex.build(board)
    return boardChecks({
      board,
      index,
      connectivity: null,
      settings: {
        ...base,
        tuning: {
          classProfiles: { Default: 'P' },
          profiles: ['P'],
          geometries: {
            P: {
              differential,
              layers: [
                { layer: 'F.Cu', width: 0.3, gap: 0.15 },
                { layer: 'B.Cu', width: 0, gap: 0 }
              ]
            }
          }
        },
        ...(severity ? { severities: { tuning_profile_track_geometries: severity } } : {})
      }
    })
      .filter((r) => r.code === 'track-width')
      .map((r) => [r.items[0], r.severity, r.message.replace(/^.*; /, '')])
  }

  test('a profile holds its layers to exactly its width, at the severity the project gives it', () => {
    expect(tuned(false, 'error')).toEqual([
      ['b10', 'error', 'board setup constraints needs at least 0.2000 mm.'],
      ['dn', 'error', 'board setup constraints needs at least 0.3000 mm.'],
      ['dp', 'error', 'board setup constraints needs at least 0.3000 mm.'],
      ['f10', 'error', 'board setup constraints needs at least 0.3000 mm.'],
      ['f25', 'error', 'board setup constraints needs at least 0.3000 mm.'],
      ['f35', 'error', "tuning profile 'P' allows at most 0.3000 mm."]
    ])
  })

  test('at its default severity, ignore, a profile silences the width check where it applies', () => {
    expect(tuned(false)).toEqual([
      ['b10', 'error', 'board setup constraints needs at least 0.2000 mm.']
    ])
  })

  test("a differential profile holds only a pair's tracks", () => {
    expect(tuned(true, 'error').map(([item]) => item)).toEqual(['b10', 'dn', 'dp', 'f10'])
  })
})

describe('post-machining', () => {
  // Four copper layers, 35 µm each, over 0.2 / 1.0 / 0.2 mm dielectrics:
  // In1.Cu sits 0.2525 mm under the front face, In2.Cu 1.2875 mm.
  const STACKUP = `(setup (stackup
    (layer "F.Cu" (type "copper") (thickness 0.035)) (layer "dielectric 1" (type "prepreg") (thickness 0.2))
    (layer "In1.Cu" (type "copper") (thickness 0.035)) (layer "dielectric 2" (type "core") (thickness 1.0))
    (layer "In2.Cu" (type "copper") (thickness 0.035)) (layer "dielectric 3" (type "prepreg") (thickness 0.2))
    (layer "B.Cu" (type "copper") (thickness 0.035))))`
  const machined = (via: string, tracks: string, stackup = STACKUP): CheckResult[] => {
    const board = parseKicadBoard(`(kicad_pcb (version 20250401) (generator "test")
  (general (thickness 1.6))
  (layers (0 "F.Cu" signal) (4 "In1.Cu" signal) (6 "In2.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user))
  ${stackup}
  (net 0 "") (net 1 "A")${OUTLINE}
  (via (at 115 110) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") ${via} (net 1) (uuid "v1"))
${tracks}
)`)
    const index = BoardSpatialIndex.build(board)
    return boardChecks({
      board,
      index,
      connectivity: computeConnectivity(board, index),
      settings: settings()
    }).filter((r) => r.code === 'track-on-post-machined-layer')
  }
  const track = (layer: string, uuid: string): string =>
    `  (segment (start 110 110) (end 115 110) (width 0.25) (layer "${layer}") (net 1) (uuid "${uuid}"))`
  const all = ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'].map((l, i) => track(l, `t${i}`)).join('\n')

  test('a track on a layer a backdrill bores is flagged at the end it meets the via', () => {
    const results = machined('(backdrill (size 0.6) (layers "B.Cu" "In2.Cu"))', all)
    expect(results.map((r) => [r.items, r.position])).toEqual([
      [['t2', 'v1'], { x: 115, y: 110 }],
      [['t3', 'v1'], { x: 115, y: 110 }]
    ])
    expect(results[0].severity).toBe('error')
    expect(
      machined('(tertiary_drill (size 0.6) (layers "F.Cu" "In1.Cu"))', all).map((r) => r.items)
    ).toEqual([
      ['t0', 'v1'],
      ['t1', 'v1']
    ])
  })

  test('post-machining reaches the layers within its depth of its face', () => {
    // A counterbore 0.6 deep reaches In1.Cu, not In2.Cu.
    const bore = machined('(front_post_machining counterbore (size 1) (depth 0.6))', all)
    expect(bore.map((r) => r.items[0])).toEqual(['t0', 't1'])
    // A countersink with no depth goes as deep as its cone: 1 mm at 90° is 0.5 deep.
    const sink = machined('(back_post_machining countersink (size 1) (angle 90))', all)
    expect(sink.map((r) => r.items[0])).toEqual(['t2', 't3'])
    // With no stackup the board has no depth, as KiCad reads it: every layer is reached.
    const flat = machined('(front_post_machining counterbore (size 1) (depth 0.6))', all, '')
    expect(flat.map((r) => r.items[0])).toEqual(['t0', 't1', 't2', 't3'])
  })

  test('a hole machined nowhere, or a track that does not reach it, is not flagged', () => {
    expect(machined('', all)).toEqual([])
    const apart = `  (segment (start 110 112) (end 114 112) (width 0.25) (layer "B.Cu") (net 1) (uuid "t9"))`
    expect(machined('(backdrill (size 0.6) (layers "B.Cu" "In2.Cu"))', apart)).toEqual([])
  })
})

describe('the board edge', () => {
  test('copper within the edge clearance, once per item at its nearest approach', () => {
    const results = run(`
  (segment (start 100.2 110) (end 100.2 120) (width 0.2) (layer "F.Cu") (net 1) (uuid "t1"))`)
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({
      code: 'copper-edge-clearance',
      items: ['edge-4', 't1'],
      targets: ['t1']
    })
    expect(results[0].message).toContain('0.1000 mm from the board edge')
  })

  test('a board with no closed outline says so and skips the edge rule', () => {
    const board = parseKicadBoard(`${HEAD}
  (gr_line (start 100 100) (end 140 100) (stroke (width 0.05)) (layer "Edge.Cuts") (uuid "edge-1"))
  (segment (start 100.2 110) (end 100.2 120) (width 0.2) (layer "F.Cu") (net 1) (uuid "t1"))
)`)
    const index = BoardSpatialIndex.build(board)
    const results = boardChecks({ board, index, connectivity: null, settings: settings() })
    expect(codes(results.filter((r) => !DANGLING.has(r.code)))).toEqual(['invalid-outline'])
  })
})

describe('courtyards', () => {
  const part = (reference: string, x: number, courtyard: string, pads = ''): string => `
  (footprint "T:${reference}" (layer "F.Cu") (uuid "fp-${reference}") (at ${x} 120)
    (property "Reference" "${reference}" (at 0 0) (layer "F.SilkS"))
    ${courtyard}
    ${pads})`
  const box = (half: number): string =>
    `(fp_rect (start -${half} -${half}) (end ${half} ${half}) (stroke (width 0.05)) (layer "F.CrtYd") (uuid "cy-${half}"))`

  test('overlapping courtyards, and touching ones that do not', () => {
    const overlap = run(part('R1', 110, box(1)) + part('R2', 111.5, box(1)))
    expect(overlap).toHaveLength(1)
    expect(overlap[0]).toMatchObject({
      code: 'courtyards-overlap',
      items: ['R1', 'R2'],
      targets: ['fp-R1', 'fp-R2']
    })
    expect(run(part('R1', 110, box(1)) + part('R2', 112, box(1)))).toEqual([])
  })

  test("a plated hole inside another part's courtyard, but not inside its cutout", () => {
    const hole = `(pad "1" thru_hole circle (at 0 0) (size 1.2 1.2) (drill 0.6) (layers "*.Cu") (net 3 "GND") (uuid "p1"))`
    const inside = run(part('J1', 110, box(3)) + part('H1', 111, '', hole))
    expect(inside.map((r) => r.code)).toEqual(['pth-inside-courtyard'])
    expect(inside[0]).toMatchObject({ items: ['H1.1', 'J1'], position: { x: 111, y: 120 } })
    // The same hole inside a 1.5 mm cutout of J1's courtyard is clear of it.
    const cutout = `(fp_rect (start -0.5 -1.5) (end 2.5 1.5) (stroke (width 0.05)) (layer "F.CrtYd") (uuid "cy-hole"))`
    expect(run(part('J1', 110, box(3) + cutout) + part('H1', 111, '', hole))).toEqual([])
  })

  test('a courtyard that does not close is malformed', () => {
    const open = `(fp_line (start -1 -1) (end 1 -1) (stroke (width 0.05)) (layer "F.CrtYd") (uuid "cy-a"))
      (fp_line (start 1 -1) (end 1 1) (stroke (width 0.05)) (layer "F.CrtYd") (uuid "cy-b"))`
    expect(codes(run(part('R1', 110, open)))).toEqual(['malformed-courtyard'])
  })
})

describe('keepouts', () => {
  // U1 carries an antenna-style keepout above it, board-absolute as a board
  // file holds a footprint's zones: nothing but pads may enter.
  const module = `
  (footprint "T:MOD" (layer "F.Cu") (uuid "fp-U1") (at 120 125)
    (property "Reference" "U1" (at 0 0) (layer "F.SilkS"))
    (fp_rect (start -5 -9) (end 5 3) (stroke (width 0.05)) (layer "F.CrtYd") (uuid "cy-u1"))
    (zone (layers "F.Cu" "B.Cu") (uuid "ko-u1") (hatch full 0.5)
      (keepout (tracks not_allowed) (vias not_allowed) (pads allowed) (copperpour not_allowed) (footprints not_allowed))
      (polygon (pts (xy 115 116) (xy 125 116) (xy 125 110) (xy 115 110)))))`
  const part = (reference: string, x: number, y: number): string => `
  (footprint "T:R" (layer "F.Cu") (uuid "fp-${reference}") (at ${x} ${y})
    (property "Reference" "${reference}" (at 0 0) (layer "F.SilkS"))
    (fp_rect (start -1 -1) (end 1 1) (stroke (width 0.05)) (layer "F.CrtYd") (uuid "cy-${reference}"))
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 1 "A") (uuid "pad-${reference}")))`
  const notAllowed = (results: CheckResult[]): CheckResult[] =>
    results.filter((r) => r.code === 'items-not-allowed')

  test("a module's own keepout flags tracks, vias, footprints and pours in it", () => {
    const results = notAllowed(
      run(
        `${module}${part('R1', 120, 113)}
  (segment (start 110 113) (end 130 113) (width 0.25) (layer "F.Cu") (net 2) (uuid "t1"))
  (via (at 117 111) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 2) (uuid "v1"))
  (zone (net 3) (net_name "GND") (layer "B.Cu") (uuid "pour") (hatch edge 0.5)
    (polygon (pts (xy 101 101) (xy 139 101) (xy 139 139) (xy 101 139)))
    (filled_polygon (layer "B.Cu") (pts (xy 101 101) (xy 139 101) (xy 139 139) (xy 101 139))))`,
        undefined,
        { connectivity: false }
      )
    )
    expect(results.map((r) => r.items[0]).sort()).toEqual(['R1', 'pour', 't1', 'v1'])
    const track = results.find((r) => r.items[0] === 't1')!
    expect(track.message).toBe('track B is in the keepout area of U1, which allows no tracks.')
    expect(track.position?.y).toBe(113)
  })

  test('what the area allows, what stays outside it, and the module itself pass', () => {
    const results = notAllowed(
      run(
        `${module}
  (footprint "T:R" (layer "F.Cu") (uuid "fp-R2") (at 120 112)
    (property "Reference" "R2" (at 0 0) (layer "F.SilkS"))
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 1 "A") (uuid "pad-R2")))
  (segment (start 110 118) (end 130 118) (width 0.25) (layer "F.Cu") (net 2) (uuid "t1"))
  (segment (start 110 116.2) (end 130 116.2) (width 0.25) (layer "F.Cu") (net 2) (uuid "t2"))`,
        undefined,
        { connectivity: false }
      )
    )
    // R2 has no courtyard, and its pad is allowed; t2's edge only touches the area.
    expect(results).toEqual([])
  })

  test('a board-level area reaches only the layers it names', () => {
    const area = `
  (zone (layer "B.Cu") (uuid "ko-b") (hatch full 0.5)
    (keepout (tracks not_allowed) (vias allowed) (pads allowed) (copperpour allowed) (footprints allowed))
    (polygon (pts (xy 110 110) (xy 130 110) (xy 130 130) (xy 110 130))))`
    const front = `(segment (start 105 120) (end 135 120) (width 0.25) (layer "F.Cu") (net 2) (uuid "t1"))`
    const back = front.replace('F.Cu', 'B.Cu').replace('t1', 't2')
    const results = notAllowed(run(area + front + back, undefined, { connectivity: false }))
    expect(results.map((r) => r.items[0])).toEqual(['t2'])
    expect(results[0].message).toContain('is in a keepout area')
  })
})

describe('zone fills', () => {
  const rect = (x0: number, y0: number, x1: number, y1: number): string =>
    `(pts (xy ${x0} ${y0}) (xy ${x1} ${y0}) (xy ${x1} ${y1}) (xy ${x0} ${y1}))`
  /** A zone whose stored fill is `fills`, each a rectangle on the zone's layer. */
  const zone = (
    uuid: string,
    net: number,
    fills: Array<[number, number, number, number]>,
    extra = '',
    layer = 'F.Cu'
  ): string => `
  (zone (net ${net}) (net_name "${['', 'A', 'B', 'GND'][net]}") (layer "${layer}") (uuid "${uuid}") (hatch edge 0.5) ${extra}
    (polygon ${rect(101, 101, 139, 139)})
    ${fills.map((f) => `(filled_polygon (layer "${layer}") ${rect(...f)})`).join('\n    ')})`
  const only = (results: CheckResult[], code: string): CheckResult[] =>
    results.filter((r) => r.code === code)

  test('a stale fill over copper of another net is a clearance finding naming the zone', () => {
    const results = run(
      `${zone('gnd', 3, [[105, 105, 135, 135]])}
  (segment (start 110 120) (end 130 120) (width 0.25) (layer "F.Cu") (net 1) (uuid "t1"))
  (segment (start 110 125) (end 130 125) (width 0.25) (layer "F.Cu") (net 3) (uuid "t2"))`,
      undefined,
      { connectivity: false }
    )
    const clearance = only(results, 'copper-clearance')
    expect(clearance.map((r) => r.items)).toEqual([['gnd', 't1']])
    expect(clearance[0].message).toContain('runs into zone GND on F.Cu')
  })

  test("a zone's own clearance is maxed with the classes, but a pad's override beats both", () => {
    const wide = '(connect_pads (clearance 0.5))'
    const track = run(
      `${zone('gnd', 3, [[105, 105, 119.7, 135]], wide)}
  (segment (start 120 110) (end 120 130) (width 0.2) (layer "F.Cu") (net 1) (uuid "t1"))`,
      undefined,
      { connectivity: false }
    )
    expect(only(track, 'copper-clearance')).toMatchObject([
      {
        items: ['gnd', 't1'],
        message: expect.stringContaining('zone GND clearance needs 0.5000 mm')
      }
    ])
    const pad = run(
      `${zone('gnd', 3, [[105, 105, 119.2, 135]], wide)}
  (footprint "T:P" (layer "F.Cu") (uuid "fp-1") (at 120 120)
    (property "Reference" "R1" (at 0 0) (layer "F.SilkS"))
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 1 "A") (clearance 0.2) (uuid "p1")))`,
      undefined,
      { connectivity: false }
    )
    expect(only(pad, 'copper-clearance')).toEqual([])
  })

  test('fills of two nets closer than their clearance, and far enough apart', () => {
    const near = run(
      `${zone('a', 1, [[105, 105, 119.9, 135]])}${zone('b', 2, [[120, 105, 135, 135]])}`,
      undefined,
      { connectivity: false }
    )
    expect(only(near, 'copper-clearance').map((r) => r.items)).toEqual([['a', 'b']])
    const apart = run(
      `${zone('a', 1, [[105, 105, 119.5, 135]])}${zone('b', 2, [[120, 105, 135, 135]])}`,
      undefined,
      { connectivity: false }
    )
    expect(only(apart, 'copper-clearance')).toEqual([])
  })

  test('two zones of one net overlap only at distinct priorities', () => {
    const same = run(`${zone('z1', 3, [])}${zone('z2', 3, [])}`, undefined, { connectivity: false })
    expect(only(same, 'zones-intersect').map((r) => r.items)).toEqual([['z1', 'z2']])
    const ranked = run(`${zone('z1', 3, [])}${zone('z2', 3, [], '(priority 1)')}`, undefined, {
      connectivity: false
    })
    expect(only(ranked, 'zones-intersect')).toEqual([])
  })

  test('an island no copper of its net reaches is isolated; one a pad of its net sits on is not', () => {
    const pad = `
  (footprint "T:R" (layer "F.Cu") (uuid "fp-r") (at 110 110)
    (property "Reference" "R1" (at 0 0) (layer "F.SilkS"))
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 3 "GND") (uuid "p1")))`
    const results = run(
      `${pad}${zone('gnd', 3, [
        [105, 105, 115, 115],
        [125, 125, 135, 135]
      ])}`
    )
    const isolated = only(results, 'isolated-copper')
    expect(isolated).toHaveLength(1)
    expect(isolated[0]).toMatchObject({ severity: 'warning', items: ['gnd'], position: { x: 125 } })
  })

  test('a thermal pad reached by one spoke is starved; by two it is not', () => {
    // The pad sits in a gap carved in the fill; spokes are fill strips bridging it.
    const pad = `
  (footprint "T:R" (layer "F.Cu") (uuid "fp-r") (at 120 120)
    (property "Reference" "R1" (at 0 0) (layer "F.SilkS"))
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 3 "GND") (uuid "p1")))`
    const ring = (spokes: string): string => `
  (zone (net 3) (net_name "GND") (layer "F.Cu") (uuid "gnd") (hatch edge 0.5)
    (fill yes (thermal_gap 0.5) (thermal_bridge_width 0.3))
    (polygon ${rect(101, 101, 139, 139)})
    (filled_polygon (layer "F.Cu") ${rect(105, 105, 119, 135)})
    ${spokes})`
    const left = `(filled_polygon (layer "F.Cu") ${rect(118.9, 119.85, 119.6, 120.15)})`
    const right = `(filled_polygon (layer "F.Cu") ${rect(120.4, 119.85, 121.1, 120.15)})`
    expect(
      only(run(pad + ring(left), undefined, { connectivity: false }), 'starved-thermal')
    ).toMatchObject([
      { items: ['R1.1', 'gnd'], message: expect.stringContaining('by 1 thermal spoke;') }
    ])
    expect(
      only(run(pad + ring(left + right), undefined, { connectivity: false }), 'starved-thermal')
    ).toEqual([])
  })

  test('a fill reaching over the board edge, once per zone', () => {
    const results = run(zone('gnd', 3, [[99, 105, 135, 135]]), undefined, { connectivity: false })
    expect(only(results, 'copper-edge-clearance').map((r) => r.items)).toEqual([['edge-4', 'gnd']])
  })
})

describe('dangling copper', () => {
  const dangling = (body: string): CheckResult[] =>
    run(body, undefined, { connectivity: false, dangling: true }).filter((r) =>
      DANGLING.has(r.code)
    )
  const pad = (reference: string, x: number): string => `
  (footprint "T:R" (layer "F.Cu") (uuid "fp-${reference}") (at ${x} 120)
    (property "Reference" "${reference}" (at 0 0) (layer "F.SilkS"))
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 1 "A") (uuid "p-${reference}")))`

  test('a track from a pad to nowhere dangles at its open end; pad to pad does not', () => {
    const open = dangling(`${pad('R1', 110)}
  (segment (start 110 120) (end 115 120) (width 0.25) (layer "F.Cu") (net 1) (uuid "t1"))`)
    expect(open).toMatchObject([
      { code: 'track-dangling', severity: 'warning', items: ['t1'], position: { x: 115, y: 120 } }
    ])
    expect(
      dangling(`${pad('R1', 110)}${pad('R2', 115)}
  (segment (start 110 120) (end 115 120) (width 0.25) (layer "F.Cu") (net 1) (uuid "t1"))`)
    ).toEqual([])
  })

  test('a via joining one layer only dangles; one joining two does not', () => {
    const track = (layer: string, uuid: string): string =>
      `(segment (start 110 120) (end 115 120) (width 0.25) (layer "${layer}") (net 1) (uuid "${uuid}"))`
    const via = `(via (at 115 120) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 1) (uuid "v1"))`
    const one = dangling(pad('R1', 110) + track('F.Cu', 't1') + via)
    expect(one.map((r) => [r.code, r.items[0]])).toEqual([['via-dangling', 'v1']])
    const both = dangling(
      pad('R1', 110) +
        track('F.Cu', 't1') +
        via +
        `(segment (start 115 120) (end 125 120) (width 0.25) (layer "B.Cu") (net 1) (uuid "t2"))` +
        `(via (at 125 120) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 1) (uuid "v2"))` +
        pad('R2', 125)
    )
    expect(both.map((r) => r.items[0])).not.toContain('v1')
  })
})

describe('connectivity', () => {
  test('each missing connection is one finding naming the net', () => {
    const results = run(`
  (segment (start 110 110) (end 115 110) (width 0.25) (layer "F.Cu") (net 3) (uuid "t1"))
  (segment (start 120 110) (end 125 110) (width 0.25) (layer "F.Cu") (net 3) (uuid "t2"))`)
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({
      code: 'unconnected-items',
      items: ['t1', 't2'],
      subject: 'track GND · track GND',
      detail: 'GND'
    })
    expect(findingOf(results[0])).toMatchObject({ items: ['t1', 't2'], detail: 'GND' })
  })

  test("a footprint's jumpers join its pads, by group or by a shared number", () => {
    const jumper = (numbers: [string, string], jumpers: string): string => `
  (footprint "T:JP" (layer "F.Cu") (uuid "fp-1") (at 110 120)
    (property "Reference" "JP1" (at 0 0) (layer "F.SilkS"))
    ${jumpers}
    (pad "${numbers[0]}" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 3 "GND") (uuid "p1"))
    (pad "${numbers[1]}" smd rect (at 5 0) (size 1 1) (layers "F.Cu") (net 3 "GND") (uuid "p2")))`
    expect(codes(run(jumper(['1', '2'], '')))).toEqual(['unconnected-items'])
    expect(run(jumper(['1', '2'], '(jumper_pad_groups ("1" "2"))'))).toEqual([])
    expect(codes(run(jumper(['1', '1'], '')))).toEqual(['unconnected-items'])
    expect(run(jumper(['1', '1'], '(duplicate_pad_numbers_are_jumpers yes)'))).toEqual([])
  })
})

describe('locating', () => {
  test("every finding's targets select something on the board", () => {
    const source = `${HEAD}${OUTLINE}
  (footprint "T:R" (layer "F.Cu") (uuid "fp-1") (at 110 120)
    (property "Reference" "R1" (at 0 0) (layer "F.SilkS"))
    (fp_rect (start -1 -1) (end 1 1) (stroke (width 0.05)) (layer "F.CrtYd") (uuid "cy-1"))
    (pad "1" thru_hole circle (at 0 0) (size 1.2 1.2) (drill 0.2) (layers "*.Cu") (net 1 "A") (uuid "p1")))
  (footprint "T:R" (layer "F.Cu") (uuid "fp-2") (at 111 120)
    (property "Reference" "R2" (at 0 0) (layer "F.SilkS"))
    (fp_rect (start -1 -1) (end 1 1) (stroke (width 0.05)) (layer "F.CrtYd") (uuid "cy-2"))
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 2 "B") (uuid "p2")))
  (segment (start 100.2 110) (end 100.2 130) (width 0.1) (layer "F.Cu") (net 1) (uuid "t1"))
  (segment (start 110 130) (end 120 130) (width 0.2) (layer "F.Cu") (net 3) (uuid "t2"))
  (segment (start 125 130) (end 130 130) (width 0.2) (layer "F.Cu") (net 3) (uuid "t3"))
  (via (at 115 135) (size 0.5) (drill 0.3) (layers "F.Cu" "B.Cu") (net 3) (uuid "v1"))
  (via (at 115.5 135) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") (net 2) (uuid "v2"))
  (segment (start 110 130.3) (end 120 130.3) (width 0.2) (layer "F.Cu") (net 2) (uuid "t4"))
)`
    const board = parseKicadBoard(source)
    const index = BoardSpatialIndex.build(board)
    const results = boardChecks({
      board,
      index,
      connectivity: computeConnectivity(board, index),
      settings: settings()
    })
    const found = codes(results)
    expect(found).toEqual(
      expect.arrayContaining([
        'copper-clearance',
        'copper-short',
        'hole-clearance',
        'holes-too-close',
        'copper-edge-clearance',
        'track-width',
        'via-diameter',
        'annular-width',
        'drill-out-of-range',
        'courtyards-overlap',
        'pth-inside-courtyard',
        'unconnected-items'
      ])
    )
    for (const result of results) {
      expect(result.targets?.length, result.code).toBeGreaterThan(0)
      expect(locateBoardItems(board, result.targets!).length, result.code).toBe(
        result.targets!.length
      )
      expect(result.position, result.code).toBeDefined()
    }
  })

  test('a finding order is stable across runs', () => {
    const body = `
  (segment (start 110 110) (end 120 110) (width 0.2) (layer "F.Cu") (net 1) (uuid "t1"))
  (segment (start 110 110.3) (end 120 110.3) (width 0.2) (layer "F.Cu") (net 2) (uuid "t2"))
  (segment (start 110 110.6) (end 120 110.6) (width 0.2) (layer "F.Cu") (net 3) (uuid "t3"))`
    expect(run(body)).toEqual(run(body))
  })
})

describe('finding ids', () => {
  test('every id a finding names is one items_get resolves', async () => {
    await loadClipper()
    // A turned footprint with unnumbered holes and a repeated pad number, its
    // own silk with and without a uuid, and copper with no uuids at all.
    const body = `
  (footprint "J" (layer "F.Cu") (uuid "fp-j1") (at 120 120 90)
    (property "Reference" "J1" (at 0 -3 90) (layer "F.SilkS") (uuid "fp-j1-ref") (effects (font (size 0.5 0.5) (thickness 0.15))))
    (pad "" np_thru_hole circle (at 2 0) (size 1 1) (drill 1) (layers "*.Cu" "*.Mask"))
    (pad "" np_thru_hole circle (at -2 0) (size 1 1) (drill 1) (layers "*.Cu" "*.Mask"))
    (pad "1" smd rect (at 0 -0.6) (size 0.6 0.6) (layers "F.Cu" "F.Mask") (net 1 "A"))
    (pad "1" smd rect (at 0 0.6) (size 0.6 0.6) (layers "F.Cu" "F.Mask") (net 2 "B"))
    (fp_line (start -1 -1) (end 1 1) (stroke (width 0.12)) (layer "F.SilkS") (uuid "fp-j1-silk"))
    (fp_line (start -1 1) (end 1 -1) (stroke (width 0.12)) (layer "F.SilkS")))
  (segment (start 110 121.9) (end 130 121.9) (width 0.2) (layer "F.Cu") (net 1))
  (segment (start 110 118.1) (end 130 118.1) (width 0.2) (layer "F.Cu") (net 2))
  (via (at 120.6 125) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 2))
  (via (at 120.9 125) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 1))`
    const board = parseKicadBoard(`${HEAD}${OUTLINE}${body}\n)`)
    const index = BoardSpatialIndex.build(board)
    const results = boardChecks({
      board,
      index,
      connectivity: computeConnectivity(board, index),
      settings: settings()
    })
    const items = boardItems(board)
    const ids = [...new Set(results.flatMap((r) => r.items))]
    expect(ids.filter((id) => !boardField(board, id) && !resolveItem(items, id).ok)).toEqual([])
    // The forms that differed before: unnumbered pads on a turned footprint,
    // copper with no uuid, and a footprint's own silk; its field by <reference>#<field>.
    expect(ids.some((id) => id.startsWith('J1.pad@'))).toBe(true)
    expect(ids.some((id) => id.startsWith('track@'))).toBe(true)
    expect(ids.some((id) => id.startsWith('via@'))).toBe(true)
    expect(ids).toEqual(expect.arrayContaining(['J1', 'fp-j1-silk', 'J1#Reference']))
  })
})
