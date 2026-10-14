<script setup lang="ts">
import Modal from './components/shared/Modal.vue'
import { loadBoardLibraries } from './lib/board/boardLibraries'
import { boardLibraryIo } from './lib/board/boardLibraryIo'
import { loadGpuPreference } from './lib/gpuPreference'
import { ref, computed, nextTick, watch, onMounted, onUnmounted, provide } from 'vue'
import { useI18n } from 'vue-i18n'
import TitleBar from './components/TitleBar.vue'
import Sidebar from './components/Sidebar.vue'
import EditorArea, { type SchematicAgentApi } from './components/EditorArea.vue'
import QuickOpen from './components/QuickOpen.vue'
import BranchPicker from './components/BranchPicker.vue'
import {
  welcomeTab,
  WELCOME_TAB_PATH,
  PARTS_TAB_PATH,
  partsTab,
  settingsTab,
  SETTINGS_TAB_PATH,
  manufactureTab,
  manufactureTabPath,
  isManufactureTab,
  manufactureBoardPath,
  isSchematicSetupTab,
  schematicSetupRootPath,
  isComponentsTableTab,
  componentsRootPath,
  schematicSetupTab,
  schematicSetupTabPath,
  boardSetupTab,
  boardSetupTabPath,
  boardSetupBoardPath,
  isBoardSetupTab,
  nestChildTabs,
  tabParent,
  componentsTab,
  componentsTabPath,
  diffTab,
  isTerminalTab,
  isSingleTerminalKind,
  terminalSessionId,
  terminalTab,
  terminalTabKind,
  type Tab
} from './lib/tabs'
import { camerasForPath, hydrateCameras, onCamerasChanged } from './lib/engine/cameraStore'
import { terminalNeedsCloseConfirm } from './lib/terminalTitle'
import { applyTerminalRestore, isSessionTab } from './lib/terminalRestore'
import type { TerminalKind, TerminalState } from '../../preload/terminalTypes'
import { hotkeyLabel, matchesHotkey } from './lib/hotkeys'
import {
  focusGroup,
  groupIdOf,
  moveTab,
  otherGroup,
  placeIn,
  renamePath,
  sendToOtherGroup,
  setRatio,
  showTab,
  toggleDirection,
  useEditorGroups
} from './lib/editorGroups'
import {
  onCrossProbe,
  receiveCrossProbe,
  setCrossProbeRoot,
  type CrossProbe
} from './lib/crossProbe'
import { routeCrossProbe, type CrossProbeRoute } from './lib/crossProbeRoute'
import { setAppTheme } from './lib/theme'
import type { CommandId } from './lib/commands'
import {
  blankFileContent,
  kindForFileName,
  uniqueFileName,
  DEFAULT_STEM_FOR_KIND,
  EXTENSION_FOR_KIND,
  type NewFileKind
} from './lib/project/scaffold'
import { findFileByExt } from './lib/fileTreeNav'
import type {
  McpCreateFileRequest,
  McpCreateProjectRequest,
  McpDesignEnvelope,
  McpDesignReply
} from '../../preload/mcpTypes'
import {
  resolveAgentSheet,
  resolveAgentFile,
  fileCandidates,
  documentKindOf
} from './lib/schematic/schematicAgent'
import { copyProjectSymbol, createProjectSymbol, deleteProjectSymbol } from './lib/symbolCreation'
import {
  copyProjectFootprint,
  createProjectFootprint,
  deleteProjectFootprint,
  footprintTextRenamed
} from './lib/footprintCreation'
import { symbolSourcesFor } from './lib/symbol/symbolSources'
import { captureSchematicDocument } from './lib/engine/schematicCapture'
import { BoardWorkScene, captureBoardDocument } from './lib/engine/boardCapture'
import { pcbRouterState } from './lib/pcbRouter'
import { autoTrackWidthFor } from './lib/board/boardViewStore'
import {
  onAgentViewportClose,
  showAgentViewports,
  type ViewportFrame
} from './lib/agentViewportView'
import { changedFrame, createAgentViewports, isViewportRequest } from './lib/agentViewports'
import type { PcbRouterState } from '../../preload/pcbRouterTypes'
import { captureFootprint } from './lib/engine/footprintCapture'
import { captureFootprintModel, captureModelViews } from './lib/engine/board3d/modelCapture'
import { captureBoard3D } from './lib/engine/board3d/boardCapture3D'
import { decodeModel, meshStats, modelFacts, rawBounds } from './lib/engine/board3d/modelFacts'
import { createLibraryAgent, isLibraryRequest } from './lib/symbol/libraryAgent'
import { PCB_GRID_DEFAULTS, SYMBOL_GRID_DEFAULTS, useGridSettings } from './lib/gridPreferences'
import { mmToNm, spacingToMm } from './lib/kicad/coordinates'
import { createFootprintAgent, isFootprintRequest } from './lib/footprint/footprintAgent'
import { createSymbolItemsAgent, isSymbolItemsRequest } from './lib/symbol/symbolItemsAgent'
import { parseKicadSymbolLibrary } from './lib/kicad/symbolLibrary'
import { serializeSExpr } from './lib/kicad/sexpr'
import { extractConnectionGrid } from './lib/kicad/project'
import { resolveProjectLibrary } from './lib/projectLibraryTarget'
import type { LibrarySymbol } from './lib/symbol/symbolSources'
import { createBoardAgent, isBoardRequest, type BoardAgentError } from './lib/board/boardAgent'
import { createFabExportAgent, isFabExportRequest } from './lib/fabExportAgent'
import { captureGerberSet } from './lib/engine/gerberCapture'
import {
  createSchematicSetupAgent,
  isSchematicSetupRequest
} from './lib/schematic/schematicSetupAgent'
import { documentStore } from './lib/document/documentStore'
import { SCHEMATIC_SOURCE } from './lib/board/syncDrift'
import type { UpdatePcbOptions } from './lib/board/syncPreview'
import { schematicNetlistOf } from './lib/board/schematicNetlist'
import { unannotatedReferences } from './lib/board/boardSync'
import { loadLibraryFootprint } from './lib/libraryLoad'
import { agentPreference } from './lib/agentPreference'
import {
  extractTextVariables,
  findProjectFile,
  netClassForNet,
  patchNetclassAssignments,
  readProjectDesignSettings
} from './lib/kicad/project'
import { netclassAssignments } from './lib/schematic/netclassAssignments'
import NewProjectDialog from './components/NewProjectDialog.vue'
import UpdatePcbDialog from './components/UpdatePcbDialog.vue'
import { netlistDate, netlistPathFor, writeNetlist } from './lib/schematic/netlist'
import SampleProjectsDialog from './components/SampleProjectsDialog.vue'
import FeedbackDialog from './components/FeedbackDialog.vue'
import type { FolderEntry } from './lib/project/adoptProject'
import { dirnameOf, samePath } from './lib/kicad/paths'
import {
  newProjectFilesWith,
  refuseCreate,
  type ProjectSetupChoice
} from './lib/project/createProject'
import { projectTemplate } from './lib/project/templates'
import {
  definitionIdOf,
  parseKicadSchematic,
  referenceForSheetPath,
  type KicadSchematic
} from './lib/kicad/schematic'
import { designCopyPath, isDesignCopyPath, sameDesignCopy } from './lib/designCopy'
import { placedFootprintUuid, projectFootprintCopy } from './lib/board/footprintCopy'
import {
  chooseActiveProject,
  projectCandidates,
  type ProjectCandidate
} from './lib/project/projectDetect'
import {
  applyRename,
  planDelete,
  planRename,
  previewFiles,
  renamedPath,
  rewriteBufferText,
  type RenameIo
} from './lib/project/renamePlan'
import {
  loadProjectIndex,
  clearProjectIndex,
  installIndexInvalidation,
  markIndexStale,
  findFootprint,
  indexLoaded,
  loadIndex,
  search as searchIndex
} from './lib/libraryIndex'
import {
  emitProjectChange,
  fileChange,
  fileRenamed,
  installProjectBus,
  onProjectChange,
  type ProjectChange
} from './lib/projectBus'
import {
  addLibraryToProject,
  createProjectLibrary,
  planAddLibrary,
  type AddLibraryMode,
  type AddLibraryPlan
} from './lib/libraryRegistration'
import AddLibraryDialog from './components/AddLibraryDialog.vue'
import { TABLE_FILENAME, type LibraryTableKind } from './lib/kicad/libraryTableWrite'
import { createFileForAgent } from './lib/project/createFileForAgent'
import type { GitBranch, GitDiffSide, GitFileStatus, GitStatusResult } from '../../preload/gitTypes'
import { createGitOps, followedDiffTabs, GIT_KEY } from './lib/git/gitOps'
import type { RecentEntry } from '../../preload/recentTypes'
import type { UnsavedChoice } from '../../preload/dialogTypes'

const { t, locale } = useI18n()

interface FileItem {
  name: string
  path: string
  isDirectory: boolean
  children?: FileItem[]
}

interface LibraryConfig {
  nickname: string
  path: string
  type: 'local' | 'remote'
  readOnly?: boolean
}

const windowId = ref(1)
// Save actions live in EditorArea (it owns editor content and dirty state);
// the title-bar File menu reaches them through this ref.
const editorArea = ref<InstanceType<typeof EditorArea> | null>(null)

/**
 * Live editor-buffer content for an open file, or null when it isn't open.
 * The schematic hierarchy resolves through this so an open, unsaved parent's
 * `(sheet)` edits are visible to the Project view before a save — the open
 * buffer is the authoritative owner of its file (workspace §5.3), the same rule
 * rename forwarding uses.
 */
const readOpenBuffer = (path: string): string | null =>
  editorArea.value?.bufferContent(path) ?? null
// `projectPath` is the *workspace* root — the opened folder. It is not the
// project: a folder may hold none, one, or several `.kicad_pro` files
// (docs/projects.md). `activeProject` is the design whose libraries,
// hierarchy, and settings apply; null means edits are isolated.
const projectPath = ref<string | null>(null)
const projectName = ref('')
const projectCandidateList = ref<ProjectCandidate[]>([])
const activeProject = ref<ProjectCandidate | null>(null)

/**
 * Re-detects the workspace's projects and picks the active one. Ambiguity
 * deliberately yields none active rather than a guess — the candidates are kept
 * so the sidebar can offer them.
 */
const detectProjects = async (root: string | null, preferPath?: string | null): Promise<void> => {
  if (!root) {
    projectCandidateList.value = []
    activeProject.value = null
    return
  }
  try {
    const found = await window.api.findProjects(root)
    const candidates = projectCandidates(found, root)
    // A slow scan must not overwrite a newer workspace's result.
    if (projectPath.value !== root) return
    projectCandidateList.value = candidates
    // A restored pick wins only if that project still exists — it carries
    // information detection cannot recover (which of several the user chose),
    // but a stale path must not leave the window with no project at all.
    const preferred = preferPath ? candidates.find((c) => c.path === preferPath) : undefined
    activeProject.value = preferred ?? chooseActiveProject(candidates)
  } catch (err) {
    console.error('Failed to scan for projects', err)
    projectCandidateList.value = []
    activeProject.value = null
  }
}

/** Explicit pick, used when the workspace holds more than one project. */
const selectActiveProject = (path: string): void => {
  activeProject.value = projectCandidateList.value.find((c) => c.path === path) ?? null
}
const files = ref<FileItem[]>([])
const openTabs = ref<Tab[]>([])
// One editor group or two (split-view-workstream.md). `activeTabPath` stays the
// window's single answer to "which tab is active": the focused group's front tab.
const editorGroups = useEditorGroups(openTabs)
const editorLayout = editorGroups.layout
const activeTabPath = editorGroups.activeTabPath
const activeSidebarTab = ref<'explorer' | 'git' | 'parts'>('explorer')
// VS Code-style: the sidebar drawer stays hidden until a project is open (or the
// user taps an activity-bar button), keeping focus on the welcome/empty screen.
const sidebarVisible = ref(false)
// Restored sidebar geometry. Held here rather than in Sidebar because the
// window session is App's to report; Sidebar owns the drag, App owns the record.
watch(projectPath, (path) => {
  if (path) sidebarVisible.value = true
  // Tell main which workspace to watch for us. External changes — KiCad writing
  // the same folder, a CLI `git checkout`, a file dropped in from the file
  // manager — arrive on the change bus from there (main/projectWatcher.ts).
  window.api.watchProject(path)
})

/**
 * Bumped after the project index reloads. `libraryIndex`'s own generation is a
 * module-level number and therefore not reactive, so consumers in components
 * need a ref to watch.
 */
const projectIndexGeneration = ref(0)

/**
 * Monotonic "the project's committed files changed" signal — the change bus's
 * generation counter, in the form a Vue component can watch
 * (docs/projects.md §9 property 2). Derived views inside
 * components — the schematic hierarchy today — compare it and re-derive lazily
 * rather than subscribing to the bus themselves, which is what makes a consumer
 * written later correct without remembering to subscribe to anything.
 *
 * Content-only commits (a save, which leaves the file set unchanged) bump this
 * too — exactly the case a path-set watch misses.
 */
const projectRevision = ref(0)

/**
 * Project scope for the library index: the design's own libraries, embedded
 * symbols, and placed footprint assignments (see libraries-workstream.md §2).
 *
 * Keyed to the *active project's* directory, not the workspace root — KiCad
 * reads `sym-lib-table` beside the `.kicad_pro`, so a nested project's tables
 * are invisible from the folder above it.
 */
const reloadProjectIndex = async (): Promise<void> => {
  const dir = activeProject.value?.dir
  if (!dir) {
    clearProjectIndex()
    projectIndexGeneration.value++
    return
  }
  try {
    await loadProjectIndex(dir)
  } catch (err) {
    console.error('Failed to load project index', err)
  }
  projectIndexGeneration.value++
}

watch(
  () => activeProject.value?.dir,
  () => void reloadProjectIndex()
)

// Read-only git status for the current project. Refresh is event-driven (no
// polling): project open, in-app saves (via refreshDirectory), window focus,
// opening the Git pane, and the pane's refresh button.
const gitStatus = ref<GitStatusResult | null>(null)
let gitRefreshInflight = false
let gitRefreshQueued = false

const refreshGitStatus = async (force = false): Promise<void> => {
  if (!projectPath.value) {
    gitStatus.value = null
    return
  }
  // Once git is known to be missing, passive triggers (focus/save) stop
  // respawning it; a project change or the manual refresh button retries.
  if (!force && gitStatus.value?.state === 'no-git') return
  if (gitRefreshInflight) {
    gitRefreshQueued = true
    return
  }
  gitRefreshInflight = true
  try {
    do {
      gitRefreshQueued = false
      const path = projectPath.value
      if (!path) {
        gitStatus.value = null
        break
      }
      const result = await window.api.getGitStatus(path)
      if (projectPath.value === path) gitStatus.value = result
    } while (gitRefreshQueued)
  } catch (err) {
    console.error('Failed to read git status', err)
  } finally {
    gitRefreshInflight = false
  }
}

watch(projectPath, (path) => {
  gitStatus.value = null
  if (path) void refreshGitStatus(true)
})

// The window's git actions, shared by the Git pane, diff tabs and the git
// hotkeys (lib/git/gitOps.ts). A pull or discard rewrites files on disk, so it
// is announced like any external edit — which re-reads status on its way.
const gitOps = createGitOps(gitStatus, projectPath, {
  refresh: () => refreshGitStatus(true),
  worktreeChanged: async () => {
    const path = projectPath.value
    if (path) await emitProjectChange(path, fileChange('file-changed', path))
    else await refreshGitStatus(true)
  }
})
provide(GIT_KEY, gitOps)

// A diff tab follows its file's change across a stage or unstage, rather than
// going blank on the side the change just left (`followedDiffTabs`).
watch(gitStatus, (status) => {
  if (status?.state !== 'ok') return
  const moves = followedDiffTabs(
    openTabs.value.map((tab) => tab.path),
    status.files
  )
  for (const [from, to] of moves) {
    const tab = openTabs.value.find((t) => t.path === from)
    if (tab) followRenameInTabs(from, to, tab.name)
  }
})

/** A Git pane row's diff — a file's, or one symbol's — with the preview/pin rules of any other open. */
const openDiffTab = (
  side: GitDiffSide,
  file: GitFileStatus,
  options: { preview: boolean; symbol?: string }
): void => {
  openFile(diffTab(side, file.path, options.symbol), { preview: options.preview })
}

const showGitPane = (): void => showSidebarTab('git')

/** An activity-bar pane by its key: shown, never toggled away, as VS Code's keys do. */
const showSidebarTab = (tab: 'explorer' | 'git' | 'parts'): void => {
  sidebarVisible.value = true
  activeSidebarTab.value = tab
}

