import { beforeEach, describe, expect, test } from 'vitest'
import {
  DOCUMENT_KINDS,
  __resetClipboard,
  canPasteInto,
  clipboardContents,
  setClipboard,
  survivesFootprintPaste,
  translateGraphicsNode,
  usePasteable,
  type DocumentKind
} from '../documentClipboard'

beforeEach(() => {
  __resetClipboard()
})

describe('canPasteInto — KiCad’s cross-editor matrix', () => {
  test('every editor accepts its own kind', () => {
    for (const kind of DOCUMENT_KINDS) expect(canPasteInto(kind, kind)).toBe(true)
  })

  test('board and footprint interoperate, in both directions', () => {
    expect(canPasteInto('board', 'footprint')).toBe(true)
    expect(canPasteInto('footprint', 'board')).toBe(true)
  })

  test('the schematic and PCB domains never cross', () => {
    const schematicSide: DocumentKind[] = ['schematic', 'symbol']
    const pcbSide: DocumentKind[] = ['board', 'footprint']
    for (const from of schematicSide) {
      for (const to of pcbSide) {
        expect(canPasteInto(from, to)).toBe(false)
        expect(canPasteInto(to, from)).toBe(false)
      }
    }
  })

  test('schematic and symbol do not interoperate either', () => {
    // KiCad's symbol editor parses lib symbols and its schematic parses
    // schematic fragments; neither reads the other's clipboard.
    expect(canPasteInto('schematic', 'symbol')).toBe(false)
    expect(canPasteInto('symbol', 'schematic')).toBe(false)
  })
})

describe('survivesFootprintPaste', () => {
  test('copper is dropped — a footprint has no tracks, vias or zones', () => {
    expect(survivesFootprintPaste('segment')).toBe(false)
    expect(survivesFootprintPaste('arc')).toBe(false)
    expect(survivesFootprintPaste('via')).toBe(false)
    expect(survivesFootprintPaste('zone')).toBe(false)
  })

  test('graphics and text transfer', () => {
    for (const name of ['gr_line', 'gr_arc', 'gr_circle', 'gr_rect', 'gr_poly', 'gr_text']) {
      expect(survivesFootprintPaste(name)).toBe(true)
    }
  })
})

describe('translateGraphicsNode', () => {
  test('board graphics become footprint graphics', () => {
    expect(translateGraphicsNode('gr_line', 'footprint')).toBe('fp_line')
    expect(translateGraphicsNode('gr_poly', 'footprint')).toBe('fp_poly')
    expect(translateGraphicsNode('gr_text', 'footprint')).toBe('fp_text')
  })

  test('footprint graphics become board graphics', () => {
    expect(translateGraphicsNode('fp_circle', 'board')).toBe('gr_circle')
    expect(translateGraphicsNode('fp_rect', 'board')).toBe('gr_rect')
  })

  test('a name with no counterpart is not renamed', () => {
    // Structural, not a rename: a footprint pastes onto a board as an instance.
    expect(translateGraphicsNode('footprint', 'board')).toBeNull()
    expect(translateGraphicsNode('segment', 'footprint')).toBeNull()
    // Already in the target's spelling.
    expect(translateGraphicsNode('fp_line', 'footprint')).toBeNull()
    // A pad is a footprint's own child, not a board graphic.
    expect(translateGraphicsNode('pad', 'board')).toBeNull()
  })
})

describe('the store', () => {
  test('copying then reading round-trips the items and their source kind', () => {
    setClipboard('board', ['(via (at 1 2))', '(segment (start 0 0) (end 1 1))'])
    expect(clipboardContents()).toEqual({
      kind: 'board',
      items: ['(via (at 1 2))', '(segment (start 0 0) (end 1 1))']
    })
  })

  test('copying nothing clears rather than storing an empty set', () => {
    setClipboard('board', ['(via (at 1 2))'])
    setClipboard('symbol', [])
    expect(clipboardContents()).toBeNull()
  })

  test('the stored list does not alias the caller’s array', () => {
    const items = ['(via (at 1 2))']
    setClipboard('board', items)
    items.push('(zone)')
    expect(clipboardContents()?.items).toHaveLength(1)
  })
})

describe('usePasteable', () => {
  test('offers the clipboard to an editor that can take it', () => {
    const forFootprint = usePasteable('footprint')
    setClipboard('board', ['(gr_line (start 0 0) (end 1 1))'])
    expect(forFootprint.value?.kind).toBe('board')
  })

  test('withholds it from an editor that must refuse it', () => {
    const forSchematic = usePasteable('schematic')
    setClipboard('board', ['(gr_line (start 0 0) (end 1 1))'])
    expect(forSchematic.value).toBeNull()
  })

  test('is reactive, so Paste can gray itself out', () => {
    const forBoard = usePasteable('board')
    expect(forBoard.value).toBeNull()
    setClipboard('board', ['(via (at 1 2))'])
    expect(forBoard.value).not.toBeNull()
    __resetClipboard()
    expect(forBoard.value).toBeNull()
  })
})
