import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  handleMcpMessage,
  RPC_INVALID_PARAMS,
  RPC_METHOD_NOT_FOUND,
  SUPPORTED_PROTOCOL_VERSIONS,
  toolContent
} from '../partsMcp'
import { registry } from '../ops'
import {
  buildFilters,
  priceAtQuantity,
  resetCategoryVocabulary,
  PROVIDER_CAPABILITIES,
  quotaSummary
} from '../ops/parts/shared'
import { DESIGN_REMEDY } from '../ops/design'
import type { DesignOutcome, OpEffect, PartsService, OpContext } from '../ops/context'
import type { DatasheetRecord } from '../partsMcpDatasheets'
import { joinArguments } from '../partsMcpPrompts'
import type {
  PartCategory,
  PartsCredentialStatus,
  PartsFilterState,
  PartRecord,
  PartSearchResult,
  PartsUsage
} from '../../preload/partsTypes'

import type { JsonRpcResponse } from '../partsMcp'
import type { IndexRecord } from '../libraryIndexTypes'
import type { McpDesignRequest } from '../../preload/mcpTypes'
import { handleV1 } from '../ops/http'

/** What each method answers, so assertions read the real shape rather than
 *  casting through `any`. */
interface InitializeResult {
  protocolVersion: string
  serverInfo: { name: string; version: string }
  capabilities: Record<string, unknown>
  instructions: string
}
interface ToolsListResult {
  tools: Array<{ name: string; description: string; inputSchema: { type: string } }>
}
interface ToolCallResult {
  content: Array<{ type: string; text: string }>
  isError: boolean
}
interface PromptsListResult {
  prompts: Array<{ name: string; description: string; arguments: Array<{ name: string }> }>
}
interface PromptGetResult {
  description: string
  messages: Array<{ role: string; content: { type: string; text: string } }>
}
interface StatusPayload {
  providers: Array<{
    provider: string
    capabilities: Record<string, boolean>
    keyHint: string | null
  }>
  connectedCount: number
  canBrowseCategories: boolean
  guidance: string
}
interface PartRowPayload {
  mpn: string
  manufacturer: string
  productUrl: string | null
  offers: Array<{
    distributorPartNumber: string
    packaging: string | null
    moq: number | null
    stock: number | null
    priceAtQty: { quantity: number; unitPrice: number } | null
  }>
}
interface ComparePayload {
  distributors: Array<{
    distributor: string
    part: PartRowPayload | null
    matches?: number
    manufacturers?: string[]
    error?: { kind: string; remedy: string }
  }>
}
interface SearchPayload {
  distributor: string
  total: number
  count: number
  guidance?: string
  parts: PartRowPayload[]
  quota: Array<{
    provider: string
    minuteRemaining: number
    dayRemaining: number
    resetsAt: number
  }>
}
interface OpenSettingsPayload {
  opened: boolean
  provider: string | null
}

const resultOf = <T>(response: JsonRpcResponse | null): T => response!.result as T

const status = (overrides: Partial<PartsCredentialStatus> = {}): PartsCredentialStatus => ({
  provider: 'digikey',
  configured: true,
  hint: 'abc123',
  lastVerifiedAt: 1_700_000_000_000,
  encryptionAvailable: true,
  ...overrides
})

const usage = (overrides: Partial<PartsUsage> = {}): PartsUsage => ({
  provider: 'digikey',
  minute: { used: 3, limit: 120 },
  day: { used: 40, limit: 1000, resetsAt: 1_700_086_400_000 },
  lastSuccessAt: null,
  ...overrides
})

/** A distributor row: a DigiKey product with two packagings unless told otherwise. */
const part = (overrides: Partial<PartRecord> = {}): PartRecord => ({
  provider: 'digikey',
  providerPartId: '497-CT-ND',
  mpn: 'STM32F405RGT6',
  manufacturer: 'STMicroelectronics',
  description: 'IC MCU 32BIT',
  datasheetUrl: 'https://example.invalid/ds.pdf',
  photoUrl: null,
  productUrl: 'https://example.invalid/dk',
  lifecycle: 'active',
  rohs: 'Compliant',
  parameters: [],
  offers: [
    {
      distributorPartNumber: '497-CT-ND',
      stock: 4000,
      moq: 1,
      currency: 'USD',
      priceBreaks: [
        { quantity: 1, unitPrice: 12.5 },
        { quantity: 10, unitPrice: 10.2 },
        { quantity: 100, unitPrice: 8.75 }
      ],
      packaging: 'Cut Tape (CT)',
      productUrl: null
    },
    {
      distributorPartNumber: '497-TR-ND',
      stock: 6000,
      moq: 1000,
      currency: 'USD',
      priceBreaks: [{ quantity: 1000, unitPrice: 7.1 }],
      packaging: 'Tape & Reel (TR)',
      productUrl: null
    }
  ],
  cad: { mode: 'none' },
  fetchedAt: 0,
  ...overrides
})

const emptySearch = (): PartSearchResult => ({
  parts: [],
  total: 0,
  facets: { manufacturers: [], packaging: [], status: [], series: [], parametric: [] }
})

const stubService = (overrides: Partial<PartsService> = {}): PartsService => ({
  credentialStatus: () => [status(), status({ provider: 'mouser', configured: false, hint: null })],
  usage: () => [usage(), usage({ provider: 'mouser', minute: { used: 0, limit: 30 } })],
  categories: async () => ({ ok: true, value: [] }),
  search: async () => ({ ok: true, value: emptySearch() }),
  ...overrides
})

const ctx = (
  overrides: Partial<PartsService> = {},
  emit?: (effect: OpEffect) => void
): OpContext => ({
  parts: stubService(overrides),
  emit
})

/**
 * The error envelope, as a failing tool result carries it
 * (`docs/agent-api.md`: MCP failures are `isError: true`
 * with the envelope as the text content, so a model reads `fix` directly).
 */
interface ErrorEnvelope {
  ok: false
  error: {
    code: string
    message: string
    fix?: string
    kind?: string
    candidates?: string[]
    path?: string
    data?: Record<string, unknown>
  }
}

const errorOf = (payload: unknown): ErrorEnvelope['error'] => (payload as ErrorEnvelope).error

const callTool = async <T>(
  name: string,
  args: Record<string, unknown>,
  overrides: Partial<PartsService> = {},
  emit?: (effect: OpEffect) => void
): Promise<{ payload: T; isError: boolean }> => {
  const response = await handleMcpMessage(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    ctx(overrides, emit)
  )
  const result = resultOf<ToolCallResult>(response)
  return { payload: JSON.parse(result.content[0].text) as T, isError: result.isError }
}

describe('protocol framing', () => {
  it('echoes a protocol version it supports, and falls back to its newest when it does not', async () => {
    const known = await handleMcpMessage(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
      ctx()
    )
    expect(resultOf<InitializeResult>(known).protocolVersion).toBe('2024-11-05')

    const unknown = await handleMcpMessage(
      { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } },
      ctx()
    )
    expect(resultOf<InitializeResult>(unknown).protocolVersion).toBe(SUPPORTED_PROTOCOL_VERSIONS[0])
  })

  it('tells a session where the Python client is, so finding it costs no call', async () => {
    const initialize = { jsonrpc: '2.0' as const, id: 1, method: 'initialize' }
    const withClient = await handleMcpMessage(initialize, {
      ...ctx(),
      scripting: () => ({
        pythonPath: '/config/python',
        modulePath: '/config/python/goatcad.py',
        examplePath: '/config/python/example_block.py',
        boardExamplePath: '/config/python/example_board.py',
        snippet: '',
        operationCount: 1
      })
    })
    const text = resultOf<InitializeResult>(withClient).instructions
    expect(text).toContain('/config/python/goatcad.py')
    expect(text).toContain('/config/python/example_board.py')
    const without = await handleMcpMessage(initialize, ctx())
    expect(resultOf<InitializeResult>(without).instructions).not.toContain('The client is at')
  })

  it('answers a notification with nothing at all', async () => {
    // A JSON-RPC message with no id takes no response; sending one is a
    // protocol error rather than a courtesy.
    expect(
      await handleMcpMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, ctx())
    ).toBeNull()
  })

  it('lists every tool with a schema', async () => {
    const response = await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, ctx())
    const tools = resultOf<ToolsListResult>(response).tools
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [
        'app_scripting',
        'schematic_bind',
        'board_undo',
        'board_redo',
        'schematic_undo',
        'schematic_redo',
        'symbol_undo',
        'symbol_redo',
        'footprint_undo',
        'footprint_redo',
        'board_apply_interface_preset',
        'board_batch',
        'board_cleanup',
        'board_describe',
        'board_explain_limits',
        'board_fanout',
        'board_get_setup',
        'board_place_footprint',
        'board_refill',
        'board_set_teardrops',
        'board_sync',
        'board_update_footprints',
        'board_update_setup',
        'board_update_tuning_patterns',
        'viewport_open',
        'viewport_close',
        'route_begin',
        'route_step',
        'route_preview',
        'route_finish',
        'bom_get',
        'bom_update',
        'parts_browse_categories',
        'parts_cache_datasheet',
        'footprint_cache_model',
        'footprint_copy',
        'symbol_create',
        'symbol_copy',
        'symbol_delete',
        'export_bom',
        'export_drill',
        'export_gerbers',
        'export_package',
        'export_positions',
        'export_profiles',
        'footprint_create',
        'footprint_delete',
        'footprint_batch',
        'symbol_batch',
        'footprint_compute_land_pattern',
        'project_context',
        'schematic_describe',
        'items_create',
        'items_delete',
        'items_get',
        'items_query',
        'items_transform',
        'items_update',
        'parts_list_filters',
        'symbol_list_libraries',
        'symbol_list_library',
        'symbol_get',
        'footprint_list_libraries',
        'footprint_list_library',
        'footprint_search',
        'footprint_get',
        'render_footprint',
        'schematic_check',
        'board_check',
        'footprint_check',
        'symbol_check',
        'parts_open_settings',
        'parts_status',
        'project_save',
        'project_open',
        'project_close',
        'project_create',
        'project_create_file',
        'workspace_list',
        'workspace_start',
        'workspace_attach',
        'workspace_update',
        'workspace_close',
        'workspace_open_window',
        'workspace_close_window',
        'workspace_open_file',
        'workspace_close_file',
        'workspace_save',
        'workspace_create_file',
        'parts_read_datasheet',
        'schematic_batch',
        'schematic_cleanup',
        'schematic_connect',
        'schematic_wire',
        'schematic_place_symbol',
        'schematic_add_sheet',
        'schematic_annotate',
        'schematic_set_paper',
        'schematic_get_setup',
        'schematic_update_setup',
        'schematic_update_symbols',
        'parts_search_category',
        'parts_search',
        'parts_compare_mpn',
        'symbol_search',
        'render_schematic',
        'render_board',
        'render_board_3d',
        'render_gerbers',
        'render_model',
        'render_symbol'
      ].sort()
    )
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe('object')
      expect(tool.description.length).toBeGreaterThan(40)
    }
  })

  it('names an unknown method and an unknown tool differently', async () => {
    const method = await handleMcpMessage(
      { jsonrpc: '2.0', id: 1, method: 'resources/list' },
      ctx()
    )
    expect(method!.error?.code).toBe(RPC_METHOD_NOT_FOUND)

    const tool = await handleMcpMessage(
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'no_such_tool' } },
      ctx()
    )
    expect(tool!.error?.code).toBe(RPC_INVALID_PARAMS)
  })

  it('offers the nearest real tool name when one is misspelled', async () => {
    // The reader is usually a model that mistyped a name it already knows, so
    // the correction rides along in `data` (`agent-api.md`) —
    // and it is a wire name, which is the only kind this caller can use.
    const response = await handleMcpMessage(
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'schematic_place_symbl' } },
      ctx()
    )
    const data = response!.error?.data as { code: string; candidates: string[] }
    expect(data.code).toBe('unknown-op')
    expect(data.candidates).toContain('schematic_place_symbol')
  })

  it('reports a thrown tool as a tool result, not as a transport error', async () => {
    // The model can act on an errored tool result; a JSON-RPC error just looks
    // like a broken server to it.
    const { payload, isError } = await callTool<SearchPayload>(
      'parts_search',
      { distributor: 'digikey', query: 'x' },
      {
        search: async () => {
          throw new Error('boom')
        }
      }
    )
    expect(isError).toBe(true)
    // Our bug, reported as one: the caller is a tool result an agent has to act
    // on, and `internal` is the code that says "do not retry this".
    expect(errorOf(payload).code).toBe('internal')
    expect(errorOf(payload).kind).toBe('handler-threw')
  })

  it('serves exactly one prompt, with rendered text', async () => {
    const list = await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'prompts/list' }, ctx())
    // `init` is the only prompt on purpose: a prompt's method reaches the
    // model only when the user invokes it, so the part-selection and
    // symbol-drawing methods that used to be prompts now live in the project
    // file `init` writes and in the guidance of the tools that need them.
    expect(resultOf<PromptsListResult>(list).prompts.map((entry) => entry.name)).toEqual(['init'])

    const got = await handleMcpMessage(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'prompts/get',
        params: { name: 'init', arguments: { about: '25 boards, hand-soldered, indoor' } }
      },
      ctx()
    )
    const rendered = resultOf<PromptGetResult>(got).messages[0].content.text
    expect(rendered).toContain('25 boards, hand-soldered, indoor')
  })
})

