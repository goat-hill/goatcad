import { beforeAll, describe, expect, test } from 'vitest'
import { parseKicadBoard } from '../../kicad/board'
import { loadClipper } from '../../geometry/clip'
import { boardLayerIndex } from '../layerIndex'
import { padMaskMargin, padPasteMargin, trackMaskMargin } from '../maskExpansion'

const HEAD = `(kicad_pcb (version 20241229) (generator "test")
  (general (thickness 1.6))
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (1 "F.Mask" user) (3 "B.Mask" user)
    (13 "F.Paste" user) (5 "F.SilkS" user) (25 "Edge.Cuts" user) (31 "F.CrtYd" user))
  (setup (pad_to_mask_clearance 0.05) (pad_to_paste_clearance_ratio -0.1))
  (net 0 "") (net 1 "A")`

const board = (body: string): ReturnType<typeof parseKicadBoard> =>
  parseKicadBoard(`${HEAD}\n${body}\n)`)

const part = (margins = '', pad = ''): string => `
  (footprint "T:P" (layer "F.Cu") (uuid "fp-1") (at 10 10)${margins}
    (property "Reference" "R1" (at 0 -2) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15))))
    (fp_rect (start -2 -1.5) (end 2 1.5) (stroke (width 0.05) (type solid)) (fill none) (layer "F.CrtYd"))
    (pad "1" smd rect (at 0 0) (size 2 1) (layers "F.Cu" "F.Mask" "F.Paste") (net 1 "A") (uuid "p1")${pad}))`

beforeAll(async () => {
  await loadClipper()
})

describe('mask and paste margins', () => {
  test("the pad's own, else its footprint's, else the board's", () => {
    expect(padMaskMargin(board(part()), 0, 0, 'F.Mask')).toBe(50_000)
    expect(padMaskMargin(board(part(' (solder_mask_margin 0.1)')), 0, 0, 'F.Mask')).toBe(100_000)
    expect(
      padMaskMargin(
        board(part(' (solder_mask_margin 0.1)', ' (solder_mask_margin 0.02)')),
        0,
        0,
        'F.Mask'
      )
    ).toBe(20_000)
  })

  test('a negative mask margin never closes the opening: at most half the smaller side', () => {
    expect(padMaskMargin(board(part('', ' (solder_mask_margin -1)')), 0, 0, 'F.Mask')).toBe(
      -500_000
    )
  })

  test('paste is the margin plus the ratio of each side, clamped to half of it', () => {
    expect(padPasteMargin(board(part()), 0, 0, 'F.Paste')).toEqual({ x: -200_000, y: -100_000 })
    expect(padPasteMargin(board(part('', ' (solder_paste_margin -2)')), 0, 0, 'F.Paste')).toEqual({
      x: -1_000_000,
      y: -500_000
    })
  })

  test('a track is bare only where its layers say so, by its own margin or the board’s', () => {
    const b = board(`
  (segment (start 0 0) (end 5 0) (width 0.2) (layers "F.Cu" "F.Mask") (solder_mask_margin 0.3) (net 1) (uuid "t1"))
  (segment (start 0 1) (end 5 1) (width 0.2) (layers "B.Cu" "B.Mask") (net 1) (uuid "t2"))
  (segment (start 0 2) (end 5 2) (width 0.2) (layer "F.Cu") (net 1) (uuid "t3"))`)
    expect(b.segments.map((s) => s.layer)).toEqual(['F.Cu', 'B.Cu', 'F.Cu'])
    expect(b.segments.map((s) => trackMaskMargin(b, s))).toEqual([300_000, 50_000, null])
  })
})

describe('boardLayerIndex', () => {
  test("a pad's mask opening and paste aperture are its copper grown by their margins", () => {
    const index = boardLayerIndex(board(part()))
    const [mask] = index.layer('F.Mask').items
    expect(mask).toMatchObject({ kind: 'pad', fp: 0, uuid: 'p1', shape: { kind: 'rrect' } })
    if (mask.shape.kind !== 'rrect') throw new Error('rect pad')
    expect(mask.shape.halfW).toBeCloseTo(1.05)
    expect(mask.shape.halfH).toBeCloseTo(0.55)
    expect(mask.shape.cornerR).toBeCloseTo(0.05)
    const [paste] = index.layer('F.Paste').items
    if (paste.shape.kind !== 'rrect') throw new Error('rect pad')
    expect(paste.shape.halfW).toBeCloseTo(0.8)
    expect(paste.shape.halfH).toBeCloseTo(0.4)
    expect(index.layer('B.Mask').items).toEqual([])
  })

  test('an untented via and a bare track open the mask; a tented via does not', () => {
    const index = boardLayerIndex(
      board(`
  (via (at 5 5) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (tenting (front no) (back yes)) (net 1) (uuid "v1"))
  (via (at 6 5) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 1) (uuid "v2"))
  (segment (start 0 0) (end 5 0) (width 0.2) (layers "F.Cu" "F.Mask") (net 1) (uuid "t1"))`)
    )
    const front = index.layer('F.Mask').items
    expect(front.map((item) => [item.kind, item.uuid])).toEqual([
      ['via', 'v1'],
      ['track', 't1']
    ])
    expect(front[0].shape).toMatchObject({ kind: 'circle', r: 0.35 })
    expect(front[1].shape.kind === 'capsule' && front[1].shape.halfWidth).toBeCloseTo(0.15)
    expect(index.layer('B.Mask').items).toEqual([])
  })

  test('silkscreen text is its glyph strokes', () => {
    const [text] = boardLayerIndex(board(part())).layer('F.SilkS').items
    expect(text.kind).toBe('text')
    expect(text.fp).toBe(0)
    expect(text.shape.kind).toBe('compound')
    // "R1" sits 2 mm above the pad (world y −8), about 1 mm tall.
    expect(text.minY).toBeGreaterThan(-8.7)
    expect(text.maxY).toBeLessThan(-7.3)
  })

  test('the courtyard is its region; the edge its centerlines', () => {
    const index = boardLayerIndex(
      board(`${part()}
  (gr_rect (start 0 0) (end 20 20) (stroke (width 0.1) (type solid)) (fill none) (layer "Edge.Cuts") (uuid "e1"))`)
    )
    const courtyards = index.layer('F.CrtYd').items.filter((item) => item.kind === 'courtyard')
    expect(courtyards).toHaveLength(1)
    expect(courtyards[0]).toMatchObject({ fp: 0, minX: 8, maxX: 12, minY: -11.5, maxY: -8.5 })
    expect(index.layer('F.CrtYd').query(11, -9, 13, -8)).toContain(courtyards[0])
    const edges = index.layer('Edge.Cuts').items
    expect(edges).toHaveLength(4)
    expect(edges.every((edge) => edge.kind === 'edge' && edge.shape.kind === 'capsule')).toBe(true)
  })
})
