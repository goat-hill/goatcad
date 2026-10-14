/**
 * A modal's keys (DESIGN.md §Modals): Escape abandons it, Enter runs its call
 * to action. Both are heard on `window`, since a modal often opens with focus
 * still on what opened it, and only by the topmost modal when they stack.
 *
 * Enter confirms only while nothing in a modal has focus — as a modal opens,
 * focus is still on whatever opened it. Once something in the modal has it
 * (a field, a checkbox, a button), Enter is that control's to use or ignore.
 */
import { onScopeDispose } from 'vue'
import { matchesHotkey } from './hotkeys'

export interface ModalKeys {
  /** Escape: close without applying. A modal in `shared/Modal.vue` leaves this to the platform's dialog. */
  dismiss?: () => void
  /** Enter: the call to action; it checks for itself whether it can run. Absent where there is none. */
  confirm?: () => void
  /** False while the modal is hidden under one that does not take part (a chooser it opened). */
  active?: () => boolean
}

/** The modals open now, the topmost last. */
const stack: symbol[] = []

/** Whether focus is inside an open modal (`aria-modal`), where Enter belongs to what has it. */
export const focusInModal = (target: EventTarget | null): boolean =>
  typeof Element !== 'undefined' &&
  target instanceof Element &&
  target.closest('[aria-modal="true"]') !== null

/** Listen for a modal's keys for as long as the component (or scope) calling it lives. */
export const useModalKeys = (keys: ModalKeys): void => {
  const id = Symbol('modal')
  stack.push(id)
  const onKey = (event: KeyboardEvent): void => {
    if (stack[stack.length - 1] !== id || keys.active?.() === false) return
    if (keys.dismiss && matchesHotkey(event, 'app.dismiss')) {
      keys.dismiss()
      return
    }
    if (
      keys.confirm &&
      !event.isComposing &&
      matchesHotkey(event, 'app.confirm') &&
      !focusInModal(event.target)
    ) {
      event.preventDefault()
      keys.confirm()
    }
  }
  window.addEventListener('keydown', onKey)
  onScopeDispose(() => {
    window.removeEventListener('keydown', onKey)
    const index = stack.indexOf(id)
    if (index >= 0) stack.splice(index, 1)
  })
}
