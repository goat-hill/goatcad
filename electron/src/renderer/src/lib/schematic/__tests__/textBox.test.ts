import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TEXT_BOX_MARGIN,
  textBoxCornerPoints,
  textBoxTextAnchor,
  textBoxWrapWidth,
  wrapTextBoxLines,
  type TextBoxFrame
} from '../textBox'
import { strokeOptionsFromTextEffects } from '../../kicad/newstroke'
import { mmToNm } from '../../kicad/coordinates'

// Every expectation here is a rule measured off KiCad 10.0.5, by exporting probe
// symbols with `kicad-cli sym export svg` and reading where the glyphs landed.
// The grammar is documented in neither our spec notes nor upstream dev-docs, so
// these tests are the record of what the real tool does — treat a failure as
// "we changed behaviour", not "the expectation is arbitrary".

const frame = (over: Partial<TextBoxFrame> = {}): TextBoxFrame => ({
  position: { x: 0, y: 0, angle: 0 },
  size: { width: 20, height: -20 },
  margins: { left: 0, top: 0, right: 0, bottom: 0 },
  ...over
})

// Effects carry domain nanometers; the layout options come back in mm.
const options = strokeOptionsFromTextEffects({
  fontSize: { height: mmToNm(1.27), width: mmToNm(1.27) }
})

describe('text box geometry', () => {
  it('reads (at) as the top-left corner and a negative height as downward', () => {
    // The corner KiCad's `at` names, and the extent its `size` reaches — the
    // whole basis of the primitive. A box drawn from (0,0) with size (20,-20)
    // occupies x 0..20 and y -20..0.
    expect(textBoxCornerPoints(frame())).toEqual([
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: -20 },
      { x: 0, y: -20 }
    ])
  })

  it('normalizes a box whose size runs the other way', () => {
    // KiCad always writes a negative height, but a hand-edited or third-party
    // file need not; an inside-out box would be a silly way to render nothing.
    const corners = textBoxCornerPoints(
      frame({ position: { x: 20, y: -20, angle: 0 }, size: { width: -20, height: 20 } })
    )
    expect(corners).toEqual(textBoxCornerPoints(frame()))
  })
})

describe('text box margins', () => {
  // Each side probed on its own against KiCad: the tuple is (left, top, right,
  // bottom), and the justification decides which two of them apply.
  it('insets a left/top-justified anchor by the left and top margins', () => {
    const { anchor } = textBoxTextAnchor(
      frame({ margins: { left: 5, top: 3, right: 0, bottom: 0 } }),
      'left',
      'top'
    )
    expect(anchor).toEqual({ x: 5, y: -3 })
  })

  it('insets a right/bottom-justified anchor by the right and bottom margins', () => {
    const { anchor } = textBoxTextAnchor(
      frame({ margins: { left: 0, top: 0, right: 5, bottom: 3 } }),
      'right',
      'bottom'
    )
    expect(anchor).toEqual({ x: 15, y: -17 })
  })

  it('IGNORES the margins when centered, centring on the full box', () => {
    // The one asymmetry in these rules, and the reason it is asserted rather
    // than assumed: a margin of 5 on the left does NOT push centered text right.
    const centered = textBoxTextAnchor(frame(), 'center', 'center').anchor
    const withMargins = textBoxTextAnchor(
      frame({ margins: { left: 5, top: 5, right: 0, bottom: 0 } }),
      'center',
      'center'
    ).anchor
    expect(withMargins).toEqual(centered)
    expect(centered).toEqual({ x: 10, y: -10 })
  })

  it('still narrows the WRAP width when centered', () => {
    // Margins always bound the line length, centered or not — the one thing they
    // do to centered text.
    expect(textBoxWrapWidth(frame())).toBe(20)
    expect(textBoxWrapWidth(frame({ margins: { left: 5, top: 0, right: 3, bottom: 0 } }))).toBe(12)
  })

  it('defaults an absent margins node to 40 mil', () => {
    expect(DEFAULT_TEXT_BOX_MARGIN).toBe(1.016)
  })
})

describe('text box wrapping', () => {
  it('breaks at spaces to fit the width', () => {
    const lines = wrapTextBoxLines('AAAA BBBB CCCC DDDD EEEE FFFF', 20, options)
    expect(lines.length).toBeGreaterThan(1)
    // Nothing may be lost or reordered by wrapping.
    expect(lines.join(' ').split(/\s+/)).toEqual(['AAAA', 'BBBB', 'CCCC', 'DDDD', 'EEEE', 'FFFF'])
  })

  it('lets a single over-long word overflow rather than breaking it', () => {
    // Probed: 30 unbroken characters came back as ONE 32 mm line in a 20 mm box.
    // Breaking mid-word would be the tidier picture and the wrong one.
    expect(wrapTextBoxLines('A'.repeat(30), 20, options)).toEqual(['A'.repeat(30)])
  })

  it('honors explicit newlines as hard breaks', () => {
    expect(wrapTextBoxLines('10V\nREF', 20, options)).toEqual(['10V', 'REF'])
  })

  it('keeps empty lines, which the standard library positions text with', () => {
    // `"\n\n\nCONTROL LOGIC"` in Analog_DAC relies on three blank lines to place
    // its label; collapsing them would move real text.
    expect(wrapTextBoxLines('\n\n\nCONTROL LOGIC', 40, options)).toEqual([
      '',
      '',
      '',
      'CONTROL LOGIC'
    ])
  })

  it('falls back to hard breaks alone when the margins have eaten the box', () => {
    // A non-positive inner width would otherwise wrap to one character per line.
    expect(wrapTextBoxLines('one two\nthree', 0, options)).toEqual(['one two', 'three'])
  })
})

describe('text box rotation', () => {
  it('turns the box about its (at) corner', () => {
    const corners = textBoxCornerPoints(
      frame({ position: { x: 0, y: 0, angle: 90 }, size: { width: 20, height: -4 } })
    )
    // A quarter turn CCW in y-up space: the corner that was at (20, 0) swings to
    // (0, 20), and the anchor itself does not move.
    expect(corners[0].x).toBeCloseTo(0)
    expect(corners[0].y).toBeCloseTo(0)
    expect(corners[1].x).toBeCloseTo(0)
    expect(corners[1].y).toBeCloseTo(20)
  })
})
