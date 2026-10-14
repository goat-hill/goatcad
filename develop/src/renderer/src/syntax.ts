// A deliberately small syntax highlighter for the Git Diff view.
//
// It is a lexer, not a parser: enough to tell comments, strings, numbers, and
// keywords apart at a glance while reading a diff, with no dependency to add.
// Two consequences worth knowing rather than discovering:
//
//   - It highlights a line at a time, carrying only "am I inside a block
//     comment". A template literal or string left open at end of line closes
//     there instead of continuing.
//   - A packed diff's hunks are not contiguous, so block-comment state resets
//     at each hunk. Whole-file mode has no such gap and reads correctly.
//
// `.vue` is lexed as code: script and style dominate our files, and a template
// degrades to quoted attribute values reading as strings, which is fair.

export type TokenType = 'plain' | 'comment' | 'string' | 'keyword' | 'number' | 'type'

export interface Token {
  type: TokenType
  text: string
}

export type Language = 'code' | 'css' | 'json' | 'none'

interface Grammar {
  lineComment: boolean
  blockComment: boolean
  /** Quote characters that open a string. */
  quotes: string
  keywords: Set<string>
  /** `@media`, `@supports` — an at-rule reads as a keyword. */
  atRules: boolean
  /** `#1a221f` — a hex color reads as a number. */
  hexColors: boolean
  /** Capitalized identifiers read as types (Vue, BrowserWindow, GitFileChange). */
  capitalIsType: boolean
}

const CODE_KEYWORDS = new Set(
  (
    'as async await break case catch class const continue declare default delete do else enum export ' +
    'extends false finally for from function get if implements import in instanceof interface let ' +
    'new null of private protected public readonly return satisfies set static super switch this throw ' +
    'true try type typeof undefined var void while yield'
  ).split(' ')
)

const GRAMMARS: Record<Exclude<Language, 'none'>, Grammar> = {
  code: {
    lineComment: true,
    blockComment: true,
    quotes: `'"\``,
    keywords: CODE_KEYWORDS,
    atRules: false,
    hexColors: false,
    capitalIsType: true
  },
  css: {
    lineComment: false,
    blockComment: true,
    quotes: `'"`,
    keywords: new Set(['important', 'inherit', 'initial', 'unset', 'none', 'auto', 'var']),
    atRules: true,
    hexColors: true,
    capitalIsType: false
  },
  json: {
    lineComment: false,
    blockComment: false,
    quotes: `"`,
    keywords: new Set(['true', 'false', 'null']),
    atRules: false,
    hexColors: false,
    capitalIsType: false
  }
}

const EXTENSIONS: Record<string, Language> = {
  ts: 'code',
  tsx: 'code',
  mts: 'code',
  cts: 'code',
  js: 'code',
  jsx: 'code',
  mjs: 'code',
  cjs: 'code',
  vue: 'code',
  css: 'css',
  scss: 'css',
  json: 'json'
}

export function languageFor(path: string): Language {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return 'none'
  return EXTENSIONS[name.slice(dot + 1).toLowerCase()] ?? 'none'
}

export interface HighlightResult {
  tokens: Token[]
  /** Whether the line ended inside a block comment, to seed the next one. */
  inBlockComment: boolean
}

export function highlightLine(
  line: string,
  language: Language,
  inBlockComment = false
): HighlightResult {
  if (language === 'none') {
    return { tokens: line ? [{ type: 'plain', text: line }] : [], inBlockComment: false }
  }
  const grammar = GRAMMARS[language]
  const tokens: Token[] = []
  let plain = ''
  const flush = (): void => {
    if (plain) {
      tokens.push({ type: 'plain', text: plain })
      plain = ''
    }
  }
  const emit = (type: TokenType, text: string): void => {
    flush()
    tokens.push({ type, text })
  }

  let block = inBlockComment
  let i = 0
  while (i < line.length) {
    if (block) {
      const end = line.indexOf('*/', i)
      if (end === -1) {
        emit('comment', line.slice(i))
        i = line.length
      } else {
        emit('comment', line.slice(i, end + 2))
        i = end + 2
        block = false
      }
      continue
    }

    const char = line[i]
    const pair = line.slice(i, i + 2)

    if (grammar.lineComment && pair === '//') {
      emit('comment', line.slice(i))
      break
    }
    if (grammar.blockComment && pair === '/*') {
      // Re-enter the loop at the same index; the block branch consumes the open.
      block = true
      continue
    }
    if (grammar.quotes.includes(char)) {
      let end = i + 1
      while (end < line.length) {
        if (line[end] === '\\') {
          end += 2
          continue
        }
        if (line[end] === char) {
          end++
          break
        }
        end++
      }
      emit('string', line.slice(i, end))
      i = end
      continue
    }
    if (grammar.hexColors && char === '#') {
      const hex = /^#[0-9a-fA-F]{3,8}\b/.exec(line.slice(i))
      if (hex) {
        emit('number', hex[0])
        i += hex[0].length
        continue
      }
    }
    if (grammar.atRules && char === '@') {
      const rule = /^@[\w-]+/.exec(line.slice(i))
      if (rule) {
        emit('keyword', rule[0])
        i += rule[0].length
        continue
      }
    }
    // A digit only starts a number when it isn't part of an identifier (utf8, h2).
    if (char >= '0' && char <= '9' && !/[\w$]/.test(line[i - 1] ?? '')) {
      const number = /^[0-9][\w.]*/.exec(line.slice(i))
      if (number) {
        emit('number', number[0])
        i += number[0].length
        continue
      }
    }
    if (/[A-Za-z_$-]/.test(char)) {
      const word = /^[\w$-]+/.exec(line.slice(i))
      if (word) {
        const text = word[0]
        if (grammar.keywords.has(text)) emit('keyword', text)
        else if (grammar.capitalIsType && /^[A-Z]/.test(text)) emit('type', text)
        else plain += text
        i += text.length
        continue
      }
    }
    plain += char
    i++
  }

  flush()
  return { tokens, inBlockComment: block }
}
