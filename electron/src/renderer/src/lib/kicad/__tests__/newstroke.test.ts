import { describe, expect, it, test } from 'vitest'
import {
  parseGlyph,
  getTextStrokes,
  strokeOptionsFromTextEffects,
  textBoxCorners,
  effectiveTextThickness,
  KICAD_DEFAULT_LINE_WIDTH,
  type StrokeSegment,
  type TextStrokeOptions
} from '../newstroke'
import { mmToNm } from '../coordinates'

describe('NewStroke Font Parser and Layout Engine', () => {
  test('parseGlyph parses space character JZ correctly', () => {
    const glyph = parseGlyph('JZ')
    expect(glyph.width).toBeCloseTo(16 / 21)
    expect(glyph.strokes.length).toBe(0)
  })

  test('parseGlyph parses double quote JZNFNJ RVFVJ correctly', () => {
    const glyph = parseGlyph('JZNFNJ RVFVJ')
    // Left: J (74 - 82 = -8) * 1/21
    // Right: Z (90 - 82 = 8) * 1/21
    expect(glyph.width).toBeCloseTo(16 / 21)
    expect(glyph.strokes.length).toBe(2)

    // Stroke 1: NF to NJ
    // N (78 - 82 = -4) -> shifted by startX (-8) = +4/21
    // F (70 - 82 = -12) -> offset -8 = -20/21
    // J (74 - 82 = -8) -> offset -8 = -16/21
    const s1 = glyph.strokes[0]
    expect(s1.length).toBe(2)
    expect(s1[0].x).toBeCloseTo(4 / 21)
    expect(s1[0].y).toBeCloseTo(-20 / 21)
    expect(s1[1].x).toBeCloseTo(4 / 21)
    expect(s1[1].y).toBeCloseTo(-16 / 21)

    // Stroke 2: VF to VJ
    // V (86 - 82 = 4) -> shifted = +12/21
    const s2 = glyph.strokes[1]
    expect(s2.length).toBe(2)
    expect(s2[0].x).toBeCloseTo(12 / 21)
    expect(s2[0].y).toBeCloseTo(-20 / 21)
    expect(s2[1].x).toBeCloseTo(12 / 21)
    expect(s2[1].y).toBeCloseTo(-16 / 21)
  })

  test('getTextStrokes layouts text and centers correctly', () => {
    const { strokes, totalWidth } = getTextStrokes('1', {
      width: 1.0,
      height: 1.0,
      thickness: 0.15
    })

    expect(totalWidth).toBeGreaterThan(0)
    expect(strokes.length).toBeGreaterThan(0)

    // Check that points are roughly centered horizontally (average X close to 0)
    let sumX = 0
    let count = 0
    for (const seg of strokes) {
      sumX += seg.x1 + seg.x2
      count += 2
    }
    const avgX = sumX / count
    expect(Math.abs(avgX)).toBeLessThan(0.3)
  })

  test('a final newline adds no line, as KiCad splits text', () => {
    const options = { width: 1.0, height: 1.0, thickness: 0.15 }
    expect(getTextStrokes('AB\n', options)).toEqual(getTextStrokes('AB', options))
    expect(getTextStrokes('AB\n\n', options).totalHeight).toBeGreaterThan(
      getTextStrokes('AB', options).totalHeight
    )
  })

  test('getTextStrokes supports italic option', () => {
    const normal = getTextStrokes('A', {
      width: 1.0,
      height: 1.0,
      thickness: 0.15
    })

    const italic = getTextStrokes('A', {
      width: 1.0,
      height: 1.0,
      thickness: 0.15,
      italic: true
    })

    expect(italic.strokes.length).toBe(normal.strokes.length)
    // Italic text should have slanted X-coordinates
    expect(italic.strokes[0].x1).not.toBeCloseTo(normal.strokes[0].x1)
  })

  test('getTextStrokes supports mirror option', () => {
    const normal = getTextStrokes('E', {
      width: 1.0,
      height: 1.0,
      thickness: 0.15
    })

    const mirrored = getTextStrokes('E', {
      width: 1.0,
      height: 1.0,
      thickness: 0.15,
      mirror: true
    })

    expect(mirrored.strokes.length).toBe(normal.strokes.length)
    // The X coordinates should be flipped
    expect(mirrored.strokes[0].x1).toBeCloseTo(-normal.strokes[0].x1)
  })

  test('anchors left and right justified text on opposite edges', () => {
    const left = getTextStrokes('NET', {
      width: 1.27,
      height: 1.27,
      thickness: 0.15,
      horizontalAlign: 'left'
    })
    const right = getTextStrokes('NET', {
      width: 1.27,
      height: 1.27,
      thickness: 0.15,
      horizontalAlign: 'right'
    })

    // Not exactly 0: KiCad insets the justified edge by `strokeWidth / 1.52`
    // for stroke fonts (`font.cpp`), so the glyphs clear the anchor by half a
    // pen. The edges still sit on opposite sides of it, which is what this is
    // about.
    const fudge = 0.15 / 1.52
    expect(left.bounds.minX).toBeCloseTo(fudge, 6)
    expect(left.bounds.maxX).toBeGreaterThan(0)
    expect(right.bounds.maxX).toBeCloseTo(-fudge, 6)
    expect(right.bounds.minX).toBeLessThan(0)
  })

  test('lays out multiline text using the configured line spacing', () => {
    const compact = getTextStrokes('USB-C\nport', {
      width: 1.27,
      height: 1.27,
      thickness: 0.15,
      lineSpacing: 1
    })
    const loose = getTextStrokes('USB-C\nport', {
      width: 1.27,
      height: 1.27,
      thickness: 0.15,
      lineSpacing: 1.5
    })

    expect(compact.totalHeight).toBeGreaterThan(1.27)
    expect(loose.totalHeight).toBeGreaterThan(compact.totalHeight)
    expect(compact.strokes.length).toBeGreaterThan(0)
  })

  test('uses NewStroke Unicode glyphs for common schematic units', () => {
    const layout = getTextStrokes('10µF 5.1kΩ', {
      width: 1.27,
      height: 1.27,
      thickness: 0.15
    })
    expect(layout.totalWidth).toBeGreaterThan(0)
    expect(layout.strokes.length).toBeGreaterThan(20)
  })
})

