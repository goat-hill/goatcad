<script setup lang="ts">
/**
 * The window's editor workspace: every open document's session, dirty state and
 * saving, plus the one or two editor groups that show them
 * (split-view-workstream.md). What belongs to the tab in front of a group is
 * `EditorGroup`'s; what outlives a tab switch is here, keyed by path.
 */
import { ref, shallowRef, computed, watch, provide, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  liveHierarchyFs,
  noteOpenSheetChanged,
  openSheetAt,
  openSheetsVersion,
  sameSheetPath,
  setOpenSheetSource
} from '../lib/schematic/openSheets'
import {
  createDesignCopySession,
  isDesignCopyPath,
  parseDesignCopyPath,
  projectSymbolCopy,
  writeSymbolCopy,
  type DesignCopyHost,
  type DesignCopyPlacement
} from '../lib/designCopy'
import { projectFootprintCopy, writeFootprintCopy } from '../lib/board/footprintCopy'
import { createSheetSession, type SheetSession } from '../lib/schematic/sheetSession'
import { createBoardSession, type BoardSession } from '../lib/board/boardSession'
import { BoardWorkerHost } from '../lib/board/worker/boardWorkerHost'
import type { SExprList } from '../lib/kicad/sexpr'
import type { ViewportFrame } from '../lib/agentViewportView'
import { createTextSession, type TextSession } from '../lib/document/textSession'
import { parseKicadSymbolLibrary, serializeKicadSymbolLibrary } from '../lib/kicad/symbolLibrary'
import type { KicadSymbolLibrary } from '../lib/kicad/symbolLibrary'
import { parseKicadFootprint, serializeKicadFootprint } from '../lib/kicad/footprint'
import { formatUpgrader } from '../lib/formatUpgrade'
import { samePath } from '../lib/kicad/paths'
import { migrateBoardViewIds } from '../lib/board/boardViewStore'
import {
  findFootprint,
  indexLoaded,
  loadIndex,
  loadLibraryView,
  onIndexRebuilt
} from '../lib/libraryIndex'
import { ercLibraryContext } from '../lib/schematic/ercLibraries'
import { createLibraryFeed, touchesProjectLibraries } from '../lib/libraryFeed'
import type { ErcContext } from '../lib/schematic/ercContext'
import type { KicadFootprint } from '../lib/kicad/footprint'
import type { SymbolPartAddress } from '../lib/symbol/symbolEdit'
import type { SelectionItem } from '../lib/history'
import { documentKindOf, documentStore, type DocumentHandle } from '../lib/document/documentStore'
import { schematicNetlistOf, type SchematicNetlist } from '../lib/board/schematicNetlist'
import { unannotatedReferences } from '../lib/board/boardSync'
import type { DesignInputs } from '../lib/schematic/sheetAgent'
import { captureSchematicDocument, exportSchematicSvg } from '../lib/engine/schematicCapture'
import { symbolSourcesFor } from '../lib/symbol/symbolSources'
import { SCHEMATIC_GRID_DEFAULTS, useGridSettings } from '../lib/gridPreferences'
import { mmToNm, spacingToMm, type Nm } from '../lib/kicad/coordinates'
import { readProjectConnectionGrid } from '../lib/kicad/project'
import { readProjectTeardropOptions } from '../lib/board/teardrop/projectOptions'
import { onProjectChange } from '../lib/projectBus'
import EditorGroup from './EditorGroup.vue'
import type { McpBatchRequest, McpDesignRequest } from '../../../preload/mcpTypes'
import type { TerminalState } from '../../../preload/terminalTypes'
import { tabDocumentPath, tabParent, type Tab } from '../lib/tabs'
import { matchesHotkey } from '../lib/hotkeys'
import type { MessageKey } from '../lib/messageKey'
import type { RecentEntry } from '../../../preload/recentTypes'
import { EDITOR_WORKSPACE, type FrontView } from '../lib/editorWorkspace'
import { groupIdOf, otherGroup, type EditorLayout } from '../lib/editorGroups'
import { hasContextPanels, tabFileType } from '../lib/tabFileType'
import { contextRailWidth } from '../lib/panelLayout'

const { t } = useI18n()

const props = defineProps<{
  projectPath: string | null
  /** The active project's `.kicad_pro`, or null when none is active. */
  projectFile?: string | null
  /** The sheet the project's boards are synced from (App's `rootSchematicPath`), or null. */
  rootSchematic?: string | null
  /** Every tab in the window, in order; a group shows its own slice. */
  openTabs: Tab[]
  /** The focused group's front tab. */
  activeTabPath: string | null
  layout: EditorLayout
  /** The keyboard moved groups by hotkey; the terminal in front there takes focus. */
  groupFocusSignal?: { groupId: string; nonce: number } | null
  windowId: number
  /** Cross-sheet reveal request routed to the schematic editor for its path. */
  /** Settings category to land on; see App.openSettingsTab. */
  pendingSettingsCategory?: { category: string; nonce: number } | null
  pendingFocus?: {
    path: string
    uuids: string[]
    at?: { x: number; y: number }
    /** The finding that asked, by key: the editor selects it in its own list. */
    finding?: string
    nonce: number
  } | null
  pendingBoardProbe?: {
    path: string
    symbolUuids: string[]
    references: string[]
    nonce: number
  } | null
  /** Reveal request routed to the symbol library editor showing its .kicad_sym. */
  pendingSymbolFocus?: { path: string; symbol: string; nonce: number } | null
  /** Symbol add/rename/delete op routed to the symbol library editor for its .kicad_sym. */
  pendingSymbolOp?: {
    path: string
    op: 'add' | 'rename' | 'delete'
    symbol?: string
    newName?: string
    nonce: number
  } | null
  showWelcomeOnStartup: boolean
  /** Passed through to the Welcome tab's Recent list; App owns the data. */
  recents: RecentEntry[]
  /**
   * False until the main process has told this window what it holds. The
   * no-file placeholder below is a claim ("you have nothing open") that is not
   * yet true during those first frames, and a window restoring a project would
   * flash it before its tabs arrive. Defaults to true so a caller that has
   * nothing to wait for need not pass it.
   */
  sessionReady?: boolean
  /**
   * Live state of every open terminal session, keyed by tab path. App owns the
   * poll (one round trip answers for every session), because the tab strip is
   * not the only reader — closing a running terminal asks first.
   */
  terminalStates?: Record<string, TerminalState>
}>()

