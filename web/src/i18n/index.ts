import { PRODUCT_NAME } from '../brand'
import { type Locale } from './locales'
import { en, type Strings } from './strings/en'
import { de } from './strings/de'
import { zhCN } from './strings/zh-CN'
import { ja } from './strings/ja'
import { fr } from './strings/fr'
import { es } from './strings/es'

export * from './locales'

const STRINGS: Record<Locale, Strings> = { en, de, 'zh-CN': zhCN, ja, fr, es }

/** The landing page's copy in `locale`. Everything is resolved at build time. */
export const strings = (locale: Locale): Strings => STRINGS[locale]

/** Fills `{name}` placeholders; `{product}` is always the product name. */
export const fmt = (message: string, values: Record<string, string> = {}): string =>
  message.replace(/\{(\w+)\}/g, (match, name: string) =>
    name === 'product' ? PRODUCT_NAME : (values[name] ?? match)
  )

/**
 * Display width in `ch`, for the agent demo's typed prompt, which reveals the
 * prompt by widening a box in `ch` steps: a CJK character takes about two.
 */
export const displayWidth = (text: string): number =>
  [...text].reduce((width, char) => width + (WIDE.test(char) ? 2 : 1), 0)

/** Han, kana, Hangul, and the CJK and full-width punctuation around them. */
const WIDE =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}　-〿！-｠￠-￦]/u
