/**
 * Rule severities as a project sets them: KiCad's own `rule_severities`, keyed
 * by KiCad's violation keys (`board.design_settings.rule_severities` for the
 * DRC, `erc.rule_severities` for the ERC), so a project reads the same in both
 * apps. The catalogs (`board/drcCatalog.ts`, `schematic/ercCatalog.ts`) list
 * every rule KiCad names and which engine codes check it.
 */
import type { CheckResult } from './schematic/checks'

export type RuleSeverity = 'error' | 'warning' | 'ignore'

/** KiCad violation key → severity; a key a project leaves out keeps its default. */
export type SeverityMap = Readonly<Record<string, RuleSeverity>>

export const RULE_SEVERITIES: readonly RuleSeverity[] = ['error', 'warning', 'ignore']

export const isRuleSeverity = (value: unknown): value is RuleSeverity =>
  value === 'error' || value === 'warning' || value === 'ignore'

export interface CatalogRule<Group extends string = string> {
  /** KiCad's violation key, as `rule_severities` spells it. */
  key: string
  group: Group
  /** KiCad's default. */
  severity: RuleSeverity
  /** The engine codes that check it; empty for a rule not checked yet. */
  codes: readonly string[]
  /**
   * Checked though no finding carries its key: it ranks rules that other
   * checks hold items to (KiCad's tuning profiles set track widths).
   */
  ranksOthers?: boolean
  /**
   * The engine grades each finding itself (a pin-conflict matrix, pins that
   * differ versus a drawing that does), so a project can only turn it off.
   */
  graded?: boolean
}

/** What `applySeverities` needs to know of the rule an engine code belongs to. */
export type RuleOf = (
  code: string
) => (Pick<CatalogRule, 'key' | 'graded'> & { severity?: RuleSeverity }) | undefined

/** Whether the engines check a rule at all. */
export const isChecked = (rule: CatalogRule): boolean => rule.codes.length > 0 || !!rule.ranksOthers

/** A catalog's rules by the engine codes that check them. */
export const rulesByCode = <G extends string>(
  catalog: readonly CatalogRule<G>[]
): ReadonlyMap<string, CatalogRule<G>> => {
  const byCode = new Map<string, CatalogRule<G>>()
  for (const rule of catalog) for (const code of rule.codes) byCode.set(code, rule)
  return byCode
}

/** A rule's severity in a project: its setting, else KiCad's default. */
export const effectiveSeverity = (rule: CatalogRule, severities: SeverityMap): RuleSeverity =>
  severities[rule.key] ?? rule.severity

/**
 * The findings as the project ranks them: an ignored rule's are dropped, and
 * the rest take the project's severity — except a graded rule's, which keep
 * the engine's. A code no catalog rule names passes through. Where the rule
 * that decided a finding sets its own severity, that outranks the project's,
 * as KiCad ranks a marker; a check the project turns off stays off, whatever
 * its rules say, and a rule's `exclusion` marks the finding excluded.
 */
export const applySeverities = (
  results: CheckResult[],
  ruleOf: RuleOf,
  severities: SeverityMap
): CheckResult[] => {
  const out: CheckResult[] = []
  for (const result of results) {
    const rule = ruleOf(result.code)
    // A rule KiCad leaves off by default stays off until the project turns it on.
    const severity = rule
      ? (severities[rule.key] ?? (rule.severity === 'ignore' ? 'ignore' : undefined))
      : undefined
    if (severity === 'ignore') continue
    const own = result.ruleSeverity
    if (own === 'ignore') continue
    if (own === 'exclusion') out.push({ ...result, excluded: { comment: '', exclusion: '' } })
    else if (own) out.push(own === result.severity ? result : { ...result, severity: own })
    else if (!rule || severity === undefined) out.push(result)
    else if (rule.graded || severity === result.severity) out.push(result)
    else out.push({ ...result, severity })
  }
  return out
}
