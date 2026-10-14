import { describe, expect, test } from 'vitest'
import {
  emptyProjectLocal,
  extractBoardLocalView,
  formatLayerMask,
  parseLayerMask,
  patchBoardLocalView,
  projectLocalPathFor
} from '../projectLocal'
import type { KicadBoardLayer } from '../board'

/** The ordinals a KiCad 9 board declares, trimmed to what these tests need. */
const LAYERS: KicadBoardLayer[] = [
  { ordinal: 0, name: 'F.Cu', type: 'signal' },
  { ordinal: 2, name: 'B.Cu', type: 'signal' },
  { ordinal: 5, name: 'F.SilkS', type: 'user' },
  { ordinal: 25, name: 'Edge.Cuts', type: 'user' },
  { ordinal: 35, name: 'F.Fab', type: 'user' }
]

describe('the visible-layer bitmask', () => {
  test('reads KiCad\u2019s all-visible default', () => {
    const mask = parseLayerMask('fffffff_ffffffff')
    expect(mask.bitCount).toBe(60)
    for (let bit = 0; bit < 60; bit++) expect(mask.visible.has(bit)).toBe(true)
  })

  test('places a bit where KiCad places it', () => {
    // Nibble 0 is the rightmost; bit 0 is its least significant bit.
    expect(parseLayerMask('1').visible).toEqual(new Set([0]))
    expect(parseLayerMask('8').visible).toEqual(new Set([3]))
    expect(parseLayerMask('10').visible).toEqual(new Set([4]))
  })

  test('round-trips through the formatter, separators and all', () => {
    const hex = 'ffffffff_ffffffff_ffffffff_ffffffff'
    const mask = parseLayerMask(hex)
    expect(formatLayerMask(mask.visible, mask.bitCount)).toBe(hex)
  })

  test('groups eight nibbles from the right, as FmtHex does', () => {
    expect(formatLayerMask(new Set([0]), 128)).toBe('00000000_00000000_00000000_00000001')
  })

  test('stops at the first byte that is not hex, like ParseHex', () => {
    expect(parseLayerMask('zz_3').visible).toEqual(new Set([0, 1]))
  })
})

describe('reading a .kicad_prl', () => {
  test('resolves ordinals against the board\u2019s own layer table', () => {
    const prl = JSON.stringify({
      board: { visible_layers: formatLayerMask(new Set([0, 2, 25]), 128), active_layer: 2 }
    })
    const view = extractBoardLocalView(prl, LAYERS)
    expect(view?.layerVisibility).toEqual({
      'F.Cu': true,
      'B.Cu': true,
      'F.SilkS': false,
      'Edge.Cuts': true,
      'F.Fab': false
    })
    expect(view?.activeLayer).toBe('B.Cu')
  })

  test('treats a layer the mask never reached as visible', () => {
    // A 16-bit mask from an older writer says nothing about ordinal 25 or 35.
    const prl = JSON.stringify({ board: { visible_layers: '0005' } })
    const view = extractBoardLocalView(prl, LAYERS)
    expect(view?.layerVisibility).toEqual({
      'F.Cu': true,
      'B.Cu': true,
      'F.SilkS': false,
      'Edge.Cuts': true,
      'F.Fab': true
    })
  })

  test('maps high_contrast_mode onto the inactive-layer cycle', () => {
    const mode = (value: number): string | undefined =>
      extractBoardLocalView(JSON.stringify({ board: { high_contrast_mode: value } }), LAYERS)
        ?.nonActiveDisplay
    expect(mode(0)).toBe('show')
    expect(mode(1)).toBe('dim')
    expect(mode(2)).toBe('hide')
  })

  test('reads the router’s Use starting track width, on where the file says nothing (R1)', () => {
    const read = (board: object): boolean | undefined =>
      extractBoardLocalView(JSON.stringify({ board }), LAYERS)?.autoTrackWidth
    expect(read({ auto_track_width: false })).toBe(false)
    expect(read({ auto_track_width: true })).toBe(true)
    expect(read({ high_contrast_mode: 1 })).toBe(true)
  })

  test('ignores an active layer the board has not got', () => {
    const prl = JSON.stringify({ board: { active_layer: 99 } })
    expect(extractBoardLocalView(prl, LAYERS)).toBeNull()
  })

  test('is null for junk, an empty file, or one with no board section', () => {
    expect(extractBoardLocalView('not json', LAYERS)).toBeNull()
    expect(extractBoardLocalView('{}', LAYERS)).toBeNull()
    expect(extractBoardLocalView(JSON.stringify({ board: {} }), LAYERS)).toBeNull()
  })
})

