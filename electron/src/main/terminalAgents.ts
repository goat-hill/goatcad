import { execFile } from 'node:child_process'
import type { TerminalKind } from '../preload/terminalTypes'

/**
 * What each kind of terminal tab launches, and whether it can resume.
 *
 * The renderer names a *kind*, never a command line (`terminalTypes.d.ts`), so
 * this module is the whole vocabulary of what the app will start — three
 * entries, all of them fixed strings. That is what keeps `terminal:start` from
 * being a general way to run argv from the page (RULES.md §9).
 *
 * Both agents keep their conversations on disk, and continuing one is almost
 * always what a person clicking their button wants — so a tab opened in a
 * directory asks its CLI to continue the last conversation there, and starts a
 * fresh one only if that fails: `claude --continue … || claude …`. The CLI is
 * the only party that knows what it can resume, so it is the only one asked.
 * The app never reads either tool's transcript store to find out — those are
 * private to the tools, their layouts are not ours to depend on, and inferring
 * from them is how a tab ends up asking to continue something that is not
 * there. Nor does it keep a record of its own: an id minted at launch stops
 * naming the conversation the moment the person types `/clear`, which starts a
 * new one under a new id, and the next tab would resume the one they left.
 *
 * - **Claude Code**: `--continue` takes the newest conversation in the cwd, and
 *   exits 1 on "No conversation found to continue". Every ordinary way out of a
 *   session (`/exit`, Ctrl-C twice, Ctrl-D twice) exits 0, so quitting a
 *   resumed conversation does not land in the fallback.
 * - **Codex**: `codex resume --last` filters by cwd itself (that is what `--all`
 *   turns off). Whatever it does with nothing to pick — start fresh on its own
 *   or fail — the tab ends up in a fresh session.
 *
 * The price is a line of the CLI's own "nothing to continue" above a fresh
 * session, and a person who declines the CLI's trust prompt being asked once
 * more by the fallback.
 */

/** Display name for the tab, and the fallback title while nothing else is reported. */
export const AGENT_NAMES: Record<TerminalKind, string> = {
  shell: 'shell',
  claude: 'Claude',
  codex: 'Codex'
}

/** The executable each agent kind runs; a plain shell runs none. */
export const AGENT_BINARIES: Record<TerminalKind, string | null> = {
  shell: null,
  claude: 'claude',
  codex: 'codex'
}

/**
 * Where to learn how to install each CLI, for the tab that opens without one.
 * The vendor's own page rather than an install command of our choosing: each
 * ships several installers, prefers different ones per platform, and changes
 * that advice more often than we would notice.
 */
export const AGENT_INSTALL: Record<Exclude<TerminalKind, 'shell'>, string> = {
  claude: 'https://code.claude.com/docs/en/quickstart',
  codex: 'https://learn.chatgpt.com/docs/codex/cli'
}

// ------------------------------------------------------------------- probe

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

/** Injected so tests never shell out. */
export type ExecFn = (command: string, args: string[]) => Promise<ExecResult>

/** A shell that hangs in its rc files must not hang the tab behind it. */
const PROBE_TIMEOUT_MS = 10_000

export const realExec: ExecFn = (command, args) =>
  new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: PROBE_TIMEOUT_MS, windowsHide: true, encoding: 'utf8' },
      (error, stdout, stderr) => {
        // A non-zero exit is an answer, not an exception: "not found" is
        // reported that way by `command -v` and `where` alike.
        const code =
          error && typeof (error as NodeJS.ErrnoException).code === 'number'
            ? ((error as NodeJS.ErrnoException).code as unknown as number)
            : error
              ? 1
              : 0
        resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' })
      }
    )
  })

/**
 * Whether the shell a tab would run this agent in can find its executable.
 *
 * Asked of *that shell*, not of this process: an app opened from Finder or a
 * desktop menu inherits a `PATH` without `~/.local/bin`, nvm or Homebrew, so
 * probing our own environment says "not installed" for a CLI the tab would run
 * fine. The login shell is what the launch uses, so its answer is the launch's
 * answer by construction. Windows GUI processes get the registry `PATH`, and
 * `where` honours `PATHEXT`, so an npm `.cmd` shim counts there.
 */
