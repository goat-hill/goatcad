/**
 * The macOS application menu.
 *
 * macOS owns the menu bar: it sits in the system bar, outside the window, and
 * there is no way to not have one. So on darwin the renderer stops drawing its
 * File/View/Help dropdowns and pushes the same tree here instead (VS Code's
 * split), and this module renders it natively. Windows and Linux keep the
 * in-window menu and never call in.
 *
 * The tree is declared in the renderer because that is where `t()` and the
 * hotkey registry live; this module only arranges it the way macOS expects and
 * routes a click back to the window it came from.
 */

import { BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron'
import type { NativeMenuNode, NativeMenuSection, NativeMenuTemplate } from '../preload/menuTypes'

const isDivider = (node: NativeMenuNode): node is { divider: true } =>
  (node as { divider?: true }).divider === true

const toNativeItem = (
  node: NativeMenuNode,
  dispatch: (id: string) => void
): MenuItemConstructorOptions => {
  if (isDivider(node)) return { type: 'separator' }
  const item: MenuItemConstructorOptions = { label: node.label }
  if (node.accelerator) item.accelerator = node.accelerator
  if (node.enabled === false) item.enabled = false
  if (node.submenu) {
    item.submenu = node.submenu.map((child) => toNativeItem(child, dispatch))
  } else {
    item.click = (): void => dispatch(node.id)
  }
  return item
}

const toNativeSection = (
  section: NativeMenuSection,
  dispatch: (id: string) => void
): MenuItemConstructorOptions => ({
  label: section.label,
  submenu: section.items.map((node) => toNativeItem(node, dispatch))
})

/**
 * The clipboard half of the Edit menu. Roles rather than app commands: they are
 * OS-localized, and text inputs (the find widget, rename fields) get Cut/Copy/
 * Paste on macOS only if something registers them. Undo and Redo are deliberately
 * *not* roles — those run the DOM's editing undo, and would swallow Ctrl/Cmd+Z
 * before the editors' undo/redo command layer saw it — so they come from the
 * renderer's `edit` section instead.
 */
const CLIPBOARD_ITEMS: MenuItemConstructorOptions[] = [
  { type: 'separator' },
  { role: 'cut' },
  { role: 'copy' },
  { role: 'paste' },
  { role: 'selectAll' }
]

/**
 * Standard macOS bar order. The app and Window menus are Electron roles rather
 * than app commands: they carry the system items every Mac app is expected to
 * have (Quit, Hide, Services; Minimize, Zoom), already localized by the OS.
 * Sections the renderer sends that aren't named here are appended after `view`,
 * so adding a menu doesn't require a change on this side.
 *
 * Notably absent is `fileMenu`: on macOS that role is Close Window on Cmd+W,
 * which would shadow the app's own close-tab binding.
 */
export function macMenuTemplate(
  template: NativeMenuTemplate,
  dispatch: (id: string) => void
): MenuItemConstructorOptions[] {
  const byId = new Map(template.sections.map((section) => [section.id, section]))
  const placed = new Set(['file', 'edit', 'view', 'help'])
  const section = (id: string): MenuItemConstructorOptions[] => {
    const found = byId.get(id)
    return found ? [toNativeSection(found, dispatch)] : []
  }
  const extras = template.sections
    .filter((s) => !placed.has(s.id))
    .map((s) => toNativeSection(s, dispatch))
  const edit = section('edit').map((menu) => ({
    ...menu,
    submenu: [...(menu.submenu as MenuItemConstructorOptions[]), ...CLIPBOARD_ITEMS]
  }))

  return [
    { role: 'appMenu' },
    ...section('file'),
    ...edit,
    ...section('view'),
    ...extras,
    { role: 'windowMenu' },
    // `role: 'help'` is what makes macOS add its own Help search field.
    ...section('help').map((help) => ({ ...help, role: 'help' as const }))
  ]
}

/**
 * One menu bar, many windows: the bar belongs to the app, not the window, so
 * the focused window's template is the one that applies. Templates are kept per
 * window and re-applied on focus — otherwise a background window's disabled
 * state (no project open) would leak onto the foreground one.
 */
const templates = new Map<number, NativeMenuTemplate>()

const dispatchTo = (windowId: number, id: string): void => {
  BrowserWindow.fromId(windowId)?.webContents.send('menu:select', id)
}

function apply(win: BrowserWindow | null): void {
  const template = win ? templates.get(win.id) : undefined
  if (!win || !template) return
  const windowId = win.id
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(macMenuTemplate(template, (id) => dispatchTo(windowId, id)))
  )
}

/** Records a window's menu and renders it if that window has focus. */
export function setWindowMenu(win: BrowserWindow, template: NativeMenuTemplate): void {
  if (process.platform !== 'darwin') return
  templates.set(win.id, template)
  if (win.isFocused() || !BrowserWindow.getFocusedWindow()) apply(win)
}

/** Re-renders the bar for the window that just took focus. */
export function focusWindowMenu(win: BrowserWindow): void {
  if (process.platform !== 'darwin') return
  apply(win)
}

export function forgetWindowMenu(win: BrowserWindow): void {
  templates.delete(win.id)
}

/**
 * Windows and Linux draw the menu in the title bar, so the application menu
 * should not exist at all there. Left unset, Electron installs its stock
 * template, and a frameless window hiding the bar does not disarm the
 * accelerators that come with it — stock Ctrl+W (Close Window) would shadow the
 * app's close-tab binding, and stock Ctrl+Z the editors' undo. Clipboard and
 * devtools keys are unaffected: outside macOS, Chromium handles Ctrl+C/V in web
 * contents itself, and `optimizer.watchWindowShortcuts` provides F12 in dev.
 */
export function clearApplicationMenu(): void {
  if (process.platform === 'darwin') return
  Menu.setApplicationMenu(null)
}
