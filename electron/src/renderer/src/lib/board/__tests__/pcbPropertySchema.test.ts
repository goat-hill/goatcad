import { describe, expect, it } from 'vitest'
import { parseKicadBoard, serializeKicadBoard, updateBoardMetaInAST } from '../../kicad/board'
import {
  BOARD_ITEM_COLLECTIONS,
  boardCollection,
  buildBoardGroups,
  boardPatch,
  selectedPads,
  warningSourceOf,
  type BoardContext
} from '../pcbPropertySchema'
import { isMixed, type PropertyField } from '../../propertyTable'
import { boardGraphicPatch } from '../../footprint/footprintPropertySchema'
import { mmToNm as mm } from '../../kicad/coordinates'

const t = (key: string): string => key

const BOARD = `(kicad_pcb (version 20240108) (generator "pcbnew")
  (general (thickness 1.6))
  (paper "A4")
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal))
  (net 0 "") (net 1 "GND") (net 2 "+3V3")
  (footprint "R:R_0603" (layer "F.Cu") (at 100 60 90) (uuid "u1")
    (property "Reference" "R1" (at 0 0 0) (effects (font (size 1 1))))
    (property "Value" "10k" (at 0 0 0) (effects (font (size 1 1))))
    (pad "1" smd rect (at -0.8 0) (size 0.8 0.9) (layers "F.Cu")))
  (segment (start 100 60) (end 105 60) (width 0.25) (layer "F.Cu") (net 1) (uuid "s1"))
  (via (at 105 60) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 1) (uuid "v1"))
  (gr_line (start 0 0) (end 10 0) (stroke (width 0.1) (type solid)) (layer "Edge.Cuts"))
)
`

const board = (): ReturnType<typeof parseKicadBoard> => parseKicadBoard(BOARD)
const ctx = (b: ReturnType<typeof parseKicadBoard>): BoardContext => ({
  layers: b.layers.map((l) => ({ value: l.name, label: l.name })),
  nets: b.nets.map((n) => ({ value: `${n.number}`, label: n.name }))
})
type Groups = ReturnType<typeof buildBoardGroups>
const group = (g: Groups, type: string): Groups[number] | undefined =>
  g.find((x) => x.type === type)
const fieldValue = (g: Groups, type: string, key: string): unknown =>
  group(g, type)?.fields.find((f) => f.key === key)?.value

