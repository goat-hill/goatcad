// Which pane answers a cross-select (split-view-workstream.md §6). Pure, so the
// rule is testable apart from the editors it moves.
//
// The pane a probe came from never answers it: fronting the board in the group
// where a symbol was just clicked would cover the schematic being worked in.
// So a probe lands across the split, or in another window, or nowhere.
//
// A design's sheets are many files where KiCad has one schematic window that
// navigates between them. The pane SHOWING a schematic plays that window's
// part: the probed sheet is switched to there, opened there, or — when it is
// open in the other pane — moved there. It is never opened twice, and a pane
// showing anything else is never taken over, whatever is open behind it.

import { pathsOf, type EditorLayout } from './editorGroups'
import { samePath } from './kicad/paths'
import { tabFileType } from './tabFileType'
import type { Tab } from './tabs'

export interface CrossProbeRoute {
  groupId: string
  path: string
  /**
   * `show`: the tab is in `groupId`; bring it to the front. `open`: the sheet
   * is not open in this window; open it in `groupId`. `move`: it is open in
   * another pane; move it to `groupId`.
   */
  action: 'show' | 'open' | 'move'
}

export const routeCrossProbe = (
  layout: EditorLayout,
  tabs: readonly Tab[],
  wanted: 'schematic' | 'pcb',
  /** The sheet holding the symbol, when the probe names one. */
  sheetFile: string | null,
  /** The group the probe was made in; null when it came from another window. */
  fromGroupId: string | null
): CrossProbeRoute | null => {
  const allPaths = tabs.map((tab) => tab.path)
  const byPath = new Map(tabs.map((tab) => [tab.path, tab]))
  const candidates = layout.groups
    .filter((group) => group.id !== fromGroupId)
    .map((group) => {
      const front = group.activeTabPath ? (byPath.get(group.activeTabPath) ?? null) : null
      return {
        id: group.id,
        front,
        frontType: tabFileType(front),
        tabs: pathsOf(layout, allPaths, group.id).map((path) => byPath.get(path) as Tab)
      }
    })

  // Either way the pane that answers is one already SHOWING that kind of editor.
  // A board or a sheet open behind an agent's terminal stays behind it: the
  // selection was made in the other pane, and what is in front here is being
  // read or typed into by someone who did not ask for it to change.
  if (wanted === 'pcb') {
    const showing = candidates.find((group) => group.frontType === 'pcb')
    return showing?.front ? { groupId: showing.id, path: showing.front.path, action: 'show' } : null
  }

  const showing = candidates.find((group) => group.frontType === 'schematic')
  if (!showing?.front) return null
  if (!sheetFile) return { groupId: showing.id, path: showing.front.path, action: 'show' }
  const inPane = showing.tabs.find((tab) => samePath(tab.path, sheetFile))
  if (inPane) return { groupId: showing.id, path: inPane.path, action: 'show' }
  const elsewhere = tabs.find((tab) => samePath(tab.path, sheetFile))
  return elsewhere
    ? { groupId: showing.id, path: elsewhere.path, action: 'move' }
    : { groupId: showing.id, path: sheetFile, action: 'open' }
}