export const probeAgentCli = (
  shell: { file: string; args: string[] },
  binary: string,
  exec: ExecFn = realExec,
  platform: NodeJS.Platform = process.platform
): Promise<boolean> => {
  const run =
    platform === 'win32'
      ? exec('where.exe', [binary])
      : exec(shell.file, [...shell.args, '-c', `command -v ${binary}`])
  return run.then(
    (result) => result.code === 0,
    // A shell that could not even start is a tab that will not either; say so
    // rather than let the launch discover it.
    () => false
  )
}

export interface AgentLaunch {
  /** The command line handed to a login shell, or null for a plain shell. */
  command: string | null
}

/**
 * Continue the last conversation here, or failing that start one. `||` reads
 * the same in every shell this runs in — sh, bash, zsh, dash, fish (3.0 on) and
 * cmd.exe — and both halves carry the same flags, so the tab is wired up the
 * same whichever one it ends in.
 *
 * On Windows each half goes through `call`: an npm-installed CLI is a `.cmd`
 * shim, and cmd.exe does not let `||` see a batch file's exit status unless the
 * batch was `call`ed. It is harmless in front of a real `.exe`.
 */
const resumeOrStart = (resume: string, start: string, platform: NodeJS.Platform): string =>
  platform === 'win32' ? `call ${resume} || call ${start}` : `${resume} || ${start}`

/**
 * What to run for a kind. Everything it needs is passed in: the module runs no
 * command and reads no file to decide.
 */
export const agentLaunch = (
  kind: TerminalKind,
  options: {
    /** A settings file for Claude Code to load beside the user's own (`agentActivity.ts`). */
    claudeSettings?: string
    /** The MCP server definition file for this launch (`partsMcpClients.ts`). */
    claudeMcpConfig?: string
    /** Codex's `-c` overrides defining the same server (`codexMcpOverrides`). */
    codexOverrides?: string[]
  } = {},
  platform: NodeJS.Platform = process.platform
): AgentLaunch => {
  if (kind === 'claude') {
    // Double-quoted for the login shell the command runs in; a userData path
    // with a space is ordinary on macOS and Windows. `--mcp-config` is
    // variadic and goes last, or it would swallow the flag after it.
    const settings = options.claudeSettings ? ` --settings "${options.claudeSettings}"` : ''
    const mcp = options.claudeMcpConfig ? ` --mcp-config "${options.claudeMcpConfig}"` : ''
    const flags = `${settings}${mcp}`
    return { command: resumeOrStart(`claude --continue${flags}`, `claude${flags}`, platform) }
  }
  if (kind === 'codex') {
    // Single-quoted: each override holds a TOML value with its own double
    // quotes, and the four shells this can run in (sh, bash, zsh, fish) all
    // read '…' literally. cmd.exe does not, and Codex is WSL-only on Windows.
    const overrides = (options.codexOverrides ?? []).map((entry) => ` -c '${entry}'`).join('')
    // `--last` skips the picker and takes the newest session for this cwd,
    // Codex's own filter deciding which those are.
    return {
      command: resumeOrStart(`codex${overrides} resume --last`, `codex${overrides}`, platform)
    }
  }
  return { command: null }
}

/**
 * The shell and argv that run one command line — an agent's launch. Everywhere
 * but Windows that is the login shell's own `-c`. cmd.exe spells it `/c`, and
 * is handed the whole line as one string: `/s` makes it strip exactly the outer
 * pair of quotes and read the rest as typed, where an argv array would have its
 * inner quotes backslash-escaped, which cmd.exe does not understand. Always
 * cmd.exe there, never the PowerShell fallback: Windows PowerShell has no `||`.
 */
export const commandShell = (
  shell: { file: string; args: string[] },
  command: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): { file: string; args: string[] | string } =>
  platform === 'win32'
    ? { file: env.COMSPEC ?? 'cmd.exe', args: `/d /s /c "${command}"` }
    : { file: shell.file, args: [...shell.args, '-c', command] }
