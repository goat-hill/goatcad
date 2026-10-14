import { defineConfig } from 'vitest/config'
import { shared } from './vitest.shared'

/**
 * `npm run test:parity` — the checkers against an installed KiCad
 * (`src/renderer/src/lib/__tests__/kicadParity.ts` finds it).
 *
 * Out of the default suite and never on CI: it needs KiCad on the machine and
 * runs `kicad-cli` over KiCad's whole library, which takes minutes. Without
 * KiCad it fails: a run that compared nothing must not read as passed.
 */
export default defineConfig({
  ...shared,
  test: {
    setupFiles: ['./vitest.setup.ts'],
    include: ['**/*.parity.test.ts'],
    // Each board as it finishes, with its time: a run stopped part way still says how far it got.
    reporters: ['verbose']
  }
})
