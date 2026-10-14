/**
 * Shared plumbing for the locale test suites.
 *
 * Split across two suites on purpose (see vitest.config.ts):
 *
 *  - `messages.test.ts` runs on every `npm run test` and checks **correctness** —
 *    things that are wrong in any language, e.g. a malformed message.
 *  - `messages.completeness.test.ts` runs only via `npm run test:i18n` (release)
 *    and checks **completeness** — whether every locale is fully translated.
 *
 * The line matters: an untranslated key is not a bug. vue-i18n falls back to
 * `en`, so the app works and simply shows English. Blocking a feature PR on it
 * would mean every dev needs every language. A *malformed* translation is a bug
 * and blocks everyone.
 *
 * Locales load through `import.meta.glob`, so these read what the bundler
 * actually produces (comments already stripped by the YAML loader) and pick up
 * a new `locales/<lang>/` directory with no edit here.
 */

export type MessageTree = { [key: string]: string | MessageTree }

/** Every locale namespace file, keyed by path e.g. '../en/app.yaml'. */
const namespaceFiles = import.meta.glob<{ default: MessageTree }>('../*/*.yaml', { eager: true })

const parsePath = (path: string): { locale: string; namespace: string } => {
  const [, locale, namespace] = path.match(/\.\.\/([^/]+)\/([^/]+)\.yaml$/) ?? []
  return { locale, namespace }
}

export const localeNames = (): string[] => [
  ...new Set(Object.keys(namespaceFiles).map((path) => parsePath(path).locale))
]

/** Assembles a locale the same way `<locale>/index.ts` does. */
export const loadLocale = (locale: string): MessageTree => {
  const tree: MessageTree = {}
  for (const [path, module] of Object.entries(namespaceFiles)) {
    const parsed = parsePath(path)
    if (parsed.locale === locale) tree[parsed.namespace] = module.default
  }
  return tree
}

export const flatten = (tree: MessageTree, prefix = ''): Map<string, string> => {
  const out = new Map<string, string>()
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (typeof value === 'string') out.set(path, value)
    else for (const [k, v] of flatten(value, path)) out.set(k, v)
  }
  return out
}

/** vue-i18n treats `|` as the plural separator; `{'|'}` is the literal escape. */
export const pluralBranches = (message: string): string[] =>
  message.includes('|') ? message.split('|').map((branch) => branch.trim()) : []

/**
 * A pipe is only legitimate when the message is chosen by a count, which in
 * this codebase always means at least one branch interpolates `{count}`.
 */
export const isDeliberatePlural = (message: string): boolean =>
  pluralBranches(message).some((branch) => branch.includes('{count}'))

export const hasSuspectPipe = (message: string): boolean =>
  message.includes('|') && !message.includes("{'|'}") && !isDeliberatePlural(message)

export const resolvePath = (tree: MessageTree, path: string): string | MessageTree | undefined => {
  let node: string | MessageTree | undefined = tree
  for (const part of path.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined
    node = node[part]
  }
  return node
}
