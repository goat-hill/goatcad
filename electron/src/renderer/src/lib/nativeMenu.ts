/**
 * Bridge from the title-bar menu model to the macOS system menu bar.
 *
 * macOS puts the menu in the system bar, so GoatCAD hides its in-window
 * dropdowns there and sends the same tree to main to render natively (see
 * `main/appMenu.ts`). The tree stays declared once, in `TitleBar.vue`; this
 * module only translates it and routes the selection back.
 *
 * Pure and DOM-free apart from `nativeCommandEvent`, so the translation is unit
 * tested rather than eyeballed through a real menu bar.
 */

import { isDivider, isHeader, labelText, type MenuNode } from './menu'
import {
  hotkeyAccelerator,
  hotkeyEventInit,
  isHotkeyActionId,
  type HotkeyActionId
} from './hotkeys'
import type {
  NativeMenuNode,
  NativeMenuSection,
  NativeMenuTemplate
} from '../../../preload/menuTypes'

/**
 * Commands whose keyboard shortcut the native menu will register. macOS takes
 * the key before the page sees it, so these are replayed as a keydown rather
 * than dispatched directly — the editors hang real work off those handlers
 * (the schematic persists its BOM presets on Ctrl/Cmd+S), and a menu that
 * bypassed them would silently do less than the shortcut.
 */
const COMMAND_HOTKEYS: Record<string, HotkeyActionId> = {
  'new:schematic': 'app.newSchematic',
  'new-window': 'app.newWindow',
  'open-folder': 'app.openFolder',
  'open-project': 'app.openProject',
  save: 'editor.save',
  undo: 'editor.undo',
  redo: 'editor.redo',
  'update-pcb': 'app.updatePcb'
}

/**
 * Items the macOS bar supplies itself, dropped from the sections we send.
 * Quit belongs in the application menu on macOS, never in File — and its
 * `Alt+F4` label is a Windows shortcut besides.
 */
const MAC_OMITTED_IDS = new Set(['exit'])

/**
 * The hotkey a command runs by. Editor edit-commands are *named* by their
 * hotkey (lib/editActions.ts), so an id that is itself an action id needs no
 * entry in the table above — which is what keeps the Edit menu's contents from
 * having to be duplicated here.
 */
const commandHotkey = (id: string): HotkeyActionId | null =>
  COMMAND_HOTKEYS[id] ?? (isHotkeyActionId(id) ? id : null)

const toNativeNode = (node: MenuNode): NativeMenuNode | null => {
  if (isDivider(node)) return { divider: true }
  // Electron's template has no section-title node, so a header becomes the thing
  // macOS itself uses for one: a disabled label. It can never be chosen, so the
  // synthetic id is only there to satisfy the shape.
  if (isHeader(node)) return { id: `header:${node.header}`, label: node.header, enabled: false }
  if (MAC_OMITTED_IDS.has(node.id)) return null
  const item: NativeMenuNode = { id: node.id, label: labelText(node.label) }
  const hotkey = commandHotkey(node.id)
  if (hotkey) item.accelerator = hotkeyAccelerator(hotkey)
  if (node.disabled) item.enabled = false
  if (node.children?.length) item.submenu = toNativeNodes(node.children)
  return item
}

/** Drops omitted items, then any divider left stranded at an edge or doubled. */
const toNativeNodes = (nodes: MenuNode[]): NativeMenuNode[] => {
  const kept = nodes.map(toNativeNode).filter((node): node is NativeMenuNode => node !== null)
  return kept.filter((node, index) => {
    if (!('divider' in node)) return true
    const previous = kept[index - 1]
    return (
      index > 0 && index < kept.length - 1 && previous !== undefined && !('divider' in previous)
    )
  })
}

/** Serializes the title-bar menus into the form main renders on macOS. */
export const toNativeTemplate = (
  sections: { id: string; label: string; items: MenuNode[] }[]
): NativeMenuTemplate => ({
  sections: sections.map((section): NativeMenuSection => ({
    id: section.id,
    label: section.label,
    items: toNativeNodes(section.items)
  }))
})

/**
 * The keydown to replay for a native menu selection, or null when the command
 * has no shortcut and should be dispatched through the normal select handler.
 */
export const nativeCommandEvent = (id: string): KeyboardEvent | null => {
  const hotkey = commandHotkey(id)
  return hotkey ? new KeyboardEvent('keydown', hotkeyEventInit(hotkey)) : null
}
