import { describe, expect, it } from 'vitest'
import {
  markupToPlainText,
  parseTextMarkup,
  unescapeKicadText,
  type MarkupNode
} from '../textMarkup'

const text = (t: string): MarkupNode => ({ kind: 'text', text: t })

describe('unescapeKicadText — KiCad UnescapeString parity', () => {
  it('resolves the named escapes', () => {
    expect(unescapeKicadText('A{slash}B{colon}C')).toBe('A/B:C')
    expect(unescapeKicadText('{dblquote}x{dblquote}')).toBe('"x"')
    expect(unescapeKicadText('{lt}{gt}{bar}{comma}{space}{dollar}{brace}')).toBe('<>|, ${')
    expect(unescapeKicadText('a{return}b{tab}c')).toBe('a\nb\tc')
  })

  it('keeps markup and variable braces, unescaping only their inside', () => {
    expect(unescapeKicadText('~{A{slash}B}')).toBe('~{A/B}')
    expect(unescapeKicadText('^{2}')).toBe('^{2}')
    expect(unescapeKicadText('_{n}')).toBe('_{n}')
    expect(unescapeKicadText('${REFERENCE}')).toBe('${REFERENCE}')
  })

  it('leaves an unknown or unterminated group as written', () => {
    expect(unescapeKicadText('{nosuch}')).toBe('{nosuch}')
    expect(unescapeKicadText('a{b')).toBe('a{b')
    expect(unescapeKicadText('ab')).toBe('ab')
  })
})

describe('parseTextMarkup — markup_parser.h grammar', () => {
  it('plain text is one text node', () => {
    expect(parseTextMarkup('INT')).toEqual([text('INT')])
  })

  it('reads overbar, superscript and subscript groups', () => {
    expect(parseTextMarkup('~{INT}')).toEqual([{ kind: 'overbar', children: [text('INT')] }])
    expect(parseTextMarkup('x^{2}')).toEqual([
      text('x'),
      { kind: 'superscript', children: [text('2')] }
    ])
    expect(parseTextMarkup('V_{CC}')).toEqual([
      text('V'),
      { kind: 'subscript', children: [text('CC')] }
    ])
  })

  it('nests groups', () => {
    expect(parseTextMarkup('~{A_{0}}')).toEqual([
      { kind: 'overbar', children: [text('A'), { kind: 'subscript', children: [text('0')] }] }
    ])
  })

  it('an unterminated group is literal text, and parsing resumes after its opener', () => {
    expect(parseTextMarkup('~{INT')).toEqual([text('~{INT')])
    expect(parseTextMarkup('~{A~{b}')).toEqual([
      text('~{A'),
      { kind: 'overbar', children: [text('b')] }
    ])
  })

  it('a lone marker or brace is text', () => {
    expect(parseTextMarkup('~')).toEqual([text('~')])
    expect(parseTextMarkup('a_b')).toEqual([text('a_b')])
    expect(parseTextMarkup('{x}')).toEqual([text('{x}')])
  })

  it('keeps an identifier group inside braces whole, so its brace does not close the group', () => {
    expect(parseTextMarkup('~{A{id}B}')).toEqual([{ kind: 'overbar', children: [text('A{id}B')] }])
  })

  it('a URL is text through to the next space, markup included', () => {
    expect(parseTextMarkup('see https://x.io/~{y} ~{z}')).toEqual([
      text('see https://x.io/~{y} '),
      { kind: 'overbar', children: [text('z')] }
    ])
  })
})

describe('markupToPlainText', () => {
  it('shows the letters of a stored name', () => {
    expect(markupToPlainText('~{RST}')).toBe('RST')
    expect(markupToPlainText('V_{CC}^{2}')).toBe('VCC2')
    expect(markupToPlainText('A{slash}~{B}')).toBe('A/B')
    expect(markupToPlainText('~{INT')).toBe('~{INT')
  })
})