const emit = defineEmits<{
  (e: 'focus-group', groupId: string): void
  (e: 'split-tab', path: string): void
  (e: 'move-tab', path: string, groupId: string, beforePath: string | null): void
  (e: 'resize-split', ratio: number): void
  /** Relayed from PartsView's setup card straight to Settings ▸ Distributor APIs. */
  (e: 'open-settings', category?: string): void
  /** Relayed from Settings ▸ About's Share feedback button. */
  (e: 'share-feedback'): void
  /** Close with no say in it — the tab moved windows, or its file is gone. */
  (e: 'close-tab', path: string): void
  /** The user asked to close this tab; unsaved edits get a prompt first. */
  (e: 'request-close-tab', path: string): void
  (e: 'select-tab', path: string): void
  (e: 'pin-tab', path: string): void
  (e: 'reorder-tabs', tabs: Tab[]): void
  (e: 'save-file', path: string, content: string): void
  (e: 'open-symbol', path: string, uuid: string): void
  /** Open a sheet or board and reveal items (by uuid) or a point on it, mm. */
  (
    e: 'reveal-in-document',
    path: string,
    uuids: string[],
    at?: { x: number; y: number },
    finding?: string
  ): void
  (e: 'file-created', path: string): void
  /** A command edited a sheet no tab holds; App opens it behind the active one. */
  (e: 'open-background', path: string): void
  (e: 'open-library-symbol', path: string, symbol: string): void
  /** The symbol now shown in the symbol editor — App puts it in the tab title. */
  (e: 'active-symbol', path: string, name: string | null): void
  /** Every symbol the open `.kicad_sym` buffer holds — the left bar lists these. */
  (e: 'symbol-names', path: string, names: string[]): void
  (e: 'update-loading-path', path: string | null): void
  (e: 'open-folder'): void
  (e: 'open-project'): void
  (e: 'open-recent', entry: RecentEntry): void
  (e: 'open-file-dialog'): void
  (e: 'new-project'): void
  (e: 'open-sample'): void
  (e: 'open-file', node: { name: string; path: string }): void
  (e: 'update:showWelcomeOnStartup', value: boolean): void
  /** A Save As... wrote the active editor's content to a new path on disk. */
  (e: 'saved-as', node: { name: string; path: string }): void
  /** Open the Manufacture tab for a board (from the PCB editor). */
  (e: 'open-manufacture', boardPath: string): void
  /** Open Update PCB from Schematic on a board (from the PCB editor). */
  (e: 'update-from-schematic', boardPath: string): void
  (e: 'open-components', rootSheetPath: string): void
  /** Open a design's Schematic Setup, by its root sheet. */
  (e: 'open-schematic-setup', rootSheetPath: string): void
  /** Open a board's Board Setup, by its board. */
  (e: 'open-board-setup', boardPath: string): void
}>()

export interface SchematicAgentApi {
  agentBatch: (request: McpBatchRequest) => Promise<unknown>
  agentDispatch: (request: McpDesignRequest) => Promise<unknown>
  /** The design as a board sync reads it (`lib/board/boardAgent.ts`). */
  agentDesign: () => Promise<DesignInputs | null>
  /** Each item's box by id, sheet mm, for a viewport framing a write. */
  agentItemFrames: () => Map<string, ViewportFrame>
}

/**
 * One session per open schematic (`lib/schematic/sheetSession.ts`): the parsed
 * sheet, its commands and its undo, for as long as the tab is open. The editor
 * in front draws it and an agent edits it, whichever tab is showing, so there
 * is one document and one revision per file rather than one per reader.
 */
const sheetSessions = new Map<string, SheetSession>()
const schematicGrid = useGridSettings('schematic', SCHEMATIC_GRID_DEFAULTS)

/** The session for an open document, made on first use. Null when no document
 *  is open for the path (the tab has not loaded yet). */
/** A library footprint's pad numbers, read through the index; null when unreadable. */
const footprintPads = async (libId: string): Promise<string[] | null> => {
  if (!indexLoaded()) await loadIndex().catch(() => {})
  const record = findFootprint(libId)
  if (!record) return null
  const read = await window.api.readFile(record.file)
  if (!read.success || typeof read.content !== 'string') return null
  try {
    return parseKicadFootprint(read.content).pads.map((pad) => pad.number)
  } catch {
    return null
  }
}

/**
 * Whether each footprint's 3D model file is on this machine, for `bom_get`'s
 * ${MODEL} column. Resolution only — no mesh is read, since the question is
 * whether the board can render whole, not what the part looks like. Each
 * distinct path is resolved once per call.
 */
const footprintModelStatus = async (libIds: string[]): Promise<Record<string, string>> => {
  if (!indexLoaded()) await loadIndex().catch(() => {})
  const resolvedPaths = new Map<string, boolean>()
  const out: Record<string, string> = {}
  for (const libId of libIds) {
    const record = findFootprint(libId)
    if (!record) {
      out[libId] = 'unknown'
      continue
    }
    if (!record.models.length) {
      out[libId] = 'none'
      continue
    }
    let status = 'not-installed'
    for (const path of record.models) {
      const key = `${path}\u0000${record.file}`
      let hit = resolvedPaths.get(key)
      if (hit === undefined) {
        const resolved = await window.api.resolveModelPath(path, record.file, props.projectPath)
        hit = 'path' in resolved
        resolvedPaths.set(key, hit)
        if (!hit && 'reason' in resolved && resolved.reason === 'missing') status = 'missing'
      }
      // Any one file being there is enough: the board renders.
      if (hit) {
        status = 'resolved'
        break
      }
    }
    out[libId] = status
  }
  return out
}

// ERC's library rules read which libraries the project reaches: loaded per
// project, again when the library index finishes a rebuild, and the project's
// own layer again when one of its libraries or tables is written (an agent's
// symbol_create). A sheet's checks wait on the latest read (`SheetSession.ready`).
const ercLibraries = shallowRef<ErcContext | undefined>(undefined)
const ercLibraryFeed = createLibraryFeed(
  async () => ercLibraryContext(await loadLibraryView(props.projectPath)),
  (context) => (ercLibraries.value = context)
)
watch(() => props.projectPath, ercLibraryFeed.refresh, { immediate: true })
onUnmounted(onIndexRebuilt(ercLibraryFeed.refresh))
onUnmounted(
  onProjectChange((changes) => {
    if (touchesProjectLibraries(changes)) ercLibraryFeed.refreshSoon()
  })
)
onUnmounted(ercLibraryFeed.dispose)