/** Which agent CLI the agent button and its key open (Settings ▸ AI Integrations). */
const agentChoice = agentPreference()

const gitPaneVisible = computed(() => sidebarVisible.value && activeSidebarTab.value === 'git')
watch(gitPaneVisible, (visible) => {
  if (visible) void refreshGitStatus()
})
const showShortcutsModal = ref(false)
// The Keyboard shortcuts sheet. Keys come from the hotkey registry, so the
// sheet always shows the platform's spelling; DevTools is Electron's own.
const shortcutSheet = computed((): { label: string; keys: string }[] => [
  { label: t('app.shortcuts.openFolder'), keys: hotkeyLabel('app.openFolder') },
  { label: t('app.shortcuts.openProject'), keys: hotkeyLabel('app.openProject') },
  { label: t('app.shortcuts.goToFile'), keys: hotkeyLabel('app.quickOpen') },
  { label: t('app.shortcuts.newSchematic'), keys: hotkeyLabel('app.newSchematic') },
  { label: t('app.shortcuts.newWindow'), keys: hotkeyLabel('app.newWindow') },
  { label: t('app.shortcuts.closeTab'), keys: hotkeyLabel('app.closeTab') },
  { label: t('app.shortcuts.nextTab'), keys: hotkeyLabel('app.cycleTabNext') },
  { label: t('app.shortcuts.previousTab'), keys: hotkeyLabel('app.cycleTabPrev') },
  { label: t('app.shortcuts.splitTab'), keys: hotkeyLabel('app.splitTab') },
  { label: t('app.shortcuts.splitDirection'), keys: hotkeyLabel('app.splitDirection') },
  { label: t('app.shortcuts.focusOtherGroup'), keys: hotkeyLabel('app.focusOtherGroup') },
  { label: t('app.shortcuts.updatePcb'), keys: hotkeyLabel('app.updatePcb') },
  { label: t('app.shortcuts.save'), keys: hotkeyLabel('editor.save') },
  { label: t('app.shortcuts.showExplorer'), keys: hotkeyLabel('app.showExplorer') },
  { label: t('app.shortcuts.showLibraries'), keys: hotkeyLabel('app.showLibraries') },
  { label: t('app.shortcuts.openPartSearch'), keys: hotkeyLabel('app.openPartSearch') },
  { label: t('app.shortcuts.newTerminal'), keys: hotkeyLabel('app.newTerminal') },
  { label: t('app.shortcuts.openAgent'), keys: hotkeyLabel('app.openAgent') },
  { label: t('app.shortcuts.openSettings'), keys: hotkeyLabel('app.openSettings') },
  { label: t('app.shortcuts.gitFocusCommit'), keys: hotkeyLabel('git.focusCommit') },
  { label: t('app.shortcuts.gitCommit'), keys: hotkeyLabel('git.commit') },
  { label: t('app.shortcuts.gitStageAll'), keys: hotkeyLabel('git.stageAll') },
  { label: t('app.shortcuts.gitPush'), keys: hotkeyLabel('git.push') },
  { label: t('app.shortcuts.gitPull'), keys: hotkeyLabel('git.pull') },
  { label: t('app.shortcuts.toggleDevTools'), keys: 'F12' }
])
const showQuickOpen = ref(false)
const showWelcomeOnStartup = ref(true)

const loadingFilePath = ref<string | null>(null)
const libraries = ref<LibraryConfig[]>([])

// Session restore: report this window's state to the main process on every
// change so it can persist the windows that were open at the last close.
// Ready only after init has been applied, or an empty pre-init state would be
// reported over the state we were told to restore.
const sessionReady = ref(false)

// Zoom and pan settle long after the tab list does, so the session watcher has
// to hear about them; `cameraStore` coalesces a pan into one report.
const cameraRevision = ref(0)
onUnmounted(onCamerasChanged(() => cameraRevision.value++))

watch(
  [projectPath, openTabs, activeTabPath, activeProject, cameraRevision, () => editorGroups.saved()],
  () => {
    if (!sessionReady.value) return
    window.api.updateSession({
      projectPath: projectPath.value,
      // A plain shell is deliberately left out. A pty does not survive the app
      // quitting, so restoring one would bring back a tab whose shell is gone —
      // worse than not restoring it. An agent tab is recorded: its conversation
      // is on disk, and the restore starts it again (`lib/terminalRestore.ts`).
      tabs: openTabs.value
        .filter((tab) => isSessionTab(tab.path))
        .map((tab) => {
          const cameras = camerasForPath(tab.path)
          return { name: tab.name, path: tab.path, ...(cameras ? { cameras } : {}) }
        }),
      activeTabPath: activeTabPath.value,
      activeProjectPath: activeProject.value?.path ?? null,
      editorLayout: editorGroups.saved()
    })
  },
  { deep: true }
)

const setShowWelcomeOnStartup = async (value: boolean): Promise<void> => {
  showWelcomeOnStartup.value = value
  try {
    await window.api.updateConfig({ showWelcomeOnStartup: value })
  } catch (err) {
    console.error('Failed to save welcome-on-startup setting', err)
  }
}

const openWelcomeTab = (): void => {
  if (!openTabs.value.some((tab) => tab.path === WELCOME_TAB_PATH)) {
    openTabs.value.unshift(welcomeTab())
  }
  activeTabPath.value = WELCOME_TAB_PATH
}

/**
 * Which settings category to land on, for callers that are asking for a
 * *specific* preference rather than settings in general. Carries a nonce like
 * `pendingFocus`: the tab is usually already open, and re-requesting the same
 * category has to re-select it after the user has clicked elsewhere.
 */
const pendingSettingsCategory = ref<{ category: string; nonce: number } | null>(null)

// Part Search is a single tab, same rule as Settings.
const openPartsTab = (): void => {
  if (!openTabs.value.some((tab) => tab.path === PARTS_TAB_PATH)) {
    openTabs.value.push(partsTab())
  }
  activeTabPath.value = PARTS_TAB_PATH
}

// Settings is a single tab: opening it again focuses the one already open.
const openSettingsTab = (category?: string): void => {
  if (!openTabs.value.some((tab) => tab.path === SETTINGS_TAB_PATH)) {
    openTabs.value.push(settingsTab())
  }
  activeTabPath.value = SETTINGS_TAB_PATH
  if (category) {
    pendingSettingsCategory.value = {
      category,
      nonce: (pendingSettingsCategory.value?.nonce ?? 0) + 1
    }
  }
}

// What an agent may name a file by. An app tab (`goatcad://…`) titled after a
// design file — Components after the root sheet, Fabrication outputs after the
// board — is not that file, and must not answer to its name.
const fileTabs = computed(() => openTabs.value.filter((tab) => !tab.path.startsWith('goatcad://')))

// Components is a per-design tab opened from any of the design's sheets (the
// properties panel's Components button), keyed by the root sheet. Same
// focus-if-open rule.
const openComponentsTab = (rootSheetPath: string): void => {
  const path = componentsTabPath(rootSheetPath)
  if (!openTabs.value.some((tab) => tab.path === path)) {
    openTabs.value.push(componentsTab(rootSheetPath))
  }
  activeTabPath.value = path
}

// Manufacture is a per-board tab opened from the PCB editor (the properties
// panel's Manufacture button). Same focus-if-open rule, keyed by board path.
const openManufactureTab = (boardPath: string): void => {
  const path = manufactureTabPath(boardPath)
  if (!openTabs.value.some((tab) => tab.path === path)) {
    openTabs.value.push(manufactureTab(boardPath))
  }
  activeTabPath.value = path
}

// Schematic Setup is per design, keyed by its root sheet like the Components tab.
const openSchematicSetupTab = (rootSheetPath: string): void => {
  const path = schematicSetupTabPath(rootSheetPath)
  if (!openTabs.value.some((tab) => tab.path === path)) {
    openTabs.value.push(schematicSetupTab(rootSheetPath))
  }
  activeTabPath.value = path
}

// Board Setup is a view on its board's document (lib/tabs.ts). Same focus-if-open rule.
const openBoardSetupTab = (boardPath: string): void => {
  const path = boardSetupTabPath(boardPath)
  if (!openTabs.value.some((tab) => tab.path === path)) {
    openTabs.value.push(boardSetupTab(boardPath))
  }
  activeTabPath.value = path
}

// A child tab and its parent live together (`tabParent`, lib/tabs.ts). The
// child sits after its parent, and the parent is pinned: a preview replaced
// under it would take its children along. Closing the parent closes its
// children, whose edits the parent's tab holds and asks about; a child that
// arrives without its parent (restored, dragged in from another window) brings
// the parent along behind it.
watch(
  () => openTabs.value.map((tab) => tab.path),
  (paths, before) => {
    const open = new Set(paths)
    const had = new Set(before ?? [])
    for (const path of paths) {
      const parent = tabParent(path)?.path
      if (parent === undefined) continue
      if (open.has(parent)) pinTab(parent)
      else if (had.has(parent)) closeTab(path)
      else openFileInBackground(parent)
    }
    const nested = nestChildTabs(openTabs.value)
    if (nested.some((tab, index) => tab !== openTabs.value[index])) openTabs.value = nested
  }
)

// ---- Terminal tabs (ARCHITECTURE.md §3.12) --------------------------------
// The shell itself lives in the main process; this window owns the tab, the
// close, and the poll that keeps the tab strip honest about what is running.

/** Live state of every open terminal session, keyed by tab path. */
const terminalStates = ref<Record<string, TerminalState>>({})

/**
 * Slow enough that a `ps` on macOS is nothing, fast enough that starting a
 * command and seeing the tab rename reads as immediate. Runs only while a
 * terminal tab is open — an app with none must not poll at all.
 */
const TERMINAL_POLL_MS = 1500
let terminalPollTimer: ReturnType<typeof setInterval> | undefined

const terminalTabs = (): Tab[] => openTabs.value.filter((tab) => isTerminalTab(tab.path))

const pollTerminalStates = async (): Promise<void> => {
  const tabs = terminalTabs()
  if (tabs.length === 0) {
    terminalStates.value = {}
    return
  }
  try {
    const states = await window.api.terminalStates(tabs.map((tab) => terminalSessionId(tab.path)))
    // Re-keyed by tab path: every reader here has a tab, not a session id.
    const next: Record<string, TerminalState> = {}
    for (const tab of tabs) {
      const state = states[terminalSessionId(tab.path)]
      if (state) next[tab.path] = state
    }
    terminalStates.value = next
  } catch (err) {
    console.error('Failed to read terminal state', err)
  }
}

watch(
  () => terminalTabs().length > 0,
  (any) => {
    if (any && !terminalPollTimer) {
      void pollTerminalStates()
      terminalPollTimer = setInterval(() => void pollTerminalStates(), TERMINAL_POLL_MS)
    } else if (!any && terminalPollTimer) {
      clearInterval(terminalPollTimer)
      terminalPollTimer = undefined
      terminalStates.value = {}
    }
  }
)

/**
 * Open a terminal of `kind`, in the workspace root — the folder the window has
 * open is the directory every one of these is about (an agent reading the
 * design, a build, git), and main falls back to the home directory when there is
 * no folder.
 *
 * A plain shell opens a new tab every time, like a terminal emulator's new-tab
 * button. The agents are one per window: their button focuses the tab that is
 * already open, because an agent session is a *conversation* — a second tab of
 * it is not a second conversation, just a way to lose the first. Whether a
 * launch continues that directory's last conversation is main's call
 * (`terminalAgents.ts`), not something the button decides.
 */
const openTerminalTab = async (kind: TerminalKind = 'shell'): Promise<void> => {
  if (isSingleTerminalKind(kind)) {
    const open = openTabs.value.find(
      (tab) => isTerminalTab(tab.path) && terminalTabKind(tab.path) === kind
    )
    if (open) {
      activeTabPath.value = open.path
      return
    }
  }
  try {
    const session = await window.api.startTerminal(projectPath.value ?? '', kind)
    const tab = terminalTab(kind, session.id, session.shell)
    openTabs.value.push(tab)
    activeTabPath.value = tab.path
  } catch (err) {
    console.error('Failed to start terminal', err)
  }
}

/**
 * The terminal tabs a window opens with, made live (`lib/terminalRestore.ts`).
 * One whose session main still holds is kept as it is — a tab dragged out into
 * this window, or this window reloading. Any other is a record from a run of
 * the app that has ended: an agent is started again, which continues its
 * conversation, and takes the old tab's place.
 */
type WindowInit = Awaited<ReturnType<typeof window.api.getWindowInit>>

const restoreTerminalTabs = async (init: WindowInit): Promise<WindowInit> => {
  const outcomes = new Map<string, Tab | null>()
  await Promise.all(
    init.tabs
      .filter((tab) => isTerminalTab(tab.path))
      .map(async (tab) => {
        try {
          if (await window.api.attachTerminal(terminalSessionId(tab.path))) return
          const kind = terminalTabKind(tab.path)
          if (!isSingleTerminalKind(kind)) return void outcomes.set(tab.path, null)
          const session = await window.api.startTerminal(init.projectPath ?? '', kind)
          outcomes.set(tab.path, terminalTab(kind, session.id, session.shell))
        } catch (err) {
          console.error('Failed to restore terminal tab', err)
          outcomes.set(tab.path, null)
        }
      })
  )
  return applyTerminalRestore(init, outcomes)
}

/**
 * Native "this is still running" box; true when the user wants them closed
 * anyway. Takes the whole list because closing a window ends every terminal in
 * it at once — naming one and silently killing the rest is the failure this
 * exists to prevent.
 */
const confirmKillTerminals = async (processes: string[]): Promise<boolean> => {
  const many = processes.length > 1
  const choice = await window.api.chooseDialog({
    message: many
      ? t('terminal.close.messageMany', { count: processes.length })
      : t('terminal.close.message', { process: processes[0] ?? '' }),
    detail: many
      ? `${processes.map((name) => `• ${name}`).join('\n')}\n\n${t('terminal.close.detailMany')}`
      : t('terminal.close.detail'),
    buttons: [
      many ? t('terminal.close.confirmMany') : t('terminal.close.confirm'),
      t('common.cancel')
    ],
    cancelId: 1
  })
  return choice === 0
}

const loadLibrariesTable = async (): Promise<void> => {
  try {
    const res = await window.api.getLibraries()
    libraries.value = res.libraries || []
  } catch (err) {
    console.error('Failed to load libraries list', err)
  }
}

const handleOpenFolder = async (): Promise<void> => {
  try {
    const project = await window.api.openDirectory()
    if (project) {
      loadProject(project as { path: string; name: string; files: FileItem[] })
    }
  } catch (err) {
    console.error('Error selecting folder:', err)
  }
}

/**
 * Open Project: the design is named, not detected. The workspace still becomes
 * a folder — the `.kicad_pro`'s own — so this lands in exactly the state Open
 * Folder produces, and re-roots the window the same way. Switching projects
 * *within* the open workspace is the sidebar's switcher, not this
 * (docs/projects.md §3).
 */
const handleOpenProject = async (): Promise<void> => {
  try {
    const picked = await window.api.openProjectDialog()
    if (picked) {
      loadProject(
        picked as { path: string; name: string; files: FileItem[] },
        picked.projectFilePath
      )
    }
  } catch (err) {
    console.error('Error selecting project:', err)
  }
}

/**
 * Recently opened projects, for File ▸ Open Recent. Held here rather than fetched
 * by the menu because main broadcasts every change (`config:changed`), so this
 * stays true when another window opens a project or the Welcome page clears the
 * list — a menu that fetched on open would still be right, but only for the
 * window that did the fetching.
 */
const recents = ref<RecentEntry[]>([])

/**
 * Reopen a recent, in the context it was used in.
 *
 * The entry carries its own workspace root and active project, so a recent file
 * lands back in its project rather than isolated — which is the whole point of
 * recording the context alongside the path. A folder that has since been moved
 * or deleted drops itself from the list rather than failing twice.
 */
const openRecentEntry = async (entry: RecentEntry): Promise<void> => {
  try {
    const listing = (await window.api.readDirectory(entry.workspaceRoot)) as FileItem[]
    if (!listing || listing.length === 0) {
      recents.value = await window.api.removeRecent(entry.path)
      alert(t('app.errors.openRecent'))
      return
    }
    const root = entry.workspaceRoot
    await loadProject(
      { path: root, name: root.split(/[/\\]/).pop() || root, files: listing },
      entry.projectPath ?? undefined
    )
    if (entry.kind === 'file') {
      openFile({ name: entry.path.split(/[/\\]/).pop() || entry.path, path: entry.path })
    }
  } catch (err) {
    console.error('Failed to open recent', err)
  }
}

/**
 * Open File… — the degraded path (a single file, its folder as workspace,
 * whatever project happens to be detected there). Shared by the File menu and
 * the Welcome page, hence here rather than in either.
 */
