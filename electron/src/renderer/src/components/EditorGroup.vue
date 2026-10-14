<script setup lang="ts">
/**
 * One editor group: a tab strip and the editor for the tab in front of it. A
 * window shows one group, or two side by side (split-view-workstream.md).
 *
 * Everything here belongs to the tab in front. What outlives a tab switch — the
 * documents, their sessions, dirty state, saving — is the workspace's
 * (`EditorArea`), reached through `EDITOR_WORKSPACE`.
 */
import { isDesignCopyPath, parseDesignCopyPath } from '../lib/designCopy'
import {
  ref,
  shallowRef,
  computed,
  watch,
  nextTick,
  inject,
  provide,
  onUnmounted,
  defineAsyncComponent
} from 'vue'
import { useI18n } from 'vue-i18n'
import type { SheetSession } from '../lib/schematic/sheetSession'
import type { BoardSession } from '../lib/board/boardSession'
import type { TextSession } from '../lib/document/textSession'
import type { KicadSymbolLibrary } from '../lib/kicad/symbolLibrary'
import type { KicadFootprint } from '../lib/kicad/footprint'
import type { SymbolPartAddress } from '../lib/symbol/symbolEdit'
import type { SelectionItem } from '../lib/history'
import { documentStore } from '../lib/document/documentStore'
import {
  EDITOR_GROUP,
  EDITOR_WORKSPACE,
  pointerCanvasGroup,
  setPointerCanvasGroup,
  type EditorWorkspace
} from '../lib/editorWorkspace'
import { tabFileType } from '../lib/tabFileType'
import WelcomeView from './WelcomeView.vue'
import BrandMark from './shared/BrandMark.vue'
import BrandWordmark from './shared/BrandWordmark.vue'
import Icon from './shared/Icon.vue'
import FileIcon from './shared/FileIcon.vue'

// Every editor and viewer below is loaded on demand. Statically imported they
// pulled three.js, the whole render engine, and the KiCad stroke font into the
// startup chunk, so a window showing nothing but the Welcome tab still spent
// ~1s evaluating them before Vue could mount. At most one of these is on screen
// at a time, and the chunk for it arrives within a frame or two of the tab
// opening. WelcomeView stays eager — it is what a cold launch renders first.
const FootprintEditor = defineAsyncComponent(() => import('./FootprintEditor.vue'))
const SchematicEditor = defineAsyncComponent(() => import('./SchematicEditor.vue'))
// Module scope: Vite's preload keeps the first import's closure, and with it
// the scope it was made in, for the life of the page.
const loadPcbEditor = (): Promise<typeof import('./PcbEditor.vue')> => import('./PcbEditor.vue')
const PcbEditor = defineAsyncComponent(loadPcbEditor)
const SymbolLibraryEditor = defineAsyncComponent(() => import('./SymbolLibraryEditor.vue'))
const ModelViewer = defineAsyncComponent(() => import('./ModelViewer.vue'))
const ImageViewer = defineAsyncComponent(() => import('./ImageViewer.vue'))
const GerberViewer = defineAsyncComponent(() => import('./GerberViewer.vue'))
const PdfViewer = defineAsyncComponent(() => import('./PdfViewer.vue'))
const HtmlViewer = defineAsyncComponent(() => import('./HtmlViewer.vue'))
const FileInfoViewer = defineAsyncComponent(() => import('./FileInfoViewer.vue'))
const TextEditor = defineAsyncComponent(() => import('./TextEditor.vue'))
const SettingsView = defineAsyncComponent(() => import('./SettingsView.vue'))
const PartsView = defineAsyncComponent(() => import('./PartsView.vue'))
const ManufactureView = defineAsyncComponent(() => import('./ManufactureView.vue'))
const ComponentsTableView = defineAsyncComponent(() => import('./ComponentsTableView.vue'))
const SchematicSetupView = defineAsyncComponent(() => import('./SchematicSetupView.vue'))
const ComponentView = defineAsyncComponent(() => import('./ComponentView.vue'))
const TerminalView = defineAsyncComponent(() => import('./TerminalView.vue'))
const DiffView = defineAsyncComponent(() => import('./git/DiffView.vue'))
import type { TerminalState } from '../../../preload/terminalTypes'
import { terminalLabel, terminalStatus } from '../lib/terminalTitle'
import { formatUpgrader } from '../lib/formatUpgrade'
import {
  isWelcomeTab,
  isPartsTab,
  isSettingsTab,
  isManufactureTab,
  isComponentsTableTab,
  componentsRootPath,
  isTerminalTab,
  terminalSessionId,
  terminalTabKind,
  manufactureBoardPath,
  isComponentTab,
  isReadonlyLibTab,
  readonlyLibPath,
  isDiffTab,
  parseDiffTab,
  isSchematicSetupTab,
  schematicSetupRootPath,
  isBoardSetupTab,
  tabDocumentPath,
  tabParent,
  type Tab
} from '../lib/tabs'
import { delayedVisible } from '../lib/delayedVisible'
import { hotkeyLabel, type HotkeyActionId } from '../lib/hotkeys'
import type { RecentEntry } from '../../../preload/recentTypes'

const { t } = useI18n()

const props = defineProps<{
  groupId: string
  /** This group holds the keyboard. */
  focused: boolean
  /** More than one group is on screen, so which one is focused needs showing. */
  split: boolean
  /** This group's editor is the one whose context panels the shell shows. */
  ownsContext: boolean
  /** Changes when this group is handed the keyboard by hotkey. */
  focusNonce?: number
  railTarget: HTMLElement | null
  projectPath: string | null
  /** This group's tabs, in strip order. */
  openTabs: Tab[]
  /** The tab this group has in front. */
  activeTabPath: string | null
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
  /** Cross-select request routed to the board editor showing its .kicad_pcb. */
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
  /** The pointer went down in this group: it takes the keyboard. */
  (e: 'focus-group'): void
  /** Send a tab across the split, opening the second group if need be. */
  (e: 'split-tab', path: string): void
  /** A tab from another group was dropped on this strip, before `beforePath`. */
  (e: 'move-tab', path: string, beforePath: string | null): void
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
  /** Open the Manufacture tab for a board (from the PCB editor). */
  (e: 'open-manufacture', boardPath: string): void
  /** Open Update PCB from Schematic on a board (from the PCB editor). */
  (e: 'update-from-schematic', boardPath: string): void
  /** Open the Components tab for a design, by its root sheet (from a sheet's editor). */
  (e: 'open-components', rootSheetPath: string): void
  /** Open a design's Schematic Setup, by its root sheet (from a sheet's properties panel). */
  (e: 'open-schematic-setup', rootSheetPath: string): void
  /** Open a board's Board Setup, by its board (from the board's properties panel). */
  (e: 'open-board-setup', boardPath: string): void
}>()