describe('textBoxCorners', () => {
  // Effects and anchors are domain nanometers; the corners come back in nm too.
  const effects = { fontSize: { height: mmToNm(1.27), width: mmToNm(1.27) } }

  test('covers the glyphs, not just the anchor', () => {
    // The regression this exists for: hit-testing a text by distance to its
    // anchor made it unclickable, because the engine's tolerance is ~10 screen
    // pixels — a fraction of a millimeter — while the glyphs run millimeters out.
    const corners = textBoxCorners('Text', effects, { x: 0, y: 0 }, 0)
    const xs = corners.map((c) => c.x)
    const ys = corners.map((c) => c.y)
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(mmToNm(2))
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(mmToNm(1.27), 0)
    // Centerd by default, so the anchor sits inside rather than at a corner.
    expect(Math.min(...xs)).toBeLessThan(0)
    expect(Math.max(...xs)).toBeGreaterThan(0)
  })

  test('lays the box out where the strokes are, within the em box', () => {
    // Both come off one layout, and this is what says so. Horizontally the box is
    // exact. Vertically it is KiCad's nominal **em** box, not the ink extent — a
    // capital's ink overshoots it by about a tenth of the font size, and the
    // descender space below the baseline goes unused — so the tolerance here
    // states that rather than pretending the two agree. It is well inside the
    // engine's own 10-pixel click tolerance, so it costs nothing in practice.
    const layout = getTextStrokes('Wg', strokeOptionsFromTextEffects(effects))
    const corners = textBoxCorners('Wg', effects, { x: 0, y: 0 }, 0)
    const minX = Math.min(...corners.map((c) => c.x))
    const maxX = Math.max(...corners.map((c) => c.x))
    const minY = Math.min(...corners.map((c) => c.y))
    const maxY = Math.max(...corners.map((c) => c.y))
    const slack = effects.fontSize.height / 3
    // Strokes lay out in mm; the corner box is nm — scale each point up
    // (unrounded, so the comparison inherits no half-nm rounding slop).
    for (const s of layout.strokes) {
      for (const [x, y] of [
        [s.x1 * 1e6, s.y1 * 1e6],
        [s.x2 * 1e6, s.y2 * 1e6]
      ]) {
        expect(x).toBeGreaterThanOrEqual(minX - 1)
        expect(x).toBeLessThanOrEqual(maxX + 1)
        expect(y).toBeGreaterThanOrEqual(minY - slack)
        expect(y).toBeLessThanOrEqual(maxY + slack)
      }
    }
  })

  test('rotates the box with the text, and moves it with the anchor', () => {
    const flat = textBoxCorners('Text', effects, { x: 0, y: 0 }, 0)
    const turned = textBoxCorners('Text', effects, { x: 0, y: 0 }, 90)
    const spanX = (pts: Array<{ x: number; y: number }>): number =>
      Math.max(...pts.map((p) => p.x)) - Math.min(...pts.map((p) => p.x))
    const spanY = (pts: Array<{ x: number; y: number }>): number =>
      Math.max(...pts.map((p) => p.y)) - Math.min(...pts.map((p) => p.y))
    // A quarter turn swaps the extents — corners, not an axis-aligned box, is
    // what makes that expressible.
    expect(spanX(turned)).toBeCloseTo(spanY(flat), 6)
    expect(spanY(turned)).toBeCloseTo(spanX(flat), 6)

    const moved = textBoxCorners('Text', effects, { x: mmToNm(5), y: mmToNm(-3) }, 0)
    expect(moved.map((c) => c.x)).toEqual(flat.map((c) => c.x + mmToNm(5)))
    expect(moved.map((c) => c.y)).toEqual(flat.map((c) => c.y - mmToNm(3)))
  })

  test('derives the thickness KiCad implies when the file omits it', () => {
    // Eeschema's rules (see effectiveTextThickness): the flat 6-mil default
    // pen for regular weight, width/5 for bold.
    expect(strokeOptionsFromTextEffects(effects).thickness).toBeCloseTo(0.1524, 6)
    expect(strokeOptionsFromTextEffects({ ...effects, bold: true }).thickness).toBeCloseTo(0.254, 6)
    // An explicit thickness wins, or a file's own stroke weight would be ignored.
    expect(strokeOptionsFromTextEffects({ ...effects, thickness: mmToNm(0.3) }).thickness).toBe(0.3)
  })
})