describe('recovering a truncated request', () => {
  it('reassembles a request the client spread across several keys', () => {
    // A slash command's free text arrived once as its first word alone, the
    // rest dropped by the client's argument mapping. Whatever a client calls
    // the pieces, they get joined back in order.
    expect(joinArguments({ need: 'low cost,', arg1: 'low power', arg2: 'sensor' })).toBe(
      'low cost, low power sensor'
    )
  })

  it('is a no-op on one clean string', () => {
    expect(joinArguments({ need: 'a 3.3V LDO' })).toBe('a 3.3V LDO')
  })

  it('ignores non-strings and blanks rather than rendering "undefined"', () => {
    expect(joinArguments({ need: '  ', quantity: 25, other: null })).toBe('')
  })
})

describe('the init prompt', () => {
  it('tells the agent to read the project before asking anything', async () => {
    const got = await handleMcpMessage(
      { jsonrpc: '2.0', id: 1, method: 'prompts/get', params: { name: 'init' } },
      ctx()
    )
    const rendered = resultOf<PromptGetResult>(got).messages[0].content.text
    expect(rendered).toContain('Do not ask for anything you can read')
    expect(rendered).toContain('project_context')
  })

  it('holds the line at two questions, and names which', async () => {
    const got = await handleMcpMessage(
      { jsonrpc: '2.0', id: 1, method: 'prompts/get', params: { name: 'init' } },
      ctx()
    )
    const rendered = resultOf<PromptGetResult>(got).messages[0].content.text
    expect(rendered).toContain('ask two questions — not a questionnaire')
    expect(rendered).toContain('How will it be assembled')
    expect(rendered).toContain('Roughly how many')
    // The three that must never be asked, because they are derived.
    expect(rendered).toContain('Never ask for layer count, board size or design rules')
  })

  it('requires the user to type nothing but plain English', async () => {
    const got = await handleMcpMessage(
      { jsonrpc: '2.0', id: 1, method: 'prompts/get', params: { name: 'init' } },
      ctx()
    )
    const rendered = resultOf<PromptGetResult>(got).messages[0].content.text
    expect(rendered).toContain('plain English and nothing else')
    expect(rendered).toContain('never be shown a schema')
    // GoatCAD does not write into a user's project; the agent does.
    expect(rendered).toContain('GoatCAD does not write it')
  })

  it('writes the schematic conventions with defaults and asks nothing about them', async () => {
    const got = await handleMcpMessage(
      { jsonrpc: '2.0', id: 1, method: 'prompts/get', params: { name: 'init' } },
      ctx()
    )
    const rendered = resultOf<PromptGetResult>(got).messages[0].content.text
    // The house style is written, not interviewed: the two-question rule holds.
    expect(rendered).toContain('fill them in, do not ask about them')
    expect(rendered).toContain('**Ask nothing.**')
    // The choices a professional sheet makes, and the loop that checks them.
    expect(rendered).toContain('Value carries the value alone')
    expect(rendered).toContain('R101 on sheet 1')
    expect(rendered).toContain('## Working on the schematic')
    // The review loop is the tools' own; the project file points at it.
    expect(rendered).toContain('as `render_schematic` describes')
    // Parts: the method, so a build does not open with a recalled part number.
    expect(rendered).toContain('## Choosing parts')
    expect(rendered).toContain('Family before ordering code')
    expect(rendered).toContain('A full MPN confirms; it does not discover')
    // What suggest_parts carried before it was retired, and must not be lost.
    expect(rendered).toContain('A part number comes from a search result, never from memory')
    expect(rendered).toContain('A shortlist, not a winner')
    // An existing design already answers the style question.
    expect(rendered).toContain('say you took them from the sheet')
  })
})

describe('project_context', () => {
  it('reports no project rather than empty constraints when none is open', async () => {
    const { payload } = await callTool<{ exists: boolean; guidance: string; fileName: string }>(
      'project_context',
      {}
    )
    expect(payload.exists).toBe(false)
    expect(payload.fileName).toBe('board-intent.md')
    expect(payload.guidance).toContain('No project is open')
  })
})

describe('parts_status', () => {
  it('reports capabilities per provider so the agent stops guessing', async () => {
    const { payload } = await callTool<StatusPayload>('parts_status', {})
    expect(payload.providers[0].capabilities).toEqual(PROVIDER_CAPABILITIES.digikey)
    expect(payload.providers[1].capabilities.categoryBrowse).toBe(false)
    expect(payload.canBrowseCategories).toBe(true)
  })

  it('never reports a key, only a hint', async () => {
    const { payload } = await callTool<StatusPayload>('parts_status', {})
    const serialized = JSON.stringify(payload)
    expect(serialized).not.toContain('clientSecret')
    expect(payload.providers[0].keyHint).toBe('abc123')
  })

  it('tells an agent to stop when nothing is connected', async () => {
    const { payload } = await callTool<StatusPayload>(
      'parts_status',
      {},
      {
        credentialStatus: () => [
          status({ configured: false }),
          status({ provider: 'mouser', configured: false })
        ]
      }
    )
    expect(payload.connectedCount).toBe(0)
    expect(payload.guidance).toContain('Settings')
  })

  it('says so when only one distributor is connected', async () => {
    const { payload } = await callTool<StatusPayload>('parts_status', {})
    expect(payload.guidance).toContain('one catalog')
  })
})

describe('parts_search', () => {
  it('refuses with a typed kind and a remedy when that distributor has no key', async () => {
    const search = vi.fn(async () => ({ ok: true as const, value: emptySearch() }))
    const { payload, isError } = await callTool<SearchPayload>(
      'parts_search',
      { distributor: 'mouser', query: 'stm32' },
      { search }
    )
    expect(isError).toBe(true)
    expect(errorOf(payload).kind).toBe('no-credentials')
    expect(errorOf(payload).fix).toContain('Settings')
    expect(errorOf(payload).data?.provider).toBe('mouser')
    // And it must not have spent a call finding that out.
    expect(search).not.toHaveBeenCalled()
  })

  it('takes exactly one distributor', async () => {
    const search = vi.fn(async () => ({ ok: true as const, value: emptySearch() }))
    const missing = await callTool<SearchPayload>('parts_search', { query: 'stm32' }, { search })
    expect(missing.isError).toBe(true)
    expect(errorOf(missing.payload).code).toBe('invalid-args')
    const unknown = await callTool<SearchPayload>(
      'parts_search',
      { distributor: 'all', query: 'stm32' },
      { search }
    )
    expect(errorOf(unknown.payload).code).toBe('invalid-args')
    expect(search).not.toHaveBeenCalled()
  })

  it('rejects an empty query without calling the distributor', async () => {
    const search = vi.fn(async () => ({ ok: true as const, value: emptySearch() }))
    const { isError } = await callTool<SearchPayload>(
      'parts_search',
      { distributor: 'digikey', query: '   ' },
      { search }
    )
    expect(isError).toBe(true)
    expect(search).not.toHaveBeenCalled()
  })

  it("passes limit, offset and the switches to that distributor's search alone", async () => {
    const search = vi.fn(async () => ({ ok: true as const, value: emptySearch() }))
    await callTool<SearchPayload>(
      'parts_search',
      { distributor: 'digikey', query: '10k 0402', limit: 5, offset: 10, inStock: true },
      { search }
    )
    expect(search).toHaveBeenCalledTimes(1)
    const [provider, keyword, limit, offset, categoryId, filters] = search.mock
      .calls[0] as unknown as [string, string, number, number, number | undefined, PartsFilterState]
    expect([provider, keyword, limit, offset, categoryId]).toEqual([
      'digikey',
      '10k 0402',
      5,
      10,
      undefined
    ])
    expect(filters.inStock).toBe(true)
    expect(filters.rohs).toBe(false)
  })

  it('answers every offer a row lists, in order, with minimum, stock and price breaks', async () => {
    const { payload } = await callTool<SearchPayload>(
      'parts_search',
      { distributor: 'digikey', query: 'stm32', qty: 100 },
      {
        search: async () => ({
          ok: true,
          value: { ...emptySearch(), total: 1, parts: [part()] }
        })
      }
    )
    expect(payload.distributor).toBe('DigiKey')
    expect(payload.total).toBe(1)
    expect(payload.count).toBe(1)
    const row = payload.parts[0]
    expect(row.manufacturer).toBe('STMicroelectronics')
    expect(row.productUrl).toBe('https://example.invalid/dk')
    expect(row.offers.map((offer) => offer.packaging)).toEqual([
      'Cut Tape (CT)',
      'Tape & Reel (TR)'
    ])
    expect(row.offers[1]).toEqual({
      distributorPartNumber: '497-TR-ND',
      packaging: 'Tape & Reel (TR)',
      moq: 1000,
      stock: 6000,
      currency: 'USD',
      // Below the reel's first break the price is that break's: a reel is bought whole.
      priceAtQty: { quantity: 1000, unitPrice: 7.1 },
      priceBreaks: [{ quantity: 1000, unitPrice: 7.1 }]
    })
    // Price at the quantity actually being built, not at one.
    expect(row.offers[0].priceAtQty).toEqual({ quantity: 100, unitPrice: 8.75 })
  })

  it('answers only the columns named, mpn always, and every offer by default', async () => {
    const search = async (): ReturnType<PartsService['search']> => ({
      ok: true,
      value: { ...emptySearch(), total: 1, parts: [part()] }
    })
    const narrow = await callTool<{ parts: Record<string, unknown>[] }>(
      'parts_search',
      { distributor: 'digikey', query: 'stm32', columns: ['lifecycle', 'offers.stock'] },
      { search }
    )
    expect(narrow.payload.parts[0]).toEqual({
      mpn: 'STM32F405RGT6',
      lifecycle: 'active',
      offers: [{ stock: 4000 }, { stock: 6000 }]
    })
    const whole = await callTool<{ parts: Record<string, unknown>[] }>(
      'parts_search',
      { distributor: 'digikey', query: 'stm32', columns: ['offers'] },
      { search }
    )
    expect(Object.keys(whole.payload.parts[0])).toEqual(['mpn', 'offers'])
    expect(Object.keys((whole.payload.parts[0].offers as object[])[0])).toHaveLength(7)
    const full = await callTool<{ parts: Record<string, unknown>[] }>(
      'parts_search',
      { distributor: 'digikey', query: 'stm32' },
      { search }
    )
    expect(Object.keys(full.payload.parts[0])).toEqual([
      'mpn',
      'manufacturer',
      'description',
      'lifecycle',
      'rohs',
      'datasheetUrl',
      'productUrl',
      'parameters',
      'offers'
    ])
    const unknown = await callTool<unknown>(
      'parts_search',
      { distributor: 'digikey', query: 'stm32', columns: ['price'] },
      { search }
    )
    expect(errorOf(unknown.payload).code).toBe('invalid-args')
  })

  it('names the paging argument when the distributor has more rows', async () => {
    const { payload } = await callTool<SearchPayload>(
      'parts_search',
      { distributor: 'mouser', query: 'stm32' },
      {
        credentialStatus: () => [status({ configured: false }), status({ provider: 'mouser' })],
        search: async () => ({ ok: true, value: { ...emptySearch(), total: 40, parts: [part()] } })
      }
    )
    expect(payload.distributor).toBe('Mouser')
    expect(payload.guidance).toContain('offset')
  })

  it('reports a failing distributor as the failure, with its remedy', async () => {
    const { payload, isError } = await callTool<SearchPayload>(
      'parts_search',
      { distributor: 'digikey', query: 'stm32' },
      { search: async () => ({ ok: false, error: { kind: 'invalid-credentials' } }) }
    )
    expect(isError).toBe(true)
    expect(errorOf(payload).kind).toBe('invalid-credentials')
    expect(errorOf(payload).fix).toContain('Do not retry')
  })

  it('carries remaining quota on a success, not only on a failure', async () => {
    const { payload } = await callTool<SearchPayload>('parts_search', {
      distributor: 'digikey',
      query: 'stm32'
    })
    expect(payload.quota).toEqual([
      { provider: 'digikey', minuteRemaining: 117, dayRemaining: 960, resetsAt: 1_700_086_400_000 },
      { provider: 'mouser', minuteRemaining: 30, dayRemaining: 960, resetsAt: 1_700_086_400_000 }
    ])
  })
})