const sessionFor = (path: string): SheetSession | null => {
  const existing = sheetSessions.get(path)
  if (existing) return existing
  const sheetDocument = documentStore.get(path)
  if (!sheetDocument) return null
  const session = createSheetSession({
    filePath: path,
    name: path.split(/[\\/]/).pop() ?? path,
    document: sheetDocument,
    commit: (edits) =>
      handleSheetUpdates(
        edits.map(({ path: edited, after, loaded }) => ({ path: edited, content: after, loaded }))
      ),
    openSheet: openSheetAt,
    fs: liveHierarchyFs,
    libraries: symbolSourcesFor(path),
    gridStep: () => mmToNm(spacingToMm(schematicGrid.value.spacing, schematicGrid.value.unit)),
    label: (key, count) => (count === undefined ? t(key) : t(key, count)),
    createFile: (file, content) => window.api.createFile(file, content),
    fileCreated: (file) => emit('file-created', file),
    siblingsVersion: () => openSheetsVersion.value,
    capture: async (document, box, maxPixels) => captureSchematicDocument(document, box, maxPixels),
    captureSvg: async (document, box, background) => exportSchematicSvg(document, box, background),
    footprintPads,
    footprintModelStatus,
    ercLibraries: () => ercLibraries.value,
    ercLibrariesReady: ercLibraryFeed.ready,
    readOnly: () => isReadOnlySource(path)
  })
  sheetSessions.set(path, session)
  return session
}

/**
 * One session per open board (`lib/board/boardSession.ts`): the parsed board,
 * its structural undo and the text it still owes, for as long as the tab is
 * open. A tab switch neither re-parses the board nor drops its history, and an
 * agent's sync is the same undoable command a gesture is.
 */
const boardSessions = new Map<string, BoardSession>()
/** The project's teardrop settings, which every board session builds teardrops with. */
let teardropOptions: Awaited<ReturnType<typeof readProjectTeardropOptions>> = null
/**
 * One session per open symbol library and footprint (`lib/document/textSession.ts`):
 * the parsed model, its commands and its undo, for as long as the tab is open.
 * The editor draws it and an agent writes to it, so a generated symbol lands in
 * the buffer as an undoable step rather than on the file underneath.
 */
const librarySessions = new Map<string, TextSession<KicadSymbolLibrary, SymbolPartAddress>>()
const footprintSessions = new Map<string, TextSession<KicadFootprint, SelectionItem>>()

const librarySessionFor = (
  path: string
): TextSession<KicadSymbolLibrary, SymbolPartAddress> | null => {
  const existing = librarySessions.get(path)
  if (existing) return existing
  const copy = parseDesignCopyPath(path)
  if (copy?.kind === 'symbol') {
    const parent = sessionFor(copy.parent)
    if (!parent) return null
    const session = createDesignCopySession<KicadSymbolLibrary, SymbolPartAddress>({
      host: sheetCopyHost(parent, copy.parent, copy.id, copy.placement),
      parse: parseKicadSymbolLibrary,
      serialize: serializeKicadSymbolLibrary,
      onText: (text) => setBufferContent(path, text, false),
      onMissing: () => emit('close-tab', path)
    })
    librarySessions.set(path, session)
    return session
  }
  const document = documentStore.get(path)
  if (!document) return null
  const session = createTextSession<KicadSymbolLibrary, SymbolPartAddress>({
    document,
    parse: parseKicadSymbolLibrary,
    serialize: serializeKicadSymbolLibrary,
    commit: (content) => handleSheetUpdates([{ path, content }]),
    readOnly: () => isReadOnlySource(path)
  })
  librarySessions.set(path, session)
  return session
}

/**
 * A sheet's symbol copy as a design-copy tab reads and writes it: the copy
 * projected from the sheet's parsed document, each edit one command on the
 * sheet's session, the sheet's undo, the sheet's read-only state.
 */
const sheetCopyHost = (
  session: SheetSession,
  parent: string,
  id: string,
  placement?: DesignCopyPlacement
): DesignCopyHost => ({
  read: () => {
    const document = session.document()
    return document ? projectSymbolCopy(document, id, placement) : null
  },
  write: (label, text) => {
    const before = session.modelRevision()
    session.runCommand(label, () => {
      const document = session.document()
      if (document) writeSymbolCopy(document, id, text, placement)
    })
    return session.modelRevision() !== before
  },
  undo: () => session.undo() !== null,
  redo: () => session.redo() !== null,
  mark: () => session.mark(),
  rollback: (mark) => session.rollback(mark),
  canUndo: () => session.canUndo(),
  canRedo: () => session.canRedo(),
  undoLabel: () => null,
  redoLabel: () => null,
  subscribe: (listener) => session.subscribe(listener),
  readOnly: () => isReadOnlySource(parent)
})

/** A board's footprint copy as a design-copy tab reads and writes it, over the board's session. */
const boardCopyHost = (session: BoardSession, parent: string, id: string): DesignCopyHost => ({
  read: () => {
    const board = session.board()
    return board ? projectFootprintCopy(board, id) : null
  },
  write: (label, text) =>
    session.runCommand(label, () => {
      const board = session.board()
      if (board) writeFootprintCopy(board, id, text)
    }),
  undo: () => session.undo() !== null,
  redo: () => session.redo() !== null,
  mark: () => session.mark(),
  rollback: (mark) => session.rollback(mark),
  canUndo: () => session.canUndo(),
  canRedo: () => session.canRedo(),
  undoLabel: () => session.undoLabel(),
  redoLabel: () => session.redoLabel(),
  subscribe: (listener) => session.subscribe(listener),
  readOnly: () => isReadOnlySource(parent) || session.readOnly()
})

