import { describe, expect, test } from 'vitest'
import {
  parseKicadBoard,
  serializeKicadBoard,
  updateTuningPatternInAST,
  type KicadBoard
} from '../../kicad/board'
import {
  boardVertexShape,
  moveShapeVertex,
  tuningFromShape,
  vertexShapeGhost,
  type VertexShape
} from '../graphicVertices'
import { mmToNm as mm } from '../../kicad/coordinates'
import {
  handlesEdit,
  membersLength,
  patternEdit,
  patternBaselines,
  patternMembers,
  patternMembership,
  prunePatternsInAST,
  restorePatternInAST
} from '../tuningPatterns'
import { removeBoardNodeFromAST } from '../../kicad/board'

// docs/router-behavior.md T4: a tuning pattern on the board, selected,
// re-tuned and removed as one.

const seg = (uuid: string, x0: number, y0: number, x1: number, y1: number, net = 1): string =>
  `(segment (start ${x0} ${y0}) (end ${x1} ${y1}) (width 0.2) (layer "F.Cu") (net ${net}) (uuid "${uuid}"))`

/** A track from x 0 to 6 at y 0, meandered from x 2 to 4: KiCad's pattern holds only the meanders. */
const board = (members: string, extra = ''): KicadBoard =>
  parseKicadBoard(`(kicad_pcb (version 20241229) (generator "pcbnew")
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal))
  (net 0 "") (net 1 "SIG")
  ${seg('l1', 0, 0, 2, 0)}
  ${seg('m1', 2, 0, 2, -1)}
  ${seg('m2', 2, -1, 4, -1)}
  ${seg('m3', 4, -1, 4, 0)}
  ${seg('l2', 4, 0, 6, 0)}
  (generated (uuid "pat") (type tuning_pattern) (name "Tuning Pattern") (layer "F.Cu")
    (base_line (pts (xy 2 0) (xy 4 0))) (corner_radius_percent 80) (end (xy 4 0))
    (initial_side "left") (is_time_domain no) (last_diff_pair_gap 0) (last_netname "SIG")
    (last_status "tuned") (last_track_width 0.2) (last_tuning_length 8) (max_amplitude 1)
    (min_amplitude 0.2) (min_spacing 0.6) (origin (xy 2 0)) (override_custom_rules no)
    (rounded yes) (single_sided no) (target_delay 1000000) (target_delay_max 1000000)
    (target_delay_min 0) (target_length 8) (target_length_max 8.1) (target_length_min 7.9)
    (target_skew 0) (target_skew_max 0.1) (target_skew_min -0.1) (tuning_mode "single")${extra}
    (members ${members}))
)`)

