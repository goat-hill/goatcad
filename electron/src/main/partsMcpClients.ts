/**
 * The MCP clients GoatCAD knows how to hand its server to.
 *
 * The shape of this file is an
 * argument, so it is worth stating: **an agent tab is told about the server
 * when it launches; nothing is registered.** Both CLIs accept a server
 * definition on their command line — Claude Code through `--mcp-config`, Codex
 * through `-c` overrides — and the terminal tab already launches them, so it
 * hands over the live URL and token every time. There is no entry in the
 * client's config to go stale when the token is replaced or the port moves,
 * nothing to repair on launch, and nothing to find on `PATH` from a process
 * that (launched from Finder or a desktop menu) has no useful `PATH` at all.
 *
 * What is left for a client to *store* is the manual path: a person
 * running the CLI in their own terminal, outside GoatCAD, registers the server
 * themselves with a line Settings shows them. We never write a client's config
 * file — `~/.claude.json` and `~/.codex/config.toml` are theirs.
 *
 * Electron-free. The one file this writes is the app's own.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** The name the server is known by, in every client. Tools are `mcp__goatcad__*`
 *  and prompts `/mcp__goatcad__<name>`, so this is user-visible and must not drift. */
export const SERVER_NAME = 'goatcad'

/** A prompt as a user types it in Claude Code, `/mcp__<server>__<prompt>`; its `/`
 *  menu lists it as `/goatcad:<name> (MCP)`. */
export const promptCommand = (name: string): string => `/mcp__${SERVER_NAME}__${name}`

/**
 * The environment variable an agent tab carries the token in. Both CLIs read
 * it from there — Codex through `bearer_token_env_var`, Claude Code by
 * expanding it in its definition file — which keeps the secret off every
 * command line and out of every file but its own store.
 */
export const TOKEN_ENV = 'GOATCAD_MCP_TOKEN'

/**
 * The environment variable an agent tab carries its workspace id in
 * (`workspaces.ts`). Both CLIs send it as `X-GoatCAD-Workspace` on the session's
 * `initialize`, which attaches the session to the tab's workspace, and the
 * Python client attaches to it when a script started from the tab connects.
 */
export const WORKSPACE_ENV = 'GOATCAD_WORKSPACE'

export type McpClientId = 'claude-code' | 'codex'

export interface McpClient {
  id: McpClientId
  /** A product name — a proper noun, so not translated. */
  name: string
  /**
   * What the manual path copies: a shell command for a client whose CLI can
   * take a header, or a config snippet for one whose CLI cannot.
   */
  manual: 'command' | 'snippet'
  manualText(url: string, token: string): string
  /** The file the manual path ends up in. Shown, never written by us. */
  configPath(): string
}

/**
 * Claude Code.
 *
 * `--scope user` is load-bearing in the manual line: `claude mcp add` defaults
 * to `local`, stored per directory, which would recreate the per-project
 * coupling a user-scope registration avoids.
 */
export const claudeCode: McpClient = {
  id: 'claude-code',
  name: 'Claude Code',
  manual: 'command',
  manualText: (url, token) =>
    `claude mcp add --scope user --transport http ${SERVER_NAME} ${url} --header "Authorization: Bearer ${token}"`,
  // Where `--scope user` writes.
  configPath: () => join(homedir(), '.claude.json')
}

/**
 * Codex.
 *
 * `codex mcp add` takes a bearer token only as an environment-variable *name*,
 * which a person's own terminal would then have to export every time — so the
 * manual path is the `config.toml` table instead, with the header inline.
 */
export const codex: McpClient = {
  id: 'codex',
  name: 'Codex',
  manual: 'snippet',
  manualText: (url, token) =>
    [
      `[mcp_servers.${SERVER_NAME}]`,
      `url = "${url}"`,
      `http_headers = { Authorization = "Bearer ${token}" }`
    ].join('\n'),
  configPath: () => join(homedir(), '.codex', 'config.toml')
}

export const MCP_CLIENTS: McpClient[] = [claudeCode, codex]

// ------------------------------------------------------------ launch config

/**
 * The file Claude Code loads through `--mcp-config`. A definition given this
 * way outranks a same-named one in the user's own config, so a registration
 * left over from an older GoatCAD does no harm inside a tab. The header names
 * the token's environment variable rather than the token — Claude Code expands
 * `${VAR}` in these files (verified against a live server) — so the token is
 * never written anywhere but its own store (`mcpToken.ts`).
 */
export const claudeMcpConfig = (url: string): Record<string, unknown> => ({
  mcpServers: {
    [SERVER_NAME]: {
      type: 'http',
      url,
      headers: {
        Authorization: `Bearer \${${TOKEN_ENV}}`,
        'X-GoatCAD-Workspace': `\${${WORKSPACE_ENV}}`
      }
    }
  }
})

const CLAUDE_MCP_FILE = 'claude-mcp.json'

/**
 * Write that file under the app's own data directory, beside the hooks file
 * the launcher also hands over. Rewritten on every launch, because it holds
 * the port as it is *now*. Not a secret: it names a loopback port and a
 * variable.
 */
export const writeClaudeMcpConfigFile = (dir: string, url: string): string => {
  const path = join(dir, CLAUDE_MCP_FILE)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path, JSON.stringify(claudeMcpConfig(url), null, 2) + '\n', 'utf8')
  return path
}

/**
 * The `-c key=value` overrides that define the server for one Codex session.
 * Each value is TOML, hence the inner quotes; the token is not here — it rides
 * in the environment under the variable the second override names.
 */
export const codexMcpOverrides = (url: string): string[] => [
  `mcp_servers.${SERVER_NAME}.url="${url}"`,
  `mcp_servers.${SERVER_NAME}.bearer_token_env_var="${TOKEN_ENV}"`,
  `mcp_servers.${SERVER_NAME}.env_http_headers={"X-GoatCAD-Workspace"="${WORKSPACE_ENV}"}`
]
