// Parts follow KiCad's source, named below: Copyright The KiCad Developers, GPL-3.0-or-later.
// KiCad's text markup, the way the file stores it and the way the font reads it.
//
// Two layers, applied in this order to any text KiCad *shows* (pin names, net
// labels, fields, free text, footprint text — `GetShownText` on all of them):
//
//   1. `UnescapeString` (`common/string_utils.cpp`): `{slash}`, `{colon}`,
//      `{dblquote}` … become the character they name. The file stores names
//      this way so a `/` in a pin name does not read as a hierarchy separator.
//   2. The markup grammar (`include/markup_parser.h`, a PEGTL parse tree that
//      `FONT::drawMarkup` walks): `~{TEXT}` is an overbar, `^{TEXT}` a
//      superscript, `_{TEXT}` a subscript. They nest. Anything unterminated is
//      literal text, so a stray `~{` draws as itself.
//
// `newstroke.ts` walks the tree to lay glyphs out; DOM surfaces that want the
// bare letters use `markupToPlainText`. Connectivity compares the RAW strings,
// as KiCad does — nothing here is for matching, only for showing.

export type MarkupNode =
  | { kind: 'text'; text: string }
  | { kind: 'overbar' | 'superscript' | 'subscript'; children: MarkupNode[] }

const ESCAPES: Readonly<Record<string, string>> = {
  dblquote: '"',
  quote: "'",
  lt: '<',
  gt: '>',
  backslash: '\\',
  slash: '/',
  bar: '|',
  comma: ',',
  colon: ':',
  space: ' ',
  dollar: '$',
  tab: '\t',
  return: '\n',
  brace: '{'
}

/**
 * KiCad's `UnescapeString`, character for character. A brace group right after
 * `$`, `~`, `^` or `_` is markup (or a `${VAR}` reference), so its braces stay
 * and only its inside is unescaped; any other `{name}` becomes the character
 * `name` stands for, or stays as written when `name` is not an escape.
 */
export function unescapeKicadText(source: string): string {
  if (source.length <= 2) return source
  let out = ''
  let prev: string
  let ch = ''
  for (let i = 0; i < source.length; i++) {
    prev = ch
    ch = source[i]
    if (ch !== '{') {
      out += ch
      continue
    }
    let token = ''
    let depth = 1
    let terminated = false
    for (i = i + 1; i < source.length; i++) {
      ch = source[i]
      if (ch === '{') depth++
      else if (ch === '}') depth--
      if (depth <= 0) {
        terminated = true
        break
      }
      token += ch
    }
    if (!terminated) {
      out += '{' + unescapeKicadText(token)
    } else if (prev === '$' || prev === '~' || prev === '^' || prev === '_') {
      out += '{' + unescapeKicadText(token) + '}'
    } else if (Object.prototype.hasOwnProperty.call(ESCAPES, token)) {
      out += ESCAPES[token]
    } else {
      out += '{' + unescapeKicadText(token) + '}'
    }
  }
  return out
}

const MARKUP_KIND: Readonly<Record<string, 'overbar' | 'superscript' | 'subscript'>> = {
  '~': 'overbar',
  '^': 'superscript',
  _: 'subscript'
}

const isIdentifierStart = (c: string): boolean => /[A-Za-z_]/.test(c)
const isIdentifierChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c)

/**
 * Parses one line of already-unescaped text into KiCad's markup tree. The
 * grammar is `markup_parser.h`'s, PEG semantics included: a markup group is
 * `~{` … `}` whose inside is text, nested groups, and `{identifier}` escape
 * sequences kept whole (so their `}` does not close the group); a group that
 * never closes is not a group, and its opener is ordinary text. A `http://` or
 * `https://` run to the next space is a URL, which the grammar keeps out of the
 * markup rules — `~{` inside one is literal.
 */
export function parseTextMarkup(text: string): MarkupNode[] {
  const { nodes } = parseSequence(text, 0, false)
  return nodes
}

/** Parses until end of input, or — inside a group — until the closing brace. */
function parseSequence(
  source: string,
  start: number,
  inGroup: boolean
): { nodes: MarkupNode[]; end: number; closed: boolean } {
  const nodes: MarkupNode[] = []
  let literal = ''
  const flush = (): void => {
    if (literal) nodes.push({ kind: 'text', text: literal })
    literal = ''
  }
  let i = start
  while (i < source.length) {
    const ch = source[i]
    if (inGroup && ch === '}') {
      flush()
      return { nodes, end: i + 1, closed: true }
    }
    const kind = MARKUP_KIND[ch]
    if (kind && source[i + 1] === '{') {
      const inner = parseSequence(source, i + 2, true)
      if (inner.closed) {
        flush()
        nodes.push({ kind, children: inner.nodes })
        i = inner.end
        continue
      }
      // Unterminated: the opener is text, and parsing resumes after it.
      literal += ch
      i += 1
      continue
    }
    if (inGroup && ch === '{') {
      // `anyStringWithinBraces` swallows `{identifier}` whole.
      let j = i + 1
      if (j < source.length && isIdentifierStart(source[j])) {
        j++
        while (j < source.length && isIdentifierChar(source[j])) j++
        if (source[j] === '}') {
          literal += source.slice(i, j + 1)
          i = j + 1
          continue
        }
      }
    }
    if (!inGroup && (source.startsWith('http://', i) || source.startsWith('https://', i))) {
      let j = i
      while (j < source.length && source[j] !== ' ') j++
      literal += source.slice(i, j)
      i = j
      continue
    }
    literal += ch
    i += 1
  }
  flush()
  return { nodes, end: i, closed: false }
}

/** The letters a markup tree draws, with every bar and shift dropped. */
export function markupPlainText(nodes: readonly MarkupNode[]): string {
  let out = ''
  for (const node of nodes) {
    out += node.kind === 'text' ? node.text : markupPlainText(node.children)
  }
  return out
}

/**
 * What a DOM surface shows for a stored string: unescaped, with the markup
 * removed — `~{RST}` reads `RST`. For the canvas, which cannot draw a bar over
 * a typeface, and for anywhere the bare name is wanted.
 */
export function markupToPlainText(source: string): string {
  return markupPlainText(parseTextMarkup(unescapeKicadText(source)))
}