describe('parts_compare_mpn', () => {
  const both = (): PartsCredentialStatus[] => [status(), status({ provider: 'mouser' })]
  const catalog =
    (rows: Record<'digikey' | 'mouser', PartRecord[]>): PartsService['search'] =>
    async (provider) => ({
      ok: true,
      value: { ...emptySearch(), total: rows[provider].length, parts: rows[provider] }
    })

  it('answers one row per distributor whose MPN matches whole, ignoring case', async () => {
    const search = vi.fn(
      catalog({
        digikey: [part({ mpn: 'STM32F405RGT6TR' }), part()],
        mouser: [part({ provider: 'mouser', manufacturer: 'STMicroelectronics N.V.' })]
      })
    )
    const { payload } = await callTool<ComparePayload>(
      'parts_compare_mpn',
      { mpn: 'stm32f405rgt6', qty: 10 },
      { credentialStatus: both, search }
    )
    expect(payload.distributors.map((entry) => entry.distributor)).toEqual(['DigiKey', 'Mouser'])
    expect(payload.distributors.map((entry) => entry.part?.mpn)).toEqual([
      'STM32F405RGT6',
      'STM32F405RGT6'
    ])
    // Each distributor's maker name as it gives it: never mapped onto the other's.
    expect(payload.distributors[1].part?.manufacturer).toBe('STMicroelectronics N.V.')
    expect(payload.distributors[0].part?.offers).toHaveLength(2)
    expect(search).toHaveBeenCalledTimes(2)
  })

  it('answers no row and the makers when a distributor lists several, until manufacturer says which', async () => {
    const rows = {
      digikey: [
        part({ mpn: 'LM358', manufacturer: 'Texas Instruments' }),
        part({ mpn: 'LM358', manufacturer: 'onsemi' })
      ],
      mouser: [part({ provider: 'mouser', mpn: 'LM358', manufacturer: 'Texas Instruments Inc.' })]
    }
    const open = await callTool<ComparePayload>(
      'parts_compare_mpn',
      { mpn: 'LM358' },
      { credentialStatus: both, search: catalog(rows) }
    )
    expect(open.payload.distributors[0]).toMatchObject({
      part: null,
      matches: 2,
      manufacturers: ['Texas Instruments', 'onsemi']
    })
    expect(open.payload.distributors[1].part?.manufacturer).toBe('Texas Instruments Inc.')

    const named = await callTool<ComparePayload>(
      'parts_compare_mpn',
      { mpn: 'LM358', manufacturer: 'texas instruments' },
      { credentialStatus: both, search: catalog(rows) }
    )
    expect(named.payload.distributors[0].part?.manufacturer).toBe('Texas Instruments')
    // A different spelling is a different name: no suffix is stripped.
    expect(named.payload.distributors[1]).toMatchObject({
      part: null,
      matches: 0,
      manufacturers: ['Texas Instruments Inc.']
    })
  })

  it('narrows each part to the columns named', async () => {
    const { payload } = await callTool<ComparePayload>(
      'parts_compare_mpn',
      { mpn: 'STM32F405RGT6', columns: ['offers.priceAtQty'], qty: 10 },
      { search: catalog({ digikey: [part()], mouser: [] }) }
    )
    expect(payload.distributors[0].part).toEqual({
      mpn: 'STM32F405RGT6',
      offers: [
        { priceAtQty: { quantity: 10, unitPrice: 10.2 } },
        { priceAtQty: { quantity: 1000, unitPrice: 7.1 } }
      ]
    })
  })

  it('reports a distributor with no key or a failure in its own entry', async () => {
    const { payload } = await callTool<ComparePayload>(
      'parts_compare_mpn',
      { mpn: 'X1' },
      { search: async () => ({ ok: false, error: { kind: 'timeout' } }) }
    )
    expect(payload.distributors[0]).toMatchObject({ part: null, error: { kind: 'timeout' } })
    expect(payload.distributors[1]).toMatchObject({ part: null, error: { kind: 'no-credentials' } })
  })

  it('refuses when no distributor is connected, without a call', async () => {
    const search = vi.fn(catalog({ digikey: [], mouser: [] }))
    const { isError, payload } = await callTool<ComparePayload>(
      'parts_compare_mpn',
      { mpn: 'X1' },
      {
        credentialStatus: () => [
          status({ configured: false }),
          status({ provider: 'mouser', configured: false })
        ],
        search
      }
    )
    expect(isError).toBe(true)
    expect(errorOf(payload).kind).toBe('no-credentials')
    expect(search).not.toHaveBeenCalled()
  })
})

describe('parts_cache_datasheet', () => {
  const LINKS = [
    { provider: 'digikey' as const, url: 'https://mfr.example/x.pdf' },
    { provider: 'mouser' as const, url: 'https://mouser.example/x.pdf' }
  ]
  /** One row per distributor link, or one DigiKey row with no link. */
  const row = (
    manufacturer: string,
    datasheetUrls: { provider: 'digikey' | 'mouser'; url: string }[]
  ): PartRecord[] =>
    datasheetUrls.length
      ? datasheetUrls.map((link) =>
          part({ provider: link.provider, mpn: 'X1', manufacturer, datasheetUrl: link.url })
        )
      : [part({ mpn: 'X1', manufacturer, datasheetUrl: null })]
  const record = (over: Partial<DatasheetRecord> = {}): DatasheetRecord => ({
    mpn: 'X1',
    file: 'X1.pdf',
    source: 'distributor',
    fetchedAt: 1,
    bytes: 10,
    sha256: 'abc',
    ...over
  })
  const datasheetCtx = (
    datasheets: NonNullable<OpContext['datasheets']>,
    rows: PartRecord[] = row('ACME', LINKS)
  ): OpContext => ({
    parts: stubService({
      credentialStatus: () => [status(), status({ provider: 'mouser' })],
      search: async (provider) => ({
        ok: true,
        value: { ...emptySearch(), parts: rows.filter((r) => r.provider === provider) }
      })
    }),
    project: () => '/p',
    datasheets
  })
  const untouched: NonNullable<OpContext['datasheets']> = {
    cached: () => null,
    path: () => '',
    fetch: async () => {
      throw new Error('not expected')
    },
    adopt: () => {
      throw new Error('not expected')
    }
  }

  it('refuses a part number several makers list, naming them, until manufacturer says which', async () => {
    // A marketplace lists clones under the original's number, and the first
    // row is a clone with no datasheet — fetching "the" link would fetch nothing
    // or the wrong part's.
    const clones = [...row('Shenzhen Clone Co.', []), ...row('STMicroelectronics', LINKS)]
    const { isError, payload } = await callRich<unknown>(
      'parts_cache_datasheet',
      { mpn: 'X1' },
      datasheetCtx(untouched, clones)
    )
    expect(isError).toBe(true)
    expect(errorOf(payload).kind).toBe('ambiguous-mpn')
    expect(errorOf(payload).candidates).toEqual(['Shenzhen Clone Co.', 'STMicroelectronics'])

    const seen: unknown[] = []
    const narrowed = await callRich<unknown>(
      'parts_cache_datasheet',
      { mpn: 'X1', manufacturer: 'stmicroelectronics' },
      datasheetCtx(
        {
          ...untouched,
          fetch: async (_p, _m, candidates) => {
            seen.push(...candidates)
            return { ok: true, record: record(), path: '', attempts: [] }
          }
        },
        clones
      )
    )
    expect(narrowed.isError).toBe(false)
    expect(seen).toHaveLength(2)
  })

  it('treats two spellings of a maker as two makers', async () => {
    const spelled = [
      ...row('Texas Instruments', [LINKS[0]]),
      ...row('Texas Instruments Inc.', [LINKS[1]])
    ]
    const { payload } = await callRich<unknown>(
      'parts_cache_datasheet',
      { mpn: 'X1' },
      datasheetCtx(untouched, spelled)
    )
    expect(errorOf(payload).candidates).toEqual(['Texas Instruments', 'Texas Instruments Inc.'])
  })

  it("hands every distributor's link to the store, in order", async () => {
    const seen: unknown[] = []
    const { isError, payload } = await callRich<{
      attempts: unknown[]
      datasheet: { path: string; field: string }
    }>(
      'parts_cache_datasheet',
      { mpn: 'X1' },
      datasheetCtx({
        cached: () => null,
        path: (_p, r) => `/p/datasheets/${r.file}`,
        fetch: async (_p, _m, candidates) => {
          seen.push(...candidates)
          return {
            ok: true,
            record: record({ distributor: 'Mouser', url: LINKS[1].url }),
            path: '/p/datasheets/X1.pdf',
            attempts: [
              { distributor: 'DigiKey', url: LINKS[0].url, result: 'http-error', status: 403 },
              { distributor: 'Mouser', url: LINKS[1].url, result: 'saved' }
            ]
          }
        },
        adopt: () => {
          throw new Error('not expected')
        }
      })
    )
    expect(isError).toBe(false)
    expect(seen).toEqual([
      { distributor: 'DigiKey', url: LINKS[0].url },
      { distributor: 'Mouser', url: LINKS[1].url }
    ])
    // The answer says what was tried, so a reader knows which copy this is.
    expect(payload.attempts).toHaveLength(2)
    // The field value is the file as the sheet should name it, never the
    // machine's path: the ninth run wrote absolute paths from `path` by hand.
    expect(payload.datasheet.path).toBe('/p/datasheets/X1.pdf')
    expect(payload.datasheet.field).toBe('${KIPRJMOD}/datasheets/X1.pdf')
  })

  it('answers not-cached with what each link returned, and the link for the BOM', async () => {
    const { isError, payload } = await callRich<unknown>(
      'parts_cache_datasheet',
      { mpn: 'X1' },
      datasheetCtx({
        ...untouched,
        fetch: async () => ({
          ok: false,
          attempts: [
            {
              distributor: 'DigiKey',
              url: LINKS[0].url,
              result: 'not-pdf',
              status: 200,
              contentType: 'text/html'
            },
            { distributor: 'Mouser', url: LINKS[1].url, result: 'http-error', status: 403 }
          ]
        })
      })
    )
    expect(isError).toBe(true)
    const error = errorOf(payload)
    expect(error.kind).toBe('not-cached')
    expect(error.message).toBe(
      'No PDF from 2 links for X1: DigiKey → not-pdf (HTTP 200); Mouser → http-error (HTTP 403).'
    )
    expect(error.fix).toContain('path')
    expect(error.fix).toContain('Datasheet field')
    expect(error.data?.datasheetUrl).toBe(LINKS[0].url)
    expect((error.data?.attempts as unknown[]).length).toBe(2)
  })

  it('answers not-cached the same way when no link was published', async () => {
    const { isError, payload } = await callRich<unknown>(
      'parts_cache_datasheet',
      { mpn: 'X1' },
      datasheetCtx(untouched, row('ACME', []))
    )
    expect(isError).toBe(true)
    const error = errorOf(payload)
    expect(error.kind).toBe('not-cached')
    expect(error.data).toEqual({ datasheetUrl: null, attempts: [] })
  })

  it('names the part whose file a new one shares', async () => {
    const { isError, payload } = await callRich<{ sharedWith?: string }>(
      'parts_cache_datasheet',
      { mpn: 'X1' },
      datasheetCtx({
        ...untouched,
        fetch: async () => ({
          ok: true,
          record: record({ file: 'X0.pdf' }),
          path: '/p/datasheets/X0.pdf',
          attempts: [{ distributor: 'DigiKey', url: LINKS[0].url, result: 'reused' }],
          sharedWith: 'X0'
        })
      })
    )
    expect(isError).toBe(false)
    expect(payload.sharedWith).toBe('X0')
  })

  it("records a fetched file as the distributor's when its url is one the listing gave", async () => {
    const seen: unknown[] = []
    const { isError } = await callRich<unknown>(
      'parts_cache_datasheet',
      { mpn: 'X1', path: '/tmp/x.pdf', url: LINKS[1].url },
      datasheetCtx({
        cached: () => null,
        path: () => '/p/datasheets/X1.pdf',
        fetch: async () => {
          throw new Error('not expected')
        },
        adopt: (_p, _m, _s, provenance) => {
          seen.push(provenance)
          return {
            ok: true,
            record: record(provenance),
            path: '/p/datasheets/X1.pdf',
            attempts: []
          }
        }
      })
    )
    expect(isError).toBe(false)
    expect(seen).toEqual([{ source: 'distributor', distributor: 'Mouser', url: LINKS[1].url }])
  })

  it("records a fetched file as the user's when its url is not one the listing gave", async () => {
    const seen: unknown[] = []
    await callRich<unknown>(
      'parts_cache_datasheet',
      { mpn: 'X1', path: '/tmp/x.pdf', url: 'https://aggregator.example/x.pdf' },
      datasheetCtx({
        cached: () => null,
        path: () => '',
        fetch: async () => {
          throw new Error('not expected')
        },
        adopt: (_p, _m, _s, provenance) => {
          seen.push(provenance)
          return { ok: true, record: record(provenance), path: '', attempts: [] }
        }
      })
    )
    expect(seen).toEqual([{ source: 'user', url: 'https://aggregator.example/x.pdf' }])
  })

  it('refuses a url with no file to go with it', async () => {
    const { isError, payload } = await callRich<unknown>(
      'parts_cache_datasheet',
      { mpn: 'X1', url: LINKS[1].url },
      datasheetCtx({
        cached: () => null,
        path: () => '',
        fetch: async () => {
          throw new Error('not expected')
        },
        adopt: () => {
          throw new Error('not expected')
        }
      })
    )
    expect(isError).toBe(true)
    expect(errorOf(payload).fix).toContain('path')
  })
})

