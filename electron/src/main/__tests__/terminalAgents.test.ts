import { describe, expect, test } from 'vitest'
import { agentLaunch, commandShell, probeAgentCli } from '../terminalAgents'

describe('agentLaunch', () => {
  test('a plain shell runs no command at all', () => {
    expect(agentLaunch('shell', { claudeSettings: '/x' })).toEqual({ command: null })
    expect(agentLaunch('shell')).toEqual({ command: null })
  })

  test('asks the CLI to continue, and starts fresh only if that fails', () => {
    // The CLI is the one that knows what it can resume: nothing is probed and
    // nothing is recorded, so a `/clear` mid-session cannot strand the next tab.
    expect(agentLaunch('claude')).toEqual({ command: 'claude --continue || claude' })
    // Codex takes no id: `--last` plus its own cwd filter is the whole request.
    expect(agentLaunch('codex', {})).toEqual({ command: 'codex resume --last || codex' })
  })

  test('hands Claude Code the hooks settings file, quoted for the shell, on both halves', () => {
    expect(agentLaunch('claude', { claudeSettings: '/My Data/hooks.json' })).toEqual({
      command:
        'claude --continue --settings "/My Data/hooks.json" || claude --settings "/My Data/hooks.json"'
    })
    // Codex has no such flag; the option is Claude's alone.
    expect(agentLaunch('codex', { claudeSettings: '/x' })).toEqual({
      command: 'codex resume --last || codex'
    })
  })

  test('hands Claude Code the MCP definition file last, since the flag is variadic', () => {
    // `--mcp-config` takes several files; a flag after it would be read as one.
    const flags = '--settings "/d/hooks.json" --mcp-config "/d/claude-mcp.json"'
    expect(
      agentLaunch('claude', {
        claudeSettings: '/d/hooks.json',
        claudeMcpConfig: '/d/claude-mcp.json'
      })
    ).toEqual({ command: `claude --continue ${flags} || claude ${flags}` })
  })

  test('hands Codex its overrides single-quoted, ahead of the subcommand, on both halves', () => {
    const overrides = `-c 'mcp_servers.goatcad.url="http://127.0.0.1:8788/mcp"' -c 'a.b="c"'`
    expect(
      agentLaunch('codex', {
        codexOverrides: ['mcp_servers.goatcad.url="http://127.0.0.1:8788/mcp"', 'a.b="c"']
      })
    ).toEqual({ command: `codex ${overrides} resume --last || codex ${overrides}` })
    // The overrides are Codex's alone.
    expect(agentLaunch('claude', { codexOverrides: ['x="y"'] })).toEqual({
      command: 'claude --continue || claude'
    })
  })

  test('on Windows each half is `call`ed, so `||` sees a .cmd shim fail', () => {
    // An npm-installed CLI is a batch file there, and cmd.exe hides a batch
    // file's exit status from `||` unless it was `call`ed.
    expect(agentLaunch('claude', { claudeSettings: 'C:\\My Data\\hooks.json' }, 'win32')).toEqual({
      command:
        'call claude --continue --settings "C:\\My Data\\hooks.json" || call claude --settings "C:\\My Data\\hooks.json"'
    })
    expect(agentLaunch('shell', {}, 'win32')).toEqual({ command: null })
  })
})

describe('commandShell', () => {
  test("is the login shell's own -c everywhere but Windows", () => {
    expect(
      commandShell({ file: '/bin/bash', args: ['-l'] }, 'claude --continue || claude', 'linux')
    ).toEqual({ file: '/bin/bash', args: ['-l', '-c', 'claude --continue || claude'] })
  })

  test('hands cmd.exe the whole line as one string behind /s /c', () => {
    // A string, not an array: argv quoting would backslash-escape the inner
    // quotes, and cmd.exe reads a backslash as a backslash.
    expect(
      commandShell(
        { file: 'powershell.exe', args: [] },
        'call claude --settings "C:\\a b\\h.json"',
        'win32',
        {
          COMSPEC: 'C:\\Windows\\System32\\cmd.exe'
        }
      )
    ).toEqual({
      file: 'C:\\Windows\\System32\\cmd.exe',
      args: '/d /s /c "call claude --settings "C:\\a b\\h.json""'
    })
    // Never the PowerShell fallback: Windows PowerShell has no `||`.
    expect(commandShell({ file: 'powershell.exe', args: [] }, 'x', 'win32', {}).file).toBe(
      'cmd.exe'
    )
  })
})

describe('probeAgentCli', () => {
  const shell = { file: '/bin/zsh', args: ['-l'] }
  const answering =
    (code: number, calls: string[][] = []) =>
    async (
      command: string,
      args: string[]
    ): Promise<{ code: number; stdout: string; stderr: string }> => {
      calls.push([command, ...args])
      return { code, stdout: '', stderr: '' }
    }

  test('asks the login shell, not this process, whether the CLI exists', async () => {
    // An app launched from Finder has no useful PATH of its own; the shell the
    // tab would run in is the one whose answer matters.
    const calls: string[][] = []
    expect(await probeAgentCli(shell, 'claude', answering(0, calls), 'darwin')).toBe(true)
    expect(calls).toEqual([['/bin/zsh', '-l', '-c', 'command -v claude']])
  })

  test('reads a non-zero exit as not installed', async () => {
    expect(await probeAgentCli(shell, 'codex', answering(1), 'linux')).toBe(false)
  })

  test('uses `where` on Windows, which honours PATHEXT for npm shims', async () => {
    const calls: string[][] = []
    const cmd = { file: 'cmd.exe', args: [] }
    expect(await probeAgentCli(cmd, 'claude', answering(0, calls), 'win32')).toBe(true)
    expect(calls).toEqual([['where.exe', 'claude']])
  })

  test('a shell that cannot start reads as not installed rather than throwing', async () => {
    const failing = async (): Promise<never> => {
      throw new Error('spawn ENOENT')
    }
    expect(await probeAgentCli(shell, 'claude', failing, 'darwin')).toBe(false)
  })
})
