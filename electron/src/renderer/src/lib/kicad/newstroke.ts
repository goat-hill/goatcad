// Parts follow KiCad's source, named below: Copyright The KiCad Developers, GPL-3.0-or-later.
import newstrokeDict from './newstroke_font_dict.json'
import { NM_PER_MM, spacingToMm } from './coordinates'
import { parseTextMarkup, unescapeKicadText, type MarkupNode } from './textMarkup'

const STROKE_FONT_SCALE = 1.0 / 21.0
const FONT_OFFSET = -8

// ---------------------------------------------------------------------------
// KiCad's text layout model, derived from `common/font/font.cpp`
// (`FONT::getLinePositions`) and `common/font/stroke_font.cpp` rather than fitted
// to screenshots. Reproduces KiCad's own output to within 1e-4 mm on all three
// vertical justifications — the test pins those numbers.
//
// The model, in KiCad's y-DOWN space, relative to the text anchor:
//
//   interline = size * INTERLINE_PITCH * LEGACY_FACTOR * lineSpacing
//   height    = size * FIRST_LINE_HEIGHT + (lineCount - 1) * interline
//   originY   = size - strokeWidth * V_FUDGE - vAdjust + i * interline
//   vAdjust   = 0 | height/2 | height          for top | center | bottom
// ---------------------------------------------------------------------------

/** `KIFONT::METRICS::m_InterlinePitch` (`include/font/font_metrics.h`). */
const INTERLINE_PITCH = 1.68
/** `STROKE_FONT::GetInterline`'s "adjustment to match legacy spacing". */
const STROKE_LEGACY_FACTOR = 0.9583
/** Line advance for the stroke font: 1.610 x size. */
const STROKE_INTERLINE = INTERLINE_PITCH * STROKE_LEGACY_FACTOR
/** `height += size.y * 1.17` — KiCad's own comment calls it a 6.0-compat fudge. */
const FIRST_LINE_HEIGHT = 1.17
/** `offset.y -= strokeWidth * 0.052`, stroke fonts only. */
const STROKE_V_FUDGE = 0.052
/** `offset.x += strokeWidth / 1.52`, stroke fonts only — left/right justify. */
const STROKE_H_FUDGE_DIVISOR = 1.52

/**
 * Where a CAPITAL sits in glyph space, in `STROKE_FONT_SCALE` units either side
 * of the font origin: 20 units above, 1 below, so caps are exactly 21/21 = one
 * em tall. Used only to report `bounds` over the glyphs actually drawn; the
 * layout above never needs it.
 */
const GLYPH_CAP_TOP = 20 / 21
const GLYPH_CAP_BOTTOM = 1 / 21

// Markup, from `STROKE_FONT::drawSingleLineText` and `FONT::drawMarkup`. A
// super- or subscript run draws at 0.8 x size with its baseline moved by a
// fraction of THAT shrunk size; an overbar is one stroke at 1.23 x the
// unshrunk height above the baseline, trimmed a tenth of the width at each
// end so its round caps do not overhang the letters.
/** `SUPER_SUB_SIZE_MULTIPLIER`. */
const SCRIPT_SCALE = 0.8
/** `SUPER_HEIGHT_OFFSET`: superscripts rise by this much of their own height. */
const SUPERSCRIPT_RISE = 0.35
/** `SUB_HEIGHT_OFFSET`: subscripts drop by this much of their own height. */
const SUBSCRIPT_DROP = 0.15
/** `KIFONT::METRICS::m_OverbarHeight`. */
const OVERBAR_HEIGHT = 1.23
/** `barTrim = aSize.x * 0.1`. */
const OVERBAR_TRIM = 0.1

interface Point {
  x: number
  y: number
}

export interface StrokeSegment {
  x1: number
  y1: number
  x2: number
  y2: number
}

export type HorizontalTextAlign = 'left' | 'center' | 'right'
export type VerticalTextAlign = 'top' | 'center' | 'bottom'

export interface TextStrokeOptions {
  width: number
  height: number
  thickness: number
  italic?: boolean
  mirror?: boolean
  bold?: boolean
  horizontalAlign?: HorizontalTextAlign
  verticalAlign?: VerticalTextAlign
  lineSpacing?: number
}