describe('parts_open_settings', () => {
  it('raises an effect rather than doing anything itself, and carries no secret', async () => {
    const effects: OpEffect[] = []
    const { payload } = await callTool<OpenSettingsPayload>(
      'parts_open_settings',
      { provider: 'digikey' },
      {},
      (effect) => effects.push(effect)
    )
    expect(effects).toEqual([{ kind: 'open-settings', provider: 'digikey' }])
    expect(payload.opened).toBe(true)
  })

  it('refuses a provider it does not know rather than silently opening nothing', async () => {
    // This used to be ignored and the pane opened unfocused. The schema now
    // refuses it (`agent-api.md`): an argument that is dropped
    // is a call that succeeds meaning something the caller did not ask for.
    const effects: OpEffect[] = []
    const { payload, isError } = await callTool<OpenSettingsPayload>(
      'parts_open_settings',
      { provider: 'octopart' },
      {},
      (effect) => effects.push(effect)
    )
    expect(isError).toBe(true)
    expect(errorOf(payload).code).toBe('invalid-args')
    expect(errorOf(payload).path).toBe('/provider')
    expect(errorOf(payload).message).toContain('digikey')
    expect(effects).toEqual([])
  })
})

describe('price at quantity', () => {
  const breaks = [
    { quantity: 1, unitPrice: 12.5 },
    { quantity: 10, unitPrice: 10.2 },
    { quantity: 100, unitPrice: 8.75 }
  ]

  it('takes the highest break at or below the quantity', () => {
    expect(priceAtQuantity(breaks, 50)).toEqual({ quantity: 10, unitPrice: 10.2 })
    expect(priceAtQuantity(breaks, 100)).toEqual({ quantity: 100, unitPrice: 8.75 })
  })

  it('falls back to the smallest break below the first one, since "no price" reads as "not for sale"', () => {
    expect(priceAtQuantity([{ quantity: 10, unitPrice: 3 }], 1)).toEqual({
      quantity: 10,
      unitPrice: 3
    })
  })

  it('is null only when there are no breaks at all', () => {
    expect(priceAtQuantity([], 5)).toBeNull()
  })

  it('does not assume breaks arrive ascending', () => {
    expect(priceAtQuantity([...breaks].reverse(), 50)).toEqual({ quantity: 10, unitPrice: 10.2 })
  })
})

describe('quota summary', () => {
  it('reports what is left, floored at zero', () => {
    expect(
      quotaSummary([
        usage({ minute: { used: 200, limit: 120 }, day: { used: 40, limit: 1000, resetsAt: 7 } })
      ])
    ).toEqual([{ provider: 'digikey', minuteRemaining: 0, dayRemaining: 960, resetsAt: 7 }])
  })
})

describe('tool descriptions', () => {
  it('tell the agent to call parts_status first', () => {
    const statusTool = registry.get('parts_status')!
    expect(statusTool.description).toContain('Call first')
  })

  it('warn against a quantity-1 price', () => {
    const search = registry.get('parts_search')!
    expect(search.description).toContain('price at build quantity')
  })
})

// ------------------------------------------------------------------ browse path

interface BrowsePayload {
  error?: string
  detail?: string
  parent: { id: number; name: string } | null
  categories: Array<{ id: number; name: string; productCount: number; hasChildren: boolean }>
  next: string
}
interface FiltersPayload {
  error?: string
  categoryId: number
  totalProducts: number
  parameters: Array<{
    parameterId: number
    name: string
    values: Array<{ valueId: string; label: string; productCount: number }>
  }>
  next: string
}
interface CategorySearchPayload {
  error?: string
  detail?: string
  total: number
  parts: Array<{ mpn: string; parameters: Array<{ name: string; value: string }> }>
  note: string | null
}

const TREE: PartCategory[] = [
  {
    id: 1,
    name: 'Integrated Circuits (ICs)',
    productCount: 900,
    children: [
      { id: 11, name: 'Embedded — Microcontrollers', productCount: 500, children: [] },
      { id: 12, name: 'PMIC — Voltage Regulators', productCount: 400, children: [] }
    ]
  },
  { id: 2, name: 'Capacitors', productCount: 100, children: [] }
]

const facetedSearch = (): PartSearchResult => ({
  parts: [],
  total: 240,
  facets: {
    manufacturers: [{ id: 'st', label: 'STMicroelectronics', productCount: 90 }],
    packaging: [],
    status: [],
    series: [],
    parametric: [
      {
        parameterId: 2049,
        name: 'Core Processor',
        values: [
          { id: 'ARM Cortex-M4', label: 'ARM Cortex-M4', productCount: 120 },
          { id: 'ARM Cortex-M7', label: 'ARM Cortex-M7', productCount: 40 }
        ]
      },
      {
        parameterId: 16,
        name: 'Number of I/O',
        values: [{ id: '51', label: '51', productCount: 12 }]
      }
    ]
  }
})

const browseService = (overrides: Partial<PartsService> = {}): Partial<PartsService> => ({
  credentialStatus: () => [status(), status({ provider: 'mouser', configured: false })],
  categories: async () => ({ ok: true, value: TREE }),
  search: async () => ({ ok: true, value: facetedSearch() }),
  ...overrides
})

describe('parts_browse_categories', () => {
  beforeEach(() => resetCategoryVocabulary())

  it('returns the top level, then descends', async () => {
    const top = await callTool<BrowsePayload>('parts_browse_categories', {}, browseService())
    expect(top.payload.categories.map((entry) => entry.id)).toEqual([1, 2])
    expect(top.payload.categories[0].hasChildren).toBe(true)

    const down = await callTool<BrowsePayload>(
      'parts_browse_categories',
      { parentId: 1 },
      browseService()
    )
    expect(down.payload.parent!.name).toBe('Integrated Circuits (ICs)')
    expect(down.payload.categories.map((entry) => entry.name)).toContain(
      'Embedded — Microcontrollers'
    )
  })

  it('refuses an id it did not hand out rather than answering emptily', async () => {
    // An empty list would read as "this category has nothing in it", which is a
    // different and wrong fact.
    const { payload, isError } = await callTool<BrowsePayload>(
      'parts_browse_categories',
      { parentId: 9999 },
      browseService()
    )
    expect(isError).toBe(true)
    expect(errorOf(payload).code).toBe('not-found')
    expect(errorOf(payload).kind).toBe('unknown-category')
    expect(errorOf(payload).fix).toContain('Take ids from this tool')
  })

  it('says browsing is DigiKey-only when no DigiKey key is installed', async () => {
    const { payload, isError } = await callTool<BrowsePayload>(
      'parts_browse_categories',
      {},
      browseService({ credentialStatus: () => [status({ configured: false })] })
    )
    expect(isError).toBe(true)
    expect(errorOf(payload).kind).toBe('no-credentials')
    // And it must point at what still works.
    expect(errorOf(payload).fix).toContain('parts_search')
  })

  it('tells a leaf category what to do next', async () => {
    const { payload } = await callTool<BrowsePayload>(
      'parts_browse_categories',
      { parentId: 2 },
      browseService()
    )
    expect(payload.next).toContain('parts_list_filters')
  })
})

describe('parts_list_filters', () => {
  beforeEach(() => resetCategoryVocabulary())

  it("returns the distributor's own parameters with ids and counts", async () => {
    const { payload } = await callTool<FiltersPayload>(
      'parts_list_filters',
      { categoryId: 11 },
      browseService()
    )
    expect(payload.parameters[0]).toEqual({
      parameterId: 2049,
      name: 'Core Processor',
      values: [
        { valueId: 'ARM Cortex-M4', label: 'ARM Cortex-M4', productCount: 120 },
        { valueId: 'ARM Cortex-M7', label: 'ARM Cortex-M7', productCount: 40 }
      ]
    })
    expect(payload.next).toContain('exactly as given')
  })

  it('scopes the request to the category rather than searching a keyword', async () => {
    const search = vi.fn(async () => ({ ok: true as const, value: facetedSearch() }))
    await callTool<FiltersPayload>(
      'parts_list_filters',
      { categoryId: 11 },
      browseService({ search })
    )
    expect(search).toHaveBeenCalledWith('digikey', '', 1, 0, 11)
  })
})

describe('parts_search_category enforces the handshake', () => {
  beforeEach(() => resetCategoryVocabulary())

  it('refuses a parameter filter before parts_list_filters has been called', async () => {
    // The whole reliability argument: the model cannot invent a vocabulary it
    // was made to read first.
    const search = vi.fn(async () => ({ ok: true as const, value: facetedSearch() }))
    const { payload, isError } = await callTool<CategorySearchPayload>(
      'parts_search_category',
      { categoryId: 11, filters: { parameters: { 2049: ['ARM Cortex-M4'] } } },
      browseService({ search })
    )
    expect(isError).toBe(true)
    expect(errorOf(payload).kind).toBe('invalid-filter')
    expect(errorOf(payload).message).toContain('parts_list_filters(11)')
    // And it cost no quota.
    expect(search).not.toHaveBeenCalled()
  })

  it('accepts the ids parts_list_filters handed out', async () => {
    await callTool<FiltersPayload>('parts_list_filters', { categoryId: 11 }, browseService())
    const { payload, isError } = await callTool<CategorySearchPayload>(
      'parts_search_category',
      { categoryId: 11, filters: { inStock: true, parameters: { 2049: ['ARM Cortex-M4'] } } },
      browseService()
    )
    expect(isError).toBe(false)
    expect(payload.total).toBe(240)
  })

  it('refuses a value the parameter does not have, and names the parameter', async () => {
    await callTool<FiltersPayload>('parts_list_filters', { categoryId: 11 }, browseService())
    const { payload, isError } = await callTool<CategorySearchPayload>(
      'parts_search_category',
      { categoryId: 11, filters: { parameters: { 2049: ['ARM Cortex-M0'] } } },
      browseService()
    )
    expect(isError).toBe(true)
    expect(errorOf(payload).message).toContain('Core Processor')
    expect(errorOf(payload).message).toContain('exactly as parts_list_filters returned')
  })

  it('refuses a parameter the category does not have', async () => {
    await callTool<FiltersPayload>('parts_list_filters', { categoryId: 11 }, browseService())
    const { payload, isError } = await callTool<CategorySearchPayload>(
      'parts_search_category',
      { categoryId: 11, filters: { parameters: { 9999: ['x'] } } },
      browseService()
    )
    expect(isError).toBe(true)
    expect(errorOf(payload).message).toContain('no parameter 9999')
  })

  it('passes the applied filters through to the distributor, not to the rows', async () => {
    await callTool<FiltersPayload>('parts_list_filters', { categoryId: 11 }, browseService())
    const search = vi.fn(async () => ({ ok: true as const, value: facetedSearch() }))
    await callTool<CategorySearchPayload>(
      'parts_search_category',
      {
        categoryId: 11,
        filters: { inStock: true, hasDatasheet: true, parameters: { 16: ['51'] } },
        limit: 5
      },
      browseService({ search })
    )
    const [, , limit, , categoryId, filters] = search.mock.calls[0] as unknown as [
      string,
      string,
      number,
      number,
      number,
      PartsFilterState
    ]
    expect(limit).toBe(5)
    expect(categoryId).toBe(11)
    expect(filters.inStock).toBe(true)
    expect(filters.hasDatasheet).toBe(true)
    expect(filters.parameters).toEqual({ 16: ['51'] })
  })

  it('rejects a sort field DigiKey does not accept, and names the ones it does', async () => {
    // "Parameter" is the obvious guess and it is wrong: a parametric column
    // cannot be sorted at all. The schema now catches it before the handler
    // runs, so the answer is the list of fields that do work.
    const { payload, isError } = await callTool<CategorySearchPayload>(
      'parts_search_category',
      { categoryId: 11, sort: { field: 'Parameter', order: 'asc' } },
      browseService()
    )
    expect(isError).toBe(true)
    expect(errorOf(payload).code).toBe('invalid-args')
    expect(errorOf(payload).path).toBe('/sort/field')
    expect(errorOf(payload).message).toContain('QuantityAvailable')
  })

  it('refuses a filter id of the wrong type rather than dropping it', async () => {
    // The failure this guards: a dropped filter returns a broader result set
    // that looks like a successful narrow, and nothing downstream can see it.
    const { payload, isError } = await callTool<CategorySearchPayload>(
      'parts_search_category',
      { categoryId: 11, filters: { manufacturerIds: ['st', 42] } },
      browseService()
    )
    expect(isError).toBe(true)
    expect(errorOf(payload).code).toBe('invalid-args')
    expect(errorOf(payload).path).toBe('/filters/manufacturerIds/1')
  })

  it('refuses an argument it does not declare rather than ignoring it', async () => {
    const { payload, isError } = await callTool<CategorySearchPayload>(
      'parts_search_category',
      { categoryId: 11, sortBy: 'price' },
      browseService()
    )
    expect(isError).toBe(true)
    expect(errorOf(payload).code).toBe('invalid-args')
    expect(errorOf(payload).message).toContain('unknown field')
  })

  it('points at narrowing rather than paging when the result set is large', async () => {
    const { payload } = await callTool<CategorySearchPayload>(
      'parts_search_category',
      { categoryId: 11 },
      browseService()
    )
    expect(payload.note).toContain('rather than paging')
  })

  it('reports a distributor failure with a typed kind and remedy', async () => {
    const { payload, isError } = await callTool<CategorySearchPayload>(
      'parts_search_category',
      { categoryId: 11 },
      browseService({
        search: async () => ({ ok: false, error: { kind: 'quota-exhausted' } })
      })
    )
    expect(isError).toBe(true)
    expect(errorOf(payload).kind).toBe('quota-exhausted')
    expect(errorOf(payload).fix).toContain('Stop searching')
  })
})