const injectedWorkspace = inject(EDITOR_WORKSPACE)
if (!injectedWorkspace) throw new Error('EditorGroup must be mounted inside EditorArea')
const workspace: EditorWorkspace = injectedWorkspace
const dirtyPaths = workspace.dirtyPaths

provide(EDITOR_GROUP, {
  groupId: props.groupId,
  focused: computed(() => props.focused),
  ownsContext: computed(() => props.ownsContext),
  railTarget: computed(() => props.railTarget),
  takeKeyboard: () => emit('focus-group')
})

const fileContent = ref('')

/** The session the mounted editor draws; null until the active tab's document
 *  has loaded, which is also while the editor is hidden. */
const activeSession = shallowRef<SheetSession | null>(null)
const activeBoardSession = shallowRef<BoardSession | null>(null)
const activeLibrarySession = shallowRef<TextSession<KicadSymbolLibrary, SymbolPartAddress> | null>(
  null
)
const activeFootprintSession = shallowRef<TextSession<KicadFootprint, SelectionItem> | null>(null)

const isLoadingFile = ref(false)

/**
 * The board tab's load is three phases the user should read as one: the file
 * read here, then the parse and the 2D scene build inside PcbEditor (merged
 * and reported up via `load-progress`). One bar spans them all — read is the
 * first slice — instead of a spinner that hands off to a second bar.
 */
const pcbLoadProgress = ref<number | null>(null)
/**
 * True from the moment a board file starts reading until PcbEditor reports
 * its load settled (a `load-progress: null` event). This is what keeps the
 * bar up across the handoff — after the read lands, the editor chunk still
 * has to mount and start parsing, and without this bridge the bar would
 * blink off into a black frame and re-arm its appearance delay.
 */
const pcbAwaitingEditor = ref(false)
const READ_SLICE_PERCENT = 10
const pcbLoadPercent = computed(() => {
  if (isLoadingFile.value) return Math.round(READ_SLICE_PERCENT / 2)
  if (pcbLoadProgress.value === null) return READ_SLICE_PERCENT
  return Math.round(READ_SLICE_PERCENT + pcbLoadProgress.value * (100 - READ_SLICE_PERCENT))
})
// Indicators only for loads that actually take a while (lib/delayedVisible.ts):
// a small file's bar would just flash.
const showFileLoading = delayedVisible(() => isLoadingFile.value)
const showPcbLoading = delayedVisible(
  () => isLoadingFile.value || pcbAwaitingEditor.value || pcbLoadProgress.value !== null
)
const handlePcbLoadProgress = (fraction: number | null): void => {
  pcbLoadProgress.value = fraction
  if (fraction === null) pcbAwaitingEditor.value = false
}

/**
 * The file the front tab shows: its own path, or for a Board Setup tab its
 * board's (`tabDocumentPath`). Loading, dirt and saves follow the document;
 * the tab's own path keys only what is the tab's (its editor mount, its pin).
 */
const documentPath = computed(() =>
  props.activeTabPath ? tabDocumentPath(props.activeTabPath) : null
)

// The front tab's slice of the workspace's dirty set.
const isDirty = computed<boolean>({
  get: () => !!documentPath.value && workspace.dirtyPaths.value.has(documentPath.value),
  set: (value) => {
    if (documentPath.value) workspace.setDirty(documentPath.value, value)
  }
})

// The content as loaded from disk for the active tab. The footprint editor
// writes edits back through v-model with no dedicated change event, so
// "edited" is detected by comparing against this snapshot — which also keeps
// tab-switch loads from reading as edits.
const lastLoadedContent = ref('')

const setLoadedContent = (content: string): void => {
  lastLoadedContent.value = content
  fileContent.value = content
  isDirty.value = false
}

/**
 * Dirty means "the buffer differs from what is on disk", NOT "an edit happened".
 *
 * The difference shows the moment you undo: rolling history back to the last
 * save leaves the file byte-identical, so the tab must stop claiming unsaved
 * work — otherwise the dot is unclearable short of saving a file that has not
 * changed. Comparison also catches the case a history counter cannot: typing a
 * value and typing the original back.
 *
 * Sound because serialization is deterministic and lossless (RULES.md §7) — every
 * editor writes through the parsed AST, so equal documents produce equal text.
 * It is the same test the tab-restore path already uses to decide dirtiness.
 */
const syncDirty = (content: string): void => {
  isDirty.value = content !== lastLoadedContent.value
}

// Any edit pins a preview tab for good (VS Code behavior). isDirty is only
// ever set for the active tab, so the path is always the edited file's.
watch(isDirty, (dirty) => {
  if (dirty && props.activeTabPath) emit('pin-tab', props.activeTabPath)
})

const isDragOverTabbar = ref(false)
const draggedTabIndex = ref<number | null>(null)

const tabsScroller = ref<HTMLDivElement | null>(null)

/**
 * Width of the fade over a strip edge that has tabs past it (`.tabs-scroller`
 * in main.css draws it). The strip's scrollbar covers the active tab's
 * underline, so it shows only while scrolling; at rest the fade says there is
 * more.
 */
const TAB_FADE_PX = 24
/** How long the scrollbar stays after the last scroll (a drag on it scrolls too). */
const TAB_SCROLLBAR_LINGER_MS = 800

const tabsScrolling = ref(false)
let tabsScrollingTimer: ReturnType<typeof setTimeout> | undefined
const onTabsScroll = (): void => {
  measureTabsClip()
  tabsScrolling.value = true
  clearTimeout(tabsScrollingTimer)
  tabsScrollingTimer = setTimeout(() => (tabsScrolling.value = false), TAB_SCROLLBAR_LINGER_MS)
}

