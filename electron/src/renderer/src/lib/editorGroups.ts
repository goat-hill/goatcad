// Editor groups: the window's tabs shown as one pane or two (split-view-workstream.md).
//
// The window keeps ONE ordered tab list; a group is a membership over it, so a
// group's strip order is the window's order filtered, and nothing has to keep
// two lists in step. Everything here is pure over a plain `EditorLayout`;
// `useEditorGroups` is the thin reactive wrapper App holds.

import { computed, reactive, watch, type Ref, type WritableComputedRef } from 'vue'
import type { SavedEditorLayout } from '../../../preload/editorLayoutTypes'

export type { SavedEditorLayout }

export type SplitDirection = 'row' | 'column'

/** Two panes, never a grid. The context rail's fallback rule ("the focused
 *  group's panels, else the other's") is only unambiguous at two. */
export const MAX_EDITOR_GROUPS = 2

export const SPLIT_RATIO_MIN = 0.2
export const SPLIT_RATIO_MAX = 0.8

export interface EditorGroupState {
  id: string
  activeTabPath: string | null
}

export interface EditorLayout {
  groups: EditorGroupState[]
  focusedGroupId: string
  direction: SplitDirection
  /** The first group's share of the split. */
  ratio: number
  /** Tab path → group id. A path absent here belongs to the focused group. */
  membership: Map<string, string>
  /** Tab order as of the last `reconcile`, which is how a closed tab's
   *  neighbor is found after the tab itself is already gone. */
  lastOrder: string[]
  nextGroupNumber: number
}

export const createLayout = (): EditorLayout => ({
  groups: [{ id: 'group-1', activeTabPath: null }],
  focusedGroupId: 'group-1',
  direction: 'row',
  ratio: 0.5,
  membership: new Map(),
  lastOrder: [],
  nextGroupNumber: 2
})

const clampRatio = (ratio: number): number =>
  Math.min(SPLIT_RATIO_MAX, Math.max(SPLIT_RATIO_MIN, ratio))

export const groupIdOf = (layout: EditorLayout, path: string): string =>
  layout.membership.get(path) ?? layout.focusedGroupId

export const pathsOf = (
  layout: EditorLayout,
  paths: readonly string[],
  groupId: string
): string[] => paths.filter((path) => groupIdOf(layout, path) === groupId)

export const focusedGroup = (layout: EditorLayout): EditorGroupState =>
  layout.groups.find((group) => group.id === layout.focusedGroupId) ?? layout.groups[0]

export const otherGroup = (layout: EditorLayout, groupId: string): EditorGroupState | null =>
  layout.groups.find((group) => group.id !== groupId) ?? null

/**
 * Bring the layout in line with the window's tab list: new tabs join the
 * focused group, closed ones leave, a group whose front tab closed shows that
 * tab's neighbor, and a group left empty closes (the last one never does).
 */
export const reconcile = (layout: EditorLayout, paths: readonly string[]): void => {
  const open = new Set(paths)
  for (const path of [...layout.membership.keys()]) {
    if (!open.has(path)) layout.membership.delete(path)
  }
  for (const path of paths) {
    if (!layout.membership.has(path)) layout.membership.set(path, layout.focusedGroupId)
  }

  for (const group of layout.groups) {
    if (group.activeTabPath !== null && open.has(group.activeTabPath)) {
      if (layout.membership.get(group.activeTabPath) === group.id) continue
    }
    const mine = pathsOf(layout, paths, group.id)
    if (mine.length === 0) {
      group.activeTabPath = null
      continue
    }
    // The closed tab's left neighbor, as it stood before the close.
    const before = layout.lastOrder.filter(
      (path) => path === group.activeTabPath || mine.includes(path)
    )
    const index = group.activeTabPath === null ? -1 : before.indexOf(group.activeTabPath)
    group.activeTabPath = index <= 0 ? mine[0] : before[index - 1]
  }

  if (layout.groups.length > 1) {
    const kept = layout.groups.filter((group) => pathsOf(layout, paths, group.id).length > 0)
    layout.groups = kept.length > 0 ? kept : [layout.groups[0]]
  }
  if (!layout.groups.some((group) => group.id === layout.focusedGroupId)) {
    layout.focusedGroupId = layout.groups[0].id
  }
  layout.lastOrder = [...paths]
}

/** Put a tab in front of its group and hand that group the keyboard. */
export const activate = (layout: EditorLayout, path: string): void => {
  const groupId = groupIdOf(layout, path)
  layout.membership.set(path, groupId)
  const group = layout.groups.find((candidate) => candidate.id === groupId)
  if (!group) return
  group.activeTabPath = path
  layout.focusedGroupId = groupId
}

/** Bring a tab to the front of its group WITHOUT moving the keyboard: what a
 *  cross-select does to the pane beside the one being worked in. */
export const showTab = (layout: EditorLayout, path: string): void => {
  const groupId = layout.membership.get(path)
  const group = layout.groups.find((candidate) => candidate.id === groupId)
  if (group) group.activeTabPath = path
}

/** Decide a tab's group ahead of it joining the window's list. */
export const placeIn = (layout: EditorLayout, path: string, groupId: string): void => {
  if (layout.groups.some((group) => group.id === groupId)) layout.membership.set(path, groupId)
}

export const focusGroup = (layout: EditorLayout, groupId: string): void => {
  if (layout.groups.some((group) => group.id === groupId)) layout.focusedGroupId = groupId
}

