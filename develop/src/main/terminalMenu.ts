/**
 * The embedded terminals' right-click menu.
 *
 * Native, unlike the View menu the title bar draws itself: a context menu is the
 * one piece of chrome that should look and behave like the desktop's own, and
 * Electron's gets placement, dismissal and keyboard navigation on all three
 * platforms for free. It only reports the choice — the renderer performs it,
 * because copy and paste are terminal operations (selection, bracketed paste),
 * not clipboard ones. See TerminalPane.vue.
 */

import { BrowserWindow, clipboard, Menu, type MenuItemConstructorOptions } from 'electron'

// The combos hotkeys.ts binds, shown as labels only — a popup menu's accelerator
// would otherwise be registered app-wide and swallow the key before the terminal.
const ACCELERATORS =
  process.platform === 'darwin'
    ? { copy: 'Command+C', paste: 'Command+V', selectAll: 'Command+A' }
    : { copy: 'Ctrl+Shift+C', paste: 'Ctrl+Shift+V', selectAll: undefined }

export async function popupTerminalMenu(
  win: BrowserWindow,
  hasSelection: boolean
): Promise<TerminalMenuAction | null> {
  const pending = await clipboard.readText()

  return new Promise((resolve) => {
    const item = (
      label: string,
      value: TerminalMenuAction,
      enabled: boolean
    ): MenuItemConstructorOptions => ({
      label,
      enabled,
      accelerator: ACCELERATORS[value],
      registerAccelerator: false,
      // The choice resolves from the click itself; a promise settles once, so
      // the dismissal below cannot overrule it whichever order the platform's
      // menu backend fires the two in.
      click: () => resolve(value)
    })

    const menu = Menu.buildFromTemplate([
      item('Copy', 'copy', hasSelection),
      item('Paste', 'paste', pending.length > 0),
      { type: 'separator' },
      item('Select All', 'selectAll', true)
    ])

    menu.popup({
      window: win,
      // A dismissal with no click. GTK can close the menu before it delivers the
      // activation, so this waits long enough for a click to have arrived first.
      callback: () => setTimeout(() => resolve(null), 150)
    })
  })
}