/** Which edges of the strip have tabs scrolled out past them. */
const tabsClipped = ref({ start: false, end: false })
const measureTabsClip = (): void => {
  const scroller = tabsScroller.value
  if (!scroller) return
  const start = scroller.scrollLeft > 0.5
  const end = scroller.scrollLeft + scroller.clientWidth < scroller.scrollWidth - 0.5
  if (start !== tabsClipped.value.start || end !== tabsClipped.value.end) {
    tabsClipped.value = { start, end }
  }
}

// A newly opened or activated tab beyond the scroll viewport is brought
// fully into view (VS Code behavior), clear of the fade on that edge unless it
// is the first or last tab.
const revealActiveTab = (): void => {
  const scroller = tabsScroller.value
  if (!scroller) return
  const el = scroller.querySelector<HTMLElement>('.tab-item.active')
  if (!el) return
  const left = el.offsetLeft
  const right = left + el.offsetWidth
  const startInset = left > 0 ? TAB_FADE_PX : 0
  const endInset = right < scroller.scrollWidth ? TAB_FADE_PX : 0
  if (left - startInset < scroller.scrollLeft) {
    scroller.scrollLeft = left - startInset
  } else if (right + endInset > scroller.scrollLeft + scroller.clientWidth) {
    scroller.scrollLeft = right + endInset - scroller.clientWidth
  }
  measureTabsClip()
}

watch(
  () => [props.activeTabPath, props.openTabs.length],
  () => {
    void nextTick(revealActiveTab)
  }
)

// The strip's own width changes with the window, a split and the rail.
const tabsResize = new ResizeObserver(measureTabsClip)
watch(tabsScroller, (el, old) => {
  if (old) tabsResize.unobserve(old)
  if (el) tabsResize.observe(el)
})
onUnmounted(() => {
  tabsResize.disconnect()
  clearTimeout(tabsScrollingTimer)
})

