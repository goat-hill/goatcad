import { app, shell, BrowserWindow, clipboard, ipcMain, nativeImage } from 'electron'
import { spawn } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { applyAppMenu } from './appMenu'
import { gitDiffOverview, listGitFiles, readGitPatch } from './gitDiff'
import { PtyManager } from './ptys'
import { getQuota } from './quota'
import {
  addWorktree,
  currentBranch,
  listWorktrees,
  removeWorktree,
  setWorktreeName
} from './worktrees'
import { HOOK_PORT, startStatusServer, writeClaudeHooksFile } from './statusServer'
import { popupTerminalMenu } from './terminalMenu'
import { listWorkspace } from './workspace'
import { registerWorkspaceProtocol, registerWorkspaceSchemePrivileges } from './mediaProtocol'

// Scheme privileges must be declared before the app is ready.
registerWorkspaceSchemePrivileges()

// develop/ lives inside the goatcad repo, so the managed repo is our parent directory.
const repoRoot = process.env.GOATHERD_REPO ?? resolve(app.getAppPath(), '..')

// Branch of the checkout this GoatHerd instance runs from — distinguishes the stable
// instance (master) from a dev instance launched out of a worktree.
let instanceBranch = ''

let mainWindow: BrowserWindow | null = null

// Live ptys keep emitting between window close and app quit; sending to a
// destroyed webContents throws, so drop events once the window is gone.
function sendToWindow(channel: string, ...args: unknown[]): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, ...args)
  }
}

const ptys = new PtyManager(sendToWindow)

// npm lives behind nvm on this machine (and `claude` may only be on the login PATH),
// so every session runs through bash with nvm sourced first.
function shellCommand(cmd: string): { file: string; args: string[] } {
  return {
    file: 'bash',
    args: ['-c', `[ -f "$HOME/.nvm/nvm.sh" ] && source "$HOME/.nvm/nvm.sh"; exec ${cmd}`]
  }
}

let nextWebPort = 4321
/** The port the status server bound; `HOOK_PORT` until it says otherwise. */
let hookPort = HOOK_PORT

// Claude Code keeps transcripts under ~/.claude/projects/<cwd with [/.] -> ->.
// If the worktree has any, a new Claude session resumes the latest conversation.
function hasClaudeTranscripts(worktree: string): boolean {
  const dir = join(homedir(), '.claude', 'projects', worktree.replace(/[/.]/g, '-'))
  try {
    return readdirSync(dir).some((name) => name.endsWith('.jsonl'))
  } catch {
    return false
  }
}

// A site dev server is only useful in a browser, so open one for the user. Wait for
// the server to announce its URL rather than probing the port we asked for: Astro
// falls forward to the next free port when ours is taken, and probing would then
// connect to — and open — whatever already owns it. The printed port is the truth,
// so it also corrects the tab's port link.
const DEV_SERVER_URL = /https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)/

function openBrowserWhenReady(ptyId: string, requestedPort: number): void {
  ptys.watchOutput(ptyId, (output) => {
    const port = Number(DEV_SERVER_URL.exec(output)?.[1])
    if (!port) return false
    if (port !== requestedPort) sendToWindow('pty:port', ptyId, port)
    void shell.openExternal(`http://127.0.0.1:${port}/`)
    return true
  })
}

