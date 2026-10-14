import { describe, expect, test } from 'vitest'
import { boardBoxSelect, type BoardBoxSelectContext } from '../BoardScene'
import { parseKicadBoard } from '../../kicad/board'

/**
 * The band test, exercised against a real parsed board. `BoardScene` itself
 * cannot be constructed here (it rasterizes glyphs against a DOM canvas), which
 * is why the geometry is an exported function — see `boardBoxSelect`.
 *
 * Every item below sits in a lane of its own so a band can take one without
 * catching a neighbor: y = 10 tracks, 20 arc, 30 via, 40 graphics, 50 text,
 * 60 zone. KiCad's y axis runs down and the scene's runs up, so a source `(at x
 * y)` is tested at scene y = -y.
 */
const source = `(kicad_pcb
  (version 20240108)
  (generator "pcbnew")
  (layers
    (0 "F.Cu" signal)
    (31 "B.Cu" signal)
    (37 "F.SilkS" user "F.Silkscreen")
    (44 "Edge.Cuts" user)
  )
  (segment (start 0 10) (end 10 10) (width 0.25) (layer "F.Cu") (net 1))
  (segment (start 0 10) (end 10 10) (width 0.25) (layer "B.Cu") (net 1))
  (arc (start 0 20) (mid 5 15) (end 10 20) (width 0.25) (layer "F.Cu") (net 1))
  (via (at 5 30) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") (net 1))
  (gr_line (start 0 40) (end 10 40) (stroke (width 0.1) (type solid)) (layer "Edge.Cuts"))
  (gr_rect (start 20 40) (end 30 45) (stroke (width 0.1) (type solid)) (fill none) (layer "Edge.Cuts"))
  (gr_circle (center 50 40) (end 53 40) (stroke (width 0.1) (type solid)) (fill none) (layer "Edge.Cuts"))
  (gr_poly (pts (xy 60 40) (xy 70 40) (xy 70 45)) (stroke (width 0.1) (type solid)) (fill none) (layer "Edge.Cuts"))
  (gr_arc (start 80 40) (mid 85 35) (end 90 40) (stroke (width 0.1) (type solid)) (layer "Edge.Cuts"))
  (arc (start 100 100) (mid 110 100) (end 105 95) (width 0.25) (layer "F.Cu") (net 1))
  (gr_text "HELLO" (at 5 50) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15))))
  (zone (net 1) (net_name "GND") (layer "F.Cu")
    (hatch edge 0.5)
    (connect_pads (clearance 0.5))
    (min_thickness 0.25)
    (fill yes)
    (polygon (pts (xy 0 60) (xy 10 60) (xy 10 70) (xy 0 70)))
  )
)`

const board = parseKicadBoard(source)

const context = (overrides: Partial<BoardBoxSelectContext> = {}): BoardBoxSelectContext => ({
  flipped: false,
  isLayerVisible: () => true,
  isFootprintSelectable: () => true,
  footprintBounds: () => undefined,
  ...overrides
})

interface Band {
  xMin: number
  xMax: number
  yMin: number
  yMax: number
}

/** Scene-space band around a KiCad-space rect, so cases read in source coords. */
const band = (xMin: number, yMin: number, xMax: number, yMax: number): Band => ({
  xMin,
  xMax,
  yMin: -yMax,
  yMax: -yMin
})

const types = (bounds: Band, crossing: boolean, ctx = context()): string[] =>
  boardBoxSelect(board, bounds, crossing, ctx).map((ref) => ref.type)

