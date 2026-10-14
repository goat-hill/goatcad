/**
 * Board Setup's Custom rules: the project's `.kicad_dru` read into one row per
 * rule and constraint, for reading, not editing (custom rules are written in
 * KiCad, or by a standard interface's setup, `rules/druRules.ts`). A row says
 * what the rule applies to and what it holds it to.
 */
import type { ConstraintType, ConstraintValue } from './rules/constraints'
import { parseRules } from './rules/dru'
import { patchRules, ruleCount, writeRuleText } from './rules/druRules'
import { wildcard } from './rules/diffPairs'

export interface CustomRuleRow {
  /** `rule:constraint`, stable while the file is. */
  key: string
  rule: string
  /** The condition as written; empty where the rule applies to everything. */
  appliesTo: string
  layer: string
  constraint: ConstraintType
  /** The limit as a reader writes it: `≤ 2.5 mm`, `0.1–0.2 mm`, `≤ 4`. */
  limit: string
}

const COUNTS: ReadonlySet<ConstraintType> = new Set(['via_count', 'min_resolved_spokes'])

const unitOf = (type: ConstraintType, value: ConstraintValue): string =>
  value.timeDomain ? 'ps' : COUNTS.has(type) ? '' : type === 'track_angle' ? '°' : 'mm'

const num = (n: number): string => `${Math.round(n * 1e4) / 1e4}`

/** A constraint's bounds, the way a limit reads in Board Setup's other tables. */
export function limitText(type: ConstraintType, value: ConstraintValue): string {
  if (value.zoneConnection) return value.zoneConnection
  if (value.disallow !== undefined) return 'disallowed'
  if (value.assertion) return 'assertion'
  const unit = unitOf(type, value)
  const u = unit ? (unit === '°' ? unit : ` ${unit}`) : ''
  const { min, opt, max } = value
  const bounds =
    min !== undefined && max !== undefined
      ? `${num(min)}–${num(max)}${u}`
      : max !== undefined
        ? `≤ ${num(max)}${u}`
        : min !== undefined
          ? `≥ ${num(min)}${u}`
          : opt !== undefined
            ? `${num(opt)}${u}`
            : ''
  return value.withinDiffPairs ? `${bounds}, within each pair` : bounds
}

/** One row per rule and constraint, in the file's order; a file KiCad would discard reads as no rows. */
export function customRuleRows(text: string | undefined): {
  rows: CustomRuleRow[]
  errors: string[]
} {
  if (!text?.trim()) return { rows: [], errors: [] }
  // Conditions are only shown, never evaluated here: any layer and net will do.
  const parsed = parseRules(
    text,
    { layersMatching: () => new Set<string>(), netNames: new Set<string>() },
    []
  )
  const rows = parsed.rules.flatMap((rule) => {
    // A user rule prints as `rule '<name>'`.
    const name = /^rule '(.*)'$/.exec(rule.name)?.[1] ?? rule.name
    return [...rule.constraints].map(([constraint, value]) => ({
      key: `${name}:${constraint}`,
      rule: name,
      appliesTo: rule.conditionText ?? '',
      layer: rule.layerSource ?? '',
      constraint,
      limit: limitText(constraint, value)
    }))
  })
  return { rows, errors: parsed.errors }
}

/** What a rule starts as when one is added: one rule's shape, to edit. */
export const NEW_RULE_TEXT = `(rule "New rule"
\t(condition "A.NetClass == 'Default'")
\t(constraint clearance (min 0.2mm)))`

/**
 * A rule edited as text (Board Setup's Custom rules): the file with it in
 * place, or why not. It must be one rule, and the file must still read as
 * KiCad reads it, since any error would make KiCad drop every rule in it.
 */
export function editCustomRule(
  text: string | undefined,
  name: string | null,
  ruleText: string,
  layers: readonly { name: string; userName?: string }[]
): { ok: true; text: string } | { ok: false; errors: string[] } {
  if (ruleCount(ruleText) !== 1) return { ok: false, errors: ['one-rule'] }
  const next = writeRuleText(text, name, ruleText)
  const parsed = parseRules(
    next,
    {
      layersMatching: (pattern) =>
        new Set(
          layers
            .filter(
              (l) => wildcard(pattern, l.name) || (!!l.userName && wildcard(pattern, l.userName))
            )
            .map((l) => l.name)
        ),
      netNames: new Set<string>()
    },
    layers
  )
  return parsed.errors.length ? { ok: false, errors: parsed.errors } : { ok: true, text: next }
}

/** Remove a rule by name; the rest of the file as it was. */
export const removeCustomRule = (text: string | undefined, name: string): string =>
  patchRules(text, [name], [])