function startSession(request: PtyStartRequest): PtyStartResult {
  const { worktree, branch, kind } = request
  switch (kind) {
    case 'claude': {
      // The hooks that drive the worktree's status dot ride along as a settings
      // file of this instance's own, so no ~/.claude/settings.json edit is needed
      // and a dev instance on another port gets its dots too (statusServer.ts).
      const hooks = writeClaudeHooksFile(join(app.getPath('userData'), 'hooks'), hookPort)
      const resume = hasClaudeTranscripts(worktree) ? 'claude --continue' : 'claude'
      const { file, args } = shellCommand(`${resume} --settings "${hooks}"`)
      return { id: ptys.start({ file, args, cwd: worktree }) }
    }
    case 'app': {
      const { file, args } = shellCommand('npm run dev')
      return {
        id: ptys.start({
          file,
          args,
          cwd: join(worktree, 'electron'),
          env: { ELECTRON_DISABLE_SANDBOX: '1', GOATCAD_WORKSTREAM: branch }
        })
      }
    }
    case 'web': {
      const port = nextWebPort++
      const { file, args } = shellCommand(`npm run dev -- --port ${port} --host 127.0.0.1`)
      const id = ptys.start({ file, args, cwd: join(worktree, 'web') })
      openBrowserWhenReady(id, port)
      return { id, port }
    }
    case 'goatherd': {
      // Dev instance of GoatHerd itself, on the alternate hook port so it doesn't
      // collide with the stable instance's status server (see README).
      const { file, args } = shellCommand('npm run dev')
      return {
        id: ptys.start({
          file,
          args,
          cwd: join(worktree, 'develop'),
          env: { ELECTRON_DISABLE_SANDBOX: '1', GOATHERD_HOOK_PORT: '47822' }
        })
      }
    }
    case 'setup': {
      const cmd =
        'bash -c "npm install --prefix electron && npm install --prefix web && npm install --prefix develop"'
      const { file, args } = shellCommand(cmd)
      return { id: ptys.start({ file, args, cwd: worktree }) }
    }
    case 'shell': {
      // Interactive login shell so the user's own config (nvm, aliases, …) applies.
      const userShell = process.env.SHELL ?? 'bash'
      return { id: ptys.start({ file: userShell, args: ['-l'], cwd: worktree }) }
    }
  }
}

