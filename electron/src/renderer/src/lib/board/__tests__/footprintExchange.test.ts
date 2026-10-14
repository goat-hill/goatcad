/**
 * The footprint swap (`footprintExchange.ts`): a placed footprint replaced by
 * a library one, held to library parity (`footprintParity.ts`) for its
 * geometry and to KiCad's `ExchangeFootprint` for what it keeps.
 */
import { describe, expect, test } from 'vitest'
import { parseKicadBoard, type KicadBoard } from '../../kicad/board'
import { parseKicadFootprint } from '../../kicad/footprint'
import {
  findChild,
  findChildren,
  getAtomValues,
  serializeSExpr,
  type SExprList
} from '../../kicad/sexpr'
import {
  CHANGE_DEFAULTS,
  UPDATE_DEFAULTS,
  exchangeFootprints,
  type ExchangeOptions
} from '../footprintExchange'
import { flipBoardFootprintInAST } from '../footprintFlip'
import { libraryDifference } from '../footprintParity'

const LIBRARY = parseKicadFootprint(`(footprint "R" (layer "F.Cu")
  (property "Reference" "REF**" (at 0 -1.5 0) (layer "F.SilkS") (uuid "l1") (effects (font (size 1 1) (thickness 0.15))))
  (property "Value" "R" (at 0 1.5 0) (layer "F.Fab") (uuid "l2") (effects (font (size 1 1) (thickness 0.15))))
  (attr smd)
  (fp_line (start -1 -0.5) (end 1 -0.5) (stroke (width 0.12) (type solid)) (layer "F.SilkS"))
  (fp_text user "\${REFERENCE}" (at 0 0 0) (layer "F.Fab") (uuid "l3") (effects (font (size 0.5 0.5) (thickness 0.08))))
  (pad "1" smd rect (at -1 0) (size 0.6 0.8) (layers "F.Cu" "F.Paste" "F.Mask"))
  (pad "2" smd rect (at 1 0 90) (size 0.6 0.8) (layers "F.Cu" "F.Paste" "F.Mask"))
  (model "\${KICAD10_3DMODEL_DIR}/R.step" (offset (xyz 0 0 0)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 0))))`)

/** A three-pad part to change to: pad 2 is gone, pads 3 and 4 are new. */
const SOT = parseKicadFootprint(`(footprint "SOT-23" (layer "F.Cu")
  (property "Reference" "REF**" (at 0 -2.5 0) (layer "F.SilkS") (uuid "s1") (effects (font (size 1 1) (thickness 0.15))))
  (property "Value" "SOT-23" (at 0 2.5 0) (layer "F.Fab") (uuid "s2") (effects (font (size 1 1) (thickness 0.15))))
  (attr smd)
  (pad "1" smd rect (at -1 -0.95) (size 0.9 0.8) (layers "F.Cu" "F.Paste" "F.Mask"))
  (pad "3" smd rect (at 1 0) (size 0.9 0.8) (layers "F.Cu" "F.Paste" "F.Mask"))
  (pad "4" smd rect (at 1 1) (size 0.9 0.8) (layers "F.Cu" "F.Paste" "F.Mask")))`)

/** The part as a board holds it, drifted from the library: its silkscreen line moved, its texts edited. */
const placed = (angle = 0): string => `
  (footprint "Lib:R" (locked yes) (layer "F.Cu") (uuid "fp-1") (at 120 80${angle ? ` ${angle}` : ''})
    (property "Reference" "R7" (at 2 -3 ${angle}) (layer "F.SilkS") (uuid "r1") (effects (font (size 0.8 0.8) (thickness 0.1))))
    (property "Value" "10k" (at 0 1.5 ${angle}) (layer "F.Fab") (hide yes) (uuid "r2") (effects (font (size 1 1) (thickness 0.15))))
    (property "MPN" "RC0603FR-0710KL" (at 0 0 ${angle}) (layer "F.Fab") (hide yes) (uuid "r3") (effects (font (size 1 1) (thickness 0.15))))
    (property "ki_fp_filters" "R_*")
    (path "/aaaa/bbbb")
    (sheetname "/")
    (sheetfile "main.kicad_sch")
    (solder_mask_margin 0.05)
    (attr smd dnp)
    (fp_line (start -1 -0.7) (end 1 -0.7) (stroke (width 0.12) (type solid)) (layer "F.SilkS"))
    (fp_text user "note" (at 0 3 ${angle}) (layer "F.Fab") (uuid "r4") (effects (font (size 1 1) (thickness 0.15))))
    (pad "1" smd rect (at -1 0 ${angle}) (size 0.6 0.8) (layers "F.Cu" "F.Paste" "F.Mask") (net 1 "VCC") (pinfunction "~") (pintype "passive"))
    (pad "2" smd rect (at 1 0 ${angle + 90}) (size 0.6 0.8) (layers "F.Cu" "F.Paste" "F.Mask") (net 2 "GND") (pintype "passive"))
    (model "\${KIPRJMOD}/custom.step" (offset (xyz 0 0 1)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 0))))`

