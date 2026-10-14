import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { registry, SCHEMA_VERSION } from '../index'
import { discovery } from '../discovery'
import { defineOp } from '../registry'
import { s } from '../schema'
import { succeed, nearest } from '../errors'
import type { OpContext } from '../context'

/**
 * The tool surface exactly as it was before the registry existed, captured from
 * the old `partsMcpTools.ts` and committed.
 *
 * It is a **floor**, not an exact match, encoding the compatibility rule of
 * `docs/agent-api.md`: within a major version the
 * argument contract may only grow. A new verb is free. A new *optional*
 * argument on an existing verb is free. Changing what a shipped argument means,
 * adding a required one, or opening an object that was closed are all ways to
 * break an agent that already learned the tool, and each fails here.
 *
 * Descriptions are deliberately not frozen: they are prose written for a model
 * and improving them is not a breaking change. It is a committed fixture rather
 * than a `toMatchSnapshot` because the point is to compare against what
 * *shipped*, not against whatever the last run happened to produce.
 */
interface ToolShape {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

const baseline: ToolShape[] = JSON.parse(
  readFileSync(join(__dirname, 'mcp-tools-baseline.json'), 'utf8')
) as ToolShape[]

const withoutDescriptions = (schema: unknown): unknown => {
  if (Array.isArray(schema)) return schema.map(withoutDescriptions)
  if (!schema || typeof schema !== 'object') return schema
  return Object.fromEntries(
    Object.entries(schema as Record<string, unknown>)
      .filter(([key]) => key !== 'description')
      .map(([key, value]) => [key, withoutDescriptions(value)])
  )
}

const rendered = (): ToolShape[] =>
  registry.list().map((op) => ({
    name: op.mcpName,
    description: op.description,
    inputSchema: op.inputSchema
  }))

describe('the registry renders the surface that shipped', () => {
  it('still exposes every tool that shipped, in the same relative order', () => {
    const shipped = new Set(baseline.map((tool) => tool.name))
    const surviving = rendered()
      .map((tool) => tool.name)
      .filter((name) => shipped.has(name))
    expect(surviving).toEqual(baseline.map((tool) => tool.name))
  })

  it.each(baseline.map((tool) => tool.name))('%s stays compatible', (name) => {
    const before = baseline.find((tool) => tool.name === name)!
    const after = rendered().find((tool) => tool.name === name)!

    const properties = (tool: ToolShape): Record<string, unknown> =>
      (tool.inputSchema.properties as Record<string, unknown>) ?? {}
    const required = (tool: ToolShape): string[] => (tool.inputSchema.required as string[]) ?? []

    // Every argument that shipped still means exactly what it meant. Its
    // description is prose for a model and free to improve, like the tool's.
    for (const [key, schema] of Object.entries(properties(before))) {
      expect(withoutDescriptions(properties(after)[key])).toEqual(withoutDescriptions(schema))
    }
    // Nothing new became mandatory, and nothing mandatory was dropped.
    expect(required(after)).toEqual(required(before))
    // Still closed: an unknown field stays an error, never something ignored.
    expect(after.inputSchema.additionalProperties).toBe(false)
    expect(after.description.length).toBeGreaterThan(0)
  })

  it('only ever adds arguments to a tool that shipped', () => {
    // The counterpart to the rule above, asserted once over the whole surface
    // so a removal cannot hide behind a rename.
    for (const before of baseline) {
      const after = rendered().find((tool) => tool.name === before.name)!
      const shipped = Object.keys((before.inputSchema.properties as object) ?? {})
      const now = Object.keys((after.inputSchema.properties as object) ?? {})
      expect(now).toEqual(expect.arrayContaining(shipped))
    }
  })

  it('reaches every operation by its registry name as well as its wire name', () => {
    for (const op of registry.list()) {
      expect(registry.get(op.name)).toBe(op)
      expect(registry.get(op.mcpName)).toBe(op)
    }
  })

  it('gives every operation a domain.verb name', () => {
    for (const op of registry.list()) {
      expect(op.name).toMatch(/^[a-z]+\.[a-z][a-z0-9_]*$/)
    }
  })

  it('marks exactly the operations that edit the design as mutating', () => {
    const mutating = registry
      .list()
      .filter((op) => op.mutates)
      .map((op) => op.name)
      .sort()
    expect(mutating).toEqual([
      'board.apply_interface_preset',
      'board.batch',
      'board.cleanup',
      'board.fanout',
      'board.place_footprint',
      'board.redo',
      'board.refill',
      'board.set_teardrops',
      'board.sync',
      'board.undo',
      'board.update_footprints',
      'board.update_setup',
      'board.update_tuning_patterns',
      'bom.update',
      'footprint.batch',
      'footprint.copy',
      'footprint.create',
      'footprint.delete',
      'footprint.redo',
      'footprint.undo',
      'items.create',
      'items.delete',
      'items.transform',
      'items.update',
      'project.close',
      'project.create',
      'project.create_file',
      'project.save',
      'route.finish',
      'route.step',
      'schematic.add_sheet',
      'schematic.annotate',
      'schematic.batch',
      'schematic.bind',
      'schematic.cleanup',
      'schematic.connect',
      'schematic.place_symbol',
      'schematic.redo',
      'schematic.set_paper',
      'schematic.undo',
      'schematic.update_setup',
      'schematic.update_symbols',
      'schematic.wire',
      'symbol.batch',
      'symbol.copy',
      'symbol.create',
      'symbol.delete',
      'symbol.redo',
      'symbol.undo',
      'workspace.close',
      'workspace.close_file',
      'workspace.close_window',
      'workspace.create_file',
      'workspace.save'
    ])
  })

  it('says a board or sheet argument takes the file name with its extension', () => {
    // The resolvers match exactly (`resolveAgentFile`, `resolveAgentSheet`),
    // so no argument may promise a bare name.
    const misleading: string[] = []
    for (const op of registry.list()) {
      const properties = (op.inputSchema.properties ?? {}) as Record<
        string,
        { description?: string }
      >
      for (const [key, extension] of [
        ['board', '.kicad_pcb'],
        ['sheet', '.kicad_sch']
      ] as const) {
        const text = properties[key]?.description
        if (text !== undefined && !text.includes(extension)) misleading.push(`${op.name}.${key}`)
      }
      if (/bare name/i.test(JSON.stringify(op.inputSchema))) misleading.push(op.name)
    }
    expect(misleading).toEqual([])
  })
})

describe('the workspace argument', () => {
  const seen: Array<string | undefined> = []
  const op = defineOp({
    name: 'demo.where',
    summary: 'Says where it ran.',
    scope: 'app',
    mutates: false,
    input: s.object({ a: s.string().optional() }),
    run: (args, ctx) => {
      seen.push(ctx.workspace)
      return succeed(args)
    }
  })
  const ctx = { parts: {} as OpContext['parts'] }

  it('is on every op, taken out before the handler, and wins over the header', async () => {
    expect((op.inputSchema.properties as Record<string, unknown>).workspace).toBeDefined()
    const answer = await op.invoke(
      { a: 'x', workspace: 'ws_1' },
      { ...ctx, workspace: 'ws_header' }
    )
    expect(answer).toEqual({ ok: true, value: { a: 'x' } })
    expect(seen.at(-1)).toBe('ws_1')
    await op.invoke({}, { ...ctx, workspace: 'ws_header' })
    expect(seen.at(-1)).toBe('ws_header')
    expect(await op.invoke({ workspace: '' }, ctx)).toMatchObject({
      ok: false,
      error: { code: 'invalid-args', path: '/workspace' }
    })
  })

  it("keeps an op's own workspace argument, which names its target", () => {
    const own = registry.get('workspace.close')!
    expect(JSON.stringify(own.inputSchema)).toContain('A workspace id from workspace_list')
  })
})

describe('discovery', () => {
  it('lists every operation with what a client needs to choose one', () => {
    const answer = discovery('/v1/ops')!
    expect(answer.status).toBe(200)
    const body = answer.body as { ops: Array<{ name: string; scope: string; mutates: boolean }> }
    expect(body.ops).toHaveLength(registry.list().length)
    expect(body.ops[0]).toEqual({
      name: 'workspace.list',
      summary: registry.get('workspace.list')!.summary,
      scope: 'app',
      mutates: false
    })
  })

  it('serves one operation with its guidance and schema', () => {
    const answer = discovery('/v1/ops/schematic.place_symbol')!
    expect(answer.status).toBe(200)
    const body = answer.body as { name: string; guidance: string; input: Record<string, unknown> }
    expect(body.name).toBe('schematic.place_symbol')
    expect(body.guidance).toContain('undo step')
    expect(body.input).toHaveProperty('properties')
  })

  it('answers an unknown operation with the nearest real names', () => {
    const answer = discovery('/v1/ops/schematic.place_symbl')!
    expect(answer.status).toBe(404)
    const body = answer.body as { error: { code: string; candidates: string[] } }
    expect(body.error.code).toBe('unknown-op')
    expect(body.error.candidates).toContain('schematic.place_symbol')
  })

  it('publishes every input schema at one address, versioned', () => {
    const answer = discovery('/v1/schema')!
    const body = answer.body as { schemaVersion: string; ops: unknown[] }
    expect(body.schemaVersion).toBe(SCHEMA_VERSION)
    expect(body.ops).toHaveLength(registry.list().length)
  })

  it('is not a catch-all', () => {
    expect(discovery('/mcp')).toBeNull()
    expect(discovery('/v1/nope')).toBeNull()
  })
})

describe('nearest', () => {
  it('offers a typo its correction', () => {
    expect(nearest('symbol_serach', ['symbol_search', 'parts_search'])).toContain('symbol_search')
  })

  it('offers nothing for a name that resembles nothing', () => {
    expect(nearest('xyzzy', ['symbol_search', 'schematic_place_symbol'])).toEqual([])
  })
})

describe('an operation validates before it runs', () => {
  const ctx = {} as OpContext
  const probe = defineOp({
    name: 'test.probe',
    summary: 'A probe.',
    scope: 'app',
    mutates: false,
    input: s.object({
      name: s.string().trim(),
      count: s.integer().min(1).max(10).optional(),
      tags: s.array(s.string()).optional()
    }),
    run: (args) => succeed(args)
  })

  it('derives the MCP name from the registry name when nothing overrides it', () => {
    expect(probe.mcpName).toBe('test_probe')
  })

  it('passes the handler a typed, trimmed value', async () => {
    const outcome = await probe.invoke({ name: '  U1  ' }, ctx)
    expect(outcome).toEqual({ ok: true, value: { name: 'U1' } })
  })

  it('names the missing field with a pointer', async () => {
    const outcome = await probe.invoke({}, ctx)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.error.code).toBe('invalid-args')
      expect(outcome.error.path).toBe('/name')
    }
  })

