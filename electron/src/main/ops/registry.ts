/**
 * `defineOp`, and what the registry is for.
 *
 * One TypeScript module per operation — name, schemas, guidance, handler — and
 * every client is **generated from it**: MCP tools, the discovery endpoints, and
 * (later) the Python client and the CLI. Nothing is hand-written twice. Design:
 * `docs/agent-api.md`.
 *
 * The registry, not the handler, does two things before a call reaches the
 * renderer: it resolves the name, and it validates the arguments. A
 * handler therefore never sees a malformed request and never has to defend
 * against one; its job is semantics only.
 *
 * An operation has one name: `domain.verb` here and over HTTP, and the same
 * with `_` for the dot as an MCP tool (`mcpName`).
 */
import type { McpDesignRequest } from '../../preload/mcpTypes'
import type { OpContext } from './context'
import { design } from './design'
import { invalidArgs, internal, type OpFailure, type OpOutcome } from './errors'
import type { Schema } from './schema'
import { ACTION_FIX, oneLine } from './viewport/action'

/** What must be open for a call to mean anything. Published in the operation
 *  list so a client can tell an agent why a verb is unavailable before it
 *  spends a turn finding out. */
export type OpScope = 'app' | 'project' | 'schematic' | 'board' | 'library'

export interface OpExample {
  args: Record<string, unknown>
  note: string
}

export interface OpSpec<I> {
  /** `domain.verb`, stable forever once shipped. */
  name: string
  /** The one line a tool list shows. */
  summary: string
  /** The paragraph a model reads before calling: what to read first, what it
   *  refuses, what a wrong call looks like. */
  guidance?: string
  input: Schema<I>
  mutates: boolean
  scope: OpScope
  /** Shipped in the schema resource and the generated docstrings, because a
   *  model copies an example far more reliably than it composes from a schema. */
  examples?: OpExample[]
  /**
   * The answer's per-item lists, as dotted paths ("escapes", "nets.added"),
   * that an MCP answer caps beside `changed` (`answerLists.ts`).
   */
  lists?: readonly string[]
  /** A document batch: the ops its entries may name, which the Python transaction queues. */
  batchOps?: readonly string[]
  run(args: I, ctx: OpContext): Promise<OpOutcome> | OpOutcome
}

/** An operation with its argument type erased, so one list can hold them all. */
export interface RegisteredOp {
  name: string
  mcpName: string
  summary: string
  guidance?: string
  scope: OpScope
  mutates: boolean
  examples: OpExample[]
  /** The answer's per-item lists an MCP answer caps (`OpSpec.lists`). */
  lists: readonly string[]
  /** A document batch's entry ops (`OpSpec.batchOps`). */
  batchOps?: readonly string[]
  inputSchema: Record<string, unknown>
  /** Summary and guidance as one string, which is what a protocol with a single
   *  description field gets. Joined with a space rather than a blank line so the
   *  seventeen migrated operations render byte-identically to what they read as
   *  before the split; the separator is the one knob to turn once that no longer
   *  matters. */
  description: string
  /** Validate, then run. Never throws: a handler that does is reported as our
   *  bug, because the caller is a tool result an agent has to act on. */
  invoke(rawArgs: Record<string, unknown>, ctx: OpContext): Promise<OpOutcome>
  /**
   * Validate, and build the window request this operation *would* send —
   * without sending it. Present only on operations the window serves.
   *
   * This is what makes `batch` possible. A batch has to hand the window
   * every edit at once, so that one snapshot covers them all and a failure
   * halfway rolls the whole thing back; it cannot do that by running the
   * operations one at a time and hoping. Splitting "what would you ask for"
   * from "ask for it" is the smallest seam that allows it, and it keeps each
   * operation's own preconditions where they belong — a refusal here never
   * reaches the window either.
   */
  designRequest?(rawArgs: Record<string, unknown>): DesignRequestResult
}

/** What a request builder answers with: the window request, or the refusal that
 *  means it never reaches the window. */
export type DesignRequestResult = { ok: true; request: McpDesignRequest } | OpFailure

