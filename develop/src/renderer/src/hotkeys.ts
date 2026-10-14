// Every GoatHerd keyboard shortcut lives in this file — matcher and hover-hint
// text together, so changing a binding is a one-place edit.
//
// mod = Cmd on macOS, Ctrl elsewhere. Letter combos all use mod+shift to stay
// clear of keys the embedded terminals need: plain Ctrl+letter is shell
// territory, and Ctrl+Shift+C/V belong to the terminals' own clipboard
// (matchTerminalClipboard below).

export type HotkeyId =
  | 'tab'
  | 'findWorktree'
  | 'split'
  | 'cyclePanes'
  | 'claude'
  | 'appDev'
  | 'webDev'
  | 'terminal'
  | 'vscode'
  | 'workspace'
  | 'gitDiff'
  | 'newBranch'
  | 'closeTab'
  | 'toggleSplit'
  | 'zoomIn'
  | 'zoomOut'
  | 'zoomReset'
  | 'copy'
  | 'paste'

export interface HotkeyMatch {
  id: HotkeyId
  /** 0-based index, only for 'tab'. */
  index?: number
}

const isMac = navigator.userAgent.includes('Mac')
const MOD = isMac ? '⌘' : 'Ctrl'

export const HOTKEY_HINTS: Record<HotkeyId, string> = {
  tab: `${MOD}+1…9`,
  findWorktree: `${MOD}+Shift+F`,
  split: `${MOD}+Shift+P`,
  cyclePanes: `${MOD}+\``,
  claude: `${MOD}+Shift+L`,
  appDev: `${MOD}+Shift+A`,
  webDev: `${MOD}+Shift+W`,
  terminal: `${MOD}+Shift+T`,
  vscode: `${MOD}+Shift+O`,
  workspace: `${MOD}+Shift+D`,
  gitDiff: `${MOD}+Shift+G`,
  newBranch: `${MOD}+Shift+N`,
  closeTab: `${MOD}+W`,
  toggleSplit: `${MOD}+Shift+X`,
  // Zoom combos are browser page-zoom keys, so they're handled in the main
  // process rather than matched below — intercepted before the page sees them on
  // Windows/Linux (interceptZoomShortcuts), registered as menu accelerators on
  // macOS (appMenu.ts). These entries exist only to label the in-window View
  // menu; the native one renders its own accelerators.
  zoomIn: `${MOD}+Shift++`,
  zoomOut: `${MOD}+Shift+-`,
  zoomReset: `${MOD}+Shift+0`,
  // Terminal-scoped, matched by matchTerminalClipboard rather than below.
  copy: isMac ? '⌘+C' : 'Ctrl+Shift+C',
  paste: isMac ? '⌘+V' : 'Ctrl+Shift+V'
}

export type TerminalClipboardAction = 'copy' | 'paste' | 'selectAll'

/** The fields a chord is decided from — a real KeyboardEvent satisfies it. */
interface KeyChord {
  code: string
  ctrlKey: boolean
  shiftKey: boolean
  metaKey: boolean
  altKey: boolean
}

/**
 * Copy/paste inside an embedded terminal, which cannot use the platform's plain
 * clipboard keys: Ctrl+C is SIGINT and Ctrl+V is readline's literal-next, so
 * both have to reach the shell untouched. Every terminal emulator solves this
 * the same way, and we follow each platform's answer — ⌘C/⌘V/⌘A on macOS,
 * Ctrl+Shift+C/V plus the classic Insert pair on Windows and Linux.
 *
 * Select All has no Windows/Linux binding on purpose: Ctrl+Shift+A is already
 * the GoatCAD dev server above, so that one lives in the right-click menu only.
 */
export function matchTerminalClipboard(
  event: KeyChord,
  mac: boolean
): TerminalClipboardAction | null {
  if (event.altKey) return null
  if (mac) {
    if (!event.metaKey || event.ctrlKey || event.shiftKey) return null
    if (event.code === 'KeyC') return 'copy'
    if (event.code === 'KeyV') return 'paste'
    if (event.code === 'KeyA') return 'selectAll'
    return null
  }
  if (event.metaKey) return null
  if (event.ctrlKey && event.shiftKey) {
    if (event.code === 'KeyC') return 'copy'
    if (event.code === 'KeyV') return 'paste'
  }
  if (event.code === 'Insert' && event.ctrlKey !== event.shiftKey) {
    return event.ctrlKey ? 'copy' : 'paste'
  }
  return null
}

export function matchHotkey(event: KeyboardEvent): HotkeyMatch | null {
  const mod = event.ctrlKey || event.metaKey
  if (!mod || event.altKey) return null
  if (!event.shiftKey && event.key >= '1' && event.key <= '9') {
    return { id: 'tab', index: Number(event.key) - 1 }
  }
  if (!event.shiftKey && event.code === 'Backquote') return { id: 'cyclePanes' }
  if (!event.shiftKey && event.code === 'KeyW') return { id: 'closeTab' }
  if (event.shiftKey) {
    switch (event.code) {
      case 'KeyF':
        return { id: 'findWorktree' }
      case 'KeyL':
        return { id: 'claude' }
      case 'KeyP':
        return { id: 'split' }
      case 'KeyA':
        return { id: 'appDev' }
      case 'KeyW':
        return { id: 'webDev' }
      case 'KeyT':
        return { id: 'terminal' }
      case 'KeyO':
        return { id: 'vscode' }
      case 'KeyD':
        return { id: 'workspace' }
      case 'KeyG':
        return { id: 'gitDiff' }
      case 'KeyN':
        return { id: 'newBranch' }
      case 'KeyX':
        return { id: 'toggleSplit' }
    }
  }
  return null
}
