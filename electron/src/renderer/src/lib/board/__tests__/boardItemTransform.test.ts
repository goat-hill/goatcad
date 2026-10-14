import { describe, expect, test } from 'vitest'
import { parseKicadBoard } from '../../kicad/board'
import { boardLayerFlipper } from '../../kicad/layers'
import { mmToNm, nm } from '../../kicad/coordinates'
import { serializeSExpr, type SExprList } from '../../kicad/sexpr'
import { rotatedBoardItemNode, transformCenter } from '../boardItemTransform'
import { flippedBoardItemNode } from '../footprintFlip'

const board = (body: string): ReturnType<typeof parseKicadBoard> =>
  parseKicadBoard(`(kicad_pcb (version 20240108) (generator "test")
  (layers (0 "F.Cu" signal) (2 "In1.Cu" signal) (4 "In2.Cu" signal) (31 "B.Cu" signal)
    (37 "F.SilkS" user) (36 "B.SilkS" user) (44 "Edge.Cuts" user))
  (net 0 "") (net 1 "GND")
  ${body})`)

const at = (x: number, y: number): { x: ReturnType<typeof nm>; y: ReturnType<typeof nm> } => ({
  x: nm(mmToNm(x)),
  y: nm(mmToNm(y))
})

const text = (node: SExprList): string => serializeSExpr(node, 0, true)

const SEG = '(segment (start 1 0) (end 3 0) (width 0.25) (layer "F.Cu") (net 1) (uuid "s"))'
const FP = `(footprint "T:R" (layer "F.Cu") (uuid "f") (at 10 10)
  (pad "1" smd rect (at -1 0) (size 1 1) (layers "F.Cu")) (pad "2" smd rect (at 1 0) (size 1 1) (layers "F.Cu")))`

describe('transformCenter', () => {
  test('one item turns about its own position: a footprint its anchor, a track its start', () => {
    const b = board(`${FP} ${SEG}`)
    expect(transformCenter(b, [{ type: 'footprint', index: 0 }], 'rotate', 0)).toEqual(at(10, 10))
    expect(transformCenter(b, [{ type: 'segment', index: 0 }], 'rotate', 0)).toEqual(at(1, 0))
  })

  test('a rectangle turns and flips about its middle', () => {
    const b = board('(gr_rect (start 0 0) (end 4 2) (layer "F.SilkS") (uuid "r"))')
    expect(transformCenter(b, [{ type: 'gr_rect', index: 0 }], 'flip', 0)).toEqual(at(2, 1))
  })

  test('several turn about their box middle, snapped to the grid; a flip takes it unsnapped', () => {
    const b = board(`${FP} ${SEG}`)
    const refs = [
      { type: 'footprint', index: 0 },
      { type: 'segment', index: 0 }
    ]
    // Box over the track (1..3, 0) and the part's pads (9..11, 10): middle (6, 5).
    expect(transformCenter(b, refs, 'flip', 0)).toEqual(at(6, 5))
    expect(transformCenter(b, refs, 'rotate', mmToNm(4))).toEqual(at(8, 4))
  })
})

describe('rotatedBoardItemNode', () => {
  test('a quarter turn counterclockwise, as KiCad turns: +x goes up the screen', () => {
    const b = board(SEG)
    const turned = rotatedBoardItemNode(b.segments[0]._raw, at(0, 0), 90)
    expect(text(turned)).toContain('(start 0 -1)')
    expect(text(turned)).toContain('(end 0 -3)')
    // The board's own node is untouched.
    expect(text(b.segments[0]._raw)).toContain('(start 1 0)')
  })

  test("a text's angle turns with it", () => {
    const b = board(
      '(gr_text "A" (at 2 0 0) (layer "F.SilkS") (uuid "t") (effects (font (size 1 1))))'
    )
    const turned = text(rotatedBoardItemNode(b.grTexts[0]._raw, at(0, 0), 90))
    expect(turned).toContain('(at 0 -2 90)')
  })

  test("a zone's outline and fill turn", () => {
    const b = board(`(zone (net 1) (net_name "GND") (layer "F.Cu") (uuid "z")
      (polygon (pts (xy 1 0) (xy 2 0) (xy 2 1)))
      (filled_polygon (layer "F.Cu") (pts (xy 1 0) (xy 2 0) (xy 2 1))))`)
    const turned = text(rotatedBoardItemNode(b.zones[0]._raw, at(0, 0), 180))
    expect(turned.match(/\(xy -2 0\)/g)).toHaveLength(2)
  })
})

describe('flippedBoardItemNode', () => {
  const flip = (body: string, pick: (b: ReturnType<typeof board>) => SExprList): string => {
    const b = board(body)
    const next = flippedBoardItemNode(pick(b), at(0, 0), 'leftRight', boardLayerFlipper(b.layers))
    return next ? text(next) : ''
  }

  test('a track mirrors and takes the opposite copper', () => {
    const out = flip(SEG, (b) => b.segments[0]._raw)
    expect(out).toContain('(start -1 0)')
    expect(out).toContain('(layer "B.Cu")')
  })

  test('a through via keeps its layers; a blind one takes the opposite pair', () => {
    const through = flip(
      '(via (at 2 0) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 1) (uuid "v"))',
      (b) => b.vias[0]._raw
    )
    expect(through).toContain('(at -2 0)')
    expect(through).toContain('(layers "F.Cu" "B.Cu")')
    const blind = flip(
      '(via blind (at 2 0) (size 0.6) (drill 0.3) (layers "F.Cu" "In1.Cu") (net 1) (uuid "v"))',
      (b) => b.vias[0]._raw
    )
    expect(blind).toContain('(layers "In2.Cu" "B.Cu")')
  })

  test('a text mirrors, negates its angle, and a side-specific one toggles its mirror', () => {
    const out = flip(
      '(gr_text "A" (at 2 0 30) (layer "F.SilkS") (uuid "t") (effects (font (size 1 1))))',
      (b) => b.grTexts[0]._raw
    )
    expect(out).toContain('(at -2 0 330)')
    expect(out).toContain('(layer "B.SilkS")')
    expect(out).toContain('(justify mirror)')
  })
})
