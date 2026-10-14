import {
  app,
  shell,
  BrowserWindow,
  ipcMain,
  clipboard,
  dialog,
  nativeImage,
  screen,
  type WebContents
} from 'electron'
import { join, basename, dirname } from 'path'
import * as fs from 'fs'
import { homedir } from 'node:os'
import * as tar from 'tar'
import * as https from 'https'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
// Unpacked: the system's text viewer opens it, and cannot read inside the asar.
import thirdPartyNotices from '../../resources/THIRD_PARTY_NOTICES.txt?asset&asarUnpack'
import {
  APP_ID,
  APP_NAME,
  ConfigStore,
  addRecent,
  normalizeSession,
  sanitizeSessions,
  windowInitFor,
  writableConfigPatch,
  type AppConfig,
  type AppTheme,
  type RecentEntry,
  type TabState,
  type WindowBounds,
  type WindowInit,
  type WindowSession
} from './appConfig'
import { clearApplicationMenu, focusWindowMenu, forgetWindowMenu, setWindowMenu } from './appMenu'
import { groupOpenTargets, parseFileArgs, KICAD_EXTENSIONS } from './launchArgs'
import { loadStepFile } from './stepLoader'
import { TerminalSessionManager } from './terminalSessions'
import { AgentStatusServer } from './agentStatusServer'
import { writeClaudeHooksFile } from './agentActivity'
import type { TerminalKind } from '../preload/terminalTypes'
import { resolveModelPath } from './modelResolver'
import {
  KICAD_LIB_VERSION,
  tarballUrl,
  extractedDirName,
  detectSystemLibraries,
  detectThirdPartyDir,
  type LibrarySet
} from './kicadLibraries'
import {
  detectKicadConfigDir,
  mergeSeedRows,
  seedRowsFromTable,
  type SeedRow
} from './kicadGlobalTables'
import { registerSystemChecks, runSystemChecks } from './launchChecks'
import { flushParts, registerPartsIpc } from './partsIpc'
import { startCrashDumps, watchPageCrash, watchProcessCrashes } from './processCrash'
import { outboundFetch } from './outboundFetch'
import { downloadSample, fetchSampleCatalog } from './sampleProjects'
import type { SampleCatalog, SampleListResult, SampleOpenResult } from '../preload/sampleTypes'
import {
  mcpLaunch,
  registerPartsMcpIpc,
  setProjectResolver,
  startPartsMcp,
  stopPartsMcp
} from './partsMcpIpc'
import { setDesignWindowSource } from './partsMcpBridge'
import { writeClaudeMcpConfigFile } from './partsMcpClients'
import type { ProjectChangeBatch } from '../preload/projectChangeTypes'
import type { FabExportPayload, FabExportResult } from '../preload/fabTypes'
import type { CrossProbe } from '../preload/crossProbeTypes'
import { configureProjectWatcher, unwatchAllForWindow, watchWorkspace } from './projectWatcher'
import { parseSymLibTableLite } from './libraryIndexProject'
import { registerLibraryIndexIpc, rebuildSystemIndex, refreshSystemIndex } from './libraryIndex'
import {
  checkoutBranch,
  commitStaged,
  ignorePath,
  discardChanges,
  getGitStatus,
  initRepo,
  listBranches,
  stageFiles,
  unstageFiles
} from './gitStatus'
import { diffFile, showFile } from './gitContent'
import { pullBranch, pushBranch } from './gitRemote'
import type { GitDiffRequest, GitDiscardTarget } from '../preload/gitTypes'
import type { NativeMenuTemplate } from '../preload/menuTypes'
import type { UnsavedChoice, UnsavedPrompt } from '../preload/dialogTypes'
import { unsavedButtonOrder } from './unsavedDialog'
import { registerMediaSchemePrivileges, registerMediaProtocolHandler } from './mediaProtocol'
import { APP_URL, appSchemePrivileges, registerAppProtocolHandler } from './appProtocol'
import { buildZip } from './zip'
import { canCheckForUpdates, checkForUpdatesNow, startUpdater } from './updater'
import { registerFeedbackIpc } from './feedback'

// Must precede any getPath('userData') call: it decides the config directory.
// Launch milestones (`launch:*`) are read by bin/launch-timing; a mark costs microseconds.
performance.mark('launch:main-evaluated')

app.setName(APP_NAME)

// Scheme privileges must be declared before app ready (see mediaProtocol.ts).
registerMediaSchemePrivileges([appSchemePrivileges])

// Test/automation escape hatch: point userData at a throwaway directory so
// harness runs (bin/screenshot) never touch the real config/session. Must also
// precede any getPath('userData') call.
if (process.env.GOATCAD_USER_DATA_DIR) {
  app.setPath('userData', process.env.GOATCAD_USER_DATA_DIR)
}

// Keep track of active windows
const windowMap = new Map<number, BrowserWindow>()

/** Live per-window state, kept current by `session:update` from each renderer. */
const sessionState = new Map<number, WindowSession>()

/**
 * Windows whose renderer has cleared the close. A close is vetoed until then so
 * unsaved tabs can be resolved first; the renderer answers on
 * `window:close-confirmed`, which re-issues `close()` with the id in this set.
 */
const closeApproved = new Set<number>()

/**
 * Terminal-tab shells. Output is addressed to the window currently showing the
 * session rather than broadcast: a tab dragged between windows re-points its
 * owner (`terminal:attach`), and a window that never had the tab should not pay
 * for its output. A session with no owner keeps running and keeps buffering —
 * that gap is exactly the moment between a tab leaving one window and mounting
 * in the next, and the snapshot replay closes it.
 */
const terminals = new TerminalSessionManager(
  (owner, channel, ...args) => {
    if (owner === null) return
    const win = BrowserWindow.getAllWindows().find((w) => w.webContents.id === owner)
    if (win && !win.webContents.isDestroyed()) win.webContents.send(channel, ...args)
  },
  {
    register: async (session) => {
      await agentStatus.start()
      return agentStatus.register(session)
    },
    unregister: (session) => agentStatus.unregister(session),
    claudeSettings: () => writeClaudeHooksFile(join(app.getPath('userData'), 'agent-hooks')),
    mcp: () => mcpLaunch(),
    claudeMcpConfig: (url) =>
      writeClaudeMcpConfigFile(join(app.getPath('userData'), 'agent-hooks'), url),
    theme: () => config().get().theme
  }
)
// Where an agent tab's hooks report what it is doing (§3.12). One loopback
// listener, bound on the first agent launch and never before.
const agentStatus = new AgentStatusServer((session, activity) =>
  terminals.reportActivity(session, activity)
)

let configStore: ConfigStore | null = null
const config = (): ConfigStore => {
  if (!configStore) configStore = new ConfigStore(app.getPath('userData'))
  return configStore
}

// A blocklisted driver (llvmpipe in a VM or under xvfb, older Mesa) otherwise
// gets no WebGL at all, and a board that cannot render is broken anyway.
if (process.platform === 'linux') app.commandLine.appendSwitch('ignore-gpu-blocklist')

startCrashDumps(is.dev)
watchProcessCrashes()

// Opt-in (Settings ▸ Appearance). Chromium's compositor and WebGL (through ANGLE)
// use OpenGL on Linux by default; both switch together so they share one API.
// Switches only apply before ready, so a change waits for a restart.
if (process.platform === 'linux' && config().get().useVulkan) {
  app.commandLine.appendSwitch('enable-features', 'Vulkan')
  app.commandLine.appendSwitch('use-angle', 'vulkan')
}

/**
 * Tell a window whether it is the active one, so its chrome can dim when it is
 * not. The renderer cannot answer this itself: clicking into a document-viewer
 * iframe (the PDF and HTML tabs) blurs the page while the OS window stays
 * active, which would dim the bar the user is working under.
 */
const sendWindowFocus = (win: BrowserWindow, focused: boolean): void => {
  // A crashed page has no frame to receive it; the crash dialog speaks for it.
  if (!win.isDestroyed() && !win.webContents.isCrashed())
    win.webContents.send('window:focus-changed', focused)
}

/** A restored position is only usable if some display still covers it. */
const boundsAreOnScreen = (bounds: WindowBounds): boolean =>
  screen.getAllDisplays().some(({ workArea }) => {
    return (
      bounds.x < workArea.x + workArea.width &&
      bounds.x + bounds.width > workArea.x &&
      bounds.y < workArea.y + workArea.height &&
      bounds.y + bounds.height > workArea.y
    )
  })

/**
 * What a window paints before the renderer's first frame, and under it while
 * resizing: each theme's --vscode-bg-editor (base.css), so launch is the
 * theme's own color rather than a flash of the other one.
 */
const WINDOW_BACKGROUND: Record<AppTheme, string> = { dark: '#151c19', light: '#f0f8f4' }