describe('buildFilters', () => {
  beforeEach(() => resetCategoryVocabulary())

  it('defaults to no narrowing at all', () => {
    const built = buildFilters(undefined, 11)
    expect(built.ok).toBe(true)
    if (built.ok) {
      expect(built.filters.inStock).toBe(false)
      expect(built.filters.parameters).toEqual({})
    }
  })

  // A non-string id used to be dropped here. It is now refused by the schema
  // before this function runs (`agent-api.md`), which is the
  // point: a silently dropped filter returns a broader result set that looks
  // like a successful narrow. The refusal is asserted with the other schema
  // rejections, on the operation itself.

  it('refuses an empty value list, which would filter by nothing', () => {
    const built = buildFilters({ parameters: { 2049: [] } }, 11)
    expect(built.ok).toBe(false)
  })
})

// --------------------------------------------------------- library + design

const libRecord = (id: string, extra: Record<string, unknown> = {}): IndexRecord =>
  ({
    type: 'symbol',
    id,
    name: id.split(':')[1],
    library: id.split(':')[0],
    scope: 'system',
    file: '/x.kicad_sym',
    isPower: false,
    value: '',
    description: '',
    keywords: '',
    datasheet: '',
    footprint: '',
    fpFilters: [],
    pins: 2,
    ...extra
  }) as IndexRecord

/** A context with the library and design capabilities wired to stubs. */
const richCtx = (options: {
  system?: IndexRecord[]
  project?: IndexRecord[]
  projectPath?: string | null
  design?: (request: McpDesignRequest) => Promise<DesignOutcome>
}): OpContext => ({
  parts: stubService(),
  project: () => options.projectPath ?? null,
  library: {
    system: async () => options.system ?? [],
    project: () => options.project ?? []
  },
  design: options.design
})

const callRich = async <T>(
  name: string,
  args: Record<string, unknown>,
  context: OpContext
): Promise<{ payload: T; isError: boolean }> => {
  const response = await handleMcpMessage(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    context
  )
  const result = resultOf<ToolCallResult>(response)
  return { payload: JSON.parse(result.content[0].text) as T, isError: result.isError }
}

describe('symbol library tools', () => {
  it("prefers the project's own definition of a lib_id over the standard one", async () => {
    // The design carrying a definition IS the definition for that id; offering
    // the standard one would place a part that renders unlike every other
    // instance of it already on the sheet.
    const { payload } = await callRich<{ symbols: Array<{ libId: string; description: string }> }>(
      'symbol_list_library',
      { library: 'Device' },
      richCtx({
        system: [libRecord('Device:R', { description: 'standard' })],
        project: [libRecord('Device:R', { description: 'house variant', scope: 'project' })],
        projectPath: '/p'
      })
    )
    expect(payload.symbols).toEqual([{ libId: 'Device:R', description: 'house variant', pins: 2 }])
  })

  it('ignores project records when no project is open', async () => {
    const { payload } = await callRich<{ totalSymbols: number }>(
      'symbol_list_libraries',
      {},
      richCtx({
        system: [libRecord('Device:R')],
        project: [libRecord('MyParts:X', { scope: 'project' })],
        projectPath: null
      })
    )
    expect(payload.totalSymbols).toBe(1)
  })

  it('reports an unknown library as an error result, not a quiet empty page', async () => {
    const { payload, isError } = await callRich<unknown>(
      'symbol_list_library',
      { library: 'Nope' },
      richCtx({ system: [libRecord('Device:R')] })
    )
    expect(isError).toBe(true)
    expect(errorOf(payload).code).toBe('not-found')
    expect(errorOf(payload).kind).toBe('unknown-library')
  })

  it('says so rather than guessing when the index is unavailable', async () => {
    // A lib_id an agent invents fails at placement; one it invents that happens
    // to exist fails silently, which is worse.
    const { payload, isError } = await callRich<unknown>(
      'symbol_search',
      { query: 'r' },
      {
        parts: stubService()
      }
    )
    expect(isError).toBe(true)
    expect(errorOf(payload).kind).toBe('library-index-unavailable')
  })
})

describe('footprint library tools', () => {
  const fpRecord = (id: string, extra: Record<string, unknown> = {}): IndexRecord =>
    ({
      type: 'footprint',
      id,
      name: id.split(':')[1],
      library: id.split(':')[0],
      scope: 'system',
      file: '/x.pretty/x.kicad_mod',
      description: '',
      tags: '',
      pads: 2,
      padNumbers: 2,
      models: [],
      ...extra
    }) as IndexRecord

  it('lists and searches footprints from the same index the symbol tools read', async () => {
    const context = richCtx({
      system: [fpRecord('Resistor_SMD:R_0402_1005Metric'), libRecord('Device:R')]
    })
    const { payload } = await callRich<{ totalFootprints: number }>(
      'footprint_list_libraries',
      {},
      context
    )
    expect(payload.totalFootprints).toBe(1)
    const found = await callRich<{ footprints: Array<{ libId: string }> }>(
      'footprint_search',
      { query: '0402' },
      context
    )
    expect(found.payload.footprints.map((row) => row.libId)).toEqual([
      'Resistor_SMD:R_0402_1005Metric'
    ])
  })

  it('forwards symbol_get columns to the window', async () => {
    const seen: McpDesignRequest[] = []
    await callRich<unknown>(
      'symbol_get',
      { symbol: 'Device:R', columns: ['pins', 'box'] },
      richCtx({
        design: async (request) => {
          seen.push(request)
          return { ok: true, payload: {} }
        }
      })
    )
    expect(seen).toEqual([{ kind: 'get-symbol', symbol: 'Device:R', columns: ['pins', 'box'] }])
  })

  it('refuses a place whose Footprint field names a footprint no library has', async () => {
    const seen: McpDesignRequest[] = []
    const { payload, isError } = await callRich<unknown>(
      'schematic_place_symbol',
      {
        symbol: 'Device:R',
        at: { x: 76.2, y: 54.61 },
        properties: { Footprint: 'Resistor_SMD:R_0402' },
        viewport: 'viewport-1',
        action: 'Act'
      },
      richCtx({
        system: [fpRecord('Resistor_SMD:R_0402_1005Metric')],
        design: async (request) => {
          seen.push(request)
          return { ok: true, payload: {} }
        }
      })
    )
    expect(isError).toBe(true)
    expect(errorOf(payload).kind).toBe('unknown-footprint')
    expect(errorOf(payload).candidates).toEqual(['Resistor_SMD:R_0402_1005Metric'])
    // Nothing crossed to the window.
    expect(seen).toHaveLength(0)
  })

  it('refuses the named footprint argument the same way, on place and on bind', async () => {
    const seen: McpDesignRequest[] = []
    const ctx = richCtx({
      system: [fpRecord('Resistor_SMD:R_0402_1005Metric')],
      design: async (request) => {
        seen.push(request)
        return { ok: true, payload: {} }
      }
    })
    const placed = await callRich<unknown>(
      'schematic_place_symbol',
      {
        symbol: 'Device:R',
        at: { x: 76.2, y: 54.61 },
        footprint: 'Resistor_SMD:R_0402',
        viewport: 'viewport-1',
        action: 'Act'
      },
      ctx
    )
    expect(placed.isError).toBe(true)
    expect(errorOf(placed.payload).kind).toBe('unknown-footprint')
    const bound = await callRich<unknown>(
      'schematic_bind',
      { reference: 'R1', footprint: 'Resistor_SMD:R_0402' },
      ctx
    )
    expect(bound.isError).toBe(true)
    expect(errorOf(bound.payload).kind).toBe('unknown-footprint')
    expect(seen).toHaveLength(0)
  })

  it('writes the named footprint as the Footprint field, winning over the loose key', async () => {
    const seen: McpDesignRequest[] = []
    await callRich<unknown>(
      'schematic_bind',
      {
        reference: 'C4',
        footprint: 'Capacitor_SMD:C_0402_1005Metric',
        properties: { Footprint: 'Capacitor_SMD:C_0603_1608Metric' }
      },
      richCtx({
        system: [
          fpRecord('Capacitor_SMD:C_0402_1005Metric'),
          fpRecord('Capacitor_SMD:C_0603_1608Metric')
        ],
        design: async (request) => {
          seen.push(request)
          return { ok: true, payload: {} }
        }
      })
    )
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      kind: 'bind-part',
      reference: 'C4',
      properties: { Footprint: 'Capacitor_SMD:C_0402_1005Metric' }
    })
  })

  it('lets a real footprint through, and an unverifiable one when there is no index', async () => {
    const seen: McpDesignRequest[] = []
    const design = async (request: McpDesignRequest): Promise<DesignOutcome> => {
      seen.push(request)
      return { ok: true, payload: {} }
    }
    await callRich<unknown>(
      'schematic_bind',
      { reference: 'R1', properties: { Footprint: 'Resistor_SMD:R_0402_1005Metric' } },
      richCtx({ system: [fpRecord('Resistor_SMD:R_0402_1005Metric')], design })
    )
    await callRich<unknown>(
      'schematic_bind',
      { reference: 'R1', properties: { Footprint: 'Whatever:Unchecked' } },
      { parts: stubService(), design }
    )
    expect(seen).toHaveLength(2)
  })
})