const handleOpenFileDialog = async (): Promise<void> => {
  try {
    const res = await window.api.openFileDialog()
    if (!res) return
    await loadProject({
      path: res.projectPath,
      name: res.projectName,
      files: res.files as FileItem[]
    })
    // A project file just opens its folder; anything else also opens as a tab.
    if (!res.fileName.toLowerCase().endsWith('.kicad_pro')) {
      openFile({ name: res.fileName, path: res.filePath })
    }
  } catch (err) {
    console.error('Failed to open file', err)
  }
}

const clearRecents = async (): Promise<void> => {
  try {
    recents.value = await window.api.clearRecents()
  } catch (err) {
    console.error('Failed to clear recents', err)
  }
}

/**
 * Record what this window is looking at. Called once the active project is
 * known, since the project context is half of what makes an entry reopenable.
 */
const recordRecent = async (
  kind: 'project' | 'file',
  path: string,
  workspaceRoot: string
): Promise<void> => {
  try {
    recents.value = await window.api.addRecent({
      kind,
      path,
      workspaceRoot,
      projectPath: activeProject.value?.path ?? null
    })
  } catch (err) {
    console.error('Failed to record recent', err)
  }
}

/**
 * The folder a Create Project is targeting, while its dialog is open. The dialog
 * decides *what* to write (scaffold or adopt); this only says where.
 */
const newProjectTarget = ref<{ path: string; name: string; entries: FolderEntry[] } | null>(null)

const topLevelEntries = (files: FileItem[]): FolderEntry[] =>
  files.map((file) => ({ name: file.name, isDirectory: file.isDirectory }))

/**
 * New Project: main picks the folder, the renderer writes the file set — the
 * templates serialize through `serializeSExpr`, which lives on this side
 * (docs/projects.md §6). Reached from the File menu, the
 * Welcome page, and the sidebar's no-project state, so it lives here rather
 * than in any one of them.
 */
const handleNewProject = async (): Promise<void> => {
  try {
    const project = await window.api.createProject()
    if (!project) return
    const typed = project as { path: string; name: string; files: FileItem[] }
    newProjectTarget.value = {
      path: typed.path,
      name: typed.name,
      entries: topLevelEntries(typed.files)
    }
  } catch (err) {
    console.error('Failed to create project', err)
  }
}

/**
 * The no-project state's exit. The folder is already known — it is the open
 * workspace — so this skips the picker and goes straight to the dialog, which is
 * the whole point of the affordance: adopt *these* files
 * (docs/projects.md §4).
 */
const handleCreateProjectHere = (): void => {
  if (!projectPath.value) {
    void handleNewProject()
    return
  }
  newProjectTarget.value = {
    path: projectPath.value,
    name: projectName.value,
    entries: topLevelEntries(files.value)
  }
}

/**
 * The root sheet's own uuid is what makes a schematic a project's: `sheets[0]`
 * keys it by uuid, never by filename (projectDetect.ts). Adopting therefore
 * means reading the chosen sheet, not just naming it.
 */
const rootUuidOf = async (filePath: string): Promise<string | null> => {
  const res = await window.api.readFile(filePath)
  if (!res.success || !res.content) return null
  try {
    return parseKicadSchematic(res.content).uuid ?? null
  } catch {
    return null
  }
}

/**
 * Write a project's files into a folder: around a schematic already there
 * (`rootSheet`), or the whole scaffold. Nothing is overwritten. The New
 * Project dialog and the agent's `project.create` both land here. Answers
 * with the files written and the root sheet's path, if adopted.
 */
const writeNewProject = async (
  target: { path: string; entries: FolderEntry[] },
  name: string,
  rootSheet: string | null,
  setup: ProjectSetupChoice = {}
): Promise<{ written: string[]; rootPath: string | null }> => {
  const existing = new Set(target.entries.map((entry) => entry.name.toLowerCase()))
  const written: string[] = []
  // Adopting writes one file — the project — around schematics that already
  // exist. Scaffolding writes the whole set.
  const adoptedUuid = rootSheet ? await rootUuidOf(`${target.path}/${rootSheet}`) : null
  if (rootSheet && adoptedUuid) {
    const projectFile = `${name}.kicad_pro`
    if (!existing.has(projectFile.toLowerCase())) {
      const res = await window.api.createFile(
        `${target.path}/${projectFile}`,
        projectTemplate(name, adoptedUuid)
      )
      if (!res.success) throw new Error(res.error)
      written.push(`${target.path}/${projectFile}`)
    }
    return { written, rootPath: `${target.path}/${rootSheet}` }
  }
  for (const file of newProjectFilesWith(name, setup)) {
    if (existing.has(file.name.toLowerCase())) continue
    const res = await window.api.createFile(`${target.path}/${file.name}`, file.content)
    if (!res.success) throw new Error(res.error)
    written.push(`${target.path}/${file.name}`)
  }
  return { written, rootPath: null }
}

const confirmNewProject = async (name: string, rootSheet: string | null): Promise<void> => {
  const target = newProjectTarget.value
  if (!target) return
  newProjectTarget.value = null
  try {
    const { rootPath } = await writeNewProject(target, name, rootSheet)
    const projectFiles = (await window.api.readDirectory(target.path)) as FileItem[]
    await loadProject(
      { path: target.path, name: target.name, files: projectFiles },
      `${target.path}/${name}.kicad_pro`
    )
    // Land the user in the editor, not an empty explorer.
    const schematic = rootPath
      ? { name: rootSheet as string, path: rootPath }
      : findFileByExt(projectFiles, '.kicad_sch')
    if (schematic) openFile({ name: schematic.name, path: schematic.path })
  } catch (err) {
    console.error('Failed to create project', err)
  }
}

/**
 * `project.create`: the dialog's create, for an agent. The new project opens
 * only where it replaces nothing — this window's own folder, or a window with
 * no folder open; otherwise it is written and left for the user to open.
 */
const createProjectForAgent = async (request: McpCreateProjectRequest): Promise<unknown> => {
  const folder = request.folder ?? projectPath.value
  if (!folder)
    return {
      error: 'no-project',
      detail: 'This window has no folder open. Pass folder, or ask the user to open one.'
    }
  let listing: FileItem[]
  try {
    listing = (await window.api.readDirectory(folder)) as FileItem[]
  } catch {
    return { error: 'file-not-found', detail: `${folder} is not a folder this app can read.` }
  }
  const entries = topLevelEntries(listing)
  const folderName = folder.split(/[\\/]/).filter(Boolean).pop() ?? folder
  const setup: ProjectSetupChoice = {
    ...(request.copperLayers !== undefined ? { copperLayers: request.copperLayers } : {}),
    ...(request.profile !== undefined ? { profile: request.profile } : {})
  }
  const refusal = refuseCreate(
    entries,
    folderName,
    request.name,
    request.adopt,
    request.blank === true,
    setup
  )
  if (refusal)
    return {
      error: refusal.error,
      detail: refusal.detail,
      ...(refusal.candidates ? { candidates: refusal.candidates } : {})
    }
  let written: string[]
  try {
    written = (
      await writeNewProject({ path: folder, entries }, request.name, request.adopt ?? null, setup)
    ).written
  } catch (err) {
    return { error: 'write-failed', detail: err instanceof Error ? err.message : String(err) }
  }
  const projectFile = `${folder}/${request.name}.kicad_pro`
  const opens = projectPath.value === null || samePath(projectPath.value, folder)
  if (opens) {
    const projectFiles = (await window.api.readDirectory(folder)) as FileItem[]
    await loadProject({ path: folder, name: folderName, files: projectFiles }, projectFile)
  }
  return {
    project: projectFile,
    written,
    ...(request.adopt ? { adopted: request.adopt } : {}),
    opened: opens,
    guidance: opens
      ? 'The project is open in this window and active: board_describe, schematic_describe and the rest act on it. Nothing was opened as a tab.'
      : 'The files are written, but this window has another project open, which was left as it is. Ask the user to open the new one.'
  }
}

/**
 * `project.create_file`: New ▸ for an agent, in the active project's folder,
 * with the GUI's content and registration; the file opens behind the active tab.
 */
const createFileForAgentRequest = (request: McpCreateFileRequest): Promise<unknown> => {
  const project = activeProject.value
  return createFileForAgent(
    project && { path: project.path, dir: project.dir },
    projectPath.value !== null,
    request,
    {
      listNames: async (directory) =>
        ((await window.api.readDirectory(directory)) as FileItem[]).map((file) => file.name),
      createFile: (path, content) => window.api.createFile(path, content),
      readTable: async (kind) =>
        project
          ? (await window.api.readProjectLibTable(project.path, TABLE_FILENAME[kind])).content
          : null,
      createLibrary: (kind, name) => createProjectLibrary(kind, project!.path, project!.dir, name),
      announce: (path, nickname) =>
        emitProjectChange(
          projectPath.value,
          fileChange('file-created', path),
          ...(nickname
            ? [{ kind: 'library-registered' as const, scope: 'project' as const, nickname }]
            : [])
        ),
      openBehind: openFileInBackground
    }
  )
}

const showSampleProjects = ref(false)

/**
 * A sample main has just downloaded (or already had) in temp. Opened like Open
 * Project, then onto its root sheet — someone trying the app out should land
 * in a design, not an explorer.
 */
const openSampleProject = async (sample: {
  projectFilePath: string
  path: string
  name: string
}): Promise<void> => {
  showSampleProjects.value = false
  try {
    const projectFiles = (await window.api.readDirectory(sample.path)) as FileItem[]
    await loadProject(
      { path: sample.path, name: sample.name, files: projectFiles },
      sample.projectFilePath
    )
    const rootSheet = sample.projectFilePath.replace(/\.kicad_pro$/i, '.kicad_sch')
    const rootName = rootSheet.split(/[/\\]/).pop() as string
    if (projectFiles.some((file) => file.path === rootSheet)) {
      openFile({ name: rootName, path: rootSheet })
    }
  } catch (err) {
    console.error('Failed to open sample project', err)
  }
}

/** The target folder was already a project; open that rather than making another. */
const openExistingProject = async (fileName: string): Promise<void> => {
  const target = newProjectTarget.value
  if (!target) return
  newProjectTarget.value = null
  try {
    const projectFiles = (await window.api.readDirectory(target.path)) as FileItem[]
    await loadProject(
      { path: target.path, name: target.name, files: projectFiles },
      `${target.path}/${fileName}`
    )
  } catch (err) {
    console.error('Failed to open project', err)
  }
}

const loadProject = async (
  project: {
    path: string
    name: string
    files: FileItem[]
  },
  preferProjectPath?: string
): Promise<void> => {
  // Re-loading the window's current project (e.g. Open File into the same
  // folder) just refreshes the listing; it must not discard the open tabs.
  const samePath = projectPath.value === project.path
  projectPath.value = project.path
  projectName.value = project.name
  files.value = project.files
  if (!samePath) {
    openTabs.value = []
    activeTabPath.value = null
  }
  // Awaited, unlike the restore path's fire-and-forget scan: the recent entry
  // below records which project is active, and that is what decides whether it
  // reads as a project or as a bare folder.
  await detectProjects(project.path, preferProjectPath)
  await recordRecent('project', activeProject.value?.path ?? project.path, project.path)
}

// The tree read is a synchronous walk in main, so overlapping refreshes (a save
// landing while a focus refresh is in flight) coalesce into one trailing pass
// rather than stacking — same shape as refreshGitStatus above.
let dirRefreshInflight = false
let dirRefreshQueued = false

const refreshDirectory = async (): Promise<void> => {
  if (projectPath.value) {
    if (dirRefreshInflight) {
      dirRefreshQueued = true
      return
    }
    dirRefreshInflight = true
    try {
      do {
        dirRefreshQueued = false
        const path = projectPath.value
        if (!path) break
        const dirFiles = await window.api.readDirectory(path)
        // The project can change mid-read; don't paint the old folder's tree.
        if (projectPath.value === path) files.value = dirFiles as FileItem[]
      } while (dirRefreshQueued)
    } catch (err) {
      console.error(err)
    } finally {
      dirRefreshInflight = false
    }
    // The generation signal derived views watch (`projectRevision`), bumped once
    // per refresh. It catches content-only commits — a save leaves the file set
    // unchanged, which a path-set watch would miss entirely.
    projectRevision.value++
    void refreshGitStatus()
    // Re-detect projects, so creating or deleting a `.kicad_pro` changes the
    // active project without reopening the folder. A depth-2 readdir is cheaper
    // than the git and index work already happening here. The current pick is
    // passed as a preference so an ordinary create/save never drops the active
    // project on the ambiguous-workspace path — that reset also cleared the
    // project index.
    void detectProjects(projectPath.value, activeProject.value?.path)
    // …and re-derive project scope (placed footprints / embedded symbols may
    // have changed on save). Main memoizes on mtime, so an unchanged design is
    // a couple of stats.
    void reloadProjectIndex()
  }
}

/**
 * Everything derived from committed files re-derives here, and only here
 * (docs/projects.md §9). Mutations announce *what
 * happened*; this decides what that invalidates, so a new derived store
 * subscribes once instead of being appended to every mutation.
 */
const handleProjectChanges = async (changes: ProjectChange[]): Promise<void> => {
  await refreshDirectory()
  // A machine-wide library registration is the one change the *system* index
  // depends on, and it is also the one another window can make. Marking it stale
  // is what fixes the chooser that would otherwise keep serving the old index.
  if (changes.some((c) => c.kind === 'library-registered' && c.scope === 'global')) {
    markIndexStale()
  }
}

const handleCreateFile = async (fileName: string, directory?: string): Promise<void> => {
  const parent = directory ?? projectPath.value
  if (!parent) return
  const filePath = `${parent}/${fileName}`
  // Content comes from the shared templates (lib/project/scaffold.ts).
  const kind = kindForFileName(fileName)
  const initialContent = kind ? blankFileContent(kind, fileName) : ''
  try {
    const res = await window.api.createFile(filePath, initialContent)
    if (res.success) {
      await emitProjectChange(projectPath.value, fileChange('file-created', filePath))
      openFile({ name: fileName, path: filePath })
    } else {
      alert(t('app.errors.createFile', { error: res.error }))
    }
  } catch (err) {
    console.error(err)
  }
}

/**
 * File explorer context-menu actions. Rename/delete are deliberately outside
 * the undo/redo command layer — history is per-file and per-document, so a
 * filesystem edit has no home in it; delete goes to the OS trash instead
 * (docs/projects.md §8.5).
 */
const handleFileAction = async (action: CommandId, node: FileItem): Promise<void> => {
  switch (action) {
    case 'file:open':
      openFile({ name: node.name, path: node.path })
      break
    case 'file:reveal':
      await window.api.revealPath(node.path)
      break
    case 'file:copy-path':
      await navigator.clipboard.writeText(node.path)
      break
    case 'file:delete': {
      // §4.4: deleting a referenced schematic leaves dangling sheet links in its
      // parents — name them so the confirm is informed, not a blind "are you sure".
      const referrers = node.name.toLowerCase().endsWith('.kicad_sch')
        ? (await planDelete(node.path, collectSchematicPaths(files.value), diskRenameIo)).referrers
        : []
      const message = referrers.length
        ? t(
            'app.confirm.deleteFileReferenced',
            {
              name: node.name,
              count: referrers.length,
              files: referrers
                .map((f) =>
                  t('app.confirm.deleteImpactFile', { name: f.fileName, count: f.count }, f.count)
                )
                .join('\n')
            },
            referrers.length
          )
        : t('app.confirm.deleteFile', { name: node.name })
      if (!confirm(message)) return
      const res = await window.api.deletePath(node.path)
      if (!res.success) {
        alert(t('app.errors.deleteFile', { error: res.error }))
        return
      }
      closeTab(node.path)
      await emitProjectChange(projectPath.value, fileChange('file-deleted', node.path))
      break
    }
    default:
      break
  }
}

/** Path handed to the explorer so a just-created file opens its name editor. */
const pendingRenamePath = ref<string | null>(null)

/**
 * `New ▸ <kind>`: write a blank file of that type with a free default name,
 * then hand the explorer the path so the user names it in place. Creating
 * first (rather than editing a phantom row) means the name goes through the
 * same rename path, validation included.
 */
const handleCreateTypedFile = async (kind: NewFileKind, directory: string): Promise<void> => {
  const siblings = (await window.api.readDirectory(directory)) as FileItem[]
  const fileName = uniqueFileName(
    DEFAULT_STEM_FOR_KIND[kind],
    EXTENSION_FOR_KIND[kind],
    siblings.map((file) => file.name)
  )
  const filePath = `${directory}/${fileName}`
  const res = await window.api.createFile(filePath, blankFileContent(kind, fileName))
  if (!res.success) {
    alert(t('app.errors.createFile', { error: res.error }))
    return
  }
  // Awaited: the explorer can only open its inline editor on a row the tree
  // already carries, and the bus settles once subscribers have run.
  await emitProjectChange(projectPath.value, fileChange('file-created', filePath))
  pendingRenamePath.value = filePath
}

