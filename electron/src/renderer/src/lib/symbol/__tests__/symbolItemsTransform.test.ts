import { describe, expect, test } from 'vitest'
import {
  parseKicadSymbolLibrary,
  serializeKicadSymbolLibrary,
  type KicadSymbolLibrary
} from '../../kicad/symbolLibrary'
import { mmToNm, spacingToMm } from '../../kicad/coordinates'
import type { SExprList } from '../../kicad/sexpr'
import { DocumentStore } from '../../document/documentStore'
import { createTextSession } from '../../document/textSession'
import { resolveSymbolItem, symbolItems } from '../symbolItems'
import { transformSymbolItems } from '../symbolItemsTransform'
import { createSymbolItemsAgent } from '../symbolItemsAgent'
import type { McpItemsTransform } from '../../../../../preload/mcpTypes'

const font = '(effects (font (size 1.27 1.27)))'

/** A box with an input on the left and an output on the right; the file is y up. */
const LIBRARY = `(kicad_symbol_lib
  (version 20251024)
  (generator "kicad_symbol_editor")
  (symbol "Part"
    (property "Reference" "U" (at 0 5.08 0) ${font})
    (property "Value" "Part" (at 0 -5.08 0) ${font})
    (symbol "Part_0_1"
      (rectangle (start -2.54 2.54) (end 2.54 -2.54) (stroke (width 0.254) (type default)) (fill (type background)))
    )
    (symbol "Part_1_1"
      (pin input line (at -5.08 0 0) (length 2.54) (name "IN" ${font}) (number "1" ${font}))
      (pin output line (at 5.08 0 180) (length 2.54) (name "OUT" ${font}) (number "2" ${font}))
    )
  )
)
`

const symbolNode = (library: KicadSymbolLibrary): SExprList => library.symbols.get('Part')!._node

const record = (node: SExprList, id: string): Record<string, unknown> => {
  const found = resolveSymbolItem(symbolItems(node), id)
  if (!found.ok) throw new Error(found.detail)
  return found.item.record
}

const run = (
  spec: Partial<McpItemsTransform> & Pick<McpItemsTransform, 'transform'>
): { node: SExprList; outcome: ReturnType<typeof transformSymbolItems> } => {
  const node = symbolNode(parseKicadSymbolLibrary(LIBRARY))
  return { node, outcome: transformSymbolItems(node, { ids: [], ...spec }) }
}

