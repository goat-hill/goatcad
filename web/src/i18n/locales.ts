/**
 * The landing page's languages — the app's launch set (docs/MILESTONES.md).
 * Only the landing page is translated; docs and privacy stay English
 * (docs/WEB.md §3), so the switcher appears only where a page has every
 * language.
 *
 * English lives at `/`, every other language under its own prefix. There is no
 * redirect by browser language or IP: a visitor lands on the URL they asked for
 * and picks a language from the switcher.
 */
export const LOCALES = ['en', 'de', 'zh-CN', 'ja', 'fr', 'es'] as const

export type Locale = (typeof LOCALES)[number]

export const DEFAULT_LOCALE: Locale = 'en'

/**
 * localStorage key for the language a visitor picked in the switcher — only an
 * explicit pick, never a page they happened to land on. Read before paint on
 * `/` (Base.astro) and by the logo on English-only pages (Nav.astro).
 */
export const LOCALE_STORAGE_KEY = 'goatcad-locale'

/**
 * Endonyms, never translated: a visitor stranded in a language they cannot read
 * has to be able to find their own in the switcher. Same rule as the app's
 * LOCALE_NAMES.
 */
export const LOCALE_NAMES: Record<Locale, string> = {
  en: 'English',
  de: 'Deutsch',
  'zh-CN': '简体中文',
  ja: '日本語',
  fr: 'Français',
  es: 'Español'
}

/** URL segment: lowercase, as URLs conventionally are. */
const SEGMENTS: Record<Locale, string> = {
  en: '',
  de: 'de',
  'zh-CN': 'zh-cn',
  ja: 'ja',
  fr: 'fr',
  es: 'es'
}

/** `og:locale` wants language_TERRITORY. */
export const OG_LOCALES: Record<Locale, string> = {
  en: 'en_US',
  de: 'de_DE',
  'zh-CN': 'zh_CN',
  ja: 'ja_JP',
  fr: 'fr_FR',
  es: 'es_ES'
}

export const isLocale = (value: unknown): value is Locale =>
  typeof value === 'string' && (LOCALES as readonly string[]).includes(value)

/** The home page's path in `locale`: `/` for English, `/de/` and so on otherwise. */
export const homePath = (locale: Locale): string =>
  SEGMENTS[locale] ? `/${SEGMENTS[locale]}/` : '/'

/** Every locale's home path, for the inline scripts that cannot import this module. */
export const homePaths = (): Record<Locale, string> =>
  Object.fromEntries(LOCALES.map((locale) => [locale, homePath(locale)])) as Record<Locale, string>

/** The locales that live under a prefix, with their segment — for getStaticPaths. */
export const prefixedLocales = (): { locale: Locale; segment: string }[] =>
  LOCALES.filter((locale) => SEGMENTS[locale]).map((locale) => ({
    locale,
    segment: SEGMENTS[locale]
  }))
