import { describe, expect, test } from 'vitest'
import type { ToolbarSearchOp } from '../toolSearch'
import { isViewCommand, viewCommandFor, viewCommandOps } from '../viewCommands'

const key = (k: string, mods: Partial<KeyboardEvent> = {}): KeyboardEvent =>
  ({
    key: k,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...mods
  }) as KeyboardEvent

describe('viewCommandFor', () => {
  test('reads KiCad zoom and center keys', () => {
    expect(viewCommandFor(key('=', { ctrlKey: true }))).toBe('zoomIn')
    expect(viewCommandFor(key('+', { metaKey: true, shiftKey: true }))).toBe('zoomIn')
    expect(viewCommandFor(key('-', { ctrlKey: true }))).toBe('zoomOut')
    expect(viewCommandFor(key('F4'))).toBe('centerOnCursor')
  })

  test('leaves the backtick to net highlight', () => {
    expect(viewCommandFor(key('`'))).toBeNull()
    expect(viewCommandFor(key('~', { shiftKey: true }))).toBeNull()
  })

  test('leaves bare + / - to the board layer keys, and zoom to selection unbound', () => {
    expect(viewCommandFor(key('-'))).toBeNull()
    expect(viewCommandFor(key('+'))).toBeNull()
    expect(viewCommandFor(key('0', { ctrlKey: true }))).toBeNull()
  })
})

describe('viewCommandOps', () => {
  const ops = (hasSelection: boolean): ToolbarSearchOp[] => viewCommandOps((k) => k, hasSelection)

  test('lists the camera commands under Navigate', () => {
    expect(ops(true).map((op) => op.id)).toEqual([
      'zoomIn',
      'zoomOut',
      'centerOnCursor',
      'zoomToSelection'
    ])
    expect(ops(true).every((op) => op.group === 'navigate')).toBe(true)
    expect(ops(true).every((op) => isViewCommand(op.id))).toBe(true)
  })

  test('dims zoom to selection with nothing selected, and center on cursor always', () => {
    const disabled = (hasSelection: boolean): string[] =>
      ops(hasSelection)
        .filter((op) => op.disabled)
        .map((op) => op.id)
    expect(disabled(true)).toEqual(['centerOnCursor'])
    expect(disabled(false)).toEqual(['centerOnCursor', 'zoomToSelection'])
  })

  test('shows a hotkey on every bound command only', () => {
    expect(ops(true).find((op) => op.id === 'zoomToSelection')?.hotkey).toBeUndefined()
    expect(ops(true).find((op) => op.id === 'centerOnCursor')?.hotkey).toBe('F4')
  })
})
