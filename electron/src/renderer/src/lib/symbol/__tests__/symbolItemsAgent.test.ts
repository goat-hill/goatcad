import { describe, expect, test } from 'vitest'
import {
  parseKicadSymbolLibrary,
  serializeKicadSymbolLibrary,
  type KicadSymbolLibrary
} from '../../kicad/symbolLibrary'
import { mmToNm, spacingToMm } from '../../kicad/coordinates'
import { DocumentStore } from '../../document/documentStore'
import { createTextSession } from '../../document/textSession'
import {
  createSymbolItemsAgent,
  isSymbolItemsRequest,
  type SymbolResolution
} from '../symbolItemsAgent'

const FILE = '/proj/proj.kicad_sym'

/** A two-pin part in the project library. */
const LIBRARY = `(kicad_symbol_lib
	(version 20251024)
	(generator "kicad_symbol_editor")
	(symbol "Part"
		(in_bom yes)
		(on_board yes)
		(property "Reference" "U"
			(at 0 5.08 0)
			(effects
				(font
					(size 1.27 1.27)
				)
			)
		)
		(property "Value" "Part"
			(at 0 -5.08 0)
			(effects
				(font
					(size 1.27 1.27)
				)
			)
		)
		(property "Footprint" ""
			(at 0 0 0)
			(hide yes)
			(effects
				(font
					(size 1.27 1.27)
				)
			)
		)
		(property "Datasheet" ""
			(at 0 0 0)
			(hide yes)
			(effects
				(font
					(size 1.27 1.27)
				)
			)
		)
		(property "Description" ""
			(at 0 0 0)
			(hide yes)
			(effects
				(font
					(size 1.27 1.27)
				)
			)
		)
		(symbol "Part_0_1"
			(rectangle
				(start -2.54 2.54)
				(end 2.54 -2.54)
				(stroke
					(width 0.254)
					(type default)
				)
				(fill
					(type background)
				)
			)
		)
		(symbol "Part_1_1"
			(pin input line
				(at -5.08 0 0)
				(length 2.54)
				(name "IN"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
				(number "1"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
			)
			(pin output line
				(at 5.08 0 180)
				(length 2.54)
				(name "OUT"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
				(number "2"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
			)
		)
	)
)
`

const door = (
  resolution: SymbolResolution = {
    ok: true,
    name: 'Part',
    scope: 'project',
    writable: true,
    file: FILE
  }
): {
  dispatch: ReturnType<typeof createSymbolItemsAgent>['dispatch']
  session: ReturnType<typeof createTextSession<KicadSymbolLibrary, unknown>>
  labels: string[]
} => {
  const document = new DocumentStore(async () => null).open(FILE, LIBRARY)
  const labels: string[] = []
  const session = createTextSession<KicadSymbolLibrary, unknown>({
    document,
    parse: parseKicadSymbolLibrary,
    serialize: serializeKicadSymbolLibrary,
    commit: () => {},
    readOnly: () => false
  })
  const agent = createSymbolItemsAgent({
    resolve: async ({ symbol }) =>
      symbol === 'proj:Part' || symbol === 'U1'
        ? resolution
        : { ok: false, error: 'unknown-symbol', detail: symbol },
    read: async () => document.text(),
    session: async () => session,
    label: (key) => {
      labels.push(key)
      return key
    },
    checkGrid: async () => mmToNm(spacingToMm(50, 'mil'))
  })
  return { dispatch: agent.dispatch, session, labels }
}