/** A design copy's text as its tab first loads it, the design file opened behind if need be. */
const designCopyText = async (path: string): Promise<string | null> => {
  const copy = parseDesignCopyPath(path)
  if (!copy) return null
  if (!props.openTabs.some((tab) => tab.path === copy.parent)) emit('open-background', copy.parent)
  if (copy.kind === 'footprint') {
    const session = await boardSession(copy.parent)
    const board = session?.board()
    return board ? projectFootprintCopy(board, copy.id) : null
  }
  const session = await openSheetSession(copy.parent)
  const document = session?.document()
  return document ? projectSymbolCopy(document, copy.id, copy.placement) : null
}

const footprintSessionFor = (path: string): TextSession<KicadFootprint, SelectionItem> | null => {
  const existing = footprintSessions.get(path)
  if (existing) return existing
  const copy = parseDesignCopyPath(path)
  if (copy?.kind === 'footprint') {
    const parent = boardSessionFor(copy.parent)
    if (!parent) return null
    const session = createDesignCopySession<KicadFootprint, SelectionItem>({
      host: boardCopyHost(parent, copy.parent, copy.id),
      parse: parseKicadFootprint,
      serialize: serializeKicadFootprint,
      onText: (text) => setBufferContent(path, text, false),
      onMissing: () => emit('close-tab', path)
    })
    footprintSessions.set(path, session)
    return session
  }
  const document = documentStore.get(path)
  if (!document) return null
  const session = createTextSession<KicadFootprint, SelectionItem>({
    document,
    parse: parseKicadFootprint,
    serialize: serializeKicadFootprint,
    commit: (content) => handleSheetUpdates([{ path, content }]),
    readOnly: () => isReadOnlySource(path)
  })
  footprintSessions.set(path, session)
  return session
}

/**
 * Run an agent's edit on an open symbol library through that library's own
 * session, so it lands in the tab as one undoable step. False when no session
 * holds it, and the caller writes the file instead.
 */
const editOpenLibrary = (
  path: string,
  label: MessageKey,
  mutate: (library: KicadSymbolLibrary) => void
): boolean => {
  const session = librarySessions.get(path)
  if (!session?.model()) return false
  return session.runCommand(t(label), mutate)
}

/** The agent's door to a footprint document: its session, the document opened
 *  in the store when no tab has loaded it yet. */
const footprintSession = async (
  path: string
): Promise<TextSession<KicadFootprint, SelectionItem> | null> => {
  // A board's copy is a projection of the board: its session needs the board's,
  // and the board a tab behind for the unsaved mark the write leaves.
  const copy = parseDesignCopyPath(path)
  if (copy?.kind === 'footprint') {
    if (!props.openTabs.some((tab) => tab.path === copy.parent))
      emit('open-background', copy.parent)
    return (await boardSession(copy.parent)) ? footprintSessionFor(path) : null
  }
  if (!documentStore.has(path)) {
    const read = await window.api.readFile(path)
    if (!read.success || read.content === undefined) return null
    documentStore.open(path, await formatUpgrader.upgrade(path, read.content))
  }
  return footprintSessionFor(path)
}

/** The agent's door to a symbol library or a sheet's symbol copy: its session,
 *  the document (or the copy's sheet) opened when no tab has loaded it yet. */
const librarySession = async (
  path: string
): Promise<TextSession<KicadSymbolLibrary, SymbolPartAddress> | null> => {
  // A sheet's copy is a projection of the sheet: its session needs the sheet's,
  // and the sheet a tab behind for the unsaved mark the write leaves.
  const copy = parseDesignCopyPath(path)
  if (copy?.kind === 'symbol') {
    return (await openSheetSession(copy.parent)) ? librarySessionFor(path) : null
  }
  if (!documentStore.has(path)) {
    const read = await window.api.readFile(path)
    if (!read.success || read.content === undefined) return null
    documentStore.open(path, await formatUpgrader.upgrade(path, read.content))
  }
  return librarySessionFor(path)
}

/**
 * A file was rewritten on disk by an agent's library write: a tab that holds
 * it takes the new text as saved, and its session re-reads it. The caller has
 * already refused the write when the tab held unsaved edits.
 */
const reloadOpenFile = (path: string, text: string): void => {
  if (!documentStore.has(path)) return
  setBufferContent(path, text, false)
  footprintSessions.get(path)?.sync()
  librarySessions.get(path)?.sync()
}

const boardSessionFor = (path: string): BoardSession | null => {
  const existing = boardSessions.get(path)
  if (existing) return existing
  const boardDocument = documentStore.get(path)
  if (!boardDocument) return null
  // The board's refills, checks and ratsnest run in a worker that follows the
  // session's board (docs/performance-workstream.md, "The board worker").
  const worker = new BoardWorkerHost(() => {
    const board = session.board()
    return board ? { text: session.flushSync(), root: board._raw as SExprList } : null
  })
  const session = createBoardSession({
    filePath: path,
    document: boardDocument,
    commit: (content) => handleSheetUpdates([{ path, content }]),
    readOnly: () => isReadOnlySource(path),
    worker
  })
  // The document answers `text()` with what the session owes, so a save or an
  // agent's read never sees a board's last edit missing.
  boardDocument.attachTextSource({
    pending: () => session.textPending(),
    flush: () => session.flushSync()
  })
  session.setTeardropOptions(teardropOptions)
  boardSessions.set(path, session)
  return session
}

/**
 * The agent's door to a board: its session, loaded, with the document opened
 * in the store when no tab has loaded it yet (the caller has put a tab behind
 * the active one). Null when the file cannot be read.
 */
const boardSession = async (path: string): Promise<BoardSession | null> => {
  if (!documentStore.has(path)) {
    const read = await window.api.readFile(path)
    if (!read.success || read.content === undefined) return null
    documentStore.open(path, await formatUpgrader.upgrade(path, read.content))
  }
  const session = boardSessionFor(path)
  if (!session) return null
  if (!session.board() && !session.parseError()) {
    const text = documentStore.get(path)?.text()
    if (text) await session.load(text)
  }
  return session
}

/** The agent's door to any open sheet, in front or behind. Opens the tab
 *  behind the active one when none holds it, so an unsaved edit has somewhere
 *  to live and its dirty marker is visible. */
