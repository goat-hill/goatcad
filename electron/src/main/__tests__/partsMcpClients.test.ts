import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  claudeCode,
  claudeMcpConfig,
  codex,
  codexMcpOverrides,
  MCP_CLIENTS,
  promptCommand,
  SERVER_NAME,
  TOKEN_ENV,
  WORKSPACE_ENV,
  writeClaudeMcpConfigFile
} from '../partsMcpClients'

const URL_NOW = 'http://127.0.0.1:8788/mcp'

describe('the launch-time definition for Claude Code', () => {
  it('is the mcpServers file shape, naming the token variable rather than the token', () => {
    // Claude Code expands `${VAR}` in these files, so the token stays in the
    // environment and the file is not a secret.
    expect(claudeMcpConfig(URL_NOW)).toEqual({
      mcpServers: {
        [SERVER_NAME]: {
          type: 'http',
          url: URL_NOW,
          headers: {
            Authorization: `Bearer \${${TOKEN_ENV}}`,
            'X-GoatCAD-Workspace': `\${${WORKSPACE_ENV}}`
          }
        }
      }
    })
  })

  it('is written where the launcher points, and rewritten on each launch', () => {
    const dir = mkdtempSync(join(tmpdir(), 'goatcad-mcp-launch-'))
    try {
      writeClaudeMcpConfigFile(join(dir, 'agent-hooks'), 'http://127.0.0.1:1/mcp')
      const path = writeClaudeMcpConfigFile(join(dir, 'agent-hooks'), URL_NOW)
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(claudeMcpConfig(URL_NOW))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('the launch-time definition for Codex', () => {
  it('names the URL and the token variable as TOML values, and never the token', () => {
    const overrides = codexMcpOverrides(URL_NOW)
    expect(overrides).toEqual([
      `mcp_servers.${SERVER_NAME}.url="${URL_NOW}"`,
      `mcp_servers.${SERVER_NAME}.bearer_token_env_var="${TOKEN_ENV}"`,
      `mcp_servers.${SERVER_NAME}.env_http_headers={"X-GoatCAD-Workspace"="${WORKSPACE_ENV}"}`
    ])
  })
})

describe('the manual path', () => {
  const relay = { command: '/Applications/GoatCAD.app/Contents/MacOS/GoatCAD', args: ['mcp'] }
  const spaced = { command: 'C:\\Program Files\\GoatCAD\\GoatCAD.exe', args: ['mcp'] }

  it('registers Claude Code at user scope, as this executable with mcp', () => {
    // `claude mcp add` defaults to `local` scope, which would recreate exactly
    // the per-project coupling the design rejects. No URL and no token: the
    // relay finds the app, so the line never goes stale.
    expect(claudeCode.manual).toBe('command')
    expect(claudeCode.manualText(relay)).toBe(
      `claude mcp add --scope user ${SERVER_NAME} -- /Applications/GoatCAD.app/Contents/MacOS/GoatCAD mcp`
    )
    expect(claudeCode.manualText(spaced)).toContain(
      '-- "C:\\Program Files\\GoatCAD\\GoatCAD.exe" mcp'
    )
  })

  it('gives Codex its config table with the command and arguments', () => {
    const snippet = codex.manualText(relay)
    expect(codex.manual).toBe('snippet')
    expect(snippet.split('\n')).toEqual([
      `[mcp_servers.${SERVER_NAME}]`,
      'command = "/Applications/GoatCAD.app/Contents/MacOS/GoatCAD"',
      'args = ["mcp"]'
    ])
  })

  it('names the file each client keeps its servers in', () => {
    // Declared rather than parsed out of a CLI: Settings needs it before
    // anyone has registered anything.
    expect(claudeCode.configPath().endsWith('.claude.json')).toBe(true)
    expect(codex.configPath().endsWith(join('.codex', 'config.toml'))).toBe(true)
  })

  it('lists both clients, each once', () => {
    expect(MCP_CLIENTS.map((client) => client.id)).toEqual(['claude-code', 'codex'])
  })
})

describe('a prompt as typed', () => {
  it("is Claude Code's /mcp__<server>__<prompt>", () => {
    expect(promptCommand('init')).toBe('/mcp__goatcad__init')
  })
})