const boardOf = (body: string): KicadBoard =>
  parseKicadBoard(`(kicad_pcb (version 20241229) (generator "test")
  (general (thickness 1.6))
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (1 "F.Mask" user) (3 "B.Mask" user)
    (13 "F.Paste" user) (15 "B.Paste" user) (5 "F.SilkS" user) (7 "B.SilkS" user)
    (35 "F.Fab" user) (37 "B.Fab" user) (25 "Edge.Cuts" user))
  (net 0 "") (net 1 "VCC") (net 2 "GND")
  ${body}
)`)

const reparse = (board: KicadBoard): KicadBoard => parseKicadBoard(serializeSExpr(board._raw))

const swap = (
  board: KicadBoard,
  library = LIBRARY,
  libId = 'Lib:R',
  options: ExchangeOptions = UPDATE_DEFAULTS
): { after: KicadBoard; reports: ReturnType<typeof exchangeFootprints> } => {
  const reports = exchangeFootprints(
    board,
    [{ footprint: board.footprints[0], library, libId }],
    options
  )
  return { after: reparse(board), reports }
}

const field = (board: KicadBoard, name: string): SExprList | undefined =>
  findChildren(board.footprints[0]._raw, 'property').find((p) => getAtomValues(p)[0] === name)

const atomsOf = (node: Parameters<typeof getAtomValues>[0] | null | undefined): string[] =>
  node ? getAtomValues(node) : []

describe('update from library', () => {
  test.each([0, 90, 30])('at %s° the footprint matches its library copy again', (angle) => {
    const board = boardOf(placed(angle))
    expect(libraryDifference(board, board.footprints[0], LIBRARY)).not.toBeNull()
    const { after } = swap(board)
    const footprint = after.footprints[0]
    expect(libraryDifference(after, footprint, LIBRARY)).toBeNull()
    expect(footprint.position.x).toBe(board.footprints[0].position.x)
    expect(footprint.position.angle ?? 0).toBe(angle)
  })

  test('on the back, it matches the library copy flipped', () => {
    const board = boardOf(placed(30))
    flipBoardFootprintInAST(board, board.footprints[0], {
      x: board.footprints[0].position.x,
      y: board.footprints[0].position.y
    })
    const flipped = reparse(board)
    const { after } = swap(flipped)
    expect(after.footprints[0].layer).toBe('B.Cu')
    expect(libraryDifference(after, after.footprints[0], LIBRARY)).toBeNull()
  })

  test('keeps its identity, link, lock, nets and the design’s text edits', () => {
    const { after } = swap(boardOf(placed()))
    const node = after.footprints[0]._raw
    expect(atomsOf(node)[0]).toBe('Lib:R')
    expect(atomsOf(findChild(node, 'uuid'))).toEqual(['fp-1'])
    expect(atomsOf(findChild(node, 'locked'))).toEqual(['yes'])
    expect(atomsOf(findChild(node, 'path'))).toEqual(['/aaaa/bbbb'])
    expect(atomsOf(findChild(node, 'sheetfile'))).toEqual(['main.kicad_sch'])
    expect(atomsOf(field(after, 'ki_fp_filters'))).toEqual(['ki_fp_filters', 'R_*'])
    // Reference: its text, place and size stay (Update keeps text edits).
    const reference = field(after, 'Reference')
    expect(atomsOf(reference)[1]).toBe('R7')
    expect(atomsOf(findChild(reference!, 'at'))).toEqual(['2', '-3', '0'])
    expect(serializeSExpr(findChild(reference!, 'effects')!)).toContain('0.8 0.8')
    // Value and a user field keep their text and stay hidden.
    expect(atomsOf(field(after, 'Value'))[1]).toBe('10k')
    expect(findChild(field(after, 'Value')!, 'hide')).not.toBeNull()
    expect(atomsOf(field(after, 'MPN'))[1]).toBe('RC0603FR-0710KL')
    // The DNP flag is the schematic's; the free text the design added stays.
    expect(after.footprints[0].footprint.attributes).toEqual(['smd', 'dnp'])
    const texts = findChildren(node, 'fp_text').map((text) => atomsOf(text)[1])
    expect(texts).toEqual(['${REFERENCE}', 'note'])
    // Each pad keeps its net, pin function and pin type.
    const pads = findChildren(node, 'pad')
    expect(atomsOf(findChild(pads[0], 'net'))).toEqual(['1', 'VCC'])
    expect(atomsOf(findChild(pads[0], 'pinfunction'))).toEqual(['~'])
    expect(atomsOf(findChild(pads[1], 'net'))).toEqual(['2', 'GND'])
  })

  test('takes the library’s clearance overrides and 3D model by default, keeps them when asked', () => {
    const fresh = swap(boardOf(placed())).after.footprints[0]._raw
    expect(findChild(fresh, 'solder_mask_margin')).toBeNull()
    expect(atomsOf(findChild(fresh, 'model'))[0]).toBe('${KICAD10_3DMODEL_DIR}/R.step')
    const kept = swap(boardOf(placed()), LIBRARY, 'Lib:R', {
      ...UPDATE_DEFAULTS,
      resetClearanceOverrides: false,
      reset3DModels: false
    }).after.footprints[0]._raw
    expect(atomsOf(findChild(kept, 'solder_mask_margin'))).toEqual(['0.05'])
    expect(atomsOf(findChild(kept, 'model'))[0]).toBe('${KIPRJMOD}/custom.step')
  })
})

