/**
 * Which GPU the WebGL canvases ask for — Settings ▸ Appearance.
 *
 * Modeled on `agentPreference.ts`: the choice lives in the main-process config
 * store so every window agrees (RULES.md §8). A WebGL context fixes its power
 * preference at creation, so a change reaches each canvas the next time it is
 * created — every editor is rebuilt on a tab switch (ARCHITECTURE.md §3.2).
 */

import { computed, ref, type ComputedRef } from 'vue'
import type { GpuPowerPreference } from '../../../preload/gpuTypes'

export type { GpuPowerPreference }

export const GPU_POWER_PREFERENCES: GpuPowerPreference[] = [
  'default',
  'low-power',
  'high-performance'
]

/** Duplicated in main/appConfig.ts's defaultConfig. */
export const DEFAULT_GPU_POWER_PREFERENCE: GpuPowerPreference = 'default'

const store = ref<GpuPowerPreference>(DEFAULT_GPU_POWER_PREFERENCE)

let loading: Promise<void> | null = null

const api = (): typeof window.api | null =>
  typeof window !== 'undefined' && window.api ? window.api : null

/**
 * Load once per window and keep in step with other windows. Idempotent. App
 * boot awaits it, so the first canvas a restored session draws already has it.
 */
export function loadGpuPreference(): Promise<void> {
  if (loading) return loading
  const bridge = api()
  if (!bridge) return (loading = Promise.resolve())
  loading = bridge
    .getConfig()
    .then((config) => {
      store.value = config.gpuPowerPreference
    })
    .catch(() => {
      // An unreadable config keeps the browser's default GPU choice.
    })
  bridge.onConfigChanged((config) => {
    store.value = config.gpuPowerPreference
  })
  return loading
}

/** The live choice, for the Settings control. */
export function gpuPreference(): ComputedRef<GpuPowerPreference> {
  void loadGpuPreference()
  return computed(() => store.value)
}

/** The value to hand a `WebGLRenderer` being created now. */
export function gpuPowerPreference(): GpuPowerPreference {
  return store.value
}

/** Choose the GPU preference and persist it. */
export function setGpuPreference(next: GpuPowerPreference): void {
  store.value = next
  const bridge = api()
  if (bridge) void bridge.updateConfig({ gpuPowerPreference: next })
}
