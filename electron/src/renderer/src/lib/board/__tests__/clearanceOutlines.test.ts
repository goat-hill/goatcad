import { beforeAll, describe, expect, test, vi } from 'vitest'
import { parseKicadBoard } from '../../kicad/board'
import { DEFAULT_DESIGN_RULES, DEFAULT_NET_CLASSES } from '../../kicad/project'
import { loadClipper } from '../../geometry/clip'
import { BoardSpatialIndex, type CopperItem } from '../spatialIndex'
import { boardRules } from '../rules/boardRules'
import {
  MergeCache,
  clearanceOutlines,
  inflatedOutline,
  ownClearanceMemo,
  previewClearanceRings,
  type ClearanceOutline,
  type ClearanceQuery
} from '../clearanceOutlines'

const BOARD = `(kicad_pcb (version 20241229) (generator "test")
  (general (thickness 1.6))
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user))
  (setup (pad_to_mask_clearance 0))
  (net 0 "") (net 1 "A") (net 2 "B")
  (footprint "T:SMD" (layer "F.Cu") (at 0 0)
    (pad "1" smd rect (at 0 0) (size 1 2) (layers "F.Cu") (net 1 "A"))
    (pad "2" smd rect (at 3 0) (size 1 2) (layers "F.Cu") (net 2 "B") (clearance 0.5)))
  (footprint "T:THT" (layer "F.Cu") (at 10 0)
    (pad "1" thru_hole circle (at 0 0) (size 1.6 1.6) (drill 0.8) (layers "*.Cu") (net 1 "A")))
  (segment (start 0 5) (end 5 5) (width 0.25) (layer "B.Cu") (net 2))
)`

const setup = (): {
  index: BoardSpatialIndex
  clearanceOf: (item: CopperItem, layer: string) => number
} => {
  const board = parseKicadBoard(BOARD)
  const index = BoardSpatialIndex.build(board)
  const rules = boardRules(board, {
    rules: { ...DEFAULT_DESIGN_RULES },
    classes: DEFAULT_NET_CLASSES.map((cls) => ({ ...cls })),
    patterns: [],
    assignments: []
  })
  return { index, clearanceOf: ownClearanceMemo()(rules) }
}

const pad = (items: readonly CopperItem[], footprint: number, padIndex: number): CopperItem =>
  items.find((i) => i.ref.type === 'pad' && i.ref.index === footprint && i.ref.pad === padIndex)!

beforeAll(async () => {
  await loadClipper()
})

describe('ownClearance', () => {
  test("a pad's is its net class's, unless it sets its own", () => {
    const { index, clearanceOf } = setup()
    const classClearance = DEFAULT_NET_CLASSES[0].clearance
    expect(clearanceOf(pad(index.items, 0, 0), 'F.Cu')).toBeCloseTo(classClearance)
    expect(clearanceOf(pad(index.items, 0, 1), 'F.Cu')).toBeCloseTo(0.5)
  })
})

describe('ownClearance across a rebuild', () => {
  const settings = {
    rules: { ...DEFAULT_DESIGN_RULES },
    classes: DEFAULT_NET_CLASSES.map((cls) => ({ ...cls })),
    patterns: [],
    assignments: []
  }

  test('rules rebuilt from the same inputs answer untouched copper without asking again', () => {
    const ownClearance = ownClearanceMemo()
    const board = parseKicadBoard(BOARD)
    const index = BoardSpatialIndex.build(board)
    const item = pad(index.items, 0, 1)
    ownClearance(boardRules(board, settings))(item, 'F.Cu')
    const again = boardRules(board, { ...settings })
    const asked = vi.spyOn(again.resolver, 'evaluate')
    // A rebuilt index copies the item and keeps its shape.
    expect(ownClearance(again)({ ...item }, 'F.Cu')).toBeCloseTo(0.5)
    expect(asked).not.toHaveBeenCalled()
  })

  test('changed settings ask again', () => {
    const ownClearance = ownClearanceMemo()
    const board = parseKicadBoard(BOARD)
    const item = pad(BoardSpatialIndex.build(board).items, 0, 0)
    ownClearance(boardRules(board, settings))(item, 'F.Cu')
    const wider = boardRules(board, {
      ...settings,
      classes: settings.classes.map((cls) => ({ ...cls, clearance: 0.4 }))
    })
    expect(ownClearance(wider)(item, 'F.Cu')).toBeCloseTo(0.4)
  })
})

