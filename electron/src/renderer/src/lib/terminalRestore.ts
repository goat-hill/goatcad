// An agent tab comes back with the window (ARCHITECTURE.md §3.12).
//
// A pty does not survive the app quitting, so a plain shell is not restored: it
// would come back as a different shell under the old one's name. An agent tab is
// another matter. What it held was a conversation, both CLIs keep that on disk,
// and launching one in the same directory continues it (`main/terminalAgents.ts`)
// — so a session records its Claude and Codex tabs, and a restore starts each
// again in the pane, the place in the strip and the front-or-behind it had.
//
// A tab's path carries its session id, and the new session has a new one. This
// is the pure half: given what became of each recorded terminal tab, rewrite the
// paths a window's init names them by. The half that starts sessions is App's.

import type { SavedEditorLayout } from '../../../preload/editorLayoutTypes'
import { isSingleTerminalKind, isTerminalTab, terminalTabKind, type Tab } from './tabs'

/** Whether a session should record this tab: every tab but a plain shell. */
export const isSessionTab = (path: string): boolean =>
  !isTerminalTab(path) || isSingleTerminalKind(terminalTabKind(path))

export interface RestorableInit<T extends Tab> {
  tabs: T[]
  activeTabPath: string | null
  editorLayout?: SavedEditorLayout
}

/**
 * `outcomes` maps a recorded terminal tab's path to the tab that stands in for
 * it, or null when it could not be started. A dropped path is simply left out
 * of the layout: `restoreLayout` closes a group that ends up empty.
 */
export const applyTerminalRestore = <T extends Tab, I extends RestorableInit<T>>(
  init: I,
  outcomes: ReadonlyMap<string, Tab | null>
): I => {
  if (outcomes.size === 0) return init
  const rename = (path: string): string | null => {
    const outcome = outcomes.get(path)
    return outcome === undefined ? path : (outcome?.path ?? null)
  }
  const tabs = init.tabs.flatMap((tab) => {
    const outcome = outcomes.get(tab.path)
    if (outcome === undefined) return [tab]
    return outcome ? [{ ...tab, name: outcome.name, path: outcome.path }] : []
  })
  const active = init.activeTabPath === null ? null : rename(init.activeTabPath)
  const editorLayout = init.editorLayout && {
    ...init.editorLayout,
    groups: init.editorLayout.groups.map((group) => ({
      tabs: group.tabs.flatMap((path) => rename(path) ?? []),
      activeTabPath: group.activeTabPath === null ? null : rename(group.activeTabPath)
    }))
  }
  return {
    ...init,
    tabs,
    activeTabPath: active ?? tabs[0]?.path ?? null,
    ...(editorLayout ? { editorLayout } : {})
  }
}