describe('the symbol item door', () => {
  test('knows its kinds', () => {
    expect(isSymbolItemsRequest({ kind: 'get-symbol-items', symbol: 'a:b', ids: [] })).toBe(true)
    expect(isSymbolItemsRequest({ kind: 'get-footprint-items', footprint: 'a:b', ids: [] })).toBe(
      false
    )
  })

  test('reads pins in the symbol frame, y down, and answers a miss with candidates', async () => {
    const { dispatch } = door()
    const answer = (await dispatch({
      kind: 'get-symbol-items',
      symbol: 'proj:Part',
      ids: ['pin:1']
    })) as { items: Array<Record<string, unknown>> }
    expect(answer.items[0]).toMatchObject({
      id: 'pin:1',
      name: 'IN',
      type: 'input',
      at: { x: -5.08 }
    })
    expect(
      await dispatch({ kind: 'get-symbol-items', symbol: 'proj:Part', ids: ['pin:9'] })
    ).toMatchObject({ error: 'item-not-found' })
  })

  test('an update is one undo step on the library, with a check delta when asked', async () => {
    const { dispatch, session, labels } = door()
    const answer = (await dispatch({
      kind: 'update-symbol-item',
      symbol: 'proj:Part',
      id: 'pin:2',
      record: { type: 'power_out' },
      checks: true
    })) as Record<string, unknown>
    expect(answer.changed).toEqual({ created: [], updated: ['pin:2'], deleted: [] })
    expect(answer).toHaveProperty('checks')
    expect(labels).toEqual(['commandLabels.editSymbolItem'])
    expect(session.canUndo()).toBe(true)
    expect(serializeKicadSymbolLibrary(session.model()!)).toContain('(pin power_out line')
  })

  test('an undo takes back the library step and names it; a redo puts it back', async () => {
    const { dispatch, session } = door()
    await dispatch({
      kind: 'update-symbol-item',
      symbol: 'proj:Part',
      id: 'pin:2',
      record: { type: 'power_out' }
    })
    const undone = (await dispatch({
      kind: 'undo-symbol',
      symbol: 'proj:Part',
      steps: 1
    })) as Record<string, unknown>
    expect(undone).toMatchObject({
      symbol: 'proj:Part',
      undone: ['commandLabels.editSymbolItem'],
      changed: { created: [], updated: ['pin:2'], deleted: [] },
      next: { undo: null, redo: 'commandLabels.editSymbolItem' }
    })
    expect(serializeKicadSymbolLibrary(session.model()!)).not.toContain('(pin power_out line')
    expect(
      await dispatch({ kind: 'undo-symbol', symbol: 'proj:Part', steps: 2, redo: true })
    ).toMatchObject({ error: 'nothing-to-redo' })
    await dispatch({ kind: 'undo-symbol', symbol: 'proj:Part', steps: 1, redo: true })
    expect(serializeKicadSymbolLibrary(session.model()!)).toContain('(pin power_out line')
  })

  test("a sheet's copy answers with its sheet; a read-only tier refuses writes", async () => {
    const copy = door({
      ok: true,
      name: 'Part',
      scope: 'sheet',
      writable: true,
      file: FILE,
      sheet: '/proj/proj.kicad_sch'
    })
    const answer = (await copy.dispatch({
      kind: 'create-symbol-item',
      symbol: 'U1',
      itemKind: 'field',
      record: { key: 'MPN', value: 'X1' }
    })) as Record<string, unknown>
    expect(answer).toMatchObject({ symbol: 'U1', sheet: '/proj/proj.kicad_sch', tier: 'sheet' })
    expect(String(answer.guidance)).toContain("sheet's tab")

    const standard = door({
      ok: true,
      name: 'Part',
      scope: 'standard',
      writable: false,
      text: LIBRARY
    })
    expect(
      await standard.dispatch({ kind: 'delete-symbol-items', symbol: 'proj:Part', ids: ['pin:1'] })
    ).toMatchObject({ error: 'library-read-only' })
    expect(standard.session.canUndo()).toBe(false)
  })

  test('a batch is atomic: a failing entry writes nothing and names its index', async () => {
    const { dispatch, session } = door()
    const failed = (await dispatch({
      kind: 'batch-symbol',
      symbol: 'proj:Part',
      ops: [
        { kind: 'update-symbol-item', symbol: 'proj:Part', id: 'pin:1', record: { name: 'EN' } },
        { kind: 'delete-symbol-items', symbol: 'proj:Part', ids: ['field:Value'] }
      ]
    })) as Record<string, unknown>
    expect(failed.error).toBe('refused')
    expect(String(failed.detail)).toContain('Operation 1 (`items.delete`)')
    expect(session.canUndo()).toBe(false)

    const done = (await dispatch({
      kind: 'batch-symbol',
      symbol: 'proj:Part',
      ops: [
        { kind: 'update-symbol-item', symbol: 'proj:Part', id: 'pin:1', record: { name: 'EN' } },
        { kind: 'get-symbol-items', symbol: 'proj:Part', ids: ['pin:1'] }
      ]
    })) as { results: Array<{ items?: Array<Record<string, unknown>> }> }
    expect(done.results[1].items?.[0].name).toBe('EN')
    expect(session.canUndo()).toBe(true)
  })

  test('a rename answers the new id; a sheet copy keeps its name', async () => {
    const { dispatch, session } = door()
    const answer = (await dispatch({
      kind: 'update-symbol-item',
      symbol: 'proj:Part',
      id: 'symbol',
      record: { name: 'Part2' }
    })) as Record<string, unknown>
    expect(answer).toMatchObject({
      libId: 'proj:Part2',
      changed: { created: [], updated: ['symbol'], deleted: [] }
    })
    expect(session.model()!.names).toEqual(['Part2'])

    const copy = door({
      ok: true,
      name: 'Part',
      scope: 'sheet',
      writable: true,
      file: FILE,
      sheet: '/proj/proj.kicad_sch'
    })
    expect(
      await copy.dispatch({
        kind: 'update-symbol-item',
        symbol: 'U1',
        id: 'symbol',
        record: { name: 'Other' }
      })
    ).toMatchObject({ error: 'refused' })
  })
})