describe('inflatedOutline', () => {
  test('grows a pad, its corners rounded by the clearance', () => {
    const [o] = inflatedOutline(
      { kind: 'rrect', cx: 1, cy: 2, halfW: 0.5, halfH: 1, cornerR: 0, rotation: 0.3 },
      0.2
    )
    expect(o).toEqual({
      kind: 'rrect',
      cx: 1,
      cy: 2,
      halfW: 0.7,
      halfH: 1.2,
      cornerR: 0.2,
      rotation: 0.3
    })
  })

  test('grows a round pad as a circle and a track by its half width', () => {
    expect(inflatedOutline({ kind: 'circle', cx: 0, cy: 0, r: 0.8 }, 0.2)[0]).toMatchObject({
      kind: 'rrect',
      halfW: 1,
      halfH: 1,
      cornerR: 1
    })
    expect(
      inflatedOutline({ kind: 'capsule', x0: 0, y0: 0, x1: 1, y1: 0, halfWidth: 0.1 }, 0.2)[0]
    ).toMatchObject({ kind: 'capsule', halfWidth: expect.closeTo(0.3) })
  })

  test('merges a compound pad into one outline', () => {
    const [o] = inflatedOutline(
      {
        kind: 'compound',
        parts: [
          { kind: 'rrect', cx: 0, cy: 0, halfW: 1, halfH: 1, cornerR: 0, rotation: 0 },
          { kind: 'rrect', cx: 1.5, cy: 0, halfW: 1, halfH: 0.5, cornerR: 0, rotation: 0 }
        ]
      },
      0.1
    )
    expect(o.kind).toBe('rings')
    expect(o.kind === 'rings' && o.rings.length).toBe(1)
  })
})

