import { describe, expect, test } from 'vitest'
import { nextTick } from 'vue'
import { rememberedRef, takeRequest } from '../paneMemory'

describe('pane memory', () => {
  test('a pane mounted again starts where it was left; no key forgets', async () => {
    const first = rememberedRef('test-pane', 'stackup')
    first.value = 'netClasses'
    await nextTick()
    expect(rememberedRef('test-pane', 'stackup').value).toBe('netClasses')
    expect(rememberedRef('other-pane', 'stackup').value).toBe('stackup')
    expect(rememberedRef(undefined, 'stackup').value).toBe('stackup')
  })

  test('a request is shown once, not again on remount', () => {
    expect(takeRequest('test-request', 1)).toBe(true)
    expect(takeRequest('test-request', 1)).toBe(false)
    expect(takeRequest('test-request', 2)).toBe(true)
  })
})