/** Move a tab into a group, where it comes to the front and takes the keyboard. */
export const moveTab = (layout: EditorLayout, path: string, targetGroupId: string): void => {
  if (!layout.groups.some((group) => group.id === targetGroupId)) return
  layout.membership.set(path, targetGroupId)
  activate(layout, path)
}

/**
 * Send a tab across the split, opening the second group when there is only one.
 * A lone tab in a lone group stays put: splitting it would leave an empty pane
 * beside the same view.
 */
export const sendToOtherGroup = (
  layout: EditorLayout,
  path: string,
  paths: readonly string[]
): boolean => {
  const sourceId = groupIdOf(layout, path)
  const target = otherGroup(layout, sourceId)
  if (target) {
    moveTab(layout, path, target.id)
    return true
  }
  if (layout.groups.length >= MAX_EDITOR_GROUPS) return false
  if (pathsOf(layout, paths, sourceId).length < 2) return false
  const created: EditorGroupState = {
    id: `group-${layout.nextGroupNumber++}`,
    activeTabPath: null
  }
  layout.groups = [...layout.groups, created]
  moveTab(layout, path, created.id)
  return true
}

/**
 * A tab's file was renamed. Called BEFORE the tab list changes, so the tab
 * keeps its group and its place in front instead of reading as one tab closed
 * and another opened.
 */
export const renamePath = (layout: EditorLayout, oldPath: string, newPath: string): void => {
  const groupId = layout.membership.get(oldPath)
  if (groupId !== undefined) {
    layout.membership.delete(oldPath)
    layout.membership.set(newPath, groupId)
  }
  for (const group of layout.groups) {
    if (group.activeTabPath === oldPath) group.activeTabPath = newPath
  }
  layout.lastOrder = layout.lastOrder.map((path) => (path === oldPath ? newPath : path))
}

export const setRatio = (layout: EditorLayout, ratio: number): void => {
  layout.ratio = clampRatio(ratio)
}

export const toggleDirection = (layout: EditorLayout): void => {
  layout.direction = layout.direction === 'row' ? 'column' : 'row'
}

export const saveLayout = (layout: EditorLayout, paths: readonly string[]): SavedEditorLayout => ({
  groups: layout.groups.map((group) => ({
    tabs: pathsOf(layout, paths, group.id),
    activeTabPath: group.activeTabPath
  })),
  focusedGroup: Math.max(
    0,
    layout.groups.findIndex((group) => group.id === layout.focusedGroupId)
  ),
  direction: layout.direction,
  ratio: layout.ratio
})

/**
 * Rebuild a layout from a session record. Groups beyond the cap fold into the
 * last one kept, and a path the record does not place joins the first group;
 * `reconcile` then drops whatever did not survive the restore.
 */
export const restoreLayout = (
  saved: SavedEditorLayout | null | undefined,
  paths: readonly string[]
): EditorLayout => {
  const layout = createLayout()
  if (saved && saved.groups.length > 1) {
    const open = new Set(paths)
    const kept = saved.groups.slice(0, MAX_EDITOR_GROUPS)
    layout.groups = kept.map((group, index) => ({
      id: `group-${index + 1}`,
      activeTabPath:
        group.activeTabPath !== null && open.has(group.activeTabPath) ? group.activeTabPath : null
    }))
    layout.nextGroupNumber = kept.length + 1
    saved.groups.forEach((group, index) => {
      const id = layout.groups[Math.min(index, kept.length - 1)].id
      for (const path of group.tabs) if (open.has(path)) layout.membership.set(path, id)
    })
    layout.focusedGroupId = layout.groups[0].id
    for (const path of paths) {
      if (!layout.membership.has(path)) layout.membership.set(path, layout.groups[0].id)
    }
    const focused = layout.groups[saved.focusedGroup]
    if (focused) layout.focusedGroupId = focused.id
    layout.direction = saved.direction === 'column' ? 'column' : 'row'
    layout.ratio = clampRatio(Number.isFinite(saved.ratio) ? saved.ratio : 0.5)
  }
  layout.lastOrder = [...paths]
  reconcile(layout, paths)
  return layout
}

export interface EditorGroups {
  layout: EditorLayout
  /** The focused group's front tab: what "the active tab" means window-wide. */
  activeTabPath: WritableComputedRef<string | null>
  /** Reconcile now rather than on the next flush, for a caller that reads the
   *  active tab straight after changing the tab list. */
  sync: () => void
  restore: (saved: SavedEditorLayout | null | undefined) => void
  saved: () => SavedEditorLayout
}

export function useEditorGroups(openTabs: Ref<Array<{ path: string }>>): EditorGroups {
  const layout = reactive(createLayout()) as EditorLayout
  const paths = (): string[] => openTabs.value.map((tab) => tab.path)
  const sync = (): void => reconcile(layout, paths())

  watch(() => paths().join('\n'), sync, { flush: 'sync' })

  const activeTabPath = computed<string | null>({
    get: () => focusedGroup(layout).activeTabPath,
    set: (path) => {
      if (path === null) focusedGroup(layout).activeTabPath = null
      else activate(layout, path)
    }
  })

  return {
    layout,
    activeTabPath,
    sync,
    restore: (saved) => Object.assign(layout, restoreLayout(saved, paths())),
    saved: () => saveLayout(layout, paths())
  }
}
