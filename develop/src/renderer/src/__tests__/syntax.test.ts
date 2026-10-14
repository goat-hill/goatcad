import { describe, expect, it } from 'vitest'
import { highlightLine, languageFor, type Token } from '../syntax'

const types = (tokens: Token[]): string => tokens.map((token) => token.type[0]).join('')
const of = (tokens: Token[], type: string): string[] =>
  tokens.filter((token) => token.type === type).map((token) => token.text)

describe('languageFor', () => {
  it('maps the extensions this repo actually contains', () => {
    expect(languageFor('src/main/gitDiff.ts')).toBe('code')
    expect(languageFor('src/renderer/src/App.vue')).toBe('code')
    expect(languageFor('src/renderer/src/assets/main.css')).toBe('css')
    expect(languageFor('package.json')).toBe('json')
    expect(languageFor('docs/RULES.md')).toBe('none')
    expect(languageFor('bin/pre-cm-checks')).toBe('none')
    expect(languageFor('.gitignore')).toBe('none')
  })
})

describe('highlightLine', () => {
  it('separates keywords, types, strings, and numbers', () => {
    const { tokens } = highlightLine(`const limit: Budget = 'x' + 42`, 'code')

    expect(of(tokens, 'keyword')).toEqual(['const'])
    expect(of(tokens, 'type')).toEqual(['Budget'])
    expect(of(tokens, 'string')).toEqual([`'x'`])
    expect(of(tokens, 'number')).toEqual(['42'])
  })

  it('takes a line comment to the end, code and all', () => {
    const { tokens } = highlightLine(`call() // const 'not a string'`, 'code')

    expect(of(tokens, 'comment')).toEqual([`// const 'not a string'`])
    expect(of(tokens, 'keyword')).toEqual([])
  })

  it('carries an unterminated block comment to the next line and closes it', () => {
    const open = highlightLine('/* opening', 'code')
    expect(open.inBlockComment).toBe(true)

    const middle = highlightLine('still a comment', 'code', open.inBlockComment)
    expect(types(middle.tokens)).toBe('c')
    expect(middle.inBlockComment).toBe(true)

    const close = highlightLine('done */ const x', 'code', middle.inBlockComment)
    expect(of(close.tokens, 'comment')).toEqual(['done */'])
    expect(of(close.tokens, 'keyword')).toEqual(['const'])
    expect(close.inBlockComment).toBe(false)
  })

  it('closes a block comment that opens and ends on one line', () => {
    const { tokens, inBlockComment } = highlightLine('a /* b */ c', 'code')

    expect(of(tokens, 'comment')).toEqual(['/* b */'])
    expect(inBlockComment).toBe(false)
  })

  it('does not let an escaped quote end a string', () => {
    expect(of(highlightLine(`'it\\'s' rest`, 'code').tokens, 'string')).toEqual([`'it\\'s'`])
  })

  it('reads hex colors and at-rules in CSS, and takes no // comment there', () => {
    expect(of(highlightLine('color: #cca250;', 'css').tokens, 'number')).toEqual(['#cca250'])
    expect(of(highlightLine('@media (min-width: 40px) {', 'css').tokens, 'keyword')).toEqual([
      '@media'
    ])
    expect(of(highlightLine('background: url(//host/a.png);', 'css').tokens, 'comment')).toEqual([])
  })

  it('treats only JSON’s literals as keywords', () => {
    const { tokens } = highlightLine(`  "private": true,`, 'json')

    expect(of(tokens, 'string')).toEqual(['"private"'])
    expect(of(tokens, 'keyword')).toEqual(['true'])
  })

  it('leaves an unknown language as one plain run, and an empty line as nothing', () => {
    expect(highlightLine('# A heading', 'none').tokens).toEqual([
      { type: 'plain', text: '# A heading' }
    ])
    expect(highlightLine('', 'code').tokens).toEqual([])
  })

  it('does not start a number inside an identifier', () => {
    expect(of(highlightLine('const utf8 = 1', 'code').tokens, 'number')).toEqual(['1'])
  })

  it('reassembles every token back into the original line', () => {
    const line = `export const A = { b: 'c' } /* tail */ // done`
    const { tokens } = highlightLine(line, 'code')

    expect(tokens.map((token) => token.text).join('')).toBe(line)
  })
})
