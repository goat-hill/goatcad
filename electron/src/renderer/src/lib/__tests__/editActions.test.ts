import { describe, expect, it } from 'vitest'
import { buildEditMenu, isEditActionId, type EditActionGroup } from '../editActions'
import { hotkeyLabel } from '../hotkeys'
import { isDivider, type MenuItem, type MenuNode } from '../menu'

const GROUPS: EditActionGroup[] = [
  [
    { hotkey: 'editor.undo', label: 'Undo', enabled: true },
    { hotkey: 'editor.redo', label: 'Redo', enabled: false }
  ],
  [
    { hotkey: 'symbol.copy', label: 'Copy', enabled: true },
    { hotkey: 'symbol.paste', label: 'Paste', enabled: false }
  ]
]

const items = (nodes: MenuNode[]): MenuItem[] => nodes.filter((n): n is MenuItem => !isDivider(n))

describe('buildEditMenu', () => {
  it('names each row by its hotkey, so selection can replay the key', () => {
    expect(items(buildEditMenu(GROUPS)).map((i) => i.id)).toEqual([
      'editor.undo',
      'editor.redo',
      'symbol.copy',
      'symbol.paste'
    ])
  })

  it('fills the shortcut column from the hotkey registry', () => {
    const copy = items(buildEditMenu(GROUPS)).find((i) => i.id === 'symbol.copy')!
    expect(copy.shortcut).toBe(hotkeyLabel('symbol.copy'))
    expect(copy.shortcut).toBeTruthy()
  })

  it('marks unavailable commands disabled rather than dropping them', () => {
    const built = items(buildEditMenu(GROUPS))
    // A command you cannot run right now still has to be visible — that is the
    // whole point of putting it in a menu.
    expect(built.find((i) => i.id === 'symbol.paste')?.disabled).toBe(true)
    expect(built.find((i) => i.id === 'symbol.copy')?.disabled).toBe(false)
  })

  it('separates groups with exactly one divider, and none at the edges', () => {
    const nodes = buildEditMenu(GROUPS)
    expect(nodes.filter(isDivider)).toHaveLength(1)
    expect(isDivider(nodes[0])).toBe(false)
    expect(isDivider(nodes[nodes.length - 1])).toBe(false)
  })

  it('drops empty groups instead of emitting a stray divider', () => {
    const nodes = buildEditMenu([[], GROUPS[0], [], GROUPS[1], []])
    expect(nodes.filter(isDivider)).toHaveLength(1)
    expect(buildEditMenu([[], []])).toEqual([])
  })
})

describe('isEditActionId', () => {
  it('recognizes published commands and rejects other menu ids', () => {
    expect(isEditActionId(GROUPS, 'symbol.copy')).toBe(true)
    expect(isEditActionId(GROUPS, 'new:board')).toBe(false)
    expect(isEditActionId([], 'symbol.copy')).toBe(false)
  })
})