export interface TextStrokeLayout {
  strokes: StrokeSegment[]
  totalWidth: number
  totalHeight: number
  bounds: { minX: number; minY: number; maxX: number; maxY: number }
}

/**
 * Parses a single KiCad Hershey-encoded font glyph string into strokes.
 * @param glyphStr The coordinate string from newstroke_font_dict
 */
export function parseGlyph(glyphStr: string): { width: number; strokes: Point[][] } {
  if (glyphStr.length < 2) {
    return { width: 0, strokes: [] }
  }

  // First two characters define glyphStartX and glyphEndX relative to 'R' (82)
  const startXVal = glyphStr.charCodeAt(0) - 82
  const endXVal = glyphStr.charCodeAt(1) - 82
  const glyphStartX = startXVal * STROKE_FONT_SCALE
  const glyphEndX = endXVal * STROKE_FONT_SCALE
  const width = glyphEndX - glyphStartX

  const strokes: Point[][] = []
  let currentStroke: Point[] = []

  for (let i = 2; i < glyphStr.length; i += 2) {
    if (i + 1 >= glyphStr.length) break
    const charX = glyphStr[i]
    const charY = glyphStr[i + 1]

    if (charX === ' ' && charY === 'R') {
      // Pen lift: start a new stroke
      if (currentStroke.length > 0) {
        strokes.push(currentStroke)
        currentStroke = []
      }
    } else {
      const valX = charX.charCodeAt(0) - 82
      const valY = charY.charCodeAt(0) - 82
      const x = valX * STROKE_FONT_SCALE - glyphStartX
      const y = (valY + FONT_OFFSET) * STROKE_FONT_SCALE
      currentStroke.push({ x, y })
    }
  }

  if (currentStroke.length > 0) {
    strokes.push(currentStroke)
  }

  return { width, strokes }
}

/**
 * Lays out a text string using KiCad's NewStroke vector font. Coordinates are
 * returned relative to the KiCad text anchor, with positive Y pointing up.
 */
/** KiCad's `ITALIC_TILT`: an eighth of the height across. */
const ITALIC_TILT = 1 / 8

