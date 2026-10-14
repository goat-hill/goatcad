/**
 * The GoatCAD executable as a command: `goatcad help agents` and `--help`
 * (`launchArgs.ts`, `launchMode`). Each runs instead of the app, never alongside
 * it: no window, no single-instance lock, no config written.
 *
 * There is no command that serves MCP. The app serves it while it runs (over
 * HTTP, `partsMcpServer.ts`), and an agent outside the app either registers that
 * URL or drives the app from Python; either way it starts GoatCAD itself, with a
 * window or `--background`. Nothing here launches the app for a client.
 */
import { join } from 'node:path'
import { app } from 'electron'
import { PYTHON_DIR } from './agentScripting'
import { readEndpoint } from './mcpEndpoint'
import { claudeCode, codex, SERVER_NAME } from './partsMcpClients'
import { DEFAULT_MCP_PORT, MCP_PATH } from './partsMcpServer'
import type { LaunchMode } from './launchArgs'

/**
 * How to run this executable with arguments. A Linux AppImage runs from a
 * mount that moves each launch, so it names the image itself; an unpackaged
 * build runs through the worktree's `bin/goatcad`, which carries its profile.
 */
const executable = (): { command: string; args: string[] } =>
  app.isPackaged
    ? { command: process.env.APPIMAGE ?? process.execPath, args: [] }
    : { command: join(app.getAppPath(), 'bin', 'goatcad'), args: [] }

const USAGE = `Usage: goatcad [file or folder ...]
       goatcad open <folder>    open a folder in its window, or a new one
       goatcad --background     start with no window, for agents
       goatcad help agents      how to give an agent GoatCAD's tools
`

const agentsHelp = (): string => {
  const configDir = app.getPath('userData')
  const goatcad = [executable().command, ...executable().args].join(' ')
  // A dev build's port is chosen at launch; an installed one's is fixed.
  const url =
    readEndpoint(configDir)?.url ??
    (app.isPackaged ? `http://127.0.0.1:${DEFAULT_MCP_PORT}${MCP_PATH}` : null)
  const server = { url: url ?? '<url>', token: '<token>', dev: !app.isPackaged }
  const pythonPath = join(configDir, PYTHON_DIR)
  const indent = (text: string): string =>
    text
      .split('\n')
      .map((line) => `  ${line}`)
      .join('\n')
  return [
    "GoatCAD's tools read and edit schematics and boards, search distributor",
    'parts, render, check and export. They are served by the running app, so',
    'start GoatCAD first, with a window or with none:',
    '',
    indent(`${goatcad}${app.isPackaged ? '' : ' dev'}`),
    indent(`${goatcad} --background`),
    '',
    'An agent in a GoatCAD terminal tab already has the tools. Elsewhere, there',
    'are two ways in.',
    '',
    'MCP. The app runs an MCP server while it is open. Claude Code connects to',
    'its servers when a session starts, so start GoatCAD before the session, or',
    `run /mcp to reconnect after. The tools are mcp__${SERVER_NAME}__*; register it`,
    'once, with the token from Settings > AI Integrations:',
    '',
    indent(claudeCode.manualText(server)),
    '',
    'Codex, in ~/.codex/config.toml:',
    '',
    indent(codex.manualText(server)),
    '',
    ...(app.isPackaged
      ? []
      : [
          'This is a development build: its port is chosen at launch, so the',
          'registration lasts until the app restarts. Settings prints it live.',
          ''
        ]),
    'Python. The app writes a client for every operation into its config',
    'directory; it connects to the running app, and needs no MCP registration:',
    '',
    indent(
      [
        'import sys',
        `sys.path.insert(0, ${JSON.stringify(pythonPath)})`,
        'from goatcad import connect',
        'gc = connect(workspace="ws_…")  # an id from gc.workspace.list()'
      ].join('\n')
    ),
    '',
    `Worked examples sit beside it in ${pythonPath}.`,
    ''
  ].join('\n')
}

/** Run the command and exit; never returns to the app's startup. */
export const runCommandLine = (mode: Exclude<LaunchMode, 'app' | 'background'>): void => {
  process.stdout.write(mode === 'help' ? USAGE : agentsHelp(), () => app.exit(0))
}
