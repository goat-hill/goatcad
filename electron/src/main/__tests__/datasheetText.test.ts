import { describe, expect, it } from 'vitest'
import { layoutText, searchable, type GlyphBox } from '../datasheetText'

/** Glyphs for a run of text at (x, y) with a fixed advance of half the size. */
const run = (text: string, x: number, y: number, size = 10): GlyphBox[] =>
  [...text].map((ch, i) => ({
    code: ch.codePointAt(0)!,
    x0: x + i * size * 0.5,
    x1: x + (i + 1) * size * 0.5,
    y0: y,
    y1: y + size,
    fontSize: size
  }))

describe('layoutText', () => {
  it('keeps table columns aligned across rows', () => {
    const glyphs = [
      ...run('PARAMETER', 72, 100),
      ...run('MIN', 300, 100),
      ...run('MAX', 420, 100),
      ...run('Input voltage', 72, 120),
      ...run('3', 300, 120),
      ...run('17', 420, 120)
    ]
    const lines = layoutText(glyphs).split('\n')
    const header = lines.find((l) => l.includes('PARAMETER'))!
    const row = lines.find((l) => l.includes('Input voltage'))!
    expect(Math.abs(header.indexOf('MIN') - row.indexOf('3'))).toBeLessThanOrEqual(1)
    expect(Math.abs(header.indexOf('MAX') - row.indexOf('17'))).toBeLessThanOrEqual(1)
  })

  it('regenerates spaces from geometry and keeps kerned words whole', () => {
    const glyphs = [...run('Hello', 72, 100), ...run('world', 72 + 5 * 5 + 3, 100)]
    // pdfium's own synthesized space, which must not double up.
    glyphs.push({ code: 32, x0: 97, x1: 97, y0: 100, y1: 110, fontSize: 10 })
    expect(layoutText(glyphs)).toBe('Hello world')
    const kerned = [...run('Vo', 72, 100), ...run('ut', 72 + 2 * 5 - 0.4, 100)]
    expect(layoutText(kerned)).toBe('Vout')
  })

  it('honors a space pdfium marked inside tight justified text', () => {
    // A word gap of a tenth of an em is below any geometric threshold that
    // would not also split kerned pairs; only the marker can tell.
    const tight = [
      ...run('over', 72, 100),
      { code: 32, x0: 92, x1: 93, y0: 100, y1: 110, fontSize: 10 },
      ...run('operating', 93, 100)
    ]
    expect(layoutText(tight)).toBe('over operating')
    // The same gap with no marker is one word.
    expect(layoutText([...run('over', 72, 100), ...run('operating', 93, 100)])).toBe(
      'overoperating'
    )
  })

  it('keeps a superscript on its line', () => {
    const glyphs = [...run('VIN', 72, 100), ...run('(1)', 72 + 3 * 5 + 1, 96, 6)]
    expect(layoutText(glyphs).split('\n')).toHaveLength(1)
  })

  it('marks a paragraph break with a blank line', () => {
    const glyphs = [...run('First', 72, 100), ...run('Second', 72, 112), ...run('Third', 72, 140)]
    const lines = layoutText(glyphs).split('\n')
    expect(lines.indexOf('Second') - lines.indexOf('First')).toBe(1)
    expect(lines.indexOf('Third') - lines.indexOf('Second')).toBeGreaterThan(1)
    expect(lines.filter((l) => l === '')).toHaveLength(1)
  })

  it('handles an empty page', () => {
    expect(layoutText([])).toBe('')
  })
})

describe('searchable', () => {
  it('collapses layout padding so a phrase matches', () => {
    expect(searchable('  Electrical   Characteristics  ')).toBe('electrical characteristics')
  })
})
