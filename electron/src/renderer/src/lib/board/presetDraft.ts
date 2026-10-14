/**
 * An interface preset as a draft in Board Setup: its plan laid over the
 * page's model, so every table shows what Apply would write in place, each
 * row marked added or edited (Net classes, Assignments, Tuning profiles,
 * Custom rules). Nothing is written until Apply; Discard drops the overlay.
 */
import type { BoardSetupModel } from './boardSetupSchema'
import { presetRuleNames, type PresetPlan } from './interfacePresets'
import { druRuleText, patchRules, ruleNamesIn, ruleTextIn } from './rules/druRules'

export type PendingState = 'added' | 'edited'

/** What a preset's solve reads besides its choices, as the draft shows it read only. */
export interface PresetInputs {
  copperLayers: number
  boardThickness: number
  minTrackWidth: number
  minClearance: number
  /** The Default class's clearance: where a derived gap starts. */
  defaultClearance: number
  /** Each solved layer's dielectric: its references, heights (mm), εr and copper. */
  layers: Array<{
    layer: string
    references: string
    heights: string
    epsilonR: number
    copperMm: number
  }>
}

/** What a draft adds or changes, by where each piece shows. */
export interface PresetPending {
  /** The class the preset sets up. */
  netClass: string
  classes: ReadonlyMap<string, PendingState>
  /** Indices into the previewed pattern list. */
  patterns: ReadonlySet<number>
  profiles: ReadonlyMap<string, PendingState>
  /** By rule name. */
  rules: ReadonlyMap<string, PendingState>
}

export interface PresetPreview {
  model: BoardSetupModel
  rulesText: string
  pending: PresetPending
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/** The page as Apply would leave it, and which rows that changes. */
export function previewPreset(
  model: BoardSetupModel,
  rulesText: string | undefined,
  plan: PresetPlan
): PresetPreview {
  const key = plan.profileName
  const classes = new Map<string, PendingState>()
  for (const next of plan.classes) {
    const before = model.classes.find((c) => c.name === next.name)
    if (!before) classes.set(next.name, 'added')
    else if (!same(before, next)) classes.set(next.name, 'edited')
  }
  const patterns = new Set<number>()
  plan.patterns.forEach((p, i) => {
    if (!model.patterns.some((q) => q.pattern === p.pattern && q.netClass === p.netClass))
      patterns.add(i)
  })
  const profiles = new Map<string, PendingState>()
  for (const next of plan.tuningProfiles) {
    const before = model.tuningProfiles.find((p) => p.name === next.name)
    if (!before) profiles.set(next.name, 'added')
    else if (!same(before, next)) profiles.set(next.name, 'edited')
  }
  const names = presetRuleNames(key)
  const nextText = patchRules(rulesText, names, plan.rules)
  const had = new Set(ruleNamesIn(rulesText))
  const rules = new Map<string, PendingState>()
  for (const rule of plan.rules) {
    if (!had.has(rule.name)) rules.set(rule.name, 'added')
    else if (ruleTextIn(rulesText, rule.name) !== druRuleText(rule)) rules.set(rule.name, 'edited')
  }
  return {
    model: {
      ...model,
      tuningProfiles: plan.tuningProfiles,
      classes: plan.classes,
      patterns: plan.patterns,
      edited: true
    },
    rulesText: nextText,
    pending: { netClass: key, classes, patterns, profiles, rules }
  }
}
