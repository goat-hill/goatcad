/**
 * `checks`, which every write takes: the checks are derived work that scales
 * with the design, so a write runs them only when asked
 * (docs/agent-api.md, fast by default). `defineDesignOp` forwards it
 * to the window, so an op only declares it.
 */
import { s } from './schema'

export const checksArg = s
  .boolean()
  .describe(
    "Also run the document's checks and answer with what this write broke or fixed. Off by default; after a burst, call the document's check once instead."
  )
  .optional()

/** `codes`, which every `*.check` takes: a narrower read of the same checks. */
export const codesArg = s
  .array(s.string().trim())
  .min(1)
  .describe(
    'Only findings with these codes, e.g. ["unconnected-pin"]; each answers a row with every finding, uncapped, count 0 when clean. Unknown codes are refused.'
  )
  .optional()
