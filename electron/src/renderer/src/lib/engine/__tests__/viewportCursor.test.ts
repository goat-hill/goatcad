import { describe, expect, test } from 'vitest'
import { viewportCursor } from '../ViewportEngine'

// The pointer is how a canvas editor says which of its two modes it is in, and
// its absence is easy to miss — the CSS this replaced (a `cursor` rule on the
// container the inline-styled canvas covers) went dead in three editors the
// moment the engine wrote its first inline cursor, with nothing to say so.
// Cheap to pin, so pinned.
describe('viewportCursor', () => {
  test('crosshairs while an insert/draw tool is armed', () => {
    expect(viewportCursor({ panning: false, drawMode: true })).toBe('crosshair')
  })

  test('is the ordinary arrow in select mode', () => {
    expect(viewportCursor({ panning: false, drawMode: false })).toBe('default')
  })

  test('a tool with its own glyph keeps it', () => {
    // The router and the wire tool draw rather than place, so they pass a
    // pencil; everything else falls back to the pick crosshair.
    const pencil = 'url("data:image/svg+xml,…") 3 15, crosshair'
    expect(viewportCursor({ panning: false, drawMode: true, drawCursor: pencil })).toBe(pencil)
  })

  test('panning wins over the armed tool for as long as it lasts', () => {
    // Otherwise a middle-drag across the canvas with a tool held would keep
    // claiming you are about to place something — glyph or no glyph.
    expect(viewportCursor({ panning: true, drawMode: true })).toBe('grabbing')
    expect(viewportCursor({ panning: true, drawMode: false })).toBe('grabbing')
    expect(viewportCursor({ panning: true, drawMode: true, drawCursor: 'x' })).toBe('grabbing')
  })

  test('select mode ignores a leftover glyph', () => {
    // setDrawMode(false) need not clear the cursor to stop showing it.
    expect(viewportCursor({ panning: false, drawMode: false, drawCursor: 'x' })).toBe('default')
  })
})