// The mouse wheel scrolls the tab strip horizontally (vertical wheels are
// the common case; trackpads already produce deltaX).
const handleTabsWheel = (e: WheelEvent): void => {
  const scroller = tabsScroller.value
  if (!scroller || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return
  e.preventDefault()
  scroller.scrollLeft += e.deltaY
}

// A board and a footprint each have a 3D preview beside their canvas, which the
// editor's own top-right toggle switches to (and Board Setup is a tab of its
// own, `goatcad://board-setup/`).
//
// Whether it shows lives here rather than inside each editor because it is a
// property of the *tab*, like source view: switching tabs must not drag it
// along, and an editor's own `ref` would be rebuilt on every remount.
const preview3dPaths = ref(new Set<string>())

const isPreview3d = computed(
  () => !!props.activeTabPath && preview3dPaths.value.has(props.activeTabPath)
)

const togglePreview3d = (): void => {
  const path = props.activeTabPath
  if (!path) return
  const next = new Set(preview3dPaths.value)
  if (!next.delete(path)) next.add(path)
  preview3dPaths.value = next
}

const activeTab = computed(() => {
  return props.openTabs.find((t) => t.path === props.activeTabPath) || null
})

// A pending focus — a finding on another sheet, or one the Manufacture
// pre-flight points at on a board — only applies to the editor showing its file.
const normalizePath = (path: string): string => path.replace(/[\\/]+/g, '/').toLowerCase()
const documentFocus = computed(() => {
  const focus = props.pendingFocus
  if (!focus || !props.activeTabPath) return null
  return normalizePath(focus.path) === normalizePath(props.activeTabPath)
    ? {
        uuids: focus.uuids,
        ...(focus.at ? { at: focus.at } : {}),
        ...(focus.finding ? { finding: focus.finding } : {}),
        nonce: focus.nonce
      }
    : null
})
const boardProbe = computed(() => {
  const probe = props.pendingBoardProbe
  if (!probe || !props.activeTabPath) return null
  return normalizePath(probe.path) === normalizePath(props.activeTabPath)
    ? { symbolUuids: probe.symbolUuids, references: probe.references, nonce: probe.nonce }
    : null
})
// The symbol-library equivalent: reveal a named symbol in the editor for its file.
const symbolFocus = computed(() => {
  const focus = props.pendingSymbolFocus
  if (!focus || !props.activeTabPath) return null
  return normalizePath(focus.path) === normalizePath(props.activeTabPath)
    ? { symbol: focus.symbol, nonce: focus.nonce }
    : null
})

// Symbol add/rename/delete op routed to the symbol editor showing this .kicad_sym.
const symbolOp = computed(() => {
  const op = props.pendingSymbolOp
  if (!op || !props.activeTabPath) return null
  return normalizePath(op.path) === normalizePath(props.activeTabPath)
    ? { op: op.op, symbol: op.symbol, newName: op.newName, nonce: op.nonce }
    : null
})

/** Terminal panes stay mounted while their tab is open; see the layer below. */
/**
 * A press in this group takes the keyboard from wherever it was. Focus left in
 * the other group — a terminal's input, a field — would otherwise keep it when
 * the press is one that stops its own default (a canvas pan), and the next
 * keystroke or middle-button paste would land in a pane not being worked in.
 */
const onMouseDownCapture = (e: MouseEvent): void => {
  const held = document.activeElement
  const group = e.currentTarget as HTMLElement
  if (held instanceof HTMLElement && held !== document.body && !group.contains(held)) held.blur()
  emit('focus-group')
}

/** Which canvas the pointer is over, for the next keystroke to go to (`useGroupKeydown`). */
const onMouseOver = (e: MouseEvent): void => {
  setPointerCanvasGroup(e.target instanceof HTMLCanvasElement ? props.groupId : null)
}
const onMouseLeave = (): void => {
  if (pointerCanvasGroup() === props.groupId) setPointerCanvasGroup(null)
}
onUnmounted(onMouseLeave)

const terminalTabs = computed(() => props.openTabs.filter((tab) => isTerminalTab(tab.path)))

const terminalStateOf = (path: string): TerminalState | undefined => props.terminalStates?.[path]

/**
 * The child tabs drawn nested: those whose parent is in this strip, which
 * App keeps directly ahead of them (`nestChildTabs`, lib/tabs.ts).
 */
const nestedTabs = computed(() => {
  const here = new Set(props.openTabs.map((tab) => tab.path))
  return new Set(
    props.openTabs.filter((tab) => here.has(tabParent(tab.path)?.path ?? '')).map((tab) => tab.path)
  )
})

/**
 * The unsaved dot belongs to the file's tab: a view nested under its parent
 * leaves it there, and away from it shows the parent's.
 */
const showsDirty = (tab: Tab): boolean => {
  const parent = tabParent(tab.path)
  if (!parent) return dirtyPaths.value.has(tab.path)
  return parent.view && !nestedTabs.value.has(tab.path) && dirtyPaths.value.has(parent.path)
}

/** A child tab's own name, without its parent's. */
const childTitle = (tab: Tab): string | null => {
  if (isBoardSetupTab(tab.path)) return t('editorArea.childTab.boardSetup')
  if (isSchematicSetupTab(tab.path)) return t('editorArea.childTab.schematicSetup')
  if (isComponentsTableTab(tab.path)) return t('editorArea.childTab.components')
  if (isManufactureTab(tab.path)) return t('editorArea.childTab.manufacture')
  if (isDesignCopyPath(tab.path)) return tab.name.replace(/\.kicad_(sym|mod)$/i, '')
  return null
}

/**
 * What the tab strip shows. A child tab nested under its parent names only
 * itself; away from it, the parent's file too. A `.kicad_sym` tab edits one
 * symbol out of a library, so neither name alone identifies it — the title
 * carries both.
 */
const tabTitle = (tab: Tab): string => {
  if (isWelcomeTab(tab.path)) return t('welcome.tabTitle')
  if (isSettingsTab(tab.path)) return t('settings.tabTitle')
  if (isPartsTab(tab.path)) return t('parts.title')
  if (isTerminalTab(tab.path)) return terminalLabel(terminalStateOf(tab.path), tab.name)
  const child = childTitle(tab)
  const parent = tabParent(tab.path)?.path
  if (child !== null && parent !== undefined) {
    if (nestedTabs.value.has(tab.path)) return child
    const file = parent.split(/[\\/]/).pop() ?? parent
    return t('editorArea.symbolTabTitle', { file, symbol: child })
  }
  if (isDiffTab(tab.path)) {
    const diff = parseDiffTab(tab.path)
    const name =
      diff?.symbol !== undefined
        ? t('editorArea.symbolTabTitle', { file: tab.name, symbol: diff.symbol })
        : tab.name
    return diff?.side === 'staged'
      ? t('git.diff.tabStaged', { name })
      : t('git.diff.tabWorking', { name })
  }
  return tab.symbol
    ? t('editorArea.symbolTabTitle', { file: tab.name, symbol: tab.symbol })
    : tab.name
}

/** The filename alone is ambiguous once the title names a symbol too. */
const tabTooltip = (tab: Tab): string => {
  // Two terminals look identical in the strip; what they run and where they
  // started is what tells them apart.
  if (isTerminalTab(tab.path)) {
    const state = terminalStateOf(tab.path)
    const status = terminalStatus(state)
    const process = state?.process ?? ''
    if (status === 'exited') return t('terminal.status.exited', { code: state?.exitCode ?? 0 })
    if (status === 'attention') return t('terminal.status.attention', { process })
    if (status === 'running') {
      return state?.activity === 'working'
        ? t('terminal.status.working', { process })
        : t('terminal.status.running', { process })
    }
    return state?.activity === 'idle'
      ? t('terminal.status.waiting', { process })
      : t('terminal.status.idle')
  }
  const copy = parseDesignCopyPath(tab.path)
  if (copy)
    return t('editorArea.designCopyTooltip', {
      part: tab.name.replace(/\.kicad_(sym|mod)$/i, ''),
      file: copy.parent
    })
  if (isDiffTab(tab.path)) {
    const diff = parseDiffTab(tab.path)
    if (!diff) return tab.name
    return diff.symbol !== undefined
      ? t('editorArea.symbolTabTitle', { file: diff.filePath, symbol: diff.symbol })
      : diff.filePath
  }
  return tab.symbol
    ? t('editorArea.symbolTabTitle', { file: tab.path, symbol: tab.symbol })
    : tab.name
}

const activeFileType = computed(() => tabFileType(activeTab.value))

/** A diff tab's Open file: the file itself, in a tab of its own. */
const openDiffFile = (path: string): void => {
  emit('open-file', { name: path.split(/[\\/]/).pop() ?? path, path })
}

// What the empty editor offers: the ways into a design, with their keys.
const emptyShortcuts = computed((): { id: HotkeyActionId; label: string }[] => [
  { id: 'app.openFolder', label: t('editorArea.empty.openFolder') },
  { id: 'app.openProject', label: t('editorArea.empty.openProject') },
  { id: 'app.newSchematic', label: t('editorArea.empty.newSchematic') },
  { id: 'app.newWindow', label: t('editorArea.empty.newWindow') }
])

const splitTitle = computed(() =>
  t('editorArea.split.sendTab', { shortcut: hotkeyLabel('app.splitTab') })
)

// Load file content for text editor & footprint editor.
// Reads are async while the editors below are keyed by tab path, so a newly
// mounted editor must never receive the previous tab's fileContent: every
// editor — including the plain textarea — is hidden while isLoadingFile is
// true, and a load that a newer tab activation superseded is dropped instead
// of applied.
/** The active file was written by a KiCad we do not write (lib/formatUpgrade.ts). */
const formatReadOnly = computed(() =>
  documentPath.value ? formatUpgrader.isReadOnly(documentPath.value) : false
)

watch(
  () => props.activeTabPath,
  async (tabPath, _oldPath, onCleanup) => {
    // Board Setup loads its board, as the board's own tab would.
    const newPath = tabPath ? tabDocumentPath(tabPath) : null
    const fileType = activeFileType.value === 'board-setup' ? 'pcb' : activeFileType.value
    let cancelled = false
    let releaseView: (() => void) | null = null
    onCleanup(() => {
      cancelled = true
      releaseView?.()
    })
    // The tab in front has a view on its document, which keeps it loaded.
    const attachView = (): void => {
      const document = newPath ? documentStore.get(newPath) : null
      if (!document) return
      releaseView = document.pin('view')
      document.touch('viewed')
      activeSession.value =
        document.kind === 'schematic' ? workspace.sheetSessionFor(document.path) : null
      activeBoardSession.value =
        document.kind === 'board' ? workspace.boardSessionFor(document.path) : null
      activeLibrarySession.value =
        document.kind === 'symbol-library' ? workspace.librarySessionFor(document.path) : null
      activeFootprintSession.value =
        document.kind === 'footprint' ? workspace.footprintSessionFor(document.path) : null
    }
    const apply = (content: string): void => {
      if (cancelled) return
      setLoadedContent(content)
      // Cache every type, text included, so an edited-but-unsaved tab keeps its
      // content (and its dirty dot) across a switch. Clean text tabs still
      // re-read from disk on the way back in (see the restore guard below), so
      // a file rewritten behind the editor's back — e.g. .kicad_pro BOM
      // settings — is never masked by a stale cache.
      if (newPath) documentStore.load(newPath, content)
      attachView()
    }
    const doneLoading = (): void => {
      if (!cancelled) isLoadingFile.value = false
    }
    // Types that don't hit a load branch (welcome, settings, library-symbol) must not
    // inherit a stale true from a superseded load.
    isLoadingFile.value = false
    pcbLoadProgress.value = null
    pcbAwaitingEditor.value = false
    activeSession.value = null
    activeBoardSession.value = null
    activeLibrarySession.value = null
    activeFootprintSession.value = null
    if (newPath) {
      const cached = documentStore.get(newPath)
      // A clean text tab always re-reads from disk (see apply() above); every
      // other cached tab — and any text tab with unsaved edits — restores
      // synchronously so the switch never paints a blank frame or loses edits.
      const isTextTab = fileType === 'text'
      if (cached && (!isTextTab || cached.isDirty())) {
        lastLoadedContent.value = cached.baseline()
        // Stored, not flushed: a board left with edits still to write is taken
        // back by the editor mounting now, which writes them itself.
        fileContent.value = cached.storedText()
        isDirty.value = cached.isDirty()
        attachView()
        return
      }
      emit('update-loading-path', newPath)
      try {
        if (isDesignCopyPath(newPath)) {
          // A design's own copy of a part: projected from its design file, which opens behind.
          isLoadingFile.value = true
          try {
            apply((await workspace.designCopyText(newPath)) ?? '')
          } finally {
            doneLoading()
          }
        } else if (
          fileType === 'text' ||
          fileType === 'html' ||
          fileType === 'schematic' ||
          fileType === 'pcb' ||
          fileType === 'library-symbol' ||
          fileType === 'gerber'
        ) {
          isLoadingFile.value = true
          if (fileType === 'pcb') {
            pcbAwaitingEditor.value = true
            // Warm the editor chunk while the file reads. Its first-open
            // import evaluates three.js and the render engine; overlapped
            // with the read, the editor mounts the moment content lands
            // instead of adding that eval to the black gap after it.
            void loadPcbEditor()
          }
          try {
            const res = await window.api.readFile(newPath)
            if (res.success && res.content !== undefined) {
              apply(await formatUpgrader.upgrade(newPath, res.content))
            } else {
              apply(`// Failed to read file content:\n// ${res.error || 'Unknown error'}`)
            }
          } catch (err) {
            console.error(err)
            apply('// Error loading file content.')
          } finally {
            doneLoading()
          }
        } else if (fileType === 'library-footprint') {
          if (isReadonlyLibTab(newPath)) {
            // A library footprint opened read-only (from the Component viewer's
            // Open button): read the real file, but the read-only flag below keeps
            // the editor from writing back to the shared library.
            isLoadingFile.value = true
            try {
              const res = await window.api.readFile(readonlyLibPath(newPath))
              if (res.success && res.content !== undefined) {
                apply(res.content)
              } else {
                apply(`(footprint "Failed to read: ${res.error || 'unknown error'}")`)
              }
            } catch (err) {
              console.error(err)
              apply('(footprint "Error")')
            } finally {
              doneLoading()
            }
          } else {
            isLoadingFile.value = true
            try {
              const res = await window.api.readFile(newPath)
              if (res.success && res.content !== undefined) {
                apply(await formatUpgrader.upgrade(newPath, res.content))
              }
            } catch (err) {
              console.error(err)
            } finally {
              doneLoading()
            }
          }
        }
      } finally {
        if (!cancelled) emit('update-loading-path', null)
      }
    } else {
      setLoadedContent('')
    }
  },
  { immediate: true }
)

// The footprint editor edits fileContent through v-model; anything that isn't
// the freshly loaded snapshot is a user edit. Also writes through to the tab
// document cache so it always holds the active tab's live content.
watch(fileContent, (newVal) => {
  if (documentPath.value) documentStore.get(documentPath.value)?.setText(newVal)
  // The footprint editor has no change event of its own — this watch IS its
  // edit signal — so it needs the comparison in both directions, not just the
  // "differs" half it used to test.
  if (activeFileType.value === 'library-footprint') syncDirty(newVal)
})

const handleTextChange = (): void => {
  // A textarea's own Ctrl+Z lands here too, so this must clear as well as set.
  syncDirty(fileContent.value)
}

onUnmounted(
  workspace.registerFrontView({
    path: () => documentPath.value,
    tab: () => activeTab.value,
    fileType: () => activeFileType.value,
    loading: () => isLoadingFile.value,
    content: () => fileContent.value,
    setContent: (text) => {
      fileContent.value = text
    },
    baseline: () => lastLoadedContent.value,
    setBaseline: (text) => {
      lastLoadedContent.value = text
    }
  })
)

/**
 * A tab with the tabs nested with it, parent first: what leaves for another
 * window together, since a child cannot live apart from its parent's file.
 */
const familyOf = (tab: Tab): Tab[] => {
  const parent = nestedTabs.value.has(tab.path) ? tabParent(tab.path)?.path : undefined
  const root = props.openTabs.find((candidate) => candidate.path === parent) ?? tab
  return [
    root,
    ...props.openTabs.filter(
      (candidate) =>
        nestedTabs.value.has(candidate.path) && tabParent(candidate.path)?.path === root.path
    )
  ]
}

/** The tab in front and the tabs nested with it: these share its underline. */
const activeFamily = computed(() => {
  const active = props.openTabs.find((tab) => tab.path === props.activeTabPath)
  return new Set(active ? familyOf(active).map((tab) => tab.path) : [])
})

const handleTabDragStart = (event: DragEvent, index: number): void => {
  draggedTabIndex.value = index
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    const tabData = {
      windowId: props.windowId,
      tab: props.openTabs[index],
      family: familyOf(props.openTabs[index])
    }
    event.dataTransfer.setData('application/goatcad-tab', JSON.stringify(tabData))
  }
}

