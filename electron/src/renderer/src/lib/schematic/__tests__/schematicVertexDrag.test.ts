import { describe, expect, test } from 'vitest'
import {
  parseKicadSchematic,
  serializeKicadSchematic,
  type KicadSchematic,
  type Point
} from '../../kicad/schematic'
import { mmToNm } from '../../kicad/coordinates'
import {
  applyVertexDrag,
  planBusVertexDrag,
  planMove,
  planVertexDrag,
  previewMovedSchematic
} from '../schematicMove'
import { cleanupSchematic, connectionShape } from '../wireCleanup'

const GRID = mmToNm(1.27)
const p = (x: number, y: number): Point => ({ x: mmToNm(x), y: mmToNm(y) })

const wire = (a: [number, number], b: [number, number], uuid: string): string =>
  `  (wire (pts (xy ${a[0]} ${a[1]}) (xy ${b[0]} ${b[1]}))
    (stroke (width 0) (type default))
    (uuid "${uuid}"))`

/**
 * R1's top pin sits at (50.8, 52.07). Wire 0 runs from it right to a corner at
 * (63.5, 52.07), where wire 1 turns up to a dangling end at (63.5, 40.64).
 */
const sheet = (items: string[] = []): string => `(kicad_sch
  (version 20231120)
  (generator "eeschema")
  (uuid "root-uuid")
  (paper "A4")
  (lib_symbols
    (symbol "Device:R"
      (property "Reference" "R" (at 0 0 0))
      (symbol "R_1_1"
        (pin passive line (at 0 3.81 270) (length 1.27)
          (name "~" (effects (font (size 1.27 1.27))))
          (number "1" (effects (font (size 1.27 1.27)))))
        (pin passive line (at 0 -3.81 90) (length 1.27)
          (name "~" (effects (font (size 1.27 1.27))))
          (number "2" (effects (font (size 1.27 1.27)))))))
  )
${wire([50.8, 52.07], [63.5, 52.07], 'w0')}
${wire([63.5, 52.07], [63.5, 40.64], 'w1')}
${items.join('\n')}
  (symbol
    (lib_id "Device:R")
    (at 50.8 55.88 0)
    (unit 1)
    (in_bom yes)
    (on_board yes)
    (dnp no)
    (uuid "symbol-uuid")
    (property "Reference" "R1" (at 52.07 54.61 0) (effects (font (size 1.27 1.27)) (justify left)))
    (property "Value" "10k" (at 52.07 57.15 0) (effects (font (size 1.27 1.27)) (justify left)))
    (pin "1" (uuid "pin-1"))
    (pin "2" (uuid "pin-2")))
  (sheet_instances (path "/" (page "1")))
)`

const edits = (plan: ReturnType<typeof planVertexDrag>): Record<number, Point[]> =>
  Object.fromEntries((plan?.reshape.edits ?? []).map((edit) => [edit.index, edit.points]))

/** Apply the drag and the tidy, the way the editor's command does. */
const dragged = (
  source: string,
  target: { index: number; vertex: number },
  delta: Point,
  wires = true
): { doc: KicadSchematic; text: string } => {
  const doc = parseKicadSchematic(source)
  const shape = connectionShape(doc)
  const plan = planVertexDrag(doc, { type: 'wire', ...target }, delta, { grid: GRID, wires })
  if (plan) applyVertexDrag(doc, plan, delta)
  const tidy = parseKicadSchematic(serializeKicadSchematic(doc))
  cleanupSchematic(tidy, shape)
  const text = serializeKicadSchematic(tidy)
  return { doc: parseKicadSchematic(text), text }
}

/** The lines of `after` that are not in `before`. */
const changedLines = (before: string, after: string): string[] => {
  const kept = new Set(before.split('\n'))
  return after.split('\n').filter((line) => !kept.has(line))
}