describe('boardBoxSelect', () => {
  test('an enclosing band takes only what it fully contains', () => {
    // Wide enough for the whole track, and clear of every other lane.
    expect(types(band(-1, 9, 11, 11), false)).toEqual(['segment', 'segment'])
  })

  test('a crossing band takes what it merely touches', () => {
    // Clips the right end of the tracks only.
    expect(types(band(9, 9, 20, 11), true)).toEqual(['segment', 'segment'])
    expect(types(band(9, 9, 20, 11), false)).toEqual([])
  })

  test('layer visibility is honored, so a band and a click agree', () => {
    const frontOnly = context({ isLayerVisible: (layer) => layer !== 'B.Cu' })
    expect(types(band(-1, 9, 11, 11), false, frontOnly)).toEqual(['segment'])
  })

  test('a simple arc is enclosed once the band clears its stroke', () => {
    // start/mid/end at y 20/15/20, so the sweep's apex is the mid point; the
    // only slack that matters is half the 0.25 stroke.
    expect(types(band(-1, 14.8, 11, 20.2), false)).toEqual(['tarc'])
    expect(types(band(-1, 15.2, 11, 20.2), false)).toEqual([])
  })

  test('an arc is bounded by its sweep, not by its three defining points', () => {
    // The 270° arc at y≈100: center (105,100) r=5, running start(180°) →
    // mid(0°) → end(90°), so it dips to y=105 — past all three of the points
    // that define it, which top out at y=100. This is the case a cheap
    // start/mid/end box gets wrong, and the reason `arcPolyline` is used.
    const containsThePointsOnly = band(99, 94, 111, 101)
    expect(types(containsThePointsOnly, false)).toEqual([])
    // Room for the real sweep, and it encloses.
    expect(types(band(99, 94, 111, 106), false)).toEqual(['tarc'])
  })

  test('a via is taken by its pad, not its center point', () => {
    // The band stops 0.3mm short of the via center but overlaps its 0.8 body.
    expect(types(band(4.5, 29.5, 4.7, 30.5), true)).toEqual(['via'])
  })

  test('each graphic kind is sweepable', () => {
    expect(types(band(-1, 39, 11, 41), false)).toEqual(['gr_line'])
    expect(types(band(19, 39, 31, 46), false)).toEqual(['gr_rect'])
    expect(types(band(46, 36, 54, 44), false)).toEqual(['gr_circle'])
    expect(types(band(59, 39, 71, 46), false)).toEqual(['gr_poly'])
    expect(types(band(79, 34, 91, 41), false)).toEqual(['gr_arc'])
  })

  test('a circle is bounded by its radius, not its center and edge points', () => {
    // Center (50,40), radius 3: the left extreme at x=47 lies outside a box
    // drawn around only the center and the (53,40) edge point.
    expect(types(band(49, 36, 54, 44), false)).toEqual([])
  })

  test('text is taken by its glyph box', () => {
    expect(types(band(4, 49, 6, 51), true)).toEqual(['gr_text'])
    // Far enough right of the anchor to miss five characters of 1mm text.
    expect(types(band(30, 49, 40, 51), true)).toEqual([])
  })

  test('a zone is taken by its outline', () => {
    expect(types(band(-1, 59, 11, 71), false)).toEqual(['zone'])
  })

  test('footprint bounds come from the scene, which measured the paint', () => {
    const withFootprint = context({
      footprintBounds: (index) => (index === 0 ? { minX: 0, minY: 0, maxX: 1, maxY: 1 } : undefined)
    })
    // No footprints in the source, so nothing is offered to test against —
    // the guard is that an absent bounds entry is skipped rather than throwing.
    expect(types(band(-1, -2, 2, 1), true, withFootprint)).toEqual([])
  })

  test('a footprint the view does not let a click take, a band does not take either', () => {
    // A back part under dim with the front active: KiCad's high contrast keeps
    // it out of a band as it keeps it out of a click (`Selectable`).
    const withFootprint = parseKicadBoard(
      source.replace(
        /\)$/,
        `(footprint "T:B" (layer "B.Cu") (at 5 80)
          (pad "1" smd rect (at 0 0) (size 1 1) (layers "B.Cu") (net 1)))
        )`
      )
    )
    const at = (selectable: boolean): string[] =>
      boardBoxSelect(
        withFootprint,
        band(3, 78, 7, 82),
        false,
        context({
          isFootprintSelectable: () => selectable,
          footprintBounds: () => ({ minX: 4, minY: -81, maxX: 6, maxY: -79 })
        })
      ).map((ref) => ref.type)
    expect(at(true)).toEqual(['footprint'])
    expect(at(false)).toEqual([])
  })

  test('a flipped view mirrors the band, not the board', () => {
    const flipped = context({ flipped: true })
    // Viewing from the back, the tracks at x 0..10 answer to a band at -10..0.
    expect(types(band(-11, 9, 1, 11), false, flipped)).toEqual(['segment', 'segment'])
    expect(types(band(-1, 9, 11, 11), false, flipped)).toEqual([])
  })

  test('an empty band selects nothing', () => {
    expect(types(band(200, 200, 201, 201), true)).toEqual([])
  })
})
