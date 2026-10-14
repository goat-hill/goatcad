import { describe, expect, it } from 'vitest'
import { registry } from '../index'
import { RECORDS } from '../../../shared/itemRecords'

const requestFor = (name: string, args: Record<string, unknown>): unknown =>
  registry.get(name)!.designRequest!(args)

describe('sheet graphics and buses', () => {
  const framed = { viewport: 'viewport-1', action: 'Act' }

  it('creates a styled graphic from its record', () => {
    expect(
      requestFor('items.create', {
        kind: 'circle',
        record: { center: { x: 50.8, y: 50.8 }, radius: 5, strokeType: 'dash', fill: 'color' },
        ...framed
      })
    ).toMatchObject({
      ok: true,
      request: {
        kind: 'create-item',
        itemKind: 'circle',
        center: { x: 50.8, y: 50.8 },
        radius: 5,
        strokeType: 'dash',
        fill: 'color'
      }
    })
  })

  it('refuses a graphic missing its geometry, or a key its kind lacks', () => {
    for (const [kind, record] of [
      [
        'bezier',
        {
          points: [
            { x: 0, y: 0 },
            { x: 1, y: 1 }
          ]
        }
      ],
      [
        'rule_area',
        {
          points: [
            { x: 0, y: 0 },
            { x: 1, y: 1 }
          ]
        }
      ],
      ['arc', { start: { x: 0, y: 0 } }],
      ['image', { at: { x: 0, y: 0 } }],
      [
        'polyline',
        {
          points: [
            { x: 0, y: 0 },
            { x: 1, y: 1 }
          ],
          fill: 'color'
        }
      ]
    ] as const)
      expect(requestFor('items.create', { kind, record, ...framed }), kind).toMatchObject({
        ok: false
      })
  })

  it('draws a bus with schematic_wire, never with merge', () => {
    const ends = { start: { x: 0, y: 0 }, end: { x: 0, y: 25.4 } }
    expect(requestFor('schematic.wire', { ...ends, bus: true, ...framed })).toMatchObject({
      ok: true,
      request: { kind: 'draw-wire', bus: true }
    })
    expect(
      requestFor('schematic.wire', { ...ends, bus: true, merge: true, ...framed })
    ).toMatchObject({ ok: false })
  })
})

describe('items.update tracks', () => {
  it('goes to a board with the move, and is refused on a sheet, a symbol or a footprint', () => {
    expect(
      requestFor('items.update', {
        board: 'b',
        id: 'R16',
        record: { at: { x: 1, y: 2 } },
        tracks: 'follow',
        viewport: 'viewport-1',
        action: 'Act'
      })
    ).toEqual({
      ok: true,
      request: {
        kind: 'update-board-item',
        board: 'b',
        id: 'R16',
        record: { at: { x: 1, y: 2 } },
        tracks: 'follow',
        viewport: 'viewport-1',
        action: 'Act'
      }
    })
    for (const args of [
      { id: 'R1', record: { value: '1k' }, tracks: 'follow' },
      { symbol: 'a:b', id: 'pin:1', record: { type: 'input' }, tracks: 'leave' },
      { footprint: 'a:b', id: 'pad:1', record: { shape: 'rect' }, tracks: 'follow' }
    ])
      expect(requestFor('items.update', args)).toMatchObject({
        ok: false,
        error: { code: 'invalid-args', path: '/tracks' }
      })
  })
})

describe('items.delete by filter', () => {
  it('sends the filters and expect to the board', () => {
    expect(
      requestFor('items.delete', {
        board: 'b',
        kind: 'track',
        net: 'SDA',
        expect: 27,
        viewport: 'viewport-1',
        action: 'Act'
      })
    ).toEqual({
      ok: true,
      request: {
        kind: 'delete-board-items',
        board: 'b',
        itemKind: 'track',
        net: 'SDA',
        expect: 27,
        viewport: 'viewport-1',
        action: 'Act'
      }
    })
  })

  it('names the items one way, holds filters to expect, and only on a board', () => {
    const refusedFor = (args: Record<string, unknown>): void =>
      expect(requestFor('items.delete', args)).toMatchObject({ ok: false })
    refusedFor({ board: 'b', viewport: 'viewport-1', action: 'Act' })
    refusedFor({ board: 'b', ids: ['R1'], net: 'GND', expect: 1 })
    refusedFor({ board: 'b', net: 'GND' })
    refusedFor({ net: 'GND', expect: 1 })
    refusedFor({ footprint: 'a:b', board: 'b', layer: 'F.SilkS', expect: 1 })
    refusedFor({ board: 'b', ids: ['R1'], expect: 1 })
  })

  it('still deletes by id on every document', () => {
    expect(
      requestFor('items.delete', { ids: ['C8'], viewport: 'viewport-1', action: 'Act' })
    ).toEqual({
      ok: true,
      request: { kind: 'delete-items', ids: ['C8'], viewport: 'viewport-1', action: 'Act' }
    })
    expect(requestFor('items.delete', { footprint: 'a:b', ids: ['model'] })).toMatchObject({
      ok: true
    })
  })
})