/**
 * Add Library, project tier. The pick is the easy half; the consequential half
 * is whether the library becomes part of the project or stays a pointer into
 * whatever folder it was downloaded to, so that is asked rather than assumed
 * (§4.5 decision 2). A library already inside the project has no choice to make
 * and skips the dialog.
 */
const addLibraryPlan = ref<AddLibraryPlan | null>(null)

const handleAddLibrary = async (kind: LibraryTableKind): Promise<void> => {
  const project = activeProject.value
  if (!project) return
  const picked =
    kind === 'symbol'
      ? await window.api.pickSymbolLibraryFile(t('libraryBrowser.add.symbolFileTitle'))
      : await window.api.pickDirectory(t('libraryBrowser.add.footprintFolderTitle'))
  if (!picked) return
  const siblings = (await window.api.readDirectory(project.dir)) as FileItem[]
  const plan = planAddLibrary(
    kind,
    picked,
    project.dir,
    siblings.map((file) => file.name)
  )
  if (plan.alreadyInProject) {
    await runAddLibrary(plan, 'reference')
    return
  }
  addLibraryPlan.value = plan
}

const runAddLibrary = async (plan: AddLibraryPlan, mode: AddLibraryMode): Promise<void> => {
  const project = activeProject.value
  addLibraryPlan.value = null
  if (!project) return
  try {
    const nickname = await addLibraryToProject(plan, mode, project.path)
    // A copy also puts a file in the project, so both halves are announced —
    // the tree has a new row *and* the project's library set grew.
    await emitProjectChange(
      projectPath.value,
      ...(mode === 'copy' && !plan.alreadyInProject
        ? [fileChange('file-created', plan.copyTarget)]
        : []),
      { kind: 'library-registered', scope: 'project', nickname }
    )
  } catch (err) {
    alert(t('app.errors.library', { error: err instanceof Error ? err.message : String(err) }))
  }
}

// Create an empty library named up front, then register it (§9: the nickname is
// fixed at creation, so libraries name-first rather than create-then-rename).
const handleNewLibrary = async (kind: LibraryTableKind, name: string): Promise<void> => {
  const project = activeProject.value
  if (!project) return
  try {
    const path = await createProjectLibrary(kind, project.path, project.dir, name)
    await emitProjectChange(projectPath.value, fileChange('file-created', path), {
      kind: 'library-registered',
      scope: 'project',
      nickname: name
    })
  } catch (err) {
    alert(t('app.errors.library', { error: err instanceof Error ? err.message : String(err) }))
  }
}

/** Disk-backed IO for the rename pipeline (lib/project/renamePlan.ts). */
const diskRenameIo: RenameIo = {
  async readFile(path) {
    const res = await window.api.readFile(path)
    return res.success && res.content !== undefined ? res.content : null
  },
  writeFile: (path, content) => window.api.createFile(path, content),
  rename: (from, to) => window.api.renamePath(from, to)
}

/** Every `.kicad_sch` path in the loaded workspace tree — the reference scan set. */
const collectSchematicPaths = (nodes: FileItem[], out: string[] = []): string[] => {
  for (const node of nodes) {
    if (node.isDirectory) collectSchematicPaths(node.children ?? [], out)
    else if (node.name.toLowerCase().endsWith('.kicad_sch')) out.push(node.path)
  }
  return out
}

/** Open tabs (and the persisted session) follow a renamed file. */
const followRenameInTabs = (oldPath: string, newPath: string, newName: string): void => {
  const tab = openTabs.value.find((t) => t.path === oldPath)
  if (!tab) return
  renamePath(editorLayout, oldPath, newPath)
  tab.path = newPath
  tab.name = newName
}

/**
 * A renamed `.kicad_mod` carries its new name inside the file as well, since
 * KiCad reads a footprint's name from the file and the two disagreeing is a
 * file nobody can explain (`footprintTextRenamed`). Left alone when a tab holds
 * unsaved edits: rewriting the disk under an editor is the one thing §5.3
 * forbids, and the next save would drop it anyway.
 */
const followFootprintRename = async (path: string, fileName: string): Promise<void> => {
  if (!fileName.toLowerCase().endsWith('.kicad_mod')) return
  if (editorArea.value?.dirtyBufferPaths().includes(path)) return
  const read = await window.api.readFile(path)
  if (!read.success || typeof read.content !== 'string') return
  try {
    const renamed = footprintTextRenamed(read.content, fileName.replace(/\.kicad_mod$/i, ''))
    if (renamed === null) return
    const written = await window.api.createFile(path, renamed)
    if (written.success) editorArea.value?.reloadOpenFile(path, renamed)
  } catch (err) {
    // An unparsable footprint still renamed; its inner name is cosmetic beside
    // the file name KiCad actually reads.
    console.error(`Could not update the footprint name inside ${path}:`, err)
  }
}

const handleRenameFile = async (node: FileItem, newName: string): Promise<void> => {
  pendingRenamePath.value = null
  const target = renamedPath(node.path, newName)

  // Reference forwarding today only follows schematic sheet links (sheet.file).
  const candidates = node.name.toLowerCase().endsWith('.kicad_sch')
    ? collectSchematicPaths(files.value)
    : []
  const plan = await planRename(node.path, newName, candidates, diskRenameIo)

  // Common case: nothing points at this file — a plain one-gesture rename.
  if (plan.edits.length === 0) {
    const res = await window.api.renamePath(node.path, target)
    if (!res.success) {
      alert(t('app.errors.renameFile', { error: res.error }))
      return
    }
    await followFootprintRename(target, newName)
    followRenameInTabs(node.path, target, newName)
    await emitProjectChange(projectPath.value, fileRenamed(node.path, target))
    return
  }

  // Preview: informed consent replaces undo (§5.2). List the impacted files.
  const impacted = previewFiles(plan)
  const detail = impacted
    .map((f) => t('app.confirm.renameForwardFile', { name: f.fileName, count: f.count }, f.count))
    .join('\n')
  if (
    !confirm(
      t(
        'app.confirm.renameForward',
        { from: node.name, to: newName, count: impacted.length, files: detail },
        impacted.length
      )
    )
  ) {
    return
  }

  // §5.3: a referencing file open with unsaved edits is rewritten in its buffer,
  // never on disk behind the editor — that write would be lost on the next save.
  const editor = editorArea.value
  const dirtyOpen = new Set(editor?.dirtyBufferPaths() ?? [])
  const bufferSkips = [
    ...new Set(plan.edits.map((e) => e.sourceFile).filter((p) => dirtyOpen.has(p)))
  ]

  const result = await applyRename(plan, diskRenameIo, { skipDiskFiles: bufferSkips })
  if (!result.ok) {
    alert(t('app.errors.renameFile', { error: result.error }))
    // A rollback restores the pre-images, but the tree was read before any of
    // it — refresh directly rather than announcing a change that did not stick.
    await refreshDirectory()
    return
  }

  if (editor) {
    // Clean open referencing tabs: re-baseline to the new disk content so they
    // never save stale bytes over the rewrite.
    for (const [file, content] of result.written) {
      if (editor.bufferContent(file) !== null) editor.setBufferContent(file, content, false)
    }
    // Dirty open referencing tabs: splice against the live buffer, still dirty.
    for (const file of bufferSkips) {
      const current = editor.bufferContent(file)
      if (current === null) continue
      editor.setBufferContent(file, rewriteBufferText(file, current, node.path, newName), true)
    }
  }

  followRenameInTabs(node.path, target, newName)
  // One batch, not one per file: forwarding a rename rewrote every referencing
  // sheet, and subscribers re-derive once for the lot (§6.3 property 2).
  await emitProjectChange(
    projectPath.value,
    fileRenamed(node.path, target),
    ...[...result.written.keys()].map((file) => fileChange('file-changed', file))
  )
}

/**
 * Write one tab's content to its path. Answers rather than alerts, so the
 * agent's `project.save` can report the result; `handleSaveFile` is the UI
 * wrapper that turns a failure into the dialog a person expects.
 */
