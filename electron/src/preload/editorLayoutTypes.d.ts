/**
 * A window's editor split as its session records it (split-view-workstream.md):
 * which tabs sit in which group, by path. Tab order is the session's tab list.
 *
 * Lives here because both processes need it — the renderer owns the layout
 * (`lib/editorGroups.ts`), main persists it with the window (RULES.md §9).
 */
export interface SavedEditorLayout {
  groups: Array<{ tabs: string[]; activeTabPath: string | null }>
  /** Index into `groups` of the one that held the keyboard. */
  focusedGroup: number
  direction: 'row' | 'column'
  /** The first group's share of the split. */
  ratio: number
}