describe('design tools', () => {
  it('passes a place through to the bridge with the §4.3 field names', async () => {
    const seen: McpDesignRequest[] = []
    const { payload, isError } = await callRich<{ placed: { reference: string } }>(
      'schematic_place_symbol',
      {
        symbol: 'Device:R',
        at: { x: 101.6, y: 72.39 },
        value: '10k',
        mpn: 'RC0402FR-0710KL',
        manufacturer: 'Yageo',
        properties: { LCSC: 'C25804' },
        viewport: 'viewport-1',
        action: 'Act'
      },
      richCtx({
        design: async (request) => {
          seen.push(request)
          return { ok: true, payload: { placed: { reference: 'R1' } } }
        }
      })
    )
    expect(isError).toBe(false)
    expect(payload.placed.reference).toBe('R1')
    // Named arguments become the KiCad keys the fab BOM already resolves; the
    // model never spells a field name itself.
    expect(seen[0]).toMatchObject({
      kind: 'place-symbol',
      libId: 'Device:R',
      value: '10k',
      properties: { MPN: 'RC0402FR-0710KL', Manufacturer: 'Yageo', LCSC: 'C25804' }
    })
    // Placing by pin is forwarded as given, and absent when not asked for.
    expect(seen[0]).not.toHaveProperty('pin')
  })

  it('lets a named argument win over the same key passed loose', async () => {
    const seen: McpDesignRequest[] = []
    await callRich(
      'schematic_bind',
      { reference: 'U1', mpn: 'REAL', properties: { MPN: 'STALE' } },
      richCtx({
        design: async (request) => {
          seen.push(request)
          return { ok: true, payload: {} }
        }
      })
    )
    expect((seen[0] as { properties: Record<string, string> }).properties.MPN).toBe('REAL')
  })

  it('refuses a bind that would write nothing', async () => {
    const { payload, isError } = await callRich<unknown>(
      'schematic_bind',
      { reference: 'U1' },
      richCtx({ design: async () => ({ ok: true, payload: {} }) })
    )
    expect(isError).toBe(true)
    expect(errorOf(payload).kind).toBe('nothing-to-write')
  })

  it('attaches a remedy to every failure kind the window can report', async () => {
    for (const error of ['no-window', 'sheet-not-found', 'unknown-symbol', 'reference-taken']) {
      const { payload, isError } = await callRich<unknown>(
        'schematic_describe',
        {},
        richCtx({ design: async () => ({ ok: false, error }) })
      )
      expect(isError).toBe(true)
      expect(errorOf(payload).kind).toBe(error)
      expect(DESIGN_REMEDY[error]).toBeDefined()
      expect(errorOf(payload).fix).toBe(DESIGN_REMEDY[error])
    }
  })

  // A pin table the layout refuses is the caller's to fix, never an internal
  // failure whose remedy says to stop and report it.
  it('answers every symbol-layout refusal as fixable input, with its remedy', async () => {
    for (const error of [
      'no-pins',
      'blank-pin-number',
      'duplicate-pin-number',
      'unknown-group',
      'everything-omitted',
      'no-power-pins',
      'stack-target-missing',
      'stack-self',
      'stack-cycle',
      'rail-name-too-long'
    ]) {
      const { payload } = await callRich<unknown>(
        'schematic_describe',
        {},
        richCtx({ design: async () => ({ ok: false, error, detail: 'x' }) })
      )
      expect(errorOf(payload).code).not.toBe('internal')
      expect(DESIGN_REMEDY[error]).toBeDefined()
      expect(errorOf(payload).fix).toBe(DESIGN_REMEDY[error])
    }
    expect(DESIGN_REMEDY['rail-name-too-long']).toContain('side')
  })

  it('falls back to a usable remedy for a failure kind it has never seen', async () => {
    const { payload } = await callRich<unknown>(
      'schematic_describe',
      {},
      richCtx({ design: async () => ({ ok: false, error: 'something-new' }) })
    )
    expect(errorOf(payload).fix).toBe(DESIGN_REMEDY['renderer-failed'])
  })

  it('reports no bridge at all rather than appearing to succeed', async () => {
    const { payload, isError } = await callRich<unknown>(
      'schematic_describe',
      {},
      {
        parts: stubService()
      }
    )
    expect(isError).toBe(true)
    expect(errorOf(payload).kind).toBe('no-bridge')
  })
})

describe('schematic_connect', () => {
  const seen: McpDesignRequest[] = []
  const echo = (): OpContext =>
    richCtx({
      design: async (request) => {
        seen.push(request)
        return { ok: true, payload: { connected: { net: 'VDD_3V3', labelled: ['U1.VDD'] } } }
      }
    })

  beforeEach(() => {
    seen.length = 0
  })

  it('passes the net and the pins through as one request', async () => {
    const { isError } = await callRich<unknown>(
      'schematic_connect',
      { net: 'VDD_3V3', pins: ['U1.VDD', 'C3.1'], viewport: 'viewport-1', action: 'Act' },
      echo()
    )
    expect(isError).toBe(false)
    expect(seen).toEqual([
      {
        kind: 'connect-pins',
        net: 'VDD_3V3',
        pins: ['U1.VDD', 'C3.1'],
        viewport: 'viewport-1',
        action: 'Act'
      }
    ])
  })

  it('sends merge only when it was asked for, so the window cannot assume it', async () => {
    await callRich<unknown>(
      'schematic_connect',
      { net: 'VDD_3V3', pins: ['U1.VDD'], merge: true, viewport: 'viewport-1', action: 'Act' },
      echo()
    )
    expect(seen[0]).toHaveProperty('merge', true)
  })

  it('refuses an empty pin list at the schema, without troubling the window', async () => {
    const { payload, isError } = await callRich<unknown>(
      'schematic_connect',
      { net: 'VDD_3V3', pins: [], viewport: 'viewport-1', action: 'Act' },
      echo()
    )
    expect(isError).toBe(true)
    expect(errorOf(payload).code).toBe('invalid-args')
    expect(seen).toEqual([])
  })

  it('refuses a blank net rather than creating one nobody can name', async () => {
    const { payload, isError } = await callRich<unknown>(
      'schematic_connect',
      { net: '   ', pins: ['U1.VDD'], viewport: 'viewport-1', action: 'Act' },
      echo()
    )
    expect(isError).toBe(true)
    expect(errorOf(payload).code).toBe('refused')
    expect(seen).toEqual([])
  })

  it('hands back the real pin ids when one does not resolve', async () => {
    // The candidates are the whole value of the failure: without them the agent
    // guesses again, and a pin name that matches two pads is exactly the case
    // where guessing connects the wrong pad silently.
    const { payload, isError } = await callRich<unknown>(
      'schematic_connect',
      { net: 'GND', pins: ['U1.GND'], viewport: 'viewport-1', action: 'Act' },
      richCtx({
        design: async () => ({
          ok: false,
          error: 'pin-not-found',
          detail: 'U1 has 2 pins named GND.',
          candidates: ['U1.2', 'U1.3']
        })
      })
    )
    expect(isError).toBe(true)
    expect(errorOf(payload).code).toBe('not-found')
    expect(errorOf(payload).candidates).toEqual(['U1.2', 'U1.3'])
  })

  it('reports a merge as a conflict, naming both nets', async () => {
    const { payload, isError } = await callRich<unknown>(
      'schematic_connect',
      { net: 'VDD_3V3', pins: ['U1.VDD'], viewport: 'viewport-1', action: 'Act' },
      richCtx({
        design: async () => ({
          ok: false,
          error: 'would-merge',
          detail: 'would merge it with VCC',
          candidates: ['VCC']
        })
      })
    )
    expect(isError).toBe(true)
    expect(errorOf(payload).code).toBe('conflict')
    expect(errorOf(payload).fix).toContain('merge: true')
  })
})

describe('the check verbs', () => {
  const requestOf = async (
    name: string,
    args: Record<string, unknown>
  ): Promise<McpDesignRequest | null> => {
    let sent: McpDesignRequest | null = null
    await callRich<unknown>(
      name,
      args,
      richCtx({
        design: async (request) => {
          sent = request
          return { ok: true, payload: { results: [] } }
        }
      })
    )
    return sent
  }

  it('each checks its own document, narrowed by codes', async () => {
    expect(await requestOf('schematic_check', { codes: ['unconnected-pin'] })).toEqual({
      kind: 'check-schematic',
      codes: ['unconnected-pin']
    })
    expect(await requestOf('board_check', { board: 'a.kicad_pcb', since: 3 })).toEqual({
      kind: 'check-board',
      board: 'a.kicad_pcb',
      since: 3
    })
    expect(await requestOf('footprint_check', { footprint: 'U1', board: 'a.kicad_pcb' })).toEqual({
      kind: 'check-footprint',
      footprint: 'U1',
      board: 'a.kicad_pcb'
    })
    expect(await requestOf('symbol_check', { symbol: 'U1', sheet: 'a.kicad_sch' })).toEqual({
      kind: 'check-symbol',
      symbol: 'U1',
      sheet: 'a.kicad_sch'
    })
  })

  it('a library id with a placement, or a reference without its board, is refused', async () => {
    expect(await requestOf('footprint_check', { footprint: 'Lib:X', board: 'a.kicad_pcb' })).toBe(
      null
    )
    expect(await requestOf('footprint_check', { footprint: 'U1' })).toBe(null)
    expect(await requestOf('symbol_check', { symbol: 'Lib:X', sheet: 'a.kicad_sch' })).toBe(null)
  })

  it('are read-only, so a batch never counts them as edits', () => {
    for (const name of ['schematic.check', 'board.check', 'footprint.check', 'symbol.check']) {
      expect(registry.get(name)!.mutates).toBe(false)
    }
  })
})

describe('schematic_batch', () => {
  const sent: McpDesignRequest[] = []
  const echo = (): OpContext =>
    richCtx({
      design: async (request) => {
        sent.push(request)
        return { ok: true, payload: { completed: 2 } }
      }
    })

  beforeEach(() => {
    sent.length = 0
  })

  it('plans every operation before running any of them, and sends one request', async () => {
    const { isError } = await callRich<unknown>(
      'schematic_batch',
      {
        ops: [
          {
            op: 'schematic.place_symbol',
            args: { symbol: 'Device:C', value: '100nF', at: { x: 101.6, y: 72.39 } }
          },
          { op: 'schematic.connect', args: { net: 'VDD', pins: ['C1.1'] } }
        ],
        viewport: 'viewport-1',
        action: 'Act'
      },
      echo()
    )
    expect(isError).toBe(false)
    expect(sent).toHaveLength(1)
    const batch = sent[0] as {
      kind: string
      viewport: string
      ops: Array<{ kind: string; viewport?: string }>
    }
    expect(batch.kind).toBe('batch')
    expect(batch.viewport).toBe('viewport-1')
    expect((batch as { action?: string }).action).toBe('Act')
    expect(batch.ops.map((entry) => entry.kind)).toEqual(['place-symbol', 'connect-pins'])
  })

  it('needs a viewport when an entry sets layout, and takes it on the batch only', async () => {
    const place = {
      op: 'schematic.place_symbol',
      args: { symbol: 'Device:C', at: { x: 101.6, y: 72.39 } }
    }
    const missing = await callRich<unknown>('schematic_batch', { ops: [place] }, echo())
    expect(missing.isError).toBe(true)
    expect(errorOf(missing.payload)).toMatchObject({ code: 'invalid-args', path: '/viewport' })
    expect(errorOf(missing.payload).fix).toContain('viewport_open')
    const own = await callRich<unknown>(
      'schematic_batch',
      {
        ops: [{ ...place, args: { ...place.args, viewport: 'viewport-1', action: 'Act' } }],
        viewport: 'viewport-1',
        action: 'Act'
      },
      echo()
    )
    expect(errorOf(own.payload).code).toBe('refused')
    // The batch's action labels the box; one on an entry is refused, and none is invalid-args.
    const unlabeled = await callRich<unknown>(
      'schematic_batch',
      { ops: [place], viewport: 'viewport-1' },
      echo()
    )
    expect(errorOf(unlabeled.payload)).toMatchObject({ code: 'invalid-args', path: '/action' })
    expect(errorOf(unlabeled.payload).fix).toContain('action on the batch')
    const ownAction = await callRich<unknown>(
      'schematic_batch',
      { ops: [{ ...place, args: { ...place.args, action: 'Act' } }], viewport: 'viewport-1' },
      echo()
    )
    expect(errorOf(ownAction.payload).code).toBe('refused')
    // A field's value sets no layout, so it needs no viewport.
    const value = await callRich<unknown>(
      'schematic_batch',
      { ops: [{ op: 'items.update', args: { id: 'R1', record: { value: '10k' } } }] },
      echo()
    )
    expect(value.isError).toBe(false)
    expect(sent).toHaveLength(1)
  })

  it('forwards dryRun, and only when it was asked for', async () => {
    await callRich<unknown>(
      'schematic_batch',
      { dryRun: true, ops: [{ op: 'schematic.describe' }] },
      echo()
    )
    expect(sent[0]).toHaveProperty('dryRun', true)
    sent.length = 0
    await callRich<unknown>('schematic_batch', { ops: [{ op: 'schematic.describe' }] }, echo())
    expect(sent[0]).not.toHaveProperty('dryRun')
  })

  it('refuses a batch inside a batch, because the name is not there to find', async () => {
    const { payload, isError } = await callRich<unknown>(
      'schematic_batch',
      { ops: [{ op: 'schematic.batch', args: { ops: [] } }] },
      echo()
    )
    expect(isError).toBe(true)
    expect(errorOf(payload).code).toBe('not-found')
    expect(sent).toEqual([])
  })

  it('refuses a library write, which could not be rolled back with the sheet', async () => {
    const { payload, isError } = await callRich<unknown>(
      'schematic_batch',
      {
        ops: [{ op: 'symbol.delete', args: { symbol: 'board:Doomed' } }]
      },
      echo()
    )
    expect(isError).toBe(true)
    expect(errorOf(payload).code).toBe('refused')
    expect(errorOf(payload).message).toContain('sheet batch')
    expect(sent).toEqual([])
  })

  it('points a bad argument at the entry that carries it', async () => {
    // Counting entries by hand is exactly what an agent gets wrong, so the
    // pointer does it.
    const { payload, isError } = await callRich<unknown>(
      'schematic_batch',
      {
        ops: [
          { op: 'schematic.describe' },
          {
            op: 'schematic.place_symbol',
            args: { symbol: 'Device:C', at: { x: 101.6, y: 72.39 }, unit: 'two' }
          }
        ]
      },
      echo()
    )
    expect(isError).toBe(true)
    expect(errorOf(payload).code).toBe('invalid-args')
    expect(errorOf(payload).path).toBe('/ops/1/args/unit')
    expect(sent).toEqual([])
  })

  it('refuses an unknown operation with the nearest real name', async () => {
    const { payload } = await callRich<unknown>(
      'schematic_batch',
      { ops: [{ op: 'schematic.place_symbl' }] },
      echo()
    )
    expect(errorOf(payload).candidates).toContain('schematic.place_symbol')
  })

  it('rejects an empty batch at the schema', async () => {
    const { payload, isError } = await callRich<unknown>('schematic_batch', { ops: [] }, echo())
    expect(isError).toBe(true)
    expect(errorOf(payload).code).toBe('invalid-args')
  })
})

