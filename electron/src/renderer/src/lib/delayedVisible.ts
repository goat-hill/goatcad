/**
 * The loading-indicator delay policy (DESIGN.md §Loading feedback): work that
 * finishes quickly pops in with no indicator at all — a bar that flashes for
 * 80 ms is noise — and only work that outlives `PROGRESS_DELAY_MS` earns one.
 * Once shown, an indicator stays until the work settles; it never blinks off
 * early.
 */

import { onScopeDispose, ref, watch, type Ref } from 'vue'

/** How long work may run before a progress indicator appears, in ms. */
export const PROGRESS_DELAY_MS = 150

/**
 * `true` once `active()` has been continuously true for `delayMs`; `false`
 * again the moment it settles. Use inside a component `setup` (the watcher
 * and timer follow the component's scope).
 */
export function delayedVisible(
  active: () => boolean,
  delayMs = PROGRESS_DELAY_MS
): Readonly<Ref<boolean>> {
  const visible = ref(false)
  let timer: ReturnType<typeof setTimeout> | null = null
  watch(
    active,
    (now) => {
      if (now) {
        if (visible.value || timer !== null) return
        timer = setTimeout(() => {
          timer = null
          if (active()) visible.value = true
        }, delayMs)
      } else {
        if (timer !== null) {
          clearTimeout(timer)
          timer = null
        }
        visible.value = false
      }
    },
    { immediate: true }
  )
  onScopeDispose(() => {
    if (timer !== null) clearTimeout(timer)
  })
  return visible
}
