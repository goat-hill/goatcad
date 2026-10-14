// Layout rules for `(text_box …)` — a bordered, optionally filled box with text
// laid out inside it.
//
// Pure and shared, for the reason `bezierCurvePoints` is: the renderer draws
// from this and the hit-test measures from it, so what you click is what you
// see. A second copy of the wrap rule would be a text you can read but cannot
// select, or a border that haloes somewhere the box is not.
//
// **Every rule here was verified against KiCad 10.0.5**, by exporting
// single-variable probe symbols with `kicad-cli sym export svg` and measuring
// where the glyph strokes actually landed. That matters more than usual: the
// grammar is undocumented in `references/kicad-format-spec.md` AND in upstream
// dev-docs, so KiCad's own output is the only authority. What the probes said:
//
//   - `(at x y angle)` is the box's TOP-LEFT corner, and `(size w h)` its extent
//     with **h negative** (KiCad writes `(size 7.62 -7.62)`), i.e. downward in
//     y-up symbol space. The border draws from the stroke; `(fill (type
//     background))` fills it.
//   - `(margins l t r b)` is **left, top, right, bottom** — each probed on its
//     own: `5 0 0 0` under left-justify moved the text right by exactly 5,
//     `0 5 0 0` under top-justify moved it down by 5, and so on for r/b.
//   - **The default justification is center/center**, and centered text IGNORES
//     the margins — it centers on the full box, not the inner rect. Only the
//     left/right/top/bottom cases inset by their margin.
//   - **The margins always set the wrap width** (`|w| - left - right`), centered
//     or not. This is the one place a margin affects centered text.
//   - Wrapping breaks **at spaces only**: a single word wider than the box
//     overflows it rather than breaking mid-word.
//   - The angle is in **DEGREES**, unlike a symbol `(text …)`, which KiCad
//     stores in decidegrees. Same-looking `(at x y a)` node, different unit —
//     see `parseGraphic`, which divides one and not the other.
//
// Not verified, and deliberately not guessed at: where KiCad anchors the text
// block of a ROTATED box. Rotation here turns the box and its text about `at`,
// which is the natural reading and exactly right at angle 0 — 17 of the 18
// instances in the standard library. See the workstream log.

import { getTextStrokes, measureTextWidth, type TextStrokeOptions } from '../kicad/newstroke'
import type { HorizontalTextAlign, VerticalTextAlign } from '../kicad/newstroke'
import { mmToNm, NM_PER_MM } from '../kicad/coordinates'

/**
 * An unbranded point. Frame geometry (position, size, margins, corners,
 * anchors) carries integer-nanometer values; only glyph measurement
 * (`wrapTextBoxLines`, `textBoxTextBounds`) speaks millimeters.
 */
export interface Point2 {
  x: number
  y: number
}

/** The geometric half of a `text_box`, independent of how the text is styled. */
export interface TextBoxFrame {
  /** Top-left corner, and the pivot the box turns about. */
  position: Point2 & { angle: number }
  /** Extent from `position`; `height` is negative for KiCad's downward boxes. */
  size: { width: number; height: number }
  margins: { left: number; top: number; right: number; bottom: number }
}

/**
 * The margin KiCad applies when the `(margins …)` node is absent: **1.016 mm**
 * (40 mil). Measured, not assumed — a probe box with no margins node put its
 * left/top-justified text exactly 1.016 further in than the same box with
 * `(margins 0 0 0 0)`. It is also what the standard library writes explicitly.
 */
export const DEFAULT_TEXT_BOX_MARGIN = 1.016

/** The same default as integer nanometers, for the nm domain model's parse fallback. */
export const DEFAULT_TEXT_BOX_MARGIN_NM = mmToNm(DEFAULT_TEXT_BOX_MARGIN)

export const DEFAULT_TEXT_BOX_MARGINS = {
  left: DEFAULT_TEXT_BOX_MARGIN,
  top: DEFAULT_TEXT_BOX_MARGIN,
  right: DEFAULT_TEXT_BOX_MARGIN,
  bottom: DEFAULT_TEXT_BOX_MARGIN
}

/**
 * The box's edges in local (unrotated) space, normalized so `left < right` and
 * `bottom < top` whichever sign the file's `size` carries. KiCad writes a
 * negative height; a hand-edited file may not, and a box that renders inside-out
 * would be a silly way to fail.
 */
export function textBoxEdges(frame: TextBoxFrame): {
  left: number
  right: number
  top: number
  bottom: number
} {
  const { position, size } = frame
  const x2 = position.x + size.width
  const y2 = position.y + size.height
  return {
    left: Math.min(position.x, x2),
    right: Math.max(position.x, x2),
    top: Math.max(position.y, y2),
    bottom: Math.min(position.y, y2)
  }
}

/** Rotate a local point about the box's `at`, the pivot KiCad's angle turns on. */
const place = (frame: TextBoxFrame, p: Point2): Point2 => {
  const angle = (frame.position.angle * Math.PI) / 180
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const dx = p.x - frame.position.x
  const dy = p.y - frame.position.y
  return {
    x: frame.position.x + dx * cos - dy * sin,
    y: frame.position.y + dx * sin + dy * cos
  }
}

