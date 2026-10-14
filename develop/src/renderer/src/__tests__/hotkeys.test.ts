import { describe, expect, it } from 'vitest'
import { matchHotkey, matchTerminalClipboard } from '../hotkeys'

const keyEvent = (overrides: Partial<KeyboardEvent>): KeyboardEvent =>
  ({
    altKey: false,
    code: '',
    ctrlKey: true,
    key: '',
    metaKey: false,
    shiftKey: false,
    ...overrides
  }) as KeyboardEvent

describe('matchHotkey', () => {
  it('maps numbered tabs and shifted commands', () => {
    expect(matchHotkey(keyEvent({ key: '3' }))).toEqual({ id: 'tab', index: 2 })
    expect(matchHotkey(keyEvent({ code: 'KeyL', shiftKey: true }))).toEqual({ id: 'claude' })
  })

  it('rejects unmodified, alternate, and unknown events', () => {
    expect(matchHotkey(keyEvent({ ctrlKey: false, key: '1' }))).toBeNull()
    expect(matchHotkey(keyEvent({ altKey: true, code: 'KeyL', shiftKey: true }))).toBeNull()
    expect(matchHotkey(keyEvent({ code: 'KeyQ', shiftKey: true }))).toBeNull()
  })
})

describe('matchTerminalClipboard', () => {
  it('takes Ctrl+Shift+C/V and the Insert pair off macOS', () => {
    expect(matchTerminalClipboard(keyEvent({ code: 'KeyC', shiftKey: true }), false)).toBe('copy')
    expect(matchTerminalClipboard(keyEvent({ code: 'KeyV', shiftKey: true }), false)).toBe('paste')
    expect(matchTerminalClipboard(keyEvent({ code: 'Insert' }), false)).toBe('copy')
    expect(
      matchTerminalClipboard(keyEvent({ code: 'Insert', ctrlKey: false, shiftKey: true }), false)
    ).toBe('paste')
  })

  it('leaves the shell its own control keys', () => {
    // Ctrl+C is SIGINT and Ctrl+V is literal-next: both must reach the pty.
    expect(matchTerminalClipboard(keyEvent({ code: 'KeyC' }), false)).toBeNull()
    expect(matchTerminalClipboard(keyEvent({ code: 'KeyV' }), false)).toBeNull()
    expect(matchTerminalClipboard(keyEvent({ code: 'Insert', shiftKey: true }), false)).toBeNull()
  })

  it('uses the plain Command combos on macOS', () => {
    const cmd = { ctrlKey: false, metaKey: true }
    expect(matchTerminalClipboard(keyEvent({ ...cmd, code: 'KeyC' }), true)).toBe('copy')
    expect(matchTerminalClipboard(keyEvent({ ...cmd, code: 'KeyV' }), true)).toBe('paste')
    expect(matchTerminalClipboard(keyEvent({ ...cmd, code: 'KeyA' }), true)).toBe('selectAll')
    expect(matchTerminalClipboard(keyEvent({ code: 'KeyC', shiftKey: true }), true)).toBeNull()
  })

  it('never claims a combo the app or the shell already owns', () => {
    // Ctrl+Shift+A is the GoatCAD dev server, so Select All stays menu-only here.
    expect(matchTerminalClipboard(keyEvent({ code: 'KeyA', shiftKey: true }), false)).toBeNull()
    expect(
      matchTerminalClipboard(keyEvent({ code: 'KeyC', shiftKey: true, altKey: true }), false)
    ).toBeNull()
  })
})
