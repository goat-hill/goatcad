import { hotkeyLabel, matchesHotkey, type HotkeyActionId } from './hotkeys'
import type { IconName } from './icons'
import { tk, type MessageKey } from './messageKey'
import type { ToolbarSearchOp } from './toolSearch'

/**
 * The canvas commands every 2D editor shares beside zoom to fit: KiCad's zoom
 * in and out at the cursor, center on cursor, and zoom to selection. They have
 * keys and tool-search rows but no rail chips — there to be found, not to take
 * room. Each viewport runs them (`runViewCommand`); the editors only route.
 */
export type ViewCommand = 'zoomIn' | 'zoomOut' | 'centerOnCursor' | 'zoomToSelection'

interface ViewCommandDef {
  id: ViewCommand
  icon: IconName
  label: MessageKey
  /** Zoom to selection is unbound, as KiCad leaves it. */
  hotkey?: HotkeyActionId
}

export const VIEW_COMMANDS: readonly ViewCommandDef[] = [
  {
    id: 'zoomIn',
    icon: 'tool-zoom-in',
    label: tk('shared.insertSearch.ops.zoomIn'),
    hotkey: 'editor.zoomIn'
  },
  {
    id: 'zoomOut',
    icon: 'tool-zoom-out',
    label: tk('shared.insertSearch.ops.zoomOut'),
    hotkey: 'editor.zoomOut'
  },
  {
    id: 'centerOnCursor',
    icon: 'tool-zoom-center',
    label: tk('shared.insertSearch.ops.centerOnCursor'),
    hotkey: 'editor.centerOnCursor'
  },
  {
    id: 'zoomToSelection',
    icon: 'tool-zoom-selection',
    label: tk('shared.insertSearch.ops.zoomToSelection')
  }
]

export const isViewCommand = (id: string): id is ViewCommand =>
  VIEW_COMMANDS.some((command) => command.id === id)

/** The view command a key asks for, or null. */
export const viewCommandFor = (event: KeyboardEvent): ViewCommand | null =>
  VIEW_COMMANDS.find(({ hotkey }) => hotkey && matchesHotkey(event, hotkey))?.id ?? null

/**
 * The commands' tool-search rows, in the Navigate group after zoom to fit.
 * Center on cursor acts where the pointer is, which a pick from the search
 * cannot supply, so it is listed dimmed; zoom to selection wants a selection.
 */
export const viewCommandOps = (
  translate: (key: MessageKey) => string,
  hasSelection: boolean
): ToolbarSearchOp[] =>
  VIEW_COMMANDS.map(({ id, icon, label, hotkey }) => ({
    id,
    icon,
    label: translate(label),
    group: 'navigate',
    ...(hotkey ? { hotkey: hotkeyLabel(hotkey) } : {}),
    ...((id === 'zoomToSelection' && !hasSelection) || id === 'centerOnCursor'
      ? { disabled: true }
      : {})
  }))
