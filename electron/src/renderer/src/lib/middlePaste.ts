/**
 * On Linux, Chromium pastes the primary selection on every middle-button
 * release into whatever holds focus, not into what was clicked. A middle-drag
 * pan on a canvas would then type into the terminal pane, or a text field,
 * that kept focus beside it. The paste is kept only for a press that lands on
 * a place that takes text — a field or a terminal — and every other middle
 * release is cancelled, which is what stops Chromium's paste.
 */
export function installMiddlePasteGuard(): void {
  let pasteAllowed = false

  const takesText = (target: EventTarget | null): boolean =>
    target instanceof Element &&
    !!target.closest('input, textarea, [contenteditable=""], [contenteditable="true"], .xterm')

  window.addEventListener(
    'mousedown',
    (e) => {
      if (e.button === 1) pasteAllowed = takesText(e.target)
    },
    true
  )
  window.addEventListener(
    'mouseup',
    (e) => {
      if (e.button === 1 && !pasteAllowed) e.preventDefault()
    },
    true
  )
}
