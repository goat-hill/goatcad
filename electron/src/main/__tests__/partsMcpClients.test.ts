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
  const server = { url: URL_NOW, token: 'tok' }

  it('registers Claude Code at user scope, by URL with the token', () => {
    // `claude mcp add` defaults to `local` scope, which would recreate exactly
    // the per-project coupling the design rejects. Nothing launches the app for
    // the client: the URL answers only while it runs.
    expect(claudeCode.manual).toBe('command')
    expect(claudeCode.manualText(server)).toBe(
      `claude mcp add --transport http --scope user ${SERVER_NAME} ${URL_NOW} --header "Authorization: Bearer tok"`
    )
  })

  it('registers a development build for its folder only', () => {
    // So it shadows an installed GoatCAD's registration there instead of replacing it.
    expect(claudeCode.manualText({ ...server, dev: true })).toContain(
      `--scope local ${SERVER_NAME} `
    )
  })

  it('gives Codex its config table with the URL and the header', () => {
    const snippet = codex.manualText(server)
    expect(codex.manual).toBe('snippet')
    expect(snippet.split('\n')).toEqual([
      `[mcp_servers.${SERVER_NAME}]`,
      `url = "${URL_NOW}"`,
      'http_headers = { Authorization = "Bearer tok" }'
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
