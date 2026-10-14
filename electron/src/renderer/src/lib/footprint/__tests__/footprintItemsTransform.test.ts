import { describe, expect, test } from 'vitest'
import {
  parseKicadFootprint,
  serializeKicadFootprint,
  type KicadFootprint
} from '../../kicad/footprint'
import { DocumentStore } from '../../document/documentStore'
import { createTextSession } from '../../document/textSession'
import { footprintItems, resolveItem } from '../footprintItems'
import { transformFootprintItemsById } from '../footprintItemsTransform'
import { createFootprintAgent } from '../footprintAgent'
import type { McpItemsTransform } from '../../../../../preload/mcpTypes'

/** No uuids, so every id but a unique pad's is positional and moves with its item. */
const LIBRARY = `(footprint "T"
  (version 20260206)
  (generator "kicad-footprint-generator")
  (layer "F.Cu")
  (property "Reference" "REF**" (at 0 -2 0) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15))))
  (property "Value" "T" (at 0 2 0) (layer "F.Fab") (effects (font (size 1 1) (thickness 0.15))))
  (attr smd)
  (fp_line (start -1 -1) (end 1 -1) (stroke (width 0.12) (type solid)) (layer "F.SilkS"))
  (fp_line (start -1 -1) (end -1 1) (stroke (width 0.12) (type solid)) (layer "F.SilkS"))
  (pad "1" smd roundrect (at -0.5 0) (size 0.6 0.8) (layers "F.Cu" "F.Paste" "F.Mask") (roundrect_rratio 0.25))
  (pad "2" smd roundrect (at 0.5 0) (size 0.6 0.8) (layers "F.Cu" "F.Paste" "F.Mask") (roundrect_rratio 0.25))
  (model "\${KICAD10_3DMODEL_DIR}/T.step" (offset (xyz 0 0 0)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 0)))
)
`

const record = (fp: KicadFootprint, id: string): Record<string, unknown> => {
  const found = resolveItem(footprintItems(fp), id)
  if (!found.ok) throw new Error(found.detail)
  return found.item.record
}

const idsOf = (fp: KicadFootprint, kind: string): string[] =>
  footprintItems(fp)
    .filter((item) => item.kind === kind)
    .map((item) => item.id)

const run = (
  spec: Partial<McpItemsTransform> & Pick<McpItemsTransform, 'transform'>
): { fp: KicadFootprint; outcome: ReturnType<typeof transformFootprintItemsById> } => {
  const fp = parseKicadFootprint(LIBRARY)
  const outcome = transformFootprintItemsById(fp, { ids: [], ...spec })
  return { fp, outcome }
}