const writeSavedFile = async (
  path: string,
  content: string
): Promise<{ ok: true; path: string } | { ok: false; error: string }> => {
  try {
    const res = await window.api.createFile(path, content)
    if (!res.success) return { ok: false, error: res.error ?? 'write failed' }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  void emitProjectChange(projectPath.value, fileChange('file-changed', path))
  if (path.toLowerCase().endsWith('.kicad_sch')) void refreshNetclassAssignments()
  return { ok: true, path }
}

const handleSaveFile = async (path: string, content: string): Promise<void> => {
  const result = await writeSavedFile(path, content)
  if (!result.ok) {
    console.error(result.error)
    alert(t('app.errors.saveFile', { error: result.error }))
  }
}

// Opens a file into a tab. With `preview: true` (explorer single-click) the
// tab is a VS Code-style preview: it re-uses the current preview tab's slot
// instead of accumulating. Every other opener (double-click, dialogs, OS
// file-open, cross-window transfer) opens pinned.
/**
 * A real open, worth remembering. Preview opens (single click in the explorer)
 * are excluded — browsing a tree would otherwise flood the list with files the
 * user only glanced at — as are the virtual tabs, which have no file behind them.
 */
const isRecordableOpen = (path: string, preview?: boolean): boolean =>
  !preview && !path.includes('://')

const openFile = (node: { name: string; path: string }, options?: { preview?: boolean }): void => {
  if (projectPath.value && isRecordableOpen(node.path, options?.preview)) {
    void recordRecent('file', node.path, projectPath.value)
  }
  const existing = openTabs.value.find((t) => t.path === node.path)
  if (existing) {
    // Re-opening pinned (e.g. a double-click) promotes an existing preview.
    if (!options?.preview && existing.preview) existing.preview = false
    activeTabPath.value = node.path
    return
  }
  const tab: Tab = { name: node.name, path: node.path }
  // A design copy has one tab, whichever placement it was last opened from.
  const sameCopy = openTabs.value.findIndex((t) => sameDesignCopy(t.path, node.path))
  if (sameCopy !== -1) {
    openTabs.value.splice(sameCopy, 1, tab)
    activeTabPath.value = node.path
    return
  }
  if (options?.preview) {
    tab.preview = true
    // A preview tab is its group's: the one across the split stays put.
    const previewIndex = openTabs.value.findIndex(
      (t) => t.preview && groupIdOf(editorLayout, t.path) === editorLayout.focusedGroupId
    )
    if (previewIndex !== -1) {
      openTabs.value.splice(previewIndex, 1, tab)
      activeTabPath.value = node.path
      return
    }
  }
  openTabs.value.push(tab)
  activeTabPath.value = node.path
}

/**
 * A tab for a file a command just edited or created, without leaving the one
 * the user is on: a whole-design annotate rewrites sibling sheets, and each
 * needs a tab to hold its unsaved buffer; a child sheet or a generated symbol
 * library is something to find later. The user did not ask to look at any of
 * them, and may be mid-task on the tab they have — every file an agent opens
 * comes through here, and only `project.open` activates one.
 */
const openFileInBackground = (path: string): void => {
  if (openTabs.value.some((tab) => tab.path === path)) return
  openTabs.value.push({ name: path.split(/[\\/]/).pop() ?? path, path })
}

// Pinning keeps a preview tab around for good: tab double-click, or any edit.
const pinTab = (path: string): void => {
  const tab = openTabs.value.find((t) => t.path === path)
  if (tab?.preview) tab.preview = false
}

// Cross-sheet navigation: open (or activate) the sheet that owns a component
// and ask its editor to reveal the symbol. The nonce re-triggers the reveal
// even when the same symbol is requested twice.
const pendingFocus = ref<{
  path: string
  uuids: string[]
  at?: { x: number; y: number }
  /** The finding that asked, by key: the editor selects it in its own list. */
  finding?: string
  nonce: number
} | null>(null)

const openSymbol = (path: string, uuid: string): void => {
  const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
  openFile({ name, path })
  pendingFocus.value = { path, uuids: [uuid], nonce: (pendingFocus.value?.nonce ?? 0) + 1 }
}

/** A finding on another sheet or a board: open it, select what it names, show where it is. */
const revealInDocument = (
  path: string,
  uuids: string[],
  at?: { x: number; y: number },
  finding?: string
): void => {
  const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
  openFile({ name, path })
  pendingFocus.value = {
    path,
    uuids,
    ...(at ? { at } : {}),
    ...(finding ? { finding } : {}),
    nonce: (pendingFocus.value?.nonce ?? 0) + 1
  }
}

// ---- cross-select (lib/crossProbe.ts, split-view-workstream.md §6) ----------
// A part selected in a schematic is selected and revealed on the board in the
// other pane — or the other window — and the reverse. The answering pane is
// brought to the right tab but never handed the keyboard: the user is still
// working where they clicked.
const pendingBoardProbe = ref<{
  path: string
  symbolUuids: string[]
  references: string[]
  nonce: number
} | null>(null)

watch(projectPath, (root) => setCrossProbeRoot(root), { immediate: true })

const stopCrossProbe = onCrossProbe((probe, source) => {
  // A net probe is answered by the editors themselves, in place.
  if (probe.net !== undefined) return
  const first = probe.targets[0]
  // A schematic is answered by a board and the reverse; the Components tab, by both.
  const answering: Array<'schematic' | 'pcb'> =
    probe.origin === 'schematic'
      ? ['pcb']
      : probe.origin === 'board'
        ? ['schematic']
        : ['schematic', 'pcb']
  for (const wanted of answering) {
    const route = routeCrossProbe(
      editorLayout,
      openTabs.value,
      wanted,
      wanted === 'schematic' ? (first.sheetFile ?? null) : null,
      source.groupId
    )
    if (route) void answerCrossProbe(probe, route, wanted)
  }
})

const answerCrossProbe = async (
  probe: CrossProbe,
  route: CrossProbeRoute,
  wanted: 'schematic' | 'pcb'
): Promise<void> => {
  if (route.action === 'open') {
    // The window already showing that sheet answers instead (the probe reaches
    // it through main); opening it here too would be the file open twice.
    if (await window.api.tabHeldElsewhere(route.path)) return
    if (openTabs.value.some((tab) => tab.path === route.path)) return
    placeIn(editorLayout, route.path, route.groupId)
    openTabs.value.push({ name: route.path.split(/[\\/]/).pop() ?? route.path, path: route.path })
  } else if (route.action === 'move') {
    placeIn(editorLayout, route.path, route.groupId)
    editorGroups.sync()
  }
  showTab(editorLayout, route.path)
  if (wanted === 'pcb') {
    pendingBoardProbe.value = {
      path: route.path,
      symbolUuids: probe.targets.map((target) => target.symbolUuid),
      references: probe.targets.flatMap((target) => (target.reference ? [target.reference] : [])),
      nonce: (pendingBoardProbe.value?.nonce ?? 0) + 1
    }
  } else {
    // Every probed symbol, not just the first: the reveal unions their bounds
    // and, under `bringIntoView`, a scattered set simply zooms out far enough
    // to hold them all instead of picking one and hiding the rest.
    pendingFocus.value = {
      path: route.path,
      uuids: probe.targets.map((target) => target.symbolUuid),
      nonce: (pendingFocus.value?.nonce ?? 0) + 1
    }
  }
}
const stopRemoteCrossProbe = window.api.onCrossProbe(receiveCrossProbe)
onUnmounted(() => {
  stopCrossProbe()
  stopRemoteCrossProbe()
})

// Component viewer "Open" on a symbol: open its .kicad_sym library (a read-only
// viewer) and reveal the specific symbol. Keyed by name, not UUID — the sibling
// of openSymbol for the library editor rather than the schematic.
const pendingSymbolFocus = ref<{ path: string; symbol: string; nonce: number } | null>(null)

// A symbol leaf is the openable unit of a `.kicad_sym`, so it follows the same
// preview/pin rule as a file row: single click previews, double click pins.
const openLibrarySymbol = (path: string, symbol: string, options?: { preview?: boolean }): void => {
  const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
  openFile({ name, path }, options)
  // The tab shows it from here on, should its editor mount after the request.
  const tab = openTabs.value.find((t) => t.path === path)
  if (tab) tab.symbol = symbol
  pendingSymbolFocus.value = { path, symbol, nonce: (pendingSymbolFocus.value?.nonce ?? 0) + 1 }
}

// Symbol add/rename/delete from the File Explorer / Project pane: open the
// .kicad_sym editor and let it run the op through its command layer (undo/save).
const pendingSymbolOp = ref<{
  path: string
  op: 'add' | 'rename' | 'delete'
  symbol?: string
  newName?: string
  nonce: number
} | null>(null)

const requestSymbolOp = (
  path: string,
  op: 'add' | 'rename' | 'delete',
  symbol?: string,
  newName?: string
): void => {
  const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
  openFile({ name, path })
  pendingSymbolOp.value = {
    path,
    op,
    symbol,
    newName,
    nonce: (pendingSymbolOp.value?.nonce ?? 0) + 1
  }
}
const newSymbol = (path: string): void => requestSymbolOp(path, 'add')
const renameLibrarySymbol = (path: string, symbol: string, newName: string): void =>
  requestSymbolOp(path, 'rename', symbol, newName)
const deleteLibrarySymbol = (path: string, symbol: string): void =>
  requestSymbolOp(path, 'delete', symbol)

// The symbol editor reports which symbol it is showing; put it in the tab title.
const setActiveSymbol = (path: string, symbol: string | null): void => {
  const tab = openTabs.value.find((t) => t.path === path)
  if (tab) tab.symbol = symbol ?? undefined
}

/**
 * Symbols held by each open `.kicad_sym` buffer, reported by its editor. The
 * left bar's symbol lists read disk, where an add / rename / delete does not
 * land until a save — and the open buffer is its file's authoritative version
 * (docs/projects.md §8.3), like `readOpenBuffer` for the hierarchy.
 */
const openLibrarySymbols = ref<Record<string, string[]>>({})

const setLibrarySymbolNames = (path: string, names: string[]): void => {
  if (path) openLibrarySymbols.value = { ...openLibrarySymbols.value, [path]: names }
}

// A closed tab takes its buffer with it, unsaved renames included, so the lists
// fall back to disk. Pruned here to cover every way a tab can close.
watch(
  () => openTabs.value.map((tab) => tab.path).join('\n'),
  () => {
    const open = new Set(openTabs.value.map((tab) => tab.path))
    const kept = Object.entries(openLibrarySymbols.value).filter(([path]) => open.has(path))
    if (kept.length !== Object.keys(openLibrarySymbols.value).length) {
      openLibrarySymbols.value = Object.fromEntries(kept)
    }
  }
)

/**
 * The native Save / Don't Save / Cancel box for tabs about to be discarded.
 * Copy is built here rather than in main because that is where `t()` lives; the
 * one- and many-file wordings differ in more than a count, so they are separate
 * messages rather than one plural.
 */
const promptUnsaved = (tabs: readonly Tab[]): Promise<UnsavedChoice> => {
  const many = tabs.length > 1
  return window.api.confirmUnsaved({
    message: many
      ? t('app.unsaved.messageMany', { count: tabs.length })
      : t('app.unsaved.message', { name: tabs[0].name }),
    detail: many
      ? `${tabs.map((tab) => `• ${tab.name}`).join('\n')}\n\n${t('app.unsaved.detail')}`
      : t('app.unsaved.detail'),
    save: many ? t('app.unsaved.saveAll') : t('common.save'),
    dontSave: t('app.unsaved.dontSave'),
    cancel: t('common.cancel')
  })
}

/**
 * Close a tab the user asked to close (the × or Ctrl+W), prompting first if it
 * would drop unsaved edits. `closeTab` stays the unconditional path for closes
 * the user has no say in — the file was deleted, or the tab moved windows.
 */
const requestCloseTab = async (path: string): Promise<void> => {
  const tab = openTabs.value.find((t) => t.path === path)
  // A terminal has no unsaved edits, it has a live process — so the question is
  // "is something running?" rather than "is anything unwritten?", and only a
  // foreground process is worth asking about (a shell at its prompt is not).
  if (tab && isTerminalTab(path)) {
    const state = terminalStates.value[path]
    if (terminalNeedsCloseConfirm(state) && !(await confirmKillTerminals([state?.process ?? ''])))
      return
    // Closing the tab is what ends the session; every other close path
    // (`closeTab`) is a tab moving windows, and must leave the shell alive.
    void window.api.disposeTerminal(terminalSessionId(path))
    closeTab(path)
    return
  }
  if (tab && editorArea.value?.hasUnsavedEdits(path)) {
    const choice = await promptUnsaved([tab])
    if (choice === 'cancel') return
    if (choice === 'save') await editorArea.value?.savePath(path)
  }
  closeTab(path)
}

/**
 * Whether this window may close: true once nothing is unsaved, or the user has
 * said what to do about it. Main vetoes every close and waits on this, since
 * dirty state lives only here.
 */
const resolveUnsavedBeforeClose = async (): Promise<boolean> => {
  // Closing the window kills its terminals (main disposes what this window still
  // owns), so the running ones get the same question a single tab close asks —
  // once for the window rather than once per tab.
  const running = terminalTabs().filter((tab) =>
    terminalNeedsCloseConfirm(terminalStates.value[tab.path])
  )
  if (running.length > 0) {
    const names = running.map((tab) => terminalStates.value[tab.path]?.process ?? '')
    if (!(await confirmKillTerminals(names))) return false
  }

  const editor = editorArea.value
  const unsaved = new Set(editor?.unsavedPaths() ?? [])
  if (unsaved.size === 0) return true
  // Tab-strip order, so the listed files read in the order they are shown.
  const tabs = openTabs.value.filter((t) => unsaved.has(t.path))
  if (tabs.length === 0) return true
  const choice = await promptUnsaved(tabs)
  if (choice === 'cancel') return false
  if (choice === 'save') {
    // Saving is fire-and-forget from here (`save-file` is an emit), so what
    // keeps the writes ahead of the window going away is main-side ordering:
    // `fs:create-file` writes synchronously, and it is already queued when the
    // `window:close-confirmed` that follows this arrives. Making that handler
    // async would open a real data-loss race on quit.
    for (const tab of tabs) await editor?.savePath(tab.path)
  }
  return true
}

const closeTab = (path: string): void => {
  const index = openTabs.value.findIndex((t) => t.path === path)
  if (index === -1) return

  // The layout picks the closed tab's neighbor within its own group, and
  // closes a group left empty (lib/editorGroups.ts `reconcile`).
  openTabs.value.splice(index, 1)
}

const selectTab = (path: string): void => {
  activeTabPath.value = path
}

// VS Code tab cycling (Ctrl+Tab / Ctrl+PageDown and their reverses). Strip
// order rather than VS Code's most-recently-used order — MRU needs its
// hold-Ctrl picker UI to be predictable, which we don't have yet.
const cycleTab = (delta: number): void => {
  const tabs = openTabs.value.filter(
    (tab) => groupIdOf(editorLayout, tab.path) === editorLayout.focusedGroupId
  )
  if (tabs.length < 2) return
  const index = tabs.findIndex((t) => t.path === activeTabPath.value)
  activeTabPath.value = tabs[(index + delta + tabs.length) % tabs.length].path
}

/** One group's strip, reordered: its tabs take their new order in the slots
 *  they already held in the window's list. */
const reorderTabs = (newTabs: Tab[]): void => {
  const moved = new Set(newTabs.map((tab) => tab.path))
  let next = 0
  openTabs.value = openTabs.value.map((tab) => (moved.has(tab.path) ? newTabs[next++] : tab))
}

/**
 * Hand a group the keyboard. DOM focus follows: a terminal takes it so typing
 * lands in the shell, and anything else gives it up so the editor's
 * window-level shortcuts hear the keys.
 */
const focusEditorGroup = (groupId: string, moveDomFocus = false): void => {
  focusGroup(editorLayout, groupId)
  if (!moveDomFocus) return
  ;(document.activeElement as HTMLElement | null)?.blur?.()
  groupFocusSignal.value = { groupId, nonce: Date.now() }
}
/** Bumped when the keyboard moves groups by hotkey, for a terminal to take focus. */
const groupFocusSignal = ref<{ groupId: string; nonce: number } | null>(null)

const splitTab = (path: string): void => {
  sendToOtherGroup(
    editorLayout,
    path,
    openTabs.value.map((tab) => tab.path)
  )
  editorGroups.sync()
}

/** A tab dropped on the other group's strip, before `beforePath` or at its end. */
const moveTabToGroup = (path: string, groupId: string, beforePath: string | null): void => {
  const tabs = [...openTabs.value]
  const from = tabs.findIndex((tab) => tab.path === path)
  if (from === -1) return
  const [tab] = tabs.splice(from, 1)
  const before = beforePath ? tabs.findIndex((candidate) => candidate.path === beforePath) : -1
  tabs.splice(before === -1 ? tabs.length : before, 0, tab)
  moveTab(editorLayout, path, groupId)
  openTabs.value = tabs
  editorGroups.sync()
}

const focusOtherEditorGroup = (): void => {
  const other = otherGroup(editorLayout, editorLayout.focusedGroupId)
  if (other) focusEditorGroup(other.id, true)
}

const toggleShortcutsModal = (): void => {
  showShortcutsModal.value = !showShortcutsModal.value
}

/** Share app feedback; `feedbackScreenshot` is its thumbnail, or null where capture failed. */
const showFeedback = ref(false)
const feedbackScreenshot = ref<string | null>(null)

// The window is captured before the dialog draws, so the screenshot shows the
// app rather than the dialog; two frames let a closing menu leave the screen.
const openFeedback = async (): Promise<void> => {
  if (showFeedback.value) return
  await nextTick()
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  feedbackScreenshot.value = await window.api.captureFeedbackScreenshot().catch(() => null)
  showFeedback.value = true
}

/** File ▸ New ▸ <kind> — creates into the project root and names it in place. */
const handleTitleBarNewFile = (kind: string): void => {
  if (!projectPath.value) return
  activeSidebarTab.value = 'explorer'
  void handleCreateTypedFile(kind as NewFileKind, projectPath.value)
}

// Quick Open lands on a preview tab (VS Code behavior): browsing files
// doesn't accumulate tabs; an edit or tab double-click pins it.
const handleQuickOpenFile = (node: { name: string; path: string }): void => {
  showQuickOpen.value = false
  openFile(node, { preview: true })
}

// A Save As... already wrote the file; surface it in the tree and as a tab.
const handleSavedAs = async (node: { name: string; path: string }): Promise<void> => {
  await emitProjectChange(projectPath.value, fileChange('file-created', node.path))
  openFile(node)
}

// ---------------------------------------------------------------------------
// The MCP design bridge
//
// Main asks; this window answers. It lands here rather than in EditorArea
// because answering may mean *opening a tab* first — behind the active one,
// never in its place — and tabs are App's.

/**
 * The agent's door to a sheet, without moving the user. One session per open
 * document serves it (`EditorArea.sheetAgent`), in front or behind, so what an
 * agent edits is the document the editor draws. A sheet no tab holds opens
 * behind the active one first — the tab store is the only place an unsaved
 * edit can live, and its dirty marker is what makes the edit visible. Nothing
 * here activates a tab or brings the window forward: bringing a sheet to the
 * front is what `project.open` is for, so it happens on purpose or not at all.
 */
const sheetAgentFor = async (path: string): Promise<SchematicAgentApi | null> => {
  if (!openTabs.value.some((tab) => tab.path === path)) openFileInBackground(path)
  await nextTick()
  return (await editorArea.value?.sheetAgent(path)) ?? null
}

// The symbol editor's grid, which the library door's symbol checks share with its pill.
const symbolEditorGrid = useGridSettings('symbol', SYMBOL_GRID_DEFAULTS)

/** References like a miss, for its refusal: the same letters first, then the rest. */
const nearReferences = (miss: string, references: string[]): string[] => {
  const prefix = miss.replace(/[0-9]+$/, '').toUpperCase()
  const sorted = [...new Set(references)].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true })
  )
  const alike = sorted.filter((reference) => reference.toUpperCase().startsWith(prefix))
  return (alike.length ? alike : sorted).slice(0, 8)
}

type PlacedRefusal = { ok: false; error: string; detail: string; candidates?: string[] }

/**
 * A placed footprint's board copy, as Edit footprint… opens it
 * (`lib/board/footprintCopy.ts`): its design-copy path, the board, its text in
 * the library frame and its lib id. The agent doors read and write a copy by
 * that path, so the footprint door needs nothing of its own for a board.
 */
const placedFootprintCopy = async (
  reference: string,
  boardName: string
): Promise<
  { ok: true; path: string; board: string; text: string; libId: string } | PlacedRefusal
> => {
  const board = resolveAgentFile(boardName, { openTabs: fileTabs.value, files: files.value })
  if (!board || documentKindOf(board) !== 'board') {
    return {
      ok: false,
      error: 'board-not-found',
      detail: `No board called ${boardName} is in this project.`,
      candidates: projectFilesOfKind('board')
    }
  }
  const parsed = (await editorArea.value?.boardSession(board))?.board()
  if (!parsed) return { ok: false, error: 'board-unreadable', detail: board }
  const placed = parsed.footprints.find((footprint) => footprint.reference === reference)
  const uuid = placed ? placedFootprintUuid(placed) : ''
  const text = placed && uuid ? projectFootprintCopy(parsed, uuid) : null
  if (!placed || text === null) {
    return {
      ok: false,
      error: 'reference-not-found',
      detail: `No footprint on ${board} has the reference ${reference}.`,
      candidates: nearReferences(
        reference,
        parsed.footprints.flatMap((footprint) => (footprint.reference ? [footprint.reference] : []))
      )
    }
  }
  return {
    ok: true,
    path: designCopyPath('footprint', board, uuid),
    board,
    text,
    libId: placed.libId
  }
}

/** A placed symbol's definition as its sheet embeds it (`lib_symbols`, `lib/designCopy.ts`). */
const placedSymbolDefinition = async (
  reference: string,
  sheet: string | undefined
): Promise<
  | {
      ok: true
      file: string
      document: KicadSchematic
      id: string
      placement: { uuid: string; sheetPath: string } | undefined
    }
  | PlacedRefusal
> => {
  const path = resolveAgentSheet(sheet, {
    openTabs: fileTabs.value,
    files: files.value,
    rootPath: rootSchematicPath()
  })
  if (!path) {
    return {
      ok: false,
      error: sheet ? 'sheet-not-found' : 'no-schematic',
      detail: sheet ?? 'This project has no root schematic and no schematic is open.'
    }
  }
  const session = await editorArea.value?.sheetSession(path)
  const document = session?.document()
  if (!session || !document) return { ok: false, error: 'sheet-not-found', detail: path }
  const references: string[] = []
  for (const sheetPath of session.instancePaths()) {
    for (const symbol of document.symbols) {
      const named = referenceForSheetPath(symbol, sheetPath)
      if (named === reference)
        return {
          ok: true,
          file: path,
          document,
          id: definitionIdOf(symbol),
          placement: symbol.uuid ? { uuid: symbol.uuid, sheetPath } : undefined
        }
      if (named) references.push(named)
    }
  }
  return {
    ok: false,
    error: 'reference-not-found',
    detail: `No symbol on ${path} has the reference ${reference}.`,
    candidates: nearReferences(reference, references)
  }
}

/** Index ids near a library id that did not resolve: by its name, else its
 *  name's first word, else its library — so a miss always names real ids. */
const nearIndexIds = (libId: string, type: 'symbol' | 'footprint'): string[] => {
  const [nickname, name] = libId.includes(':')
    ? [libId.slice(0, libId.indexOf(':')), libId.slice(libId.indexOf(':') + 1)]
    : ['', libId]
  for (const query of [name, name.split(/[-_ ]/)[0], nickname]) {
    if (!query) continue
    const ids = searchIndex(query, { types: [type], limit: 5 }).map((record) => record.id)
    if (ids.length) return ids
  }
  return []
}

