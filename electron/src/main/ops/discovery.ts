/**
 * How an agent finds out what exists, in three tiers.
 *
 * Design: `docs/agent-api.md`. All three are rendered from the
 * registry, so nothing here can drift from what actually runs:
 *
 * 1. **The list** — every operation's name, summary, scope and `mutates`. About
 *    fifty lines, always affordable. MCP's `tools/list` is this same list
 *    rendered as tools.
 * 2. **The operation** — its guidance, input schema and examples.
 * 3. **The whole schema** — every input schema at once, which is what the
 *    generated Python client is built from.
 */
import { registry, SCHEMA_VERSION } from './index'
import { nearest } from './errors'

export const V1_PREFIX = '/v1/'

export interface DiscoveryResponse {
  status: number
  body: unknown
}

const detail = (name: string): Record<string, unknown> | null => {
  const op = registry.get(name)
  if (!op) return null
  return {
    name: op.name,
    mcpName: op.mcpName,
    summary: op.summary,
    ...(op.guidance ? { guidance: op.guidance } : {}),
    scope: op.scope,
    mutates: op.mutates,
    input: op.inputSchema,
    examples: op.examples
  }
}

/** Answer a `/v1/...` path, or `null` when it is not one we serve. */
export const discovery = (path: string): DiscoveryResponse | null => {
  if (path === '/v1/ops') {
    return {
      status: 200,
      body: {
        ops: registry.list().map((op) => ({
          name: op.name,
          summary: op.summary,
          scope: op.scope,
          mutates: op.mutates
        }))
      }
    }
  }

  if (path.startsWith('/v1/ops/')) {
    const name = decodeURIComponent(path.slice('/v1/ops/'.length))
    const found = detail(name)
    if (found) return { status: 200, body: found }
    return {
      status: 404,
      body: {
        ok: false,
        error: {
          code: 'unknown-op',
          message: `No operation named ${name}.`,
          fix: 'GET /v1/ops for the operations this server actually has.',
          candidates: nearest(name, registry.names())
        }
      }
    }
  }

  if (path === '/v1/schema') {
    return {
      status: 200,
      body: {
        schemaVersion: SCHEMA_VERSION,
        // JSON Schema 2020-12, generated from the DSL rather than hand-written,
        // which is what keeps the published contract and the validator that
        // enforces it the same object.
        dialect: 'https://json-schema.org/draft/2020-12/schema',
        ops: registry.list().map((op) => ({
          name: op.name,
          mcpName: op.mcpName,
          summary: op.summary,
          ...(op.guidance ? { guidance: op.guidance } : {}),
          scope: op.scope,
          mutates: op.mutates,
          input: op.inputSchema,
          examples: op.examples
        }))
      }
    }
  }

  return null
}