describe('change footprint', () => {
  test('reports the pads that lose their net and the pads that arrive without one', () => {
    const { after, reports } = swap(boardOf(placed()), SOT, 'Package:SOT-23', CHANGE_DEFAULTS)
    expect(reports).toEqual([
      {
        reference: 'R7',
        from: 'Lib:R',
        to: 'Package:SOT-23',
        droppedPads: [{ number: '2', net: 'GND' }],
        addedPads: [
          { number: '3', net: '' },
          { number: '4', net: '' }
        ]
      }
    ])
    const pads = findChildren(after.footprints[0]._raw, 'pad')
    expect(atomsOf(findChild(pads[0], 'net'))).toEqual(['1', 'VCC'])
    expect(findChild(pads[1], 'net')).toBeNull()
  })

  test('resets text to the library’s but never the reference, and keeps the placement’s flags', () => {
    const { after } = swap(boardOf(placed()), SOT, 'Package:SOT-23', CHANGE_DEFAULTS)
    const reference = field(after, 'Reference')
    expect(atomsOf(reference)[1]).toBe('R7')
    expect(atomsOf(findChild(reference!, 'at'))).toEqual(['0', '-2.5', '0'])
    // A value the design set is kept: only a value echoing the footprint's name is reset.
    expect(atomsOf(field(after, 'Value'))[1]).toBe('10k')
    expect(after.footprints[0].footprint.attributes).toEqual(['smd', 'dnp'])
    expect(atomsOf(after.footprints[0]._raw)[0]).toBe('Package:SOT-23')
  })

  test('a value that only named the old footprint takes the new one’s', () => {
    const board = boardOf(placed().replace('"Value" "10k"', '"Value" "R"'))
    const { after } = swap(board, SOT, 'Package:SOT-23', CHANGE_DEFAULTS)
    expect(atomsOf(field(after, 'Value'))[1]).toBe('SOT-23')
  })

  test('a board-only footprint stays board-only', () => {
    const board = boardOf(placed().replace('(attr smd dnp)', '(attr smd board_only)'))
    const { after } = swap(board, SOT, 'Package:SOT-23', CHANGE_DEFAULTS)
    expect(after.footprints[0].footprint.attributes).toEqual(['smd', 'board_only'])
  })

  test('drops the design’s extra texts only when asked', () => {
    const kept = swap(boardOf(placed()), SOT, 'Package:SOT-23', CHANGE_DEFAULTS).after
    expect(findChildren(kept.footprints[0]._raw, 'fp_text').map((t) => atomsOf(t)[1])).toEqual([
      'note'
    ])
    const dropped = swap(boardOf(placed()), SOT, 'Package:SOT-23', {
      ...CHANGE_DEFAULTS,
      removeExtraTexts: true
    }).after
    expect(findChildren(dropped.footprints[0]._raw, 'fp_text')).toEqual([])
  })
})
