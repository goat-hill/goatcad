import { describe, expect, test } from 'vitest'
import {
  parseKicadFootprint,
  serializeKicadFootprint,
  type KicadFootprint
} from '../../kicad/footprint'
import { mmToNm } from '../../kicad/coordinates'
import { DocumentStore } from '../../document/documentStore'
import { createTextSession } from '../../document/textSession'
import {
  createItem,
  deleteItems,
  footprintItems,
  itemRow,
  queryItems,
  resolveItem,
  updateItem
} from '../footprintItems'
import {
  createFootprintAgent,
  isFootprintRequest,
  type FootprintAgentContext
} from '../footprintAgent'
import { generateFootprint } from '../footprintGenerate'
import { DEFAULT_STYLE_CHOICES } from '../footprintStyle'
import { JST_PH_4 } from './footprintFixtures'
import { parseKicadBoard } from '../../kicad/board'
import { projectFootprintCopy } from '../../board/footprintCopy'

/** KiCad 10's library dialect: no uuids, `(fill no)`. */
const LIBRARY = `(footprint "T"
  (version 20260206)
  (generator "kicad-footprint-generator")
  (layer "F.Cu")
  (property "Reference" "REF**" (at 0 -2 0) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15))))
  (property "Value" "T" (at 0 2 0) (layer "F.Fab") (effects (font (size 1 1) (thickness 0.15))))
  (attr smd)
  (fp_line (start -1 -1) (end 1 -1) (stroke (width 0.12) (type solid)) (layer "F.SilkS"))
  (fp_line (start -1 -1) (end -1 1) (stroke (width 0.12) (type solid)) (layer "F.SilkS"))
  (fp_rect (start -1.5 -1.5) (end 1.5 1.5) (stroke (width 0.05) (type solid)) (fill no) (layer "F.CrtYd"))
  (fp_text user "\${REFERENCE}" (at 0 0 0) (layer "F.Fab") (effects (font (size 0.5 0.5) (thickness 0.08))))
  (pad "1" smd roundrect (at -0.5 0) (size 0.6 0.8) (layers "F.Cu" "F.Paste" "F.Mask") (roundrect_rratio 0.25))
  (pad "2" smd roundrect (at 0.5 0) (size 0.6 0.8) (layers "F.Cu" "F.Paste" "F.Mask") (roundrect_rratio 0.25))
  (pad "MP" smd rect (at 0 1) (size 0.3 0.3) (layers "F.Cu" "F.Mask"))
  (pad "MP" smd rect (at 0 -1) (size 0.3 0.3) (layers "F.Cu" "F.Mask"))
  (model "\${KICAD10_3DMODEL_DIR}/T.step" (offset (xyz 0 0 0)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 0)))
)
`

const reparse = (fp: KicadFootprint): KicadFootprint =>
  parseKicadFootprint(serializeKicadFootprint(fp))

const find = (fp: KicadFootprint, id: string): ReturnType<typeof footprintItems>[number] => {
  const found = resolveItem(footprintItems(fp), id)
  if (!found.ok) throw new Error(found.detail)
  return found.item
}

describe('footprintItems', () => {
  test('ids: positional for a node with no uuid, numbered when two share a point', () => {
    const ids = footprintItems(parseKicadFootprint(LIBRARY)).map((item) => item.id)
    expect(ids).toEqual([
      'footprint',
      'pad:1',
      'pad:2',
      'pad@0,1',
      'pad@0,-1',
      'line@-1,-1',
      'line@-1,-1#2',
      'rect@-1.5,-1.5',
      'text@0,0',
      'property:Reference',
      'property:Value',
      'model'
    ])
  })

  test('records are millimeters in the shape a write takes', () => {
    const fp = parseKicadFootprint(LIBRARY)
    expect(itemRow(find(fp, 'pad:1'))).toEqual({
      id: 'pad:1',
      kind: 'pad',
      number: '1',
      type: 'smd',
      shape: 'roundrect',
      at: { x: -0.5, y: 0 },
      size: { width: 0.6, height: 0.8 },
      layers: ['F.Cu', 'F.Paste', 'F.Mask'],
      roundrectRatio: 0.25,
      box: { x: -0.8, y: -0.4, width: 0.6, height: 0.8 }
    })
    expect(itemRow(find(fp, 'rect@-1.5,-1.5'))).toMatchObject({
      layer: 'F.CrtYd',
      width: 0.05,
      start: { x: -1.5, y: -1.5 },
      fill: 'none'
    })
    expect(itemRow(find(fp, 'property:Value'))).toMatchObject({
      key: 'Value',
      value: 'T',
      at: { x: 0, y: 2 },
      angle: 0,
      layer: 'F.Fab',
      size: 1,
      thickness: 0.15,
      hidden: false
    })
    expect(itemRow(find(fp, 'model'))).toMatchObject({ scale: { x: 1, y: 1, z: 1 } })
  })

  test('a shared pad number is not an alias, and a miss names candidates', () => {
    const items = footprintItems(parseKicadFootprint(LIBRARY))
    expect(resolveItem(items, 'pad:MP')).toMatchObject({
      ok: false,
      candidates: ['pad@0,1', 'pad@0,-1']
    })
    expect(resolveItem(items, 'line@-1')).toMatchObject({
      ok: false,
      candidates: ['line@-1,-1', 'line@-1,-1#2']
    })
  })

  test('a uuid pad is still reachable by its number', () => {
    const result = generateFootprint(JST_PH_4, DEFAULT_STYLE_CHOICES)
    if (!result.ok) throw new Error(result.error)
    const items = footprintItems(parseKicadFootprint(result.text))
    const pad = resolveItem(items, 'pad:3')
    expect(pad.ok && pad.item.record.at).toEqual({ x: 4, y: 0 })
    expect(pad.ok && pad.item.id).toMatch(/^[0-9a-f-]{36}$/)
  })

  test('query by kind, layer, number and region', () => {
    const items = footprintItems(parseKicadFootprint(LIBRARY))
    const ids = (query: Parameters<typeof queryItems>[1]): string[] =>
      queryItems(items, query).rows.map((item) => item.id)
    expect(ids({ layer: 'F.SilkS' })).toEqual(['line@-1,-1', 'line@-1,-1#2', 'property:Reference'])
    expect(ids({ kind: 'pad', number: 'MP' })).toEqual(['pad@0,1', 'pad@0,-1'])
    expect(ids({ kind: 'pad', box: { x: 0.3, y: -0.1, width: 0.1, height: 0.1 } })).toEqual([
      'pad:2'
    ])
    expect(ids({ kind: 'pad', near: { x: 0, y: 1 }, radius: 0.1 })).toEqual(['pad@0,1'])
    expect(queryItems(items, { limit: 2 })).toMatchObject({ total: 12 })
  })
})