export function getTextStrokes(text: string, options: TextStrokeOptions): TextStrokeLayout {
  const {
    width: fontWidth,
    height: fontHeight,
    thickness,
    italic = false,
    mirror = false,
    horizontalAlign = 'center',
    verticalAlign = 'center',
    lineSpacing = 1
  } = options
  // What KiCad shows, not what the file stores: escapes resolved first (a
  // `{return}` is a line break, so before the split), then each line's markup
  // parsed into the runs the walk below draws.
  const lines = unescapeKicadText(text).split('\n')
  // KiCad's `wxStringSplit` keeps no empty line after a final newline.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  const lineAdvance = fontHeight * STROKE_INTERLINE * lineSpacing
  const lineLayouts: Array<{ strokes: Point[][]; width: number; centerY: number }> = []
  let totalWidth = 0

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    // The pen, in mm along the line — KiCad's `cursor.x`.
    let cursorX = 0
    const strokes: Point[][] = []
    const walk = (nodes: readonly MarkupNode[], subscript: boolean, superscript: boolean): void => {
      for (const node of nodes) {
        if (node.kind !== 'text') {
          const startX = cursorX
          // Both flags accumulate, and a subscript wins the offset — KiCad ORs
          // TEXT_STYLE bits and tests SUBSCRIPT first. The size shrinks once,
          // not per level: a bit, not a multiplier.
          walk(
            node.children,
            subscript || node.kind === 'subscript',
            superscript || node.kind === 'superscript'
          )
          if (node.kind === 'overbar') {
            const trim = fontWidth * OVERBAR_TRIM
            const barY = fontHeight * OVERBAR_HEIGHT
            strokes.push([
              { x: startX + trim, y: barY },
              { x: cursorX - trim, y: barY }
            ])
          }
          continue
        }
        const scale = subscript || superscript ? SCRIPT_SCALE : 1
        const glyphWidth = fontWidth * scale
        const glyphHeight = fontHeight * scale
        // The run's baseline shift, y-down like KiCad's `cursor.y`.
        const baselineDown = subscript
          ? glyphHeight * SUBSCRIPT_DROP
          : superscript
            ? -glyphHeight * SUPERSCRIPT_RISE
            : 0
        for (const char of Array.from(node.text)) {
          const code = char.codePointAt(0) ?? 0
          if (code < 32) continue
          const index = code - 32
          const glyphStr =
            (newstrokeDict as Record<string, string>)[index.toString()] ?? 'F^K[KFYFY[K['
          const glyph = parseGlyph(glyphStr)
          for (const stroke of glyph.strokes) {
            strokes.push(
              stroke.map((point) => ({
                // Italic slants each point by its height in glyph space —
                // about the baseline, before the run's shift — as KiCad's
                // `STROKE_GLYPH::Transform` does.
                x:
                  cursorX +
                  point.x * glyphWidth -
                  (italic ? point.y * glyphHeight * ITALIC_TILT : 0),
                // Glyph space is y-down like KiCad's; the renderer is y-up. The
                // line's baseline offset is NOT folded in here — it belongs to
                // the line, and `verticalShift` below carries KiCad's whole
                // origin formula.
                y: -(point.y * glyphHeight + baselineDown)
              }))
            )
          }
          cursorX += glyph.width * glyphWidth
        }
      }
    }
    walk(parseTextMarkup(lines[lineIndex]), false, false)
    const lineWidth = cursorX
    totalWidth = Math.max(totalWidth, lineWidth)
    lineLayouts.push({ strokes, width: lineWidth, centerY: -lineIndex * lineAdvance })
  }

  // KiCad's block height: the first line counts 1.17 x size, every line after it
  // one interline. Not `lineCount * interline` — the first line is special.
  const totalHeight = fontHeight * FIRST_LINE_HEIGHT + Math.max(0, lines.length - 1) * lineAdvance
  const verticalAdjust =
    verticalAlign === 'top' ? 0 : verticalAlign === 'bottom' ? totalHeight : totalHeight / 2
  // The first line's origin, negated into y-up. Later lines step down by one
  // interline via `line.centerY`.
  const verticalShift = -(fontHeight - thickness * STROKE_V_FUDGE - verticalAdjust)
  // Stroke fonts nudge horizontally too, on the justified edge only: KiCad adds
  // it for left, subtracts it for right, and discards it when centring.
  const horizontalFudge = thickness / STROKE_H_FUDGE_DIVISOR
  const segments: StrokeSegment[] = []
  for (const line of lineLayouts) {
    const horizontalShift =
      horizontalAlign === 'left'
        ? horizontalFudge
        : horizontalAlign === 'right'
          ? -(line.width + horizontalFudge)
          : -line.width / 2
    for (const stroke of line.strokes) {
      const transformed = stroke.map((point) => {
        const y = point.y + line.centerY + verticalShift
        let x = point.x + horizontalShift
        if (mirror) x = -x
        return { x, y }
      })
      for (let i = 0; i < transformed.length - 1; i++) {
        segments.push({
          x1: transformed[i].x,
          y1: transformed[i].y,
          x2: transformed[i + 1].x,
          y2: transformed[i + 1].y
        })
      }
    }
  }

  const horizontalBounds =
    horizontalAlign === 'left'
      ? { minX: horizontalFudge, maxX: horizontalFudge + totalWidth }
      : horizontalAlign === 'right'
        ? { minX: -(totalWidth + horizontalFudge), maxX: -horizontalFudge }
        : { minX: -totalWidth / 2, maxX: totalWidth / 2 }
  // The CAP box of the glyphs actually drawn — top of the first line to the
  // baseline of the last — rather than the nominal line box, so a click lands
  // where the letters are.
  const verticalBounds = {
    minY:
      verticalShift - Math.max(0, lines.length - 1) * lineAdvance - GLYPH_CAP_BOTTOM * fontHeight,
    maxY: verticalShift + GLYPH_CAP_TOP * fontHeight
  }
  const bounds = mirror
    ? {
        minX: -horizontalBounds.maxX,
        maxX: -horizontalBounds.minX,
        ...verticalBounds
      }
    : { ...horizontalBounds, ...verticalBounds }
  return { strokes: segments, totalWidth, totalHeight, bounds }
}