describe('buildBoardGroups', () => {
  it('shows the board group only when nothing is selected', () => {
    const b = board()
    const groups = buildBoardGroups(b, [], t, ctx(b))
    expect(groups.map((g) => g.type)).toEqual(['board'])
    expect(fieldValue(groups, 'board', 'thickness')).toBe(mm(1.6))
    expect(fieldValue(groups, 'board', 'paper')).toBe('A4')
  })

  it('builds a footprint group (raw Y)', () => {
    const b = board()
    const groups = buildBoardGroups(b, [{ type: 'footprint', index: 0 }], t, ctx(b))
    expect(fieldValue(groups, 'footprint', 'posY')).toBe(mm(60))
    expect(fieldValue(groups, 'footprint', 'rotation')).toBe(90)
    expect(fieldValue(groups, 'footprint', 'side')).toBe('F.Cu')
    expect(fieldValue(groups, 'footprint', 'reference')).toBe('R1')
  })

  it('lets a footprint name itself only while no symbol owns it', () => {
    const owned = parseKicadBoard(BOARD.replace('(uuid "u1")', '(uuid "u1") (path "/s1")'))
    const boardOnly = parseKicadBoard(
      BOARD.replace('(uuid "u1")', '(uuid "u1") (path "/s1") (attr board_only)')
    )
    for (const [b, readonly] of [
      [owned, true],
      [boardOnly, false],
      [board(), false]
    ] as const) {
      const fp = buildBoardGroups(b, [{ type: 'footprint', index: 0 }], t, ctx(b))
      expect(group(fp, 'footprint')?.fields.find((f) => f.key === 'reference')?.readonly).toBe(
        readonly || undefined
      )
      expect(group(fp, 'footprint')?.fields.find((f) => f.key === 'value')?.readonly).toBe(
        readonly || undefined
      )
      const field = buildBoardGroups(b, [{ type: 'fp_field', index: 0, child: 0 }], t, ctx(b))
      expect(group(field, 'fp_field')?.fields.find((f) => f.key === 'text')?.readonly).toBe(
        readonly || undefined
      )
    }
  })

  it('builds a segment group with editable width/layer/net', () => {
    const b = board()
    const groups = buildBoardGroups(b, [{ type: 'segment', index: 0 }], t, ctx(b))
    expect(fieldValue(groups, 'segment', 'width')).toBe(mm(0.25))
    expect(fieldValue(groups, 'segment', 'net')).toBe(1)
    expect(fieldValue(groups, 'segment', 'layer')).toBe('F.Cu')
  })

  it("shows a track's own length and its net's, read-only, as KiCad's track readout", () => {
    const b = board()
    const bare = buildBoardGroups(b, [{ type: 'segment', index: 0 }], t, ctx(b))
    expect(fieldValue(bare, 'segment', 'length')).toBe(mm(5))
    expect(group(bare, 'segment')?.fields.find((f) => f.key === 'routedLength')).toBeUndefined()
    const asked: number[] = []
    const keys = (padToDie: number): Record<string, unknown> =>
      Object.fromEntries(
        group(
          buildBoardGroups(b, [{ type: 'segment', index: 0 }], t, {
            ...ctx(b),
            netLength: (net) => (asked.push(net), { routed: 12.5, padToDie })
          }),
          'segment'
        )!
          .fields.filter((f) => f.readonly)
          .map((f) => [f.key, f.value])
      )
    // Pad-to-die and the full length only where a pad sets a die length.
    expect(keys(0)).toEqual({ length: mm(5), routedLength: 12.5 })
    expect(keys(1.5)).toEqual({ length: mm(5), routedLength: 12.5, padToDie: 1.5, fullLength: 14 })
    expect(asked).toEqual([1, 1])
  })

  it('builds a via group with type + net', () => {
    const b = board()
    const groups = buildBoardGroups(b, [{ type: 'via', index: 0 }], t, ctx(b))
    expect(fieldValue(groups, 'via', 'size')).toBe(mm(0.6))
    expect(fieldValue(groups, 'via', 'type')).toBe('through')
  })

  it('marks disagreeing multi-select values MIXED', () => {
    const b = board()
    // one via + one segment selected → two groups
    const groups = buildBoardGroups(
      b,
      [
        { type: 'segment', index: 0 },
        { type: 'via', index: 0 }
      ],
      t,
      ctx(b)
    )
    expect(groups.map((g) => g.type).sort()).toEqual(['segment', 'via'])
  })

  it('makes board gr_line editable', () => {
    const b = board()
    const groups = buildBoardGroups(b, [{ type: 'gr_line', index: 0 }], t, ctx(b))
    expect(fieldValue(groups, 'gr_line', 'strokeType')).toBe('solid')
    expect(fieldValue(groups, 'gr_line', 'layer')).toBe('Edge.Cuts')
  })
})

describe('boardPatch', () => {
  it('maps coordinate + net keys', () => {
    expect(boardPatch('startX', 3)).toEqual({ start: { x: 3 } })
    expect(boardPatch('posY', -2)).toEqual({ position: { y: -2 } })
    expect(boardPatch('net', '2')).toEqual({ net: 2 })
    expect(boardPatch('width', 0.3)).toEqual({ width: 0.3 })
  })
})

describe('updateBoardMetaInAST', () => {
  it('edits thickness + paper with a round-trip', () => {
    const b = board()
    updateBoardMetaInAST(b, { thickness: mm(1.2), paper: 'A3' })
    const round = parseKicadBoard(serializeKicadBoard(b))
    expect(round.thickness).toBe(mm(1.2))
    expect(round.paper).toBe('A3')
  })
})

describe('isMixed export sanity', () => {
  it('is usable', () => {
    expect(isMixed(undefined)).toBe(false)
  })
})