// The library door (`lib/symbol/libraryAgent.ts`): symbol create, delete and
// render, served by this window with no sheet. The context is what the window
// has and the handlers should not: the project, the dirty tabs, the library
// tiers of a directory, the off-screen engine, the change bus and the tabs.
const libraryAgent = createLibraryAgent({
  projectPath: () => projectPath.value,
  projectFile: () => activeProject.value?.path ?? null,
  hasUnsavedEdits: (path) => editorArea.value?.hasUnsavedEdits(path) ?? false,
  reloadOpenFile: (path, text) => editorArea.value?.reloadOpenFile(path, text),
  refreshIndex: () => reloadProjectIndex(),
  editOpenLibrary: (path, label, mutate) =>
    editorArea.value?.editOpenLibrary(path, label, mutate) ?? false,
  // Sources are per directory and find the project file beside the path
  // given; with no project, the global and standard tiers are read alone.
  sources: (dir) => symbolSourcesFor(dir ? `${dir}/sym-lib-table` : ''),
  capture: (document, box, maxPixels) => captureSchematicDocument(document, box, maxPixels),
  captureFootprint: (footprint, maxPixels) => captureFootprint(footprint, maxPixels),
  // Footprints have no per-directory tiers: the index already unions the
  // system, global and project records, and a record carries its file.
  findFootprint: async (libId) => {
    if (!indexLoaded()) await loadIndex().catch(() => {})
    return findFootprint(libId)
  },
  placedFootprint: async (reference, board) => {
    const copy = await placedFootprintCopy(reference, board)
    return copy.ok ? { ok: true, file: copy.board, text: copy.text, libId: copy.libId } : copy
  },
  placedSymbol: placedSymbolDefinition,
  footprintCandidates: async (libId) => nearIndexIds(libId, 'footprint'),
  symbolCandidates: async (libId) => nearIndexIds(libId, 'symbol'),
  libraryRevision: async (path) =>
    (await editorArea.value?.librarySession(path))?.revision() ?? null,
  // An open tab's buffer is the footprint as it is now; the disk is behind it.
  readFile: async (path) => {
    const buffered = readOpenBuffer(path)
    if (buffered !== null) return buffered
    const result = await window.api.readFile(path)
    return result.success && typeof result.content === 'string' ? result.content : null
  },
  symbolGrid: () =>
    mmToNm(spacingToMm(symbolEditorGrid.value.spacing, symbolEditorGrid.value.unit)),
  modelFacts: (input) => modelFacts({ ...input, projectPath: projectPath.value }),
  captureModel: async (resolved, maxPixels) => {
    // Decoded once: the group is handed to the capture engine, which disposes
    // what it draws, so it is measured before it goes (`modelFacts.ts`).
    const content = await decodeModel(resolved)
    if (!content) return null
    const bounds = rawBounds(content)
    const stats = meshStats(content)
    return { capture: captureModelViews(content, maxPixels), bounds, ...stats }
  },
  captureFootprintWithModel: (footprint, footprintFile, maxPixels) =>
    captureFootprintModel(footprint, footprintFile, projectPath.value, maxPixels),
  copyFootprint: copyProjectFootprint,
  copySymbol: copyProjectSymbol,
  createSymbol: createProjectSymbol,
  deleteSymbol: deleteProjectSymbol,
  createFootprint: createProjectFootprint,
  deleteFootprint: deleteProjectFootprint,
  libraryChanged: (path, created) =>
    emitProjectChange(
      projectPath.value,
      fileChange(created ? 'file-created' : 'file-changed', path)
    ),
  openBehind: openFileInBackground
})

// The symbol item door (`lib/symbol/symbolItemsAgent.ts`): items on one symbol
// definition. A library symbol reads from any tier and writes only the
// project's own library; a placed reference reads and writes its sheet's copy
// through the design-copy session Edit symbol… opens.
const symbolItemsAgent = createSymbolItemsAgent({
  resolve: async (target) => {
    if (!target.symbol.includes(':')) {
      const placed = await placedSymbolDefinition(target.symbol, target.sheet)
      if (!placed.ok) return placed
      return {
        ok: true,
        name: placed.id,
        scope: 'sheet',
        writable: true,
        file: designCopyPath('symbol', placed.file, placed.id, placed.placement),
        sheet: placed.file
      }
    }
    const libId = target.symbol
    const sources = symbolSourcesFor(projectPath.value ? `${projectPath.value}/sym-lib-table` : '')
    await sources.ready()
    const find = (): LibrarySymbol | undefined =>
      [...sources.tableSymbols.value, ...sources.standardSymbols.value].find(
        (entry) => entry.libId === libId
      )
    let entry = find()
    if (!entry) {
      await sources.ensureStandardLibrary(libId)
      entry = find()
    }
    if (!entry) {
      const candidates = nearIndexIds(libId, 'symbol')
      return { ok: false, error: 'unknown-symbol', detail: libId, candidates }
    }
    const [nickname, name] = [
      libId.slice(0, libId.indexOf(':')),
      libId.slice(libId.indexOf(':') + 1)
    ]
    if (entry.tier === 'project') {
      const library = resolveProjectLibrary(
        { projectPath: projectPath.value, projectFile: activeProject.value?.path ?? null },
        'symbol',
        nickname
      )
      if (library.ok) {
        const text = readOpenBuffer(library.path) ?? (await readDiskText(library.path))
        if (text && parseKicadSymbolLibrary(text).symbols.has(name))
          return { ok: true, name, scope: 'project', writable: true, file: library.path }
      }
    }
    // A read-only tier is read from the parsed tiers: the definition alone, by its id.
    const node = entry.sheet.libSymbols.get(libId)?._node
    if (!node) {
      const candidates = nearIndexIds(libId, 'symbol')
      return { ok: false, error: 'unknown-symbol', detail: libId, candidates }
    }
    return {
      ok: true,
      name: libId,
      scope: entry.tier,
      writable: false,
      text: `(kicad_symbol_lib (version 20241209) (generator "goatcad")\n  ${serializeSExpr(node)}\n)\n`
    }
  },
  read: async (path) => {
    if (isDesignCopyPath(path)) return (await editorArea.value?.designCopyText(path)) ?? null
    return readOpenBuffer(path) ?? (await readDiskText(path))
  },
  session: async (path) => {
    if (!isDesignCopyPath(path) && !openTabs.value.some((tab) => tab.path === path))
      openFileInBackground(path)
    await nextTick()
    return (await editorArea.value?.librarySession(path)) ?? null
  },
  label: (key, count) => (count === undefined ? t(key) : t(key, count)),
  checkGrid: async () => {
    const projectFile = activeProject.value?.path
    const text = projectFile ? await readDiskText(projectFile) : null
    return (
      (text && extractConnectionGrid(text)) ||
      mmToNm(spacingToMm(symbolEditorGrid.value.spacing, symbolEditorGrid.value.unit))
    )
  }
})

// The footprint door (`lib/footprint/footprintAgent.ts`): items and checks on
// one footprint. Reads take any tier through the index; writes land through
// the footprint editor's session, the tab opened behind the active one.
const footprintAgent = createFootprintAgent({
  resolve: async (target) => {
    if (target.board) {
      const copy = await placedFootprintCopy(target.footprint, target.board)
      return copy.ok ? { ok: true, file: copy.path, scope: 'board', board: copy.board } : copy
    }
    const libId = target.footprint
    if (!indexLoaded()) await loadIndex().catch(() => {})
    const record = findFootprint(libId)
    if (record) return { ok: true, file: record.file, scope: record.scope }
    const candidates = nearIndexIds(libId, 'footprint')
    return {
      ok: false,
      error: 'unknown-footprint',
      detail: libId,
      ...(candidates.length ? { candidates } : {})
    }
  },
  read: async (path) => {
    if (isDesignCopyPath(path)) return (await editorArea.value?.designCopyText(path)) ?? null
    const buffered = readOpenBuffer(path)
    if (buffered !== null) return buffered
    const result = await window.api.readFile(path)
    return result.success && typeof result.content === 'string' ? result.content : null
  },
  session: async (path) => {
    if (!isDesignCopyPath(path) && !openTabs.value.some((tab) => tab.path === path))
      openFileInBackground(path)
    await nextTick()
    return (await editorArea.value?.footprintSession(path)) ?? null
  },
  label: (key, count) => (count === undefined ? t(key) : t(key, count)),
  modelFacts: (input) => modelFacts({ ...input, projectPath: projectPath.value })
})

/** Every file of a kind in the project tree, absolute. */
const projectFilesOfKind = (kind: 'board' | 'schematic'): string[] => {
  const out: string[] = []
  const walk = (nodes: FileItem[]): void => {
    for (const node of nodes) {
      if (node.children) walk(node.children)
      else if (!node.isDirectory && documentKindOf(node.path) === kind) out.push(node.path)
    }
  }
  walk(files.value)
  return out
}

/**
 * The root schematic a board is synced from: the sheet named like the
 * project (`psu.kicad_pro` ↔ `psu.kicad_sch`, the only association KiCad has),
 * else the project's one schematic, else null.
 */
const rootSchematicPath = (): string | null => {
  const schematics = projectFilesOfKind('schematic')
  const project = activeProject.value
  if (project) {
    const wanted = `${project.name.toLowerCase()}.kicad_sch`
    const named = schematics.find(
      (path) => (path.split(/[\\/]/).pop() ?? '').toLowerCase() === wanted
    )
    if (named) return named
  }
  return schematics.length === 1 ? schematics[0] : null
}

/** A file's text from disk, or null. */
const readDiskText = async (path: string): Promise<string | null> => {
  const result = await window.api.readFile(path)
  return result.success && typeof result.content === 'string' ? result.content : null
}

/**
 * The schematic's net class assignments into the project file
 * (`netclass_assignments`), rebuilt from its directive flags and label fields as
 * KiCad's connection graph does, so the board resolves the classes the
 * schematic names. Run when a sheet is saved and before the board is updated.
 */
const refreshNetclassAssignments = async (): Promise<void> => {
  const root = rootSchematicPath()
  const agent = root ? await sheetAgentFor(root) : null
  const design = agent ? await agent.agentDesign() : null
  if (!root || !design) return
  const file = await findProjectFile(root)
  const text = file ? await readDiskText(file) : null
  if (!file || text === null) return
  const found = netclassAssignments(
    design.inputs,
    design.connectivity,
    extractTextVariables(text) ?? {}
  )
  const next = patchNetclassAssignments(text, found)
  if (next !== null && next !== text) await writeProjectFile(file, next)
}

/** Write the project file and announce it, as Board and Schematic Setup do. */
const writeProjectFile = async (path: string, content: string): Promise<boolean> => {
  const written = await window.api.createFile(path, content)
  if (!written.success) return false
  void emitProjectChange(null, fileChange('file-changed', path))
  return true
}

// A routing session starts from the person's router preferences and grid,
// and never writes them (`lib/board/routeAgent.ts`).
const agentRouterPrefs = pcbRouterState()
const agentPcbGrid = useGridSettings('pcb', PCB_GRID_DEFAULTS)

/** Sheet mm round what a write changed, in its viewport's frame: a grid step, so the neighbors show. */
const SHEET_WRITE_FRAME_MARGIN_MM = 2.54

// The agents' viewports (`lib/agentViewports.ts`): labeled boxes on the
// canvases, one per id an agent holds, on boards and sheets. Opening one on a
// document no tab holds opens it behind; nothing here moves the camera.
const agentViewports = createAgentViewports({
  isOpen: (path) => openTabs.value.some((tab) => tab.path === path),
  resolve: (name) => resolveAgentFile(name, { openTabs: fileTabs.value, files: files.value }),
  candidates: (name) => fileCandidates(files.value, name),
  open: async (path) => {
    openFileInBackground(path)
    await nextTick()
  },
  show: showAgentViewports
})
// The canvas's ×, or Esc on a box's label: the viewport closes, and routing in it ends.
onAgentViewportClose((id) => agentViewports.closeByPerson(id))
// A closed tab takes its viewports with it now, not at the next sweep.
watch(
  () => openTabs.value.map((tab) => tab.path).join('\n'),
  () => agentViewports.sweep()
)

// The board door (`lib/board/boardAgent.ts`): describe and sync, served over
// the board's tab buffer or its disk copy, with the schematic side read
// through the root sheet's agent. Nothing here activates a tab.
const boardAgent = createBoardAgent({
  boardFiles: () => projectFilesOfKind('board'),
  resolveBoard: (name) => {
    const resolved = resolveAgentFile(name, { openTabs: fileTabs.value, files: files.value })
    return resolved && documentKindOf(resolved) === 'board' ? resolved : null
  },
  boardText: async (path) => {
    const editor = editorArea.value
    if (editor) {
      // The mounted PCB editor serializes lazily; contentToSave flushes it.
      const edited = await editor.contentToSave(path)
      if (edited !== null) return edited
      const buffered = editor.bufferContent(path)
      if (buffered !== null) return buffered
    }
    const result = await window.api.readFile(path)
    return result.success && typeof result.content === 'string' ? result.content : null
  },
  commitBoard: (path, content, loaded) =>
    editorArea.value?.landAgentEdits([{ path, content, loaded }]),
  design: async () => {
    const root = rootSchematicPath()
    if (!root) return null
    const agent = await sheetAgentFor(root)
    return agent ? await agent.agentDesign() : null
  },
  schematicNetlist: async () => (await editorArea.value?.schematicNetlist()) ?? null,
  loadFootprint: loadLibraryFootprint,
  hold: (path) => {
    const boardDocument = documentStore.get(path)
    boardDocument?.touch('agent')
    return boardDocument?.pin('agent') ?? (() => {})
  },
  openSession: (path) => editorArea.value?.openBoardSession(path) ?? null,
  session: async (path) => {
    if (!openTabs.value.some((tab) => tab.path === path)) openFileInBackground(path)
    await nextTick()
    return (await editorArea.value?.boardSession(path)) ?? null
  },
  label: (key, values) =>
    values === undefined ? t(key) : typeof values === 'number' ? t(key, values) : t(key, values),
  capture: async (board, request) => captureBoardDocument(board, request),
  capture3D: (board, path, request) => captureBoard3D(board, path, dirnameOf(path), request),
  designSettings: async (path) => {
    const project = await findProjectFile(path)
    return project ? readProjectDesignSettings(project) : null
  },
  boardLibraries: (board) => loadBoardLibraries(boardLibraryIo(activeProject.value?.dir), board),
  projectFile: (path) => findProjectFile(path),
  readText: readDiskText,
  writeProject: writeProjectFile,
  readOnly: () => false,
  routerPrefs: () => JSON.parse(JSON.stringify(agentRouterPrefs.value)) as PcbRouterState,
  autoTrackWidth: autoTrackWidthFor,
  gridSpacing: () => spacingToMm(agentPcbGrid.value.spacing, agentPcbGrid.value.unit),
  routeScene: () => new BoardWorkScene(),
  viewports: agentViewports
})

// The schematic a board's checks hold it to (lib/board/syncDrift.ts): the
// root sheet's live design as a netlist, for DRC's schematic parity and the
// drift on the board's Update from schematic. Read without a tab: a passive
// check must not open one.
provide(SCHEMATIC_SOURCE, {
  read: async () => {
    const root = rootSchematicPath()
    const agent = root ? await editorArea.value?.sheetAgent(root) : null
    const design = agent ? await agent.agentDesign() : null
    if (!design) return null
    const references = unannotatedReferences(design)
    return references.length
      ? { state: 'unannotated', references }
      : { state: 'ready', netlist: schematicNetlistOf(design) }
  },
  // Only a sheet whose content moved: the store also notifies on attach,
  // flush and session changes, each of which would re-run a whole check.
  onChange: (listener) => {
    const seen = new WeakMap<object, number>()
    return documentStore.subscribe((document) => {
      if (document.kind !== 'schematic' || seen.get(document) === document.revision()) return
      seen.set(document, document.revision())
      listener()
    })
  }
})

// The fab export door (`lib/fabExportAgent.ts`): the writers over the board's
// saved file, refused while its tab holds unsaved edits or stale zone fills.
const fabExportAgent = createFabExportAgent({
  boardFiles: () => projectFilesOfKind('board'),
  resolveBoard: (name) => {
    const resolved = resolveAgentFile(name, { openTabs: fileTabs.value, files: files.value })
    return resolved && documentKindOf(resolved) === 'board' ? resolved : null
  },
  unsaved: (path) => documentStore.get(path)?.isDirty() ?? false,
  staleZones: (path) => editorArea.value?.openBoardSession(path)?.staleZones() ?? new Set(),
  readText: readDiskText,
  designSettings: async (path) => {
    const project = await findProjectFile(path)
    return project ? readProjectDesignSettings(project) : null
  },
  boardLibraries: (board) => loadBoardLibraries(boardLibraryIo(activeProject.value?.dir), board),
  schematicNetlist: async () => (await editorArea.value?.schematicNetlist()) ?? null,
  write: (payload) => window.api.exportFabPackage(payload),
  listDir: async (path) => {
    try {
      return await window.api.listDir(path)
    } catch {
      return []
    }
  },
  captureGerbers: async (request) => captureGerberSet(request)
})

// The Schematic Setup door (`lib/schematic/schematicSetupAgent.ts`): the ERC's
// severities and exclusions, over the root sheet's session.
const schematicSetupAgent = createSchematicSetupAgent({
  projectFile: () => activeProject.value?.path ?? null,
  readText: readDiskText,
  writeProject: writeProjectFile,
  rootSheet: async () => {
    const root = rootSchematicPath()
    if (!root) return null
    if (!openTabs.value.some((tab) => tab.path === root)) openFileInBackground(root)
    await nextTick()
    return (await editorArea.value?.sheetSession(root)) ?? null
  }
})