describe('updateItem', () => {
  test('moves and resizes a pad, keeping what it was not told', () => {
    const fp = parseKicadFootprint(LIBRARY)
    expect(
      updateItem(fp, find(fp, 'pad:1'), {
        at: { x: -0.6, y: 0 },
        size: { width: 0.7, height: 0.9 }
      })
    ).toEqual({ ok: true })
    const pad = reparse(fp).pads[0]
    expect(pad.position).toEqual({ x: mmToNm(-0.6), y: mmToNm(0) })
    expect(pad.size).toEqual({ w: mmToNm(0.7), h: mmToNm(0.9) })
    expect(pad.roundrectRatio).toBe(0.25)
  })

  test('writes layers, chamfer, thermal and paste ratio', () => {
    const fp = parseKicadFootprint(LIBRARY)
    updateItem(fp, find(fp, 'pad:2'), {
      layers: ['F.Cu', 'F.Mask'],
      chamfer: { ratio: 0.2, corners: ['top_left'] },
      thermal: { bridgeWidth: 0.3, zoneConnect: 'solid' },
      pasteRatio: -0.2
    })
    const record = find(reparse(fp), 'pad:2').record
    expect(record).toMatchObject({
      layers: ['F.Cu', 'F.Mask'],
      chamfer: { ratio: 0.2, corners: ['top_left'] },
      thermal: { bridgeWidth: 0.3, zoneConnect: 'solid' },
      pasteRatio: -0.2
    })
  })

  test('a pad turned roundrect gets the library radius', () => {
    const fp = parseKicadFootprint(LIBRARY)
    updateItem(fp, find(fp, 'pad@0,1'), { shape: 'roundrect' })
    expect(reparse(fp).pads[2]).toMatchObject({ shape: 'roundrect', roundrectRatio: 0.25 })
  })

  test('moves a line and keeps the file dialect for fill', () => {
    const fp = parseKicadFootprint(LIBRARY)
    updateItem(fp, find(fp, 'line@-1,-1#2'), { end: { x: -1, y: 0.5 }, width: 0.1 })
    updateItem(fp, find(fp, 'rect@-1.5,-1.5'), { fill: true })
    const text = serializeKicadFootprint(fp)
    expect(text).toContain('(fill yes)')
    expect(reparse(fp).fpLines[1]).toMatchObject({
      end: { x: mmToNm(-1), y: mmToNm(0.5) },
      strokeWidth: mmToNm(0.1)
    })
  })

  test('hides and resizes a property without losing its layer', () => {
    const fp = parseKicadFootprint(LIBRARY)
    updateItem(fp, find(fp, 'property:Value'), { hidden: true, size: 0.8, at: { x: 0, y: 2.5 } })
    expect(find(reparse(fp), 'property:Value').record).toMatchObject({
      hidden: true,
      size: 0.8,
      thickness: 0.15,
      at: { x: 0, y: 2.5 },
      layer: 'F.Fab'
    })
  })

  test('refuses a key the kind does not carry, a bad value, and a key rename', () => {
    const fp = parseKicadFootprint(LIBRARY)
    expect(updateItem(fp, find(fp, 'line@-1,-1'), { drill: { diameter: 1 } })).toMatchObject({
      ok: false,
      error: 'not-applicable'
    })
    expect(updateItem(fp, find(fp, 'pad:1'), { size: { width: 0, height: 1 } })).toMatchObject({
      ok: false,
      error: 'invalid-record',
      detail: 'pad.size must be {width, height}, both positive.'
    })
    expect(updateItem(fp, find(fp, 'property:Value'), { key: 'X' })).toMatchObject({
      ok: false,
      error: 'not-applicable'
    })
  })
})

