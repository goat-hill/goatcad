import { defineConfig } from 'vitest/config'
import { shared } from './vitest.shared'

/**
 * `npm run test:i18n` — the translation-completeness suite the release workflow
 * gates on, and the one to run when filling a language in. Failures name the
 * exact missing keys.
 *
 * Kept out of the default suite so day-to-day work is never blocked on
 * translations; see vitest.config.ts for why the line sits where it does.
 */
export default defineConfig({
  ...shared,
  test: {
    include: ['**/*.completeness.test.ts']
  }
})
