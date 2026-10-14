import { describe, expect, it, test } from 'vitest'
import {
  pinTextOrientation,
  schematicFieldDrawn,
  schematicFieldTextAngle,
  schematicLabelDirection,
  schematicTextAngle,
  symbolBodyTextAngle,
  symbolFieldTextAngle,
  transformedTextAngle
} from '../schematicTextOrientation'

describe('schematic text orientation', () => {
  test('keeps sheet text upright the way KiCad does: 0 or 90, reading up, never down', () => {
    // KeepUpright: 90 and 270 both read bottom-to-top; the justification, not
    // the angle, decides which side of the anchor the text lands on. Verified
    // against kicad-cli output of a sheet whose 90° labels read upward.
    expect(schematicTextAngle(0)).toBe(0)
    expect(schematicTextAngle(90)).toBe(90)
    expect(schematicTextAngle(180)).toBe(0)
    expect(schematicTextAngle(270)).toBe(90)
    expect(schematicTextAngle(-90)).toBe(90)
    expect(schematicTextAngle(45)).toBe(0)
    expect(schematicTextAngle(46)).toBe(90)
  })

  test('a label faces the way its raw angle says, for the arrow on a global label', () => {
    expect(schematicLabelDirection(0)).toBe(0)
    expect(schematicLabelDirection(90)).toBe(90)
    expect(schematicLabelDirection(270)).toBe(270)
    expect(schematicLabelDirection(-90)).toBe(270)
  })

  test('resolves placed symbol fields relative to the symbol orientation', () => {
    expect(schematicFieldTextAngle(90, 90)).toBe(0)
    expect(schematicFieldTextAngle(90, 270)).toBe(0)
    expect(schematicFieldTextAngle(0, 0)).toBe(0)
    expect(schematicFieldTextAngle(90, 0)).toBe(90)
  })

  test('keeps left- and right-facing pin names upright with matching alignment', () => {
    expect(pinTextOrientation({ x: 1, y: 0 })).toMatchObject({
      angle: 0,
      nameAlign: 'left',
      above: { x: 0, y: 1 }
    })
    expect(pinTextOrientation({ x: -1, y: 0 })).toMatchObject({
      angle: 0,
      nameAlign: 'right',
      above: { x: 0, y: 1 }
    })
  })

  test('uses a consistent number side for vertical pins', () => {
    const up = pinTextOrientation({ x: 0, y: 1 })
    const down = pinTextOrientation({ x: 0, y: -1 })
    expect(up.angle).toBe(90)
    expect(down.angle).toBe(90)
    expect(up.above.x).toBeCloseTo(-1)
    expect(down.above.x).toBeCloseTo(-1)
  })

  test('derives local text rotation after rotation and mirroring', () => {
    const rotated = transformedTextAngle(0, ({ x, y }) => ({ x: -y + 3, y: x + 4 }))
    expect(rotated).toBe(90)

    const mirrored = transformedTextAngle(0, ({ x, y }) => ({ x: -x + 3, y: y + 4 }))
    expect(Math.abs(mirrored)).toBe(180)
  })
})

describe('symbolFieldTextAngle', () => {
  // Library space is y-up like the renderer, so a symbol field's angle needs NO
  // sign flip — the bug was routing it through the sheet-space converter, which
  // negated it and rendered 90° fields reading top-to-bottom. Ground truth from
  // plotting probe symbols with `kicad-cli sym export svg`: KiCad renders 0 as
  // L→R, 90 as bottom→top, 180 as R→L, 270 as top→bottom.
  it('keeps a 90° field reading bottom-to-top, as KiCad plots it', () => {
    expect(symbolFieldTextAngle(90)).toBe(90)
  })

  it('agrees with sheet space on a 90° field, now that neither flips the sign', () => {
    // Both spaces read a 90° field bottom-to-top; the sheet-space negation this
    // test used to guard against was itself the bug.
    expect(symbolFieldTextAngle(90)).toBe(schematicFieldTextAngle(90, 0))
  })

  it('leaves horizontal fields alone', () => {
    expect(symbolFieldTextAngle(0)).toBe(0)
  })

  it('renders 270° top-to-bottom, matching KiCad', () => {
    expect(symbolFieldTextAngle(270)).toBe(-90)
  })

  it('straightens an upside-down 180° field rather than mirroring it', () => {
    // The one deliberate divergence: KiCad plots 180 reversed; a field authored
    // upside down is almost certainly a mistake, and reading it beats copying it.
    expect(symbolFieldTextAngle(180)).toBe(0)
  })
})