describe('clearanceOutlines', () => {
  const query = (
    over: Partial<ClearanceQuery> = {}
  ): Array<{ layer: string; kind: ClearanceOutline['kind'] }> => {
    const { index, clearanceOf } = setup()
    return clearanceOutlines(index.items, {
      layer: 'F.Cu',
      visibleLayers: new Set(['F.Cu', 'B.Cu']),
      pads: true,
      tracks: false,
      selected: () => false,
      clearanceOf,
      ...over
    }).map((o) => ({ layer: o.layer, kind: o.outline.kind }))
  }

  test('outlines every pad on the active layer, and no track; pads apart stay apart', () => {
    expect(query()).toEqual([
      { layer: 'F.Cu', kind: 'rrect' },
      { layer: 'F.Cu', kind: 'rrect' },
      { layer: 'F.Cu', kind: 'rrect' }
    ])
  })

  test("a net's touching copper merges into one outline; two nets' stay apart", () => {
    const board = parseKicadBoard(`(kicad_pcb (version 20241229) (generator "test")
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal))
  (net 0 "") (net 1 "A") (net 2 "B")
  (segment (start 0 0) (end 5 0) (width 0.25) (layer "F.Cu") (net 1))
  (segment (start 5 0) (end 5 5) (width 0.25) (layer "F.Cu") (net 1))
  (segment (start 0 0.6) (end 5 0.6) (width 0.25) (layer "F.Cu") (net 2))
)`)
    const index = BoardSpatialIndex.build(board)
    const outlines = clearanceOutlines(index.items, {
      layer: 'F.Cu',
      visibleLayers: new Set(['F.Cu']),
      pads: false,
      tracks: true,
      selected: () => false,
      clearanceOf: () => 0.2
    })
    const a = outlines.filter((o) => o.net === 1)
    expect(a).toHaveLength(1)
    expect(a[0].outline.kind === 'rings' && a[0].outline.rings).toHaveLength(1)
    expect(outlines.filter((o) => o.net === 2)).toEqual([
      expect.objectContaining({ outline: expect.objectContaining({ kind: 'capsule' }) })
    ])
  })

  test('moving copper merges only with moving copper, and says so', () => {
    const board = parseKicadBoard(`(kicad_pcb (version 20241229) (generator "test")
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal))
  (net 0 "") (net 1 "A")
  (segment (start 0 0) (end 5 0) (width 0.25) (layer "F.Cu") (net 1))
  (segment (start 5 0) (end 5 5) (width 0.25) (layer "F.Cu") (net 1))
)`)
    const index = BoardSpatialIndex.build(board)
    const outlines = clearanceOutlines(index.items, {
      layer: 'F.Cu',
      visibleLayers: new Set(['F.Cu']),
      pads: false,
      tracks: true,
      selected: () => false,
      clearanceOf: () => 0.2,
      moving: (item) => item.ref.type === 'segment' && item.ref.index === 1
    })
    expect(outlines.map((o) => [o.outline.kind, o.moving ?? false])).toEqual([
      ['capsule', false],
      ['capsule', true]
    ])
  })

  test('outlines tracks on the active layer only when asked', () => {
    expect(query({ pads: false, tracks: true })).toEqual([])
    expect(query({ pads: false, tracks: true, layer: 'B.Cu' })).toEqual([
      { layer: 'B.Cu', kind: 'capsule' }
    ])
  })

  test('a selected item is outlined on every visible copper layer it is on', () => {
    const outlines = query({
      pads: true,
      selected: (item) => item.ref.type === 'pad' && item.ref.index === 1
    })
    expect(outlines.filter((o) => o.layer === 'B.Cu')).toEqual([{ layer: 'B.Cu', kind: 'rrect' }])
    expect(
      query({
        selected: (item) => item.ref.type === 'pad' && item.ref.index === 1,
        visibleLayers: new Set(['F.Cu'])
      }).filter((o) => o.layer === 'B.Cu')
    ).toEqual([])
  })

  test('nothing with pads off and tracks off, or no copper layer active', () => {
    expect(query({ pads: false })).toEqual([])
    expect(query({ layer: null })).toEqual([])
  })
})

describe('previewClearanceRings', () => {
  test("a route's tracks and its via are one outline", () => {
    const rings = previewClearanceRings(
      [
        { x0: 0, y0: 0, x1: 5, y1: 0, halfWidth: 0.3 },
        { x0: 5, y0: 0, x1: 8, y1: 3, halfWidth: 0.3 }
      ],
      [{ x: 8, y: 3, r: 0.5 }]
    )
    expect(rings).toHaveLength(1)
  })

  test('pieces apart stay apart', () => {
    expect(
      previewClearanceRings(
        [{ x0: 0, y0: 0, x1: 1, y1: 0, halfWidth: 0.2 }],
        [{ x: 5, y: 5, r: 0.3 }]
      )
    ).toHaveLength(2)
  })
})

describe('MergeCache', () => {
  const ring = (points: number): Array<{ x: number; y: number }> =>
    Array.from({ length: points }, (_, i) => ({ x: i, y: 0 }))

  test('holds at most two generations of points, however many entries', () => {
    const cache = new MergeCache(100)
    // An undo's worth of fresh keys, again and again: the stale ones age out.
    for (let i = 0; i < 1000; i++) cache.set(`k${i}`, [ring(30)])
    expect(cache.points).toBeLessThanOrEqual(2 * 100 + 30)
  })

  test('keeps what is still asked for across a generation', () => {
    const cache = new MergeCache(100)
    cache.set('kept', [ring(40)])
    cache.set('a', [ring(40)])
    cache.set('b', [ring(40)]) // a new generation: 'kept' and 'a' are old now
    expect(cache.get('kept')).toBeDefined() // brought back into the young one
    cache.set('c', [ring(40)])
    cache.set('d', [ring(40)]) // another: the old one, 'a' with it, goes
    expect(cache.get('a')).toBeUndefined()
    expect(cache.get('kept')).toBeDefined()
  })
})