describe('app_scripting', () => {
  it('hands back a path and a snippet, not a package to go and fetch', async () => {
    const { payload, isError } = await callRich<{
      language: string
      pythonPath: string
      snippet: string
      operationCount: number
    }>(
      'app_scripting',
      {},
      {
        ...richCtx({}),
        scripting: () => ({
          pythonPath: '/config/python',
          modulePath: '/config/python/goatcad.py',
          examplePath: '/config/python/example_block.py',
          boardExamplePath: '/config/python/example_board.py',
          snippet: 'import sys\nsys.path.insert(0, "/config/python")\nfrom goatcad import connect',
          operationCount: 22
        })
      }
    )
    expect(isError).toBe(false)
    expect(payload.language).toBe('python')
    expect(payload.snippet).toContain('sys.path.insert')
    expect(payload.operationCount).toBe(22)
  })

  it('says so plainly when this build writes no client', async () => {
    const { payload, isError } = await callRich<unknown>('app_scripting', {}, richCtx({}))
    expect(isError).toBe(true)
    expect(errorOf(payload).kind).toBe('scripting-unavailable')
    expect(errorOf(payload).fix).toContain('/v1/ops/')
  })
})

describe('render_schematic', () => {
  it('asks the window for a picture and answers with image content beside the text', async () => {
    const seen: McpDesignRequest[] = []
    const response = await handleMcpMessage(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'render_schematic',
          arguments: { symbols: ['U1', 'C8'], viewport: 'viewport-1', action: 'Act' }
        }
      },
      richCtx({
        design: async (request) => {
          seen.push(request)
          return {
            ok: true,
            payload: {
              frame: { x: 10, y: 20, width: 100, height: 50 },
              image: { mimeType: 'image/png', base64: 'AAAA' }
            }
          }
        }
      })
    )
    expect(seen[0]).toEqual({
      kind: 'render-sheet',
      symbols: ['U1', 'C8'],
      maxPixels: 1600,
      viewport: 'viewport-1',
      action: 'Act'
    })
    const result = resultOf<ToolCallResult>(response)
    expect(result.isError).toBe(false)
    expect(result.content).toEqual([
      {
        type: 'text',
        text: JSON.stringify({ frame: { x: 10, y: 20, width: 100, height: 50 } }, null, 2)
      },
      { type: 'image', data: 'AAAA', mimeType: 'image/png' }
    ])
  })

  it('leaves a payload without an image as plain text', () => {
    expect(toolContent({ a: 1 })).toEqual([
      { type: 'text', text: JSON.stringify({ a: 1 }, null, 2) }
    ])
    expect(toolContent({ image: 'not-an-image' })).toHaveLength(1)
  })

  it('refuses a pixel cap outside the range the renderer will honour', async () => {
    const { isError, payload } = await callTool<unknown>('render_schematic', { maxPixels: 64 })
    expect(isError).toBe(true)
    expect(errorOf(payload).code).toBe('invalid-args')
    expect(errorOf(payload).path).toBe('/maxPixels')
  })
})

describe('project_save', () => {
  it('asks the window to write the named tabs, or every dirty one', async () => {
    const seen: McpDesignRequest[] = []
    const design = async (request: McpDesignRequest): Promise<DesignOutcome> => {
      seen.push(request)
      return { ok: true, payload: { written: [], alreadySaved: [], stillUnsaved: [] } }
    }
    await callRich('project_save', {}, richCtx({ design }))
    await callRich('project_save', { files: ['a.kicad_sch'] }, richCtx({ design }))
    expect(seen).toEqual([{ kind: 'save-files' }, { kind: 'save-files', files: ['a.kicad_sch'] }])
  })

  it('reports a file that is not open as not-found with the open tabs as candidates', async () => {
    const { isError, payload } = await callRich<unknown>(
      'project_save',
      { files: ['nope.kicad_sch'] },
      richCtx({
        design: async () => ({
          ok: false,
          error: 'file-not-open',
          detail: 'No open tab is called nope.kicad_sch.',
          candidates: ['/p/a.kicad_sch']
        })
      })
    )
    expect(isError).toBe(true)
    expect(errorOf(payload).code).toBe('not-found')
    expect(errorOf(payload).candidates).toEqual(['/p/a.kicad_sch'])
  })
})

describe('project_open and project_close', () => {
  it('pass the file through, and discard only when asked', async () => {
    const seen: McpDesignRequest[] = []
    const design = async (request: McpDesignRequest): Promise<DesignOutcome> => {
      seen.push(request)
      return { ok: true, payload: {} }
    }
    await callRich('project_open', { file: 'a.kicad_pcb' }, richCtx({ design }))
    await callRich('project_close', { file: 'a.kicad_pcb' }, richCtx({ design }))
    await callRich('project_close', { file: 'a.kicad_pcb', discard: true }, richCtx({ design }))
    expect(seen).toEqual([
      { kind: 'open-file', file: 'a.kicad_pcb' },
      { kind: 'close-file', file: 'a.kicad_pcb' },
      { kind: 'close-file', file: 'a.kicad_pcb', discard: true }
    ])
  })

  it('reports unsaved edits as a conflict that names the way out', async () => {
    const { isError, payload } = await callRich<unknown>(
      'project_close',
      { file: 'a.kicad_sch' },
      richCtx({ design: async () => ({ ok: false, error: 'unsaved-edits', detail: 'dirty' }) })
    )
    expect(isError).toBe(true)
    expect(errorOf(payload).code).toBe('conflict')
    expect(errorOf(payload).fix).toContain('discard')
  })
})

describe('footprint_create', () => {
  const pads = [
    {
      number: '1',
      type: 'smd',
      shape: 'roundrect',
      at: { x: -1, y: 0 },
      size: { width: 1, height: 1 }
    },
    {
      number: '2',
      type: 'smd',
      shape: 'roundrect',
      at: { x: 1, y: 0 },
      size: { width: 1, height: 1 }
    }
  ]

  it('sends the pads with the style the intent file states', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'goatcad-fp-'))
    try {
      writeFileSync(
        join(dir, 'board-intent.md'),
        '---\nassembly:\n  method: hand-solder\nfootprints:\n  pin1_marker: dot\n---\n'
      )
      const seen: McpDesignRequest[] = []
      const { isError } = await callRich<unknown>(
        'footprint_create',
        {
          name: 'TWO_PAD',
          attributes: 'smd',
          pads,
          body: { rect: { x: -1.5, y: -0.5, width: 3, height: 1 } },
          pin1: '1',
          symbol: 'Device:R'
        },
        richCtx({
          projectPath: dir,
          design: async (request) => {
            seen.push(request)
            return { ok: true, payload: {} }
          }
        })
      )
      expect(isError).toBe(false)
      expect(seen[0]).toMatchObject({
        kind: 'create-footprint',
        name: 'TWO_PAD',
        body: { rect: { x: -1.5, y: -0.5, width: 3, height: 1 } },
        symbol: 'Device:R',
        style: { density: 'most', pin1Marker: 'dot', source: 'board-intent' },
        maxPads: 200
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses a body that is both or neither shape, before the window', async () => {
    const seen: McpDesignRequest[] = []
    const context = richCtx({
      design: async (request) => {
        seen.push(request)
        return { ok: true, payload: {} }
      }
    })
    const triangle = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 0, y: 1 }
    ]
    for (const body of [{}, { rect: { x: 0, y: 0, width: 1, height: 1 }, polygon: triangle }]) {
      const { payload, isError } = await callRich<unknown>(
        'footprint_create',
        { name: 'X', attributes: 'smd', pads, body, pin1: '1' },
        context
      )
      expect(isError).toBe(true)
      expect(errorOf(payload)).toMatchObject({ code: 'refused', kind: 'bad-body' })
    }
    expect(seen).toHaveLength(0)
  })

  it('maps a generation refusal to its code and remedy', async () => {
    const { payload, isError } = await callRich<unknown>(
      'footprint_create',
      { name: 'X', attributes: 'smd', pads, body: { rect: { x: 0, y: 0, width: 1, height: 1 } } },
      richCtx({
        design: async () => ({
          ok: false,
          error: 'pads-overlap',
          detail: 'Copper of pads 1 and 2 would touch.'
        })
      })
    )
    expect(isError).toBe(true)
    expect(errorOf(payload)).toMatchObject({
      code: 'refused',
      kind: 'pads-overlap',
      message: 'Copper of pads 1 and 2 would touch.'
    })
    expect(errorOf(payload).fix).toContain('short by construction')
  })
})

