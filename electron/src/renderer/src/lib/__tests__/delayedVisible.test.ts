import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { effectScope, nextTick, ref, type Ref } from 'vue'
import { PROGRESS_DELAY_MS, delayedVisible } from '../delayedVisible'

/** `delayedVisible` under a scope, plus the source that drives it. */
const mount = (): { active: Ref<boolean>; visible: Ref<boolean>; stop: () => void } => {
  const active = ref(false)
  const scope = effectScope()
  const visible = scope.run(() => delayedVisible(() => active.value)) as Ref<boolean>
  return { active, visible, stop: () => scope.stop() }
}

describe('delayedVisible', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  test('stays hidden for work that settles inside the delay', async () => {
    const { active, visible, stop } = mount()
    active.value = true
    await nextTick()
    vi.advanceTimersByTime(PROGRESS_DELAY_MS - 1)
    active.value = false
    await nextTick()
    vi.advanceTimersByTime(PROGRESS_DELAY_MS)
    expect(visible.value).toBe(false)
    stop()
  })

  test('appears once work outlives the delay, and only then', async () => {
    const { active, visible, stop } = mount()
    active.value = true
    await nextTick()
    vi.advanceTimersByTime(PROGRESS_DELAY_MS - 1)
    expect(visible.value).toBe(false)
    vi.advanceTimersByTime(1)
    expect(visible.value).toBe(true)
    stop()
  })

  test('hides the moment the work settles', async () => {
    const { active, visible, stop } = mount()
    active.value = true
    await nextTick()
    vi.advanceTimersByTime(PROGRESS_DELAY_MS)
    expect(visible.value).toBe(true)
    active.value = false
    await nextTick()
    expect(visible.value).toBe(false)
    stop()
  })

  test('a lull that never reaches the delay does not re-arm into a flash', async () => {
    // Two short bursts back to back: neither earns an indicator, and the
    // second must not inherit the first one's elapsed time.
    const { active, visible, stop } = mount()
    for (let i = 0; i < 2; i++) {
      active.value = true
      await nextTick()
      vi.advanceTimersByTime(PROGRESS_DELAY_MS - 10)
      active.value = false
      await nextTick()
      vi.advanceTimersByTime(5)
    }
    expect(visible.value).toBe(false)
    stop()
  })

  test('leaves no timer behind when its scope is disposed', async () => {
    const { active, visible, stop } = mount()
    active.value = true
    await nextTick()
    stop()
    vi.advanceTimersByTime(PROGRESS_DELAY_MS * 2)
    expect(visible.value).toBe(false)
  })
})