const handleTabDragEnd = (event: DragEvent): void => {
  // If the drop effect is none, it was dropped outside all windows!
  // Spawn a new window with this tab and remove it from the current window.
  if (event.dataTransfer?.dropEffect === 'none' && draggedTabIndex.value !== null) {
    const family = familyOf(props.openTabs[draggedTabIndex.value])
    void window.api.newWindow(
      props.projectPath || undefined,
      family.map((tab) => ({ name: tab.name, path: tab.path }))
    )
    // Its children close with it.
    emit('close-tab', family[0].path)
  }
  draggedTabIndex.value = null
  isDragOverTabbar.value = false
}

const handleTabbarDragOver = (event: DragEvent): void => {
  if (event.dataTransfer?.types.includes('application/goatcad-tab')) {
    event.preventDefault()
    isDragOverTabbar.value = true
  }
}

const handleTabbarDragLeave = (): void => {
  isDragOverTabbar.value = false
}

const handleTabbarDrop = async (event: DragEvent): Promise<void> => {
  event.preventDefault()
  isDragOverTabbar.value = false

  const rawData = event.dataTransfer?.getData('application/goatcad-tab')
  if (!rawData) return

  try {
    const data = JSON.parse(rawData)
    const { windowId: sourceWindowId, tab: tabData } = data
    const family: Tab[] = Array.isArray(data.family) ? data.family : [tabData]

    if (sourceWindowId === props.windowId) {
      const tabItems = Array.from(
        (event.currentTarget as HTMLElement).querySelectorAll('.tab-item')
      )
      const dropX = event.clientX
      let dropIndex = props.openTabs.length - 1
      let dropBefore: string | null = null

      for (let i = 0; i < tabItems.length; i++) {
        const rect = tabItems[i].getBoundingClientRect()
        if (dropX < rect.left + rect.width / 2) {
          dropIndex = i
          dropBefore = props.openTabs[i]?.path ?? null
          break
        }
      }

      // `draggedTabIndex` is this strip's own drag; without it the tab came
      // from the other group.
      if (draggedTabIndex.value === null) {
        if (typeof tabData?.path === 'string') emit('move-tab', tabData.path, dropBefore)
      } else {
        const newTabs = [...props.openTabs]
        const [movedTab] = newTabs.splice(draggedTabIndex.value, 1)
        newTabs.splice(dropIndex, 0, movedTab)
        emit('reorder-tabs', newTabs)
      }
    } else {
      for (const tab of family) await window.api.transferTab(sourceWindowId, props.windowId, tab)
    }
  } catch (err) {
    console.error(err)
  }
}
</script>

