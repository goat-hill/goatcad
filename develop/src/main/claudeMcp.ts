/**
 * The `goatcad` MCP server a worktree's Claude session talks to.
 *
 * Each worktree's GoatCAD runs in that worktree's own profile (`electron/bin/goatcad`),
 * so a relay reaches only the build it was started from. A registration made once
 * with `claude mcp add` names one worktree's `bin/goatcad`, and every session sharing
 * that registration would drive that worktree's app. Instead each session started
 * here gets a config of its own (`claude --mcp-config <file>`) naming its worktree,
 * which outranks a same-named registration (an installed GoatCAD's included).
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

/** The name every GoatCAD build's server is known by (electron's `partsMcpClients.ts`). */
export const SERVER_NAME = 'goatcad'

/** The worktree's `goatcad` command, or null on a branch from before it existed. */
export const goatcadCommand = (worktree: string): string | null => {
  const command = join(worktree, 'electron', 'bin', 'goatcad')
  return existsSync(command) ? command : null
}

/** Write the worktree's MCP config under `dir` and return its path, or null without a `goatcad` command. */
export const writeClaudeMcpFile = (dir: string, worktree: string): string | null => {
  const command = goatcadCommand(worktree)
  if (!command) return null
  // One file per worktree: two sessions in different worktrees may start together.
  const id = createHash('sha256').update(worktree).digest('hex').slice(0, 12)
  const path = join(dir, `claude-mcp-${basename(worktree)}-${id}.json`)
  const config = { mcpServers: { [SERVER_NAME]: { command, args: ['mcp'] } } }
  mkdirSync(dir, { recursive: true })
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n', 'utf8')
  return path
}
