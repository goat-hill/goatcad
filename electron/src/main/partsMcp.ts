/**
 * MCP protocol framing for the parts tools — JSON-RPC 2.0 in, JSON-RPC out.
 *
 * Pure: one function from a parsed message to a response, with no transport and
 * no Electron, so the whole protocol surface is unit-testable without opening a
 * socket. The HTTP transport is `partsMcpServer.ts`; the operations themselves
 * are the registry in `ops/`. See
 * `docs/agent-api.md` for why this file now renders a registry
 * rather than holding a tool list of its own.
 *
 * Hand-rolled rather than built on the MCP SDK, deliberately for now: adding a
 * dependency is the maintainer's call (RULES.md §4), and the request surface a
 * read-only tool server needs is small enough that a prototype should prove the
 * shape before anyone installs anything. If this graduates, the SDK is the
 * obvious answer — it owns session handling, SSE and protocol-version drift,
 * which are exactly the parts most annoying to maintain by hand.
 */
import { registry } from './ops'
import { nearest } from './ops/errors'
import type { OpContext } from './ops/context'
import { capAnswerLists } from './ops/answerLists'
import { INIT_PROJECT_PROMPT } from './partsMcpPrompts'

/** Revisions this server understands. First entry is what we answer with when
 *  the client asks for something we do not know. */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const

export const SERVER_INFO = { name: 'goatcad', version: '0.1.0' } as const

export interface JsonRpcRequest {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: Record<string, unknown>
}

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: string | number | null
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

/** JSON-RPC's own codes; nothing here is a parts failure, which travels as a
 *  successful tool result with `isError` (that is what MCP clients surface to
 *  the model, where a protocol error would just look like a broken server). */
export const RPC_PARSE_ERROR = -32700
export const RPC_INVALID_REQUEST = -32600
export const RPC_METHOD_NOT_FOUND = -32601
export const RPC_INVALID_PARAMS = -32602
export const RPC_INTERNAL_ERROR = -32603

const ok = (id: string | number | null, result: unknown): JsonRpcResponse => ({
  jsonrpc: '2.0',
  id,
  result
})

const fail = (
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown
): JsonRpcResponse => ({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } })

/** Exported so Settings can list what the server exposes rather than restate it
 *  — see `McpServerStatus.prompts`. */
export const MCP_PROMPTS = [INIT_PROJECT_PROMPT]

/**
 * Handle one message.
 *
 * Returns `null` for a notification — a JSON-RPC message with no `id` takes no
 * response, and answering one is a protocol error rather than a courtesy.
 */
type McpContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }

/**
 * What a tool result carries.
 *
 * A payload with an `image` (`render.schematic` is the one that has one) answers as
 * MCP image content with the rest of the payload as text beside it, so a model
 * sees the picture *and* reads the frame that maps its pixels to millimeters.
 * The text comes first because it is what every other tool answers with alone,
 * and a client that cannot show images still gets a complete answer from it.
 * Over HTTP the payload goes out untouched, base64 and all.
 */
export const toolContent = (payload: unknown): McpContent[] => {
  const record =
    payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : null
  const image = record?.image as { mimeType?: unknown; base64?: unknown } | undefined
  if (image && typeof image.mimeType === 'string' && typeof image.base64 === 'string') {
    const rest = Object.fromEntries(Object.entries(record!).filter(([key]) => key !== 'image'))
    return [
      { type: 'text', text: JSON.stringify(rest, null, 2) },
      { type: 'image', data: image.base64, mimeType: image.mimeType }
    ]
  }
  return [{ type: 'text', text: JSON.stringify(payload, null, 2) }]
}

/** What an agent most needs to know before its first call, shown by clients that surface it. */
const INSTRUCTIONS =
  "GoatCAD exposes the running app: distributor part data (DigiKey, Mouser), the libraries this project can see, and its schematic and board. Every design call acts in the workspace (a folder or project, shown in windows or open in the background) this connection is attached to: before the first, call workspace_list, then workspace_attach or workspace_start; an agent started in a GoatCAD terminal tab is already attached. Domains: parts_* find parts and datasheets; symbol_* and footprint_* are library parts, or a placed part's own copy by its reference (with sheet or board); each document has a *_check; schematic_*, board_* and items_* read and edit the open design; bom_* is the parts list; render_* draws a document (over HTTP the PNG is base64 under image.base64); export_* writes fabrication files; workspace_* starts, attaches and closes workspaces and opens, saves and closes their files; project_create makes a project; viewport_* shows the user where you work, as a labeled box on their canvas. Call parts_status before searching parts (the daily quota is small and shared with the app) and project_context before the first design edit (its conventions say how this project spells values, numbers references, names nets, splits sheets and chooses parts). Read before writing (schematic_describe, board_describe, items_get). Open a viewport (viewport_open) for each block of work, pass it to every render and every edit that sets layout (position, angle, size, routing) with an action, a few words on what the call does (\"Route USB_DP\"), which the user's box shows; they refuse without both. Close it (viewport_close) when the block is done. Unless the project's board-intent.md says otherwise, judge design quality visually: render as you go and evaluate placement, readability and routing from the pictures, and route with the editor's interactive router (route_finish, then route_begin, route_preview and route_step), never a router of your own. A design edit lands as an undoable step on an unsaved tab; say what you changed. Do not present a part number or library id these tools did not return. Writes run no checks unless asked: pass checks: true on a write, or after a burst call schematic_check or board_check once with since set to a revision from before it. Board writes never refill zones: they leave every fill stale (stale.fills), and board_refill pours them all. Draw a schematic one block at a time and review each block's render before the next (render_schematic says what to look for); before reporting done, render every sheet legibly and run schematic_check. A schematic is ready for layout when every part bom_get lists has a footprint, and ready to order when each has an MPN and a cached datasheet. Schematic: place a block's main part, then each passive by the pin it serves (schematic_place_symbol with pin) and wire it (schematic_wire); a power symbol per rail per block, and power:PWR_FLAG where a rail enters from a connector; schematic_connect labels only between blocks (global for rails, hierarchical across sheets); a no-connect on each pin left open on purpose; a child sheet per block once there are more than two. Board: project_create sets the copper count and manufacturing profile, board_get_setup and board_update_setup are Board Setup, board_sync carries the schematic over, and route_begin and route_step route tracks with the editor's interactive router, and route_finish finishes connections from chosen pads (Attempt Finish Selected). For more than a handful of edits, layouts computed from the design, or generate-check-fix loops, use app_scripting: it returns a Python client already on disk, with worked examples."