<template>
  <!-- Capture phase: a canvas stops its own mousedown, and the group has to
       hear the click that lands on it. -->
  <div
    class="editor-group"
    :class="{ split, focused }"
    @mousedown.capture="onMouseDownCapture"
    @mouseover="onMouseOver"
    @mouseleave="onMouseLeave"
    @focusin="emit('focus-group')"
  >
    <div
      class="tabs-bar"
      :class="{ 'drag-over': isDragOverTabbar }"
      @dragover="handleTabbarDragOver"
      @dragleave="handleTabbarDragLeave"
      @drop="handleTabbarDrop"
    >
      <div
        ref="tabsScroller"
        class="tabs-scroller"
        :class="{
          'clipped-start': tabsClipped.start,
          'clipped-end': tabsClipped.end,
          scrolling: tabsScrolling
        }"
        :style="{ '--tab-fade': TAB_FADE_PX + 'px' }"
        @wheel="handleTabsWheel"
        @scroll.passive="onTabsScroll"
      >
        <div
          v-for="(tab, idx) in openTabs"
          :key="tab.path"
          class="tab-item"
          :class="{
            active: activeTabPath === tab.path,
            preview: tab.preview,
            'component-tab': isComponentTab(tab.path),
            family: activeFamily.has(tab.path)
          }"
          draggable="true"
          @dragstart="handleTabDragStart($event, idx)"
          @dragend="handleTabDragEnd"
          @click="emit('select-tab', tab.path)"
          @dblclick="emit('pin-tab', tab.path)"
        >
          <!-- Custom Tab Icon. Virtual tabs get their own glyph; real files
               share the file-tree iconography via FileIcon, so a tab and its
               explorer row always read the same. -->
          <span class="tab-icon">
            <Icon v-if="isComponentTab(tab.path)" name="tab-component" />
            <BrandMark v-else-if="isWelcomeTab(tab.path)" />
            <Icon
              v-else-if="isSettingsTab(tab.path)"
              name="settings"
              style="color: var(--vscode-accent)"
            />
            <Icon v-else-if="isManufactureTab(tab.path)" name="manufacture" />
            <Icon v-else-if="isComponentsTableTab(tab.path)" name="components-table" />
            <!-- An agent tab wears the launcher's mark, so it reads as the
                 button that opened it. -->
            <Icon
              v-else-if="isTerminalTab(tab.path)"
              :name="terminalTabKind(tab.path) === 'shell' ? 'terminal' : 'agent'"
            />
            <Icon v-else-if="isDiffTab(tab.path)" name="git-branch" />
            <Icon
              v-else-if="isSchematicSetupTab(tab.path) || isBoardSetupTab(tab.path)"
              name="settings"
            />
            <Icon v-else-if="isPartsTab(tab.path)" name="part-search" />
            <FileIcon v-else :name="tab.name" />
          </span>

          <!-- A .kicad_sym tab edits one symbol, so it names both the library
               file and the symbol; the tooltip carries the full path context. -->
          <span class="tab-title" :title="tabTooltip(tab)">{{ tabTitle(tab) }}</span>

          <!-- What a terminal tab is doing. The title already names the process;
               this is the at-a-glance "is it still going?" a terminal app's tab
               carries, and the only thing that distinguishes a finished shell. -->
          <span
            v-if="isTerminalTab(tab.path)"
            class="terminal-state"
            :class="terminalStatus(terminalStateOf(tab.path))"
            :title="tabTooltip(tab)"
            role="img"
            :aria-label="tabTooltip(tab)"
          ></span>

          <span
            class="tab-close"
            :class="{ modified: showsDirty(tab) }"
            :title="t('editorArea.closeTab')"
            @click.stop="emit('request-close-tab', tab.path)"
          >
            <span class="dirty-indicator" aria-hidden="true"></span>
            <Icon name="close-tight" class="close-icon" />
          </span>
        </div>
      </div>

      <!-- Fixed right-side tab-bar actions (VS Code's split-editor spot) -->
      <div class="tabs-actions">
        <button
          v-if="activeTabPath && (split || openTabs.length > 1)"
          class="tab-action-btn"
          :title="splitTitle"
          :aria-label="splitTitle"
          @click="emit('split-tab', activeTabPath)"
        >
          <Icon name="split-editor" />
        </button>
      </div>
    </div>

    <div class="editor-panel">
      <!-- A. No file is open -->
      <div v-if="!activeTab && props.sessionReady !== false" class="editor-empty">
        <div class="editor-empty-content">
          <div class="editor-empty-logo"><BrandWordmark size="hero" /></div>
          <p class="editor-empty-tagline">{{ t('welcome.hero.tagline') }}</p>
          <dl class="shortcut-grid">
            <template v-for="s in emptyShortcuts" :key="s.id">
              <dt class="shortcut-desc">{{ s.label }}</dt>
              <dd>
                <kbd class="kbd"
                  ><span>{{ hotkeyLabel(s.id) }}</span></kbd
                >
              </dd>
            </template>
          </dl>
        </div>
      </div>

      <!-- B. Welcome page (goatcad://welcome) -->
      <WelcomeView
        v-else-if="activeFileType === 'welcome'"
        :show-on-startup="showWelcomeOnStartup"
        :recents="recents"
        @open-folder="emit('open-folder')"
        @open-project="emit('open-project')"
        @open-recent="(entry) => emit('open-recent', entry)"
        @open-file-dialog="emit('open-file-dialog')"
        @new-project="emit('new-project')"
        @open-sample="emit('open-sample')"
        @update:show-on-startup="(value) => emit('update:showWelcomeOnStartup', value)"
      />

      <!-- B1. Settings editor (goatcad://settings) -->
      <SettingsView
        v-else-if="activeFileType === 'settings'"
        :pending-category="pendingSettingsCategory"
        @share-feedback="emit('share-feedback')"
      />

      <!-- B1a. Part Search (goatcad://parts) -->
      <PartsView
        v-else-if="activeFileType === 'parts'"
        @open-settings="(category) => emit('open-settings', category)"
      />

      <!-- B1b. Manufacture mode (goatcad://manufacture) -->
      <ManufactureView
        v-else-if="activeFileType === 'manufacture' && activeTab"
        :board-path="manufactureBoardPath(activeTab.path)"
        :unsaved="dirtyPaths.has(manufactureBoardPath(activeTab.path))"
        @reveal-in-board="(path, uuids) => emit('reveal-in-document', path, uuids)"
      />

      <!-- B1c. Components table (goatcad://components/<root sheet>) -->
      <ComponentsTableView
        v-else-if="activeFileType === 'components' && activeTab"
        :key="activeTab.path"
        :root-path="componentsRootPath(activeTab.path)"
        @open-symbol="(path, uuid) => emit('open-symbol', path, uuid)"
        @open-library-symbol="(path, symbol) => emit('open-library-symbol', path, symbol)"
        @open-file="(node) => emit('open-file', node)"
      />

      <!-- B1d. Diff (goatcad://diff/<side>/<file>) -->
      <DiffView
        v-else-if="activeFileType === 'diff' && activeTab"
        :key="activeTab.path"
        :tab-path="activeTab.path"
        @open-file="openDiffFile"
      />

      <!-- B1e. Schematic Setup (goatcad://schematic-setup/<root sheet>) -->
      <SchematicSetupView
        v-else-if="activeFileType === 'schematic-setup' && activeTab"
        :key="activeTab.path"
        :root-path="schematicSetupRootPath(activeTab.path)"
      />

      <!-- B2. Component view (component://…) -->
      <ComponentView
        v-else-if="activeFileType === 'component'"
        :tab-path="props.activeTabPath"
        @open-file="(node) => emit('open-file', node)"
        @open-library-symbol="(path, symbol) => emit('open-library-symbol', path, symbol)"
      />

      <!-- C. Schematic View (.kicad_sch) -->
      <div v-else-if="activeFileType === 'schematic'" class="viewport-editor-host">
        <div v-if="showFileLoading" class="viewport-loading">
          <span class="viewport-loading-spinner"></span>
          <span>{{ t('editorArea.loadingFileContents') }}</span>
        </div>
        <SchematicEditor
          v-if="!isLoadingFile && activeSession"
          :key="props.activeTabPath ?? ''"
          :session="activeSession"
          :model-value="fileContent"
          :file-path="props.activeTabPath || ''"
          :name="activeTab?.name || 'schematic.kicad_sch'"
          :focus-request="documentFocus"
          :is-read-only="formatReadOnly"
          @open-symbol="(path, uuid) => emit('open-symbol', path, uuid)"
          @open-library-symbol="(path, symbol) => emit('open-library-symbol', path, symbol)"
          @reveal-in-sheet="
            (path, uuids, at, finding) => emit('reveal-in-document', path, uuids, at, finding)
          "
          @open-components="(path) => emit('open-components', path)"
          @open-schematic-setup="(path) => emit('open-schematic-setup', path)"
          @open-file="(node) => emit('open-file', node)"
          @file-created="(path) => emit('file-created', path)"
        />
      </div>

      <!-- C. PCB Layout Editor (.kicad_pcb), and its Board Setup tab
           (goatcad://board-setup/<board>): the same editor on the board's session. -->
      <div
        v-else-if="activeFileType === 'pcb' || activeFileType === 'board-setup'"
        class="viewport-editor-host"
      >
        <div v-if="showPcbLoading" class="viewport-loading">
          <div class="viewport-loading-pill">
            <div class="viewport-loading-bar">
              <div class="viewport-loading-fill" :style="{ width: pcbLoadPercent + '%' }"></div>
            </div>
            <span>{{ t('pcbEditor.loadingBoard', { percent: pcbLoadPercent }) }}</span>
          </div>
        </div>
        <PcbEditor
          v-if="!isLoadingFile && activeBoardSession"
          :key="props.activeTabPath ?? ''"
          :session="activeBoardSession"
          :model-value="fileContent"
          :file-path="documentPath"
          :name="activeTab?.name || 'board.kicad_pcb'"
          :board-setup="activeFileType === 'board-setup'"
          :preview3d="isPreview3d"
          :probe-request="boardProbe"
          :focus-request="documentFocus"
          :is-read-only="formatReadOnly"
          @open-manufacture="(path) => emit('open-manufacture', path)"
          @update-from-schematic="(path) => emit('update-from-schematic', path)"
          @open-setup="documentPath && emit('open-board-setup', documentPath)"
          @toggle-preview3d="togglePreview3d"
          @open-library-symbol="(path, symbol) => emit('open-library-symbol', path, symbol)"
          @open-file="(node) => emit('open-file', node)"
          @load-progress="handlePcbLoadProgress"
        />
      </div>

      <!-- 3D model viewer (.step / .stp / .wrl) -->
      <div v-else-if="activeFileType === 'model3d'" style="width: 100%; height: 100%">
        <ModelViewer
          :key="props.activeTabPath ?? ''"
          :file-path="props.activeTabPath || ''"
          :name="activeTab?.name || ''"
        />
      </div>

      <!-- Gerber viewer (.gbr/.gtl/… — see lib/gerber/files.ts) -->
      <div v-else-if="activeFileType === 'gerber'" class="viewport-editor-host">
        <GerberViewer
          v-if="!isLoadingFile"
          :key="props.activeTabPath ?? ''"
          :model-value="fileContent"
          :file-path="props.activeTabPath || ''"
          :name="activeTab?.name || 'layer.gbr'"
        />
      </div>

      <!-- Image viewer (png/jpg/svg/… — see lib/imageFiles.ts) -->
      <div v-else-if="activeFileType === 'image'" style="width: 100%; height: 100%">
        <ImageViewer
          :key="props.activeTabPath ?? ''"
          :file-path="props.activeTabPath || ''"
          :name="activeTab?.name || ''"
        />
      </div>

      <!-- PDF viewer (Chromium's built-in viewer over goatcad-media://) -->
      <div v-else-if="activeFileType === 'pdf'" style="width: 100%; height: 100%">
        <PdfViewer :key="props.activeTabPath ?? ''" :file-path="props.activeTabPath || ''" />
      </div>

      <!-- Rendered HTML (html/htm — see lib/documentFiles.ts) -->
      <div v-else-if="activeFileType === 'html'" style="width: 100%; height: 100%">
        <HtmlViewer :key="props.activeTabPath ?? ''" :file-path="props.activeTabPath || ''" />
      </div>

      <!-- File-info tab for types GoatCAD won't open (see lib/fileTypes.ts) -->
      <div v-else-if="activeFileType === 'unsupported'" style="width: 100%; height: 100%">
        <FileInfoViewer
          :key="props.activeTabPath ?? ''"
          :file-path="props.activeTabPath || ''"
          :name="activeTab?.name || ''"
        />
      </div>

      <!-- D. Symbol Library Viewer (.kicad_sym) -->
      <div v-else-if="activeFileType === 'library-symbol'" class="viewport-editor-host">
        <SymbolLibraryEditor
          v-if="!isLoadingFile && activeLibrarySession"
          :key="props.activeTabPath ?? ''"
          :session="activeLibrarySession"
          :model-value="fileContent"
          :name="activeTab?.name || 'library.kicad_sym'"
          :file-path="props.activeTabPath"
          :is-read-only="
            formatReadOnly || (props.activeTabPath ? isReadonlyLibTab(props.activeTabPath) : false)
          "
          :focus-request="symbolFocus"
          :shown-symbol="activeTab?.symbol"
          :op-request="symbolOp"
          @active-symbol="(name) => emit('active-symbol', props.activeTabPath ?? '', name)"
          @symbol-names="(names) => emit('symbol-names', props.activeTabPath ?? '', names)"
        />
      </div>

      <div v-else-if="activeFileType === 'library-footprint'" class="viewport-editor-host">
        <FootprintEditor
          v-if="!isLoadingFile && activeFootprintSession"
          :key="props.activeTabPath ?? ''"
          :session="activeFootprintSession"
          :model-value="fileContent"
          :file-path="props.activeTabPath"
          :is-read-only="
            formatReadOnly || (props.activeTabPath ? isReadonlyLibTab(props.activeTabPath) : false)
          "
          :name="activeTab ? activeTab.name : 'footprint'"
          :preview3d="isPreview3d"
          :project-path="projectPath"
          @toggle-preview3d="togglePreview3d"
          @save-file="workspace.saveFile"
        />
      </div>

      <!-- F. Terminal (goatcad://terminal/<id>). The pane itself is the layer
           below, which outlives any single tab activation — this branch only
           stops the chain from falling through to the text editor. -->
      <div v-else-if="activeFileType === 'terminal'" class="terminal-slot"></div>

      <!-- E. Editable Text / Markdown Editor -->
      <div v-else class="text-editor-container">
        <div class="text-editor-body">
          <div
            v-if="isLoadingFile"
            style="
              position: absolute;
              inset: 0;
              display: flex;
              align-items: center;
              justify-content: center;
              background-color: var(--vscode-overlay);
              z-index: 10;
            "
          >
            {{ t('editorArea.loadingFileContents') }}
          </div>
          <!-- Gated like the visual editors: unguarded, the editor mounts
               while fileContent still holds the PREVIOUS tab's document (the
               async re-read hasn't landed), and the first forced layout of a
               multi-MB value stalls the tab switch for ~500 ms per MB. -->
          <TextEditor
            v-if="!isLoadingFile"
            :key="props.activeTabPath ?? ''"
            v-model="fileContent"
            :placeholder="t('editorArea.writeContentPlaceholder')"
            @change="handleTextChange"
          />
        </div>
      </div>

      <!-- Every open terminal, mounted for as long as its tab is open and shown
           only when it is active. Unmounting on a tab switch would repaint the
           whole scrollback and lose the scroll position; the shell itself lives
           in the main process either way (ARCHITECTURE.md §3.12). -->
      <TerminalView
        v-for="tab in terminalTabs"
        :key="tab.path"
        :session-id="terminalSessionId(tab.path)"
        :visible="activeTabPath === tab.path"
        :focus-nonce="focusNonce"
      />
    </div>
  </div>
</template>