describe('createItem and deleteItems', () => {
  test('a silk line takes the silk width when none is given', () => {
    const fp = parseKicadFootprint(LIBRARY)
    const made = createItem(fp, 'line', {
      layer: 'F.SilkS',
      start: { x: 1, y: -1 },
      end: { x: 1, y: 1 }
    })
    expect(made).toMatchObject({ ok: true })
    const line = reparse(fp).fpLines[2]
    expect(line.strokeWidth).toBe(mmToNm(0.12))
    expect(made.ok && made.id).toBe(line.uuid)
  })

  test('a pad takes default layers and a radius, and needs a drill for a hole', () => {
    const fp = parseKicadFootprint(LIBRARY)
    expect(
      createItem(fp, 'pad', {
        number: '3',
        type: 'smd',
        shape: 'roundrect',
        at: { x: 1, y: 1 },
        size: { width: 0.4, height: 0.4 },
        pasteRatio: -0.1
      })
    ).toMatchObject({ ok: true })
    expect(reparse(fp).pads[4]).toMatchObject({
      number: '3',
      layers: ['F.Cu', 'F.Paste', 'F.Mask'],
      roundrectRatio: 0.25,
      solderPasteMarginRatio: -0.1
    })
    expect(
      createItem(fp, 'pad', {
        number: '4',
        type: 'thru_hole',
        shape: 'circle',
        at: { x: 2, y: 2 },
        size: { width: 1, height: 1 }
      })
    ).toMatchObject({ ok: false, detail: 'A thru_hole pad needs drill.' })
  })

  test('refuses what is missing, a second property of one key, and a second model', () => {
    const fp = parseKicadFootprint(LIBRARY)
    expect(createItem(fp, 'arc', { layer: 'F.Fab', start: { x: 0, y: 0 } })).toMatchObject({
      ok: false,
      detail: 'A new arc needs mid, end.'
    })
    expect(createItem(fp, 'property', { key: 'Value', value: 'X', layer: 'F.Fab' })).toMatchObject({
      ok: false,
      error: 'refused'
    })
    expect(createItem(fp, 'model', { path: 'x.step' })).toMatchObject({
      ok: false,
      error: 'refused'
    })
    expect(
      createItem(fp, 'property', { key: 'MPN', value: 'X1', layer: 'F.Fab', hidden: true })
    ).toEqual({ ok: true, id: 'property:MPN' })
    expect(reparse(fp).properties.find((p) => p.key === 'MPN')).toMatchObject({ hide: true })
  })

  test('deletes items and the model, and keeps Reference and Value', () => {
    const fp = parseKicadFootprint(LIBRARY)
    const items = footprintItems(fp)
    const pick = (id: string): ReturnType<typeof footprintItems>[number] =>
      items.find((item) => item.id === id)!
    expect(deleteItems(fp, [pick('property:Reference')])).toMatchObject({ ok: false })
    expect(deleteItems(fp, [pick('line@-1,-1'), pick('model')])).toEqual({ ok: true })
    const after = reparse(fp)
    expect(after.fpLines).toHaveLength(1)
    expect(after.model).toBeUndefined()
  })
})