describe('a symbol transform by id', () => {
  test('rotate turns pins about the center of their extent, counterclockwise', () => {
    const { node, outcome } = run({ transform: 'rotate', ids: ['pin:1', 'pin:2'], angle: 90 })
    expect(outcome).toEqual({
      ok: true,
      changed: { created: [], updated: ['pin:1', 'pin:2'], deleted: [] }
    })
    // The left pin goes to the bottom (y down), pointing up.
    expect(record(node, 'pin:1')).toMatchObject({ at: { x: 0, y: 5.08 }, angle: 90 })
  })

  test('mirror "y" flips left to right, turning the pin round', () => {
    const { node } = run({ transform: 'mirror', ids: ['pin:1'], axis: 'y', about: { x: 0, y: 0 } })
    expect(record(node, 'pin:1')).toMatchObject({ at: { x: 5.08, y: 0 }, angle: 180 })
  })

  test('move shifts a pin and a field by an offset, y down', () => {
    const { node, outcome } = run({
      transform: 'move',
      ids: ['pin:1', 'field:Reference'],
      by: { x: 1.27, y: 2.54 }
    })
    expect(outcome).toMatchObject({ ok: true, changed: { updated: ['pin:1', 'field:Reference'] } })
    expect(record(node, 'pin:1')).toMatchObject({ at: { x: -3.81, y: 2.54 } })
    expect(record(node, 'field:Reference')).toMatchObject({ at: { x: 1.27, y: -2.54 } })
  })

  test('duplicate numbers a copied pin on from the highest; pinStep steps it from its source', () => {
    const plain = run({ transform: 'duplicate', ids: ['pin:1'], by: { x: 0, y: 2.54 } })
    expect(plain.outcome).toMatchObject({ ok: true, changed: { created: ['pin:3'], updated: [] } })
    expect(record(plain.node, 'pin:3')).toMatchObject({ name: 'IN', at: { x: -5.08, y: 2.54 } })

    const stepped = run({
      transform: 'duplicate',
      ids: ['pin:2'],
      by: { x: 0, y: 2.54 },
      pinStep: 5
    })
    expect(stepped.outcome).toMatchObject({ ok: true, changed: { created: ['pin:7'] } })
    expect(record(stepped.node, 'pin:7')).toMatchObject({ unit: 1, at: { x: 5.08, y: 2.54 } })
  })

  test('anchor makes a point the origin, shifting every item', () => {
    const { node, outcome } = run({ transform: 'anchor', at: { x: -5.08, y: 0 } })
    if (!outcome.ok) throw new Error(outcome.detail)
    expect(record(node, 'pin:1')).toMatchObject({ at: { x: 0, y: 0 } })
    expect(outcome.changed.updated).toEqual(
      expect.arrayContaining(['pin:1', 'pin:2', 'rect:0.1.0', 'field:Reference'])
    )
  })

  test('a field only moves, a symbol does not flip, and a miss names candidates', () => {
    expect(run({ transform: 'rotate', ids: ['field:Value'], angle: 90 }).outcome).toMatchObject({
      ok: false,
      error: 'not-transformable'
    })
    expect(run({ transform: 'flip', ids: ['pin:1'] }).outcome).toMatchObject({
      ok: false,
      error: 'not-transformable'
    })
    // The symbol itself is no item to transform: a copy would nest it in its unit.
    expect(
      run({ transform: 'duplicate', ids: ['symbol'], by: { x: 1, y: 0 } }).outcome
    ).toMatchObject({ ok: false, error: 'not-transformable' })
    expect(run({ transform: 'move', ids: ['pin:9'], by: { x: 1, y: 0 } }).outcome).toMatchObject({
      ok: false,
      error: 'item-not-found'
    })
  })
})

describe('the symbol door', () => {
  test('a transform is one undo step with the editor label, and runs in a batch', async () => {
    const FILE = '/proj/proj.kicad_sym'
    const document = new DocumentStore(async () => null).open(FILE, LIBRARY)
    const session = createTextSession<KicadSymbolLibrary, unknown>({
      document,
      parse: parseKicadSymbolLibrary,
      serialize: serializeKicadSymbolLibrary,
      commit: () => {},
      readOnly: () => false
    })
    const labels: string[] = []
    const agent = createSymbolItemsAgent({
      resolve: async () => ({
        ok: true,
        name: 'Part',
        scope: 'project',
        writable: true,
        file: FILE
      }),
      read: async () => document.text(),
      session: async () => session,
      label: (key) => {
        labels.push(key)
        return key
      },
      checkGrid: async () => mmToNm(spacingToMm(50, 'mil'))
    })
    const alone = (await agent.dispatch({
      kind: 'transform-symbol-items',
      symbol: 'proj:Part',
      transform: 'duplicate',
      ids: ['pin:1'],
      by: { x: 0, y: 2.54 },
      pinStep: 2
    })) as Record<string, unknown>
    expect(alone.changed).toEqual({ created: ['pin:3'], updated: [], deleted: [] })
    expect(labels).toEqual(['symbolEditor.commands.repeatItems'])

    const batch = (await agent.dispatch({
      kind: 'batch-symbol',
      symbol: 'proj:Part',
      ops: [
        {
          kind: 'transform-symbol-items',
          symbol: 'proj:Part',
          transform: 'move',
          ids: ['pin:3'],
          by: { x: 0, y: 2.54 }
        },
        { kind: 'get-symbol-items', symbol: 'proj:Part', ids: ['pin:3'] }
      ]
    })) as { changed: unknown; results: Array<Record<string, unknown>> }
    expect(batch.changed).toEqual({ created: [], updated: ['pin:3'], deleted: [] })
    expect(batch.results[1]).toMatchObject({ items: [{ at: { x: -5.08, y: 5.08 } }] })
  })
})