/**
 * Advance width of a single line, in mm — what a text-box wrap has to compare
 * against the box's inner width.
 *
 * Deliberately `getTextStrokes().totalWidth` rather than a second, cheaper loop
 * over the glyph advances. A private measurer would be the faster code and the
 * wrong trade: it would be a copy of the advance rule that wrapping trusts to
 * match what rendering then draws, and the two drifting is invisible until a
 * line spills its box. Text boxes are short and rare, so the cost of laying the
 * strokes out to throw them away is not worth a rule stated twice.
 *
 * Multi-line input reports the WIDEST line, since that is what `totalWidth`
 * means; wrapping calls it per candidate line.
 */
export function measureTextWidth(text: string, options: TextStrokeOptions): number {
  return getTextStrokes(text, options).totalWidth
}

/**
 * Eeschema's default line width, **6 mil** (`DEFAULT_LINE_WIDTH_MILS`,
 * `eeschema/default_values.h`), written in its defining unit per RULES.md §5.
 * It reaches text through the painter: `SCH_PAINTER::getTextThickness` hands
 * `GetDefaultPenWidth()` to `GetEffectiveTextPenWidth`, which is why non-bold
 * schematic text with no authored thickness draws at a FLAT 6 mil at any font
 * size — not size/8. `SchematicScene` aliases this for pin/graphic strokes;
 * one home for the one KiCad setting.
 */
export const KICAD_DEFAULT_LINE_WIDTH = spacingToMm(6, 'mil')

/**
 * KiCad's `EDA_TEXT::GetEffectiveTextPenWidth` (`eda_text.cpp`) plus the
 * pen-size rules of `gr_text.cpp`, in mm:
 *
 *   1. An authored thickness wins (bold does not override it) — but is still
 *      clamped, so a heavy authored pen cannot blob small text.
 *   2. Bold autos to width / 5 (`GetPenSizeForBold`), beating the default pen.
 *   3. Otherwise the caller's default pen: eeschema paints with the schematic
 *      default line width, pcbnew passes nothing so width / 8
 *      (`GetPenSizeForNormal`) fires.
 *   4. Everything clamps to 0.25 × min(width, height) (`ClampTextPenSize`,
 *      non-strict; pin texts use a separate 0.18-strict rule — see
 *      `SchematicScene.pinTextThickness`).
 *
 * KiCad keys the pen-size ratios off the WIDTH component and the clamp off the
 * smaller axis; both matter for non-square `(size h w)` fonts.
 */
export function effectiveTextThickness(options: {
  width: number
  height: number
  thickness?: number
  bold?: boolean
  /** What the painter would pass: eeschema the default line width, pcbnew 0. */
  defaultPenWidth?: number
}): number {
  const { width, height, thickness, bold, defaultPenWidth = 0 } = options
  let pen = thickness ?? 0
  if (pen <= 0) {
    if (bold) pen = width / 5
    else if (defaultPenWidth > 0) pen = defaultPenWidth
    else pen = width / 8
  }
  return Math.min(pen, 0.25 * Math.min(Math.abs(width), Math.abs(height)))
}

/**
 * Structural view of KicadTextEffects (schematic.ts) — same reason as
 * `FontEffectsLike` below, for the shape the schematic and symbol editors carry.
 */
export interface TextEffectsLike {
  /** Integer nanometers — the schematic/symbol domain unit (KicadTextEffects). */
  fontSize: { height: number; width: number }
  /** Integer nanometers, absent for KiCad's derived-from-size auto pen. */
  thickness?: number
  bold?: boolean
  italic?: boolean
  horizontalAlign?: HorizontalTextAlign
  verticalAlign?: VerticalTextAlign
  lineSpacing?: number
}

