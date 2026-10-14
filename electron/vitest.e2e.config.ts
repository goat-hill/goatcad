import { defineConfig } from 'vitest/config'
import { shared } from './vitest.shared'

/**
 * `npm run test:e2e` — the suites that drive a real external interpreter.
 *
 * Kept out of the default suite because they are integration tests wearing unit
 * tests' clothes: they spawn Python subprocesses against a server running on
 * this thread, so they are slow, they depend on what is installed on the
 * machine, and the subprocess must stay asynchronous or the two deadlock (see
 * the header of pythonClient.e2e.test.ts).
 */
export default defineConfig({
  ...shared,
  test: {
    setupFiles: ['./vitest.setup.ts'],
    include: ['**/*.e2e.test.ts']
  }
})