function createProjectWindow(session: Partial<WindowSession> = {}): BrowserWindow {
  const theme = config().get().theme
  const bounds = session.bounds && boundsAreOnScreen(session.bounds) ? session.bounds : undefined

  const win = new BrowserWindow({
    width: bounds?.width ?? 1200,
    height: bounds?.height ?? 800,
    ...(bounds ? { x: bounds.x, y: bounds.y } : {}),
    show: false,
    // Chromium paints its default white until the renderer's first frame lands.
    backgroundColor: WINDOW_BACKGROUND[theme],
    // Frameless everywhere — the renderer draws the title bar. macOS is the
    // exception: `frame: false` would take the traffic lights with it, and a
    // Mac window without them is not a Mac window. `titleBarStyle: 'hidden'`
    // keeps them native and lets the renderer own the rest of the bar; the
    // position centers them in its 35px height (main.css `.titlebar`).
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hidden' as const, trafficLightPosition: { x: 12, y: 11 } }
      : { frame: false }),
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      // Chromium's built-in PDF viewer is plugin-backed; the PDF tab's iframe
      // shows a download prompt instead of the document without this.
      plugins: true,
      // The renderer applies the theme before its first paint from this,
      // rather than painting dark until its config read comes back.
      additionalArguments: [`--goatcad-theme=${theme}`]
    }
  })

  if (session.maximized) win.maximize()

  const init = windowInitFor(session, config().get().showWelcomeOnStartup)

  windowMap.set(win.id, win)
  // Seed the live state: it is what the renderer asks for on load
  // (`window:get-init`), and what a window closed before its renderer reports
  // back still round-trips.
  sessionState.set(win.id, {
    projectPath: init.projectPath,
    tabs: init.tabs,
    activeTabPath: init.activeTabPath,
    ...(init.activeProjectPath ? { activeProjectPath: init.activeProjectPath } : {}),
    ...(init.editorLayout ? { editorLayout: init.editorLayout } : {})
  })

  win.on('ready-to-show', () => {
    performance.mark('launch:window-shown')
    win.show()
  })

  // 'close' fires while the window is still in windowMap, so the snapshot below
  // includes the window being closed — that is what makes "restore the tabs from
  // last close" work when this is the final window.
  win.on('close', (event) => {
    // Dirty state lives in the renderer, so main cannot decide this alone: veto
    // the close, ask, and let `window:close-confirmed` re-issue it. A gone or
    // hung renderer has no unsaved work worth blocking on, so it closes.
    // A crashed page cannot answer for its unsaved work; waiting on it would hold the window open.
    if (
      !closeApproved.has(win.id) &&
      !win.webContents.isDestroyed() &&
      !win.webContents.isCrashed()
    ) {
      event.preventDefault()
      win.webContents.send('window:confirm-close')
      return
    }
    if (!quitSessionCaptured) captureSession()
  })

  // `webContents.id` is captured before the window goes: it is the key the
  // watcher tracks subscribers by, and reading it off a destroyed window throws.
  const webContentsId = win.webContents.id

  win.on('closed', () => {
    windowMap.delete(win.id)
    sessionState.delete(win.id)
    // Another window stays open: the persisted set drops this one now. The last
    // window's close keeps the snapshot its 'close' took, as a quit does.
    if (!quitSessionCaptured && windowMap.size > 0) captureSession()
    closeApproved.delete(win.id)
    forgetWindowMenu(win)
    unwatchAllForWindow(webContentsId)
    // Sessions whose tab was dragged to another window have already re-pointed
    // their owner, so this only reaches the shells that were still shown here.
    terminals.disposeOwnedBy(webContentsId)
  })

  // The macOS menu bar belongs to the app, so the focused window's menu is the
  // one that applies (see appMenu.ts).
  win.on('focus', () => {
    focusWindowMenu(win)
    sendWindowFocus(win, true)
  })

  win.on('blur', () => {
    sendWindowFocus(win, false)
  })

  watchPageCrash(win, () => {
    const live = sessionState.get(win.id)
    if (!live) return
    const empty: WindowSession = { ...live, tabs: [], activeTabPath: null }
    delete empty.editorLayout
    sessionState.set(win.id, empty)
    // Saved now: a window killed after its crash must not relaunch the tab that crashed it.
    captureSession()
  })

  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // Web links clicked inside a document-viewer iframe (PDF/HTML tabs) go to
  // the system browser instead of navigating the frame onto the internet.
  // Main-frame navigations are left alone — in dev the window itself lives on
  // the http dev server.
  win.webContents.on('will-frame-navigate', (event) => {
    if (event.isMainFrame) return
    if (event.url.startsWith('http:') || event.url.startsWith('https:')) {
      event.preventDefault()
      shell.openExternal(event.url)
    }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadURL(APP_URL)
  }

  return win
}

const liveBounds = (win: BrowserWindow): Pick<WindowSession, 'bounds' | 'maximized'> => {
  const maximized = win.isMaximized()
  // A maximized window's own bounds are the screen; keep the restore-size instead.
  const bounds = win.getNormalBounds()
  return { bounds, ...(maximized ? { maximized: true } : {}) }
}

/**
 * Persist the windows that are open right now. Called on every window close, so
 * the last write before the app exits describes exactly the windows that were
 * still open at that moment — windows closed earlier are already gone from
 * windowMap and drop out naturally.
 */
const captureSession = (): void => {
  const sessions: WindowSession[] = []
  for (const [id, win] of windowMap) {
    const state = sessionState.get(id)
    if (!state) continue
    sessions.push({ ...state, ...liveBounds(win) })
  }
  config().update({ session: sessions })
}

let quitSessionCaptured = false

/**
 * A quit is waiting on windows to clear their unsaved work. Vetoing one window's
 * close cancels the whole quit sequence, so each approval re-issues `app.quit()`
 * to move on to the next window; a cancel anywhere drops the flag and the app
 * stays open.
 */
let quitRequested = false

/** Open the windows a launch should start with: files > restored session > welcome. */
const openStartupWindows = (files: readonly string[]): void => {
  const targets = groupOpenTargets(files)
  if (targets.length > 0) {
    for (const target of targets) {
      createProjectWindow({ projectPath: target.projectPath, tabs: target.tabs })
    }
    return
  }

  const restored = sanitizeSessions(config().get().session, fs.existsSync)
  if (restored.length > 0) {
    for (const session of restored) createProjectWindow(session)
    return
  }

  createProjectWindow()
}

const findWindowForProject = (projectPath: string): BrowserWindow | null => {
  for (const [id, win] of windowMap) {
    if (sessionState.get(id)?.projectPath === projectPath) return win
  }
  return null
}

const focusWindow = (win: BrowserWindow): void => {
  if (win.isMinimized()) win.restore()
  win.focus()
}

/** Route OS file-open requests into the running app. */
const openFilesInApp = (files: readonly string[]): void => {
  for (const target of groupOpenTargets(files)) {
    const existing = findWindowForProject(target.projectPath)
    if (existing) {
      for (const tab of target.tabs) existing.webContents.send('tab:add', tab)
      focusWindow(existing)
    } else {
      createProjectWindow({ projectPath: target.projectPath, tabs: target.tabs })
    }
  }
}

/** macOS delivers open-file events, sometimes before the app is ready. */
const queuedOpenFiles: string[] = []

interface FileItem {
  name: string
  path: string
  isDirectory: boolean
  children?: FileItem[]
}

// Recursive directory scanning
/** Names skipped by every directory walk (the tree, and the project scan). */
const isIgnoredDir = (name: string): boolean =>
  name.startsWith('.') || name === 'node_modules' || name === 'dist' || name === 'out'

function readDirectoryRecursive(dirPath: string, depth = 0, maxDepth = 5): FileItem[] {
  if (depth > maxDepth) return []
  try {
    const items = fs.readdirSync(dirPath, { withFileTypes: true })
    const result: FileItem[] = []
    for (const item of items) {
      if (isIgnoredDir(item.name)) continue
      const fullPath = join(dirPath, item.name)
      if (item.isDirectory()) {
        result.push({
          name: item.name,
          path: fullPath,
          isDirectory: true,
          children: readDirectoryRecursive(fullPath, depth + 1, maxDepth)
        })
      } else {
        result.push({
          name: item.name,
          path: fullPath,
          isDirectory: false
        })
      }
    }
    // Directories first, then files alphabetically
    return result.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1
      if (!a.isDirectory && b.isDirectory) return 1
      return a.name.localeCompare(b.name)
    })
  } catch (err) {
    console.error(err)
    return []
  }
}

// IPC Handlers Registration
const start = (): void => {
  app.whenReady().then(() => {
    performance.mark('launch:app-ready')
    electronApp.setAppUserModelId(APP_ID)

    clearApplicationMenu()

    // Packaged builds get the Dock icon from the bundle; `electron-vite dev`
    // runs inside Electron.app, so set it by hand or dev shows the Electron logo.
    if (is.dev && process.platform === 'darwin') {
      app.dock?.setIcon(nativeImage.createFromPath(icon))
    }

    registerMediaProtocolHandler()
    registerAppProtocolHandler(join(__dirname, '../renderer'))

    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
    })

    registerIpcHandlers()

    const launchFiles = [
      ...queuedOpenFiles,
      ...parseFileArgs(process.argv, {
        isPackaged: app.isPackaged,
        cwd: process.cwd(),
        exists: fs.existsSync
      })
    ]
    queuedOpenFiles.length = 0
    openStartupWindows(launchFiles)

    // Self-update for direct installs (main/updater.ts). The setting is read
    // at every check, so it is honored on the first one.
    startUpdater({ enabled: () => config().get().checkForUpdates })

    app.on('activate', function () {
      if (BrowserWindow.getAllWindows().length === 0) openStartupWindows([])
    })
  })
}

