import { createServer, type Server } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Local endpoint Claude Code hooks POST to, and the hooks that do the posting.
 *
 * Two ways in. A session GoatHerd launched carries a settings file written by
 * `writeClaudeHooksFile` (passed as `claude --settings <file>`, merged with the
 * user's own hooks), whose commands name the status in the path:
 * `POST /hook/working`. A session launched anywhere else can still report
 * through the hooks in `~/.claude/settings.json` (see README), which post the
 * bare `/hook` and are read by event name. Both forward Claude Code's own JSON
 * payload, because `cwd` in it is what maps a report to a worktree.
 *
 * Override the port with GOATHERD_HOOK_PORT so a second (dev) instance can run
 * alongside the stable one; `0` takes any free port, and the settings file is
 * written with whichever port was actually bound.
 */
export const HOOK_PORT = Number(process.env.GOATHERD_HOOK_PORT ?? 47821)

const STATUSES: readonly ClaudeStatus[] = ['working', 'waiting', 'idle']

const isStatus = (value: string): value is ClaudeStatus =>
  (STATUSES as readonly string[]).includes(value)

/** For a bare `/hook`: what the event alone says. */
const STATUS_BY_EVENT: Record<string, ClaudeStatus> = {
  SessionStart: 'idle',
  UserPromptSubmit: 'working',
  PreToolUse: 'working',
  PostToolUse: 'working',
  Notification: 'waiting',
  Stop: 'idle',
  SubagentStop: 'idle',
  SessionEnd: 'idle'
}

export function startStatusServer(
  onEvent: (event: ClaudeStatusEvent) => void,
  port = HOOK_PORT
): Server {
  const server = createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405).end()
      return
    }
    const [root, named] = (req.url ?? '').split('?')[0].split('/').filter(Boolean)
    if (root !== 'hook' || (named !== undefined && !isStatus(named))) {
      res.writeHead(404).end()
      req.resume()
      return
    }
    let body = ''
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString()
    })
    req.on('end', () => {
      res.writeHead(204).end()
      try {
        const payload = JSON.parse(body) as {
          hook_event_name?: string
          cwd?: string
          session_id?: string
          message?: string
        }
        const name = payload.hook_event_name
        if (!name || !payload.cwd) return
        const status = named ?? STATUS_BY_EVENT[name]
        if (!status) return
        onEvent({
          cwd: payload.cwd,
          status,
          event: name,
          sessionId: payload.session_id ?? '',
          message: payload.message
        })
      } catch {
        // Malformed hook payload — ignore.
      }
    })
  })
  server.on('error', (error) => {
    console.error('[goatherd] hook status server error:', error.message)
  })
  server.listen(port, '127.0.0.1')
  return server
}

/**
 * Which hook says what, for a session GoatHerd launches. Working is re-asserted
 * around every tool call so that answering a permission prompt (a PostToolUse
 * follows) turns the dot back without a second mechanism. Only a notification
 * that wants a person is "waiting": a permission or elicitation dialog, or an
 * agent asking for input — the reminder Claude sends after a minute at its
 * prompt is the prompt again, so it reads as idle.
 */
export const CLAUDE_HOOKS: readonly { event: string; matcher?: string; status: ClaudeStatus }[] = [
  { event: 'SessionStart', status: 'idle' },
  { event: 'UserPromptSubmit', status: 'working' },
  { event: 'PreToolUse', status: 'working' },
  { event: 'PostToolUse', status: 'working' },
  {
    event: 'Notification',
    matcher: 'permission_prompt|elicitation_dialog|elicitation_url_dialog|agent_needs_input',
    status: 'waiting'
  },
  { event: 'Notification', matcher: 'idle_prompt', status: 'idle' },
  { event: 'Stop', status: 'idle' },
  { event: 'SessionEnd', status: 'idle' }
]

/** The `-m 2 … || true` keeps the session unaffected when GoatHerd is gone. */
export const hookCommand = (port: number, status: ClaudeStatus): string =>
  `curl -s -m 2 -X POST -H 'Content-Type: application/json' --data-binary @- http://127.0.0.1:${port}/hook/${status} >/dev/null 2>&1 || true`

export const claudeHooksSettings = (port: number): { hooks: Record<string, unknown[]> } => {
  const hooks: Record<string, unknown[]> = {}
  for (const { event, matcher, status } of CLAUDE_HOOKS) {
    hooks[event] ??= []
    hooks[event].push({
      ...(matcher ? { matcher } : {}),
      hooks: [{ type: 'command', command: hookCommand(port, status), timeout: 5 }]
    })
  }
  return { hooks }
}

/**
 * The settings file the launcher hands Claude Code, under this instance's own
 * data directory so the user's settings are never touched. Rewritten on every
 * launch, with the port this instance is listening on.
 */
export const writeClaudeHooksFile = (dir: string, port: number): string => {
  const path = join(dir, 'claude-hooks.json')
  mkdirSync(dir, { recursive: true })
  writeFileSync(path, JSON.stringify(claudeHooksSettings(port), null, 2) + '\n', 'utf8')
  return path
}
