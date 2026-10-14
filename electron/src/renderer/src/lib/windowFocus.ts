/**
 * Whether this window is the active one, for chrome that dims when it is not.
 *
 * A frameless window gets no OS title bar to gray out for it, so the app has to
 * draw the cue itself. The state comes from main (`window:focus-changed`) rather
 * than the page's own focus/blur events, which fire when focus moves into a
 * document-viewer iframe while the OS window stays active.
 */

import { readonly, ref, type Ref } from 'vue'

// Seeded from the document because main's first `focus` may land before the
// renderer subscribes; every change after that arrives over IPC.
const focused = ref(typeof document === 'undefined' || document.hasFocus())

let subscribed = false

/** The live focus state. Subscribes once per window; never unsubscribes. */
export function useWindowFocused(): Readonly<Ref<boolean>> {
  if (!subscribed && typeof window !== 'undefined' && window.api) {
    subscribed = true
    window.api.onWindowFocusChanged((next) => {
      focused.value = next
    })
  }
  return readonly(focused)
}