describe('the footprint door', () => {
  const FILE = '/proj/proj.pretty/T.kicad_mod'

  const door = (
    scope = 'project'
  ): {
    dispatch: ReturnType<typeof createFootprintAgent>['dispatch']
    session: ReturnType<typeof createTextSession<KicadFootprint, unknown>>
    labels: string[]
  } => {
    const document = new DocumentStore(async () => null).open(FILE, LIBRARY)
    const labels: string[] = []
    const session = createTextSession<KicadFootprint, unknown>({
      document,
      parse: parseKicadFootprint,
      serialize: serializeKicadFootprint,
      commit: () => {},
      readOnly: () => false
    })
    const ctx: FootprintAgentContext = {
      // R1 on the board is the same footprint, reached as the board's copy.
      resolve: async ({ footprint, board }) =>
        board
          ? footprint === 'R1'
            ? { ok: true, file: FILE, scope: 'board', board }
            : { ok: false, error: 'reference-not-found', detail: footprint, candidates: ['R1'] }
          : footprint === 'proj:T'
            ? { ok: true, file: FILE, scope }
            : { ok: false, error: 'unknown-footprint', detail: footprint, candidates: ['proj:T'] },
      read: async () => document.text(),
      session: async () => session,
      label: (key) => {
        labels.push(key)
        return key
      },
      // No model file on a test machine; the status is the answer, not a failure.
      modelFacts: async () => ({
        status: 'not-installed' as const,
        resolved: null,
        bounds: null,
        fit: null,
        triangles: 0,
        meshes: 0
      })
    }
    return { dispatch: createFootprintAgent(ctx).dispatch, session, labels }
  }

  test('knows its kinds', () => {
    expect(isFootprintRequest({ kind: 'check-footprint', footprint: 'a:b' })).toBe(true)
    expect(isFootprintRequest({ kind: 'get-items', ids: ['R1'] })).toBe(false)
  })

  test('reads items and answers a miss with candidates', async () => {
    const { dispatch } = door()
    expect(
      await dispatch({ kind: 'get-footprint-items', footprint: 'proj:T', ids: ['pad:1'] })
    ).toMatchObject({ items: [{ id: 'pad:1', number: '1' }] })
    expect(
      await dispatch({ kind: 'get-footprint-items', footprint: 'proj:X', ids: ['pad:1'] })
    ).toEqual({ error: 'unknown-footprint', detail: 'proj:X', candidates: ['proj:T'] })
  })

  test('an update is one undo step with a check delta', async () => {
    const { dispatch, session, labels } = door()
    const answer = (await dispatch({
      kind: 'update-footprint-item',
      footprint: 'proj:T',
      id: 'pad:2',
      record: { at: { x: -0.4, y: 0 } },
      checks: true
    })) as Record<string, unknown>
    expect(answer.changed).toEqual({ created: [], updated: ['pad:2'], deleted: [] })
    expect(answer.checks).toEqual({
      new: [{ code: 'pads-overlap', severity: 'error', items: ['pad:1', 'pad:2'] }],
      resolved: []
    })
    expect(labels).toEqual(['commandLabels.editFootprintItem'])
    expect(session.canUndo()).toBe(true)
    expect(session.model()?.pads[1].position.x).toBe(mmToNm(-0.4))
  })

  test('an undo takes back the step and names it; a standard footprint has none', async () => {
    const { dispatch, session } = door()
    await dispatch({
      kind: 'update-footprint-item',
      footprint: 'proj:T',
      id: 'pad:2',
      record: { at: { x: -0.4, y: 0 } }
    })
    expect(await dispatch({ kind: 'undo-footprint', footprint: 'proj:T', steps: 1 })).toMatchObject(
      {
        footprint: 'proj:T',
        undone: ['commandLabels.editFootprintItem'],
        changed: { created: [], updated: ['pad:2'], deleted: [] },
        next: { undo: null, redo: 'commandLabels.editFootprintItem' }
      }
    )
    expect(session.model()?.pads[1].position.x).toBe(mmToNm(0.5))
    expect(
      await door('system').dispatch({ kind: 'undo-footprint', footprint: 'proj:T', steps: 1 })
    ).toMatchObject({ error: 'library-read-only' })
  })

  test('a refused edit writes nothing, and a standard footprint is read-only', async () => {
    const { dispatch, session } = door()
    expect(
      await dispatch({
        kind: 'update-footprint-item',
        footprint: 'proj:T',
        id: 'pad:1',
        record: { width: 1 }
      })
    ).toMatchObject({ error: 'not-applicable' })
    expect(session.canUndo()).toBe(false)
    const standard = door('system')
    expect(
      await standard.dispatch({
        kind: 'delete-footprint-items',
        footprint: 'proj:T',
        ids: ['model']
      })
    ).toMatchObject({ error: 'library-read-only' })
  })

  test("a placed footprint's board copy is written whatever its library's tier", async () => {
    const { dispatch, session } = door('system')
    const answer = (await dispatch({
      kind: 'update-footprint-item',
      footprint: 'R1',
      board: '/proj/proj.kicad_pcb',
      id: 'pad:2',
      record: { at: { x: 0.6, y: 0 } }
    })) as Record<string, unknown>
    expect(answer).toMatchObject({
      footprint: 'R1',
      board: '/proj/proj.kicad_pcb',
      tier: 'board',
      changed: { created: [], updated: ['pad:2'], deleted: [] }
    })
    expect(String(answer.guidance)).toContain("board's own copy")
    expect(session.canUndo()).toBe(true)
  })

  test('check narrows by code, and a code no footprint rule has is refused', async () => {
    const { dispatch } = door()
    const narrowed = (await dispatch({
      kind: 'check-footprint',
      footprint: 'proj:T',
      codes: ['pads-overlap']
    })) as Record<string, unknown>
    // A clean code still answers its row, at count 0.
    expect(narrowed).toMatchObject({
      footprint: 'proj:T',
      codes: ['pads-overlap'],
      ok: true,
      checks: [{ code: 'pads-overlap', count: 0, items: [], rule: expect.any(String) }]
    })
    expect(
      await dispatch({ kind: 'check-footprint', footprint: 'proj:T', codes: ['pad-overlap'] })
    ).toMatchObject({
      error: 'unknown-check-code',
      candidates: expect.arrayContaining(['pads-overlap'])
    })
  })

  test('a batch is atomic, reads see earlier edits, and dryRun writes nothing', async () => {
    const { dispatch, session } = door()
    const ops = [
      {
        kind: 'create-footprint-item' as const,
        footprint: 'proj:T',
        itemKind: 'line' as const,
        record: { layer: 'F.Fab', start: { x: 0, y: 0 }, end: { x: 1, y: 0 } }
      },
      {
        kind: 'query-footprint-items' as const,
        footprint: 'proj:T',
        layer: 'F.Fab'
      }
    ]
    const dry = (await dispatch({
      kind: 'batch-footprint',
      footprint: 'proj:T',
      ops,
      dryRun: true
    })) as { results: Array<{ items?: unknown[] }>; dryRun: boolean }
    expect(dry.dryRun).toBe(true)
    // The Value property, the fab text, and the new line.
    expect(dry.results[1].items).toHaveLength(3)
    expect(session.canUndo()).toBe(false)

    const failed = await dispatch({
      kind: 'batch-footprint',
      footprint: 'proj:T',
      ops: [ops[0], { kind: 'delete-footprint-items', footprint: 'proj:T', ids: ['nope'] }]
    })
    expect(failed).toMatchObject({ error: 'item-not-found' })
    expect((failed as { detail: string }).detail).toMatch(
      /^Operation 1 \(`items\.delete`\): .*Nothing was written\.$/
    )
    expect(session.canUndo()).toBe(false)

    await dispatch({ kind: 'batch-footprint', footprint: 'proj:T', ops })
    expect(session.model()?.fpLines).toHaveLength(3)
    session.undo()
    expect(session.model()?.fpLines).toHaveLength(2)
  })

  test('check groups the footprint rules', async () => {
    const { dispatch } = door()
    const answer = (await dispatch({ kind: 'check-footprint', footprint: 'proj:T' })) as {
      ok: boolean
      checks: Array<{ code: string; items: string[] }>
    }
    // A warning, as in KiCad: the footprint is still ok.
    expect(answer.ok).toBe(true)
    expect(answer.checks.map((row) => row.code)).toEqual(['silk-clipped-by-mask'])
    expect(answer).toMatchObject({ counts: { error: 0, warning: 1 } })
  })

  test('a capped query says so and counts every match', async () => {
    const { dispatch } = door()
    const answer = (await dispatch({
      kind: 'query-footprint-items',
      footprint: 'proj:T',
      limit: 1
    })) as Record<string, unknown>
    expect(answer.truncated).toBe(true)
    expect(answer.count).toBeGreaterThan(1)
    expect((answer.items as unknown[]).length).toBe(1)
    expect(String(answer.guidance)).toMatch(/By kind: .*read on with offset 1\./)
  })
})

