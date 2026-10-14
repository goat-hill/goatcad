/**
 * Which agent CLI the activity bar's agent button launches — Claude Code or
 * Codex, chosen in Settings ▸ AI Integrations.
 *
 * Modeled on `symbolView.ts`: the choice lives in the main-process config store
 * so every window agrees (RULES.md §8), reads fall back to the default until
 * the first load lands, and a missing bridge degrades to an in-memory copy.
 */

import { computed, ref, type ComputedRef } from 'vue'
import type { AgentKind } from '../../../preload/terminalTypes'

export type { AgentKind }

export const DEFAULT_AGENT: AgentKind = 'claude'

const store = ref<AgentKind>(DEFAULT_AGENT)

let loading: Promise<void> | null = null

const api = (): typeof window.api | null =>
  typeof window !== 'undefined' && window.api ? window.api : null

/** Load once per window and keep in step with other windows. Idempotent. */
export function loadAgentPreference(): Promise<void> {
  if (loading) return loading
  const bridge = api()
  if (!bridge) return (loading = Promise.resolve())
  loading = bridge
    .getConfig()
    .then((config) => {
      store.value = config.agent
    })
    .catch(() => {
      // An unreadable config keeps the default; the button still launches.
    })
  bridge.onConfigChanged((config) => {
    store.value = config.agent
  })
  return loading
}

/** The live choice. Reads are the default until the first load lands. */
export function agentPreference(): ComputedRef<AgentKind> {
  void loadAgentPreference()
  return computed(() => store.value)
}

/** Choose the agent and persist it. */
export function setAgentPreference(next: AgentKind): void {
  store.value = next
  const bridge = api()
  if (bridge) void bridge.updateConfig({ agent: next })
}

/** Test seam: drop the loaded state so a suite can start from the default. */
export function __resetAgentPreferenceStore(): void {
  store.value = DEFAULT_AGENT
  loading = null
}
