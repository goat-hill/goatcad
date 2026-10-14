/**
 * The macOS application menu.
 *
 * macOS owns the menu bar and there is no way to not have one: left alone,
 * Electron fills it with its stock template — a Help menu pointing at
 * electronjs.org, and a View menu whose Zoom In/Out are Chromium *page* zoom,
 * the exact thing `interceptZoomShortcuts` exists to prevent. So on darwin we
 * declare the bar explicitly, and the window stops drawing its own View button
 * and window controls (App.vue). Windows and Linux keep the in-window menu and
 * never call in — `autoHideMenuBar` covers them.
 */

import { BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron'

/**
 * One zoom command, plus every keystroke that means the same thing. A native
 * menu item carries a single accelerator, so the alternates are hidden
 * duplicates — the same trick VS Code uses. They are not optional: the
 * intercepted path treats Shift and the numpad as interchangeable here, and
 * registering only the printed shortcut would quietly drop the rest.
 *
 * First entry is the one shown, and it is the Shift form the hotkey table
 * advertises (`hotkeys.ts` HOTKEY_HINTS, README) rather than the bare combo.
 */
const ZOOM_COMMANDS: { action: string; label: string; keys: string[] }[] = [
  {
    action: 'in',
    label: 'Zoom In',
    keys: [
      'CommandOrControl+Shift+=',
      'CommandOrControl+=',
      'CommandOrControl+Plus',
      'CommandOrControl+numadd'
    ]
  },
  {
    action: 'out',
    label: 'Zoom Out',
    keys: ['CommandOrControl+Shift+-', 'CommandOrControl+-', 'CommandOrControl+numsub']
  },
  {
    action: 'reset',
    label: 'Reset Zoom',
    keys: ['CommandOrControl+Shift+0', 'CommandOrControl+0', 'CommandOrControl+num0']
  }
]

/**
 * The zoom items send the same `zoom` message the key interception does, so the
 * renderer's font store stays the single place the size actually changes.
 */
const zoomItems = (win: BrowserWindow): MenuItemConstructorOptions[] =>
  ZOOM_COMMANDS.flatMap(({ action, label, keys }) =>
    keys.map((accelerator, index) => ({
      label,
      accelerator,
      // Only the first spelling is shown; the rest exist to be pressed.
      ...(index > 0 ? { visible: false } : {}),
      click: (): void => win.webContents.send('zoom', action)
    }))
  )

/**
 * Edit, minus the clipboard roles.
 *
 * `role: 'copy'` and friends act on the DOM, which cannot serve an embedded
 * terminal: its selection is drawn rather than selected, and its paste has to go
 * through xterm to respect bracketed-paste mode. So the three become plain items
 * that report the intent to the renderer, which routes it to whatever holds
 * focus (renderer/src/terminalClipboard.ts) — the same place the key chords land.
 *
 * `registerAccelerator: false` is what lets both routes coexist: the combos stay
 * printed next to the items but are left to the page, where the renderer's own
 * handler sees them. Should the platform claim one anyway, the click handler
 * ends up in exactly the same router, so neither path can go missing.
 */
const editItems = (win: BrowserWindow): MenuItemConstructorOptions[] => {
  const clipboardItem = (
    label: string,
    action: TerminalMenuAction,
    accelerator: string
  ): MenuItemConstructorOptions => ({
    label,
    accelerator,
    registerAccelerator: false,
    click: (): void => win.webContents.send('clipboard', action)
  })
  return [
    { role: 'undo' },
    { role: 'redo' },
    { type: 'separator' },
    { role: 'cut' },
    clipboardItem('Copy', 'copy', 'Command+C'),
    clipboardItem('Paste', 'paste', 'Command+V'),
    { type: 'separator' },
    clipboardItem('Select All', 'selectAll', 'Command+A')
  ]
}

/**
 * `sizeLabel` is the live "14px · default 13px" readout the in-window menu shows
 * in its footer, formatted by the renderer (which owns the default) and passed
 * through; a disabled item is the nearest native equivalent. It is omitted until
 * the renderer first reports — the menu is applied at window creation so the
 * stock Electron template never gets a frame on screen.
 */
export function buildMacMenu(win: BrowserWindow, sizeLabel?: string): MenuItemConstructorOptions[] {
  return [
    { role: 'appMenu' },
    { label: 'Edit', submenu: editItems(win) },
    {
      label: 'View',
      submenu: [
        ...zoomItems(win),
        ...(sizeLabel ? [{ type: 'separator' as const }, { label: sizeLabel, enabled: false }] : [])
      ]
    },
    { role: 'windowMenu' }
  ]
}

/**
 * Renders the bar. Re-called whenever the font size readout changes.
 *
 * Off macOS it clears the menu instead of skipping: the View menu is drawn in
 * the title bar there, so no application menu should exist. Left unset, Electron
 * installs its stock template, and a frameless window hiding the bar does not
 * disarm the accelerators that come with it — stock Ctrl+/-/0 is Chromium page
 * zoom, competing with the terminal-font interception. Clipboard and devtools
 * keys are unaffected: outside macOS, Chromium handles Ctrl+C/V in web contents
 * itself, the terminals' Ctrl+Shift+C/V is the renderer's (hotkeys.ts), and
 * `optimizer.watchWindowShortcuts` provides F12 in dev.
 */
export function applyAppMenu(win: BrowserWindow, sizeLabel?: string): void {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null)
    return
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildMacMenu(win, sizeLabel)))
}