function registerIpcHandlers(): void {
  // Window utilities
  ipcMain.handle('window:get-id', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return win ? win.id : null
  })

  // The renderer asks for the project, tabs and welcome decision it opens
  // with: the window's live state, so a reload (a dev-mode rebuild, View ▸
  // Reload) comes back as the window was, not as it was created.
  ipcMain.handle('window:get-init', (event): WindowInit => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const live = win ? sessionState.get(win.id) : undefined
    return live
      ? windowInitFor(live, config().get().showWelcomeOnStartup)
      : { projectPath: null, tabs: [], activeTabPath: null, showWelcome: false }
  })

  // An agent's design request goes to the window holding the document, which
  // only this module knows (main/designWindow.ts).
  setDesignWindowSource(() =>
    [...windowMap.entries()]
      .filter(([, win]) => !win.isDestroyed())
      .map(([id, win]) => ({
        id,
        focused: win.isFocused(),
        projectPath: sessionState.get(id)?.projectPath ?? null,
        tabPaths: (sessionState.get(id)?.tabs ?? []).map((tab) => tab.path)
      }))
  )

  ipcMain.on('session:update', (event, session: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || !windowMap.has(win.id)) return
    const normalized = normalizeSession(session)
    if (!normalized) return
    sessionState.set(win.id, normalized)
    // Persisted as it changes (the config write is debounced), not only on
    // close: a restart that never closes a window — a dev-mode main rebuild, a
    // crash — still reopens the tabs and project as they were. A quit has
    // taken its own snapshot, which the windows closing after it must not shrink.
    if (!quitSessionCaptured) captureSession()
  })

  // Global app config
  ipcMain.handle('config:get', (): AppConfig => ({ ...config().get() }))

  /**
   * Push settings to every window so the config store is shared *state*, not
   * just shared storage. Without this, changing the language in one window
   * leaves the others on the old one until they restart.
   */
  const broadcastConfig = (next: AppConfig): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue
      win.setBackgroundColor(WINDOW_BACKGROUND[next.theme])
      win.webContents.send('config:changed', next)
    }
  }

  /**
   * The project change bus's rebroadcast half
   * (docs/projects.md §9). Two windows can hold the same
   * project open, and main is their only common point — so a create in one has
   * to reach the other's file tree, index and git decorations. The sender is
   * excluded: it already ran its own subscribers before sending, and handling
   * its own echo would refresh everything twice.
   *
   * Main is a *relay* here, not a participant. It does not interpret the batch;
   * the renderer owns what each change invalidates.
   */
  const broadcastProjectChange = (batch: ProjectChangeBatch, from?: WebContents): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed() || win.webContents === from) continue
      win.webContents.send('project:changed', batch)
    }
  }

  ipcMain.on('project:notify-change', (event, batch: ProjectChangeBatch) => {
    broadcastProjectChange(batch, event.sender)
  })

  // Does ANOTHER window have this file open? A file is open once per app, not
  // once per window: two editors on one path would each hold their own unsaved
  // copy (projects.md §5). The asking window uses this to leave a
  // cross-select to the window that already shows the sheet.
  ipcMain.handle('tab:held-elsewhere', (event, path: unknown): boolean => {
    if (typeof path !== 'string') return false
    const asking = BrowserWindow.fromWebContents(event.sender)?.id
    const wanted = path.replace(/[\\/]+/g, '/').toLowerCase()
    for (const [id, session] of sessionState) {
      if (id === asking) continue
      if (session.tabs.some((tab) => tab.path.replace(/[\\/]+/g, '/').toLowerCase() === wanted)) {
        return true
      }
    }
    return false
  })

  // Cross-select between a schematic and its board when the two sit in different
  // windows (split-view-workstream.md §6). A relay like the one above: main does
  // not read the probe, and the receiving window decides whether it concerns it.
  ipcMain.on('crossprobe:notify', (event, probe: CrossProbe) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed() || win.webContents === event.sender) continue
      win.webContents.send('crossprobe:probe', probe)
    }
  })

  // The watcher is main's own emitter into that bus, so it broadcasts to every
  // window — there is no sender to exclude (main/projectWatcher.ts).
  configureProjectWatcher({ broadcast: (batch) => broadcastProjectChange(batch) })

  // A window declares which workspace it is looking at; a null root means it is
  // looking at none. Re-declaring replaces the previous watch, so opening a
  // second folder never leaves the first one watched.
  ipcMain.on('project:watch', (event, root: string | null) => {
    unwatchAllForWindow(event.sender.id)
    if (root) watchWorkspace(root, event.sender.id)
  })

  ipcMain.handle('config:update', (_, patch: unknown): AppConfig => {
    const updated = { ...config().update(writableConfigPatch(patch)) }
    broadcastConfig(updated)
    return updated
  })

  // Recents broadcast for the same reason settings do: they are shared *state*,
  // read by the Welcome page and File ▸ Open Recent in every window at once. A
  // window that opened a project, or cleared the list, must not leave the others
  // showing what is no longer true.
  ipcMain.handle('config:add-recent', (_, entry: RecentEntry): RecentEntry[] => {
    // Rebuilt field by field rather than spread: this crosses the bridge from a
    // renderer, so it is untrusted input like any other IPC payload.
    const recents = addRecent(config().get().recents, {
      kind: entry.kind === 'file' ? 'file' : 'project',
      path: entry.path,
      workspaceRoot: entry.workspaceRoot,
      projectPath: entry.projectPath ?? null
    })
    broadcastConfig({ ...config().update({ recents }) })
    return recents
  })

  ipcMain.handle('config:remove-recent', (_, path: string): RecentEntry[] => {
    const recents = config()
      .get()
      .recents.filter((item) => item.path !== path)
    broadcastConfig({ ...config().update({ recents }) })
    return recents
  })

  ipcMain.handle('config:clear-recents', (): RecentEntry[] => {
    broadcastConfig({ ...config().update({ recents: [] }) })
    return []
  })

  ipcMain.handle('window:new', (_, projectPath?: string, tabs?: TabState[]) => {
    createProjectWindow({
      projectPath: projectPath ?? null,
      tabs: Array.isArray(tabs)
        ? tabs.filter((tab) => typeof tab?.name === 'string' && typeof tab?.path === 'string')
        : []
    })
  })

  // macOS only: the renderer hides its own menu bar there and pushes the tree
  // here instead, re-sending whenever a label or enabled state changes.
  ipcMain.on('menu:set-template', (event, template: NativeMenuTemplate) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) setWindowMenu(win, template)
  })

  ipcMain.on('window:close', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) win.close()
  })

  // The renderer's verdict on the `window:confirm-close` it was just sent.
  ipcMain.on('window:close-confirmed', (event, proceed: boolean) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    if (!proceed) {
      // Backing out of the close also backs out of any quit it was part of, and
      // of the session snapshot that quit took — the windows staying open are
      // not the set that was about to be persisted.
      quitRequested = false
      quitSessionCaptured = false
      return
    }
    closeApproved.add(win.id)
    win.close()
    // The veto above cancelled the quit; restart it now that this window is gone.
    if (quitRequested) app.quit()
  })

  ipcMain.on('window:minimize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) win.minimize()
  })

  ipcMain.on('window:maximize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) {
      if (win.isMaximized()) {
        win.unmaximize()
      } else {
        win.maximize()
      }
    }
  })

  // Undocked, matching the F12 path `optimizer.watchWindowShortcuts` provides in
  // dev — the tools take half a frameless window otherwise.
  ipcMain.on('window:toggle-dev-tools', (event) => {
    const { sender } = event
    if (sender.isDevToolsOpened()) sender.closeDevTools()
    else sender.openDevTools({ mode: 'undocked' })
  })

  // Read from the packaged app, not package.json: in dev those agree, and in a
  // build the bundle version is the one the user actually has.
  ipcMain.handle('app:version', (): string => app.getVersion())
  ipcMain.handle('app:open-source-code', () =>
    shell.openExternal('https://github.com/goat-hill/goatcad')
  )
  // openPath resolves to an error message, empty on success.
  ipcMain.handle(
    'app:open-third-party-notices',
    async (): Promise<boolean> => (await shell.openPath(thirdPartyNotices)) === ''
  )
  ipcMain.handle('updater:can-check', (): boolean => canCheckForUpdates())
  ipcMain.handle('updater:check', () => checkForUpdatesNow())
  registerFeedbackIpc()

  // File explorer directory picker
  ipcMain.handle('dialog:open-directory', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) {
      return null
    }
    const projectPath = result.filePaths[0]
    const files = readDirectoryRecursive(projectPath)
    return {
      path: projectPath,
      name: basename(projectPath),
      files
    }
  })

  // Project picker: choose the design, not the folder. The containing directory
  // becomes the workspace, exactly as `dialog:open-directory` would produce it —
  // the only difference is that the active project is named rather than
  // detected, which is what makes this worth having where a folder holds several
  // (docs/projects.md §3).
  ipcMain.handle('dialog:open-project', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      title: 'Open Project',
      properties: ['openFile'],
      filters: [{ name: 'KiCad Projects', extensions: ['kicad_pro'] }]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const projectFilePath = result.filePaths[0]
    const workspacePath = dirname(projectFilePath)
    return {
      projectFilePath,
      path: workspacePath,
      name: basename(workspacePath),
      files: readDirectoryRecursive(workspacePath)
    }
  })

  // Single-file picker. Mirrors an OS file-open: the containing directory
  // becomes the project folder (see launchArgs), so the renderer gets both the
  // file to open and the project listing around it.
  ipcMain.handle('dialog:open-file', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      title: 'Open File',
      properties: ['openFile'],
      filters: [
        {
          name: 'KiCad Design Files',
          extensions: KICAD_EXTENSIONS.map((ext) => ext.slice(1))
        },
        { name: 'All Files', extensions: ['*'] }
      ]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const filePath = result.filePaths[0]
    const projectPath = dirname(filePath)
    return {
      filePath,
      fileName: basename(filePath),
      projectPath,
      projectName: basename(projectPath),
      files: readDirectoryRecursive(projectPath)
    }
  })

  // Lightweight 3D-model file picker for the footprint model link. Returns the
  // chosen absolute path only (no project treatment); null when canceled.
  ipcMain.handle('dialog:pick-model-file', async (event, defaultPath?: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      title: 'Select 3D Model',
      defaultPath,
      properties: ['openFile'],
      filters: [
        { name: '3D Models', extensions: ['step', 'stp', 'wrl'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })

  // Plain directory picker for settings paths. Unlike `dialog:open-directory`,
  // the choice is not treated as a project — no recursive file scan, no window
  // retargeting. Returns the absolute path only; null when canceled.
  ipcMain.handle('dialog:pick-directory', async (event, title?: string, defaultPath?: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      title,
      defaultPath,
      properties: ['openDirectory']
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })

  // Save As target picker. Returns the chosen path only; the renderer decides
  // what to write there (it owns the live editor content).
  ipcMain.handle('dialog:save-file', async (event, defaultPath?: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return null
    const result = await dialog.showSaveDialog(win, {
      title: 'Save As',
      defaultPath,
      properties: ['createDirectory', 'showOverwriteConfirmation']
    })
    return result.canceled || !result.filePath ? null : result.filePath
  })

  // Save / Don't Save / Cancel for unsaved tabs, as a real OS message box. The
  // copy arrives translated because `t()` lives in the renderer and main has no
  // vue-i18n (the same split the native app menu uses).
  ipcMain.handle(
    'dialog:confirm-unsaved',
    async (event, prompt: UnsavedPrompt): Promise<UnsavedChoice> => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) return 'cancel'
      const order = unsavedButtonOrder(process.platform)
      const label: Record<UnsavedChoice, string> = {
        save: prompt.save,
        dontSave: prompt.dontSave,
        cancel: prompt.cancel
      }
      const { response } = await dialog.showMessageBox(win, {
        type: 'warning',
        message: prompt.message,
        detail: prompt.detail,
        buttons: order.map((choice) => label[choice]),
        defaultId: order.indexOf('save'),
        cancelId: order.indexOf('cancel'),
        // Windows would otherwise render three buttons as command links.
        noLink: true
      })
      return order[response] ?? 'cancel'
    }
  )

  // New-project picker + scaffold. A folder that already holds a .kicad_pro is
  // opened as-is; otherwise the renderer writes the minimal file set
  // (renderer/src/lib/project/scaffold.ts).
  ipcMain.handle('dialog:create-project', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      title: 'Choose a Folder for the New Project',
      buttonLabel: 'Create Project',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const projectPath = result.filePaths[0]
    // Only the folder is chosen here. The renderer writes the file set, because
    // the templates serialize through the S-expression writer, which lives on
    // that side (docs/projects.md §6) — scaffolding here
    // too would mean a second copy of every template.
    return {
      path: projectPath,
      name: basename(projectPath),
      files: readDirectoryRecursive(projectPath)
    }
  })

  // Sample projects (sampleProjects.ts). Only reached from the sample picker,
  // so no request leaves the app until the user asks for a sample. `open`
  // accepts only a folder from the catalog main itself fetched — the renderer
  // names a sample, never a URL or a path.
  let sampleCatalog: SampleCatalog | null = null
  ipcMain.handle('samples:list', async (): Promise<SampleListResult> => {
    const result = await fetchSampleCatalog(outboundFetch)
    if (result.ok) sampleCatalog = result.catalog
    return result
  })
  ipcMain.handle(
    'samples:open',
    (_, dir: unknown): Promise<SampleOpenResult> | SampleOpenResult => {
      const sample = sampleCatalog?.samples.find((entry) => entry.dir === dir)
      if (!sampleCatalog || !sample) return { ok: false, error: 'unavailable' }
      return downloadSample(
        outboundFetch,
        sample,
        sampleCatalog.sha,
        join(app.getPath('temp'), 'GoatCAD Samples')
      )
    }
  )

  ipcMain.handle('fs:read-directory', (_, dirPath) => {
    return readDirectoryRecursive(dirPath)
  })

  /**
   * Every `.kicad_pro` at or below `root`, to a bounded depth.
   *
   * The workspace is a folder; the project is a `.kicad_pro` inside it
   * (docs/projects.md). Depth is capped because a workspace can be a
   * whole repository and an unbounded walk on open is exactly the kind of
   * blocking work RULES.md §8 forbids — two levels covers the layouts that
   * actually occur (design variants sharing a directory, a sub-board nested
   * inside its parent).
   */
  ipcMain.handle('project:find', (_, root: string, maxDepth = 2): string[] => {
    const found: string[] = []
    const walk = (dir: string, depth: number): void => {
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return // unreadable dir (permissions, races) — skip, don't fail the open
      }
      for (const entry of entries) {
        if (entry.isFile() && entry.name.toLowerCase().endsWith('.kicad_pro')) {
          found.push(join(dir, entry.name))
        } else if (entry.isDirectory() && depth < maxDepth && !isIgnoredDir(entry.name)) {
          walk(join(dir, entry.name), depth + 1)
        }
      }
    }
    walk(root, 0)
    return found
  })

  // File system read/write
  ipcMain.handle('fs:create-file', (_, filePath, content = '') => {
    try {
      fs.writeFileSync(filePath, content, 'utf8')
      return { success: true }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err)
      return { success: false, error: errMsg }
    }
  })

  ipcMain.handle('fs:read-file', async (_, filePath) => {
    try {
      // Async on purpose: a large board is tens of megabytes, and a sync read
      // here would freeze every window's IPC for its duration.
      const content = await fs.promises.readFile(filePath, 'utf8')
      return { success: true, content }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err)
      return { success: false, error: errMsg }
    }
  })

  // Rename/move. Refuses an existing target rather than clobbering it: the
  // renderer validates first, but a case-insensitive filesystem (macOS,
  // Windows) can still resolve two distinct-looking names onto one file, so
  // the guard has to live where the write happens. A case-only rename of the
  // *same* file is the one legal collision — fs.renameSync handles it.
  ipcMain.handle('fs:rename', (_, fromPath: string, toPath: string) => {
    try {
      const sameFile =
        fs.existsSync(toPath) &&
        fs.existsSync(fromPath) &&
        fs.statSync(toPath).ino === fs.statSync(fromPath).ino
      if (fs.existsSync(toPath) && !sameFile) {
        return { success: false, error: 'EEXIST' }
      }
      fs.renameSync(fromPath, toPath)
      return { success: true }
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // Delete to the OS trash, never unlink: file operations sit outside the
  // undo/redo command layer, so recovery is deliberately the OS's job
  // (docs/projects.md §7.4).
  ipcMain.handle('fs:delete', async (_, targetPath: string) => {
    try {
      await shell.trashItem(targetPath)
      return { success: true }
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('fs:mkdir', (_, dirPath: string) => {
    try {
      if (fs.existsSync(dirPath)) return { success: false, error: 'EEXIST' }
      fs.mkdirSync(dirPath, { recursive: true })
      return { success: true }
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // Copy a file or a whole directory, refusing an existing target for the same
  // reason `fs:rename` does. Its caller is Add Library's copy-into-the-project
  // option (docs/projects.md §7.5): a symbol library is one
  // `.kicad_sym`, a footprint library is a `.pretty` directory, so one channel
  // has to serve both.
  ipcMain.handle('fs:copy', async (_, fromPath: string, toPath: string) => {
    try {
      if (fs.existsSync(toPath)) return { success: false, error: 'EEXIST' }
      await fs.promises.cp(fromPath, toPath, { recursive: true, errorOnExist: true, force: false })
      return { success: true }
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('fs:exists', (_, targetPath: string) => fs.existsSync(targetPath))

  ipcMain.handle('fs:reveal', (_, targetPath: string) => {
    shell.showItemInFolder(targetPath)
  })

  // Fab-package export (fabrication-export-workstream.md): the files the
  // renderer built (lib/fabExport.ts) into one folder, plus a zip of those the
  // profile uploads together (dependency-free — see main/zip.ts).
  ipcMain.handle('fab:export', (_, payload: FabExportPayload): FabExportResult => {
    try {
      const names = [...payload.files.map((f) => f.name), payload.archive?.name ?? '']
      const bad = names.find((name) => name !== basename(name) || name === '..' || name === '.')
      if (bad !== undefined) return { success: false, error: `Not a file name: ${bad}` }
      fs.mkdirSync(payload.directory, { recursive: true })
      const written = payload.files.map((file) => {
        const path = join(payload.directory, file.name)
        fs.writeFileSync(path, file.content, 'utf8')
        return { path, bytes: Buffer.byteLength(file.content, 'utf8') }
      })
      let archive: FabExportResult['archive']
      if (payload.archive) {
        const held = new Set(payload.archive.files)
        const zip = buildZip(payload.files.filter((file) => held.has(file.name)))
        const path = join(payload.directory, payload.archive.name)
        fs.writeFileSync(path, zip)
        archive = { path, bytes: zip.length }
      }
      return {
        success: true,
        directory: payload.directory,
        written,
        ...(archive ? { archive } : {}),
        revealPath: archive?.path ?? written[0]?.path ?? payload.directory
      }
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // File metadata for the file-info tab (files GoatCAD declines to open).
  ipcMain.handle('fs:stat', (_, filePath) => {
    try {
      const stats = fs.statSync(filePath)
      return { success: true, size: stats.size, modifiedMs: stats.mtimeMs }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err)
      return { success: false, error: errMsg }
    }
  })

  // Binary read for the image viewer: the renderer builds a data: URL from
  // this (a file:// <img> src would be blocked by web security in dev, where
  // the page is served over http).
  ipcMain.handle('fs:read-file-base64', (_, filePath) => {
    try {
      const data = fs.readFileSync(filePath).toString('base64')
      return { success: true, data }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err)
      return { success: false, error: errMsg }
    }
  })

  // Binary write, the other half: an exported picture (the symbol editor's
  // PNG) arrives as base64 and lands as bytes. `fs:create-file` writes UTF-8
  // text, which would mangle it.
  ipcMain.handle('fs:write-file-base64', (_, filePath: unknown, data: unknown) => {
    if (typeof filePath !== 'string' || !filePath || typeof data !== 'string') {
      return { success: false, error: 'Invalid arguments' }
    }
    try {
      fs.writeFileSync(filePath, Buffer.from(data, 'base64'))
      return { success: true }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err)
      return { success: false, error: errMsg }
    }
  })

  // STEP tessellation (occt-import-js in a worker thread, see stepLoader.ts)
  ipcMain.handle('step:load', (_, filePath: string) => loadStepFile(filePath))

  // Resolve a footprint (model ...) path (env-var/absolute/relative) to a file
  // the renderer can load — see modelResolver.ts. Relative paths resolve against
  // the footprint file's own directory first, then the project.
  //
  // `${KICAD*_3DMODEL_DIR}` normally expands from the environment; when that var
  // is unset (the common case when GoatCAD isn't launched from KiCad's shell) we
  // stand in the detected install's `3dmodels/` dir, so library models resolve
  // with no configuration. An explicit `kicad3dModelDir` overrides it. Note the
  // 3D set is never downloaded (multi-GB — see the packages3d note below), so a
  // detected install is the only automatic source.
  //
  // Detection is cached rather than re-run per resolve: a footprint can reference
  // a model on every open, and detection stats several candidate install roots.
  // Like the standard library rows, the cache is *derived, never persisted* — it
  // refreshes at launch and whenever the provider changes, so a KiCad that moves
  // or is uninstalled can't leave a stale path behind (see resolveStandardLibraries).
  let detectedModelDir: string | null = null
  let detectedThirdPartyDir: string | null = null
  const refreshDetectedModelDir = (): void => {
    const deps = {
      platform: process.platform,
      existsSync: fs.existsSync,
      home: app.getPath('home')
    }
    try {
      detectedModelDir = detectSystemLibraries(deps)?.models3d ?? null
    } catch (err) {
      console.error('Failed to detect the KiCad 3D model directory', err)
      detectedModelDir = null
    }
    try {
      detectedThirdPartyDir = detectThirdPartyDir(deps)
    } catch (err) {
      console.error('Failed to detect the KiCad third-party directory', err)
      detectedThirdPartyDir = null
    }
  }

  ipcMain.handle(
    'model:resolve',
    (_, modelPath: string, footprintFilePath: string | null, projectPath: string | null) => {
      const footprintDir = footprintFilePath ? dirname(footprintFilePath) : null
      return resolveModelPath(modelPath, footprintDir, projectPath, {
        modelDir: config().get().kicad3dModelDir ?? detectedModelDir ?? undefined,
        thirdPartyDir: detectedThirdPartyDir ?? undefined
      })
    }
  )

  // Git via the system git binary (see gitStatus.ts): status, init, commit loop
  ipcMain.handle('git:status', (_, projectPath: string) => getGitStatus(projectPath))
  ipcMain.handle('git:init', (_, projectPath: string) => initRepo(projectPath))
  ipcMain.handle('git:stage', (_, projectPath: string, paths: string[]) =>
    stageFiles(projectPath, paths)
  )
  ipcMain.handle('git:unstage', (_, projectPath: string, paths: string[]) =>
    unstageFiles(projectPath, paths)
  )
  ipcMain.handle('git:discard', (_, projectPath: string, targets: GitDiscardTarget[]) =>
    discardChanges(projectPath, targets)
  )
  ipcMain.handle('git:commit', (_, projectPath: string, message: string) =>
    commitStaged(projectPath, message)
  )
  // Diff tab reads (gitContent.ts). The side and revision are allowlisted here:
  // they pick git arguments, so nothing else from the renderer reaches argv.
  ipcMain.handle('git:diff', (_, projectPath: string, req: GitDiffRequest) =>
    diffFile(projectPath, {
      path: String(req.path),
      side: req.side === 'staged' ? 'staged' : 'working',
      untracked: req.untracked === true,
      conflicted: req.conflicted === true,
      ...(typeof req.renamedFrom === 'string' ? { renamedFrom: req.renamedFrom } : {})
    })
  )
  ipcMain.handle('git:show', (_, projectPath: string, filePath: string, revision: string) =>
    showFile(projectPath, String(filePath), revision === 'index' ? 'index' : 'HEAD')
  )
  ipcMain.handle('git:ignore', (_, projectPath: string, filePath: string) =>
    ignorePath(projectPath, String(filePath))
  )
  ipcMain.handle('git:push', (_, projectPath: string) => pushBranch(projectPath))
  ipcMain.handle('git:pull', (_, projectPath: string) => pullBranch(projectPath))
  ipcMain.handle('git:branches', (_, projectPath: string) => listBranches(projectPath))
  ipcMain.handle('git:checkout', (_, projectPath: string, name: string, create: boolean) =>
    checkoutBranch(projectPath, name, create)
  )

  // The system clipboard, for surfaces that are not DOM text: the terminal's
  // selection is drawn on a canvas, so the browser's own copy/paste never sees
  // it. `primary` is X11/Wayland's middle-click selection, which every Linux
  // terminal fills on a drag; `clipboard.selection` does not exist elsewhere.
  ipcMain.handle('clipboard:read-text', () => clipboard.readText())
  ipcMain.on('clipboard:write-text', (_, text: string, primary = false) => {
    // `clipboard.selection` is the X11/Wayland PRIMARY buffer and exists only
    // there, so a non-Linux caller asking for it writes nothing rather than
    // silently landing in the system clipboard the user did not mean to touch.
    const target = primary ? (process.platform === 'linux' ? clipboard.selection : null) : clipboard
    void target?.writeText(text)
  })

  // --- Terminal tabs (ARCHITECTURE.md §3.12) -------------------------------
  // The renderer names a directory, never a command: what gets spawned is
  // `defaultShell()`'s login shell and nothing else, so this pair of channels
  // cannot become a way to run arbitrary argv from the page (RULES.md §9).
  ipcMain.handle('terminal:start', (event, cwd: string, kind: TerminalKind = 'shell') => {
    const dir = fs.existsSync(cwd) && fs.statSync(cwd).isDirectory() ? cwd : homedir()
    return terminals.start(dir, kind, event.sender.id)
  })
  ipcMain.handle('terminal:attach', (event, id: string) => terminals.attach(id, event.sender.id))
  ipcMain.handle('terminal:snapshot', (_, id: string) => terminals.snapshot(id))
  ipcMain.handle('terminal:dispose', (_, id: string) => terminals.dispose(id))
  ipcMain.handle('terminal:states', (_, ids: string[]) => terminals.states(ids))
  ipcMain.on('terminal:input', (_, id: string, data: string) => terminals.write(id, data))
  ipcMain.on('terminal:resize', (_, id: string, cols: number, rows: number) =>
    terminals.resize(id, cols, rows)
  )

  // Tab transfer across windows
  ipcMain.handle('tab:transfer', (_, sourceWindowId, targetWindowId, tabData) => {
    const sourceWin = windowMap.get(sourceWindowId)
    const targetWin = windowMap.get(targetWindowId)
    if (sourceWin) {
      sourceWin.webContents.send('tab:remove', tabData.path)
    }
    if (targetWin) {
      targetWin.webContents.send('tab:add', tabData)
    }
  })

  // Footprint Libraries settings management
  interface LibraryConfig {
    nickname: string
    path: string
    type: 'local' | 'remote'
    readOnly?: boolean
  }

  // Symbol library row (persisted shape of symbol-libraries.json entries).
  // `source: 'standard'` marks rows provisioned from the standard KiCad libraries
  // (detected install or download) so they can be replaced wholesale on re-provision.
  interface SymbolLibraryRow {
    nickname: string
    path: string
    type: 'local'
    readOnly?: boolean
    source?: 'standard'
  }

  const getLibTablePath = (): string => join(app.getPath('userData'), 'libraries.json')

  /**
   * Read one of the `userData` library tables. Null on an unreadable or corrupt
   * file so a caller can leave it alone rather than overwrite it; a valid file
   * whose `libraries` was hand-edited away normalizes to an empty list.
   */
  const readJsonTable = <T>(path: string): { libraries: T[] } | null => {
    try {
      const parsed = JSON.parse(fs.readFileSync(path, 'utf8')) as { libraries?: T[] }
      return { libraries: Array.isArray(parsed.libraries) ? parsed.libraries : [] }
    } catch (err) {
      console.error(`Failed to read ${basename(path)}`, err)
      return null
    }
  }

  ipcMain.handle('libraries:get-table', () => {
    const configPath = getLibTablePath()
    if (!fs.existsSync(configPath)) {
      return { libraries: [] }
    }
    try {
      const data = fs.readFileSync(configPath, 'utf8')
      return JSON.parse(data)
    } catch (err) {
      console.error('Failed to read libraries.json', err)
      return { libraries: [] }
    }
  })

  ipcMain.handle('libraries:save-table', (_, tableData) => {
    const configPath = getLibTablePath()
    try {
      const next = JSON.stringify(tableData, null, 2)
      const prev = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : null
      fs.writeFileSync(configPath, next, 'utf8')
      // A user add/remove of a footprint library changes what the index covers.
      if (prev !== next) refreshSystemIndex()
      return { success: true }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err)
      return { success: false, error: errMsg }
    }
  })

  ipcMain.handle('libraries:scan-directory', async (_, dirPath) => {
    try {
      if (!fs.existsSync(dirPath)) return []

      const results: { category: string; footprints: { name: string; path: string }[] }[] = []

      // Check if the directory itself has .kicad_mod files
      const rootItems = await fs.promises.readdir(dirPath, { withFileTypes: true })
      const directFootprints: { name: string; path: string }[] = []
      for (const item of rootItems) {
        if (!item.isDirectory() && item.name.toLowerCase().endsWith('.kicad_mod')) {
          directFootprints.push({
            name: item.name,
            path: join(dirPath, item.name)
          })
        }
      }
      if (directFootprints.length > 0) {
        const folderName = basename(dirPath)
        const catName = folderName.toLowerCase().endsWith('.pretty')
          ? folderName.slice(0, -7)
          : folderName
        results.push({
          category: catName,
          footprints: directFootprints
        })
      }

      // Check subdirectories (especially .pretty ones) in parallel
      const subDirPromises = rootItems
        .filter((item) => item.isDirectory())
        .map(async (item) => {
          const subDirPath = join(dirPath, item.name)
          try {
            const subItems = await fs.promises.readdir(subDirPath, { withFileTypes: true })
            const subFootprints: { name: string; path: string }[] = []
            for (const subItem of subItems) {
              if (!subItem.isDirectory() && subItem.name.toLowerCase().endsWith('.kicad_mod')) {
                subFootprints.push({
                  name: subItem.name,
                  path: join(subDirPath, subItem.name)
                })
              }
            }
            if (subFootprints.length > 0) {
              const catName = item.name.toLowerCase().endsWith('.pretty')
                ? item.name.slice(0, -7)
                : item.name
              return {
                category: catName,
                footprints: subFootprints
              }
            }
          } catch (err) {
            console.error(`Failed to scan subdirectory ${subDirPath}`, err)
          }
          return null
        })

      const subDirResults = await Promise.all(subDirPromises)
      for (const res of subDirResults) {
        if (res) {
          results.push(res)
        }
      }

      return results
    } catch (err) {
      console.error(`Failed to scan local library directory ${dirPath}`, err)
      return []
    }
  })

  // --- Standard KiCad library provisioning (see docs/libraries-workstream.md).
  // Two ways to provide the standard symbol/footprint libraries: reuse a detected
  // local KiCad install, or download a version-pinned copy. Both register
  // read-only rows. Footprints become the single `KiCad_Official` entry (a dir of
  // `.pretty`s); symbols scan into per-file `source: 'standard'` rows. 3D is
  // deferred (multi-GB, and nothing resolves ${KICAD10_3DMODEL_DIR} yet).

  const getSymbolTablePathForProvisioning = (): string =>
    join(app.getPath('userData'), 'symbol-libraries.json')

  // Point the read-only KiCad_Official footprint entry at a `.pretty`-containing
  // directory (an extracted download or a system install's footprints dir).
  const registerStandardFootprints = (footprintsDir: string): void => {
    const configPath = getLibTablePath()
    let table = { libraries: [] as LibraryConfig[] }
    if (fs.existsSync(configPath)) {
      try {
        table = JSON.parse(fs.readFileSync(configPath, 'utf8'))
      } catch (e) {
        console.error(e)
      }
    }
    // Valid JSON without a `libraries` array (hand-edited) must not throw.
    if (!Array.isArray(table.libraries)) table.libraries = []
    table.libraries = table.libraries.filter((l) => l.nickname !== 'KiCad_Official')
    table.libraries.push({
      nickname: 'KiCad_Official',
      path: footprintsDir,
      type: 'local',
      readOnly: true
    })
    fs.writeFileSync(configPath, JSON.stringify(table, null, 2), 'utf8')
  }

  // Scan a directory of `.kicad_sym` files and register each as a read-only
  // standard row, replacing any prior `source: 'standard'` rows so switching
  // provider/version is clean. Returns how many libraries were registered.
  const registerStandardSymbols = (symbolsDir: string): number => {
    const configPath = getSymbolTablePathForProvisioning()
    let table = { libraries: [] as SymbolLibraryRow[] }
    if (fs.existsSync(configPath)) {
      try {
        table = JSON.parse(fs.readFileSync(configPath, 'utf8'))
      } catch (e) {
        console.error(e)
      }
    }
    // Valid JSON without a `libraries` array (hand-edited) must not throw.
    if (!Array.isArray(table.libraries)) table.libraries = []
    table.libraries = table.libraries.filter((l) => l.source !== 'standard')
    let count = 0
    for (const item of fs.readdirSync(symbolsDir, { withFileTypes: true })) {
      if (item.isDirectory() || !item.name.toLowerCase().endsWith('.kicad_sym')) continue
      table.libraries.push({
        nickname: item.name.slice(0, -'.kicad_sym'.length),
        path: join(symbolsDir, item.name),
        type: 'local',
        readOnly: true,
        source: 'standard'
      })
      count++
    }
    fs.writeFileSync(configPath, JSON.stringify(table, null, 2), 'utf8')
    return count
  }

  const downloadSetTarball = (set: LibrarySet, destDir: string): Promise<void> => {
    const url = tarballUrl(set)
    return new Promise((resolve, reject) => {
      const request = (u: string): void => {
        https
          .get(u, (response) => {
            if (response.statusCode === 301 || response.statusCode === 302) {
              const redirectUrl = response.headers.location
              if (redirectUrl) {
                request(redirectUrl)
                return
              }
            }
            if (response.statusCode !== 200) {
              reject(new Error(`Failed to download ${set}: HTTP ${response.statusCode}`))
              return
            }
            response
              .pipe(tar.x({ cwd: destDir }))
              .on('finish', () => resolve())
              .on('error', (err: unknown) => reject(err))
          })
          .on('error', (err) => reject(err))
      }
      request(url)
    })
  }

  // Drop the standard rows from both tables (undoes register* above). The
  // provider mode is the source of truth; these rows are its cache.
  const clearStandardRows = (): void => {
    const symPath = getSymbolTablePathForProvisioning()
    if (fs.existsSync(symPath)) {
      try {
        const t = JSON.parse(fs.readFileSync(symPath, 'utf8')) as { libraries: SymbolLibraryRow[] }
        t.libraries = (t.libraries ?? []).filter((l) => l.source !== 'standard')
        fs.writeFileSync(symPath, JSON.stringify(t, null, 2), 'utf8')
      } catch (e) {
        console.error(e)
      }
    }
    const fpPath = getLibTablePath()
    if (fs.existsSync(fpPath)) {
      try {
        const t = JSON.parse(fs.readFileSync(fpPath, 'utf8')) as { libraries: LibraryConfig[] }
        t.libraries = (t.libraries ?? []).filter((l) => l.nickname !== 'KiCad_Official')
        fs.writeFileSync(fpPath, JSON.stringify(t, null, 2), 'utf8')
      } catch (e) {
        console.error(e)
      }
    }
  }

  ipcMain.handle('libraries:download-official', async (event, sets?: LibrarySet[]) => {
    const requested: LibrarySet[] = sets && sets.length ? sets : ['footprints']
    const cacheDir = join(app.getPath('userData'), 'cache', 'KiCad_Official')
    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true })

    try {
      const registered: string[] = []
      for (const set of requested) {
        // 3D (packages3d) intentionally skipped for now — see note above.
        if (set !== 'symbols' && set !== 'footprints') continue
        event.sender.send(
          'libraries:download-progress',
          `Downloading KiCad ${set} library (${KICAD_LIB_VERSION})…`
        )
        await downloadSetTarball(set, cacheDir)
        const extracted = join(cacheDir, extractedDirName(set))
        if (set === 'footprints') {
          registerStandardFootprints(extracted)
          registered.push('footprints')
        } else {
          const n = registerStandardSymbols(extracted)
          registered.push(`${n} symbol libraries`)
        }
      }
      if (registered.length) {
        config().update({ standardLibraryProvider: 'downloaded' })
        rebuildSystemIndex() // the downloaded libraries changed what's indexed
      }
      return { success: true, registered }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err)
      return { success: false, error: errMsg }
    }
  })

  // Detect a local KiCad install's standard libraries (null when none found).
  // Used by the Libraries manager to show the auto-detection status.
  ipcMain.handle('libraries:detect-system', () =>
    detectSystemLibraries({
      platform: process.platform,
      existsSync: fs.existsSync,
      home: app.getPath('home')
    })
  )

  // Generic directory listing (used to browse the 3D-models tree: `.3dshapes`
  // packages, then the `.step`/`.wrl` files inside). Sorted, dirs first.
  ipcMain.handle('libraries:list-dir', async (_event, dirPath: string) => {
    try {
      if (!dirPath || !fs.existsSync(dirPath)) return []
      const items = await fs.promises.readdir(dirPath, { withFileTypes: true })
      return items
        .map((item) => ({
          name: item.name,
          path: join(dirPath, item.name),
          isDir: item.isDirectory()
        }))
        .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))
    } catch (err) {
      console.error(`Failed to list directory ${dirPath}`, err)
      return []
    }
  })

  // Resolve the standard libraries from the provider mode. Runs on EVERY launch
  // (and after a mode change), so installing/uninstalling KiCad is picked up
  // automatically — no manual "use installed" step. `auto` (the default) adopts a
  // detected install read-only, or clears the rows when none is found.
  // `downloaded` uses the version-pinned cache and falls back to `auto` if the
  // cache is gone. Standard rows are always a cache of this resolution.
  const resolveStandardLibraries = (): void => {
    // 3D models are never downloaded, so this runs for both provider modes.
    refreshDetectedModelDir()
    if (config().get().standardLibraryProvider === 'downloaded') {
      const cacheDir = join(app.getPath('userData'), 'cache', 'KiCad_Official')
      const symDir = join(cacheDir, extractedDirName('symbols'))
      const fpDir = join(cacheDir, extractedDirName('footprints'))
      if (fs.existsSync(symDir) || fs.existsSync(fpDir)) {
        if (fs.existsSync(fpDir)) registerStandardFootprints(fpDir)
        if (fs.existsSync(symDir)) registerStandardSymbols(symDir)
        return
      }
      // Cache vanished (e.g. reset) — fall back to auto-detection.
      config().update({ standardLibraryProvider: 'auto' })
    }
    const det = detectSystemLibraries({
      platform: process.platform,
      existsSync: fs.existsSync,
      home: app.getPath('home')
    })
    if (det && (det.footprints || det.symbols)) {
      if (det.footprints) registerStandardFootprints(det.footprints)
      if (det.symbols) registerStandardSymbols(det.symbols)
    } else {
      clearStandardRows()
    }
  }

  // --- The user's *own* KiCad libraries (projects.md §7.5).
  // Provisioning above adopts the standard set; this adopts the rows they added
  // to KiCad themselves, which live only in KiCad's global tables. Read once —
  // a live mirror would mean owning KiCad's config as a write target, and would
  // resurrect rows deliberately removed here.

  /** Read and parse one of KiCad's global tables; [] when absent or unreadable. */
  const readKicadGlobalTable = (configDir: string, fileName: string): SeedRow[] => {
    const detected = detectSystemLibraries({
      platform: process.platform,
      existsSync: fs.existsSync,
      home: app.getPath('home')
    })
    const tablePath = join(configDir, fileName)
    if (!fs.existsSync(tablePath)) return []
    let source: string
    try {
      source = fs.readFileSync(tablePath, 'utf8')
    } catch {
      return []
    }
    return seedRowsFromTable(parseSymLibTableLite(source), {
      symbolDir: detected?.symbols,
      footprintDir: detected?.footprints,
      thirdPartyDir:
        detectThirdPartyDir({
          platform: process.platform,
          existsSync: fs.existsSync,
          home: app.getPath('home')
        }) ?? undefined,
      home: app.getPath('home')
    })
  }

  /**
   * Import both tables into our own global rows. Idempotent — `mergeSeedRows`
   * keys on path — so the Settings re-run picks up libraries added to KiCad
   * since without duplicating the ones already here. Returns rows added.
   */
  const seedFromKicadGlobalTables = (): { added: number; configDir: string | null } => {
    const configDir = detectKicadConfigDir({
      platform: process.platform,
      existsSync: fs.existsSync,
      home: app.getPath('home')
    })
    if (!configDir) return { added: 0, configDir: null }
    let added = 0

    const symbolSeeds = readKicadGlobalTable(configDir, 'sym-lib-table')
    if (symbolSeeds.length) {
      const symPath = getSymbolTablePathForProvisioning()
      const table = fs.existsSync(symPath)
        ? (readJsonTable<SymbolLibraryRow>(symPath) ?? { libraries: [] })
        : { libraries: [] as SymbolLibraryRow[] }
      const merged = mergeSeedRows(table.libraries, symbolSeeds, (row) => ({
        ...row,
        type: 'local' as const
      }))
      if (merged) {
        fs.writeFileSync(symPath, JSON.stringify({ libraries: merged }, null, 2), 'utf8')
        added += merged.length - table.libraries.length
      }
    }

    const footprintSeeds = readKicadGlobalTable(configDir, 'fp-lib-table')
    if (footprintSeeds.length) {
      const fpPath = getLibTablePath()
      const table = fs.existsSync(fpPath)
        ? (readJsonTable<LibraryConfig>(fpPath) ?? { libraries: [] })
        : { libraries: [] as LibraryConfig[] }
      const merged = mergeSeedRows(table.libraries, footprintSeeds, (row) => ({
        ...row,
        type: 'local' as const
      }))
      if (merged) {
        fs.writeFileSync(fpPath, JSON.stringify({ libraries: merged }, null, 2), 'utf8')
        added += merged.length - table.libraries.length
      }
    }

    if (added > 0) refreshSystemIndex()
    return { added, configDir }
  }

  // Revert to automatic detection (Manage Libraries → discard a download). Clears
  // any downloaded rows, then re-resolves so an installed KiCad is re-adopted.
  ipcMain.handle('libraries:reset-standard', () => {
    try {
      clearStandardRows()
      config().update({ standardLibraryProvider: 'auto' })
      resolveStandardLibraries()
      rebuildSystemIndex() // standard libraries changed
      return { success: true }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err)
      return { success: false, error: errMsg }
    }
  })

  // Adopt an installed KiCad / clear stale rows on every launch. A corrupt
  // library table (or unreadable disk) must degrade to "no standard libraries",
  // never abort the IPC registrations below. Stays synchronous and stays here:
  // the index warm below builds off the tables it writes.
  try {
    resolveStandardLibraries()
  } catch (err) {
    console.error('Failed to resolve standard libraries at launch', err)
  }

  // Library index (search + associations) — built in a worker off the resolved
  // standard-library tables above. Warms its cache on launch.
  registerLibraryIndexIpc()

  // Distributor part search (docs/parts-sourcing-workstream.md). Nothing runs
  // until the renderer asks: no credentials means no network, and the service
  // itself is constructed lazily on the first call.
  registerPartsIpc()

  // The MCP server for agent-driven part search.
  // Started for the process, not per window, and non-fatal: a taken port means
  // no agent surface, never a launch failure.
  registerPartsMcpIpc()
  // Which project an agent is asking about: the focused window's, falling back
  // to any window with one open. Wrong the moment two windows hold different
  // boards — a `project` argument is the fix (workstream §8.5) — but right for
  // the ordinary case of one project at a time.
  setProjectResolver(() => {
    const focused = BrowserWindow.getFocusedWindow()
    const preferred = focused ? sessionState.get(focused.id)?.projectPath : null
    if (preferred) return preferred
    for (const win of BrowserWindow.getAllWindows()) {
      const path = sessionState.get(win.id)?.projectPath
      if (path) return path
    }
    return null
  })
  // Nothing to reconcile after it starts: an agent tab is told the live URL
  // and token when it launches.
  // A harness instance beside a running GoatCAD needs its own port, as it has
  // its own userData (bin/screenshot passes 0, an ephemeral one).
  const harnessPort = process.env.GOATCAD_MCP_PORT ? Number(process.env.GOATCAD_MCP_PORT) : NaN
  const mcpPort = Number.isInteger(harnessPort) && harnessPort >= 0 ? harnessPort : undefined
  void startPartsMcp(mcpPort).then((result) => {
    if (!result.ok) console.warn(`[parts-mcp] not started: ${result.reason}`)
  })

  // --- What we probe about this machine (main/launchChecks.ts). Registered as a
  // set so they can be re-run from Settings without a restart — the case that
  // matters is installing KiCad *after* GoatCAD.
  registerSystemChecks(
    {
      id: 'standard-libraries',
      run: () => {
        resolveStandardLibraries()
        const detected = detectSystemLibraries({
          platform: process.platform,
          existsSync: fs.existsSync,
          home: app.getPath('home')
        })
        return { detail: detected?.root ?? null }
      }
    },
    {
      id: 'kicad-global-tables',
      run: () => {
        const { added, configDir } = seedFromKicadGlobalTables()
        // Marked on *finding the config*, not on importing anything: a KiCad
        // whose global table holds only standard rows is fully handled, and
        // re-running would resurrect rows the user removed here. A machine with
        // no KiCad stays unmarked, so installing one later still seeds.
        if (configDir) config().update({ kicadGlobalTablesSeeded: true })
        return { detail: configDir, added }
      }
    }
  )

  ipcMain.handle('system:run-checks', () => runSystemChecks())

  // Deliberately not awaited, and narrowed to the seed: the standard libraries
  // were resolved synchronously above, and reading someone's KiCad config should
  // never sit between them and their first window.
  if (!config().get().kicadGlobalTablesSeeded) {
    void runSystemChecks(['kicad-global-tables']).catch((err) =>
      console.error('System checks failed', err)
    )
  }

  // Symbol Libraries settings management.
  //
  // The symbol sibling of the footprint library table above. A symbol library
  // is a single `.kicad_sym` file (unlike a footprint `.pretty` directory), so
  // an entry's `path` points at a file. This layer is file-IO only: parsing the
  // `.kicad_sym`/`sym-lib-table` s-expressions happens in the renderer, which
  // already owns the KiCad grammar (lib/kicad/*). The persisted shape is
  // `{ libraries: [{ nickname, path, type: 'local' }] }` (see the preload
  // SymbolLibraryConfig typing).
  const getSymbolLibTablePath = (): string => join(app.getPath('userData'), 'symbol-libraries.json')

  ipcMain.handle('symbol-libraries:get-table', () => {
    const configPath = getSymbolLibTablePath()
    if (!fs.existsSync(configPath)) {
      return { libraries: [] }
    }
    try {
      return JSON.parse(fs.readFileSync(configPath, 'utf8'))
    } catch (err) {
      console.error('Failed to read symbol-libraries.json', err)
      return { libraries: [] }
    }
  })

  ipcMain.handle('symbol-libraries:save-table', (_, tableData) => {
    const configPath = getSymbolLibTablePath()
    try {
      const next = JSON.stringify(tableData, null, 2)
      const prev = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : null
      fs.writeFileSync(configPath, next, 'utf8')
      // A user add/remove of a symbol library changes what the index covers.
      if (prev !== next) refreshSystemIndex()
      return { success: true }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err)
      return { success: false, error: errMsg }
    }
  })

  // Enumerate the `.kicad_sym` files under a directory (KiCad's standard symbol
  // libraries are a flat folder of them). Each file is one library; the nickname
  // defaults to the file stem, matching KiCad's own convention.
  ipcMain.handle('symbol-libraries:scan-directory', async (_, dirPath) => {
    try {
      if (!fs.existsSync(dirPath)) return []
      const items = await fs.promises.readdir(dirPath, { withFileTypes: true })
      return items
        .filter((item) => !item.isDirectory() && item.name.toLowerCase().endsWith('.kicad_sym'))
        .map((item) => ({
          nickname: item.name.slice(0, -'.kicad_sym'.length),
          path: join(dirPath, item.name)
        }))
    } catch (err) {
      console.error(`Failed to scan symbol library directory ${dirPath}`, err)
      return []
    }
  })

  ipcMain.handle('symbol-libraries:read-library', async (_, filePath) => {
    try {
      if (!fs.existsSync(filePath)) {
        return { success: false, error: `Symbol library not found: ${filePath}` }
      }
      const content = await fs.promises.readFile(filePath, 'utf8')
      return { success: true, content }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err)
      return { success: false, error: errMsg }
    }
  })

  // Read the project-tier `sym-lib-table` (KiCad's own S-expr file) that lives
  // next to a `.kicad_pro`. `projectPath` may be the project file or its
  // directory. Returns raw text for the renderer to parse, or null when absent.
  ipcMain.handle('symbol-libraries:read-project-table', async (_, projectPath) => {
    try {
      const dir =
        fs.existsSync(projectPath) && fs.statSync(projectPath).isDirectory()
          ? projectPath
          : dirname(projectPath)
      const tablePath = join(dir, 'sym-lib-table')
      if (!fs.existsSync(tablePath)) return { content: null, dir }
      const content = await fs.promises.readFile(tablePath, 'utf8')
      return { content, dir }
    } catch (err) {
      console.error(`Failed to read project sym-lib-table for ${projectPath}`, err)
      return { content: null, dir: null }
    }
  })

  // Project-tier library tables, both kinds. `symbol-libraries:read-project-table`
  // above is the symbol-only reader the chooser already uses; these serve the
  // add-library flow, which needs footprints too and needs to write.
  const projectTablePath = (
    projectPath: string,
    fileName: string
  ): { dir: string; file: string } => {
    const dir =
      fs.existsSync(projectPath) && fs.statSync(projectPath).isDirectory()
        ? projectPath
        : dirname(projectPath)
    return { dir, file: join(dir, fileName) }
  }

  ipcMain.handle(
    'libraries:read-project-table',
    async (_, projectPath: string, fileName: string) => {
      try {
        const { dir, file } = projectTablePath(projectPath, fileName)
        if (!fs.existsSync(file)) return { content: null, dir }
        return { content: await fs.promises.readFile(file, 'utf8'), dir }
      } catch (err) {
        console.error(`Failed to read project ${fileName} for ${projectPath}`, err)
        return { content: null, dir: null }
      }
    }
  )

  ipcMain.handle(
    'libraries:write-project-table',
    async (_, projectPath: string, fileName: string, content: string) => {
      try {
        const { file } = projectTablePath(projectPath, fileName)
        await fs.promises.writeFile(file, content, 'utf8')
        return { success: true }
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  // Symbol-library picker, filtered to `.kicad_sym` so the dialog itself says
  // what to look for. (A *footprint* library is a `.pretty` directory, not a
  // file, so it uses the directory picker instead.)
  ipcMain.handle('dialog:pick-symbol-library-file', async (event, title?: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      title: title || 'Choose a Symbol Library File',
      buttonLabel: 'Add Library',
      properties: ['openFile'],
      filters: [{ name: 'KiCad symbol library', extensions: ['kicad_sym'] }]
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })

  // Generic single-file picker. Unlike the purpose-named pickers above, the
  // caller supplies the filters — this exists for the data files an editor
  // imports (a pin table's CSV today) rather than for a project artifact, where
  // a named channel is worth it because main also decides what to do with the
  // choice. Returns the path only; the renderer reads it through `fs:read-file`.
  ipcMain.handle(
    'dialog:pick-file',
    async (
      event,
      options?: {
        title?: string
        buttonLabel?: string
        filters?: { name: string; extensions: string[] }[]
      }
    ) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) return null
      const result = await dialog.showOpenDialog(win, {
        title: options?.title,
        buttonLabel: options?.buttonLabel,
        properties: ['openFile'],
        ...(options?.filters ? { filters: options.filters } : {})
      })
      return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
    }
  )

  // Generic "pick one of these" message box, returning the chosen button index.
  // The copy arrives translated because `t()` lives in the renderer and main has
  // no vue-i18n — the same split `dialog:confirm-unsaved` uses. That handler
  // stays separate rather than folding into this one: it owns the per-platform
  // Save/Don't Save/Cancel button ORDER, which is a rule, not a caller's choice.
  ipcMain.handle(
    'dialog:choose',
    async (
      event,
      prompt: { message: string; detail?: string; buttons: string[]; cancelId?: number }
    ): Promise<number> => {
      const win = BrowserWindow.fromWebContents(event.sender)
      const cancelId = prompt.cancelId ?? prompt.buttons.length - 1
      if (!win) return cancelId
      const { response } = await dialog.showMessageBox(win, {
        type: 'question',
        message: prompt.message,
        detail: prompt.detail,
        buttons: prompt.buttons,
        defaultId: 0,
        cancelId,
        // Windows would otherwise render three buttons as command links.
        noLink: true
      })
      return response
    }
  )
}

// A second launch (including an OS file-open on Windows/Linux) hands its argv to
// the running instance instead of starting a rival copy. Everything below is
// registered only for the instance that owns the lock — a losing instance quits
// immediately and must not touch the config the primary instance owns.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })

  app.on('before-quit', () => {
    quitRequested = true
    // Quit with windows still open (Cmd+Q, app.quit()): snapshot them now and stop
    // the per-window close handlers from overwriting it with a shrinking set. When
    // the quit came from closing the last window there is nothing open to capture
    // and the close handler's snapshot is the one we want to keep. An unsaved-work
    // prompt makes this fire once per window as the quit is re-issued, so the
    // first snapshot — the only one that still sees every window — is the keeper.
    if (!quitSessionCaptured && BrowserWindow.getAllWindows().length > 0) {
      captureSession()
      quitSessionCaptured = true
    }
    terminals.disposeAll()
    void agentStatus.stop()
    config().flush()
    // The debounced cache/quota write, forced — a quit inside the debounce
    // window would otherwise lose the day's call count and hand back quota we
    // have already spent.
    flushParts()
    // Release the listener so the next launch finds its port free; the tools
    // are only meant to work while the app is open anyway.
    void stopPartsMcp()
  })

  app.on('second-instance', (_event, argv, workingDirectory) => {
    const files = parseFileArgs(argv, {
      isPackaged: app.isPackaged,
      cwd: workingDirectory,
      exists: fs.existsSync
    })
    if (files.length > 0) {
      openFilesInApp(files)
      return
    }
    const [win] = BrowserWindow.getAllWindows()
    if (win) focusWindow(win)
  })

  app.on('open-file', (event, filePath) => {
    event.preventDefault()
    if (!app.isReady()) {
      queuedOpenFiles.push(filePath)
      return
    }
    openFilesInApp([filePath])
  })

  start()
}