describe('dragging a wire end', () => {
  test('moves only that end; a lengthened wire diffs to one coordinate', () => {
    const plan = planVertexDrag(
      parseKicadSchematic(sheet()),
      { type: 'wire', index: 1, vertex: 1 },
      p(0, -2.54),
      { grid: GRID, wires: true }
    )
    expect(edits(plan)).toEqual({ 1: [p(63.5, 52.07), p(63.5, 38.1)] })
    const { text } = dragged(sheet(), { index: 1, vertex: 1 }, p(0, -2.54))
    const before = serializeKicadSchematic(parseKicadSchematic(sheet()))
    const changed = changedLines(before, text)
    expect(changed).toHaveLength(1)
    expect(changed[0]).toContain('(xy 63.5 38.1)')
  })

  test('the other end stays, so a sideways pull leaves the wire diagonal', () => {
    const plan = planVertexDrag(
      parseKicadSchematic(sheet()),
      { type: 'wire', index: 1, vertex: 1 },
      p(2.54, 0),
      { grid: GRID, wires: true }
    )
    expect(edits(plan)[1]).toEqual([p(63.5, 52.07), p(66.04, 40.64)])
  })

  test('a corner drags the wire that meets it, which stays orthogonal', () => {
    const plan = planVertexDrag(
      parseKicadSchematic(sheet()),
      { type: 'wire', index: 0, vertex: 1 },
      p(2.54, 0),
      { grid: GRID, wires: true }
    )
    expect(edits(plan)).toEqual({
      0: [p(50.8, 52.07), p(66.04, 52.07)],
      1: [p(66.04, 52.07), p(66.04, 40.64)]
    })
  })

  test('pulled off its line, the corner leaves the meeting wire upright', () => {
    const plan = planVertexDrag(
      parseKicadSchematic(sheet()),
      { type: 'wire', index: 0, vertex: 1 },
      p(2.54, -2.54),
      { grid: GRID, wires: true }
    )
    expect(edits(plan)).toEqual({
      0: [p(50.8, 52.07), p(66.04, 49.53)],
      1: [p(66.04, 49.53), p(66.04, 40.64)]
    })
  })

  test('with Shift the end leaves alone and what met it stays', () => {
    const plan = planVertexDrag(
      parseKicadSchematic(sheet()),
      { type: 'wire', index: 0, vertex: 1 },
      p(2.54, 0),
      { grid: GRID, wires: false }
    )
    expect(edits(plan)).toEqual({ 0: [p(50.8, 52.07), p(66.04, 52.07)] })
  })

  test('an end on a pin comes off it; the pin and what else meets there stay', () => {
    const extra = wire([50.8, 52.07], [50.8, 45.72], 'w2')
    const plan = planVertexDrag(
      parseKicadSchematic(sheet([extra])),
      { type: 'wire', index: 0, vertex: 0 },
      p(0, -2.54),
      { grid: GRID, wires: true }
    )
    expect(plan?.moved).toEqual([])
    expect(edits(plan)).toEqual({ 0: [p(50.8, 49.53), p(63.5, 52.07)] })
  })

  test('a dot and a label at the end ride with it', () => {
    const extra = [
      wire([63.5, 52.07], [76.2, 52.07], 'w2'),
      '  (junction (at 63.5 52.07) (diameter 0) (color 0 0 0 0) (uuid "j"))',
      '  (label "N" (at 63.5 52.07 0) (effects (font (size 1.27 1.27)) (justify left bottom)) (uuid "l"))'
    ]
    const source = sheet(extra)
    const plan = planVertexDrag(
      parseKicadSchematic(source),
      { type: 'wire', index: 0, vertex: 1 },
      p(0, -2.54),
      { grid: GRID, wires: true }
    )
    expect([...(plan?.selection.junctions ?? [])]).toEqual([0])
    expect(plan?.labelMoves).toEqual([{ index: 0, to: p(63.5, 49.53) }])
    const { doc, text } = dragged(source, { index: 0, vertex: 1 }, p(0, -2.54))
    expect(doc.junctions.map((junction) => [junction.x, junction.y])).toEqual([
      [mmToNm(63.5), mmToNm(49.53)]
    ])
    // Moved, not replaced: the dot keeps its uuid.
    expect(text).toContain('(uuid "j")')
    expect(doc.labels[0].position).toMatchObject(p(63.5, 49.53))
  })

  test('a wire teed onto the dragged wire stays where it is', () => {
    const tee = wire([57.15, 52.07], [57.15, 45.72], 'w2')
    const plan = planVertexDrag(
      parseKicadSchematic(sheet([tee])),
      { type: 'wire', index: 0, vertex: 1 },
      p(2.54, 0),
      { grid: GRID, wires: true }
    )
    expect(edits(plan)[2]).toBeUndefined()
  })

  test('an end teed onto another wire comes off it alone', () => {
    const tee = wire([57.15, 52.07], [57.15, 45.72], 'w2')
    const plan = planVertexDrag(
      parseKicadSchematic(sheet([tee])),
      { type: 'wire', index: 2, vertex: 0 },
      p(0, 2.54),
      { grid: GRID, wires: true }
    )
    expect(plan?.moved).toEqual([])
    expect(edits(plan)).toEqual({ 2: [p(57.15, 54.61), p(57.15, 45.72)] })
  })

  test('an end dropped mid-wire breaks that wire and dots the T', () => {
    const stub = wire([57.15, 45.72], [57.15, 40.64], 'w2')
    const { doc } = dragged(sheet([stub]), { index: 2, vertex: 0 }, p(0, 6.35))
    expect(doc.wires.map((w) => w.points)).toEqual([
      [p(50.8, 52.07), p(57.15, 52.07)],
      [p(57.15, 52.07), p(63.5, 52.07)],
      [p(63.5, 52.07), p(63.5, 40.64)],
      [p(57.15, 52.07), p(57.15, 40.64)]
    ])
    expect(doc.junctions.map((junction) => [junction.x, junction.y])).toEqual([
      [mmToNm(57.15), mmToNm(52.07)]
    ])
  })

  test('the tidy runs after the drag: an end folded back onto its line is merged', () => {
    // Pulling the corner down to the pin's row turns the riser into a stub
    // that continues wire 0; the tidy joins what nothing else meets.
    const { doc } = dragged(sheet(), { index: 1, vertex: 1 }, p(0, 11.43))
    expect(doc.wires).toHaveLength(1)
    expect(doc.wires[0].points).toEqual([p(50.8, 52.07), p(63.5, 52.07)])
  })

  test('the preview carries the dragged wire by its edit, not by a shift', () => {
    const doc = parseKicadSchematic(sheet())
    const delta = p(2.54, 0)
    const plan = planVertexDrag(doc, { type: 'wire', index: 1, vertex: 1 }, delta, {
      grid: GRID,
      wires: true
    })
    if (!plan) throw new Error('no plan')
    expect(previewMovedSchematic(doc, plan, delta).wires[1].points).toEqual([
      p(63.5, 52.07),
      p(66.04, 40.64)
    ])
  })
})