// Update PCB from Schematic (File menu, F8, a board's Properties panel): the agent's board.sync behind a
// preview, applied through the same door so an open board takes it as one undo step.
const updatePcbOpen = ref(false)
const rootSchematic = computed(() => rootSchematicPath())
const hasRootSchematic = computed(() => rootSchematic.value !== null)

/**
 * The board File's design pages (Board Setup, Fabrication Outputs) are for: the
 * one in front — its own tab, its setup or its manufacture tab — else none, and
 * the menu leaves them out.
 */
const menuBoardPath = (): string | null => {
  const active = activeTabPath.value
  if (!active) return null
  if (isBoardSetupTab(active)) return boardSetupBoardPath(active)
  if (isManufactureTab(active)) return manufactureBoardPath(active)
  return documentKindOf(active) === 'board' ? active : null
}
const hasMenuBoard = computed(() => menuBoardPath() !== null)

/**
 * The design root the schematic File pages (Schematic Setup, Components) are
 * for, while a sheet, its setup or its components tab is in front: the
 * project's root schematic for a sheet, or the sheet itself where there is none.
 */
const menuSchematicRoot = (): string | null => {
  const active = activeTabPath.value
  if (!active) return null
  if (isSchematicSetupTab(active)) return schematicSetupRootPath(active)
  if (isComponentsTableTab(active)) return componentsRootPath(active)
  if (documentKindOf(active) !== 'schematic') return null
  return rootSchematicPath() ?? active
}
const hasMenuSchematic = computed(() => menuSchematicRoot() !== null)

/** File ▸ a design page, for the design the menu names. */
const openDesignPage = (
  page: 'board-setup' | 'manufacture' | 'schematic-setup' | 'components'
): void => {
  if (page === 'board-setup' || page === 'manufacture') {
    const board = menuBoardPath()
    if (!board) return
    if (page === 'board-setup') openBoardSetupTab(board)
    else openManufactureTab(board)
    return
  }
  const root = menuSchematicRoot()
  if (!root) return
  if (page === 'schematic-setup') openSchematicSetupTab(root)
  else openComponentsTab(root)
}
/** The board the dialog opens on: the one asked for, else the board in front, else the first. */
const updatePcbBoard = ref<string | null>(null)
const openUpdatePcb = (board?: string): void => {
  if (!hasRootSchematic.value) return
  updatePcbBoard.value = board ?? menuBoardPath()
  updatePcbOpen.value = true
}
const applyBoardUpdate = async (
  board: string,
  options: UpdatePcbOptions
): Promise<BoardAgentError | null> => {
  await refreshNetclassAssignments()
  const answer = await boardAgent.dispatch({ kind: 'sync-board', board, ...options, dryRun: false })
  const failure = answer as Partial<BoardAgentError> | null
  return failure && typeof failure.error === 'string' ? (failure as BoardAgentError) : null
}
const onBoardUpdated = (board: string): void => {
  updatePcbOpen.value = false
  openFile({ name: board.split(/[\\/]/).pop() ?? board, path: board })
}

// File ▸ Export ▸ Netlist: the root sheet's design, live edits included, as KiCad's `.net`.
const exportNetlist = async (): Promise<void> => {
  const root = rootSchematicPath()
  const agent = root ? await sheetAgentFor(root) : null
  const design = agent ? await agent.agentDesign() : null
  if (!root || !design) {
    alert(t('app.netlist.errors.noSchematic'))
    return
  }
  const target = await window.api.saveFileDialog(netlistPathFor(root))
  if (!target) return
  const project = await findProjectFile(root)
  const settings = project ? await readProjectDesignSettings(project) : null
  const version = await window.api.getAppVersion().catch(() => '')
  const text = writeNetlist(design, {
    source: root,
    date: netlistDate(new Date()),
    tool: `GoatCAD ${version}`.trim(),
    ...(settings
      ? {
          netClassOf: (name: string) =>
            netClassForNet(name, settings.classes, settings.patterns, settings.assignments).name
        }
      : {})
  })
  const result = await window.api.createFile(target, text)
  if (!result.success) alert(t('app.netlist.errors.write', { error: result.error }))
}

/** Settles once the window's folder and projects are read, which agent requests wait for. */
let designReady: Promise<void> = Promise.resolve()

const handleDesignRequest = async (envelope: McpDesignEnvelope): Promise<void> => {
  const reply = (result: Omit<McpDesignReply, 'id'>): void =>
    window.api.sendMcpDesignReply({ id: envelope.id, ...result })
  // A door reports its refusals as `{ error }` rather than throwing; unwrap
  // them into the envelope's typed failure rather than handing the agent a
  // successful call whose payload says it failed.
  const replyPayload = (payload: unknown): void => {
    const failure = payload as { error?: string; detail?: string; candidates?: string[] } | null
    if (failure && typeof failure === 'object' && typeof failure.error === 'string') {
      return reply({
        ok: false,
        error: failure.error,
        detail: failure.detail,
        ...(failure.candidates ? { candidates: failure.candidates } : {})
      })
    }
    reply({ ok: true, payload })
  }

  try {
    // Three doors, asked in turn: the libraries (no sheet, project optional),
    // the window's own tabs, then a sheet. Each is a map of kind → handler
    // beside its handlers; nothing here knows what any one operation does.
    if (isLibraryRequest(envelope.request)) {
      return replyPayload(await libraryAgent.dispatch(envelope.request))
    }
    if (isViewportRequest(envelope.request)) {
      return replyPayload(await agentViewports.dispatch(envelope.request))
    }
    if (isBoardRequest(envelope.request)) {
      return replyPayload(await boardAgent.dispatch(envelope.request))
    }
    if (isFabExportRequest(envelope.request)) {
      return replyPayload(await fabExportAgent.dispatch(envelope.request))
    }
    if (isSymbolItemsRequest(envelope.request)) {
      return replyPayload(await symbolItemsAgent.dispatch(envelope.request))
    }
    if (isFootprintRequest(envelope.request)) {
      return replyPayload(await footprintAgent.dispatch(envelope.request))
    }
    if (isSchematicSetupRequest(envelope.request)) {
      return replyPayload(await schematicSetupAgent.dispatch(envelope.request))
    }

    // Opening and closing tabs are App's own — tabs live here — and take any
    // document kind, so they are served before the sheet resolution below.
    if (envelope.request.kind === 'unsaved-files') {
      return reply({ ok: true, payload: { unsaved: editorArea.value?.unsavedPaths() ?? [] } })
    }
    if (envelope.request.kind === 'set-workspace') {
      const unsaved = editorArea.value?.unsavedPaths() ?? []
      if (unsaved.length)
        return reply({
          ok: false,
          error: 'unsaved-edits',
          detail: `The workspace has unsaved edits: ${unsaved.join(', ')}.`,
          candidates: unsaved
        })
      const { root, project } = envelope.request
      let listing: FileItem[]
      try {
        listing = (await window.api.readDirectory(root)) as FileItem[]
      } catch {
        return reply({
          ok: false,
          error: 'file-not-found',
          detail: `${root} is not a folder this app can read.`
        })
      }
      const name = root.split(/[\\/]/).filter(Boolean).pop() ?? root
      await loadProject({ path: root, name, files: listing }, project ?? undefined)
      return reply({
        ok: true,
        payload: { root: projectPath.value, project: activeProject.value?.path ?? null }
      })
    }
    if (envelope.request.kind === 'create-project') {
      return replyPayload(await createProjectForAgent(envelope.request))
    }
    if (envelope.request.kind === 'create-file') {
      return replyPayload(await createFileForAgentRequest(envelope.request))
    }
    if (envelope.request.kind === 'open-file') {
      const request = envelope.request
      const resolved = resolveAgentFile(request.file, {
        openTabs: fileTabs.value,
        files: files.value
      })
      if (!resolved) {
        return reply({
          ok: false,
          error: 'file-not-found',
          detail: `No file called ${request.file} is in this project.`,
          candidates: fileCandidates(files.value, request.file)
        })
      }
      const wasOpen = openTabs.value.some((tab) => tab.path === resolved)
      openFile({ name: resolved.split(/[\\/]/).pop() ?? resolved, path: resolved })
      await nextTick()
      return reply({
        ok: true,
        payload: {
          opened: resolved,
          kind: documentKindOf(resolved),
          wasOpen,
          active: activeTabPath.value === resolved,
          guidance: wasOpen
            ? 'The file was already open; its tab is now in front.'
            : 'The file is open in a new tab, in front of the user.'
        }
      })
    }
    if (envelope.request.kind === 'close-file') {
      const request = envelope.request
      const open = openTabs.value.map((tab) => tab.path)
      const wanted = request.file.trim().toLowerCase()
      const byPath = open.find((path) => path.toLowerCase() === wanted)
      const byName = open.filter(
        (path) => (path.split(/[\\/]/).pop() ?? '').toLowerCase() === wanted
      )
      const resolved = byPath ?? (byName.length === 1 ? byName[0] : undefined)
      if (!resolved) {
        return reply({
          ok: false,
          error: 'file-not-open',
          detail:
            byName.length > 1
              ? `${request.file} names ${byName.length} open tabs; pass the full path.`
              : `No open tab is called ${request.file}.`,
          candidates: byName.length > 1 ? byName : open
        })
      }
      const dirty = editorArea.value?.hasUnsavedEdits(resolved) ?? false
      if (dirty && request.discard !== true) {
        return reply({
          ok: false,
          error: 'unsaved-edits',
          detail: `${resolved} has unsaved edits.`
        })
      }
      closeTab(resolved)
      return reply({
        ok: true,
        payload: {
          closed: resolved,
          discardedEdits: dirty,
          active: activeTabPath.value,
          guidance: dirty
            ? 'The tab is closed and its unsaved edits are gone. Tell the user.'
            : 'The tab is closed; nothing was lost.'
        }
      })
    }

    // Saving is not a sheet edit and takes any document kind, so it is served
    // here, where the tabs are, and never reaches an editor. It writes exactly
    // what a person's Save would — the flushed buffer — and answers with the
    // paths, which is the whole consent story for the one verb that crosses
    // the undo line.
    if (envelope.request.kind === 'save-files') {
      const editor = editorArea.value
      if (!editor) return reply({ ok: false, error: 'no-window' })
      const open = openTabs.value.map((tab) => tab.path)
      const dirty = new Set(editor.unsavedPaths())
      const wanted = envelope.request.files
      let targets: string[]
      if (wanted?.length) {
        targets = []
        for (const file of wanted) {
          const exact = open.find((candidate) => candidate === file)
          const byName = open.filter((candidate) => candidate.split(/[\\/]/).pop() === file)
          const match = exact ?? (byName.length === 1 ? byName[0] : undefined)
          if (!match) {
            return reply({
              ok: false,
              error: 'file-not-open',
              detail:
                byName.length > 1
                  ? `${file} names ${byName.length} open tabs; pass the full path.`
                  : `No open tab is called ${file}.`,
              candidates: byName.length > 1 ? byName : open
            })
          }
          targets.push(match)
        }
      } else {
        targets = [...dirty]
      }
      const written: { path: string; bytes: number }[] = []
      const clean: string[] = []
      for (const path of targets) {
        const content = dirty.has(path) ? await editor.contentToSave(path) : null
        if (content === null) {
          clean.push(path)
          continue
        }
        const result = await writeSavedFile(path, content)
        if (!result.ok) {
          return reply({ ok: false, error: 'save-failed', detail: `${path}: ${result.error}` })
        }
        editor.markSaved(path, content)
        written.push({ path: result.path, bytes: content.length })
      }
      return reply({
        ok: true,
        payload: {
          written,
          alreadySaved: clean,
          stillUnsaved: editor.unsavedPaths(),
          guidance: written.length
            ? 'These files are now on disk and their tabs are clean; the edits can no longer be undone in the editor. Tell the user exactly which files were written.'
            : 'Nothing needed writing. Every named tab was already saved.'
        }
      })
    }

    const path = resolveAgentSheet(envelope.request.sheet, {
      openTabs: fileTabs.value,
      files: files.value,
      rootPath: rootSchematicPath()
    })
    if (!path) {
      return reply({
        ok: false,
        error: envelope.request.sheet ? 'sheet-not-found' : 'no-schematic',
        detail: envelope.request.sheet
      })
    }
    const agent = await sheetAgentFor(path)
    if (!agent) return reply({ ok: false, error: 'sheet-not-found', detail: path })

    // Dispatch belongs to the editor, not here: a batch has to run the same
    // requests through the same door without each one writing history, so the
    // map lives next to the handlers (`docs/agent-api.md`).
    const request = envelope.request
    const sheetDocument = documentStore.get(path)
    sheetDocument?.touch('agent')
    const release = sheetDocument?.pin('agent')
    let payload: unknown
    const run = (): Promise<unknown> =>
      request.kind === 'batch' ? agent.agentBatch(request) : agent.agentDispatch(request)
    // A layout write names its viewport, whose box frames what it changed:
    // deleted items where they were, read before the write.
    const layout = request as { viewport?: string; action?: string }
    const deletes =
      request.kind === 'delete-items' ||
      request.kind === 'undo-sheet' ||
      (request.kind === 'batch' && request.ops.some((op) => op.kind === 'delete-items'))
    let was = new Map<string, ViewportFrame>()
    try {
      payload =
        request.kind === 'render-sheet'
          ? await agentViewports.framed(request, path, run)
          : layout.viewport !== undefined
            ? await agentViewports.framed(
                layout,
                path,
                () => {
                  if (deletes) was = agent.agentItemFrames()
                  return run()
                },
                (answer) => {
                  const now = agent.agentItemFrames()
                  return changedFrame(
                    answer,
                    { now: (id) => now.get(id), was: (id) => was.get(id) },
                    SHEET_WRITE_FRAME_MARGIN_MM
                  )
                }
              )
            : await run()
    } finally {
      release?.()
    }

    if (typeof (payload as { error?: unknown } | null)?.error === 'string') {
      return replyPayload(payload)
    }
    // A child sheet just written is a tab the user can find, behind this one.
    if (request.kind === 'add-sheet') {
      const file = (payload as { file?: string } | null)?.file
      if (file) openFileInBackground(file)
    }
    reply({ ok: true, payload })
  } catch (err) {
    reply({
      ok: false,
      error: 'renderer-failed',
      detail: err instanceof Error ? err.message : String(err)
    })
  }
}