describe('a viewport on layout edits', () => {
  const missing = { ok: false, error: { code: 'invalid-args', path: '/viewport' } }

  it('is required to create or delete a sheet or board item, and refused on a library', () => {
    expect(requestFor('items.delete', { board: 'b', ids: ['R1'] })).toMatchObject(missing)
    expect(
      requestFor('items.create', { kind: 'junction', record: { at: { x: 0, y: 0 } } })
    ).toMatchObject(missing)
    expect(
      requestFor('items.create', {
        footprint: 'a:b',
        kind: 'line',
        record: {},
        viewport: 'viewport-1',
        action: 'Act'
      })
    ).toMatchObject({ ok: false, error: { code: 'invalid-args', path: '/viewport' } })
  })

  it('is required by an update only when its record sets layout', () => {
    expect(
      requestFor('items.update', { board: 'b', id: 'R1', record: { at: { x: 1, y: 2 } } })
    ).toMatchObject(missing)
    expect(
      requestFor('items.update', { board: 'b', id: 'T1', record: { width: 0.3 } })
    ).toMatchObject(missing)
    expect(requestFor('items.update', { board: 'b', id: 'R1', record: { locked: true } })).toEqual({
      ok: true,
      request: { kind: 'update-board-item', board: 'b', id: 'R1', record: { locked: true } }
    })
    expect(
      requestFor('items.update', { id: 'R1', record: { fields: { MPN: 'X' } } })
    ).toMatchObject({ ok: true })
    expect(
      requestFor('items.update', { footprint: 'a:b', id: 'pad:1', record: { at: { x: 0, y: 0 } } })
    ).toMatchObject({ ok: true })
  })

  it('is a required argument of every placement, wire, fanout, routing and render', () => {
    for (const name of [
      'schematic.place_symbol',
      'schematic.wire',
      'schematic.connect',
      'schematic.add_sheet',
      'board.place_footprint',
      'board.fanout',
      'board.update_tuning_patterns',
      'route.begin',
      'route.finish',
      'render.board',
      'render.schematic'
    ])
      expect(registry.get(name)!.inputSchema.required, name).toContain('viewport')
  })
})

describe('an action on every call that moves the box', () => {
  const unlabeled = { ok: false, error: { code: 'invalid-args', path: '/action' } }

  it('is a required argument wherever viewport is, and of route_step and route_preview', () => {
    for (const name of [
      'schematic.place_symbol',
      'schematic.wire',
      'schematic.connect',
      'schematic.add_sheet',
      'schematic.undo',
      'schematic.redo',
      'board.place_footprint',
      'board.fanout',
      'board.update_tuning_patterns',
      'board.undo',
      'board.redo',
      'route.begin',
      'route.finish',
      'route.step',
      'route.preview',
      'render.board',
      'render.schematic'
    ])
      expect(registry.get(name)!.inputSchema.required, name).toContain('action')
    for (const name of [
      'items.update',
      'items.create',
      'items.delete',
      'board.batch',
      'schematic.batch'
    ])
      expect(registry.get(name)!.inputSchema.required ?? [], name).not.toContain('action')
  })

  it('refuses a missing or long action with the fix that names it', () => {
    const missing = requestFor('render.schematic', { viewport: 'viewport-1' })
    expect(missing).toMatchObject(unlabeled)
    expect((missing as { error: { fix: string } }).error.fix).toContain('Pass action')
    expect(
      requestFor('route.step', { session: 'route-1', gestures: [{ to: 'U2.5' }] })
    ).toMatchObject(unlabeled)
    expect(
      requestFor('render.schematic', { viewport: 'viewport-1', action: 'x'.repeat(33) })
    ).toMatchObject(unlabeled)
  })

  it('goes onto the request as one line', () => {
    expect(
      requestFor('route.preview', {
        session: 'route-1',
        candidates: [[{ to: 'U2.5' }]],
        action: '  Compare\n two ways  '
      })
    ).toEqual({
      ok: true,
      request: {
        kind: 'preview-route',
        session: 'route-1',
        candidates: [[{ to: 'U2.5' }]],
        action: 'Compare two ways'
      }
    })
  })

  it('is required by an item edit exactly when its viewport is', () => {
    expect(
      requestFor('items.update', {
        board: 'b',
        id: 'R1',
        record: { at: { x: 1, y: 2 } },
        viewport: 'viewport-1'
      })
    ).toMatchObject(unlabeled)
    expect(
      requestFor('items.delete', { board: 'b', ids: ['R1'], viewport: 'viewport-1' })
    ).toMatchObject(unlabeled)
    expect(
      requestFor('items.update', { board: 'b', id: 'R1', record: { locked: true } })
    ).toMatchObject({ ok: true })
    expect(
      requestFor('items.update', {
        footprint: 'a:b',
        id: 'pad:1',
        record: { at: { x: 0, y: 0 } },
        action: 'Move pad 1'
      })
    ).toMatchObject(unlabeled)
  })
})