/**
 * The instructions with where the Python client is, when this server writes
 * one: the path saves the agent a call to find it, and a script started from
 * a GoatCAD terminal already has the token in its environment.
 */
const withScriptingPath = (text: string, ctx: OpContext): string => {
  const info = ctx.scripting?.()
  return info
    ? `${text} The client is at ${info.modulePath} (put ${info.pythonPath} on sys.path, then \`from goatcad import connect; gc = connect(workspace=...)\` with your workspace id); the worked examples are ${info.examplePath} and ${info.boardExamplePath}.`
    : text
}

export async function handleMcpMessage(
  message: JsonRpcRequest,
  ctx: OpContext
): Promise<JsonRpcResponse | null> {
  const id = message.id ?? null
  const isNotification = message.id === undefined || message.id === null
  const method = typeof message.method === 'string' ? message.method : ''

  if (!method) {
    return isNotification ? null : fail(id, RPC_INVALID_REQUEST, 'method is required')
  }

  switch (method) {
    case 'initialize': {
      const asked = message.params?.protocolVersion
      const version =
        typeof asked === 'string' &&
        (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(asked)
          ? asked
          : SUPPORTED_PROTOCOL_VERSIONS[0]
      return ok(id, {
        protocolVersion: version,
        capabilities: { tools: {}, prompts: {} },
        serverInfo: SERVER_INFO,
        // Shown by clients that surface it, and the one place to say the thing
        // an agent most needs to know before its first call.
        instructions: withScriptingPath(INSTRUCTIONS, ctx)
      })
    }

    // Notifications. The client tells us it is ready; there is nothing to say.
    case 'notifications/initialized':
    case 'initialized':
      return null

    case 'ping':
      return isNotification ? null : ok(id, {})

    case 'tools/list':
      return ok(id, {
        tools: registry.list().map((op) => ({
          name: op.mcpName,
          description: op.description,
          inputSchema: op.inputSchema
        }))
      })

    case 'tools/call': {
      const name = message.params?.name
      const op = typeof name === 'string' ? registry.get(name) : undefined
      if (!op) {
        // A name that is not an operation is a protocol-level bad parameter,
        // which is what a client branches on — but the nearest real names ride
        // along in `data`, because the reader is usually a model that misspelled
        // one (`docs/agent-api.md`).
        return fail(id, RPC_INVALID_PARAMS, `Unknown tool: ${String(name)}`, {
          code: 'unknown-op',
          candidates: typeof name === 'string' ? nearest(name, registry.mcpNames()) : []
        })
      }

      const rawArgs = message.params?.arguments
      const args =
        rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
          ? (rawArgs as Record<string, unknown>)
          : {}

      // `invoke` validates, runs and converts a thrown handler into an
      // `internal` outcome, so there is nothing left to catch here: a failure is
      // a tool result the model can act on, never a transport error that just
      // looks like a dead server.
      const outcome = await op.invoke(args, ctx)
      // Every token reaches the model: long lists are capped here, never on /v1 (`answerLists.ts`).
      const value = outcome.ok ? capAnswerLists(outcome.value, op.lists) : undefined
      const payload = outcome.ok
        ? outcome.warning === undefined
          ? value
          : { ...(value as Record<string, unknown>), warning: outcome.warning }
        : { ok: false, error: outcome.error }
      return ok(id, { content: toolContent(payload), isError: !outcome.ok })
    }

    case 'prompts/list':
      return ok(id, {
        prompts: MCP_PROMPTS.map((prompt) => ({
          name: prompt.name,
          description: prompt.description,
          arguments: prompt.arguments
        }))
      })

    case 'prompts/get': {
      const name = message.params?.name
      const prompt = MCP_PROMPTS.find((entry) => entry.name === name)
      if (!prompt) return fail(id, RPC_INVALID_PARAMS, `Unknown prompt: ${String(name)}`)
      const rawArgs = message.params?.arguments
      const args =
        rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
          ? (rawArgs as Record<string, unknown>)
          : {}
      return ok(id, {
        description: prompt.description,
        messages: [{ role: 'user', content: { type: 'text', text: prompt.render(args) } }]
      })
    }

    // Declared-but-empty capabilities would make a client call these; we
    // declare neither, so an ask for one is a client bug worth naming.
    default:
      return isNotification ? null : fail(id, RPC_METHOD_NOT_FOUND, `Unknown method: ${method}`)
  }
}