describe('KiCad text layout parity', () => {
  // Ground truth measured from KiCad 10 by plotting a symbol whose text sits on a
  // circle centered at the anchor (so the anchor is exact in the SVG) and reading
  // the glyph box back. The model is derived from `common/font/font.cpp`
  // (`getLinePositions`) + `stroke_font.cpp`, not fitted to these numbers — they
  // are the check, not the source.
  //
  // A capital's box runs 20/21 of an em above the font origin and 1/21 below.
  const H = 1.27
  const opts = (verticalAlign: 'top' | 'center' | 'bottom'): TextStrokeOptions => ({
    width: H,
    height: H,
    // KiCad's vertical fudge is `strokeWidth * 0.052`; this is the value solved
    // from its own output, and it moves the result by under 0.01 mm.
    thickness: 0.1554,
    horizontalAlign: 'center',
    verticalAlign
  })
  /** Cap box in KiCad's y-DOWN sign, relative to the anchor. */
  const capBox = (verticalAlign: 'top' | 'center' | 'bottom'): { top: number; bottom: number } => {
    const { strokes } = getTextStrokes('HXHX', opts(verticalAlign))
    let lo = Infinity
    let hi = -Infinity
    for (const s of strokes) {
      lo = Math.min(lo, s.y1, s.y2)
      hi = Math.max(hi, s.y1, s.y2)
    }
    return { top: -hi, bottom: -lo }
  }

  it('matches KiCad for top-justified text', () => {
    const { top, bottom } = capBox('top')
    expect(top).toBeCloseTo(0.0524, 3)
    expect(bottom).toBeCloseTo(1.3224, 3)
  })

  it('matches KiCad for center-justified text', () => {
    const { top, bottom } = capBox('center')
    expect(top).toBeCloseTo(-0.6905, 3)
    expect(bottom).toBeCloseTo(0.5795, 3)
  })

  it('matches KiCad for bottom-justified text', () => {
    const { top, bottom } = capBox('bottom')
    expect(top).toBeCloseTo(-1.4335, 3)
    expect(bottom).toBeCloseTo(-0.1635, 3)
  })

  it('renders capitals exactly one em tall', () => {
    const { top, bottom } = capBox('center')
    expect(bottom - top).toBeCloseTo(H, 6)
  })

  it('advances lines by 1.610 x size, not 1.5', () => {
    // `INTERLINE_PITCH (1.68) * STROKE_LEGACY_FACTOR (0.9583)`. The old 1.5 set
    // wrapped text ~7% tight, which only shows on multi-line strings — i.e. on
    // every wrapped text_box.
    const one = capBox('top')
    const { strokes } = getTextStrokes('HXHX\nHXHX', opts('top'))
    let lo = Infinity
    for (const s of strokes) lo = Math.min(lo, s.y1, s.y2)
    expect(-lo - one.bottom).toBeCloseTo(H * 1.68 * 0.9583, 4)
  })

  it('separates center and bottom justification by 0.585 x size', () => {
    // Not academic: pin numbers are positioned by an offset KiCad measures to the
    // text's CENTER, and drawing them bottom-justified lifted every one by
    // exactly this gap — ~29 mil at a 1.27 mm font, which is what the ecc83-pp
    // audit caught. Anything anchored by a center offset must be center-aligned.
    const center = capBox('center')
    const bottom = capBox('bottom')
    expect(center.top - bottom.top).toBeCloseTo(H * 1.17 * 0.5, 4)
    expect(H * 1.17 * 0.5).toBeCloseTo(0.743, 4)
  })

  it('offsets the justified edge by the stroke fudge, and not when centered', () => {
    // `offset.x += strokeWidth / 1.52` for left, subtracted for right, discarded
    // when centring (`font.cpp`).
    const left = getTextStrokes('H', { ...opts('center'), horizontalAlign: 'left' })
    expect(left.bounds.minX).toBeCloseTo(0.1554 / 1.52, 6)
    const centered = getTextStrokes('H', opts('center'))
    expect(centered.bounds.minX).toBeCloseTo(-centered.totalWidth / 2, 6)
  })
})

