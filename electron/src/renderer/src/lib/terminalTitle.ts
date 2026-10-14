import type { TerminalState } from '../../../preload/terminalTypes'

/**
 * What a terminal tab calls itself, and what its indicator says.
 *
 * A terminal emulator names its tabs after what they are running, and that is
 * the whole reason to show them in a tab strip at all: three shells look
 * identical, but `claude`, `npm run dev` and `fish` do not. The state itself is
 * probed in the main process (`terminalProcess.ts`); this is only the naming,
 * kept pure so it is testable without a pty.
 */

/**
 * What the dot says. `running` is a process that is going; for an agent that
 * has reported (`TerminalState.activity`) it narrows to *working*, and its
 * prompt reads as `idle` like a shell's — a Claude tab that is alive but
 * waiting is not the thing to glance at. `attention` is an agent waiting on a
 * person: a permission or input dialog nobody has seen yet.
 */
export type TerminalStatus = 'idle' | 'running' | 'attention' | 'exited'

export const terminalStatus = (state: TerminalState | undefined): TerminalStatus => {
  if (!state) return 'idle'
  if (state.exitCode !== null) return 'exited'
  if (!state.process) return 'idle'
  switch (state.activity) {
    case 'idle':
      return 'idle'
    case 'attention':
      return 'attention'
    default:
      return 'running'
  }
}

/** Alive with a process in it — an agent at its prompt included. */
export const terminalAlive = (state: TerminalState | undefined): boolean =>
  !!state && state.exitCode === null && state.process !== null

/**
 * Tab title: the running command, else the shell. `fallback` covers the frames
 * before the first poll answers — a tab has to be titled the moment it appears.
 */
export const terminalLabel = (state: TerminalState | undefined, fallback: string): string => {
  if (!state) return fallback
  return state.process ?? state.shell ?? fallback
}

/**
 * Whether closing this tab is worth a confirmation. Only work under way counts:
 * a shell at its prompt is nothing to lose, and neither is an agent at its own —
 * both CLIs keep the conversation on disk and the next launch continues it
 * (`terminalAgents.ts`), so what a close can cost is the turn in progress. That
 * is an agent that says it is working, or is waiting on an answer mid-turn, or
 * has not said (a plain command, or an agent whose reports never arrived).
 * Asking about the rest would train the answer out of the user before the one
 * close that mattered.
 */
export const terminalNeedsCloseConfirm = (state: TerminalState | undefined): boolean =>
  terminalAlive(state) && state?.activity !== 'idle'