  it('refuses an unknown field rather than dropping it', async () => {
    const outcome = await probe.invoke({ name: 'U1', nmae: 'U2' }, ctx)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.error.path).toBe('/nmae')
      expect(outcome.error.message).toContain('unknown field')
    }
  })

  it('points into an array at the entry that is wrong', async () => {
    const outcome = await probe.invoke({ name: 'U1', tags: ['a', 3] }, ctx)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error.path).toBe('/tags/1')
  })

  it('enforces the bounds it publishes', async () => {
    const outcome = await probe.invoke({ name: 'U1', count: 99 }, ctx)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error.message).toContain('at most 10')
  })

  it('rejects a fraction where it publishes an integer', async () => {
    const outcome = await probe.invoke({ name: 'U1', count: 2.5 }, ctx)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error.message).toContain('whole number')
  })

  it('reports a handler that throws as our bug, not as a bad request', async () => {
    const boom = defineOp({
      name: 'test.boom',
      summary: 'Throws.',
      scope: 'app',
      mutates: false,
      input: s.object({}),
      run: () => {
        throw new Error('boom')
      }
    })
    const outcome = await boom.invoke({}, ctx)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.error.code).toBe('internal')
      expect(outcome.error.message).toBe('boom')
    }
  })
})

describe('schematic.annotate', () => {
  const requests: unknown[] = []
  const ctx = {
    design: async (request: unknown) => {
      requests.push(request)
      return { ok: true, payload: { renamed: [] } }
    }
  } as unknown as OpContext
  const op = registry.get('schematic.annotate')!

  it('defaults to the whole design, kept numbers, reading order', async () => {
    requests.length = 0
    await op.invoke({}, ctx)
    expect(requests[0]).toEqual({
      kind: 'annotate-schematic',
      scope: 'design',
      recurse: false,
      order: 'xy',
      numbering: 'sequential',
      start: 0,
      reset: false,
      dryRun: false
    })
  })

  it('named symbols confine the run to the sheet', async () => {
    requests.length = 0
    await op.invoke({ symbols: ['R?', 'C12'], sheet: 'power.kicad_sch', start: 100.7 }, ctx)
    expect(requests[0]).toMatchObject({
      scope: 'sheet',
      symbols: ['R?', 'C12'],
      sheet: 'power.kicad_sch',
      start: 100
    })
  })

  it('refuses a negative start and an empty symbol list', async () => {
    const negative = await op.invoke({ start: -1 }, ctx)
    expect(negative.ok).toBe(false)
    const empty = await op.invoke({ symbols: [] }, ctx)
    expect(empty.ok).toBe(false)
  })
})