describe('writing a .kicad_prl', () => {
  const view = {
    layerVisibility: { 'F.Cu': true, 'B.Cu': false, 'F.SilkS': true, 'Edge.Cuts': true },
    activeLayer: 'F.SilkS',
    nonActiveDisplay: 'dim' as const,
    autoTrackWidth: false
  }

  test('leaves every sibling key alone', () => {
    const prl = JSON.stringify({
      board: { opacity: { zones: 0.6 }, visible_items: ['pads'] },
      meta: { filename: 'x.kicad_prl', version: 5 },
      schematic: { selection_filter: { lockedItems: false } }
    })
    const patched = patchBoardLocalView(prl, view, LAYERS)
    const root = JSON.parse(patched ?? '')
    expect(root.board.opacity).toEqual({ zones: 0.6 })
    expect(root.board.visible_items).toEqual(['pads'])
    expect(root.meta).toEqual({ filename: 'x.kicad_prl', version: 5 })
    expect(root.schematic).toEqual({ selection_filter: { lockedItems: false } })
  })

  test('writes the four keys we own', () => {
    const root = JSON.parse(patchBoardLocalView('{}', view, LAYERS) ?? '')
    expect(root.board.active_layer).toBe(5)
    expect(root.board.high_contrast_mode).toBe(1)
    expect(root.board.auto_track_width).toBe(false)
    expect(parseLayerMask(root.board.visible_layers).visible.has(2)).toBe(false)
  })

  test('keeps bits for layers the board does not declare', () => {
    // Ordinal 7 (B.SilkS on a board that has one) was hidden by whoever wrote
    // the file; this board's table does not mention it, so it must survive.
    const prl = JSON.stringify({
      board: { visible_layers: formatLayerMask(new Set([0, 2, 5, 25, 35]), 128) }
    })
    const patched = patchBoardLocalView(prl, view, LAYERS)
    const mask = parseLayerMask(JSON.parse(patched ?? '').board.visible_layers)
    expect(mask.visible.has(7)).toBe(false)
    expect(mask.visible.has(2)).toBe(false)
    expect(mask.visible.has(5)).toBe(true)
  })

  test('round-trips through the reader', () => {
    const patched = patchBoardLocalView('{}', view, LAYERS)
    const read = extractBoardLocalView(patched ?? '', LAYERS)
    expect(read?.activeLayer).toBe('F.SilkS')
    expect(read?.nonActiveDisplay).toBe('dim')
    expect(read?.autoTrackWidth).toBe(false)
    expect(read?.layerVisibility['B.Cu']).toBe(false)
    expect(read?.layerVisibility['F.Cu']).toBe(true)
  })

  test('refuses malformed input rather than clobbering it', () => {
    expect(patchBoardLocalView('not json', view, LAYERS)).toBeNull()
  })
})

describe('the file we create', () => {
  test('declares only the keys we own, at a version KiCad migrates as a no-op', () => {
    const root = JSON.parse(emptyProjectLocal('canary.kicad_prl'))
    expect(root).toEqual({
      board: {},
      meta: { filename: 'canary.kicad_prl', version: 1 },
      project: { files: [] }
    })
  })

  test('is named off the project stem, as KiCad names it', () => {
    expect(projectLocalPathFor('/w/canary.kicad_pro')).toBe('/w/canary.kicad_prl')
    expect(projectLocalPathFor('C:\\w\\canary.kicad_pro')).toBe('C:\\w\\canary.kicad_prl')
  })
})