describe('T4: a tuning pattern on the board', () => {
  test('is read with its settings, target and tracks', () => {
    const b = board('"m1" "m2" "m3"')
    expect(b.tuningPatterns).toHaveLength(1)
    const p = b.tuningPatterns[0]
    expect(p.uuid).toBe('pat')
    expect(p.mode).toBe('single')
    expect(p.initialSide).toBe('left')
    expect(p.maxAmplitude).toBe(1)
    expect(p.minSpacing).toBe(0.6)
    expect(p.targetLength).toEqual({ min: 7.9, opt: 8, max: 8.1 })
    expect(p.overrideCustomRules).toBe(false)
    expect(patternMembers(b, p).map((m) => b.segments[m.index].uuid)).toEqual(['m1', 'm2', 'm3'])
    expect(patternMembership(b).get('segment:2')).toBe(0)
    expect(patternMembership(b).has('segment:0')).toBe(false)
    expect(membersLength(b, p, 1)).toBeCloseTo(4, 9)
  })

  test('KiCad\'s "no constraint" reads as unbounded', () => {
    const b = board('"m1"')
    updateTuningPatternInAST(b.tuningPatterns[0], {
      ...b.tuningPatterns[0],
      targetLength: { min: 0, opt: Infinity, max: Infinity }
    })
    const again = parseKicadBoard(serializeKicadBoard(b))
    expect(again.tuningPatterns[0].targetLength).toEqual({ min: 0, opt: Infinity, max: Infinity })
    expect(serializeKicadBoard(b)).toMatch(/\(target_length_max 1000000\)/)
  })

  test('re-tuned in place, a key we do not model is kept where it was', () => {
    const b = board('"m1" "m2" "m3"', ' (future_key 7)')
    const p = b.tuningPatterns[0]
    updateTuningPatternInAST(p, { ...p, maxAmplitude: 1.5, members: ['m2', 'm1'] })
    const text = serializeKicadBoard(b)
    expect(text).toMatch(/\(max_amplitude 1\.5\)/)
    expect(text).toMatch(/\(future_key 7\)\s*\(members "m1" "m2"\)/)
    expect(parseKicadBoard(text).tuningPatterns[0].maxAmplitude).toBe(1.5)
  })

  test('its base line is the run it replaced, out to where its tracks meet the net', () => {
    const kicad = board('"m1" "m2" "m3"')
    expect(patternBaselines(kicad, kicad.tuningPatterns[0])).toEqual([
      expect.objectContaining({ net: 1, points: [kicad.segments[1].start, kicad.segments[3].end] })
    ])
    // One we wrote before held its leads too: they come back in line with it.
    const ours = board('"l1" "m1" "m2" "m3" "l2"')
    const [run] = patternBaselines(ours, ours.tuningPatterns[0])
    expect(run.points).toEqual([ours.segments[0].start, ours.segments[4].end])
  })

  test('deleted alone, it gives back the straight track and the routing stays', () => {
    const b = board('"m1" "m2" "m3"')
    restorePatternInAST(b, b.tuningPatterns[0])
    const after = parseKicadBoard(serializeKicadBoard(b))
    expect(after.tuningPatterns).toHaveLength(0)
    expect(after.segments.map((s) => s.uuid)).toEqual(['l1', 'l2', expect.any(String)])
    const restored = after.segments[2]
    expect([restored.start, restored.end]).toEqual([b.segments[1].start, b.segments[3].end])
  })

  test('a pattern whose tracks are deleted goes with them; one that lost some keeps the rest', () => {
    const b = board('"m1" "m2" "m3"')
    removeBoardNodeFromAST(b, b.segments[2]._raw)
    expect(prunePatternsInAST(b)).toBe(true)
    let after = parseKicadBoard(serializeKicadBoard(b))
    expect(after.tuningPatterns[0].members).toEqual(['m1', 'm3'])
    for (const s of after.segments.filter((x) => x.uuid?.startsWith('m')))
      removeBoardNodeFromAST(after, s._raw)
    expect(prunePatternsInAST(after)).toBe(true)
    after = parseKicadBoard(serializeKicadBoard(after))
    expect(after.tuningPatterns).toHaveLength(0)
    expect(prunePatternsInAST(after)).toBe(false)
  })
})

