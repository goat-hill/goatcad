import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

function subscribe(channel: string, handler: (...args: unknown[]) => void): () => void {
  const listener = (_event: IpcRendererEvent, ...args: unknown[]): void => handler(...args)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const api: GoatherdApi = {
  info: () => ipcRenderer.invoke('app:info'),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  openPath: (path) => ipcRenderer.invoke('app:openPath', path),
  openInVSCode: (path) => ipcRenderer.invoke('app:openInVSCode', path),
  listWorkspace: (worktreePath) => ipcRenderer.invoke('workspace:list', worktreePath),
  minimizeWindow: () => ipcRenderer.send('window:minimize'),
  maximizeWindow: () => ipcRenderer.send('window:maximize'),
  closeWindow: () => ipcRenderer.send('window:close'),
  platform: process.platform,
  setZoomLabel: (label) => ipcRenderer.send('menu:zoom-label', label),
  onWindowFocus: (callback) =>
    subscribe('window:focus-changed', (focused) => callback(focused as boolean)),
  // Through main: Electron 44 took the `clipboard` module out of renderer
  // processes (a preload is one), so calling it here threw on every copy and
  // paste — silently, since nothing awaited the promise.
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),
  writeClipboard: (text) => ipcRenderer.invoke('clipboard:write', text),
  writePrimarySelection: (text) => ipcRenderer.send('clipboard:write-primary', text),
  showTerminalMenu: (hasSelection) => ipcRenderer.invoke('menu:terminalContext', hasSelection),
  onClipboardCommand: (callback) =>
    subscribe('clipboard', (action) => callback(action as TerminalMenuAction)),
  listWorktrees: () => ipcRenderer.invoke('wt:list'),
  gitOverview: (worktree, base) => ipcRenderer.invoke('git:overview', worktree, base),
  gitFiles: (request) => ipcRenderer.invoke('git:files', request),
  gitPatch: (request) => ipcRenderer.invoke('git:patch', request),
  addWorktree: (branch) => ipcRenderer.invoke('wt:add', branch),
  removeWorktree: (path) => ipcRenderer.invoke('wt:remove', path),
  renameWorktree: (path, name) => ipcRenderer.invoke('wt:rename', path, name),
  startPty: (request) => ipcRenderer.invoke('pty:start', request),
  disposePty: (id) => ipcRenderer.invoke('pty:dispose', id),
  ptySnapshot: (id) => ipcRenderer.invoke('pty:snapshot', id),
  ptyInput: (id, data) => ipcRenderer.send('pty:input', id, data),
  ptyResize: (id, cols, rows) => ipcRenderer.send('pty:resize', id, cols, rows),
  getPtyProcess: (id) => ipcRenderer.invoke('pty:getProcess', id),
  onPtyData: (callback) =>
    subscribe('pty:data', (id, data, offset) =>
      callback(id as string, data as string, offset as number)
    ),
  onPtyExit: (callback) =>
    subscribe('pty:exit', (id, exitCode) => callback(id as string, exitCode as number)),
  onPtyPort: (callback) =>
    subscribe('pty:port', (id, port) => callback(id as string, port as number)),
  onClaudeStatus: (callback) =>
    subscribe('claude:status', (event) => callback(event as ClaudeStatusEvent)),
  getQuota: (force) => ipcRenderer.invoke('quota:get', force),
  onQuota: (callback) => subscribe('quota:update', (status) => callback(status as QuotaStatus)),
  onZoom: (callback) => subscribe('zoom', (action) => callback(action as ZoomAction))
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
