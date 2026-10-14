import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CLAUDE_HOOKS,
  claudeHooksSettings,
  hookCommand,
  startStatusServer,
  writeClaudeHooksFile
} from '../statusServer'

describe('startStatusServer', () => {
  let server: Server
  afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())))

  const listen = (onEvent: (event: ClaudeStatusEvent) => void): Promise<string> =>
    new Promise((resolve) => {
      server = startStatusServer(onEvent, 0)
      server.on('listening', () =>
        resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
      )
    })

  const post = (url: string, body: unknown): Promise<number> =>
    fetch(url, { method: 'POST', body: JSON.stringify(body) }).then((r) => r.status)

  it('reads a bare /hook by event name, keyed by the cwd in the payload', async () => {
    const onEvent = vi.fn()
    const base = await listen(onEvent)
    expect(
      await post(`${base}/hook`, { hook_event_name: 'Stop', cwd: '/w', session_id: 's' })
    ).toBe(204)
    expect(onEvent).toHaveBeenCalledWith({
      cwd: '/w',
      status: 'idle',
      event: 'Stop',
      sessionId: 's',
      message: undefined
    })
  })

  it('takes the status named in the path over the event, since the hook chose it', async () => {
    const onEvent = vi.fn()
    const base = await listen(onEvent)
    await post(`${base}/hook/idle`, { hook_event_name: 'Notification', cwd: '/w' })
    expect(onEvent.mock.calls[0][0]).toMatchObject({ status: 'idle', event: 'Notification' })
  })

  it('ignores a payload without a cwd, an unknown event, and refuses a made-up status', async () => {
    const onEvent = vi.fn()
    const base = await listen(onEvent)
    expect(await post(`${base}/hook`, { hook_event_name: 'Stop' })).toBe(204)
    expect(await post(`${base}/hook`, { hook_event_name: 'PreCompact', cwd: '/w' })).toBe(204)
    expect(await post(`${base}/hook/busy`, { hook_event_name: 'Stop', cwd: '/w' })).toBe(404)
    expect((await fetch(`${base}/hook`)).status).toBe(405)
    expect(onEvent).not.toHaveBeenCalled()
  })
})

describe('claudeHooksSettings', () => {
  const settings = claudeHooksSettings(47822)
  const entries = (event: string): { matcher?: string; hooks: { command: string }[] }[] =>
    settings.hooks[event] as { matcher?: string; hooks: { command: string }[] }[]

  it('posts to the port given, with the status in the path and the payload forwarded', () => {
    expect(hookCommand(47822, 'working')).toContain('http://127.0.0.1:47822/hook/working')
    expect(hookCommand(47822, 'working')).toContain('--data-binary @-')
    expect(hookCommand(47822, 'working')).toMatch(/\|\| true$/)
  })

  it('covers the turn and re-asserts working around tool calls', () => {
    for (const event of ['UserPromptSubmit', 'PreToolUse', 'PostToolUse'])
      expect(entries(event)[0].hooks[0].command).toContain('/hook/working ')
    for (const event of ['SessionStart', 'Stop', 'SessionEnd'])
      expect(entries(event)[0].hooks[0].command).toContain('/hook/idle ')
  })

  it('a notification waits only when it wants a person', () => {
    const waiting = entries('Notification').find((e) =>
      e.hooks[0].command.includes('/hook/waiting ')
    )
    const idle = entries('Notification').find((e) => e.hooks[0].command.includes('/hook/idle '))
    expect(waiting?.matcher).toContain('permission_prompt')
    expect(waiting?.matcher).not.toContain('idle_prompt')
    expect(idle?.matcher).toBe('idle_prompt')
    expect(Object.keys(settings.hooks).sort()).toEqual(
      [...new Set(CLAUDE_HOOKS.map((h) => h.event))].sort()
    )
  })
})

describe('writeClaudeHooksFile', () => {
  let dir: string
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('writes the settings as JSON into a directory it creates', () => {
    dir = join(mkdtempSync(join(tmpdir(), 'goatherd-hooks-')), 'nested')
    const path = writeClaudeHooksFile(dir, 47821)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(claudeHooksSettings(47821))
  })
})