describe('effectiveTextThickness — KiCad GetEffectiveTextPenWidth parity', () => {
  // Each rule mirrors eda_text.cpp / gr_text.cpp; the schematic surface passes
  // eeschema's default line width, the board surface passes none.
  const SCH = KICAD_DEFAULT_LINE_WIDTH

  it('non-bold schematic text is a FLAT 6 mil at any size', () => {
    // The old proportional 0.1 x height drew default text 17% thinner than
    // KiCad and large text far heavier; the flat default pen is the fix.
    expect(effectiveTextThickness({ width: 1.27, height: 1.27, defaultPenWidth: SCH })).toBeCloseTo(
      0.1524,
      6
    )
    expect(effectiveTextThickness({ width: 5.08, height: 5.08, defaultPenWidth: SCH })).toBeCloseTo(
      0.1524,
      6
    )
  })

  it('clamps tiny text to a quarter of its smaller axis', () => {
    expect(effectiveTextThickness({ width: 0.5, height: 0.5, defaultPenWidth: SCH })).toBeCloseTo(
      0.125,
      6
    )
    // Clamp keys off min(width, height), not either axis alone.
    expect(
      effectiveTextThickness({ width: 2, height: 1, thickness: 0.5, defaultPenWidth: SCH })
    ).toBeCloseTo(0.25, 6)
  })

  it('bold autos to width/5 and beats the default pen', () => {
    expect(
      effectiveTextThickness({ width: 1.27, height: 1.27, bold: true, defaultPenWidth: SCH })
    ).toBeCloseTo(0.254, 6)
    // The RATIO keys off width (KiCad's GetPenSizeForBold(GetTextWidth())).
    expect(
      effectiveTextThickness({ width: 1, height: 2, bold: true, defaultPenWidth: SCH })
    ).toBeCloseTo(0.2, 6)
  })

  it('an authored thickness wins over bold, but is still clamped', () => {
    expect(
      effectiveTextThickness({
        width: 1.27,
        height: 1.27,
        thickness: 0.2,
        bold: true,
        defaultPenWidth: SCH
      })
    ).toBeCloseTo(0.2, 6)
    expect(
      effectiveTextThickness({ width: 1, height: 1, thickness: 0.5, defaultPenWidth: SCH })
    ).toBeCloseTo(0.25, 6)
  })

  it('an authored zero means auto, as KiCad encodes it', () => {
    // The UI's "auto" checkbox writes thickness 0 (eda_text.cpp SetTextThickness).
    expect(
      effectiveTextThickness({ width: 1.27, height: 1.27, thickness: 0, defaultPenWidth: SCH })
    ).toBeCloseTo(0.1524, 6)
  })

  it('board text with no default pen autos to width/8', () => {
    expect(effectiveTextThickness({ width: 1, height: 1 })).toBeCloseTo(0.125, 6)
  })
})

