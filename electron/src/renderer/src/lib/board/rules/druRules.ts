/**
 * The one way GoatCAD writes a project's custom rules (`<project>.kicad_dru`):
 * whole rules, by name, as KiCad writes them, with nothing of ours beside them.
 * Writing a set of names replaces the rules of those names, the first in place
 * and the rest removed, and appends what is new; every other byte of the file
 * (a rule the user wrote, a comment) is left as it was. A file that does not
 * exist yet starts with KiCad's `(version 1)`.
 */

/** A rule as it is written: KiCad's syntax, one clause a line. */
export interface DruRule {
  name: string
  condition: string
  /** Each constraint clause whole, e.g. `(constraint skew (max 5ps) (within_diff_pairs))`. */
  constraints: string[]
}

/** KiCad quotes a rule's name and condition in double quotes, escaping none inside. */
export const druRuleText = (rule: DruRule): string =>
  [
    `(rule "${rule.name}"`,
    `\t(condition "${rule.condition}")`,
    ...rule.constraints.map((c) => `\t${c}`)
  ]
    .join('\n')
    .concat(')')

interface RuleSpan {
  name: string
  start: number
  end: number
}

/** Each top-level `(rule "…" …)` in the text: its name and where it starts and ends. */
function ruleSpans(text: string): RuleSpan[] {
  const spans: RuleSpan[] = []
  let depth = 0
  let start = -1
  let inString = false
  let lineStart = true
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '\n') {
      lineStart = true
      continue
    }
    // A `#` first on its line is a comment to the line's end (KiCad's lexer).
    if (lineStart && c === '#' && !inString) {
      const next = text.indexOf('\n', i)
      i = next < 0 ? text.length : next - 1
      continue
    }
    if (c !== ' ' && c !== '\t') lineStart = false
    if (inString) {
      if (c === '"') inString = false
      continue
    }
    if (c === '"') inString = true
    else if (c === '(') {
      if (depth === 0) start = i
      depth++
    } else if (c === ')') {
      depth--
      if (depth === 0 && start >= 0) {
        const name = /^\(rule\s+"([^"]*)"/.exec(text.slice(start, i + 1))?.[1]
        if (name !== undefined) spans.push({ name, start, end: i + 1 })
        start = -1
      }
    }
  }
  return spans
}

/** The names of the file's rules, in order. */
export const ruleNamesIn = (text: string | undefined): string[] =>
  ruleSpans(text ?? '').map((s) => s.name)

/** A rule's text as the file has it, or null. */
export function ruleTextIn(text: string | undefined, name: string): string | null {
  const span = ruleSpans(text ?? '').find((s) => s.name === name)
  return span && text ? text.slice(span.start, span.end) : null
}

/**
 * Write `rules` over the rules named `replace`: in place of the first of them
 * the file has, the others removed with their line; else appended after a
 * blank line. Nothing to write and nothing to replace leaves the text as it is.
 */
export function patchRules(
  text: string | undefined,
  replace: readonly string[],
  rules: readonly DruRule[]
): string {
  const current = text ?? ''
  const names = new Set(replace)
  const spans = ruleSpans(current).filter((s) => names.has(s.name))
  const written = rules.map(druRuleText).join('\n')
  if (!spans.length) {
    if (!rules.length) return current
    const base = current.trim() ? current : '(version 1)\n'
    return `${base.replace(/\n*$/, '\n')}\n${written}\n`
  }
  let out = ''
  let at = 0
  spans.forEach((span, i) => {
    out += current.slice(at, span.start)
    at = span.end
    if (i === 0 && written) out += written
    // A removed rule takes its line break with it.
    else if (current[at] === '\n') at++
  })
  out += current.slice(at)
  return out.replace(/\n{3,}/g, '\n\n')
}

/** How many top-level rules a piece of text holds: an edit must be exactly one. */
export const ruleCount = (text: string): number => ruleSpans(text).length

/**
 * Put a rule's text, as typed, in place of the rule named `name`, or after the
 * last thing in the file when `name` is null (a new rule). The text may rename
 * the rule. Nothing else in the file changes.
 */
export function writeRuleText(
  text: string | undefined,
  name: string | null,
  ruleText: string
): string {
  const current = text ?? ''
  const typed = ruleText.trim()
  const span = name === null ? undefined : ruleSpans(current).find((s) => s.name === name)
  if (span) return current.slice(0, span.start) + typed + current.slice(span.end)
  const base = current.trim() ? current : '(version 1)\n'
  return `${base.replace(/\n*$/, '\n')}\n${typed}\n`
}