/**
 * Layout options for schematic/symbol text effects, including the thickness
 * KiCad derives from the font size when the file does not state one. This is
 * the nm→mm boundary for text: effects arrive in domain nanometers, layout
 * options leave in the millimeters the font engine works in.
 *
 * Shared because **hit-testing has to lay text out exactly as rendering does**:
 * where the glyphs are is where a click must land, and two copies of this mapping
 * would drift into a text you can see but cannot click.
 */
export function strokeOptionsFromTextEffects(
  effects: TextEffectsLike
): TextStrokeOptions & { thickness: number } {
  const width = effects.fontSize.width / NM_PER_MM
  const height = effects.fontSize.height / NM_PER_MM
  return {
    width,
    height,
    // A schematic-surface text, so the auto pen is eeschema's: the flat
    // default line width, not a size ratio.
    thickness: effectiveTextThickness({
      width,
      height,
      thickness: effects.thickness === undefined ? undefined : effects.thickness / NM_PER_MM,
      bold: effects.bold,
      defaultPenWidth: KICAD_DEFAULT_LINE_WIDTH
    }),
    bold: effects.bold,
    italic: effects.italic,
    horizontalAlign: effects.horizontalAlign,
    verticalAlign: effects.verticalAlign,
    lineSpacing: effects.lineSpacing
  }
}

/**
 * The four corners of a laid-out string, rotated by `angleDegrees` about its
 * anchor and placed in the anchor's own space — the quad a click should be
 * tested against, since a text occupies its glyph box and not merely the point
 * it is stored at.
 *
 * The anchor and the returned corners are domain nanometers (the glyph bounds
 * measure in millimeters and scale up here). Returned as corners rather than
 * an axis-aligned box because a rotated text's box is not axis-aligned, and
 * flattening it early would make a 90° label clickable well outside itself.
 */
export function textBoxCorners(
  text: string,
  effects: TextEffectsLike,
  anchor: Point,
  angleDegrees: number
): Point[] {
  const { bounds } = getTextStrokes(text, strokeOptionsFromTextEffects(effects))
  const angle = (angleDegrees * Math.PI) / 180
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  return [
    { x: bounds.minX, y: bounds.minY },
    { x: bounds.maxX, y: bounds.minY },
    { x: bounds.maxX, y: bounds.maxY },
    { x: bounds.minX, y: bounds.maxY }
  ].map((corner) => ({
    x: anchor.x + (corner.x * cos - corner.y * sin) * NM_PER_MM,
    y: anchor.y + (corner.x * sin + corner.y * cos) * NM_PER_MM
  }))
}

/**
 * Structural view of KicadFontEffects (footprint.ts) — declared here so the
 * font engine stays dependency-free. Distances are integer nanometers.
 */
export interface FontEffectsLike {
  width?: number
  height?: number
  thickness?: number
  bold?: boolean
  italic?: boolean
  mirror?: boolean
  hAlign?: 'left' | 'right'
  vAlign?: 'top' | 'bottom'
}

/**
 * Map parsed KiCad text effects to stroke-layout options. Centralizes the
 * KiCad defaults (1.27mm size, center justification) so rendering and
 * hit-testing lay text out identically.
 */
export function strokeOptionsFromEffects(
  effects?: FontEffectsLike
): TextStrokeOptions & { thickness: number } {
  // Same nm→mm boundary as `strokeOptionsFromTextEffects`: the footprint/board
  // domain carries nanometers, the font engine lays out in millimeters.
  const width = effects?.width !== undefined ? effects.width / NM_PER_MM : 1.27
  const height = effects?.height !== undefined ? effects.height / NM_PER_MM : 1.27
  return {
    width,
    height,
    // A board-surface text, so the auto pen is pcbnew's: no default pen is
    // passed and the width/8 ratio fires.
    thickness: effectiveTextThickness({
      width,
      height,
      thickness: effects?.thickness === undefined ? undefined : effects.thickness / NM_PER_MM,
      bold: effects?.bold
    }),
    bold: effects?.bold ?? false,
    italic: effects?.italic ?? false,
    mirror: effects?.mirror ?? false,
    horizontalAlign: effects?.hAlign ?? 'center',
    verticalAlign: effects?.vAlign ?? 'center'
  }
}