describe('KiCad text markup in the stroke layout', () => {
  // Top-justified with no pen width puts the line origin exactly one em below
  // the anchor, so a glyph's y is `-(glyphY + baselineShift) - 1`.
  const plain: TextStrokeOptions = {
    width: 1,
    height: 1,
    thickness: 0,
    horizontalAlign: 'left',
    verticalAlign: 'top'
  }
  const horizontalSegments = (text: string): StrokeSegment[] =>
    getTextStrokes(text, plain).strokes.filter((s) => Math.abs(s.y1 - s.y2) < 1e-9)

  it('an overbar draws the letters as if unmarked, plus one bar above them', () => {
    const bare = getTextStrokes('INT', plain)
    const barred = getTextStrokes('~{INT}', plain)
    expect(barred.totalWidth).toBeCloseTo(bare.totalWidth, 9)
    expect(barred.strokes.length).toBe(bare.strokes.length + 1)
    expect(barred.strokes.slice(0, bare.strokes.length)).toEqual(bare.strokes)
    const bar = barred.strokes[barred.strokes.length - 1]
    // 1.23 em above the baseline, which top justification puts at y = -1.
    expect(bar.y1).toBeCloseTo(1.23 - 1, 9)
    expect(bar.y2).toBeCloseTo(1.23 - 1, 9)
    // Trimmed a tenth of the width at each end; the left fudge is 0 at pen 0.
    expect(bar.x1).toBeCloseTo(0.1, 9)
    expect(bar.x2).toBeCloseTo(bare.totalWidth - 0.1, 9)
    // Above every letter.
    for (const s of bare.strokes) expect(Math.max(s.y1, s.y2)).toBeLessThan(bar.y1)
  })

  it('the bar spans a nested run and sits at the unshrunk height', () => {
    const inner = getTextStrokes('A_{0}', plain)
    const barred = getTextStrokes('~{A_{0}}', plain)
    const bar = barred.strokes[barred.strokes.length - 1]
    expect(bar.y1).toBeCloseTo(0.23, 9)
    expect(bar.x2).toBeCloseTo(inner.totalWidth - 0.1, 9)
  })

  it('a superscript is 0.8 x size, raised by 0.35 of its own height', () => {
    const bare = getTextStrokes('A2', plain)
    const scripted = getTextStrokes('A^{2}', plain)
    const aStrokes = getTextStrokes('A', plain).strokes.length
    expect(scripted.totalWidth).toBeCloseTo(
      getTextStrokes('A', plain).totalWidth + 0.8 * getTextStrokes('2', plain).totalWidth,
      9
    )
    const two = bare.strokes.slice(aStrokes)
    const twoScripted = scripted.strokes.slice(aStrokes)
    expect(twoScripted.length).toBe(two.length)
    for (let i = 0; i < two.length; i++) {
      // y_plain = -glyphY - 1  →  glyphY = -(y_plain + 1)
      // y_super = -(0.8 glyphY - 0.35 * 0.8) - 1
      const expectY = (y: number): number => 0.8 * (y + 1) + 0.35 * 0.8 - 1
      expect(twoScripted[i].y1).toBeCloseTo(expectY(two[i].y1), 9)
      expect(twoScripted[i].y2).toBeCloseTo(expectY(two[i].y2), 9)
    }
  })

  it('a subscript is 0.8 x size, dropped by 0.15 of its own height', () => {
    const bare = getTextStrokes('A2', plain)
    const scripted = getTextStrokes('A_{2}', plain)
    const aStrokes = getTextStrokes('A', plain).strokes.length
    const two = bare.strokes.slice(aStrokes)
    const twoScripted = scripted.strokes.slice(aStrokes)
    for (let i = 0; i < two.length; i++) {
      const expectY = (y: number): number => 0.8 * (y + 1) - 0.15 * 0.8 - 1
      expect(twoScripted[i].y1).toBeCloseTo(expectY(two[i].y1), 9)
    }
  })

  it('a subscript inside a superscript shrinks once and takes the subscript offset', () => {
    const once = getTextStrokes('_{2}', plain)
    const nested = getTextStrokes('^{_{2}}', plain)
    expect(nested.strokes).toEqual(once.strokes)
  })

  it('an unterminated group draws its opener as glyphs', () => {
    const literal = getTextStrokes('~{X', plain)
    expect(literal.totalWidth).toBeCloseTo(
      getTextStrokes('~', plain).totalWidth + getTextStrokes('{X', plain).totalWidth,
      9
    )
    expect(horizontalSegments('~{X').length).toBeGreaterThan(0)
  })

  it('resolves file escapes before measuring, and a {return} is a line break', () => {
    expect(getTextStrokes('A{slash}B', plain).totalWidth).toBeCloseTo(
      getTextStrokes('A/B', plain).totalWidth,
      9
    )
    expect(getTextStrokes('A{return}B', plain).totalHeight).toBeCloseTo(
      getTextStrokes('A\nB', plain).totalHeight,
      9
    )
  })
})