describe("a footprint's zones", () => {
  /** A module with an antenna keep-out, as KiCad 10 writes a rule area in a library footprint. */
  const KEEPOUT = `(footprint "ANT"
  (version 20260206)
  (generator "pcbnew")
  (layer "F.Cu")
  (property "Reference" "REF**" (at 0 -6 0) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15))))
  (property "Value" "ANT" (at 0 6 0) (layer "F.Fab") (effects (font (size 1 1) (thickness 0.15))))
  (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu" "F.Paste" "F.Mask"))
  (zone (net 0) (net_name "") (layers "*.Cu") (name "antenna") (hatch edge 0.5)
    (connect_pads (clearance 0)) (min_thickness 0.25)
    (keepout (tracks not_allowed) (vias not_allowed) (pads allowed) (copperpour not_allowed) (footprints allowed))
    (fill (thermal_gap 0.5) (thermal_bridge_width 0.5))
    (polygon (pts (xy -3 -4) (xy 3 -4) (xy 3 -2) (xy -3 -2))))
)
`

  test('read as the board reads a rule area: layers, keepout, rules, outline and box', () => {
    const zones = footprintItems(parseKicadFootprint(KEEPOUT)).filter((i) => i.kind === 'zone')
    expect(zones.map(itemRow)).toEqual([
      {
        id: 'zone@-3,-4',
        kind: 'zone',
        layers: ['*.Cu'],
        name: 'antenna',
        keepout: true,
        points: [
          { x: -3, y: -4 },
          { x: 3, y: -4 },
          { x: 3, y: -2 },
          { x: -3, y: -2 }
        ],
        priority: 0,
        rules: {
          tracks: 'not_allowed',
          vias: 'not_allowed',
          pads: 'allowed',
          copperpour: 'not_allowed',
          footprints: 'allowed'
        },
        minThickness: 0.25,
        hatchStyle: 'edge',
        hatchPitch: 0.5,
        box: { x: -3, y: -4, width: 6, height: 2 }
      }
    ])
  })

  test('a query finds them by kind and by a copper layer their wildcard covers', () => {
    const items = footprintItems(parseKicadFootprint(KEEPOUT))
    expect(queryItems(items, { kind: 'zone' }).rows.map((i) => i.id)).toEqual(['zone@-3,-4'])
    expect(queryItems(items, { kind: 'zone', layer: 'B.Cu' }).rows).toHaveLength(1)
    expect(queryItems(items, { kind: 'zone', layer: 'F.SilkS' }).rows).toHaveLength(0)
  })

  test('update writes rules, layers, outline and hatch as the board writes a zone', () => {
    const fp = parseKicadFootprint(KEEPOUT)
    expect(
      updateItem(fp, find(fp, 'zone@-3,-4'), {
        layers: ['F.Cu'],
        rules: { footprints: 'not_allowed' },
        minThickness: 0.2,
        hatchStyle: 'full',
        points: [
          { x: -2, y: -4 },
          { x: 2, y: -4 },
          { x: 2, y: -2 }
        ]
      })
    ).toEqual({ ok: true })
    const zone = itemRow(find(reparse(fp), 'zone@-2,-4'))
    expect(zone).toMatchObject({
      layers: ['F.Cu'],
      keepout: true,
      rules: { footprints: 'not_allowed', tracks: 'not_allowed' },
      minThickness: 0.2,
      hatchStyle: 'full',
      points: [
        { x: -2, y: -4 },
        { x: 2, y: -4 },
        { x: 2, y: -2 }
      ]
    })
  })

  test('refuses pour settings on a rule area, a non-copper layer, and a net', () => {
    const fp = parseKicadFootprint(KEEPOUT)
    const zone = find(fp, 'zone@-3,-4')
    expect(updateItem(fp, zone, { thermalGap: 0.3 })).toMatchObject({ error: 'not-applicable' })
    expect(updateItem(fp, zone, { layers: ['F.SilkS'] })).toMatchObject({
      error: 'invalid-record'
    })
    expect(updateItem(fp, zone, { net: 'GND' })).toMatchObject({ error: 'not-applicable' })
    expect(serializeKicadFootprint(fp)).toBe(serializeKicadFootprint(parseKicadFootprint(KEEPOUT)))
  })

  test('create makes a rule area on no net, and delete removes it', () => {
    const fp = parseKicadFootprint(LIBRARY)
    const made = createItem(fp, 'zone', {
      points: [
        { x: -1, y: -1 },
        { x: 1, y: -1 },
        { x: 1, y: 1 }
      ],
      layers: ['F.Cu', 'B.Cu'],
      keepout: true,
      rules: { vias: 'allowed' },
      name: 'keepout'
    })
    if (!made.ok) throw new Error(made.detail)
    const text = serializeKicadFootprint(fp)
    expect(text).not.toContain('(net ')
    const after = reparse(fp)
    expect(itemRow(find(after, made.id))).toMatchObject({
      kind: 'zone',
      layers: ['F.Cu', 'B.Cu'],
      name: 'keepout',
      keepout: true,
      rules: { vias: 'allowed', tracks: 'not_allowed' }
    })
    expect(deleteItems(after, [find(after, made.id)])).toEqual({ ok: true })
    expect(reparse(after).zones).toHaveLength(0)
    expect(
      createItem(fp, 'zone', {
        points: [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 1, y: 1 }
        ],
        layers: ['F.Cu'],
        keepout: true,
        padConnection: 'solid'
      })
    ).toMatchObject({ ok: false, error: 'not-applicable' })
  })

  test("a placed footprint's zone reads in the library frame, its uuid its id", () => {
    // Board-absolute in the board file: the part at (50, 30), turned 90°.
    const board = parseKicadBoard(`(kicad_pcb (version 20240108) (generator "pcbnew")
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal))
  (net 0 "")
  (footprint "Lib:ANT" (layer "F.Cu") (uuid "fp1") (at 50 30 90)
    (property "Reference" "U3" (at 0 0 90) (layer "F.SilkS") (uuid "r1"))
    (pad "1" smd rect (at 0 0 90) (size 1 1) (layers "F.Cu"))
    (zone (net 0) (net_name "") (layers "F.Cu") (uuid "kz") (hatch edge 0.5)
      (keepout (tracks not_allowed) (vias not_allowed) (pads allowed) (copperpour not_allowed) (footprints allowed))
      (polygon (pts (xy 46 27) (xy 48 27) (xy 48 33) (xy 46 33)))))
)`)
    const copy = projectFootprintCopy(board, 'fp1')
    if (!copy) throw new Error('no copy')
    const [zone] = footprintItems(parseKicadFootprint(copy)).filter((i) => i.kind === 'zone')
    expect(zone.id).toBe('kz')
    expect(itemRow(zone).box).toEqual({ x: -3, y: -4, width: 6, height: 2 })
  })
})

