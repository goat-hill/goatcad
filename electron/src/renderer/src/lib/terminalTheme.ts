import type { ITheme } from '@xterm/xterm'
import { themeColor } from './theme'

/**
 * The terminal's palette, read from the app's CSS theme tokens.
 *
 * xterm wants concrete color strings rather than CSS variables, so this is the
 * one place they are resolved — and resolving them from `base.css` is what keeps
 * a terminal tab following the app's theme instead of carrying a hardcoded
 * palette of its own (RULES.md §6). Re-read on every theme change; nothing here
 * is cached.
 *
 * `color` is injected so the mapping can be tested without a document.
 */
export const terminalTheme = (color: typeof themeColor = themeColor): ITheme => ({
  background: color('--vscode-source-bg', '#0b0f0d'),
  foreground: color('--vscode-source-text', '#cdd7d1'),
  cursor: color('--vscode-accent', '#cca250'),
  cursorAccent: color('--vscode-source-bg', '#0b0f0d'),
  selectionBackground: color('--vscode-term-selection'),
  black: color('--vscode-term-black'),
  red: color('--vscode-term-red'),
  green: color('--vscode-term-green'),
  yellow: color('--vscode-term-yellow'),
  blue: color('--vscode-term-blue'),
  magenta: color('--vscode-term-magenta'),
  cyan: color('--vscode-term-cyan'),
  white: color('--vscode-term-white'),
  brightBlack: color('--vscode-term-bright-black'),
  brightRed: color('--vscode-term-bright-red'),
  brightGreen: color('--vscode-term-bright-green'),
  brightYellow: color('--vscode-term-bright-yellow'),
  brightBlue: color('--vscode-term-bright-blue'),
  brightMagenta: color('--vscode-term-bright-magenta'),
  brightCyan: color('--vscode-term-bright-cyan'),
  brightWhite: color('--vscode-term-bright-white')
})
