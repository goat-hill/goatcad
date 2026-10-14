import { createI18n } from 'vue-i18n'
import en from './locales/en'
import de from './locales/de'
import zhCN from './locales/zh-CN'
import ja from './locales/ja'
import fr from './locales/fr'
import es from './locales/es'
import { pluralRulesFor } from './locales/plurals'

/**
 * Registering a locale here is the only step: `pluralRules` is derived from
 * this map, so a new language gets CLDR-correct plurals without further wiring.
 * Keep in sync with `SUPPORTED_LOCALES` in `src/main/appConfig.ts` — the main
 * process validates the persisted `locale` and cannot import this file.
 * `locales/__tests__` asserts the two agree.
 */
const messages = { en, de, 'zh-CN': zhCN, ja, fr, es }

/**
 * Language names are endonyms — each written in its own language, never
 * translated. Someone who lands in a language they cannot read has to be able
 * to find their way back, which is impossible if this list is localized.
 */
export const LOCALE_NAMES: Record<keyof typeof messages, string> = {
  en: 'English',
  de: 'Deutsch',
  'zh-CN': '简体中文',
  ja: '日本語',
  fr: 'Français',
  es: 'Español'
}

export const i18n = createI18n({
  legacy: false,
  locale: 'en',
  fallbackLocale: 'en',
  globalInjection: false,
  messages,
  pluralRules: pluralRulesFor(Object.keys(messages))
})