describe('dragging a segment by its middle', () => {
  test('keeps the orthogonal neighbour orthogonal (KiCad drag, G)', () => {
    const doc = parseKicadSchematic(sheet())
    const plan = planMove(doc, [{ type: 'wire', index: 0 }], p(1.27, -2.54), {
      grid: GRID,
      wires: true
    })
    const riser = plan.reshape.edits.find((edit) => edit.index === 1)?.points
    expect(riser).toEqual([p(64.77, 49.53), p(64.77, 40.64)])
  })

  test('a move (M) leaves the neighbour where it was', () => {
    const doc = parseKicadSchematic(sheet())
    const plan = planMove(doc, [{ type: 'wire', index: 0 }], p(1.27, -2.54), {
      grid: GRID,
      wires: false
    })
    expect(plan.reshape.edits).toEqual([])
  })
})

describe('dragging a bus point', () => {
  const buses = sheet([
    '  (bus (pts (xy 20 20) (xy 30 20)) (stroke (width 0) (type default)) (uuid "b0"))',
    '  (bus (pts (xy 30 20) (xy 30 30)) (stroke (width 0) (type default)) (uuid "b1"))'
  ])

  test('an end takes the bus meeting it along; Shift leaves it', () => {
    const doc = parseKicadSchematic(buses)
    const target = { type: 'bus' as const, index: 0, vertex: 1 }
    expect(planBusVertexDrag(doc, target, p(0, 2.54), true)).toEqual([
      { index: 0, points: [p(20, 20), p(30, 22.54)] },
      { index: 1, points: [p(30, 22.54), p(30, 30)] }
    ])
    expect(planBusVertexDrag(doc, target, p(0, 2.54), false)).toEqual([
      { index: 0, points: [p(20, 20), p(30, 22.54)] }
    ])
  })
})
