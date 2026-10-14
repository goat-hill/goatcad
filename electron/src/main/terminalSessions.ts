import { spawn, type IPty } from 'node-pty'
import { isShellName, readForeground } from './terminalProcess'
import {
  AGENT_BINARIES,
  AGENT_INSTALL,
  AGENT_NAMES,
  agentLaunch,
  commandShell,
  probeAgentCli,
  realExec,
  type ExecFn
} from './terminalAgents'
import { STATUS_URL_ENV } from './agentActivity'
import type { AppTheme } from './appConfig'
import { codexMcpOverrides, TOKEN_ENV } from './partsMcpClients'
import type {
  AgentActivity,
  TerminalKind,
  TerminalSession,
  TerminalState
} from '../preload/terminalTypes'

/**
 * What an agent tab is handed at launch, beyond its command: a way to report
 * what it is doing (`agentActivity.ts` — a URL of its own in its environment,
 * and for Claude Code a settings file whose hooks post to it), and the app's
 * MCP server (`partsMcpClients.ts` — the live URL and token, given on the
 * command line so nothing is ever registered and nothing can go stale).
 * Injected so the manager can run without a listener or a server.
 */
export interface AgentHooks {
  /** A session's own report URL, from a listener started on first use. */
  register(session: string): Promise<string>
  unregister(session: string): void
  /** The hooks settings file Claude Code loads, written fresh for this launch. */
  claudeSettings(): string
  /** The MCP server as it is right now, or null while it is not running. */
  mcp(): { url: string; token: string } | null
  /** The server-definition file Claude Code loads, written fresh for this launch. */
  claudeMcpConfig(url: string): string
  /** The app theme, so every session (not only an agent's) knows its background. */
  theme?(): AppTheme
}

/**
 * The pty sessions behind the app's terminal tabs.
 *
 * The process lives here rather than in the window that opened it, for three
 * reasons: a tab switch unmounts the xterm and must not take the shell with it,
 * a tab dragged to another window has to keep running, and the app's own quit is
 * the only thing allowed to end a session the user did not close. Each session
 * therefore keeps a scrollback tail plus a running byte offset, and a view that
 * (re)mounts replays the tail and drops the live chunks the tail already covers.
 *
 * Deliberately Electron-free — `emit` is injected — so the whole thing is
 * testable without a BrowserWindow, the same split `parts.ts`/`partsIpc.ts` uses.
 */

/** Scrollback kept per session so a late or re-mounted view can replay history. */
const BUFFER_CAP = 512 * 1024

/**
 * Variables Electron sets for its own child processes. Left in place they leak
 * into every command the user runs — `ELECTRON_RUN_AS_NODE` in particular turns
 * a plain `node` into a very confusing Electron.
 */
const STRIPPED_ENV = [
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_NO_ATTACH_CONSOLE',
  'ELECTRON_IS_DEV',
  'NODE_OPTIONS',
  'GOATCAD_TEST_HOOKS'
]

/**
 * A login shell, so the user's own configuration applies — nvm, aliases, and on
 * macOS the PATH itself, which an app launched from Finder does not inherit.
 */
export const defaultShell = (
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): { file: string; args: string[] } => {
  if (platform === 'win32') return { file: env.COMSPEC ?? 'powershell.exe', args: [] }
  return { file: env.SHELL ?? '/bin/bash', args: ['-l'] }
}

export const shellName = (file: string): string =>
  file
    .split(/[/\\]/)
    .pop()
    ?.replace(/\.exe$/i, '') ?? file

interface Entry {
  pty: IPty
  session: TerminalSession
  buffer: string
  offset: number
  exitCode: number | null
  /** webContents id of the window currently showing this session, if any. */
  owner: number | null
  /** The agent's last report, `unknown` until its first (`TerminalState.activity`). */
  activity: AgentActivity | 'unknown'
}

const RUN_TAG = Date.now().toString(36)

export class TerminalSessionManager {
  private entries = new Map<string, Entry>()
  private nextId = 1

