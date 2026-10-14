// The active editor's edit and navigation commands, published for the surfaces
// that display them: the title bar's Edit and Go menus and the canvas
// right-click menu.
//
// Why a registry rather than props: the editors sit under EditorArea while the
// title bar is its sibling, so threading this through App would be a prop chain
// carrying editor-internal state (is anything selected? is the clipboard empty?)
// through components with no use for it.
//
// Commands are named by their HOTKEY, not by a callback. Both menus dispatch the
// bound key as a synthetic keydown — the same replay the native macOS menu
// already uses (lib/nativeMenu.ts) — so a menu item runs the editor's real
// handler, and menu and shortcut cannot drift apart. It also means a command
// with no hotkey cannot appear in a menu, which is the right pressure.

import {
  computed,
  onUnmounted,
  shallowRef,
  watch,
  type ComputedRef,
  type Ref,
  type ShallowRef
} from 'vue'
import { useEditorGroup } from './editorWorkspace'
import { hotkeyEventInit, hotkeyLabel, isTypingTarget, type HotkeyActionId } from './hotkeys'
import type { MenuNode } from './menu'

export interface EditAction {
  /** The command's hotkey; also its identity in the menu. */
  hotkey: HotkeyActionId
  /** Already-translated label — the owning editor holds the strings. */
  label: string
  /** False renders the row grayed rather than letting it silently no-op. */
  enabled: boolean
}

/** Actions in one visual group; groups render separated by dividers. */
export type EditActionGroup = EditAction[]

const groups = shallowRef<EditActionGroup[]>([])
/** The Go menu's rows: moving between the documents an editor spans (sheets). */
const navGroups = shallowRef<EditActionGroup[]>([])

/** Replace the published commands. Editors go through `usePublishedEditActions`. */
export function setEditActions(next: EditActionGroup[]): void {
  groups.value = next
}

/**
 * Publish into `target` for as long as the editor's group holds the keyboard. In
 * a split two editors are mounted, and the menu is the focused one's: the other
 * neither publishes nor, on unmount, clears what is not its own.
 */
export const publishWhileFocused = <T>(target: ShallowRef<T[]>, actions: Ref<T[]>): void => {
  const { focused } = useEditorGroup()
  let published = false
  watch(
    [actions, focused],
    ([next, isFocused]) => {
      if (isFocused) {
        target.value = next
        published = true
      } else if (published) {
        target.value = []
        published = false
      }
    },
    { immediate: true }
  )
  onUnmounted(() => {
    if (published) target.value = []
  })
}

/** Publish an editor's Edit menu commands while its group holds the keyboard. */
export function usePublishedEditActions(actions: Ref<EditActionGroup[]>): void {
  publishWhileFocused(groups, actions)
}

/**
 * Publish an editor's Go menu commands — back / forward, up, previous / next —
 * while its group holds the keyboard. The menu shows only while one does.
 */
export function usePublishedNavActions(actions: Ref<EditActionGroup[]>): void {
  publishWhileFocused(navGroups, actions)
}

export function useEditActions(): ComputedRef<EditActionGroup[]> {
  return computed(() => groups.value)
}

export function useNavActions(): ComputedRef<EditActionGroup[]> {
  return computed(() => navGroups.value)
}

/**
 * Menu rows for the given groups, with the shortcut column filled from the
 * hotkey registry so a rebind updates the menus for free. Empty groups are
 * dropped rather than emitting a stray divider.
 */
export function buildEditMenu(actionGroups: EditActionGroup[]): MenuNode[] {
  const nodes: MenuNode[] = []
  for (const group of actionGroups.filter((g) => g.length > 0)) {
    if (nodes.length > 0) nodes.push({ divider: true })
    for (const action of group) {
      nodes.push({
        id: action.hotkey,
        label: action.label,
        shortcut: hotkeyLabel(action.hotkey),
        disabled: !action.enabled
      })
    }
  }
  return nodes
}

/** True when `id` names an edit action — i.e. it is a hotkey to replay. */
export function isEditActionId(actionGroups: EditActionGroup[], id: string): boolean {
  return actionGroups.some((group) => group.some((action) => action.hotkey === id))
}

/**
 * Run an edit command by replaying its key. The editors listen on `window`, so
 * the event has to reach them the same way a real press would.
 */
export function dispatchEditAction(hotkey: HotkeyActionId): void {
  window.dispatchEvent(new KeyboardEvent('keydown', hotkeyEventInit(hotkey)))
}

/**
 * Ctrl/Cmd+A while a text field has focus is the field's own select-all, not
 * the editor's. On macOS the editor's Select All row in the Edit menu takes ⌘A
 * before the page sees it — it has to, or the menu's Select All role would —
 * and replays it as a synthetic keydown, so there the field is given its
 * select-all by hand. True when the key was the field's; the editor then leaves
 * it alone.
 */
export function selectAllInField(event: KeyboardEvent): boolean {
  if (!isTypingTarget()) return false
  const field = document.activeElement
  if (
    !event.isTrusted &&
    (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement)
  ) {
    field.select()
  }
  return true
}
