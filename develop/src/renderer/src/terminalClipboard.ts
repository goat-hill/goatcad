/**
 * Sends a clipboard command to whatever holds focus.
 *
 * A terminal has to answer for itself: its selection is drawn, not a DOM
 * selection, so the browser's own copy command sees nothing to copy and the
 * paste has to go through xterm to respect bracketed-paste mode. Everything else
 * in the window is an ordinary field or ordinary text, and still expects the
 * plain behavior — hence one router rather than a terminal-only handler.
 *
 * Both routes into it end here: the key chords (hotkeys.ts, dispatched from the
 * window-level handler in App.vue) and the macOS Edit menu (main/appMenu.ts),
 * whose items cannot act on their own for the reason above.
 */

import type { TerminalClipboardAction } from './hotkeys'

interface TerminalTarget {
  /** The pane's root; focus anywhere inside it means this terminal is the target. */
  element: HTMLElement
  run: (action: TerminalClipboardAction) => void | Promise<void>
}

const terminals = new Set<TerminalTarget>()

export function registerTerminal(target: TerminalTarget): () => void {
  terminals.add(target)
  return () => {
    terminals.delete(target)
  }
}

export async function runClipboardCommand(action: TerminalClipboardAction): Promise<void> {
  const focused = document.activeElement
  const terminal = [...terminals].find((t) => t.element.contains(focused))
  if (terminal) {
    terminal.run(action)
    return
  }

  if (focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement) {
    switch (action) {
      case 'copy': {
        const text = focused.value.slice(focused.selectionStart ?? 0, focused.selectionEnd ?? 0)
        if (text) window.api.writeClipboard(text)
        break
      }
      case 'paste': {
        // insertText rather than writing `value`: it keeps the field's own undo
        // stack and fires the input event a v-model binding listens for.
        const text = await window.api.readClipboard()
        if (text) document.execCommand('insertText', false, text)
        break
      }
      case 'selectAll':
        focused.select()
        break
    }
    return
  }

  // Plain page text — a Workspace writeup, an error line. Only copy applies, and
  // it is the whole reason this branch exists: macOS reaches us for ⌘C.
  if (action === 'copy') {
    const text = window.getSelection()?.toString()
    if (text) window.api.writeClipboard(text)
  }
}