describe('the footprint record', () => {
  test('reads Footprint Properties, every override null while it inherits', () => {
    expect(itemRow(find(parseKicadFootprint(LIBRARY), 'footprint'))).toEqual({
      id: 'footprint',
      kind: 'footprint',
      name: 'T',
      description: '',
      keywords: '',
      locked: false,
      attributes: {
        type: 'smd',
        boardOnly: false,
        excludeFromPositionFiles: false,
        excludeFromBom: false,
        allowMissingCourtyard: false,
        dnp: false
      },
      overrides: {
        clearance: null,
        solderMaskMargin: null,
        solderPasteMargin: null,
        solderPasteRatio: null,
        zoneConnect: null,
        allowSolderMaskBridges: false
      }
    })
  })

  test('writes name, text, attributes and overrides, and null inherits again', () => {
    const fp = parseKicadFootprint(LIBRARY)
    expect(
      updateItem(fp, find(fp, 'footprint'), {
        name: 'T2',
        keywords: 'chip resistor',
        locked: true,
        attributes: { type: 'through_hole', excludeFromBom: true, dnp: true },
        overrides: { clearance: 0.2, solderPasteRatio: -0.1, zoneConnect: 'solid' }
      })
    ).toEqual({ ok: true })
    const after = reparse(fp)
    expect(after.attributes).toEqual(['through_hole', 'exclude_from_bom', 'dnp'])
    expect(itemRow(find(after, 'footprint'))).toMatchObject({
      name: 'T2',
      keywords: 'chip resistor',
      locked: true,
      attributes: { type: 'through_hole', excludeFromBom: true, dnp: true },
      overrides: { clearance: 0.2, solderPasteRatio: -0.1, zoneConnect: 'solid' }
    })
    updateItem(after, find(after, 'footprint'), {
      attributes: { type: 'unspecified' },
      overrides: { clearance: null, zoneConnect: null, allowSolderMaskBridges: true }
    })
    const cleared = reparse(after)
    expect(cleared.clearance).toBeUndefined()
    expect(cleared.zoneConnect).toBeUndefined()
    expect(cleared.attributes).toEqual(['exclude_from_bom', 'dnp', 'allow_soldermask_bridges'])
  })

  test('refuses an unknown attribute, a bad override, a create and a delete', () => {
    const fp = parseKicadFootprint(LIBRARY)
    const self = find(fp, 'footprint')
    expect(updateItem(fp, self, { attributes: { virtual: true } })).toMatchObject({
      error: 'not-applicable'
    })
    expect(updateItem(fp, self, { overrides: { zoneConnect: 'thick' } })).toMatchObject({
      error: 'invalid-record'
    })
    expect(createItem(fp, 'footprint', {})).toMatchObject({ error: 'refused' })
    expect(deleteItems(fp, [self])).toMatchObject({ error: 'refused' })
  })
})

