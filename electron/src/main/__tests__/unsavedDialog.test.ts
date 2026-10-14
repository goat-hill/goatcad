import { describe, it, expect } from 'vitest'
import { unsavedButtonOrder } from '../unsavedDialog'

describe('unsavedButtonOrder', () => {
  const platforms: NodeJS.Platform[] = ['linux', 'darwin', 'win32']

  it('offers all three choices exactly once everywhere', () => {
    for (const platform of platforms) {
      expect([...unsavedButtonOrder(platform)].sort()).toEqual(['cancel', 'dontSave', 'save'])
    }
  })

  it('reads Save / Don’t Save / Cancel on Windows', () => {
    expect(unsavedButtonOrder('win32')).toEqual(['save', 'dontSave', 'cancel'])
  })

  it('puts the discard verb first on GTK, where buttons render in array order', () => {
    expect(unsavedButtonOrder('linux')).toEqual(['dontSave', 'cancel', 'save'])
  })

  // Electron renders macOS buttons right-to-left, so the array is the reverse of
  // what the user sees — which is the same reading order GTK gets.
  it('mirrors the GTK order on macOS', () => {
    expect([...unsavedButtonOrder('darwin')].reverse()).toEqual(unsavedButtonOrder('linux'))
  })

  // Save is the default and Cancel the escape hatch on every platform; the
  // dialog derives defaultId/cancelId by index, so both must always be present.
  it('keeps Save and Cancel findable for defaultId and cancelId', () => {
    for (const platform of platforms) {
      const order = unsavedButtonOrder(platform)
      expect(order.indexOf('save')).toBeGreaterThanOrEqual(0)
      expect(order.indexOf('cancel')).toBeGreaterThanOrEqual(0)
    }
  })

  it('falls back to the GTK order on unknown platforms', () => {
    expect(unsavedButtonOrder('freebsd')).toEqual(unsavedButtonOrder('linux'))
  })
})
