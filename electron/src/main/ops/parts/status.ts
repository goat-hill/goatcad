/**
 * `parts.status` — the operation an agent should call first.
 */
import { PROVIDER_INFO } from '../../partsProviders'
import { defineOp } from '../registry'
import { s } from '../schema'
import { succeed } from '../errors'
import { PROVIDER_CAPABILITIES, REMEDY } from './shared'

export const partsStatus = defineOp({
  name: 'parts.status',
  scope: 'app',
  mutates: false,
  summary: "Report the connected distributors, each catalog's capabilities, and today's API quota.",
  guidance:
    'Call first in a part-selection task: it says whether category browsing (DigiKey) or keyword search only (Mouser) is available. With nothing connected, tell the user how to connect; do not invent parts.',
  input: s.object({}),
  run(_args, ctx) {
    const statuses = ctx.parts.credentialStatus()
    const usage = ctx.parts.usage()
    const byProvider = new Map(usage.map((entry) => [entry.provider, entry]))

    const providers = statuses.map((status) => {
      const quota = byProvider.get(status.provider)
      return {
        provider: status.provider,
        name: PROVIDER_INFO[status.provider].name,
        configured: status.configured,
        keyHint: status.hint,
        lastVerifiedAt: status.lastVerifiedAt,
        /** False on a Linux box with no keyring: the key is obfuscated, not
         *  encrypted, and the agent should not claim otherwise if asked. */
        encryptionAvailable: status.encryptionAvailable,
        capabilities: PROVIDER_CAPABILITIES[status.provider],
        quota: quota
          ? {
              minute: { used: quota.minute.used, limit: quota.minute.limit },
              day: { used: quota.day.used, limit: quota.day.limit, resetsAt: quota.day.resetsAt }
            }
          : null,
        registrationUrl: PROVIDER_INFO[status.provider].registrationUrl
      }
    })

    const connected = providers.filter((entry) => entry.configured)
    return succeed({
      providers,
      connectedCount: connected.length,
      // Spelled out rather than left for the model to infer from the array:
      // "you can browse categories" is the fact that decides its whole plan.
      canBrowseCategories: connected.some((entry) => entry.capabilities.categoryBrowse),
      guidance:
        connected.length === 0
          ? REMEDY['no-credentials']
          : connected.length === 1
            ? `Only ${connected[0].name} is connected; say a shortlist comes from one catalog.`
            : 'Several distributors are connected. parts_search takes one; confirm a pick at each with parts_compare_mpn, and flag single-sourced candidates.'
    })
  }
})
