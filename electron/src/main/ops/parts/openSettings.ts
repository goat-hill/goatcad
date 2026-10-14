/**
 * `parts.open_settings` — the one action that is not an edit.
 */
import { PROVIDER_IDS } from '../../partsProviders'
import { defineOp } from '../registry'
import { s } from '../schema'
import { succeed } from '../errors'

export const partsOpenSettings = defineOp({
  name: 'parts.open_settings',
  scope: 'app',
  mutates: false,
  summary: "Open GoatCAD's Distributor APIs settings so the user can paste an API key.",
  guidance:
    'Use after no-credentials or invalid-credentials. Keys cannot be set through this interface.',
  input: s.object({
    provider: s.enum(PROVIDER_IDS).describe('Provider to focus.').optional()
  }),
  run(args, ctx) {
    const provider = args.provider ?? null
    ctx.emit?.({ kind: 'open-settings', provider })
    return succeed({
      opened: true,
      provider,
      note: 'Settings are open. Ask the user to say when the key is saved, then call parts_status.'
    })
  }
})