// Ctrl/Cmd + (+/-/0) are Chromium's page-zoom accelerators. We don't want the
// whole frameless UI zooming; we want the embedded terminals to change font size.
// So intercept those keys before they reach the page, cancel the native zoom, and
// forward the intent to the renderer's font store. Shift is optional (Ctrl+= and
// Ctrl+Shift+= both zoom in), matching how terminals and VS Code behave.
//
// Not used on macOS: the View menu there registers these keys as accelerators
// (appMenu.ts) and sends the same message, and a key claimed by the system menu
// never reaches the page — running both would double every zoom step.
function interceptZoomShortcuts(window: BrowserWindow): void {
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.alt || !(input.control || input.meta)) return
    let action: 'in' | 'out' | 'reset' | null = null
    if (input.code === 'Equal' || input.code === 'NumpadAdd') action = 'in'
    else if (input.code === 'Minus' || input.code === 'NumpadSubtract') action = 'out'
    else if (input.code === 'Digit0' || input.code === 'Numpad0') action = 'reset'
    if (!action) return
    event.preventDefault()
    window.webContents.send('zoom', action)
  })
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 950,
    show: false,
    // Frameless; the renderer draws its own title bar (like GoatCAD). macOS is
    // the exception: `frame: false` would take the traffic lights with it, so
    // there we hide only the OS title bar and position the lights to sit in the
    // 34px bar the renderer draws (main.css `.titlebar`).
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hidden' as const, trafficLightPosition: { x: 12, y: 11 } }
      : { frame: false }),
    autoHideMenuBar: true,
    backgroundColor: '#14181f',
    title:
      instanceBranch && instanceBranch !== 'master' ? `GoatHerd — ${instanceBranch}` : 'GoatHerd',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  // Before first paint, so Electron's stock menu template never applies.
  applyAppMenu(mainWindow)

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // Tell the window whether it is the active one, so its title bar can back off
  // when it is not. A frameless window has no OS bar to gray out for it, and the
  // page's own focus events cannot answer this — they fire for the focused
  // element, which stays put while the window itself goes to the background.
  mainWindow.on('focus', () => sendToWindow('window:focus-changed', true))
  mainWindow.on('blur', () => sendToWindow('window:focus-changed', false))

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.goatcad.goatherd')

  // Packaged builds get the Dock icon from the bundle; `electron-vite dev` runs
  // inside Electron.app, so set it by hand or dev shows the Electron logo.
  if (is.dev && process.platform === 'darwin') {
    app.dock?.setIcon(nativeImage.createFromPath(icon))
  }

  app.on('browser-window-created', (_, window) => {
    // zoom: true tells the toolkit not to touch the Ctrl/Cmd +/- combos — we own
    // them below so we can forward the intent to the renderer instead of the
    // toolkit silently swallowing them (which killed the terminal-zoom hotkeys).
    optimizer.watchWindowShortcuts(window, { zoom: true })
    if (process.platform !== 'darwin') interceptZoomShortcuts(window)
  })

  instanceBranch = await currentBranch(repoRoot).catch(() => '')

  registerWorkspaceProtocol()

  ipcMain.handle('app:info', () => ({ repoRoot, hookPort: HOOK_PORT, instanceBranch }))
  ipcMain.handle('app:openExternal', (_event, url: string) => shell.openExternal(url))
  ipcMain.handle('app:openPath', (_event, path: string) => shell.openPath(path))
  ipcMain.handle('workspace:list', (_event, worktreePath: string) => listWorkspace(worktreePath))
  ipcMain.handle('app:openInVSCode', (_event, path: string) => {
    // `code` may only be on the login PATH; go through a login bash like the ptys do.
    spawn('bash', ['-lc', 'code .'], { cwd: path, detached: true, stdio: 'ignore' }).unref()
  })

  ipcMain.on('window:minimize', () => mainWindow?.minimize())
  ipcMain.on('window:maximize', () => {
    if (!mainWindow) return
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
  })
  ipcMain.on('window:close', () => mainWindow?.close())

  // macOS only: the View menu lives in the system bar there, and its font-size
  // readout is formatted by the renderer (which owns the default) and re-sent
  // on every zoom.
  ipcMain.on('menu:zoom-label', (_event, label: string) => {
    if (mainWindow) applyAppMenu(mainWindow, label)
  })

  ipcMain.handle('menu:terminalContext', (_event, hasSelection: boolean) =>
    mainWindow ? popupTerminalMenu(mainWindow, hasSelection) : null
  )

  // The system clipboard, for the terminals: their selection is drawn, not DOM
  // text, so the browser's own copy sees nothing, and since Electron 44 only
  // main has the `clipboard` module at all.
  ipcMain.handle('clipboard:read', () => clipboard.readText())
  ipcMain.handle('clipboard:write', (_event, text: string) => clipboard.writeText(text))
  ipcMain.on('clipboard:write-primary', (_event, text: string) => {
    // PRIMARY is an X11/Wayland notion — what middle-click pastes. The property
    // is undefined on platforms without such a buffer, hence both guards.
    if (process.platform === 'linux') void clipboard.selection?.writeText(text)
  })

  ipcMain.handle('wt:list', () => listWorktrees(repoRoot))
  ipcMain.handle('wt:add', (_event, branch: string) => addWorktree(repoRoot, branch))
  ipcMain.handle('wt:remove', (_event, path: string) => removeWorktree(repoRoot, path))
  ipcMain.handle('wt:rename', (_event, path: string, name: string) => setWorktreeName(path, name))

  ipcMain.handle('git:overview', (_event, worktree: string, base: string) =>
    gitDiffOverview(worktree, base)
  )
  ipcMain.handle('git:files', (_event, request: GitDiffRequest) => listGitFiles(request))
  ipcMain.handle('git:patch', (_event, request: GitPatchRequest) => readGitPatch(request))

  ipcMain.handle('pty:start', (_event, request: PtyStartRequest) => startSession(request))
  ipcMain.handle('pty:dispose', (_event, id: string) => ptys.dispose(id))
  ipcMain.handle('pty:snapshot', (_event, id: string) => ptys.snapshot(id))
  ipcMain.on('pty:input', (_event, id: string, data: string) => ptys.write(id, data))
  ipcMain.on('pty:resize', (_event, id: string, cols: number, rows: number) =>
    ptys.resize(id, cols, rows)
  )
  ipcMain.handle('pty:getProcess', (_event, id: string) => ptys.getProcess(id))

  ipcMain.handle('quota:get', (_event, force?: boolean) => getQuota(force))
  // Push fresh quota periodically; the renderer also pulls on demand.
  setInterval(() => {
    void getQuota().then((status) => sendToWindow('quota:update', status))
  }, 60 * 1000)

  const statusServer = startStatusServer((event) => {
    sendToWindow('claude:status', event)
  })
  // GOATHERD_HOOK_PORT=0 (screenshots, recordings) binds any free port; the
  // hooks file written at each Claude launch must name the one actually bound.
  statusServer.on('listening', () => {
    const address = statusServer.address()
    if (address && typeof address === 'object') hookPort = address.port
  })

  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  ptys.disposeAll()
})

app.on('window-all-closed', () => {
  app.quit()
})