describe('items.query paging', () => {
  it('passes offset and revision to a board and a sheet', () => {
    expect(requestFor('items.query', { board: 'b', offset: 400, revision: 3 })).toEqual({
      ok: true,
      request: { kind: 'query-board-items', board: 'b', offset: 400, revision: 3 }
    })
    expect(requestFor('items.query', { offset: 100, revision: 9 })).toEqual({
      ok: true,
      request: { kind: 'query-items', offset: 100, revision: 9 }
    })
  })

  it('refuses a revision on a footprint, which answers none', () => {
    expect(requestFor('items.query', { footprint: 'a:b', revision: 1, offset: 100 })).toMatchObject(
      { ok: false }
    )
  })
})

describe('board.batch', () => {
  it('refuses an entry that pins its own revision', async () => {
    const op = registry.get('board.batch')!
    const outcome = await op.invoke(
      { ops: [{ op: 'items.query', args: { revision: 2 } }] },
      {} as Parameters<typeof op.invoke>[1]
    )
    expect(outcome).toMatchObject({ ok: false, error: { code: 'refused' } })
  })

  it('holds items.transform, which sets layout and so needs the batch viewport', async () => {
    const op = registry.get('board.batch')!
    const outcome = await op.invoke(
      {
        ops: [
          { op: 'items.transform', args: { ids: ['R1'], transform: 'move', by: { x: 1, y: 0 } } }
        ]
      },
      {} as Parameters<typeof op.invoke>[1]
    )
    expect(outcome).toMatchObject({
      ok: false,
      error: { code: 'invalid-args', path: '/viewport' }
    })
  })
})

describe('a record is checked in main, on every document', () => {
  const framed = { viewport: 'viewport-1', action: 'Act' }
  const docs: Array<Record<string, string>> = [
    { symbol: 'board:ES8388', kind: 'polyline' },
    { footprint: 'board:SOT-23-5', kind: 'line' },
    { board: 'b.kicad_pcb', kind: 'line', ...framed },
    { kind: 'polyline', ...framed }
  ]

  it('refuses a bad value on create as invalid-record, worded one way', () => {
    for (const args of docs) {
      expect(requestFor('items.create', { ...args, record: { strokeType: 'wavy' } })).toMatchObject(
        {
          ok: false,
          error: {
            code: 'invalid-args',
            kind: 'invalid-record',
            path: '/record/strokeType',
            message: `${args.kind}.strokeType must be one of default, solid, dash, dot, dash_dot, dash_dot_dot.`
          }
        }
      )
    }
  })

  it('refuses a key no item of the document takes on update as not-applicable', () => {
    for (const { kind, ...target } of docs) {
      expect(
        requestFor('items.update', { ...target, id: kind, record: { glow: '#000000' } })
      ).toMatchObject({ ok: false, error: { code: 'refused', kind: 'not-applicable' } })
    }
  })

  it('holds an update to the rule of whichever kind takes the key', () => {
    expect(
      requestFor('items.update', {
        footprint: 'board:SOT-23-5',
        id: 'x',
        record: { fill: 'solid' }
      })
    ).toMatchObject({ ok: true })
    expect(
      requestFor('items.update', { symbol: 'board:ES8388', id: 'x', record: { fill: true } })
    ).toMatchObject({ ok: false, error: { kind: 'invalid-record', path: '/record/fill' } })
  })

  it("checks a batch's entries before the batch crosses", async () => {
    const seen: unknown[] = []
    const ctx = {
      design: async (request: unknown) => {
        seen.push(request)
        return { ok: true as const, payload: {} }
      }
    }
    const outcome = await registry.get('footprint.batch')!.invoke(
      {
        footprint: 'board:SOT-23-5',
        ops: [
          { op: 'items.update', args: { id: 'pad:1', record: { shape: 'rect' } } },
          { op: 'items.update', args: { id: 'pad:2', record: { shape: 'hexagon' } } }
        ]
      },
      ctx as never
    )
    expect(outcome).toMatchObject({
      ok: false,
      error: { kind: 'invalid-record', path: '/ops/1/args/record/shape' }
    })
    expect(seen).toEqual([])
  })
})

describe('the record description', () => {
  const described = (op: string): string =>
    (registry.get(op)!.inputSchema as { properties: { record: { description: string } } })
      .properties.record.description

  it('names every key a kind takes, itself or by its group', () => {
    const text = described('items.update')
    const named = new Set(text.match(/[A-Za-z_]+/g))
    for (const document of ['sheet', 'symbol', 'footprint', 'board'] as const)
      for (const mode of ['create', 'update'] as const)
        for (const keys of Object.values(RECORDS[document][mode]))
          for (const key of keys) expect(named.has(key), `${document} ${key}`).toBe(true)
    expect(described('items.create')).toBe(text)
  })

  it('says the color format once', () => {
    expect(described('items.update').match(/#rrggbb"/g)).toHaveLength(1)
  })

  it("keeps items_update's guidance under 900 characters", () => {
    expect(registry.get('items.update')!.guidance!.length).toBeLessThan(900)
  })
})
