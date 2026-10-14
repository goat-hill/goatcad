import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  CLAUDE_HOOKS,
  claudeHooksSettings,
  hookCommand,
  isAgentActivity,
  STATUS_URL_ENV,
  writeClaudeHooksFile
} from '../agentActivity'

describe('hookCommand', () => {
  test('posts the activity to the URL in the environment, bounded and silent', () => {
    expect(hookCommand('working')).toBe(`curl -s -m 2 -X POST "$${STATUS_URL_ENV}/working"`)
  })
})

describe('claudeHooksSettings', () => {
  const settings = claudeHooksSettings() as {
    hooks: Record<string, { matcher?: string; hooks: { command: string; timeout: number }[] }[]>
  }

  test('covers the turn: working from the prompt, idle at its end, and at every start', () => {
    const activityOf = (event: string): string[] =>
      settings.hooks[event].map((entry) => entry.hooks[0].command.split('/').pop()!.slice(0, -1))
    expect(activityOf('UserPromptSubmit')).toEqual(['working'])
    expect(activityOf('Stop')).toEqual(['idle'])
    expect(activityOf('SessionStart')).toEqual(['idle'])
    expect(activityOf('SessionEnd')).toEqual(['idle'])
  })

  test('re-asserts working around a tool call, so an answered permission turns the tab back', () => {
    for (const event of ['PreToolUse', 'PostToolUse']) {
      expect(settings.hooks[event][0].hooks[0].command).toContain('/working"')
    }
  })

  test('a notification is attention only when it wants a person', () => {
    const notification = settings.hooks.Notification
    const attention = notification.find((entry) => entry.hooks[0].command.includes('/attention"'))
    const idle = notification.find((entry) => entry.hooks[0].command.includes('/idle"'))
    expect(attention?.matcher).toContain('permission_prompt')
    expect(attention?.matcher).not.toContain('idle_prompt')
    expect(idle?.matcher).toBe('idle_prompt')
  })

  test('every hook has a short timeout, since the agent waits on it', () => {
    for (const entries of Object.values(settings.hooks))
      for (const entry of entries) expect(entry.hooks[0].timeout).toBeLessThanOrEqual(5)
    expect(Object.keys(settings.hooks).sort()).toEqual(
      [...new Set(CLAUDE_HOOKS.map((hook) => hook.event))].sort()
    )
  })
})

describe('writeClaudeHooksFile', () => {
  let dir: string
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test('writes the settings as JSON into a directory it creates', () => {
    dir = join(mkdtempSync(join(tmpdir(), 'goatcad-hooks-')), 'nested')
    const path = writeClaudeHooksFile(dir)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(claudeHooksSettings())
  })
})

describe('isAgentActivity', () => {
  test('admits the three reports and nothing else', () => {
    expect(isAgentActivity('working')).toBe(true)
    expect(isAgentActivity('attention')).toBe(true)
    expect(isAgentActivity('unknown')).toBe(false)
    expect(isAgentActivity('')).toBe(false)
  })
})