const sheetAgent = async (path: string): Promise<SchematicAgentApi | null> => {
  if (!documentStore.has(path)) {
    const read = await window.api.readFile(path)
    if (!read.success || read.content === undefined) return null
    documentStore.open(path, await formatUpgrader.upgrade(path, read.content))
  }
  const session = sessionFor(path)
  if (!session) return null
  return {
    agentDispatch: session.agent.dispatch,
    agentBatch: session.agent.batch,
    agentDesign: session.agent.designInputs,
    agentItemFrames: session.agent.itemFrames
  }
}

const openSheetSession = async (path: string): Promise<SheetSession | null> => {
  if (!props.openTabs.some((tab) => tab.path === path)) emit('open-background', path)
  if (!documentStore.has(path)) {
    const read = await window.api.readFile(path)
    if (!read.success || read.content === undefined) return null
    documentStore.open(path, await formatUpgrader.upgrade(path, read.content))
  }
  return sessionFor(path)
}

// The active project's connection grid, which the symbol checks measure pins against.
const projectConnectionGrid = ref<Nm | null>(null)
const readConnectionGrid = async (): Promise<void> => {
  const file = props.projectFile
  const grid = file ? await readProjectConnectionGrid(file) : null
  if (file === props.projectFile) projectConnectionGrid.value = grid
}
watch(() => props.projectFile, readConnectionGrid, { immediate: true })

const readTeardropOptions = async (): Promise<void> => {
  const file = props.projectFile
  const options = file ? await readProjectTeardropOptions(file) : null
  if (file !== props.projectFile) return
  teardropOptions = options
  for (const session of boardSessions.values()) session.setTeardropOptions(options)
}
watch(() => props.projectFile, readTeardropOptions, { immediate: true })

// The trees those sessions resolved follow the project's sheet files, and the
// project file's settings.
const stopSheetWatch = onProjectChange((changes) => {
  const touchesTree = changes.some(
    (change) =>
      (change.kind === 'file-created' ||
        change.kind === 'file-deleted' ||
        change.kind === 'file-renamed') &&
      change.fileType === 'schematic'
  )
  const touchesProject = changes.some(
    (change) => 'fileType' in change && change.fileType === 'project'
  )
  if (touchesProject) {
    void readConnectionGrid()
    void readTeardropOptions()
  }
  if (touchesTree || touchesProject) {
    for (const session of sheetSessions.values()) void session.reloadHierarchy()
  }
})
onUnmounted(stopSheetWatch)

// The tab each group has in front. A front tab's live text can run ahead of its
// document, so saves and buffer reads ask the view before the store. A view is
// found by its document's path: a Board Setup tab in front is the live view of
// its board.
const frontViews = new Set<FrontView>()
const frontViewOf = (path: string): FrontView | null => {
  for (const view of frontViews) if (view.path() === path) return view
  return null
}
const focusedView = (): FrontView | null =>
  props.activeTabPath ? frontViewOf(tabDocumentPath(props.activeTabPath)) : null

// Unsaved-edit state, tracked per tab path so the dirty dot survives a tab
// switch (VS Code behavior): the indicator stays on every edited-but-unsaved
// tab, not just the one in front. Each group reads its front tab's slice.
const dirtyPaths = ref(new Set<string>())

const setDirty = (path: string, dirty: boolean): void => {
  if (dirty) dirtyPaths.value.add(path)
  else dirtyPaths.value.delete(path)
}

// Every open tab's document lives in `documentStore`, keyed by tab path. Switching back
// to an open tab restores from here synchronously — the new editor mounts with
// its content in the same patch, so no disk round-trip and no blank frame —
// and unsaved edits survive the switch. Entries are dropped when a tab closes,
// so memory tracks the open-tab set. Text tabs keep re-reading from disk: they
// have no WebGL mount gap to hide, and files like .kicad_pro can be rewritten
// behind the editor's back (BOM settings), which a cache would mask.

// Cross-sheet readers (hierarchy resolution, connectivity, the checks over
// both) need every open sheet, not just the one with an editor — see
// `lib/schematic/openSheets.ts`. This map is the only thing that has them.
const stopOpenSheetSource = setOpenSheetSource(
  (path) => documentStore.find(path, sameSheetPath)?.text() ?? null
)
onUnmounted(stopOpenSheetSource)

// A document that changes behind its tab — a board left with edits still to
// write, a sheet an agent edited — shows it on the tab.
const stopDocumentDirty = documentStore.subscribe((document) => {
  if (!frontViewOf(document.path)) setDirty(document.path, document.isDirty())
})
onUnmounted(stopDocumentDirty)

const markSaved = (path: string, content: string): void => {
  documentStore.get(path)?.markSaved(content)
  setDirty(path, false)
  frontViewOf(path)?.setBaseline(content)
}

watch(
  // A view keeps its parent's document and session open until it closes too,
  // so a parent closed ahead of its children never leaves one on a dropped session.
  () =>
    props.openTabs.flatMap((tab) => {
      const parent = tabParent(tab.path)
      return parent?.view ? [tabDocumentPath(tab.path), parent.path] : [tabDocumentPath(tab.path)]
    }),
  (paths) => {
    const open = new Set(paths)
    for (const path of documentStore.paths()) {
      if (!open.has(path)) documentStore.close(path)
    }
    for (const path of [...sheetSessions.keys()]) {
      if (!open.has(path)) sheetSessions.delete(path)
    }
    for (const path of [...boardSessions.keys()]) {
      if (!open.has(path)) {
        boardSessions.get(path)?.dispose()
        boardSessions.delete(path)
      }
    }
    for (const path of [...librarySessions.keys()]) {
      if (!open.has(path)) {
        const session = librarySessions.get(path) as { dispose?: () => void } | undefined
        session?.dispose?.()
        librarySessions.delete(path)
      }
    }
    for (const path of [...footprintSessions.keys()]) {
      if (!open.has(path)) {
        // A board's copy listens to the board's session; let it go with the tab.
        const session = footprintSessions.get(path) as { dispose?: () => void } | undefined
        session?.dispose?.()
        footprintSessions.delete(path)
      }
    }
    for (const path of [...dirtyPaths.value]) {
      if (!open.has(path)) dirtyPaths.value.delete(path)
    }
  }
)

/**
 * A command in the active editor rewrote other sheets — annotating a whole
 * design — and undo or redo of it does the same. Each lands in its tab's
 * buffer, dirty against what was loaded, exactly as if edited there. A sheet
 * no tab holds is opened behind the active one first: the tab store is the
 * only place an unsaved edit can live, and a save has to find it.
 */
