import { describe, expect, it } from 'vitest'
import {
  activate,
  createLayout,
  focusedGroup,
  pathsOf,
  reconcile,
  renamePath,
  restoreLayout,
  saveLayout,
  sendToOtherGroup,
  setRatio,
  SPLIT_RATIO_MAX
} from '../editorGroups'

const open = (paths: string[], active: string): ReturnType<typeof createLayout> => {
  const layout = createLayout()
  reconcile(layout, paths)
  activate(layout, active)
  return layout
}

describe('editorGroups', () => {
  it('puts new tabs in the focused group and shows the first one', () => {
    const layout = createLayout()
    reconcile(layout, ['a', 'b'])
    expect(layout.groups).toHaveLength(1)
    expect(focusedGroup(layout).activeTabPath).toBe('a')
  })

  it('shows the left neighbor when the front tab closes', () => {
    const layout = open(['a', 'b', 'c'], 'c')
    reconcile(layout, ['a', 'b'])
    expect(focusedGroup(layout).activeTabPath).toBe('b')
  })

  it('refuses to split a lone tab', () => {
    const layout = open(['a'], 'a')
    expect(sendToOtherGroup(layout, 'a', ['a'])).toBe(false)
    expect(layout.groups).toHaveLength(1)
  })

  it('splits the active tab into a second, focused group', () => {
    const paths = ['a', 'b', 'c']
    const layout = open(paths, 'b')
    expect(sendToOtherGroup(layout, 'b', paths)).toBe(true)
    reconcile(layout, paths)
    const [first, second] = layout.groups
    expect(pathsOf(layout, paths, first.id)).toEqual(['a', 'c'])
    expect(pathsOf(layout, paths, second.id)).toEqual(['b'])
    expect(first.activeTabPath).toBe('a')
    expect(layout.focusedGroupId).toBe(second.id)
  })

  it('never opens a third group: a second send crosses back', () => {
    const paths = ['a', 'b', 'c']
    const layout = open(paths, 'b')
    sendToOtherGroup(layout, 'b', paths)
    reconcile(layout, paths)
    sendToOtherGroup(layout, 'c', paths)
    reconcile(layout, paths)
    expect(layout.groups).toHaveLength(2)
    expect(pathsOf(layout, paths, layout.groups[1].id)).toEqual(['b', 'c'])
  })

  it('closes a group when its last tab leaves, and refocuses', () => {
    const paths = ['a', 'b']
    const layout = open(paths, 'b')
    sendToOtherGroup(layout, 'b', paths)
    reconcile(layout, paths)
    reconcile(layout, ['a'])
    expect(layout.groups).toHaveLength(1)
    expect(focusedGroup(layout).activeTabPath).toBe('a')
  })

  it('fixes an unfocused group whose front tab closed, inside that group', () => {
    const paths = ['a', 'b', 'c', 'd']
    const layout = open(paths, 'c')
    sendToOtherGroup(layout, 'c', paths)
    sendToOtherGroup(layout, 'd', paths)
    reconcile(layout, paths)
    activate(layout, 'a')
    reconcile(layout, ['a', 'b', 'c'])
    expect(layout.groups[1].activeTabPath).toBe('c')
    expect(layout.focusedGroupId).toBe(layout.groups[0].id)
  })

  it('keeps a renamed tab in its group and in front', () => {
    const paths = ['a', 'b']
    const layout = open(paths, 'b')
    sendToOtherGroup(layout, 'b', paths)
    reconcile(layout, paths)
    activate(layout, 'a')
    renamePath(layout, 'b', 'b2')
    reconcile(layout, ['a', 'b2'])
    expect(layout.groups[1].activeTabPath).toBe('b2')
    expect(layout.focusedGroupId).toBe(layout.groups[0].id)
  })

  it('round-trips through a session record', () => {
    const paths = ['a', 'b', 'c']
    const layout = open(paths, 'c')
    sendToOtherGroup(layout, 'c', paths)
    reconcile(layout, paths)
    layout.direction = 'column'
    setRatio(layout, 0.99)
    const restored = restoreLayout(saveLayout(layout, paths), paths)
    expect(saveLayout(restored, paths)).toEqual(saveLayout(layout, paths))
    expect(restored.ratio).toBe(SPLIT_RATIO_MAX)
  })

  it('collapses a restored group whose tabs did not survive', () => {
    const saved = {
      groups: [
        { tabs: ['a'], activeTabPath: 'a' },
        { tabs: ['term'], activeTabPath: 'term' }
      ],
      focusedGroup: 1,
      direction: 'row' as const,
      ratio: 0.5
    }
    const restored = restoreLayout(saved, ['a'])
    expect(restored.groups).toHaveLength(1)
    expect(focusedGroup(restored).activeTabPath).toBe('a')
  })
})
