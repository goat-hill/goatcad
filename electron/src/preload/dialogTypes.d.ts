/**
 * What the user picked in the unsaved-changes prompt shown when a dirty tab is
 * closed. `cancel` also covers dismissing the sheet (Escape, window close).
 */
export type UnsavedChoice = 'save' | 'dontSave' | 'cancel'

/**
 * Copy for that prompt. The strings arrive already translated because `t()`
 * lives in the renderer, not the main process — the same split the native app
 * menu uses (`menuTypes.d.ts`).
 */
export interface UnsavedPrompt {
  message: string
  detail: string
  save: string
  dontSave: string
  cancel: string
}