/**
 * The four corners of the border, in world space and in winding order — what the
 * renderer strokes and what a click is tested against. Corners rather than an
 * axis-aligned box because a rotated box is not axis-aligned.
 */
export function textBoxCornerPoints(frame: TextBoxFrame): Point2[] {
  const { left, right, top, bottom } = textBoxEdges(frame)
  return [
    { x: left, y: top },
    { x: right, y: top },
    { x: right, y: bottom },
    { x: left, y: bottom }
  ].map((corner) => place(frame, corner))
}

/**
 * Break `text` to fit `maxWidth`, honoring explicit newlines as hard breaks.
 *
 * Empty paragraphs survive as empty lines — the standard library leans on that
 * (`"\n\n\nCONTROL LOGIC"` positions its label by three blank lines), so
 * collapsing them would move real text.
 *
 * A word too wide to fit anywhere is emitted on its own line and allowed to
 * overflow, which is what KiCad does: probing a 30-character unbroken run gave a
 * single line 32 mm wide in a 20 mm box rather than a mid-word break.
 */
export function wrapTextBoxLines(
  text: string,
  maxWidth: number,
  options: TextStrokeOptions
): string[] {
  const paragraphs = text.split('\n')
  // A non-positive inner width says the margins have eaten the box; wrapping to
  // it would put one character per line. Hard breaks still apply.
  if (!(maxWidth > 0)) return paragraphs
  const lines: string[] = []
  for (const paragraph of paragraphs) {
    const words = paragraph.split(' ').filter((w) => w !== '')
    if (words.length === 0) {
      lines.push('')
      continue
    }
    let current = ''
    for (const word of words) {
      const candidate = current === '' ? word : `${current} ${word}`
      if (current !== '' && measureTextWidth(candidate, options) > maxWidth) {
        lines.push(current)
        current = word
      } else {
        current = candidate
      }
    }
    lines.push(current)
  }
  return lines
}

/**
 * Where the wrapped text block anchors, in world space, plus the alignment
 * `getTextStrokes` should lay it out with around that anchor.
 *
 * The alignment is passed straight back out rather than folded into the point
 * because the two halves have to agree: `getTextStrokes` positions a block
 * relative to its anchor *according to* the alignment, so an anchor computed for
 * "left" and a layout run as "center" would sit half a block off.
 */
export function textBoxTextAnchor(
  frame: TextBoxFrame,
  hAlign: HorizontalTextAlign,
  vAlign: VerticalTextAlign
): { anchor: Point2; angle: number } {
  const { left, right, top, bottom } = textBoxEdges(frame)
  const { margins } = frame
  // Centered text ignores the margins and centers on the FULL box — probed, and
  // the one asymmetry in these rules worth stating rather than inferring.
  const x =
    hAlign === 'left'
      ? left + margins.left
      : hAlign === 'right'
        ? right - margins.right
        : (left + right) / 2
  const y =
    vAlign === 'top'
      ? top - margins.top
      : vAlign === 'bottom'
        ? bottom + margins.bottom
        : (top + bottom) / 2
  return { anchor: place(frame, { x, y }), angle: frame.position.angle }
}

/** The width wrapping fits to: the box less its left and right margins. */
export function textBoxWrapWidth(frame: TextBoxFrame): number {
  const { left, right } = textBoxEdges(frame)
  return right - left - frame.margins.left - frame.margins.right
}

/**
 * Everything needed to draw or hit-test one box: its border and the text as it
 * will actually be laid out. One call so a caller cannot take the border from
 * here and the wrap from somewhere else.
 */
export function textBoxLayout(
  frame: TextBoxFrame,
  text: string,
  options: TextStrokeOptions
): {
  corners: Point2[]
  lines: string[]
  text: string
  anchor: Point2
  angle: number
} {
  // The frame is domain nanometers but glyphs measure in millimeters, so the
  // wrap width crosses units here — the one place wrapping meets the box.
  const lines = wrapTextBoxLines(text, textBoxWrapWidth(frame) / NM_PER_MM, options)
  const { anchor, angle } = textBoxTextAnchor(
    frame,
    options.horizontalAlign ?? 'center',
    options.verticalAlign ?? 'center'
  )
  return { corners: textBoxCornerPoints(frame), lines, text: lines.join('\n'), anchor, angle }
}

/**
 * The glyph block's own extent, for callers that need to know how far the text
 * reaches rather than where the box is — a box whose text overflows still has to
 * report honest bounds.
 */
export function textBoxTextBounds(
  frame: TextBoxFrame,
  text: string,
  options: TextStrokeOptions
): { width: number; height: number } {
  const laid = textBoxLayout(frame, text, options)
  const { totalWidth, totalHeight } = getTextStrokes(laid.text, options)
  return { width: totalWidth, height: totalHeight }
}