  constructor(
    private emit: (owner: number | null, channel: string, ...args: unknown[]) => void,
    private hooks: AgentHooks | null = null,
    /** Runs the install probe; injected so tests never shell out. */
    private exec: ExecFn = realExec
  ) {}

  async start(cwd: string, kind: TerminalKind, owner: number | null): Promise<TerminalSession> {
    // Unique to this run of the app as well as within it: a session restored
    // from disk still names its agent tabs by the id they had, and a window
    // must never find another window's new session under it (`attach`).
    const id = `term-${RUN_TAG}-${this.nextId++}`
    const shell = defaultShell()
    // An agent whose CLI the shell cannot find gets a plain shell in its tab
    // instead, and the tab says why (`missingCli`): a person can install it
    // right there and click again. Probed through the same login shell the
    // launch would use, so the two cannot disagree.
    const binary = AGENT_BINARIES[kind]
    const found = binary === null || (await probeAgentCli(shell, binary, this.exec))
    const missingCli =
      binary !== null && kind !== 'shell' && !found
        ? { cli: binary, docs: AGENT_INSTALL[kind] }
        : undefined
    // An agent tab is told where to report what it is doing; a shell is not
    // asked. A listener that fails to bind costs the report, not the tab.
    let statusUrl: string | null = null
    if (kind !== 'shell' && found && this.hooks) {
      try {
        statusUrl = await this.hooks.register(id)
      } catch (err) {
        console.error('Agent status listener unavailable', err)
      }
    }
    // The app's MCP server, handed over for this one session: Claude Code
    // takes a definition file, Codex takes config overrides, and both read
    // the token from the tab's environment.
    const mcp = found && kind !== 'shell' ? (this.hooks?.mcp() ?? null) : null
    const launch = found
      ? agentLaunch(kind, {
          ...(kind === 'claude' && statusUrl && this.hooks
            ? { claudeSettings: this.hooks.claudeSettings() }
            : {}),
          ...(kind === 'claude' && mcp && this.hooks
            ? { claudeMcpConfig: this.hooks.claudeMcpConfig(mcp.url) }
            : {}),
          ...(kind === 'codex' && mcp ? { codexOverrides: codexMcpOverrides(mcp.url) } : {})
        })
      : { command: null }
    // An agent runs *inside* a login shell rather than as its own argv, so the
    // user's PATH applies (both CLIs commonly live under nvm or ~/.local/bin,
    // neither of which an app launched from a desktop menu inherits).
    const { file, args } = launch.command ? commandShell(shell, launch.command) : shell

    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !STRIPPED_ENV.includes(key)) env[key] = value
    }
    // Tell the program what it is talking to; xterm.js implements both.
    env.TERM = 'xterm-256color'
    env.COLORTERM = 'truecolor'
    // "foreground;background" as ANSI indices — how vim, less and friends tell a
    // light terminal from a dark one without a round trip. xterm.js also answers
    // the OSC 11 background query, for programs that ask. Fixed at spawn: a
    // session started before a theme switch keeps the old answer.
    env.COLORFGBG = this.hooks?.theme?.() === 'light' ? '0;15' : '15;0'
    if (statusUrl) env[STATUS_URL_ENV] = statusUrl
    if (mcp) env[TOKEN_ENV] = mcp.token

    const pty = spawn(file, args, { name: 'xterm-256color', cols: 80, rows: 24, cwd, env })
    const session: TerminalSession = {
      id,
      kind,
      shell: kind === 'shell' || !found ? shellName(file) : AGENT_NAMES[kind],
      cwd,
      pid: pty.pid,
      ...(missingCli ? { missingCli } : {})
    }
    const entry: Entry = {
      pty,
      session,
      buffer: '',
      offset: 0,
      exitCode: null,
      owner,
      activity: 'unknown'
    }
    this.entries.set(id, entry)

    pty.onData((data) => {
      entry.offset += data.length
      entry.buffer = (entry.buffer + data).slice(-BUFFER_CAP)
      this.emit(entry.owner, 'terminal:data', id, data, entry.offset)
    })
    pty.onExit(({ exitCode }) => {
      entry.exitCode = exitCode
      this.emit(entry.owner, 'terminal:exit', id, exitCode)
    })
    return session
  }

  /** Point a session's output at the window now showing it (a tab moved windows). */
  attach(id: string, owner: number): TerminalSession | null {
    const entry = this.entries.get(id)
    if (!entry) return null
    entry.owner = owner
    return entry.session
  }

  write(id: string, data: string): void {
    const entry = this.entries.get(id)
    if (entry && entry.exitCode === null) entry.pty.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    const entry = this.entries.get(id)
    if (entry && entry.exitCode === null && cols > 0 && rows > 0) entry.pty.resize(cols, rows)
  }

  /** Scrollback tail plus the total-output offset it ends at, for replay-then-stream dedupe. */
  snapshot(id: string): { data: string; offset: number; exitCode: number | null } {
    const entry = this.entries.get(id)
    if (!entry) return { data: '', offset: 0, exitCode: null }
    return { data: entry.buffer, offset: entry.offset, exitCode: entry.exitCode }
  }

  /** Kill the process (if it is still running) and forget the session. */
  dispose(id: string): void {
    const entry = this.entries.get(id)
    if (!entry) return
    if (entry.exitCode === null) entry.pty.kill()
    this.entries.delete(id)
    this.hooks?.unregister(id)
  }

  /** An agent's hook said what it is doing; the next state poll carries it. */
  reportActivity(id: string, activity: AgentActivity): void {
    const entry = this.entries.get(id)
    if (entry) entry.activity = activity
  }

  /**
   * End every session still pointed at a window that is going away. A session
   * whose tab was dragged elsewhere has already re-pointed, so it survives.
   */
  disposeOwnedBy(owner: number): void {
    for (const [id, entry] of this.entries) if (entry.owner === owner) this.dispose(id)
  }

  disposeAll(): void {
    for (const id of [...this.entries.keys()]) this.dispose(id)
  }

  /**
   * What each session is running, in one pass — the poll behind the tab titles.
   * Batched because the macOS probe is a `ps` call, and one per tab per tick is
   * exactly the kind of per-item subprocess this should never grow into.
   */
  async states(ids: readonly string[]): Promise<Record<string, TerminalState>> {
    const live = ids
      .map((id) => this.entries.get(id))
      .filter((entry): entry is Entry => !!entry && entry.exitCode === null)
    const foreground = await readForeground(live.map((entry) => entry.pty.pid))

    const states: Record<string, TerminalState> = {}
    for (const id of ids) {
      const entry = this.entries.get(id)
      if (!entry) continue
      states[id] = {
        shell: entry.session.shell,
        process: entry.exitCode === null ? this.runningIn(entry, foreground) : null,
        exitCode: entry.exitCode,
        activity: entry.activity
      }
    }
    return states
  }

  /**
   * What this session counts as running.
   *
   * An agent tab is running from launch until its process exits, and is reported
   * that way rather than probed: a shell handed one command usually *execs* into
   * it instead of forking, which leaves no foreground child to find — so the
   * probe would report an idle tab for a live agent, and whether it did would
   * depend on which shell the user happens to use.
   *
   * A plain shell is probed, because there the question is real. On Windows
   * there is no foreground-process-group to probe, so ConPTY's console title
   * stands in: it tracks the running program and reads back as the shell's own
   * name when nothing is running, which is exactly the idle answer.
   */
  private runningIn(entry: Entry, foreground: Map<number, string | null>): string | null {
    // A tab that fell back to a plain shell for want of its CLI is a shell.
    if (entry.session.kind !== 'shell' && !entry.session.missingCli) return entry.session.shell
    if (process.platform !== 'win32') return foreground.get(entry.pty.pid) ?? null
    const title = entry.pty.process?.trim()
    if (!title || isShellName(title)) return null
    return shellName(title)
  }
}
