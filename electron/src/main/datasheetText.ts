/**
 * Text as it is laid out on the page, rebuilt from glyph boxes.
 *
 * pdfium hands back characters with their boxes; its own reading-order text
 * loses the one thing a spec table needs, which column a number sits in.
 * This rebuilds lines from the boxes and places each run of glyphs at the
 * character column its x position implies, the way `pdftotext -layout` does,
 * so MIN/TYP/MAX stay under their headings. Pure, so it can be tested on
 * synthetic boxes.
 */

/** One character as the wasm glue reports it: a loose glyph box in page
 *  points with a top-left origin, and the font size it was set in. */
export interface GlyphBox {
  code: number
  x0: number
  y0: number
  x1: number
  y1: number
  fontSize: number
}

interface Line {
  glyphs: GlyphBox[]
  yc: number
  height: number
}

const median = (values: number[]): number => {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

/** Group glyphs into lines by vertical center, tolerant of superscripts. */
const groupLines = (glyphs: readonly GlyphBox[]): Line[] => {
  const byY = [...glyphs].sort((a, b) => (a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2)
  const lines: Line[] = []
  for (const g of byY) {
    const yc = (g.y0 + g.y1) / 2
    const height = g.y1 - g.y0
    const line = lines[lines.length - 1]
    // 0.7 of the taller box: a superscript's center sits well above the
    // line's, while the next line of even dense text is a full pitch away.
    if (line && Math.abs(yc - line.yc) <= 0.7 * Math.max(line.height, height)) {
      line.glyphs.push(g)
      line.yc = (line.yc * (line.glyphs.length - 1) + yc) / line.glyphs.length
      line.height = Math.max(line.height, height)
    } else {
      lines.push({ glyphs: [g], yc, height })
    }
  }
  return lines
}

/**
 * A line's text with each gapped run starting at its character column. A word
 * break is a geometric gap, or a space pdfium itself put between two glyphs:
 * justified body text closes word gaps to less than kerning tells apart, and
 * pdfium's own segmentation knows which was which.
 */
const renderLine = (line: Line, leftEdge: number, unit: number): string => {
  const glyphs = [...line.glyphs].sort((a, b) => a.x0 - b.x0)
  let out = ''
  let prev: GlyphBox | null = null
  let spaceMarked = false
  for (const g of glyphs) {
    if (g.code === 32) {
      spaceMarked = true
      continue
    }
    if (prev) {
      const gap = g.x0 - prev.x1
      if (gap > 0.15 * g.fontSize) {
        const column = Math.round((g.x0 - leftEdge) / unit)
        out += ' '.repeat(Math.max(1, column - out.length))
      } else if (spaceMarked && gap > -0.1 * g.fontSize) {
        out += ' '
      }
    } else {
      out += ' '.repeat(Math.max(0, Math.round((g.x0 - leftEdge) / unit)))
    }
    out += String.fromCodePoint(g.code)
    prev = g
    spaceMarked = false
  }
  return out.trimEnd()
}

/**
 * The page's text with its layout kept. Control characters pdfium synthesizes
 * are dropped; spaces survive only as word-break markers, and the padding is
 * regenerated from geometry, so a real gap is a gap and a kerned word stays
 * one word. A blank line marks a vertical break
 * larger than a table row's pitch.
 */
export function layoutText(glyphs: readonly GlyphBox[]): string {
  const visible = glyphs.filter((g) => g.code > 32 && g.x1 > g.x0 && g.y1 > g.y0)
  if (!visible.length) return ''
  const unit =
    median(visible.map((g) => g.x1 - g.x0)) || median(visible.map((g) => g.fontSize)) * 0.5
  const leftEdge = Math.min(...visible.map((g) => g.x0))
  // Spaces ride along as word-break markers; they need a line to belong to.
  const spaces = glyphs.filter((g) => g.code === 32 && g.y1 > g.y0)
  const lines = groupLines([...visible, ...spaces])
  const out: string[] = []
  let prevBottom: number | null = null
  for (const line of lines) {
    const top = line.yc - line.height / 2
    // A table row's pitch is about twice its glyph height; more than that is
    // a break worth showing.
    if (prevBottom !== null && top - prevBottom > 1.5 * line.height) out.push('')
    out.push(renderLine(line, leftEdge, unit))
    prevBottom = line.yc + line.height / 2
  }
  return out.join('\n')
}

/** Whitespace-collapsed, lowercased: the form a search compares in, so a
 *  phrase matches across the padding layout inserts. */
export const searchable = (text: string): string => text.replace(/\s+/g, ' ').trim().toLowerCase()
