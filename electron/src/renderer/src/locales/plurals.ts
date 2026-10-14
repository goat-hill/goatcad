import type { PluralizationRule } from 'vue-i18n'

/**
 * CLDR-correct pluralisation, derived from the platform's own `Intl.PluralRules`
 * rather than a hand-maintained per-language table.
 *
 * vue-i18n's built-in rule is English-shaped: two branches picked by
 * `count === 1`. That is wrong nearly everywhere else — Russian needs three
 * forms for cardinals (2–4 differ from 5+), Arabic six, and even French needs
 * three. Registering a rule per locale keeps a message's pipe-branch order
 * meaningful in every language.
 *
 * The contract for translators: **write branches in CLDR category order**, and
 * write exactly as many as the locale uses (`pluralBranchCount`). For `en` that
 * is `one | other`; for `ru`, `one | few | many | other`.
 *
 * Consequence worth knowing: this gives up vue-i18n's English-only 3-branch
 * idiom (`no items | one item | {count} items`), where index 0 doubles as zero.
 * CLDR `en` has no `zero` category, so that third branch would be unreachable.
 * Express a zero case as its own message instead. `locales/__tests__` enforces
 * the branch count per locale, so a stray extra branch fails rather than
 * silently never rendering.
 */

/** CLDR's canonical category order. Branch order within a message follows this. */
const CLDR_ORDER = ['zero', 'one', 'two', 'few', 'many', 'other'] as const

export type PluralCategory = (typeof CLDR_ORDER)[number]

/**
 * The plural categories `locale` actually uses, in CLDR order.
 * `en` → `['one', 'other']`, `ru` → `['one', 'few', 'many', 'other']`.
 */
export const pluralCategories = (locale: string): PluralCategory[] => {
  const used = new Set<string>(new Intl.PluralRules(locale).resolvedOptions().pluralCategories)
  return CLDR_ORDER.filter((category) => used.has(category))
}

/** How many branches a plural message must have in `locale`. */
export const pluralBranchCount = (locale: string): number => pluralCategories(locale).length

/** Maps a count to its branch index for `locale`, for vue-i18n's `pluralRules`. */
export const pluralRuleFor = (locale: string): PluralizationRule => {
  const rules = new Intl.PluralRules(locale)
  const categories = pluralCategories(locale)
  return (choice: number, choicesLength: number): number => {
    const index = categories.indexOf(rules.select(choice) as PluralCategory)
    // A message with the wrong branch count is a locale-data bug, not a reason
    // to throw mid-render: clamp to the last branch and let the test be what
    // fails. `indexOf` can only miss if Intl reports a category outside CLDR.
    if (index < 0) return Math.max(choicesLength - 1, 0)
    return Math.min(index, Math.max(choicesLength - 1, 0))
  }
}

/** `pluralRules` for `createI18n`, keyed by locale. */
export const pluralRulesFor = (locales: string[]): Record<string, PluralizationRule> =>
  Object.fromEntries(locales.map((locale) => [locale, pluralRuleFor(locale)]))