describe('writes are fast by default: checks are asked for', () => {
  // Every write whose answer can carry a check delta, and so takes `checks`.
  const CHECKED = [
    'board.batch',
    'board.cleanup',
    'board.fanout',
    'board.place_footprint',
    'board.refill',
    'board.set_teardrops',
    'board.sync',
    'board.update_footprints',
    'board.update_setup',
    'board.update_tuning_patterns',
    'items.create',
    'items.delete',
    'items.update',
    'items.transform',
    'footprint.batch',
    'route.finish',
    'route.step',
    'schematic.add_sheet',
    'schematic.annotate',
    'schematic.batch',
    'schematic.bind',
    'schematic.cleanup',
    'schematic.connect',
    'schematic.place_symbol',
    'schematic.set_paper',
    'schematic.update_setup',
    'schematic.update_symbols',
    'schematic.wire',
    'symbol.batch'
  ]

  it('each such write declares checks, and none requires it', () => {
    for (const name of CHECKED) {
      const schema = registry.get(name)!.inputSchema as {
        properties: Record<string, unknown>
        required?: string[]
      }
      expect(schema.properties.checks, name).toBeDefined()
      expect(schema.required ?? [], name).not.toContain('checks')
    }
    const declaring = registry
      .list()
      .filter((op) => 'checks' in ((op.inputSchema.properties as object | undefined) ?? {}))
      .map((op) => op.name)
      .sort()
    expect(declaring).toEqual([...CHECKED].sort())
  })

  it('forwards checks to the window only when asked', () => {
    const op = registry.get('items.update')!
    const asked = op.designRequest!({ id: 'R1', record: { dnp: true }, checks: true })
    const quiet = op.designRequest!({ id: 'R1', record: { dnp: true } })
    expect(asked.ok && asked.request).toMatchObject({ kind: 'update-item', checks: true })
    expect(quiet.ok && 'checks' in quiet.request).toBe(false)
    // On a board, the request builder spreads what is left: checks is not among it.
    const board = op.designRequest!({ board: 'b.kicad_pcb', id: 'R1', record: { locked: true } })
    expect(board.ok).toBe(true)
  })

  it('a batch is checked as one write, never per entry', async () => {
    const ctx = {} as OpContext
    for (const [name, args] of [
      ['board.batch', {}],
      ['schematic.batch', {}],
      ['footprint.batch', { footprint: 'proj:T' }]
    ] as const) {
      const outcome = await registry.get(name)!.invoke(
        {
          ...args,
          ops: [{ op: 'items.update', args: { id: 'R1', record: { x: 1 }, checks: true } }]
        },
        ctx
      )
      expect(outcome.ok, name).toBe(false)
      expect(!outcome.ok && outcome.error.message, name).toContain('its own checks')
    }
  })
})
