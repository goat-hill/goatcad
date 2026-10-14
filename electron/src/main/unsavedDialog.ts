// Button layout for the native unsaved-changes box (`dialog:confirm-unsaved`).
// Split out from index.ts only so it can be tested — the entry point cannot be
// imported without starting Electron.

import type { UnsavedChoice } from '../preload/dialogTypes'

/**
 * Button order, which is platform convention rather than preference — and the
 * three do not agree. Windows reads `Save / Don't Save / Cancel`. GTK and macOS
 * both *show* `Don't Save / Cancel / Save`, but macOS is spelled backwards here
 * because Electron lays its buttons out right-to-left, which is also what puts
 * index 0 in the default position.
 *
 * Returning choices rather than labels is what lets `defaultId`, `cancelId`, and
 * the reply mapping all derive from one array instead of hand-kept indices that
 * would have to be re-checked per platform.
 */
export const unsavedButtonOrder = (platform: NodeJS.Platform): UnsavedChoice[] => {
  if (platform === 'darwin') return ['save', 'cancel', 'dontSave']
  if (platform === 'win32') return ['save', 'dontSave', 'cancel']
  return ['dontSave', 'cancel', 'save']
}