const handleSheetUpdates = (
  updates: Array<{ path: string; content: string; loaded?: string }>
): void => {
  for (const { path, content, loaded: onDisk } of updates) {
    if (!documentStore.has(path) && !frontViewOf(path)) {
      emit('open-background', path)
      // `loaded` is what the command read from disk, so an undo back to it
      // reads clean rather than as an edit of nothing.
      documentStore.open(path, content, onDisk ?? '')
    }
    const loaded = documentStore.get(path)?.baseline() ?? frontViewOf(path)?.baseline() ?? ''
    setBufferContent(path, content, content !== loaded)
  }
}

/**
 * Write a tab's text. A file read at an older KiCad version is written at the
 * current one (it was migrated on load), and with it whatever must move with
 * it: the rest of a legacy hierarchy, from its buffers or its migrated text,
 * and the project file (lib/formatUpgrade.ts).
 */
const writeTab = (path: string, content: string): void => {
  const pending = formatUpgrader.isPendingUpgrade(path)
  const group = pending ? formatUpgrader.saveGroupOf(path) : null
  emit('save-file', path, content)
  if (!pending) return
  // Still in the old ids until the save is noted.
  if (formatUpgrader.stateOf(path)?.format === 'kicad_pcb') void migrateBoardViewIds(path)
  formatUpgrader.noteSaved(path)
  for (const file of group?.files ?? []) {
    if (samePath(file, path) || !formatUpgrader.isPendingUpgrade(file)) continue
    const open = bufferContent(file)
    const text = open ?? formatUpgrader.migratedText(file)
    if (text === undefined) continue
    emit('save-file', file, text)
    if (open !== null) markSaved(file, text)
    formatUpgrader.noteSaved(file)
  }
  if (formatUpgrader.stateOf(path)?.format !== 'kicad_sch') return
  void formatUpgrader.projectUpgrade(path).then((project) => {
    if (project) emit('save-file', project.file, project.text)
  })
}

const handleSaveFile = (path: string, content: string): void => {
  writeTab(path, content)
  markSaved(path, content)
}

/** Save a tab that is in front of a group, its live text first. */
const saveFrontTab = async (view: FrontView, path: string): Promise<void> => {
  // The PCB editor derives its document lazily; bring it current first. The
  // flush is cooperative (frame-budget slices), so a save never blocks the
  // thread — and a non-null result means there WAS an outstanding edit, even
  // if the dirty flag hasn't caught the just-landed emit yet.
  const session = boardSessions.get(path)
  const flushed = session?.textPending() ? await session.flush() : null
  // A file waiting on its upgrade saves even unedited: the save is the upgrade.
  const upgrading = formatUpgrader.isPendingUpgrade(path)
  if (!dirtyPaths.value.has(path) && flushed === null && !upgrading) return
  const content = flushed ?? view.content()
  writeTab(path, content)
  markSaved(path, content)
}

/** Save the focused group's front tab (Ctrl/Cmd+S, File ▸ Save). */
const saveCurrentFile = async (): Promise<void> => {
  // A child tab saves its parent's file.
  const parent = props.activeTabPath ? tabParent(props.activeTabPath)?.path : undefined
  const view = parent !== undefined ? frontViewOf(parent) : focusedView()
  const path = parent ?? view?.path()
  if (view && path) await saveFrontTab(view, path)
  else if (path) await savePath(path)
}

// ---- reference forwarding (projects.md §8.3) -------------
// A rename rewrites files that point at the renamed one. For any such file
// that is open, the edit must land on the *buffer*, never on disk behind the
// editor: a disk write under an unsaved buffer is lost on the next save, and a
// clean open tab left showing pre-edit content saves stale bytes just as badly.
// App.vue drives this — it reads the live buffer, splices, and writes it back.

/** Paths of open tabs with unsaved edits (snapshot). */
const dirtyBufferPaths = (): string[] => [...dirtyPaths.value]

/**
 * Tabs nothing may be written back from: virtual tabs over a read-only source,
 * and files from a KiCad newer than we write or older than we open.
 */
const isReadOnlySource = (path: string): boolean =>
  (isDesignCopyPath(path) && isReadOnlySource(parseDesignCopyPath(path)?.parent ?? path)) ||
  formatUpgrader.isReadOnly(path)

/**
 * Does closing this tab lose work? Read-only sources answer no even when their
 * buffer differs: offering to save what cannot be written is a dead end.
 */
const hasUnsavedEdits = (path: string): boolean =>
  dirtyPaths.value.has(path) && !isReadOnlySource(path)

/** Every open tab whose unsaved edits a save would actually persist. */
const unsavedPaths = (): string[] => [...dirtyPaths.value].filter((p) => !isReadOnlySource(p))

/** Write one tab's buffer, active or not. Used by the close-time save prompts. */
const savePath = async (path: string): Promise<void> => {
  if (!hasUnsavedEdits(path)) return
  const view = frontViewOf(path)
  if (view) {
    await saveFrontTab(view, path)
    return
  }
  const doc = documentStore.get(path)
  if (!doc?.isDirty()) return
  const content = doc.text()
  writeTab(path, content)
  markSaved(path, content)
}

/**
 * The bytes a save of this tab would write, brought current first — or null
 * when it is read-only or has nothing to write. For the agent's `project.save`,
 * which wants the write's result back rather than an emit it cannot await:
 * App writes these and then calls `markSaved`, the same two steps `savePath`
 * takes through the event.
 */
const contentToSave = async (path: string): Promise<string | null> => {
  if (!hasUnsavedEdits(path)) return null
  const view = frontViewOf(path)
  if (view) {
    const session = boardSessions.get(path)
    const flushed = session?.textPending() ? await session.flush() : null
    return flushed ?? view.content()
  }
  const doc = documentStore.get(path)
  return doc?.isDirty() ? doc.text() : null
}

/** Live buffer content for an open tab, or null when the tab isn't open. */
const bufferContent = (path: string): string | null => {
  const view = frontViewOf(path)
  if (view) return view.content()
  return documentStore.get(path)?.text() ?? null
}

/**
 * Replace an open tab's live buffer after a reference rewrite. `dirty: true`
 * keeps the edit buffer-only (the tab was already unsaved — the user's save
 * persists it); `dirty: false` means the rewrite also hit disk, so the buffer
 * is re-baselined clean and stays in sync.
 */
