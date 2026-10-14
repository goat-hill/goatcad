import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentActivity } from '../preload/terminalTypes'

/**
 * What an agent tab is doing, told by the agent itself.
 *
 * A Claude Code tab reports "running" from launch to exit (`terminalSessions.ts`),
 * which says the CLI is alive and nothing about whether it is working or sitting
 * at its prompt — and that is the question a person glancing at a tab strip has.
 * The process cannot answer it: the same node process blocks on the network
 * while the model thinks and on stdin while it waits, at the same near-zero CPU.
 * Claude Code's hooks can: they are shell commands it runs at fixed points in
 * its own loop, and each one here is a `curl` to a loopback URL the app put in
 * the tab's environment (`agentStatusServer.ts`), with the activity it means in
 * the path. Which event means what is decided here, once, in the settings file
 * the launcher hands Claude Code; the server only has to believe the path.
 *
 * Verified against a real session (2026-09-10): hooks from a `--settings` file
 * run alongside the hooks in the user's and project's own settings rather than
 * replacing them, and a hook command sees the environment of the shell that
 * launched `claude`.
 *
 * Codex has the same hooks but runs none until the user has reviewed it
 * (`trusted_hash` in its config); writing that for them would defeat it, and
 * asking every user to approve hooks costs more than a dot is worth. Nor is its
 * rollout store read instead: the app reads nothing under `~/.claude` or
 * `~/.codex`, for any purpose. So a Codex tab stays `unknown` — running while
 * alive — until Codex offers a way to be told that costs the user nothing.
 */

/** The environment variable the launched shell carries, and the hook reads. */
export const STATUS_URL_ENV = 'GOATCAD_AGENT_STATUS_URL'

export const AGENT_ACTIVITIES: readonly AgentActivity[] = ['working', 'idle', 'attention']

export const isAgentActivity = (value: string): value is AgentActivity =>
  (AGENT_ACTIVITIES as readonly string[]).includes(value)

/**
 * Which hook says what. A `matcher` narrows an event to the kinds named, as a
 * regex; without one the hook fires on every occurrence.
 *
 * Working starts at the prompt and is re-asserted around every tool call, so
 * that answering a permission prompt (a `PostToolUse` follows) turns the tab
 * back from "needs you" without a second mechanism. Only a notification that
 * wants a person — a permission or elicitation dialog, or an agent asking for
 * input — is attention; the reminder Claude sends after a minute at its prompt
 * is the prompt again, not a request.
 */
export const CLAUDE_HOOKS: readonly { event: string; matcher?: string; activity: AgentActivity }[] =
  [
    { event: 'SessionStart', activity: 'idle' },
    { event: 'UserPromptSubmit', activity: 'working' },
    { event: 'PreToolUse', activity: 'working' },
    { event: 'PostToolUse', activity: 'working' },
    {
      event: 'Notification',
      matcher: 'permission_prompt|elicitation_dialog|elicitation_url_dialog|agent_needs_input',
      activity: 'attention'
    },
    { event: 'Notification', matcher: 'idle_prompt', activity: 'idle' },
    { event: 'Stop', activity: 'idle' },
    { event: 'SessionEnd', activity: 'idle' }
  ]

/**
 * The hook command: one POST, the activity in the path, nothing in the body.
 * `curl` because it is on every platform the app ships to and the hook runs in
 * whatever shell Claude Code uses (`sh` here, Git Bash or PowerShell on
 * Windows), where nothing else is promised. `-m 2` bounds a hang to two
 * seconds, so the app answering slowly never stalls the agent; stdin is left
 * unread. Output is discarded by Claude Code on a zero exit.
 */
export const hookCommand = (activity: AgentActivity): string =>
  `curl -s -m 2 -X POST "$${STATUS_URL_ENV}/${activity}"`

/**
 * The settings object Claude Code loads through `--settings <file>`. Grouped
 * by event because that is the file's shape: one entry per event, each with
 * its matcher and the commands to run.
 */
export const claudeHooksSettings = (): Record<string, unknown> => {
  const hooks: Record<string, unknown[]> = {}
  for (const { event, matcher, activity } of CLAUDE_HOOKS) {
    hooks[event] ??= []
    hooks[event].push({
      ...(matcher ? { matcher } : {}),
      hooks: [{ type: 'command', command: hookCommand(activity), timeout: 5 }]
    })
  }
  return { hooks }
}

const HOOKS_FILE = 'claude-hooks.json'

/**
 * Write the settings file the launcher points Claude Code at, under the app's
 * own data directory so a user's settings are never touched. Rewritten on
 * every launch: it is the app's file, and an old copy from a previous version
 * must not outlive the commands it names.
 */
export const writeClaudeHooksFile = (dir: string): string => {
  const path = join(dir, HOOKS_FILE)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path, JSON.stringify(claudeHooksSettings(), null, 2) + '\n', 'utf8')
  return path
}