describe('size rows and the rules (router-behavior.md S9)', () => {
  const rules = (min: number, via = 0.3): BoardContext['rulesFor'] => ({
    trackWidth: () => ({ min, source: "netclass 'Default'" }),
    via: () => ({ min: via, source: "netclass 'Default'" })
  })
  const row = (
    b: ReturnType<typeof parseKicadBoard>,
    c: BoardContext,
    type: string,
    key: string
  ): Groups[number]['fields'][number] | undefined =>
    group(buildBoardGroups(b, [{ type, index: 0 }], t, c), type)?.fields.find((f) => f.key === key)

  it("warns of a size only outside the rules' bounds, and offers no reset, as KiCad", () => {
    const b = board()
    // 0.25 against a min of 0.1: legal however far from the preferred size.
    const legal = row(b, { ...ctx(b), rulesFor: rules(0.1) }, 'segment', 'width')
    expect(legal?.warning).toBeUndefined()
    expect(legal?.actions).toBeUndefined()
    expect(row(b, { ...ctx(b), rulesFor: rules(0.3) }, 'segment', 'width')?.warning).toBe(
      'pcbEditor.properties.belowRule'
    )
    expect(row(b, { ...ctx(b), rulesFor: rules(0.1, 0.8) }, 'via', 'size')?.warning).toBe(
      'pcbEditor.properties.belowRule'
    )
    expect(row(b, ctx(b), 'via', 'size')?.warning).toBeUndefined()
    const tagged = row(
      b,
      {
        ...ctx(b),
        rulesFor: rules(0.3),
        classColor: (name) => (name === 'Default' ? '#f00' : undefined)
      },
      'segment',
      'width'
    )
    expect(tagged?.warningSource).toEqual({ kind: 'netClass', name: 'Default', color: '#f00' })
  })

  it('reads a source as a class tag, a rule name, or text', () => {
    expect(warningSourceOf("netclass 'USB,HS'", (n) => (n === 'USB' ? 'blue' : undefined))).toEqual(
      {
        kind: 'netClass',
        name: 'USB,HS',
        color: 'blue'
      }
    )
    expect(warningSourceOf("rule '(85_ohm_outer'")).toEqual({ kind: 'rule', name: '(85_ohm_outer' })
    expect(warningSourceOf('board minimum')).toEqual({ kind: 'text', text: 'board minimum' })
  })
})

/** One of every item the PCB editor selects. */
const EVERY_ITEM = `(kicad_pcb (version 20260206) (generator "pcbnew")
  (general (thickness 1.6))
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (25 "Edge.Cuts" user) (37 "F.SilkS" user))
  (net 0 "") (net 1 "GND")
  (footprint "R:R_0603" (layer "F.Cu") (at 100 60) (uuid "u1")
    (property "Reference" "R1" (at 0 0 0) (effects (font (size 1 1))))
    (pad "1" smd rect (at -0.8 0) (size 0.8 0.9) (layers "F.Cu")))
  (segment (start 100 60) (end 105 60) (width 0.25) (layer "F.Cu") (net 1))
  (arc (start 0 0) (mid 1 1) (end 2 0) (width 0.25) (layer "F.Cu") (net 1))
  (via (at 105 60) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 1))
  (zone (net 1) (net_name "GND") (layer "F.Cu") (hatch edge 0.5)
    (polygon (pts (xy 0 0) (xy 10 0) (xy 10 10))))
  (gr_line (start 0 0) (end 10 0) (stroke (width 0.1) (type solid)) (layer "Edge.Cuts"))
  (gr_arc (start 0 0) (mid 1 1) (end 2 0) (stroke (width 0.1) (type solid)) (layer "Edge.Cuts"))
  (gr_circle (center 0 0) (end 1 0) (stroke (width 0.1) (type solid)) (fill no) (layer "F.SilkS"))
  (gr_rect (start 0 0) (end 1 1) (stroke (width 0.1) (type solid)) (fill no) (layer "F.SilkS"))
  (gr_poly (pts (xy 0 0) (xy 1 0) (xy 1 1)) (stroke (width 0.1) (type solid)) (fill yes) (layer "F.SilkS"))
  (gr_curve (pts (xy 0 0) (xy 1 -1) (xy 2 1) (xy 3 0)) (stroke (width 0.2) (type default)) (layer "F.SilkS"))
  (gr_text "Rev A" (at 20 30 90) (layer "F.SilkS") (effects (font (size 1.5 1.5) (thickness 0.3))))
  (gr_text_box "Note" (start 20 20) (end 30 25) (layer "F.SilkS") (effects (font (size 1 1))))
  (table (column_count 1) (layer "F.SilkS") (column_widths 10) (row_heights 5 5)
    (cells
      (table_cell "A" (start 40 40) (end 50 45) (layer "F.SilkS") (effects (font (size 1 1))))
      (table_cell "B" (start 40 45) (end 50 50) (layer "F.SilkS") (effects (font (size 1 1))))))
  (point (at 5 6) (size 1) (layer "F.SilkS"))
  (generated (uuid "tp") (type tuning_pattern) (name "Tuning Pattern") (layer "F.Cu")
    (base_line (pts (xy 0 0) (xy 4 0))) (end (xy 4 0)) (origin (xy 0 0)) (initial_side "left")
    (max_amplitude 1) (min_amplitude 0.2) (min_spacing 0.6) (target_length 10)
    (target_length_min 9.9) (target_length_max 10.1) (tuning_mode "single") (members))
)`

