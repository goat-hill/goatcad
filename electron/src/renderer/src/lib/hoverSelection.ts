// KiCad's hover selection (`PCB_SELECTION_TOOL::RequestSelection`, its
// schematic twin): an edit key pressed with nothing selected acts on the item
// under the pointer, which is unselected again once the command has run.

import { nextTick, type Ref } from 'vue'
import { isTypingTarget, matchesHotkey, type HotkeyActionId } from './hotkeys'

export interface HoverSelection<T> {
  selected: Ref<T[]>
  /** The item under the pointer, as a click there would select it; null for none. */
  hover: () => T | null
  same: (a: T, b: T) => boolean
}

/**
 * Run `command` on the selection, or with none on the item under the pointer.
 * The hovered item is let go after unless `keep` (a command that opens what it
 * acts on, such as a property row) or the command selected something else.
 */
export function withHoverSelection<T>(
  { selected, hover, same }: HoverSelection<T>,
  command: () => void,
  keep = false
): void {
  const item = selected.value.length ? null : hover()
  if (!item) return command()
  selected.value = [item]
  command()
  const now = selected.value
  if (!keep && now.length === 1 && same(now[0], item)) selected.value = []
}

export interface HoverKeys<T> extends HoverSelection<T> {
  /** The edit keys that take the item under the pointer when nothing is selected. */
  keys: readonly HotkeyActionId[]
  /** Those of them whose command opens what it acts on, which stays selected. */
  keep?: readonly HotkeyActionId[]
  /** Whether a key may pick now: the select tool, no gesture in flight. */
  ready: () => boolean
}

/** An editor's keydown with its edit keys run through `withHoverSelection`. */
export function withHoverKeys<T>(
  keydown: (e: KeyboardEvent) => void,
  hover: HoverKeys<T>
): (e: KeyboardEvent) => void {
  return (e) => {
    const action = hover.keys.find((id) => matchesHotkey(e, id))
    if (!action || isTypingTarget() || !hover.ready()) return keydown(e)
    withHoverSelection(hover, () => keydown(e), hover.keep?.includes(action))
  }
}

export interface HeldMove {
  /** Whether a held move is running. */
  active: () => boolean
  /** M: pick up the selection, or with none the item under the pointer. */
  start: () => void
  /** The click dropped it (the editor's drag end); nothing when none is running. */
  end: () => void
  /** Escape: everything goes back, the edits made while it was held too. */
  cancel: () => void
}

/** The editor's undo history, for a held move to roll back what was done while it was held. */
export interface HeldMoveHistory {
  mark(): number
  rollback(mark: number): void
}

/**
 * KiCad's Move (M): the selection — or, with none, the item under the pointer,
 * unselected again when the move ends — follows the pointer until a click
 * drops it. `begin` starts the viewport's held drag; `abandon` puts back what
 * it moved. Escape takes back what was done meanwhile too, a turn or a flip,
 * as KiCad reverts the move's commit (`history`).
 */
export function heldMove<T>(
  selection: HoverSelection<T>,
  viewport: { begin: () => boolean; abandon: () => void; history?: HeldMoveHistory }
): HeldMove {
  let held: 'selection' | 'hover' | null = null
  let mark = 0
  const end = (): void => {
    if (held === 'hover') selection.selected.value = []
    held = null
  }
  return {
    active: () => held !== null,
    start: () => {
      const item = selection.selected.value.length ? null : selection.hover()
      if (!selection.selected.value.length && !item) return
      if (item) selection.selected.value = [item]
      // The viewport reads the selection as the move starts: let it arrive.
      void nextTick(() => {
        if (viewport.begin()) {
          held = item ? 'hover' : 'selection'
          mark = viewport.history?.mark() ?? 0
        } else if (item) selection.selected.value = []
      })
    },
    end,
    cancel: () => {
      viewport.abandon()
      viewport.history?.rollback(mark)
      end()
    }
  }
}
