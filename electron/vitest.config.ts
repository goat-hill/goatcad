import { defineConfig, configDefaults } from 'vitest/config'
import { shared } from './vitest.shared'

/**
 * The default suite: `npm run test`.
 *
 * Three kinds of test are excluded on purpose, each with its own config and its
 * own `bin/` wrapper: the end-to-end suites that drive a real Python
 * interpreter (`vitest.e2e.config.ts`), the parity suites that compare the
 * checkers against an installed KiCad (`vitest.parity.config.ts`, never on CI),
 * and translation completeness.
 *
 * Translation *completeness* is excluded on purpose and lives in
 * `npm run test:i18n` (vitest.i18n.config.ts), which the release workflow gates
 * on. Adding an English string should not fail a feature PR because nobody has
 * translated it yet — vue-i18n falls back to `en`, so the result is correct but
 * untranslated. Everything that would be *wrong* in any language (malformed
 * messages, bad plural branch counts, locale-list drift) still runs here on
 * every commit.
 */
export default defineConfig({
  ...shared,
  test: {
    setupFiles: ['./vitest.setup.ts'],
    exclude: [
      ...configDefaults.exclude,
      '**/*.completeness.test.ts',
      '**/*.e2e.test.ts',
      '**/*.parity.test.ts'
    ]
  }
})