describe('item operations on a footprint', () => {
  const capture = (): { seen: McpDesignRequest[]; context: OpContext } => {
    const seen: McpDesignRequest[] = []
    return {
      seen,
      context: richCtx({
        design: async (request) => {
          seen.push(request)
          return { ok: true, payload: {} }
        }
      })
    }
  }

  it('routes footprint reads, writes and checks to the footprint door', async () => {
    const { seen, context } = capture()
    const footprint = 'board:J3'
    await callRich('items_get', { footprint, ids: ['pad:1'] }, context)
    await callRich('items_query', { footprint, kind: 'line', layer: 'F.SilkS' }, context)
    await callRich('items_update', { footprint, id: 'pad:1', record: { shape: 'rect' } }, context)
    await callRich('items_delete', { footprint, ids: ['line@0,0'] }, context)
    await callRich(
      'items_create',
      {
        footprint,
        kind: 'circle',
        record: { layer: 'F.Fab', center: { x: 0, y: 0 }, end: { x: 1, y: 0 } }
      },
      context
    )
    await callRich('footprint_check', { footprint }, context)
    await callRich('symbol_check', { symbol: 'Device:R' }, context)
    expect(seen).toEqual([
      { kind: 'get-footprint-items', footprint, ids: ['pad:1'] },
      { kind: 'query-footprint-items', footprint, itemKind: 'line', layer: 'F.SilkS' },
      { kind: 'update-footprint-item', footprint, id: 'pad:1', record: { shape: 'rect' } },
      { kind: 'delete-footprint-items', footprint, ids: ['line@0,0'] },
      {
        kind: 'create-footprint-item',
        footprint,
        itemKind: 'circle',
        record: { layer: 'F.Fab', center: { x: 0, y: 0 }, end: { x: 1, y: 0 } }
      },
      { kind: 'check-footprint', footprint },
      { kind: 'check-symbol', symbol: 'Device:R' }
    ])
  })

  it("routes a placed footprint's reference with its board to the board's copy", async () => {
    const { seen, context } = capture()
    const placed = { footprint: 'U1', board: 'a.kicad_pcb' }
    await callRich('items_get', { ...placed, ids: ['pad:1'] }, context)
    await callRich('items_update', { ...placed, id: 'pad:1', record: { shape: 'rect' } }, context)
    await callRich('footprint_get', placed, context)
    await callRich('render_footprint', placed, context)
    expect(seen).toEqual([
      { kind: 'get-footprint-items', ...placed, ids: ['pad:1'] },
      { kind: 'update-footprint-item', ...placed, id: 'pad:1', record: { shape: 'rect' } },
      { kind: 'get-footprint', ...placed, maxPads: 200 },
      { kind: 'render-footprint', ...placed, maxPixels: 1600 }
    ])
  })

  it('routes symbol items to the symbol door: a library id, or a placed reference on its sheet', async () => {
    const { seen, context } = capture()
    await callRich('items_get', { symbol: 'proj:ES8388', ids: ['pin:7'] }, context)
    await callRich(
      'items_query',
      { symbol: 'U1', sheet: 'a.kicad_sch', kind: 'pin', unit: 2 },
      context
    )
    await callRich(
      'items_update',
      { symbol: 'proj:ES8388', id: 'pin:7', record: { type: 'power_in' } },
      context
    )
    await callRich('items_delete', { symbol: 'U1', ids: ['rect:1.1.0'] }, context)
    await callRich(
      'items_create',
      { symbol: 'proj:ES8388', kind: 'field', record: { key: 'MPN', value: 'ES8388' } },
      context
    )
    await callRich(
      'symbol_batch',
      {
        symbol: 'U1',
        ops: [{ op: 'items.update', args: { id: 'pin:1', record: { name: 'EN' } } }]
      },
      context
    )
    expect(seen).toEqual([
      { kind: 'get-symbol-items', symbol: 'proj:ES8388', ids: ['pin:7'] },
      { kind: 'query-symbol-items', symbol: 'U1', sheet: 'a.kicad_sch', itemKind: 'pin', unit: 2 },
      {
        kind: 'update-symbol-item',
        symbol: 'proj:ES8388',
        id: 'pin:7',
        record: { type: 'power_in' }
      },
      { kind: 'delete-symbol-items', symbol: 'U1', ids: ['rect:1.1.0'] },
      {
        kind: 'create-symbol-item',
        symbol: 'proj:ES8388',
        itemKind: 'field',
        record: { key: 'MPN', value: 'ES8388' }
      },
      {
        kind: 'batch-symbol',
        symbol: 'U1',
        ops: [{ kind: 'update-symbol-item', symbol: 'U1', id: 'pin:1', record: { name: 'EN' } }]
      }
    ])
  })

  it('refuses a symbol with a board or a footprint, a library id with sheet, and sheet keys on a symbol', async () => {
    const { seen, context } = capture()
    const refusals = [
      ['items_get', { symbol: 'a:b', board: 'x.kicad_pcb', ids: ['pin:1'] }],
      ['items_get', { symbol: 'a:b', sheet: 'x.kicad_sch', ids: ['pin:1'] }],
      ['items_update', { symbol: 'a:b', id: 'pin:1', wires: 'leave', record: { type: 'input' } }],
      ['items_create', { symbol: 'a:b', kind: 'label', record: {} }],
      ['items_query', { symbol: 'a:b', net: 'GND' }],
      ['items_query', { unit: 1 }]
    ] as const
    for (const [name, args] of refusals) {
      const { payload, isError } = await callRich<unknown>(name, { ...args }, context)
      expect(isError, name).toBe(true)
      expect(errorOf(payload).code, name).toBe('refused')
    }
    expect(seen).toHaveLength(0)
  })

  it('refuses mixing a sheet with a footprint, and sheet keys on a footprint', async () => {
    const { seen, context } = capture()
    const refusals = [
      ['items_get', { footprint: 'a:b', sheet: 'x.kicad_sch', ids: ['R1'] }],
      [
        'items_update',
        { footprint: 'a:b', id: 'pad:1', wires: 'leave', record: { shape: 'rect' } }
      ],
      ['items_update', { footprint: 'a:b', id: 'pad:1' }],
      ['items_create', { footprint: 'a:b', kind: 'label', record: {} }],
      [
        'items_create',
        { kind: 'pad', record: { at: { x: 0, y: 0 } }, viewport: 'viewport-1', action: 'Act' }
      ],
      ['items_query', { footprint: 'a:b', net: 'GND' }],
      ['items_query', { kind: 'pad' }],
      ['items_get', { footprint: 'U1', ids: ['pad:1'] }],
      ['items_get', { footprint: 'a:b', board: 'x.kicad_pcb', ids: ['pad:1'] }],
      ['footprint_get', { footprint: 'U1' }]
    ] as const
    for (const [name, args] of refusals) {
      const { payload, isError } = await callRich<unknown>(name, { ...args }, context)
      expect(isError, name).toBe(true)
      expect(errorOf(payload).code, name).toBe('refused')
    }
    expect(seen).toHaveLength(0)
  })

  it('writes a sheet item from its record, refusing a key no sheet item takes', async () => {
    const { seen, context } = capture()
    const moved = await callRich<unknown>(
      'items_update',
      {
        id: 'R1',
        wires: 'leave',
        record: { at: { x: 10.16, y: 20.32 }, angle: 90, fields: { MPN: 'X' } },
        viewport: 'viewport-1',
        action: 'Act'
      },
      context
    )
    expect(moved.isError).toBe(false)
    expect(seen).toEqual([
      {
        kind: 'update-item',
        id: 'R1',
        at: { x: 10.16, y: 20.32 },
        angle: 90,
        fields: { MPN: 'X' },
        wires: 'leave',
        viewport: 'viewport-1',
        action: 'Act'
      }
    ])
    // A record that sets layout needs a viewport; one that does not, none.
    const unframed = await callRich<unknown>(
      'items_update',
      { id: 'R1', record: { at: { x: 10.16, y: 20.32 } } },
      context
    )
    expect(errorOf(unframed.payload)).toMatchObject({ code: 'invalid-args', path: '/viewport' })
    expect(errorOf(unframed.payload).fix).toContain('viewport_open')
    expect(
      (await callRich<unknown>('items_update', { id: 'R1', record: { value: '10k' } }, context))
        .isError
    ).toBe(false)
    seen.length = 1
    for (const record of [{ size: 20 }, { angle: 45 }, { at: { x: 1 } }, {}]) {
      const { payload, isError } = await callRich<unknown>(
        'items_update',
        { id: 'R1', record },
        context
      )
      expect(isError, JSON.stringify(record)).toBe(true)
      expect(['invalid-args', 'refused']).toContain(errorOf(payload).code)
    }
    const unknown = await callRich<unknown>(
      'items_update',
      { id: 'R1', record: { size: 20 } },
      context
    )
    expect(errorOf(unknown.payload)).toMatchObject({ kind: 'invalid-record', path: '/record/size' })
    expect(errorOf(unknown.payload).message).toContain('record.size must be')
    expect(errorOf(unknown.payload).message).toContain('{width, height} in millimeters (sheet)')
    expect(seen).toHaveLength(1)
  })

  it('creates a sheet item from its record, refusing a key that kind does not take', async () => {
    const { seen, context } = capture()
    const made = await callRich<unknown>(
      'items_create',
      {
        kind: 'label',
        record: { text: 'GND', labelKind: 'global', pin: 'C8.2' },
        viewport: 'viewport-1',
        action: 'Act'
      },
      context
    )
    expect(made.isError).toBe(false)
    expect(seen).toEqual([
      {
        kind: 'create-item',
        itemKind: 'label',
        text: 'GND',
        labelKind: 'global',
        pin: 'C8.2',
        viewport: 'viewport-1',
        action: 'Act'
      }
    ])
    for (const [kind, record] of [
      ['junction', { at: { x: 0, y: 0 }, size: 2 }],
      ['text', { text: 'x', at: { x: 0, y: 0 }, angle: 45 }],
      ['label', { text: 'GND' }],
      ['rect', { at: { x: 0, y: 0 } }]
    ] as const) {
      const { payload, isError } = await callRich<unknown>(
        'items_create',
        { kind, record, viewport: 'viewport-1', action: 'Act' },
        context
      )
      expect(isError, kind).toBe(true)
      expect(['invalid-args', 'refused']).toContain(errorOf(payload).code)
    }
    const wrong = await callRich<unknown>(
      'items_create',
      {
        kind: 'junction',
        record: { at: { x: 0, y: 0 }, size: 2 },
        viewport: 'viewport-1',
        action: 'Act'
      },
      context
    )
    expect(errorOf(wrong.payload)).toMatchObject({ code: 'refused', kind: 'not-applicable' })
    expect(errorOf(wrong.payload).message).toBe('A junction does not take size; it takes at.')
    expect(seen).toHaveLength(1)
  })

  it('batches footprint item operations under one footprint', async () => {
    const { seen, context } = capture()
    const { isError } = await callRich(
      'footprint_batch',
      {
        footprint: 'board:J3',
        dryRun: true,
        ops: [
          { op: 'items.update', args: { id: 'pad:1', record: { shape: 'rect' } } },
          { op: 'items_query', args: { kind: 'pad' } }
        ]
      },
      context
    )
    expect(isError).toBe(false)
    expect(seen).toEqual([
      {
        kind: 'batch-footprint',
        footprint: 'board:J3',
        dryRun: true,
        ops: [
          {
            kind: 'update-footprint-item',
            footprint: 'board:J3',
            id: 'pad:1',
            record: { shape: 'rect' }
          },
          { kind: 'query-footprint-items', footprint: 'board:J3', itemKind: 'pad' }
        ]
      }
    ])
  })

  it('refuses a footprint batch entry that names another document or is not an item op', async () => {
    const { seen, context } = capture()
    for (const ops of [
      [{ op: 'items.get', args: { ids: ['x'], footprint: 'other:F' } }],
      [{ op: 'items.get', args: { ids: ['x'], sheet: 'a.kicad_sch' } }],
      [{ op: 'schematic.place_symbol', args: { symbol: 'Device:R', at: { x: 0, y: 0 } } }],
      [{ op: 'parts.status' }]
    ]) {
      const { payload, isError } = await callRich<unknown>(
        'footprint_batch',
        { footprint: 'board:J3', ops },
        context
      )
      expect(isError).toBe(true)
      expect(['refused', 'not-found']).toContain(errorOf(payload).code)
    }
    expect(seen).toHaveLength(0)
  })

  it('asks for the full footprint record only when detail is full', async () => {
    const { seen, context } = capture()
    await callRich('footprint_get', { footprint: 'a:b' }, context)
    await callRich('footprint_get', { footprint: 'a:b', detail: 'full' }, context)
    expect(seen).toEqual([
      { kind: 'get-footprint', footprint: 'a:b', maxPads: 200 },
      { kind: 'get-footprint', footprint: 'a:b', maxPads: 200, detail: 'full' }
    ])
  })
})

describe('footprint_compute_land_pattern', () => {
  const soic = {
    leadType: 'gullwing',
    body: { x: { nominal: 3.9, tolerance: 0.1 }, y: { min: 4.8, max: 5 } },
    span: { x: { nominal: 6, tolerance: 0.2 } },
    lead: { width: { min: 0.31, max: 0.51 }, length: { min: 0.4, max: 1.27 } },
    pitch: 1.27,
    pins: { y: 4 }
  }

  it("takes the project's density unless one is passed", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'goatcad-lp-'))
    try {
      writeFileSync(join(dir, 'board-intent.md'), '---\nassembly:\n  method: hand-solder\n---\n')
      const seen: McpDesignRequest[] = []
      const context = richCtx({
        projectPath: dir,
        design: async (request) => {
          seen.push(request)
          return { ok: true, payload: {} }
        }
      })
      await callRich('footprint_compute_land_pattern', soic, context)
      await callRich('footprint_compute_land_pattern', { ...soic, density: 'least' }, context)
      expect(seen[0]).toMatchObject({
        kind: 'land-pattern',
        density: 'most',
        densitySource: 'default',
        body: { x: { nominal: 3.9, tolerance: 0.1 }, y: { min: 4.8, max: 5 } },
        lead: { width: { min: 0.31, max: 0.51 }, length: { min: 0.4, max: 1.27 } }
      })
      expect(seen[1]).toMatchObject({ density: 'least', densitySource: 'argument' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses a dimension given both ways, or neither', async () => {
    const seen: McpDesignRequest[] = []
    const context = richCtx({
      design: async (request) => {
        seen.push(request)
        return { ok: true, payload: {} }
      }
    })
    for (const body of [
      { x: { nominal: 3.9, min: 3.8, max: 4 }, y: { nominal: 4.9 } },
      { x: { tolerance: 0.1 }, y: { nominal: 4.9 } }
    ]) {
      const { payload, isError } = await callRich<unknown>(
        'footprint_compute_land_pattern',
        { ...soic, body },
        context
      )
      expect(isError).toBe(true)
      expect(errorOf(payload)).toMatchObject({ code: 'invalid-args', kind: 'bad-dimension' })
    }
    expect(seen).toHaveLength(0)
  })
})

describe('large answers', () => {
  const deleted = Array.from({ length: 443 }, (_, i) => `track-${i}`)
  const context = (): OpContext =>
    richCtx({
      design: async () => ({
        ok: true,
        payload: { changed: { created: [], updated: [], deleted }, revision: 7 }
      })
    })
  const args = {
    board: 'a.kicad_pcb',
    kind: 'track',
    net: 'GND',
    expect: 443,
    viewport: 'v',
    action: 'Act'
  }

  it('caps changed on an MCP answer, with its counts', async () => {
    const { payload } = await callRich<{
      changed: { deleted: string[]; counts: Record<string, number>; truncated: boolean }
    }>('items_delete', args, context())
    expect(payload.changed.deleted).toHaveLength(100)
    expect(payload.changed.counts.deleted).toBe(443)
    expect(payload.changed.truncated).toBe(true)
  })

  it('answers every id over /v1, where the Python client reads', async () => {
    const answer = await handleV1('POST', '/v1/ops/items.delete', args, context())
    const body = answer!.body as { value: { changed: { deleted: string[] } } }
    expect(body.value.changed.deleted).toHaveLength(443)
  })
})