describe('a footprint transform by id', () => {
  test('rotate turns two pads about their center, as the editor does', () => {
    const { fp, outcome } = run({ transform: 'rotate', ids: ['pad:1', 'pad:2'], angle: 90 })
    expect(outcome).toEqual({
      ok: true,
      changed: { created: [], updated: ['pad:1', 'pad:2'], deleted: [] }
    })
    expect(record(fp, 'pad:1')).toMatchObject({ at: { x: 0, y: 0.5 }, angle: 90 })
    expect(record(fp, 'pad:2')).toMatchObject({ at: { x: 0, y: -0.5 }, angle: 90 })
  })

  test('mirror "y" flips left to right about a given point', () => {
    const { fp } = run({ transform: 'mirror', ids: ['pad:1'], axis: 'y', about: { x: 1, y: 0 } })
    expect(record(fp, 'pad:1')).toMatchObject({ at: { x: 2.5, y: 0 } })
  })

  test('flip moves a silk line to the back, and answers its new id', () => {
    const [line] = idsOf(parseKicadFootprint(LIBRARY), 'line')
    const { fp, outcome } = run({ transform: 'flip', ids: [line] })
    if (!outcome.ok) throw new Error(outcome.detail)
    const [moved] = outcome.changed.updated
    expect(record(fp, moved)).toMatchObject({ layer: 'B.SilkS' })
  })

  test('move shifts a pad, and the scratch stays readable for the next edit', () => {
    const { fp } = run({ transform: 'move', ids: ['pad:1'], by: { x: 1, y: 0.25 } })
    expect(fp.pads[0].position).toMatchObject({ x: 500000, y: 250000 })
    expect(record(fp, 'pad:1')).toMatchObject({ at: { x: 0.5, y: 0.25 } })
  })

  test('duplicate copies items by an offset and names the copies', () => {
    const lines = idsOf(parseKicadFootprint(LIBRARY), 'line')
    const { fp, outcome } = run({ transform: 'duplicate', ids: lines, by: { x: 0, y: 3 } })
    if (!outcome.ok) throw new Error(outcome.detail)
    expect(outcome.changed.created).toHaveLength(2)
    expect(outcome.changed.updated).toEqual([])
    expect(record(fp, outcome.changed.created[0])).toMatchObject({ start: { x: -1, y: 2 } })
    expect(idsOf(fp, 'line')).toHaveLength(4)
  })

  test('anchor moves the origin: every item shifts, the model offset follows', () => {
    const { fp, outcome } = run({ transform: 'anchor', at: { x: -0.5, y: 0 } })
    if (!outcome.ok) throw new Error(outcome.detail)
    expect(record(fp, 'pad:1')).toMatchObject({ at: { x: 0, y: 0 } })
    expect(outcome.changed.updated).toEqual(expect.arrayContaining(['pad:1', 'pad:2', 'model']))
  })

  test('the model, a duplicated field and a miss are refused', () => {
    expect(run({ transform: 'move', ids: ['model'], by: { x: 1, y: 0 } }).outcome).toMatchObject({
      ok: false,
      error: 'not-transformable'
    })
    expect(
      run({ transform: 'duplicate', ids: ['property:Value'], by: { x: 1, y: 0 } }).outcome
    ).toMatchObject({ ok: false, error: 'not-transformable' })
    // The footprint itself is no item to transform: a copy would nest it in itself.
    expect(
      run({ transform: 'duplicate', ids: ['footprint'], by: { x: 1, y: 0 } }).outcome
    ).toMatchObject({ ok: false, error: 'not-transformable' })
    expect(run({ transform: 'move', ids: ['pad:9'], by: { x: 1, y: 0 } }).outcome).toMatchObject({
      ok: false,
      error: 'item-not-found'
    })
  })
})

describe('the footprint door', () => {
  const FILE = '/proj/proj.pretty/T.kicad_mod'

  test('a transform in a batch is one undo step, labeled for the batch', async () => {
    const document = new DocumentStore(async () => null).open(FILE, LIBRARY)
    const session = createTextSession<KicadFootprint, unknown>({
      document,
      parse: parseKicadFootprint,
      serialize: serializeKicadFootprint,
      commit: () => {},
      readOnly: () => false
    })
    const labels: string[] = []
    const agent = createFootprintAgent({
      resolve: async () => ({ ok: true, file: FILE, scope: 'project' }),
      read: async () => document.text(),
      session: async () => session,
      label: (key) => {
        labels.push(key)
        return key
      },
      modelFacts: async () => ({
        status: 'not-installed' as const,
        resolved: null,
        bounds: null,
        fit: null,
        triangles: 0,
        meshes: 0
      })
    })
    const alone = (await agent.dispatch({
      kind: 'transform-footprint-items',
      footprint: 'proj:T',
      transform: 'rotate',
      ids: ['pad:1'],
      angle: 90
    })) as Record<string, unknown>
    expect(alone.changed).toEqual({ created: [], updated: ['pad:1'], deleted: [] })
    expect(labels).toEqual(['footprintEditor.commands.rotate'])

    const answer = (await agent.dispatch({
      kind: 'batch-footprint',
      footprint: 'proj:T',
      ops: [
        {
          kind: 'transform-footprint-items',
          footprint: 'proj:T',
          transform: 'move',
          ids: ['pad:2'],
          by: { x: 1, y: 0 }
        },
        { kind: 'get-footprint-items', footprint: 'proj:T', ids: ['pad:2'] }
      ]
    })) as { changed: unknown; results: Array<Record<string, unknown>> }
    expect(answer.changed).toEqual({ created: [], updated: ['pad:2'], deleted: [] })
    expect(answer.results[1]).toMatchObject({ items: [{ at: { x: 1.5, y: 0 } }] })
    expect(session.undo()).toBeTruthy()
    expect(serializeKicadFootprint(session.model()!)).toContain('(at 0.5 0)')
  })
})
