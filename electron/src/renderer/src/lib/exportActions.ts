// The front editor's own exports, published for File ▸ Export: what only that
// editor can write, from what it has on screen (the board's 3D view as a
// picture). A registry for the reason `editActions.ts` is one — the editors sit
// under EditorArea, the title bar beside it — but a row here runs a callback:
// an export opens a dialog and has no key to replay.

import { computed, shallowRef, type ComputedRef, type Ref } from 'vue'
import { publishWhileFocused } from './editActions'
import type { MenuNode } from './menu'

export interface ExportAction {
  /** Its identity in the menu. */
  id: string
  /** Already translated; the owning editor holds the strings. */
  label: string
  /** False renders the row grayed rather than dropping it. */
  enabled: boolean
  /** Why it is grayed; the row's tooltip. */
  disabledReason?: string
  run: () => void
}

const actions = shallowRef<ExportAction[]>([])

/** Publish an editor's exports while its group holds the keyboard. */
export function usePublishedExportActions(next: Ref<ExportAction[]>): void {
  publishWhileFocused(actions, next)
}

export function useExportActions(): ComputedRef<ExportAction[]> {
  return computed(() => actions.value)
}

export function buildExportMenu(published: ExportAction[]): MenuNode[] {
  return published.map((action) => ({
    id: action.id,
    label: action.label,
    ...(action.enabled ? {} : { disabled: true, disabledReason: action.disabledReason })
  }))
}

/** Run the published export called `id`; false when there is none to run. */
export function runExportAction(published: ExportAction[], id: string): boolean {
  const action = published.find((entry) => entry.id === id)
  if (!action?.enabled) return false
  action.run()
  return true
}
