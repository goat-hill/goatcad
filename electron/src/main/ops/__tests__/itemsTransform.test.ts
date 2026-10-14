import { describe, expect, test } from 'vitest'
import { itemsTransform } from '../items/transform'

const build = (args: Record<string, unknown>): unknown => itemsTransform.designRequest!(args)

describe('items.transform arguments', () => {
  test('a symbol rotate and a footprint anchor become their window requests', () => {
    expect(build({ symbol: 'proj:Part', ids: ['pin:1'], transform: 'rotate', angle: 90 })).toEqual({
      ok: true,
      request: {
        kind: 'transform-symbol-items',
        symbol: 'proj:Part',
        transform: 'rotate',
        ids: ['pin:1'],
        angle: 90
      }
    })
    expect(
      build({ footprint: 'U1', board: 'b.kicad_pcb', transform: 'anchor', at: { x: 1, y: 0 } })
    ).toMatchObject({
      ok: true,
      request: { kind: 'transform-footprint-items', footprint: 'U1', board: 'b.kicad_pcb', ids: [] }
    })
  })

  test('each transform takes only its own arguments, and needs its own', () => {
    for (const [args, path] of [
      [{ transform: 'move', ids: ['pad:1'] }, '/by'],
      [{ transform: 'move', ids: ['pad:1'], by: { x: 1, y: 0 }, angle: 90 }, '/angle'],
      [{ transform: 'anchor', ids: ['pad:1'], at: { x: 1, y: 0 } }, '/ids'],
      [{ transform: 'mirror', axis: 'x' }, '/ids'],
      [{ transform: 'duplicate', ids: ['pad:1'], by: { x: 1, y: 0 }, pinStep: 1 }, '/pinStep']
    ] as const) {
      expect(build({ footprint: 'proj:T', ...args })).toMatchObject({
        ok: false,
        error: { code: 'invalid-args', path }
      })
    }
  })

  test('a symbol turns in quarter turns and has no sides; a document is required', () => {
    expect(
      build({ symbol: 'proj:Part', ids: ['pin:1'], transform: 'rotate', angle: 45 })
    ).toMatchObject({ ok: false, error: { path: '/angle' } })
    expect(build({ symbol: 'proj:Part', ids: ['pin:1'], transform: 'flip' })).toMatchObject({
      ok: false,
      error: { path: '/transform' }
    })
    expect(build({ ids: ['pin:1'], transform: 'move', by: { x: 1, y: 0 } })).toMatchObject({
      ok: false,
      error: { code: 'invalid-args' }
    })
  })

  test('a board transform needs a viewport and action, and takes no anchor or pinStep', () => {
    const turn = { board: 'b.kicad_pcb', ids: ['C3', 'C4'], transform: 'rotate', angle: 90 }
    expect(build({ ...turn, viewport: 'viewport-1', action: 'Turn caps' })).toEqual({
      ok: true,
      request: {
        kind: 'transform-board-items',
        board: 'b.kicad_pcb',
        transform: 'rotate',
        ids: ['C3', 'C4'],
        angle: 90,
        viewport: 'viewport-1',
        action: 'Turn caps'
      }
    })
    expect(build(turn)).toMatchObject({ ok: false, error: { path: '/viewport' } })
    expect(build({ ...turn, viewport: 'viewport-1' })).toMatchObject({
      ok: false,
      error: { path: '/action' }
    })
    const view = { board: 'b.kicad_pcb', viewport: 'viewport-1', action: 'Edit' }
    expect(build({ ...view, transform: 'anchor', at: { x: 0, y: 0 } })).toMatchObject({
      ok: false,
      error: { path: '/transform' }
    })
    expect(
      build({ ...view, transform: 'duplicate', ids: ['R1'], by: { x: 1, y: 0 }, pinStep: 1 })
    ).toMatchObject({ ok: false, error: { path: '/pinStep' } })
  })

  test('a symbol or footprint takes no viewport', () => {
    expect(
      build({ footprint: 'proj:T', ids: ['pad:1'], transform: 'flip', viewport: 'viewport-1' })
    ).toMatchObject({ ok: false, error: { path: '/viewport' } })
  })
})