describe('every selectable board item has a property group', () => {
  it.each(Object.keys(BOARD_ITEM_COLLECTIONS))('%s', (type) => {
    const b = parseKicadBoard(EVERY_ITEM)
    expect(boardCollection(b, type)?.length).toBeGreaterThan(0)
    const groups = buildBoardGroups(b, [{ type, index: 0 }], t, ctx(b))
    expect(groups.map((g) => g.type)).toEqual([type])
    expect(groups[0].fields.length).toBeGreaterThan(0)
  })

  it('gives a type with no group an empty one, never the board group', () => {
    const b = board()
    const groups = buildBoardGroups(b, [{ type: 'unknown', index: 0 }], t, ctx(b))
    expect(groups).toEqual([
      { type: 'unknown', title: 'shared.properties.selection', count: 1, fields: [] }
    ])
  })

  it('shows a board text’s rows with raw Y', () => {
    const b = parseKicadBoard(EVERY_ITEM)
    const groups = buildBoardGroups(b, [{ type: 'gr_text', index: 0 }], t, ctx(b))
    expect(fieldValue(groups, 'gr_text', 'text')).toBe('Rev A')
    expect(fieldValue(groups, 'gr_text', 'angle')).toBe(90)
    expect(fieldValue(groups, 'gr_text', 'textHeight')).toBe(mm(1.5))
    expect(fieldValue(groups, 'gr_text', 'thickness')).toBe(mm(0.3))
    expect(
      group(groups, 'gr_text')?.fields.some((f) => f.key === 'keepUpright' || f.key === 'hidden')
    ).toBe(false)
    const posY = group(groups, 'gr_text')?.fields.find((f) => f.key === 'posY')
    expect(posY?.value).toBe(mm(30))
    expect(posY?.editor.negate).toBe(false)
  })
})

