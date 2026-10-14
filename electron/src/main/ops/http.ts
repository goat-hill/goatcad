/**
 * The `/v1` surface: discovery by GET, calls by POST.
 *
 * This is what the Python client and the CLI talk to, and it exists so neither
 * has to tunnel through MCP's JSON-RPC framing to reach an operation. MCP is one
 * client of the registry, not the protocol underneath it
 * (`docs/agent-api.md`).
 *
 * The error rule is the reason a caller can parse one shape:
 * **operation failures are `200` with the envelope; only transport and auth are
 * HTTP errors.** A client that cannot read the body should not have to guess
 * which of the two it got — a 404 means "no such route", never "that pin does
 * not exist".
 *
 * The exception is a GET for an operation that does not exist, which is a
 * missing *resource* rather than a failed call, and answers 404 with the
 * envelope in the body so both readings work.
 */
import type { OpContext } from './context'
import { registry } from './index'
import { discovery, V1_PREFIX } from './discovery'
import { nearest } from './errors'

export interface V1Response {
  status: number
  body: unknown
}

const OPS_PREFIX = '/v1/ops/'

/** Answer a `/v1/...` request, or `null` when the path is not one we serve. */
export const handleV1 = async (
  method: string,
  path: string,
  body: unknown,
  ctx: OpContext
): Promise<V1Response | null> => {
  if (!path.startsWith(V1_PREFIX)) return null

  if (method === 'GET') return discovery(path)

  if (method === 'POST' && path.startsWith(OPS_PREFIX)) {
    const name = decodeURIComponent(path.slice(OPS_PREFIX.length))
    const op = registry.get(name)
    if (!op) {
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

    // A body that is not an object is the caller sending arguments wrong, which
    // is an argument error like any other rather than a malformed request.
    const args =
      body && typeof body === 'object' && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : {}

    const outcome = await op.invoke(args, ctx)
    return { status: 200, body: outcome }
  }

  // A path under /v1 that exists for another method: say which, rather than
  // 404ing and sending the caller looking for a typo.
  return { status: 405, body: { error: 'method not allowed' } }
}
