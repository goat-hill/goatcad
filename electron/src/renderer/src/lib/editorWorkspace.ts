// What an editor group is handed by the two things above it: the workspace
// (`EditorArea`, which owns every open document's session and dirty state) and
// the group itself (whether it holds the keyboard, and where its editor's
// context panels go). split-view-workstream.md.

import {
  computed,
  inject,
  onMounted,
  onUnmounted,
  type ComputedRef,
  type InjectionKey,
  type Ref
} from 'vue'
import type { SheetSession } from './schematic/sheetSession'
import type { BoardSession } from './board/boardSession'
import type { TextSession } from './document/textSession'
import type { KicadSymbolLibrary } from './kicad/symbolLibrary'
import type { KicadFootprint } from './kicad/footprint'
import type { SymbolPartAddress } from './symbol/symbolEdit'
import type { SelectionItem } from './history'
import type { Nm } from './kicad/coordinates'
import type { SchematicNetlist } from './board/schematicNetlist'
import type { Tab } from './tabs'
import type { TabFileType } from './tabFileType'
import { canvasMayTakeKeyboard } from './hotkeys'

/**
 * The tab a group has in front. Its live text can run ahead of its document
 * (a text or footprint edit reaches the document on the next flush), so the
 * workspace's saves and buffer reads ask the view first.
 */
export interface FrontView {
  path: () => string | null
  tab: () => Tab | null
  fileType: () => TabFileType
  loading: () => boolean
  content: () => string
  setContent: (text: string) => void
  /** The text as last read from or written to disk. */
  baseline: () => string
  setBaseline: (text: string) => void
}

export interface EditorWorkspace {
  sheetSessionFor: (path: string) => SheetSession | null
  boardSessionFor: (path: string) => BoardSession | null
  librarySessionFor: (path: string) => TextSession<KicadSymbolLibrary, SymbolPartAddress> | null
  footprintSessionFor: (path: string) => TextSession<KicadFootprint, SelectionItem> | null
  /**
   * A sheet's session for a view that is not that sheet's editor (the
   * Components tab): the sheet gets a tab behind the others if it has none, so
   * an edit made through the session has a tab to be dirty on and saved from.
   */
  openSheetSession: (path: string) => Promise<SheetSession | null>
  /** A design copy's text for its tab to load (`lib/designCopy.ts`); null when the design lacks it. */
  designCopyText: (path: string) => Promise<string | null>
  dirtyPaths: Readonly<Ref<Set<string>>>
  setDirty: (path: string, dirty: boolean) => void
  registerFrontView: (view: FrontView) => () => void
  /** Write a tab's content and mark it saved. */
  saveFile: (path: string, content: string) => void
  /** The active project's connection grid (`kicad/project.ts`), or null with none. */
  projectConnectionGrid: Readonly<Ref<Nm | null>>
  /** Moves whenever a sheet's text changes: when the schematic's netlist may have. */
  schematicRevision: Readonly<Ref<number>>
  /** The root schematic's netlist as it is now, for the board checks; null with no schematic. */
  schematicNetlist: () => Promise<SchematicNetlist | null>
}

export const EDITOR_WORKSPACE: InjectionKey<EditorWorkspace> = Symbol('editor-workspace')

export interface EditorGroupContext {
  groupId: string
  /** This group holds the keyboard. Always true in a window with one group. */
  focused: ComputedRef<boolean>
  /** This group's editor is the one whose context panels the shell shows. */
  ownsContext: ComputedRef<boolean>
  /** The shell's right rail; null until the shell has mounted. */
  railTarget: ComputedRef<HTMLElement | null>
  /** Hand this group the keyboard. */
  takeKeyboard: () => void
}

export const EDITOR_GROUP: InjectionKey<EditorGroupContext> = Symbol('editor-group')

/** The enclosing group's keyboard state, or "focused" for a component mounted
 *  outside one (a test, a dialog). */
export function useEditorGroup(): {
  focused: ComputedRef<boolean>
  groupId: string | null
  takeKeyboard: () => void
} {
  const group = inject(EDITOR_GROUP, null)
  return {
    focused: computed(() => group?.focused.value ?? true),
    groupId: group?.groupId ?? null,
    takeKeyboard: () => group?.takeKeyboard()
  }
}

/** The group whose canvas the pointer is over; null over anything else. */
let pointerGroup: string | null = null
export const pointerCanvasGroup = (): string | null => pointerGroup
export const setPointerCanvasGroup = (groupId: string | null): void => {
  pointerGroup = groupId
}

/**
 * Which group a keystroke is for: the one whose canvas is under the pointer,
 * as KiCad's canvas takes the keyboard on mouse enter
 * (`EDA_DRAW_PANEL_GAL::onEnter`) — unless a field is being typed in or a
 * dialog is open — else the focused one (null).
 */
export function keystrokeGroup(): string | null {
  return pointerGroup !== null && canvasMayTakeKeyboard() ? pointerGroup : null
}

/**
 * Where an editor's context panels go. An editor keeps owning its properties
 * rail — it renders the editor's selection — and teleports it into the shell's
 * shared rail, so a split shows ONE set of panels: those of the group that owns
 * the context. Bind as
 * `<Teleport v-if="panels.show" :to="panels.rail" :disabled="panels.inline">`.
 */
export function useContextPanels(): {
  /** False for the group that does not own the context: it draws no panels. */
  show: ComputedRef<boolean>
  /** Outside a group there is no shell to teleport into; render in place. */
  inline: boolean
  rail: ComputedRef<HTMLElement | null>
} {
  const group = inject(EDITOR_GROUP, null)
  if (!group) {
    return {
      show: computed(() => true),
      inline: true,
      rail: computed(() => null)
    }
  }
  return {
    show: computed(() => group.ownsContext.value && !!group.railTarget.value),
    inline: false,
    rail: group.railTarget
  }
}

/**
 * An editor's window-level keydown handler, heard only while its group holds
 * the keyboard. Two editors are mounted in a split and both listen on `window`
 * (a canvas rarely has DOM focus), so without the gate one keystroke would run
 * in both.
 */
export function useGroupKeydown(
  handler: (event: KeyboardEvent) => void,
  options?: AddEventListenerOptions
): void {
  const { focused, groupId, takeKeyboard } = useEditorGroup()
  const listener = (event: KeyboardEvent): void => {
    const target = groupId === null ? null : keystrokeGroup()
    if (target === null ? !focused.value : target !== groupId) return
    // The keyboard moves to the hovered canvas on the key, never on the hover.
    if (!focused.value) takeKeyboard()
    handler(event)
  }
  onMounted(() => window.addEventListener('keydown', listener, options))
  onUnmounted(() => window.removeEventListener('keydown', listener, options))
}
