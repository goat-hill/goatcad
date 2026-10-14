/**
 * Terminal-tab shapes shared by main and renderer (the one directory both
 * tsconfigs see, same rationale as `modelTypes.d.ts`).
 *
 * Nothing here carries a command: the renderer asks for a shell in a directory
 * and gets back an id, and every later call is that id plus keystrokes. What
 * runs is decided in `terminalSessions.ts`, so the bridge never becomes a way to
 * execute an arbitrary command line (RULES.md §9).
 */

/**
 * What a terminal tab was started as. Not a command line — a *name* main maps to
 * one, which is what keeps the bridge from becoming a way to run arbitrary argv.
 * `shell` is a plain login shell; the other two launch an agent CLI, resuming
 * that directory's last conversation when there is one.
 */
export type TerminalKind = 'shell' | 'claude' | 'codex'

/** The agent CLIs — what the activity bar's one agent button can launch. */
export type AgentKind = Exclude<TerminalKind, 'shell'>

export interface TerminalSession {
  id: string
  kind: TerminalKind
  /**
   * The tab's title while nothing more specific is running: the shell's basename
   * for a plain terminal, the agent's display name for the other two.
   */
  shell: string
  cwd: string
  pid: number
  /**
   * Set when an agent tab's CLI was not found by the shell that would have run
   * it: the executable's name, and the vendor's page on installing it. The tab
   * then holds a plain shell, and the view says what is missing and where to
   * look, so a person can install it right there and click again.
   */
  missingCli?: { cli: string; docs: string }
}

/**
 * What an agent CLI is doing — told by Claude Code through its hooks
 * (`main/agentActivity.ts`). Codex reports nothing and stays `unknown`:
 * `working` from a prompt's submission to its answer, `idle` at its prompt,
 * `attention` when a permission or input dialog is waiting on a person.
 */
export type AgentActivity = 'working' | 'idle' | 'attention'

export interface TerminalState {
  shell: string
  /** Foreground command, or null when the session is sitting at its prompt. */
  process: string | null
  /** Null while the shell is alive; the exit status once it is not. */
  exitCode: number | null
  /**
   * The agent's own report, or `unknown` until one arrives — which for a plain
   * shell, or an agent whose hooks never reached the app, is forever, and reads
   * as "running while the process is".
   */
  activity: AgentActivity | 'unknown'
}

export interface TerminalSnapshot {
  /** Scrollback tail to replay before live data is written. */
  data: string
  /** Total bytes emitted at the end of `data`; live chunks at or below it are dupes. */
  offset: number
  exitCode: number | null
}