describe('symbolBodyTextAngle', () => {
  // Body text is not a field. Probed side by side with `kicad-cli sym export
  // svg`: a `(property …)` plots literally in all four quadrants (above), while
  // a `(text …)` is two-state — horizontal at 0, vertical at everything else.
  it('draws only angle 0 horizontally', () => {
    expect(symbolBodyTextAngle(0)).toBe(0)
    expect(symbolBodyTextAngle(360)).toBe(0)
  })

  it('draws every other angle as one vertical, bottom-to-top', () => {
    expect([90, 180, 270, 45, -90].map(symbolBodyTextAngle)).toEqual([90, 90, 90, 90, 90])
  })

  it('parts company with the field rule exactly where KiCad does', () => {
    // At 180 a field straightens to horizontal; a body text turns a quarter turn.
    expect(symbolBodyTextAngle(180)).not.toBe(symbolFieldTextAngle(180))
  })
})

describe('schematicFieldDrawn', () => {
  /**
   * `[field angle, symbol angle, mirror, drawn angle, drawn h, drawn v]` for a
   * field stored `justify left top`, read off `kicad-cli sch export svg`
   * (KiCad 10): which side of its anchor each field's strokes landed on, for
   * every turn and mirror of the symbol.
   */
  const KICAD: Array<[number, number, '' | 'x' | 'y', number, string, string]> = [
    [0, 0, '', 0, 'left', 'top'],
    [0, 0, 'x', 0, 'left', 'bottom'],
    [0, 0, 'y', 0, 'right', 'top'],
    [0, 90, '', 90, 'left', 'top'],
    [0, 90, 'x', 90, 'right', 'top'],
    [0, 90, 'y', 90, 'left', 'bottom'],
    [0, 180, '', 0, 'right', 'bottom'],
    [0, 180, 'x', 0, 'right', 'top'],
    [0, 180, 'y', 0, 'left', 'bottom'],
    [0, 270, '', 90, 'right', 'bottom'],
    [0, 270, 'x', 90, 'left', 'bottom'],
    [0, 270, 'y', 90, 'right', 'top'],
    [90, 0, '', 90, 'left', 'top'],
    [90, 0, 'x', 90, 'right', 'top'],
    [90, 0, 'y', 90, 'left', 'bottom'],
    [90, 90, '', 0, 'right', 'bottom'],
    [90, 90, 'x', 0, 'right', 'top'],
    [90, 90, 'y', 0, 'left', 'bottom'],
    [90, 180, '', 90, 'right', 'bottom'],
    [90, 180, 'x', 90, 'left', 'bottom'],
    [90, 180, 'y', 90, 'right', 'top'],
    [90, 270, '', 0, 'left', 'top'],
    [90, 270, 'x', 0, 'left', 'bottom'],
    [90, 270, 'y', 0, 'right', 'top']
  ]

  test.each(KICAD)(
    'field %i on a symbol at %i mirror "%s" draws at %i, %s %s',
    (fieldAngle, symbolAngle, mirror, angle, horizontal, vertical) => {
      const frame = { angle: symbolAngle, ...(mirror ? { mirror } : {}) }
      expect(schematicFieldDrawn(fieldAngle, 'left', 'top', frame)).toEqual({
        angle,
        horizontal,
        vertical
      })
    }
  )

  test('a centered field stays centered, whatever the frame', () => {
    for (const [fieldAngle, symbolAngle, mirror] of KICAD) {
      const frame = { angle: symbolAngle, ...(mirror ? { mirror } : {}) }
      const drawn = schematicFieldDrawn(fieldAngle, 'center', 'center', frame)
      expect([drawn.horizontal, drawn.vertical]).toEqual(['center', 'center'])
    }
  })

  test('a right-justified field of a quarter-turned symbol runs rightward', () => {
    expect(schematicFieldDrawn(90, 'right', 'center', { angle: 90 })).toEqual({
      angle: 0,
      horizontal: 'left',
      vertical: 'center'
    })
  })

  test('is its own inverse: the drawn justification maps back to the stored one', () => {
    for (const [fieldAngle, symbolAngle, mirror] of KICAD) {
      const frame = { angle: symbolAngle, ...(mirror ? { mirror } : {}) }
      const drawn = schematicFieldDrawn(fieldAngle, 'right', 'bottom', frame)
      const back = schematicFieldDrawn(fieldAngle, drawn.horizontal, drawn.vertical, frame)
      expect([back.horizontal, back.vertical]).toEqual(['right', 'bottom'])
    }
  })
})
