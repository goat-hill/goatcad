import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { effectScope } from 'vue'
import { focusInModal, useModalKeys } from '../modalKeys'

/** A keydown on the window, as one with nothing focused arrives. */
const press = (key: string, init: Partial<KeyboardEvent> = {}): void => {
  const event = Object.assign(new Event('keydown', { cancelable: true }), {
    key,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    isComposing: false,
    ...init
  })
  window.dispatchEvent(event)
}

/** A modal's keys under a scope, standing in for its component's life. */
const open = (keys: Parameters<typeof useModalKeys>[0]): (() => void) => {
  const scope = effectScope()
  scope.run(() => useModalKeys(keys))
  return () => scope.stop()
}

describe('useModalKeys', () => {
  beforeEach(() => vi.stubGlobal('window', new EventTarget()))
  afterEach(() => vi.unstubAllGlobals())

  test('Escape dismisses and Enter confirms while nothing in the modal has focus', () => {
    const dismiss = vi.fn()
    const confirm = vi.fn()
    const close = open({ dismiss, confirm })
    press('Enter')
    press('Escape')
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(dismiss).toHaveBeenCalledTimes(1)
    close()
    press('Enter')
    expect(confirm).toHaveBeenCalledTimes(1)
  })

  test('only the topmost modal hears the keys, and the one below again once it closes', () => {
    const below = vi.fn()
    const above = vi.fn()
    const closeBelow = open({ dismiss: () => {}, confirm: below })
    const closeAbove = open({ dismiss: () => {}, confirm: above })
    press('Enter')
    expect([above.mock.calls.length, below.mock.calls.length]).toEqual([1, 0])
    closeAbove()
    press('Enter')
    expect(below).toHaveBeenCalledTimes(1)
    closeBelow()
  })

  test('a modal hidden under one it opened hears nothing; a modifier or IME Enter is not a confirm', () => {
    const confirm = vi.fn()
    let paused = true
    const close = open({ dismiss: () => {}, confirm, active: () => !paused })
    press('Enter')
    paused = false
    press('Enter', { ctrlKey: true })
    press('Enter', { isComposing: true })
    expect(confirm).not.toHaveBeenCalled()
    press('Enter')
    expect(confirm).toHaveBeenCalledTimes(1)
    close()
  })
})

describe('focusInModal', () => {
  afterEach(() => vi.unstubAllGlobals())

  test('is true only for an element inside an aria-modal dialog', () => {
    class FakeElement {
      constructor(private readonly inModal: boolean) {}
      closest(selector: string): object | null {
        return selector === '[aria-modal="true"]' && this.inModal ? {} : null
      }
    }
    vi.stubGlobal('Element', FakeElement)
    expect(focusInModal(new FakeElement(true) as unknown as Element)).toBe(true)
    expect(focusInModal(new FakeElement(false) as unknown as Element)).toBe(false)
    expect(focusInModal(null)).toBe(false)
  })
})