describe('KiCad’s board rows', () => {
  const rowOf = (g: Groups, type: string, key: string): PropertyField | undefined =>
    group(g, type)?.fields.find((f) => f.key === key)

  it('gives every item but a point its Locked row, above the subheadings', () => {
    const b = parseKicadBoard(EVERY_ITEM)
    for (const type of ['segment', 'tarc', 'via', 'zone', 'gr_rect', 'gr_text', 'table']) {
      const groups = buildBoardGroups(b, [{ type, index: 0 }], t, ctx(b))
      const fields = group(groups, type)!.fields
      const locked = fields.findIndex((f) => f.key === 'locked')
      expect(locked, type).toBeGreaterThanOrEqual(0)
      expect(
        fields.slice(0, locked).every((f) => !f.section),
        type
      ).toBe(true)
    }
    const point = buildBoardGroups(b, [{ type: 'point', index: 0 }], t, ctx(b))
    expect(rowOf(point, 'point', 'locked')).toBeUndefined()
  })

  it('gives a track arc its net and a via its layer span', () => {
    const b = parseKicadBoard(EVERY_ITEM)
    const arc = buildBoardGroups(b, [{ type: 'tarc', index: 0 }], t, ctx(b))
    expect(fieldValue(arc, 'tarc', 'net')).toBe(1)
    const via = buildBoardGroups(b, [{ type: 'via', index: 0 }], t, ctx(b))
    expect(fieldValue(via, 'via', 'layerTop')).toBe('F.Cu')
    expect(fieldValue(via, 'via', 'layerBottom')).toBe('B.Cu')
  })

  it('gives a placed footprint KiCad’s attributes and overrides', () => {
    const b = parseKicadBoard(EVERY_ITEM)
    const groups = buildBoardGroups(b, [{ type: 'footprint', index: 0 }], t, ctx(b))
    expect(rowOf(groups, 'footprint', 'attr:dnp')?.section).toBe('attributes')
    expect(rowOf(groups, 'footprint', 'clearance')?.section).toBe('overrides')
    expect(rowOf(groups, 'footprint', 'reference')?.section).toBe('fields')
    expect(rowOf(groups, 'footprint', 'attr:allow_soldermask_bridges')?.section).toBe('overrides')
  })

  it('offers a zone’s name and the below-area island mode', () => {
    const b = parseKicadBoard(EVERY_ITEM)
    const groups = buildBoardGroups(b, [{ type: 'zone', index: 0 }], t, ctx(b))
    expect(rowOf(groups, 'zone', 'zoneName')).toBeDefined()
    expect(rowOf(groups, 'zone', 'removeIslands')?.editor.options?.map((o) => o.value)).toEqual([
      '0',
      '1',
      '2'
    ])
  })

  it('maps a board graphic’s KiCad rows to the footprint shape patches', () => {
    const b = parseKicadBoard(EVERY_ITEM)
    const circle = b.grCircles[0]
    expect(boardGraphicPatch('gr_circle', 'radius', mm(2), circle)).toEqual({
      end: { x: mm(2), y: mm(0) }
    })
  })
})

describe('a pad selected on the board', () => {
  it('shows the pad’s own rows under its net and pin, without a position', () => {
    const b = parseKicadBoard(EVERY_ITEM)
    const groups = buildBoardGroups(b, [{ type: 'pad', index: 0, pad: 0 }], t, ctx(b))
    expect(groups.map((g) => g.type)).toEqual(['pad'])
    const keys = group(groups, 'pad')!.fields.map((f) => f.key)
    expect(keys).toContain('number')
    expect(keys).toContain('clearance')
    expect(keys).not.toContain('posX')
    expect(group(groups, 'pad')!.fields.find((f) => f.key === 'net')?.readonly).toBe(true)
  })

  it('resolves through its footprint, and a stale one resolves to nothing', () => {
    const b = parseKicadBoard(EVERY_ITEM)
    expect(selectedPads(b, [{ type: 'pad', index: 0, pad: 0 }])).toEqual([
      b.footprints[0].footprint.pads[0]
    ])
    expect(selectedPads(b, [{ type: 'pad', index: 0, pad: 9 }])).toEqual([])
  })
})

describe('T4: a tuning pattern', () => {
  it('shows what it tunes to and how, the target unbounded where it has none', () => {
    const b = parseKicadBoard(EVERY_ITEM)
    const groups = buildBoardGroups(b, [{ type: 'tuning_pattern', index: 0 }], t, ctx(b))
    expect(fieldValue(groups, 'tuning_pattern', 'mode')).toBe('single')
    expect(fieldValue(groups, 'tuning_pattern', 'target')).toBe(10)
    expect(fieldValue(groups, 'tuning_pattern', 'maxAmplitude')).toBe(1)
    expect(fieldValue(groups, 'tuning_pattern', 'initialSide')).toBe('left')
    expect(group(groups, 'tuning_pattern')?.fields.some((f) => f.key === 'locked')).toBe(false)
  })
})