onMounted(async (): Promise<void> => {
  // These are independent, so they go out together: awaited in sequence they
  // cost an IPC round trip each before this window knows what it holds, and the
  // editor area shows nothing until then. Settled individually so one failure
  // does not deny the window the other answers. The GPU preference is here so
  // the first canvas a restored session creates already asks for it.
  const [idResult, configResult, initResult] = await Promise.allSettled([
    window.api.getWindowId(),
    window.api.getConfig(),
    window.api.getWindowInit(),
    loadGpuPreference()
  ])

  if (idResult.status === 'fulfilled') {
    if (idResult.value) windowId.value = idResult.value
  } else {
    console.error(idResult.reason)
  }

  if (configResult.status === 'fulfilled') {
    showWelcomeOnStartup.value = configResult.value.showWelcomeOnStartup
    recents.value = configResult.value.recents
    if (configResult.value.locale) locale.value = configResult.value.locale
    setAppTheme(configResult.value.theme)
  } else {
    console.error('Failed to load app config', configResult.reason)
  }

  // What this window opens with — a restored session, a file the OS asked us to
  // open, a dragged-out tab, or nothing — is decided by the main process.
  if (initResult.status === 'fulfilled') {
    const init = await restoreTerminalTabs(initResult.value)
    if (init.projectPath) {
      projectPath.value = init.projectPath
      projectName.value = init.projectPath.split(/[/\\]/).pop() || init.projectPath
    }
    if (init.tabs.length > 0) {
      for (const tab of init.tabs) {
        if (tab.cameras) hydrateCameras(tab.path, tab.cameras)
      }
      openTabs.value = init.tabs.map((tab) => ({ name: tab.name, path: tab.path }))
      editorGroups.restore(init.editorLayout)
      // A restored split keeps each group's own front tab; the window's active
      // tab is then whichever group had the keyboard.
      if (editorLayout.groups.length === 1) {
        activeTabPath.value = init.activeTabPath ?? init.tabs[0].path
      }
    }
    if (init.showWelcome) openWelcomeTab()
    // Deliberately not awaited, and deliberately after the tabs are assigned:
    // the file tree and the project scan are sidebar detail, and holding the
    // editor back for a directory walk plus `git status` is what made a
    // restored project sit behind a blank panel. Both fill in on their own.
    if (init.projectPath) {
      // Re-detected rather than trusted wholesale: the workspace may have
      // gained or lost projects since this window last closed. The remembered
      // pick is a preference applied on top of that.
      designReady = Promise.all([
        refreshDirectory(),
        detectProjects(init.projectPath, init.activeProjectPath)
      ]).then(
        () => undefined,
        (err) => console.error('Failed to read the workspace', err)
      )
    }
  } else {
    console.error('Failed to initialize window', initResult.reason)
  }
  sessionReady.value = true
  performance.mark('launch:session-ready')

  // Settings are global, so another window changing them applies here too.
  // An MCP client asked for the distributor-key form.
  const cleanupMcpSettings = window.api.onPartsOpenSettings(() => {
    openSettingsTab('parts')
  })

  // Read/edit requests from an MCP client, answered once the folder is read:
  // an agent may ask the moment it starts a workspace (`main/partsMcpBridge.ts`).
  const cleanupMcpDesign = window.api.onMcpDesignRequest((envelope) => {
    void designReady.then(() => handleDesignRequest(envelope))
  })
  void designReady.then(() => window.api.mcpDesignReady())

  const cleanupConfig = window.api.onConfigChanged((config) => {
    showWelcomeOnStartup.value = config.showWelcomeOnStartup
    recents.value = config.recents
    locale.value = config.locale
    setAppTheme(config.theme)
  })

  const cleanupRemove = window.api.onTabRemove((path) => {
    closeTab(path)
  })

  // Main holds the window open until this answers, so every path out of here
  // must reply — including the failure one.
  const cleanupConfirmClose = window.api.onConfirmClose(() => {
    void resolveUnsavedBeforeClose()
      .catch(() => true)
      .then((proceed) => window.api.confirmWindowClose(proceed))
  })

  const cleanupAdd = window.api.onTabAdd((tabData) => {
    openFile(tabData as { name: string; path: string })
  })

  // Global keydown listeners for window actions (bindings in lib/hotkeys.ts)
  const handleKeydown = (e: KeyboardEvent): void => {
    // Escape dismisses the topmost sheet, on `window` rather than the overlay:
    // neither of these focuses a control, so a `@keydown.esc` on the element
    // would never fire (DESIGN.md §3).
    if (matchesHotkey(e, 'app.dismiss') && showShortcutsModal.value) {
      e.preventDefault()
      showShortcutsModal.value = false
    } else if (matchesHotkey(e, 'app.cycleTabNext')) {
      e.preventDefault()
      cycleTab(1)
    } else if (matchesHotkey(e, 'app.cycleTabPrev')) {
      e.preventDefault()
      cycleTab(-1)
    } else if (matchesHotkey(e, 'app.newSchematic')) {
      e.preventDefault()
      if (projectPath.value) handleTitleBarNewFile('schematic')
    } else if (matchesHotkey(e, 'app.openFolder')) {
      e.preventDefault()
      handleOpenFolder()
    } else if (matchesHotkey(e, 'app.openProject')) {
      e.preventDefault()
      handleOpenProject()
    } else if (matchesHotkey(e, 'app.quickOpen')) {
      e.preventDefault()
      showQuickOpen.value = !showQuickOpen.value
    } else if (matchesHotkey(e, 'app.closeTab')) {
      e.preventDefault()
      if (activeTabPath.value) {
        void requestCloseTab(activeTabPath.value)
      }
    } else if (matchesHotkey(e, 'app.newWindow')) {
      e.preventDefault()
      window.api.newWindow()
    } else if (matchesHotkey(e, 'app.newTerminal')) {
      e.preventDefault()
      void openTerminalTab()
    } else if (matchesHotkey(e, 'app.showExplorer')) {
      e.preventDefault()
      showSidebarTab('explorer')
    } else if (matchesHotkey(e, 'app.showLibraries')) {
      e.preventDefault()
      showSidebarTab('parts')
    } else if (matchesHotkey(e, 'app.openPartSearch')) {
      e.preventDefault()
      openPartsTab()
    } else if (matchesHotkey(e, 'app.openAgent')) {
      e.preventDefault()
      void openTerminalTab(agentChoice.value)
    } else if (matchesHotkey(e, 'app.openSettings')) {
      e.preventDefault()
      openSettingsTab()
    } else if (matchesHotkey(e, 'app.updatePcb')) {
      e.preventDefault()
      openUpdatePcb()
    } else if (matchesHotkey(e, 'git.focusCommit')) {
      e.preventDefault()
      if (!projectPath.value) return
      showGitPane()
      gitOps.requestCommitFocus()
    } else if (gitStatus.value?.state === 'ok' && matchesHotkey(e, 'git.stageAll')) {
      e.preventDefault()
      void gitOps.stageAll()
    } else if (gitStatus.value?.state === 'ok' && matchesHotkey(e, 'git.push')) {
      e.preventDefault()
      void gitOps.push()
    } else if (gitStatus.value?.state === 'ok' && matchesHotkey(e, 'git.pull')) {
      e.preventDefault()
      void gitOps.pull()
    }
  }
  window.addEventListener('keydown', handleKeydown)

  // Capture phase: a focused terminal consumes every key it is sent (F6
  // included), and these are the keys that get the keyboard back out of it.
  const handleSplitKeydown = (e: KeyboardEvent): void => {
    if (matchesHotkey(e, 'app.focusOtherGroup')) {
      if (editorLayout.groups.length < 2) return
      focusOtherEditorGroup()
    } else if (matchesHotkey(e, 'app.splitTab')) {
      if (!activeTabPath.value) return
      splitTab(activeTabPath.value)
    } else if (matchesHotkey(e, 'app.splitDirection')) {
      if (editorLayout.groups.length < 2) return
      toggleDirection(editorLayout)
    } else {
      return
    }
    e.preventDefault()
    e.stopPropagation()
  }
  window.addEventListener('keydown', handleSplitKeydown, true)

  // External edits (CLI commits, other editors, files dropped in from the file
  // manager) get picked up on refocus. The full directory refresh — not just
  // git — because otherwise a file copied in shows up as untracked in the Git
  // pane while the explorer still doesn't list it. refreshDirectory re-runs git
  // itself, so this covers both.
  const handleWindowFocus = (): void => {
    void refreshDirectory()
  }
  window.addEventListener('focus', handleWindowFocus)

  await loadLibrariesTable()

  // Window-wide, so a library added anywhere reaches every index consumer —
  // not just the components that subscribe to `index:progress` themselves.
  const cleanupIndexInvalidation = installIndexInvalidation()

  // The change bus: this window's own mutations, and — through main — the ones
  // another window made in the same workspace.
  const cleanupBusListener = onProjectChange(handleProjectChanges)
  const cleanupBusBridge = installProjectBus(() => projectPath.value)

  onUnmounted((): void => {
    cleanupMcpSettings()
    cleanupMcpDesign()
    cleanupConfig()
    cleanupRemove()
    cleanupConfirmClose()
    cleanupAdd()
    cleanupIndexInvalidation()
    cleanupBusListener()
    cleanupBusBridge()
    window.removeEventListener('keydown', handleKeydown)
    window.removeEventListener('keydown', handleSplitKeydown, true)
    window.removeEventListener('focus', handleWindowFocus)
    if (terminalPollTimer) clearInterval(terminalPollTimer)
  })
})

const activeTabObj = computed(() => {
  return openTabs.value.find((t) => t.path === activeTabPath.value) || null
})

const showBranchPicker = ref(false)
const branchList = ref<GitBranch[]>([])
const branchListLoading = ref(false)
const branchPickerError = ref<string | null>(null)

const openBranchPicker = async (): Promise<void> => {
  const path = projectPath.value
  if (!path) return
  showBranchPicker.value = true
  branchPickerError.value = null
  branchListLoading.value = true
  try {
    const res = await window.api.gitBranches(path)
    branchList.value = res.branches
    if (!res.success) branchPickerError.value = res.error ?? null
  } catch (err) {
    branchPickerError.value = err instanceof Error ? err.message : String(err)
  } finally {
    branchListLoading.value = false
  }
}

const handleBranchCheckout = async (name: string, create: boolean): Promise<void> => {
  const path = projectPath.value
  if (!path) return
  branchPickerError.value = null
  try {
    const res = await window.api.gitCheckout(path, name, create)
    if (!res.success) {
      // Typical: dirty files that would be overwritten. Stay open, show why.
      branchPickerError.value = res.error ?? null
      return
    }
    showBranchPicker.value = false
    // A branch switch rewrites the whole tree, so this is announced against the
    // workspace root rather than a file: every subscriber has to re-derive, and
    // enumerating what git touched would say nothing extra. Open tabs keep their
    // loaded content until reopened.
    await emitProjectChange(path, fileChange('file-changed', path))
  } catch (err) {
    branchPickerError.value = err instanceof Error ? err.message : String(err)
  }
}
</script>

<template>
  <div class="window-container">
    <!-- Frameless custom title bar -->
    <TitleBar
      :project-path="projectPath"
      :project-name="projectName"
      :active-tab-name="activeTabObj ? activeTabObj.name : null"
      :recents="recents"
      :has-schematic="hasRootSchematic"
      :has-board-page="hasMenuBoard"
      :has-schematic-page="hasMenuSchematic"
      @open-design-page="openDesignPage"
      @open-folder="handleOpenFolder"
      @open-project="handleOpenProject"
      @open-recent="openRecentEntry"
      @open-file="handleOpenFileDialog"
      @clear-recent="clearRecents"
      @new-project="handleNewProject"
      @create-typed-file="handleTitleBarNewFile"
      @save="editorArea?.saveCurrentFile()"
      @save-as="editorArea?.saveFileAs()"
      @save-all="editorArea?.saveAllFiles()"
      @export-netlist="exportNetlist"
      @update-pcb="openUpdatePcb"
      @show-shortcuts="toggleShortcutsModal"
      @show-welcome="openWelcomeTab"
      @show-about="openSettingsTab('about')"
      @show-feedback="openFeedback"
    />

    <!-- IDE shell. The welcome page is an editor tab, so this is always mounted. -->
    <div class="workspace-container">
      <Sidebar
        v-model:active-sidebar-tab="activeSidebarTab"
        v-model:drawer-visible="sidebarVisible"
        :project-path="projectPath"
        :project-name="projectName"
        :files="files"
        :active-tab-path="activeTabPath"
        :libraries="libraries"
        :loading-file-path="loadingFilePath"
        :git-status="gitStatus"
        :rename-request-path="pendingRenamePath"
        :active-project="activeProject"
        :project-candidates="projectCandidateList"
        :project-index-generation="projectIndexGeneration"
        :project-revision="projectRevision"
        :read-open-buffer="readOpenBuffer"
        :open-library-symbols="openLibrarySymbols"
        @select-project="selectActiveProject"
        @open-library-symbol="openLibrarySymbol"
        @new-symbol="newSymbol"
        @rename-symbol="renameLibrarySymbol"
        @delete-symbol="deleteLibrarySymbol"
        @open-settings="openSettingsTab"
        @share-feedback="openFeedback"
        @open-parts="openPartsTab"
        @new-terminal="openTerminalTab"
        @open-file="openFile"
        @open-folder="handleOpenFolder"
        @new-project="handleCreateProjectHere"
        @refresh-directory="refreshDirectory"
        @open-branch-picker="openBranchPicker"
        @open-diff="openDiffTab"
        @create-file="handleCreateFile"
        @file-action="handleFileAction"
        @rename-file="handleRenameFile"
        @create-typed-file="handleCreateTypedFile"
        @add-library="handleAddLibrary"
        @new-library="handleNewLibrary"
      />

      <EditorArea
        ref="editorArea"
        :project-path="projectPath"
        :project-file="activeProject?.path ?? null"
        :root-schematic="rootSchematic"
        :open-tabs="openTabs"
        :active-tab-path="activeTabPath"
        :layout="editorLayout"
        :group-focus-signal="groupFocusSignal"
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
        @open-settings="openSettingsTab"
        @share-feedback="openFeedback"
        @close-tab="closeTab"
        @request-close-tab="requestCloseTab"
        @select-tab="selectTab"
        @pin-tab="pinTab"
        @reorder-tabs="reorderTabs"
        @focus-group="focusEditorGroup"
        @split-tab="splitTab"
        @move-tab="moveTabToGroup"
        @resize-split="(ratio) => setRatio(editorLayout, ratio)"
        @save-file="handleSaveFile"
        @saved-as="handleSavedAs"
        @open-file="openFile"
        @open-symbol="openSymbol"
        @reveal-in-document="revealInDocument"
        @file-created="(path) => emitProjectChange(projectPath, fileChange('file-created', path))"
        @open-background="openFileInBackground"
        @open-library-symbol="openLibrarySymbol"
        @active-symbol="setActiveSymbol"
        @symbol-names="setLibrarySymbolNames"
        @open-folder="handleOpenFolder"
        @open-project="handleOpenProject"
        @open-recent="openRecentEntry"
        @open-file-dialog="handleOpenFileDialog"
        @new-project="handleNewProject"
        @open-sample="showSampleProjects = true"
        @open-manufacture="openManufactureTab"
        @update-from-schematic="openUpdatePcb"
        @open-components="openComponentsTab"
        @open-schematic-setup="openSchematicSetupTab"
        @open-board-setup="openBoardSetupTab"
        @update:show-welcome-on-startup="setShowWelcomeOnStartup"
        @update-loading-path="(path) => (loadingFilePath = path)"
      />
    </div>

    <BranchPicker
      v-if="showBranchPicker"
      :branches="branchList"
      :loading="branchListLoading"
      :error="branchPickerError"
      @checkout="handleBranchCheckout"
      @close="showBranchPicker = false"
    />

    <QuickOpen
      v-if="showQuickOpen"
      :files="files"
      :open-tabs="openTabs"
      :project-path="projectPath"
      @close="showQuickOpen = false"
      @open-file="handleQuickOpenFile"
    />

    <!-- Add Library: copy it into the project, or point at where it lives -->
    <AddLibraryDialog
      v-if="addLibraryPlan && activeProject"
      :plan="addLibraryPlan"
      :project-dir="activeProject.dir"
      @confirm="(mode) => runAddLibrary(addLibraryPlan as AddLibraryPlan, mode)"
      @cancel="addLibraryPlan = null"
    />

    <!-- Create Project: scaffold a blank design, or adopt what the folder holds -->
    <NewProjectDialog
      v-if="newProjectTarget"
      :folder-path="newProjectTarget.path"
      :folder-name="newProjectTarget.name"
      :entries="newProjectTarget.entries"
      @confirm="confirmNewProject"
      @open-existing="openExistingProject"
      @cancel="newProjectTarget = null"
    />

    <UpdatePcbDialog
      v-if="updatePcbOpen"
      :boards="projectFilesOfKind('board')"
      :initial-board="updatePcbBoard"
      :project-dir="activeProject?.dir ?? null"
      :schematic="rootSchematicPath()"
      :preview="boardAgent.previewSync"
      :apply="applyBoardUpdate"
      @applied="onBoardUpdated"
      @close="updatePcbOpen = false"
    />

    <!-- Open sample project: fetch the catalog, download one into temp -->
    <SampleProjectsDialog
      v-if="showSampleProjects"
      @opened="openSampleProject"
      @cancel="showSampleProjects = false"
    />

    <FeedbackDialog
      v-if="showFeedback"
      :screenshot="feedbackScreenshot"
      @close="showFeedback = false"
    />

    <Modal v-if="showShortcutsModal" @dismiss="showShortcutsModal = false">
      <div class="modal-content">
        <h2>{{ t('app.shortcuts.title') }}</h2>
        <dl class="shortcut-grid shortcut-sheet">
          <template v-for="s in shortcutSheet" :key="s.label">
            <dt class="shortcut-desc">{{ s.label }}</dt>
            <dd>
              <kbd class="kbd"
                ><span>{{ s.keys }}</span></kbd
              >
            </dd>
          </template>
        </dl>
        <button class="btn-outline btn-md shortcut-sheet-close" @click="showShortcutsModal = false">
          {{ t('common.close') }}
        </button>
      </div>
    </Modal>
  </div>
</template>

<style scoped>
.modal-content {
  background-color: var(--vscode-bg-sidebar);
  border: 1px solid var(--vscode-border);
  border-radius: 8px;
  width: 90%;
  max-width: 450px;
  padding: 24px;
  box-shadow: 0 10px 30px var(--vscode-shadow-modal);
  display: flex;
  flex-direction: column;
}

.modal-content h2 {
  font-size: var(--text-heading);
  font-weight: 700;
  color: var(--vscode-text-light);
  border-bottom: 1px solid var(--vscode-border);
  padding-bottom: 12px;
  margin-bottom: 16px;
}

/* A reference list, read top to bottom: labels flush left, keys in a column. */
.shortcut-sheet {
  grid-template-columns: 1fr auto;
}

.shortcut-sheet .shortcut-desc {
  text-align: left;
}

.shortcut-sheet-close {
  margin-top: 24px;
  align-self: flex-end;
}
</style>
