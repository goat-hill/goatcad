/**
 * KiCad's shown text for a label or field: `${NAME}` text variables replaced,
 * then `@{…}` arithmetic evaluated — how KiCad 10 lets one sheet, reused, name
 * its nets per instance (`Out@{(${#}-2)*8}`). A variable nothing defines, or
 * an expression that is not plain arithmetic, is left as written.
 */

/** `+ - * / %` and parentheses over numbers; null when `source` is anything else. */
const evaluate = (source: string): number | null => {
  const tokens = source.match(/\d+(?:\.\d+)?|[-+*/%()]|\S/g) ?? []
  let at = 0
  const peek = (): string | undefined => tokens[at]
  const expression = (): number | null => {
    let value = term()
    while (value !== null && (peek() === '+' || peek() === '-')) {
      const op = tokens[at++]
      const right = term()
      if (right === null) return null
      value = op === '+' ? value + right : value - right
    }
    return value
  }
  const term = (): number | null => {
    let value = factor()
    while (value !== null && (peek() === '*' || peek() === '/' || peek() === '%')) {
      const op = tokens[at++]
      const right = factor()
      if (right === null) return null
      value = op === '*' ? value * right : op === '/' ? value / right : value % right
    }
    return value
  }
  const factor = (): number | null => {
    const token = tokens[at++]
    if (token === '-') {
      const value = factor()
      return value === null ? null : -value
    }
    if (token === '(') {
      const value = expression()
      return tokens[at++] === ')' ? value : null
    }
    return token !== undefined && /^\d/.test(token) ? Number(token) : null
  }
  const value = expression()
  return value !== null && at === tokens.length && Number.isFinite(value) ? value : null
}

export const shownText = (text: string, lookup: (name: string) => string | undefined): string => {
  if (!text.includes('${') && !text.includes('@{')) return text
  const substituted = text.replace(/\$\{([^{}]*)\}/g, (all, name: string) => lookup(name) ?? all)
  return substituted.replace(/@\{([^{}]*)\}/g, (all, expression: string) => {
    const value = evaluate(expression)
    if (value === null) return all
    return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6)))
  })
}