describe('pad overrides and kinds', () => {
  test('clearance and margins write, read back, and null removes them', () => {
    const fp = parseKicadFootprint(LIBRARY)
    updateItem(fp, find(fp, 'pad:1'), {
      clearance: 0.1,
      solderMaskMargin: 0.05,
      solderPasteMargin: -0.02,
      pasteRatio: -0.1
    })
    const after = reparse(fp)
    expect(find(after, 'pad:1').record).toMatchObject({
      clearance: 0.1,
      solderMaskMargin: 0.05,
      solderPasteMargin: -0.02,
      pasteRatio: -0.1
    })
    updateItem(after, find(after, 'pad:1'), { clearance: null, pasteRatio: null })
    const record = find(reparse(after), 'pad:1').record
    expect(record).not.toHaveProperty('clearance')
    expect(record).not.toHaveProperty('pasteRatio')
    expect(record).toMatchObject({ solderMaskMargin: 0.05 })
  })

  test('a connector pad takes copper and mask; a trapezoid its delta; custom stays refused', () => {
    const fp = parseKicadFootprint(LIBRARY)
    const made = createItem(fp, 'pad', {
      number: '9',
      type: 'connect',
      shape: 'trapezoid',
      at: { x: 2, y: 0 },
      size: { width: 1, height: 1 },
      rectDelta: { x: 0.2, y: 0 }
    })
    if (!made.ok) throw new Error(made.detail)
    expect(find(reparse(fp), made.id).record).toMatchObject({
      type: 'connect',
      shape: 'trapezoid',
      layers: ['F.Cu', 'F.Mask'],
      rectDelta: { x: 0.2, y: 0 }
    })
    expect(updateItem(fp, find(fp, 'pad:1'), { shape: 'custom' })).toMatchObject({
      error: 'invalid-record'
    })
  })
})

describe('strokes, corners and text formatting', () => {
  test('a line takes a stroke style and color, and null restores the default color', () => {
    const fp = parseKicadFootprint(LIBRARY)
    updateItem(fp, find(fp, 'line@-1,-1'), { strokeType: 'dash', strokeColor: '#FF000080' })
    const after = reparse(fp)
    expect(find(after, 'line@-1,-1').record).toMatchObject({
      strokeType: 'dash',
      strokeColor: '#ff000080'
    })
    updateItem(after, find(after, 'line@-1,-1'), { strokeColor: null })
    expect(find(reparse(after), 'line@-1,-1').record).not.toHaveProperty('strokeColor')
    expect(updateItem(fp, find(fp, 'line@-1,-1'), { strokeColor: 'red' })).toMatchObject({
      error: 'invalid-record'
    })
  })

  test('a rect rounds its corners, and 0 squares them', () => {
    const fp = parseKicadFootprint(LIBRARY)
    updateItem(fp, find(fp, 'rect@-1.5,-1.5'), { radius: 0.3 })
    const after = reparse(fp)
    expect(find(after, 'rect@-1.5,-1.5').record).toMatchObject({ radius: 0.3 })
    updateItem(after, find(after, 'rect@-1.5,-1.5'), { radius: 0 })
    expect(find(reparse(after), 'rect@-1.5,-1.5').record).not.toHaveProperty('radius')
  })

  test('a text takes bold, justification, a width-and-height size and keep-upright', () => {
    const fp = parseKicadFootprint(LIBRARY)
    updateItem(fp, find(fp, 'text@0,0'), {
      bold: true,
      italic: true,
      justify: 'left',
      verticalJustify: 'bottom',
      size: { width: 0.6, height: 0.8 },
      knockout: true,
      keepUpright: false
    })
    expect(find(reparse(fp), 'text@0,0').record).toMatchObject({
      bold: true,
      italic: true,
      justify: 'left',
      verticalJustify: 'bottom',
      size: { width: 0.6, height: 0.8 },
      thickness: 0.08,
      knockout: true,
      keepUpright: false
    })
    const made = createItem(fp, 'text', {
      text: 'X',
      at: { x: 0, y: 3 },
      layer: 'F.Fab',
      size: 0.5,
      mirror: true
    })
    if (!made.ok) throw new Error(made.detail)
    expect(find(reparse(fp), made.id).record).toMatchObject({ size: 0.5, mirror: true })
  })
})