const setBufferContent = (path: string, content: string, dirty: boolean): void => {
  documentStore.get(path)?.setText(content, { saved: !dirty })
  const view = frontViewOf(path)
  if (view) {
    view.setContent(content)
    if (!dirty) view.setBaseline(content)
  }
  setDirty(path, dirty)
  noteOpenSheetChanged()
}

// Editors whose content is the file's serialized source; the viewer-only
// types (model3d, image, pdf, unsupported, welcome, settings) have nothing to
// write — settings persist through the config store, not a file save.
const SAVABLE_TYPES = ['text', 'html', 'schematic', 'pcb', 'library-symbol', 'library-footprint']

// Save As (File menu): pick a target with the native dialog and write the
// active editor's content there. The write happens here — not via the
// 'save-file' round-trip — so the new file exists on disk before 'saved-as'
// asks App to refresh the tree and open it as a tab.
const saveFileAs = async (): Promise<void> => {
  const view = focusedView()
  const tab = view?.tab()
  if (!view || !tab || !SAVABLE_TYPES.includes(view.fileType()) || view.loading()) return
  // Bring a board's lazily-derived text current before any content read below.
  const flushing = boardSessions.get(tab.path)
  if (flushing?.textPending()) await flushing.flush()
  // Virtual tabs (design-copy://, readonly-lib://) have no on-disk path;
  // offer just the display name and let the dialog pick the directory.
  const defaultPath = tab.path.includes('://') ? tab.name : tab.path
  const targetPath = await window.api.saveFileDialog(defaultPath)
  if (!targetPath) return
  try {
    const res = await window.api.createFile(targetPath, view.content())
    if (!res.success) {
      alert(t('app.errors.saveFile', { error: res.error }))
      return
    }
  } catch (err) {
    console.error(err)
    return
  }
  if (targetPath === tab.path) {
    // Saved over itself — that's a plain save, not a new tab.
    markSaved(targetPath, view.content())
    return
  }
  const name = targetPath.slice(
    Math.max(targetPath.lastIndexOf('/'), targetPath.lastIndexOf('\\')) + 1
  )
  emit('saved-as', { name, path: targetPath })
}

// Save All (File menu): every open tab with unsaved edits. Inactive tabs —
// text tabs included, since an edited text tab now keeps its content across a
// switch — live in the document store; the active tab is also covered by
// saveCurrentFile (a front tab's live text is authoritative).
const saveAllFiles = (): void => {
  for (const doc of documentStore.documents()) {
    if (isReadOnlySource(doc.path) || !doc.isDirty()) continue
    const content = doc.text()
    writeTab(doc.path, content)
    markSaved(doc.path, content)
  }
  void saveCurrentFile()
}

// The root schematic's netlist as the board checks read it: the design as it
// is now, unsaved edits included, as KiCad's DRC fetches it from the
// schematic editor. A sheet with no tab is read without one; the netlist is
// kept until a sheet's text changes.
const schematicRevision = ref(0)
const sheetRevisions = new WeakMap<DocumentHandle, number>()
const stopSchematicWatch = documentStore.subscribe((document) => {
  if (documentKindOf(document.path) !== 'schematic') return
  if (sheetRevisions.get(document) === document.revision()) return
  sheetRevisions.set(document, document.revision())
  schematicRevision.value++
})
onUnmounted(stopSchematicWatch)
let netlistCache: { key: string; netlist: Promise<SchematicNetlist | null> } | null = null
const schematicNetlist = (): Promise<SchematicNetlist | null> => {
  const root = props.rootSchematic
  if (!root) return Promise.resolve(null)
  const key = `${root}\n${schematicRevision.value}`
  if (netlistCache?.key !== key) {
    // Parts numbered `R?` give no netlist, as the board pill's source reads
    // them (`SCHEMATIC_SOURCE`), so every check skips parity alike.
    const read = sheetAgent(root)
      .then((agent) => agent?.agentDesign() ?? null)
      .then((design) =>
        design
          ? { netlist: unannotatedReferences(design).length ? null : schematicNetlistOf(design) }
          : null
      )
      .catch(() => null)
    const entry = { key, netlist: read.then((r) => r?.netlist ?? null) }
    netlistCache = entry
    // A read that found nothing (the sheet not loaded yet, or one that failed)
    // is not kept: the next ask reads again rather than leaving the checks off.
    void read.then((r) => {
      if (r === null && netlistCache === entry) netlistCache = null
    })
  }
  return netlistCache.netlist
}

defineExpose({
  sheetAgent,
  sheetSession: openSheetSession,
  boardSession,
  openBoardSession: (path: string): BoardSession | null => boardSessions.get(path) ?? null,
  editOpenLibrary,
  footprintSession,
  librarySession,
  designCopyText,
  reloadOpenFile,
  saveCurrentFile,
  saveFileAs,
  saveAllFiles,
  hasUnsavedEdits,
  unsavedPaths,
  savePath,
  contentToSave,
  markSaved,
  dirtyBufferPaths,
  bufferContent,
  setBufferContent,
  // A door with no editor of its own (the board's) lands text the way a
  // sibling sheet edit does: into the tab's buffer, opened behind if need be.
  landAgentEdits: handleSheetUpdates,
  schematicNetlist
})

provide(EDITOR_WORKSPACE, {
  sheetSessionFor: sessionFor,
  openSheetSession,
  boardSessionFor,
  librarySessionFor,
  footprintSessionFor,
  designCopyText,
  dirtyPaths,
  setDirty,
  registerFrontView: (view) => {
    frontViews.add(view)
    return () => frontViews.delete(view)
  },
  saveFile: handleSaveFile,
  projectConnectionGrid,
  schematicRevision,
  schematicNetlist
})

// ---- groups -----------------------------------------------------------------

const isSplit = computed(() => props.layout.groups.length > 1)

const tabsOf = (groupId: string): Tab[] =>
  props.openTabs.filter((tab) => groupIdOf(props.layout, tab.path) === groupId)

const frontTabOf = (groupId: string): Tab | null => {
  const path = props.layout.groups.find((group) => group.id === groupId)?.activeTabPath
  return props.openTabs.find((tab) => tab.path === path) ?? null
}

