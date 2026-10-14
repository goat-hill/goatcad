/**
 * The GoatCAD executable as a command: `goatcad mcp`, `goatcad help agents`
 * and `--help` (`launchArgs.ts`, `launchMode`). Each runs instead of the app,
 * never alongside it: no window, no single-instance lock, no config written.
 *
 * The executable is the only command there is: no second binary, no PATH
 * entry, no Node install. Registration uses its absolute path, as this
 * process reads it (`relayCommand`).
 */
import { spawn } from 'node:child_process'
import { app, safeStorage } from 'electron'
import { runRelay } from './mcpRelay'
import { readToken } from './mcpToken'
import { claudeCode, codex } from './partsMcpClients'
import type { LaunchMode } from './launchArgs'

/**
 * How to run this executable with arguments. A Linux AppImage runs from a
 * mount that moves each launch, so it names the image itself; an unpackaged
 * build is Electron with the app's folder.
 */
export const executable = (): { command: string; args: string[] } => ({
  command: process.env.APPIMAGE ?? process.execPath,
  args: app.isPackaged ? [] : [app.getAppPath()]
})

/** What an MCP client registers: this executable with `mcp`. */
export const relayCommand = (): { command: string; args: string[] } => {
  const { command, args } = executable()
  return { command, args: [...args, 'mcp'] }
}

/** Start the app with no window, for an agent, detached from this process. */
const launchBackground = (): void => {
  const { command, args } = executable()
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  spawn(command, [...args, '--background'], { detached: true, stdio: 'ignore', env }).unref()
}

const USAGE = `Usage: goatcad [file or folder ...]
       goatcad open <folder>    open a folder in its window, or a new one
       goatcad --background     start with no window, for agents
       goatcad mcp              relay an MCP client's stdio to the app
       goatcad help agents      how to give an agent GoatCAD's tools
`

const agentsHelp = (): string => {
  const relay = relayCommand()
  const indent = (text: string): string =>
    text
      .split('\n')
      .map((line) => `  ${line}`)
      .join('\n')
  return [
    "GoatCAD's MCP server reads and edits schematics and boards, searches",
    'distributor parts, renders, checks and exports. Register it once:',
    '',
    indent(claudeCode.manualText(relay)),
    '',
    'Codex, in ~/.codex/config.toml:',
    '',
    indent(codex.manualText(relay)),
    '',
    'Any other client: run that command as a stdio MCP server. It starts',
    'GoatCAD in the background if it is not running. Then restart the session;',
    'the tools are mcp__goatcad__*, and workspace_list is the first call.',
    ''
  ].join('\n')
}

/** Run the command and exit; never returns to the app's startup. */
export const runCommandLine = (mode: Exclude<LaunchMode, 'app' | 'background'>): void => {
  if (mode === 'help' || mode === 'help-agents') {
    process.stdout.write(mode === 'help' ? USAGE : agentsHelp(), () => app.exit(0))
    return
  }
  // A relay draws nothing: no GPU process, and only fatal Chromium logs on the
  // stderr its client records.
  app.dock?.hide()
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-gpu')
  app.commandLine.appendSwitch('log-level', '3')
  const configDir = app.getPath('userData')
  void runRelay({
    configDir,
    launch: launchBackground,
    // The keyring needs the app ready; only a port or a Windows pipe asks.
    token: async () => {
      await app.whenReady()
      return readToken(configDir, safeStorage)
    },
    ...(process.env.GOATCAD_WORKSPACE ? { workspace: process.env.GOATCAD_WORKSPACE } : {}),
    input: process.stdin,
    output: process.stdout,
    log: (message) => process.stderr.write(`goatcad: ${message}\n`)
  }).then((code) => app.exit(code))
}
