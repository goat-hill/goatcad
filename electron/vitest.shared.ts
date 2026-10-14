import { resolve } from 'path'
import yaml from '@rollup/plugin-yaml'
import type { UserConfig } from 'vitest/config'

/**
 * Config shared by both vitest suites (`vitest.config.ts` and
 * `vitest.i18n.config.ts`). Extracted rather than copied: these loaders drifting
 * apart would make one suite fail in ways the other cannot reproduce.
 *
 * Vitest does not read electron.vite.config.ts, so anything the tests need to
 * import has to be repeated here. Today that is just `yaml`, without which the
 * locale suites cannot load `locales/<lang>/*.yaml` at all.
 */
export const shared: UserConfig = {
  plugins: [yaml()],
  resolve: {
    alias: {
      '@renderer': resolve('src/renderer/src')
    }
  }
}