/**
 * The group whose editor fills the shared rail: the focused one, or,
 * when its tab has no panels (a terminal, a PDF), the other. Falling back keeps
 * the rail from collapsing, and both panes from resizing, on every click between
 * an agent's terminal and the design beside it.
 */
const contextGroupId = computed<string | null>(() => {
  const focusedId = props.layout.focusedGroupId
  if (hasContextPanels(frontTabOf(focusedId))) return focusedId
  const other = otherGroup(props.layout, focusedId)
  return other && hasContextPanels(frontTabOf(other.id)) ? other.id : null
})

/**
 * What the rail will be once its editor has filled it, held as a floor until it
 * does. See `contextRailWidth` — an editor that is still reading its file
 * teleports nothing, and a rail that collapses for the length of a load takes
 * both panes and both canvases with it.
 */
const railReserve = computed(() => {
  const id = contextGroupId.value
  return id ? contextRailWidth(tabFileType(frontTabOf(id))) : 0
})

const railTarget = ref<HTMLElement | null>(null)

/** Working in the shared panels is working in the editor they belong to. */
const focusContextGroup = (): void => {
  if (contextGroupId.value) emit('focus-group', contextGroupId.value)
}

const groupStyle = (index: number): Record<string, string> => {
  if (!isSplit.value) return { flex: '1 1 0' }
  const share = index === 0 ? props.layout.ratio : 1 - props.layout.ratio
  return { flex: `${share} 1 0` }
}

const groupsHost = ref<HTMLElement | null>(null)
const resizing = ref(false)

const startSplitResize = (event: MouseEvent): void => {
  const host = groupsHost.value
  if (!host) return
  event.preventDefault()
  resizing.value = true
  const onMove = (move: MouseEvent): void => {
    const rect = host.getBoundingClientRect()
    const row = props.layout.direction === 'row'
    const size = row ? rect.width : rect.height
    if (size <= 0) return
    const offset = row ? move.clientX - rect.left : move.clientY - rect.top
    emit('resize-split', offset / size)
  }
  const onUp = (): void => {
    resizing.value = false
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
  }
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}

const keydownListener = (e: KeyboardEvent): void => {
  if (matchesHotkey(e, 'editor.save')) {
    e.preventDefault()
    void saveCurrentFile()
  }
}

onMounted((): void => {
  window.addEventListener('keydown', keydownListener)
})

onUnmounted((): void => {
  window.removeEventListener('keydown', keydownListener)
})
</script>

<template>
  <div class="editor-area">
    <div class="editor-main">
      <div ref="groupsHost" class="editor-groups" :class="[layout.direction, { resizing }]">
        <template v-for="(group, index) in layout.groups" :key="group.id">
          <div
            v-if="index > 0"
            class="editor-group-resizer"
            role="separator"
            :aria-orientation="layout.direction === 'row' ? 'vertical' : 'horizontal'"
            :aria-label="t('editorArea.split.resize')"
            @mousedown="startSplitResize"
          ></div>
          <EditorGroup
            :style="groupStyle(index)"
            :group-id="group.id"
            :focused="group.id === layout.focusedGroupId"
            :split="isSplit"
            :owns-context="group.id === contextGroupId"
            :rail-target="railTarget"
            :project-path="projectPath"
            :open-tabs="tabsOf(group.id)"
            :active-tab-path="group.activeTabPath"
            :window-id="windowId"
            :pending-settings-category="pendingSettingsCategory"
            :pending-focus="pendingFocus"
            :pending-board-probe="pendingBoardProbe"
            :pending-symbol-focus="pendingSymbolFocus"
            :pending-symbol-op="pendingSymbolOp"
            :show-welcome-on-startup="showWelcomeOnStartup"
            :recents="recents"
            :session-ready="sessionReady"
            :terminal-states="terminalStates"
            :focus-nonce="groupFocusSignal?.groupId === group.id ? groupFocusSignal.nonce : 0"
            @focus-group="emit('focus-group', group.id)"
            @split-tab="(path) => emit('split-tab', path)"
            @move-tab="(path, before) => emit('move-tab', path, group.id, before)"
            @open-settings="(category) => emit('open-settings', category)"
            @share-feedback="emit('share-feedback')"
            @close-tab="(path) => emit('close-tab', path)"
            @request-close-tab="(path) => emit('request-close-tab', path)"
            @select-tab="(path) => emit('select-tab', path)"
            @pin-tab="(path) => emit('pin-tab', path)"
            @reorder-tabs="(tabs) => emit('reorder-tabs', tabs)"
            @open-symbol="(path, uuid) => emit('open-symbol', path, uuid)"
            @reveal-in-document="
              (path, uuids, at, finding) => emit('reveal-in-document', path, uuids, at, finding)
            "
            @file-created="(path) => emit('file-created', path)"
            @open-library-symbol="(path, symbol) => emit('open-library-symbol', path, symbol)"
            @active-symbol="(path, name) => emit('active-symbol', path, name)"
            @symbol-names="(path, names) => emit('symbol-names', path, names)"
            @update-loading-path="(path) => emit('update-loading-path', path)"
            @open-folder="emit('open-folder')"
            @open-project="emit('open-project')"
            @open-recent="(entry) => emit('open-recent', entry)"
            @open-file-dialog="emit('open-file-dialog')"
            @new-project="emit('new-project')"
            @open-sample="emit('open-sample')"
            @open-file="(node) => emit('open-file', node)"
            @update:show-welcome-on-startup="(value) => emit('update:showWelcomeOnStartup', value)"
            @open-manufacture="(path) => emit('open-manufacture', path)"
            @update-from-schematic="(path) => emit('update-from-schematic', path)"
            @open-components="(path) => emit('open-components', path)"
            @open-schematic-setup="(path) => emit('open-schematic-setup', path)"
            @open-board-setup="(path) => emit('open-board-setup', path)"
          />
        </template>
      </div>
    </div>
    <!-- The right rail is the shell's; the editor that owns the context
         teleports its panels in (split-view-workstream.md §4). -->
    <div
      ref="railTarget"
      class="context-rail"
      :style="{ minWidth: railReserve + 'px' }"
      @mousedown.capture="focusContextGroup"
      @focusin="focusContextGroup"
    ></div>
  </div>
</template>
