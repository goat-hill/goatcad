// Which pane inside an editor the user is working in — the canvas, or the
// properties panel beside it.
//
// It drives the Escape handover only: leaving a property field hands the
// keyboard back to the canvas, which has to know it holds it again. It does NOT
// gate shortcuts — `isTypingTarget()` does — and deliberately no longer dims the
// canvas selection.
//
// Module scope, not a per-component ref: the properties rail is the shell's and
// shows one editor's panels at a time, even in a split, so "the active pane" is
// a single answer for the window, and it must survive a component that unmounts
// mid-edit. Which EDITOR holds the keyboard is the group's (lib/editorWorkspace.ts).

import { computed, ref, type ComputedRef } from 'vue'

/** The panes an editor is split into. The left tree runs its own (Sidebar.vue). */
export type EditorPane = 'canvas' | 'properties'

const active = ref<EditorPane>('canvas')

export function useActivePane(): {
  activePane: ComputedRef<EditorPane>
  /** True when `pane` is the one being worked in — bind this to the dimming. */
  isActivePane: (pane: EditorPane) => ComputedRef<boolean>
  setActivePane: (pane: EditorPane) => void
} {
  return {
    activePane: computed(() => active.value),
    isActivePane: (pane) => computed(() => active.value === pane),
    setActivePane: (pane) => {
      active.value = pane
    }
  }
}

/**
 * Reset to the canvas. Called when an editor mounts, so opening a file never
 * inherits "the properties panel is active" from the editor you just left.
 */
export function resetActivePane(): void {
  active.value = 'canvas'
}
