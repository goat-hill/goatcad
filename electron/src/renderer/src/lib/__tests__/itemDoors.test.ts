import { describe, expect, test } from 'vitest'
import {
  BOARD_CREATE_KINDS,
  FOOTPRINT_CREATE_KINDS,
  SHEET_CREATE_KINDS,
  SYMBOL_CREATE_KINDS
} from '../../../../shared/itemRecords'
import { parseKicadSymbolLibrary } from '../kicad/symbolLibrary'
import { parseKicadFootprint } from '../kicad/footprint'
import { parseKicadBoard } from '../kicad/board'
import { createSymbolItem } from '../symbol/symbolItems'
import { createItem as createFootprintItem } from '../footprint/footprintItems'
import { createItem as createBoardItem } from '../board/boardItems'
import { GRAPHIC_KINDS } from '../schematic/sheetGraphicItems'

// Each door makes every kind the shared table says its document creates: an
// empty record reaches the kind's own writer, which asks for what it needs,
// rather than falling through to another kind's.

const LIBRARY = `(kicad_symbol_lib (version 20231120) (generator "test")
  (symbol "S" (property "Reference" "U" (at 0 0 0) (effects (font (size 1.27 1.27))))
    (symbol "S_0_1") (symbol "S_1_1")))`

const FOOTPRINT = `(footprint "F" (version 20240108) (generator "test") (layer "F.Cu") (attr smd))`

const BOARD = `(kicad_pcb (version 20240108) (generator "test") (general (thickness 1.6))
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (37 "F.SilkS" user))
  (net 0 ""))`

describe('every door makes every kind its document creates', () => {
  test('symbol', () => {
    for (const kind of SYMBOL_CREATE_KINDS) {
      const node = parseKicadSymbolLibrary(LIBRARY).symbols.get('S')!._node
      expect(createSymbolItem(node, kind, {}), kind).toMatchObject({
        ok: false,
        error: 'invalid-record',
        detail: expect.stringContaining(`A new ${kind} needs`)
      })
    }
  })

  test('footprint', () => {
    for (const kind of FOOTPRINT_CREATE_KINDS) {
      expect(createFootprintItem(parseKicadFootprint(FOOTPRINT), kind, {}), kind).toMatchObject({
        ok: false,
        error: 'invalid-record',
        detail: expect.stringContaining(`A new ${kind} needs`)
      })
    }
  })

  test('board', () => {
    const defaults = {
      classOf: () => ({
        trackWidth: 0.25,
        viaDiameter: 0.6,
        viaDrill: 0.3,
        microviaDiameter: 0.3,
        microviaDrill: 0.1
      })
    }
    for (const kind of BOARD_CREATE_KINDS) {
      expect(createBoardItem(parseKicadBoard(BOARD), kind, {}, defaults), kind).toMatchObject({
        ok: false,
        error: 'invalid-record'
      })
    }
  })

  test('sheet: each create kind is a graphic or one of the sheet door’s own', () => {
    const own = ['label', 'text', 'no_connect', 'junction', 'sheet_pin']
    const graphics = GRAPHIC_KINDS.filter((kind) => kind !== 'bus')
    expect([...own, ...graphics].sort()).toEqual([...SHEET_CREATE_KINDS].sort())
  })
})
