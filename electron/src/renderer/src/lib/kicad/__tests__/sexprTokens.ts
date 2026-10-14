/**
 * Test support: split s-expression text into its tokens — parens and atoms —
 * respecting quoted strings (which may contain whitespace and backslash
 * escapes). Two files with equal token streams differ only in formatting,
 * which is the round-trip invariant the serializer actually offers against
 * KiCad-authored files: it canonicalizes whitespace by contract
 * (sexpr.ts serializeSExpr: "whitespace may differ") while every atom must
 * survive byte-for-byte.
 */
export const sexprTokens = (text: string): string[] => {
  const tokens: string[] = []
  let i = 0
  const n = text.length
  while (i < n) {
    const c = text[i]
    if (c === '(' || c === ')') {
      tokens.push(c)
      i++
    } else if (c === '"') {
      let j = i + 1
      while (j < n && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      tokens.push(text.slice(i, j + 1))
      i = j + 1
    } else if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++
    } else {
      let j = i
      while (j < n && !' \t\n\r()"'.includes(text[j])) j++
      tokens.push(text.slice(i, j))
      i = j
    }
  }
  return tokens
}