describe('T4: re-tuning a pattern', () => {
  test('a Properties row changes what it is laid again with', () => {
    const p = board('"m1"').tuningPatterns[0]
    expect(patternEdit(p, 'maxAmplitude', 2).maxAmplitude).toBe(2)
    // The largest under the least carries the least down, as KiCad's SetMaxAmplitude.
    expect(patternEdit(p, 'maxAmplitude', 0.1)).toMatchObject({
      maxAmplitude: 0.1,
      minAmplitude: 0.1
    })
    expect(patternEdit(p, 'minAmplitude', 1.5)).toMatchObject({
      minAmplitude: 1.5,
      maxAmplitude: 1.5
    })
    expect(patternEdit(p, 'spacing', 0.8).minSpacing).toBe(0.8)
    expect(patternEdit(p, 'initialSide', 'right').initialSide).toBe('right')
    expect(patternEdit(p, 'target', 12).targetLength).toEqual({ min: 11.9, opt: 12, max: 12.1 })
    expect(patternEdit(p, 'target', null).targetLength.opt).toBe(Infinity)
    expect(patternEdit(p, 'overrideCustomRules', true).overrideCustomRules).toBe(true)
  })

  test("its handles are KiCad's: the ends slide along the base line, the third sets amplitude and side, the fourth spacing", () => {
    const b = board('"m1"')
    const p = b.tuningPatterns[0]
    const shape = boardVertexShape(b, 'tuning_pattern', 0) as Extract<
      VertexShape,
      { kind: 'tuning' }
    >
    expect(shape.origin).toEqual(p.origin)
    expect(shape.end).toEqual(p.end)
    // Left of origin → end as the board is drawn (y up) is up the screen: y less in the file.
    // Out past the largest amplitude by half the track's width, as KiCad's.
    expect(shape.amplitude).toEqual({ x: mm(3), y: mm(-1.1) })
    // 1.5 spacings on along the line from it.
    expect(shape.spacing).toEqual({ x: mm(3.9), y: mm(-1.1) })
    expect(handlesEdit(p, shape, 2)).toMatchObject({ maxAmplitude: 1, initialSide: 'left' })
    expect(handlesEdit(p, shape, 3).minSpacing).toBe(0.6)

    // An end pulled off the line stays on it, and nothing else is read back.
    const slid = moveShapeVertex(shape, 1, mm(0.5), mm(0.7)) as typeof shape
    expect(slid.end).toEqual({ x: mm(4.5), y: mm(0) })
    expect(handlesEdit(p, slid, 1)).toMatchObject({ end: slid.end, maxAmplitude: 1 })
    // The amplitude handle pulled across the line: further out, on the other side,
    // in hundredths, its spacing handle carried along.
    const across = moveShapeVertex(shape, 2, mm(0), mm(2.504)) as typeof shape
    expect(handlesEdit(p, across, 2)).toMatchObject({ maxAmplitude: 1.3, initialSide: 'right' })
    expect(handlesEdit(p, across, 3).minSpacing).toBe(0.6)
    // Pulled in under the least amplitude, it carries the least down, as KiCad's.
    const low = moveShapeVertex(shape, 2, mm(0), mm(0.95)) as typeof shape
    expect(handlesEdit(p, low, 2)).toMatchObject({ maxAmplitude: 0.05, minAmplitude: 0.05 })
    // The spacing handle sets the spacing by how far along it stands.
    const wider = moveShapeVertex(shape, 3, mm(0.3), mm(0.2)) as typeof shape
    expect(handlesEdit(p, wider, 3).minSpacing).toBe(0.8)
    // The ghost is the line between the ends, the amplitude's reach, then the spacing.
    const ghost = vertexShapeGhost(shape)
    expect(ghost.kind === 'lines' && ghost.segments).toHaveLength(3)
  })

  test("a pair's handles stand on its centerline, its ends read back onto the tuned half", () => {
    const b = board('"m1"')
    updateTuningPatternInAST(b.tuningPatterns[0], {
      ...b.tuningPatterns[0],
      mode: 'diff_pair',
      baseLineCoupled: [
        { x: mm(2), y: mm(0.5) },
        { x: mm(4), y: mm(0.5) }
      ],
      lastDiffPairGap: 0.3
    })
    const pair = parseKicadBoard(serializeKicadBoard(b))
    const p = pair.tuningPatterns[0]
    const shape = boardVertexShape(pair, 'tuning_pattern', 0) as Extract<
      VertexShape,
      { kind: 'tuning' }
    >
    expect(shape.origin).toEqual({ x: mm(2), y: mm(0.25) })
    // Half a width, a width and the gap past the largest amplitude.
    expect(shape.amplitude).toEqual({ x: mm(3), y: mm(-1.35) })
    expect(handlesEdit(p, shape, 2).maxAmplitude).toBe(1)
    const slid = moveShapeVertex(shape, 0, mm(0.5), mm(0.3)) as typeof shape
    expect(handlesEdit(p, slid, 0).origin).toEqual({ x: mm(2.5), y: mm(0) })
  })

  test('on a base line that bends, the handles follow it round the bend', () => {
    const pt = (x: number, y: number): { x: ReturnType<typeof mm>; y: ReturnType<typeof mm> } => ({
      x: mm(x),
      y: mm(y)
    })
    // Along x to 10, then down the file (y) to 6: halfway along is (8, 0), its left up the file.
    const shape: Extract<VertexShape, { kind: 'tuning' }> = {
      kind: 'tuning',
      origin: pt(0, 0),
      end: pt(10, 6),
      amplitude: pt(8, -1),
      spacing: pt(8.9, -1),
      base: [pt(0, 0), pt(10, 0), pt(10, 6)],
      reach: 0
    }
    expect(tuningFromShape(shape)).toMatchObject({ maxAmplitude: 1, side: 1, spacing: 0.6 })
    // The end pulled off the line lands on the stretch it is nearest, past the bend.
    const slid = moveShapeVertex(shape, 1, mm(0.5), mm(-2)) as typeof shape
    expect(slid.end).toEqual(pt(10, 4))
    // The ghost traces the line round the bend, then the amplitude handle's reach.
    const ghost = vertexShapeGhost(shape)
    expect(ghost.kind === 'lines' && ghost.segments).toHaveLength(4)
  })
})