export function defineOp<I>(spec: OpSpec<I>): RegisteredOp {
  const description = [spec.summary, spec.guidance].filter(Boolean).join(' ')
  return {
    name: spec.name,
    mcpName: spec.name.replace(/\./g, '_'),
    summary: spec.summary,
    ...(spec.guidance ? { guidance: spec.guidance } : {}),
    scope: spec.scope,
    mutates: spec.mutates,
    examples: spec.examples ?? [],
    lists: spec.lists ?? [],
    ...(spec.batchOps ? { batchOps: spec.batchOps } : {}),
    inputSchema: spec.input.json,
    description,
    async invoke(rawArgs, ctx) {
      const parsed = spec.input.parse(rawArgs, '')
      if (!parsed.ok) {
        const { path, message } = parsed.issue
        // The pointer names the field and the message says what was wrong with
        // it; together they are the whole of what a caller needs to fix it.
        const field = path.replace(/^\//, '') || 'arguments'
        return invalidArgs(`\`${field}\` ${message}.`, path || '/', schemaFix(spec.name, path))
      }
      try {
        return await spec.run(parsed.value, ctx)
      } catch (err) {
        return internal(err instanceof Error ? err.message : String(err), 'handler-threw')
      }
    }
  }
}

/** The registry itself: a lookup by both names, and the list every discovery
 *  tier is rendered from. */
export class OpRegistry {
  private readonly ops: RegisteredOp[]
  private readonly byName = new Map<string, RegisteredOp>()

  constructor(ops: RegisteredOp[]) {
    this.ops = ops
    for (const op of ops) {
      this.byName.set(op.name, op)
      this.byName.set(op.mcpName, op)
    }
  }

  list(): readonly RegisteredOp[] {
    return this.ops
  }

  /** Resolves a registry name or an MCP wire name; they are one operation. */
  get(name: string): RegisteredOp | undefined {
    return this.byName.get(name)
  }

  /** Every name a caller may legitimately use, for `unknown-op` candidates. */
  names(): string[] {
    return [...this.byName.keys()]
  }

  /** Just the wire names, for a caller that only knows those — suggesting
   *  `schematic.place_symbol` to a client whose tool list says `schematic_place_symbol` would be
   *  a correction it cannot act on. */
  mcpNames(): string[] {
    return this.ops.map((op) => op.mcpName)
  }
}

/**
 * An operation the window serves.
 *
 * The body is `request`: what to ask the window for, or a refusal raised before
 * anything crosses the bridge. `run` and `designRequest` are both generated from
 * it, so the two can never disagree about what an operation does — which is the
 * failure this shape exists to make impossible, since `batch` executes through
 * one and an ordinary call through the other.
 */
export interface DesignOpSpec<I> extends Omit<OpSpec<I>, 'run'> {
  /** `ctx` is absent for a batch entry. */
  request(args: I, ctx?: OpContext): McpDesignRequest | OpFailure
  /** A check that needs main's context — the library index, say — before the
   *  request crosses to the window. A failure here is the answer; null lets
   *  the request through. Runs on a direct call only: a batch entry is
   *  validated by the window, which holds the same index. */
  validate?(args: I, ctx: OpContext): Promise<OpFailure | null>
}

const isRefusal = (value: McpDesignRequest | OpFailure): value is OpFailure => 'ok' in value

/**
 * The window request for parsed arguments. `checks` (`checksArg`), which a
 * write declares, is forwarded here rather than by each op, so a request
 * builder never sees it among the arguments it spreads. `viewport` and
 * `action` (`viewport/`) are forwarded here too, the action as one line of
 * plain text; a builder still reads them where its requirement depends on
 * other arguments. A required viewport is forwarded as given, an optional one
 * only when set.
 */
function buildRequest<I>(
  spec: DesignOpSpec<I>,
  args: I,
  ctx?: OpContext
): McpDesignRequest | OpFailure {
  const { checks, ...rest } = args as I & { checks?: boolean }
  const built = spec.request(rest as I, ctx)
  if (isRefusal(built)) return built
  const { viewport, action } = rest as { viewport?: string; action?: string }
  const required = (spec.input.json.required as string[] | undefined)?.includes('viewport')
  return {
    ...built,
    ...(checks === true ? { checks: true } : {}),
    ...(viewport || (required && viewport !== undefined) ? { viewport } : {}),
    ...(action ? { action: oneLine(action) } : {})
  } as McpDesignRequest
}

/** A schema refusal's fix: a missing action names what to pass; the rest point at the schema. */
const schemaFix = (name: string, path: string): string =>
  path === '/action'
    ? ACTION_FIX
    : `Read the input schema for ${name} and send the argument it declares.`

export function defineDesignOp<I>(spec: DesignOpSpec<I>): RegisteredOp {
  const op = defineOp<I>({
    ...spec,
    run: async (args, ctx) => {
      const veto = spec.validate ? await spec.validate(args, ctx) : null
      if (veto) return veto
      const built = buildRequest(spec, args, ctx)
      return isRefusal(built) ? built : design(ctx, built)
    }
  })
  return {
    ...op,
    designRequest(rawArgs) {
      const parsed = spec.input.parse(rawArgs, '')
      if (!parsed.ok) {
        const field = parsed.issue.path.replace(/^\//, '') || 'arguments'
        return invalidArgs(
          `\`${field}\` ${parsed.issue.message}.`,
          parsed.issue.path || '/',
          schemaFix(spec.name, parsed.issue.path)
        )
      }
      const built = buildRequest(spec, parsed.value)
      return isRefusal(built) ? built : { ok: true, request: built }
    }
  }
}