describe('text boxes, Béziers, points and tables', () => {
  test('a text box, a Bézier and a point are created, updated and deleted', () => {
    const fp = parseKicadFootprint(LIBRARY)
    const box = createItem(fp, 'text_box', {
      text: 'Note',
      start: { x: -2, y: 3 },
      end: { x: 2, y: 4 },
      layer: 'F.Fab',
      justify: 'center'
    })
    const curve = createItem(fp, 'bezier', {
      layer: 'F.Fab',
      points: [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
        { x: 2, y: 1 },
        { x: 3, y: 0 }
      ],
      strokeType: 'dot'
    })
    const point = createItem(fp, 'point', { at: { x: 1, y: 1 }, layer: 'F.Fab' })
    if (!box.ok || !curve.ok || !point.ok) throw new Error('not created')
    let after = reparse(fp)
    expect(find(after, box.id).record).toMatchObject({
      text: 'Note',
      start: { x: -2, y: 3 },
      end: { x: 2, y: 4 },
      layer: 'F.Fab',
      verticalJustify: 'top',
      border: true
    })
    expect(find(after, box.id).record).not.toHaveProperty('justify')
    expect(find(after, curve.id).record).toMatchObject({ strokeType: 'dot', width: 0.1 })
    expect(find(after, point.id).record).toEqual({ at: { x: 1, y: 1 }, size: 1, layer: 'F.Fab' })
    updateItem(after, find(after, box.id), {
      text: 'Changed',
      border: false,
      margins: { left: 0.1, top: 0.1, right: 0.1, bottom: 0.1 }
    })
    updateItem(after, find(after, point.id), { size: 0.5 })
    expect(updateItem(after, find(after, curve.id), { points: [{ x: 0, y: 0 }] })).toMatchObject({
      error: 'invalid-record'
    })
    after = reparse(after)
    expect(find(after, box.id).record).toMatchObject({
      text: 'Changed',
      border: false,
      margins: { left: 0.1, top: 0.1, right: 0.1, bottom: 0.1 }
    })
    expect(find(after, point.id).record).toMatchObject({ size: 0.5 })
    // A side not named keeps its margin.
    updateItem(after, find(after, box.id), { margins: { left: 0.4 } })
    after = reparse(after)
    expect(find(after, box.id).record).toMatchObject({
      margins: { left: 0.4, top: 0.1, right: 0.1, bottom: 0.1 }
    })
    expect(
      deleteItems(after, [find(after, box.id), find(after, curve.id), find(after, point.id)])
    ).toEqual({ ok: true })
    const gone = reparse(after)
    expect([gone.fpTextBoxes, gone.fpCurves, gone.points].map((list) => list.length)).toEqual([
      0, 0, 0
    ])
  })

  test('a table reads its grid and writes its borders; it is not created here', () => {
    const fp = parseKicadFootprint(
      LIBRARY.replace(
        /\)\n$/,
        `  (table (column_count 2) (layer "F.Fab") (uuid "tb")
    (border (external yes) (header yes) (stroke (width 0.1) (type solid)))
    (separators (rows yes) (cols yes) (stroke (width 0.1) (type solid)))
    (column_widths 2 3) (row_heights 1)
    (cells
      (table_cell "A" (start 0 0) (end 2 1) (layer "F.Fab") (effects (font (size 1 1) (thickness 0.15))))
      (table_cell "B" (start 2 0) (end 5 1) (layer "F.Fab") (effects (font (size 1 1) (thickness 0.15))))))
)
`
      )
    )
    const table = find(fp, 'tb')
    expect(itemRow(table)).toMatchObject({
      kind: 'table',
      columns: 2,
      rows: 1,
      columnWidths: [2, 3],
      cells: ['A', 'B'],
      borderExternal: true,
      box: { x: 0, y: 0, width: 5, height: 1 }
    })
    expect(updateItem(fp, table, { separatorCols: false, borderWidth: 0.2 })).toEqual({ ok: true })
    expect(find(reparse(fp), 'tb').record).toMatchObject({ separatorCols: false, borderWidth: 0.2 })
    expect(updateItem(fp, table, { cells: ['C', 'D'] })).toMatchObject({ error: 'not-applicable' })
    expect(createItem(fp, 'table', { layer: 'F.Fab' })).toMatchObject({ error: 'refused' })
  })
})
