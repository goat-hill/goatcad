import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseKicadBoard } from '../../kicad/board'
import { loadClipper } from '../../geometry/clip'
import { writeGerberLayer } from '../write'
import { parseGerber, type GerberImage } from '../parse'
import { collectDrillHits, writeExcellon, drillPreviewGerber, partitionHits } from '../drill'
import { parseExcellon } from '../excellon'
import { gerberRegions } from '../regions'
import { pointInPoly } from '../../board/spatialIndex'
import { gerberFileName } from '../fabPackage'
import { exportPackage, exportDrill, exportGerbers } from '../../fabExport'
import { findExportProfile } from '../../exportProfiles'
import { CANARY_BOARD } from '../../__tests__/canaryFixture'

// A small but structurally complete board: two SMD pads (one rounded, one
// rotated rect), a through-hole pad, a track, a via, an Edge.Cuts outline, and
// a filled copper zone. Exercises every plot path the writer has.
const BOARD = `
(kicad_pcb (version 20221018) (generator pcbnew)
  (general (thickness 1.6))
  (paper "A4")
  (layers
    (0 "F.Cu" signal) (31 "B.Cu" signal)
    (36 "F.SilkS" user) (34 "F.Paste" user) (38 "F.Mask" user)
    (44 "Edge.Cuts" user))
  (net 0 "")
  (net 1 "GND")
  (footprint "R_0603" (layer "F.Cu") (at 10 10 90)
    (property "Reference" "R1" (at 0 -1 90) (layer "F.SilkS")
      (effects (font (size 1 1) (thickness 0.15))))
    (pad "1" smd roundrect (at -0.8 0 90) (size 0.9 0.8)
      (layers "F.Cu" "F.Paste" "F.Mask") (roundrect_rratio 0.25))
    (pad "2" smd rect (at 0.8 0 90) (size 0.9 0.8)
      (layers "F.Cu" "F.Paste" "F.Mask"))
    (fp_line (start -1 -0.5) (end 1 -0.5) (layer "F.SilkS")
      (stroke (width 0.12) (type solid))))
  (footprint "D_TH" (layer "F.Cu") (at 20 20)
    (pad "1" thru_hole circle (at 0 0) (size 1.6 1.6) (drill 0.8)
      (layers "*.Cu" "*.Mask")))
  (segment (start 10 10) (end 20 10) (width 0.25) (layer "F.Cu") (net 1))
  (via (at 15 12) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 1))
  (gr_line (start 0 0) (end 40 0) (layer "Edge.Cuts") (stroke (width 0.1) (type solid)))
  (gr_line (start 40 0) (end 40 40) (layer "Edge.Cuts") (stroke (width 0.1) (type solid)))
  (gr_line (start 40 40) (end 0 40) (layer "Edge.Cuts") (stroke (width 0.1) (type solid)))
  (gr_line (start 0 40) (end 0 0) (layer "Edge.Cuts") (stroke (width 0.1) (type solid)))
  (zone (net 1) (net_name "GND") (layers "F.Cu") (hatch edge 0.5)
    (polygon (pts (xy 0 0) (xy 40 0) (xy 40 40) (xy 0 40)))
    (filled_polygon (layer "F.Cu")
      (pts (xy 1 1) (xy 39 1) (xy 39 39) (xy 1 39)))))
`

const board = parseKicadBoard(BOARD)

describe('writeGerberLayer — round-trips through our own parser', () => {
  it('numbers copper by stack position, not by KiCad 9+ layer ids', () => {
    // v9+ ids: F.Cu 0, B.Cu 2, In1.Cu 4, In2.Cu 6 — B.Cu is still L4.
    const v10 = parseKicadBoard(
      BOARD.replace('(version 20221018)', '(version 20260206)').replace(
        '(31 "B.Cu" signal)',
        '(4 "In1.Cu" signal) (6 "In2.Cu" signal) (2 "B.Cu" signal)'
      )
    )
    expect(writeGerberLayer(v10, 'In1.Cu').fileFunction).toBe('Copper,L2,Inr')
    expect(writeGerberLayer(v10, 'In2.Cu').fileFunction).toBe('Copper,L3,Inr')
    expect(writeGerberLayer(v10, 'B.Cu').fileFunction).toBe('Copper,L4,Bot')
  })

  it('emits a header the parser accepts and renders F.Cu geometry', () => {
    const layer = writeGerberLayer(board, 'F.Cu')
    expect(layer.fileFunction).toBe('Copper,L1,Top')
    const image = parseGerber(layer.content)
    expect(image.warnings).toEqual([])
    expect(image.units).toBe('mm')
    // Pads, track, via, zone fill all present.
    expect(image.items.length).toBeGreaterThan(4)
    // Leftmost/rightmost F.Cu geometry is the zone fill (1..39); the board
    // outline itself lives on Edge.Cuts, not here.
    expect(image.bounds.minX).toBeLessThanOrEqual(1.01)
    expect(image.bounds.maxX).toBeGreaterThanOrEqual(38.99)
  })

  it('flashes an axis-aligned rect pad as a standard R aperture', () => {
    // Pad "2" is a rect at an axis-aligned 90° → standard aperture flash,
    // not a region, so the aperture dictionary is non-empty.
    const image = parseGerber(writeGerberLayer(board, 'F.Cu').content)
    expect(image.apertureCount).toBeGreaterThan(0)
  })

  it('plots paste only for SMD pads', () => {
    const image = parseGerber(writeGerberLayer(board, 'F.Paste').content)
    // Two SMD pad openings; the through-hole pad has no stencil aperture.
    const flashesAndRegions = image.items.length
    expect(flashesAndRegions).toBe(2)
  })

  it('plots mask openings for SMD and through-hole pads', () => {
    const image = parseGerber(writeGerberLayer(board, 'F.Mask').content)
    // Two SMD + one *.Mask through-hole pad.
    expect(image.items.length).toBe(3)
  })

  it('renders silkscreen graphics and reference text as strokes', () => {
    const image = parseGerber(writeGerberLayer(board, 'F.SilkS').content)
    // One fp_line + several glyph strokes for "R1".
    expect(image.items.length).toBeGreaterThan(1)
    expect(image.warnings).toEqual([])
  })

  it('plots the Edge.Cuts outline', () => {
    const image = parseGerber(writeGerberLayer(board, 'Edge.Cuts').content)
    expect(image.fileFunction).toBe('Profile,NP')
    expect(image.items.length).toBe(4)
    // 40×40 outline (+0.05 stroke half-width each side). KiCad's positive-Y-down
    // board lands in negative Gerber Y, so assert the span, not absolute Y.
    expect(image.bounds.maxX - image.bounds.minX).toBeCloseTo(40.1, 1)
    expect(image.bounds.maxY - image.bounds.minY).toBeCloseTo(40.1, 1)
  })

  it('is deterministic', () => {
    expect(writeGerberLayer(board, 'F.Cu').content).toBe(writeGerberLayer(board, 'F.Cu').content)
  })

  it('plots a rotated reference the upright way KiCad would', () => {
    // KiCad keeps footprint text readable unless it is `(unlocked yes)`, so a
    // reference stored at 180 — a part rotated half a turn — plots exactly as
    // if it were stored at 0. Asserted on the Gerber, the copy the fab gets.
    const silk = (angle: string, unlocked = ''): string =>
      writeGerberLayer(
        parseKicadBoard(
          BOARD.replace(
            '(property "Reference" "R1" (at 0 -1 90) (layer "F.SilkS")',
            `(property "Reference" "R1" (at 0 -1 ${angle}) ${unlocked}(layer "F.SilkS")`
          )
        ),
        'F.SilkS'
      ).content

    expect(silk('180')).toBe(silk('0'))
    expect(silk('270')).toBe(silk('90'))
    // The flag is honored, so the fold is not blanket.
    expect(silk('180', '(unlocked yes) ')).not.toBe(silk('0'))
  })
})

describe('collectDrillHits / writeExcellon', () => {
  it('collects the through-hole pad and the via', () => {
    const hits = collectDrillHits(board)
    expect(hits).toHaveLength(2)
    const diameters = hits.map((h) => h.diameter).sort()
    expect(diameters).toEqual([0.3, 0.8])
    expect(hits.every((h) => h.plated)).toBe(true)
  })

  it('writes a metric Excellon file with one tool per diameter', () => {
    const drl = writeExcellon(collectDrillHits(board))
    expect(drl).toContain('M48')
    expect(drl).toContain('METRIC')
    expect(drl).toContain('T1C0.3')
    expect(drl).toContain('T2C0.8')
    expect(drl.trimEnd().endsWith('M30')).toBe(true)
  })

  it('produces a preview gerber the parser accepts', () => {
    const image = parseGerber(drillPreviewGerber(collectDrillHits(board)))
    expect(image.items).toHaveLength(2)
    expect(image.warnings).toEqual([])
  })

  it('partitions plated from non-plated', () => {
    const { plated, nonPlated } = partitionHits(collectDrillHits(board))
    expect(plated).toHaveLength(2)
    expect(nonPlated).toHaveLength(0)
  })
})

describe('the Gerber and drill writers — naming and assembly', () => {
  const jlc = findExportProfile('jlcpcb')!

  it('names gerbers with protel extensions for a protel profile', () => {
    expect(gerberFileName('F.Cu', 'demo', 'protel')).toBe('demo.GTL')
    expect(gerberFileName('B.Cu', 'demo', 'protel')).toBe('demo.GBL')
    expect(gerberFileName('Edge.Cuts', 'demo', 'protel')).toBe('demo.GM1')
    expect(gerberFileName('In1.Cu', 'demo', 'protel')).toBe('demo.G1')
  })

  it("names gerbers with KiCad's .gbr suffixes", () => {
    expect(gerberFileName('F.Cu', 'demo', 'kicad')).toBe('demo-F_Cu.gbr')
    expect(gerberFileName('Edge.Cuts', 'demo', 'kicad')).toBe('demo-Edge_Cuts.gbr')
  })

  it('packages JLCPCB as protel gerbers and split drills, zipping only those', () => {
    const layers = ['F.Cu', 'B.Cu', 'Edge.Cuts']
    const profile = {
      ...jlc,
      outputs: { ...jlc.outputs, gerber: { ...jlc.outputs.gerber, layers } }
    }
    const pkg = exportPackage(board, profile, { boardName: 'demo' })
    const names = pkg.files.map((f) => f.name)
    expect(names).toEqual(
      expect.arrayContaining([
        'demo.GTL',
        'demo.GBL',
        'demo.GM1',
        'demo-PTH.drl',
        'demo-bom.csv',
        'demo-pos.csv'
      ])
    )
    // Protel packages carry no .gbrjob unless asked.
    expect(names.some((n) => n.endsWith('.gbrjob'))).toBe(false)
    expect(pkg.archive?.name).toBe('demo-gerbers.zip')
    expect(pkg.archive?.files).not.toContain('demo-bom.csv')
    expect(pkg.archive?.files).toContain('demo-PTH.drl')
  })

  it("writes KiCad's names and a .gbrjob by default", () => {
    const out = exportGerbers(
      board,
      { layers: ['F.Cu', 'B.Cu', 'Edge.Cuts'] },
      { boardName: 'demo' }
    )
    const names = out.files.map((f) => f.name)
    expect(names).toContain('demo-F_Cu.gbr')
    expect(names).toContain('demo.gbrjob')
  })

  it('merges plated and non-plated holes into one file when asked', () => {
    const named = (separatePlated?: boolean): string[] =>
      exportDrill(board, { separatePlated }, { boardName: 'demo' }).files.map((f) => f.name)
    expect(named(false)).toEqual(['demo.drl'])
    // Split by default; here only plated holes exist.
    expect(named(undefined)).toEqual(['demo-PTH.drl'])
  })
})

// A custom pad: a 1×1 anchor at the pad origin, a filled 2×1 polygon out to the
// right at width 0.2, and an unfilled circle out to the left.
const CUSTOM_PAD_BOARD = `
(kicad_pcb (version 20221018) (generator pcbnew)
  (general (thickness 1.6))
  (paper "A4")
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (38 "F.Mask" user))
  (setup (pad_to_mask_clearance 0))
  (net 0 "")
  (footprint "CP" (layer "F.Cu") (at 40 60)
    (pad "1" smd custom (at 0 0) (size 1 1) (layers "F.Cu" "F.Mask")
      (options (clearance outline) (anchor rect))
      (primitives
        (gr_poly (pts (xy 2 -0.5) (xy 4 -0.5) (xy 4 0.5) (xy 2 0.5)) (width 0.2) (fill yes))
        (gr_circle (center -3 0) (end -2.5 0) (width 0.1) (fill no))))))
`

describe('custom pads plot their primitives', () => {
  // Checked against KiCad 10's own plot of the same board, whose FreePoly
  // aperture macros come back at x[1.9,4.1] for the polygon (inflated by its
  // width/2) and an outer radius of 0.545 for the ring. We emit regions and
  // strokes rather than macros — same painted copper, a shape our own parser
  // accepts.
  const plotted = (src: string, layer = 'F.Cu'): ReturnType<typeof writeGerberLayer> =>
    writeGerberLayer(parseKicadBoard(src), layer)

  it('covers the primitives, not a bounding box around them', () => {
    const layer = plotted(CUSTOM_PAD_BOARD)
    const bounds = parseGerber(layer.content).bounds
    // Ring at local -3 with outer radius 0.545, polygon out to local 4 + 0.1.
    expect(bounds.minX).toBeCloseTo(36.455, 3)
    expect(bounds.maxX).toBeCloseTo(44.1, 3)
    expect(bounds.maxY - bounds.minY).toBeCloseTo(1.2, 3)
    expect(layer.warnings).toEqual([])
  })

  it('anchors on a circle when the pad names no anchor', () => {
    // KiCad's default, read back from the aperture macro a pad with no
    // `(options …)` flashes: a disc, not the square its `size` might suggest.
    const withOptions = (opts: string): string =>
      CUSTOM_PAD_BOARD.replace('(options (clearance outline) (anchor rect))', opts)
    const none = plotted(withOptions('')).content
    expect(none).toBe(plotted(withOptions('(options (anchor circle))')).content)
    expect(none).not.toBe(plotted(withOptions('(options (anchor rect))')).content)
  })

  it('inflates every piece for the mask, not just the anchor', () => {
    const expanded = CUSTOM_PAD_BOARD.replace(
      '(pad_to_mask_clearance 0)',
      '(pad_to_mask_clearance 0.1)'
    )
    const tight = parseGerber(plotted(CUSTOM_PAD_BOARD, 'F.Mask').content).bounds
    const loose = parseGerber(plotted(expanded, 'F.Mask').content).bounds
    expect(loose.maxX - tight.maxX).toBeCloseTo(0.1, 3)
    expect(tight.minX - loose.minX).toBeCloseTo(0.1, 3)
  })
})

// A board whose only mask features are vias, so a flash count IS the tenting
// answer. Board default tents both sides; the two vias override it.
const TENTING_BOARD = `
(kicad_pcb (version 20221018) (generator pcbnew)
  (general (thickness 1.6))
  (paper "A4")
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (38 "F.Mask" user) (39 "B.Mask" user))
  (setup (pad_to_mask_clearance 0) (tenting (front yes) (back yes)))
  (net 0 "")
  (via (at 10 10) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu"))
  (via (at 20 10) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu")
    (tenting (front no) (back no)))
  (via (at 30 10) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu")
    (tenting (front yes) (back no))))
`

describe('via tenting decides what the mask opens', () => {
  // Probed against KiCad 10 by plotting the same board: `yes` = tented = no
  // opening, a per-via node overrides the board default per side, and a board
  // with no `(setup (tenting …))` at all tents both sides. The aperture is the
  // via size plus twice `pad_to_mask_clearance`.
  const flashes = (src: string, layer: string): string[] =>
    writeGerberLayer(parseKicadBoard(src), layer).content.match(/X(-?\d+)Y-?\d+D03\*/g) ?? []

  it('opens only where a via is untented, per side', () => {
    // Front: via 2 only. Back: vias 2 and 3, whose back is `no`.
    expect(flashes(TENTING_BOARD, 'F.Mask')).toEqual(['X20000000Y-10000000D03*'])
    expect(flashes(TENTING_BOARD, 'B.Mask')).toEqual([
      'X20000000Y-10000000D03*',
      'X30000000Y-10000000D03*'
    ])
  })

  it('tents by default when the board says nothing', () => {
    const noSetup = TENTING_BOARD.replace('(tenting (front yes) (back yes))', '')
    expect(flashes(noSetup, 'F.Mask')).toEqual(['X20000000Y-10000000D03*'])
  })

  it('sizes the opening from the via and the board mask clearance', () => {
    const expanded = TENTING_BOARD.replace(
      '(pad_to_mask_clearance 0)',
      '(pad_to_mask_clearance 0.1)'
    )
    expect(writeGerberLayer(parseKicadBoard(TENTING_BOARD), 'F.Mask').content).toContain('C,0.8')
    expect(writeGerberLayer(parseKicadBoard(expanded), 'F.Mask').content).toContain('C,1')
  })

  it('leaves paste alone — a via has no stencil aperture', () => {
    const withPaste = TENTING_BOARD.replace(
      '(38 "F.Mask" user)',
      '(38 "F.Mask" user) (34 "F.Paste" user)'
    )
    expect(flashes(withPaste, 'F.Paste')).toEqual([])
  })
})

// A board built to exercise silk clipping: a closed 40×40 outline, one SMD pad
// with a mask opening at its center, a silk line straight through that pad, a
// silk line crossing the right board edge, one entirely off the board, and one
// nowhere near anything.
const SILK_BOARD = `
(kicad_pcb (version 20221018) (generator pcbnew)
  (general (thickness 1.6))
  (layers
    (0 "F.Cu" signal) (31 "B.Cu" signal)
    (36 "F.SilkS" user) (38 "F.Mask" user) (44 "Edge.Cuts" user))
  (net 0 "")
  (footprint "PAD" (layer "F.Cu") (at 20 20)
    (pad "1" smd rect (at 0 0) (size 2 2) (layers "F.Cu" "F.Mask")))
  (gr_line (start 16 20) (end 24 20) (layer "F.SilkS") (stroke (width 0.2) (type solid)))
  (gr_line (start 36 10) (end 44 10) (layer "F.SilkS") (stroke (width 0.2) (type solid)))
  (gr_line (start 50 20) (end 55 20) (layer "F.SilkS") (stroke (width 0.2) (type solid)))
  (gr_line (start 5 30) (end 10 30) (layer "F.SilkS") (stroke (width 0.2) (type solid)))
  (gr_line (start 0 0) (end 40 0) (layer "Edge.Cuts") (stroke (width 0.1) (type solid)))
  (gr_line (start 40 0) (end 40 40) (layer "Edge.Cuts") (stroke (width 0.1) (type solid)))
  (gr_line (start 40 40) (end 0 40) (layer "Edge.Cuts") (stroke (width 0.1) (type solid)))
  (gr_line (start 0 40) (end 0 0) (layer "Edge.Cuts") (stroke (width 0.1) (type solid))))
`

/** Does any dark item of the image cover the given point (Gerber space)? */
const covers = (image: GerberImage, x: number, y: number): boolean =>
  image.items.some(({ shape }) => {
    switch (shape.kind) {
      case 'capsule': {
        const dx = shape.x1 - shape.x0
        const dy = shape.y1 - shape.y0
        const len2 = dx * dx + dy * dy
        const t =
          len2 === 0
            ? 0
            : Math.max(0, Math.min(1, ((x - shape.x0) * dx + (y - shape.y0) * dy) / len2))
        const px = shape.x0 + t * dx
        const py = shape.y0 + t * dy
        return Math.hypot(x - px, y - py) <= shape.halfWidth
      }
      case 'poly': {
        let inside = false
        const ring = shape.outline
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const a = ring[i]
          const b = ring[j]
          if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) {
            inside = !inside
          }
        }
        return inside
      }
      default:
        return false
    }
  })

describe('silkscreen clipping (mask openings + board outline)', () => {
  const silkBoard = parseKicadBoard(SILK_BOARD)

  beforeAll(async () => {
    await loadClipper()
  })

  // KiCad y-down lands in negative Gerber y: board point (x, y) → (x, −y).
  it('opens the mask window in silk that crosses a pad', () => {
    const layer = writeGerberLayer(silkBoard, 'F.SilkS')
    expect(layer.warnings).toEqual([])
    const image = parseGerber(layer.content)
    // Over the pad: nothing. On the line but clear of the pad: still silk.
    expect(covers(image, 20, -20)).toBe(false)
    expect(covers(image, 16.5, -20)).toBe(true)
    expect(covers(image, 23.5, -20)).toBe(true)
    // The clipped pieces are regions; the untouched line is still a stroke.
    expect(layer.content).toContain('G36*')
  })

  it('trims silk at the board edge and drops silk fully off the board', () => {
    const image = parseGerber(writeGerberLayer(silkBoard, 'F.SilkS').content)
    expect(covers(image, 37, -10)).toBe(true)
    expect(covers(image, 41, -10)).toBe(false)
    // The wholly off-board line at x 50..55 is gone entirely.
    expect(covers(image, 52.5, -20)).toBe(false)
    expect(image.bounds.maxX).toBeLessThanOrEqual(40.01)
  })

  it('leaves silk clear of pads and edges as plain strokes', () => {
    const image = parseGerber(writeGerberLayer(silkBoard, 'F.SilkS').content)
    expect(covers(image, 7.5, -30)).toBe(true)
    expect(
      image.items.some((i) => i.shape.kind === 'capsule' && Math.abs(i.shape.y0 + 30) < 0.01)
    ).toBe(true)
  })

  it('honors the opt-outs and reproduces unclipped output', () => {
    const layer = writeGerberLayer(silkBoard, 'F.SilkS', {
      subtractMaskFromSilk: false,
      clipSilkToOutline: false
    })
    expect(layer.content).not.toContain('G36*')
    const image = parseGerber(layer.content)
    expect(covers(image, 20, -20)).toBe(true)
    expect(covers(image, 52.5, -20)).toBe(true)
  })

  it('subtracts graphics drawn on the mask layer, not just pads', () => {
    const withMaskRect = parseKicadBoard(
      SILK_BOARD.replace(
        '(gr_line (start 0 0) (end 40 0) (layer "Edge.Cuts")',
        '(gr_rect (start 6 28) (end 9 32) (layer "F.Mask") (stroke (width 0.1) (type solid)) (fill solid))\n  (gr_line (start 0 0) (end 40 0) (layer "Edge.Cuts")'
      )
    )
    const image = parseGerber(writeGerberLayer(withMaskRect, 'F.SilkS').content)
    // The 5..10 silk line at y 30 now dies inside the 6..9 mask rectangle.
    expect(covers(image, 7.5, -30)).toBe(false)
    expect(covers(image, 5.5, -30)).toBe(true)
    expect(covers(image, 9.5, -30)).toBe(true)
  })

  it('is deterministic with clipping active', () => {
    expect(writeGerberLayer(silkBoard, 'F.SilkS').content).toBe(
      writeGerberLayer(silkBoard, 'F.SilkS').content
    )
  })
})

// A full KiCad board (hundreds of footprints, tracks, vias, zones).
const FIXTURE = CANARY_BOARD

describe('smoke test — a real KiCad board (canary)', () => {
  const canary = parseKicadBoard(readFileSync(FIXTURE, 'utf8'))

  it('generates a full JLCPCB package whose every gerber re-parses', () => {
    const pkg = exportPackage(canary, findExportProfile('jlcpcb')!, { boardName: 'canary' })
    expect(pkg.files.length).toBeGreaterThan(5)
    let copperItems = 0
    for (const file of pkg.files) {
      if (file.output !== 'gerber' || file.name.endsWith('.gbrjob')) continue
      // Every generated gerber must parse without a fatal error.
      const image = parseGerber(file.content)
      // The standard set holds back paste, which this board leaves empty.
      if (image.items.length) expect(image.bounds.maxX).toBeGreaterThanOrEqual(image.bounds.minX)
      if (file.kicadLayer === 'F.Cu') copperItems = image.items.length
    }
    // The front copper of a real board is dense.
    expect(copperItems).toBeGreaterThan(50)
    // The board has drilled holes, plated ones in their own file.
    expect(pkg.drill?.holes).toBeGreaterThan(0)
    expect(pkg.files.some((f) => f.name === 'canary-PTH.drl')).toBe(true)
  })
})

/** A two-layer board around `body`, with mask, paste and silk on both sides. */
const boardWith = (body: string, setup = '(pad_to_mask_clearance 0)'): string => `
(kicad_pcb (version 20240108) (generator pcbnew)
  (general (thickness 1.6))
  (layers
    (0 "F.Cu" signal) (31 "B.Cu" signal)
    (34 "B.Paste" user) (35 "F.Paste" user) (36 "B.SilkS" user) (37 "F.SilkS" user)
    (38 "B.Mask" user) (39 "F.Mask" user) (44 "Edge.Cuts" user) (49 "F.Fab" user))
  (setup ${setup})
  (net 0 "")
  (net 1 "GND")
  ${body})
`

describe('drills: slots, plating and the number format', () => {
  const SLOT = boardWith(`
    (footprint "J" (layer "F.Cu") (at 10 20 90)
      (pad "1" thru_hole oval (at 0 0 90) (size 1.2 2.2) (drill oval 0.6 1.6) (layers "*.Cu" "*.Mask"))
      (pad "2" np_thru_hole circle (at 3 0 90) (size 0.6 0.6) (drill 0.6) (layers "*.Cu" "*.Mask"))
      (pad "3" thru_hole circle (at 6 0 90) (size 1.2 1.2) (drill 0.6) (layers "*.Cu" "*.Mask")))
    (via (at 55 30) (size 0.6) (drill 0.6) (layers "F.Cu" "B.Cu"))`)
  const hits = collectDrillHits(parseKicadBoard(SLOT))

  it('makes an oval drill a slot along its long axis, turned with the pad', () => {
    const slot = hits.find((h) => h.slot)!
    expect(slot.diameter).toBeCloseTo(0.6, 9)
    // Drill 1.6 along the pad's y; at 90° the pad's y runs along the board's x.
    const { from, to } = slot.slot!
    expect(Math.abs(to.x - from.x)).toBeCloseTo(1, 9)
    expect(to.y - from.y).toBeCloseTo(0, 9)
    expect((from.x + to.x) / 2).toBeCloseTo(10, 9)
  })

  it('writes a slot as KiCad does, a G85 hit then back to drill mode', () => {
    const drl = writeExcellon(hits)
    expect(drl).toMatch(/^X9\.5Y-20\.0G85X10\.5Y-20\.0$/m)
    expect(drl).toMatch(/G85.*\nG05\n/)
    const preview = parseGerber(drillPreviewGerber(hits))
    expect(preview.items.filter((i) => i.shape.kind === 'capsule')).toHaveLength(1)
  })

  it('gives every coordinate a decimal point, which a zero-suppression reading would scale', () => {
    expect(writeExcellon(hits)).toContain('X55.0Y-30.0')
  })

  it('keeps plated, non-plated and via holes of one size on their own tools, each labeled', () => {
    const drl = writeExcellon(hits, { copperLayers: 2 })
    expect(drl).toContain('; #@! TF.FileFunction,MixedPlating,1,2')
    expect(drl.match(/^T\dC0\.6$/gm)).toHaveLength(3)
    for (const role of [
      'Plated,PTH,ViaDrill',
      'Plated,PTH,ComponentDrill',
      'NonPlated,NPTH,ComponentDrill'
    ])
      expect(drl).toContain(`; #@! TA.AperFunction,${role}`)
    expect(writeExcellon(hits, { file: 'npth', copperLayers: 2 })).toContain(
      'TF.FileFunction,NonPlated,1,2,NPTH'
    )
  })

  it('reads back what it wrote, hole for hole', () => {
    const read = parseExcellon(writeExcellon(hits, { copperLayers: 2 }))
    const key = (h: (typeof hits)[number]): string =>
      [h.x, h.y, h.diameter, h.plated, !!h.via, h.slot?.from.x ?? '', h.slot?.to.x ?? '']
        .map((v) => (typeof v === 'number' ? v.toFixed(4) : String(v)))
        .join()
    expect(read.hits.map(key).sort()).toEqual(hits.map(key).sort())
    expect(read.warnings).toEqual([])
  })
})

describe("plots what KiCad's plotter plots", () => {
  beforeAll(async () => {
    await loadClipper()
  })

  const layerOf = (src: string, layer: string): string =>
    writeGerberLayer(parseKicadBoard(src), layer).content
  /** Painted area, mm². */
  const area = (content: string): number =>
    gerberRegions(parseGerber(content)).reduce((sum, r) => {
      const ring = (pts: { x: number; y: number }[]): number => {
        let a = 0
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++)
          a += (pts[j].x + pts[i].x) * (pts[j].y - pts[i].y)
        return Math.abs(a) / 2
      }
      return sum + ring(r.outer) - r.holes.reduce((h, hole) => h + ring(hole), 0)
    }, 0)
  /** Whether the layer paints board point (x, y) — KiCad coordinates, y down. */
  const paints = (content: string, x: number, y: number): boolean =>
    gerberRegions(parseGerber(content)).some((r) => pointInPoly([r.outer, ...r.holes], x, -y))

  it('leaves a non-plated pad the size of its hole off copper, and keeps a larger one', () => {
    const src = boardWith(`
      (footprint "H" (layer "F.Cu") (at 10 10)
        (pad "" np_thru_hole circle (at 0 0) (size 1 1) (drill 1) (layers "*.Cu" "*.Mask"))
        (pad "" np_thru_hole circle (at 5 0) (size 2 2) (drill 1) (layers "*.Cu" "*.Mask")))`)
    const copper = layerOf(src, 'F.Cu')
    expect(paints(copper, 10, 10)).toBe(false)
    expect(paints(copper, 15.8, 10)).toBe(true)
    expect(paints(layerOf(src, 'F.Mask'), 10, 10)).toBe(true)
  })

  it('draws a filled shape with its outline stroke, which widens it by half the width', () => {
    const src = boardWith(`
      (footprint "P" (layer "F.Cu") (at 10 10)
        (fp_poly (pts (xy 0 0) (xy 1 0) (xy 1 1) (xy 0 1)) (stroke (width 0.2) (type solid))
          (fill yes) (layer "F.Paste")))`)
    // 1 × 1 plus a 0.1 band all round with rounded corners.
    expect(area(layerOf(src, 'F.Paste'))).toBeCloseTo(1 + 4 * 0.1 + Math.PI * 0.01, 3)
  })

  it('dashes a dashed stroke, 11 widths on and 4 off, restarting at each corner', () => {
    const src = boardWith(`
      (gr_line (start 0 0) (end 10 0) (stroke (width 0.1) (type dash)) (layer "F.SilkS"))`)
    const draws = layerOf(src, 'F.SilkS').match(/D01\*/g) ?? []
    // 10 mm of 1.1 on, 0.4 off: six whole dashes and a seventh cut short.
    expect(draws).toHaveLength(7)
  })

  it('plots a zone on "F&B.Cu" on both sides', () => {
    const src = boardWith(`
      (zone (net 1) (net_name "GND") (layers "F&B.Cu") (hatch edge 0.5)
        (polygon (pts (xy 0 0) (xy 10 0) (xy 10 10) (xy 0 10)))
        (filled_polygon (layer "F.Cu") (pts (xy 1 1) (xy 9 1) (xy 9 9) (xy 1 9)))
        (filled_polygon (layer "B.Cu") (pts (xy 1 1) (xy 9 1) (xy 9 9) (xy 1 9))))`)
    expect(area(layerOf(src, 'F.Cu'))).toBeCloseTo(64, 6)
    expect(area(layerOf(src, 'B.Cu'))).toBeCloseTo(64, 6)
  })

  it("puts a pad's copper at its drill offset, turned with the pad, and its hole where the pad is", () => {
    const src = boardWith(`
      (footprint "U" (layer "F.Cu") (at 10 10 90)
        (pad "1" thru_hole circle (at 0 0 90) (size 1 1) (drill 0.5 (offset 0 0.4)) (layers "*.Cu" "*.Mask")))`)
    const copper = layerOf(src, 'F.Cu')
    // Pad-local +y (down) at 90° is the board's +x.
    expect(paints(copper, 10.85, 10)).toBe(true)
    expect(paints(copper, 9.15, 10)).toBe(false)
    expect(collectDrillHits(parseKicadBoard(src))[0]).toMatchObject({ x: 10, y: -10 })
  })

  it('plots a chamfered pad with its corner cut and a trapezoid with its sides slanted', () => {
    const src = boardWith(`
      (footprint "C" (layer "F.Cu") (at 10 10)
        (pad "1" smd rect (at 0 0) (size 2 2) (layers "F.Cu")
          (chamfer_ratio 0.25) (chamfer top_left))
        (pad "2" smd trapezoid (at 5 0) (size 2 2) (rect_delta 0 1) (layers "F.Cu")))`)
    const copper = layerOf(src, 'F.Cu')
    expect(paints(copper, 9.05, 9.05)).toBe(false)
    expect(paints(copper, 10.95, 9.05)).toBe(true)
    // A 2 × 2 chamfered by 0.5 at one corner, and a trapezoid of the same area as its square.
    expect(area(copper)).toBeCloseTo(4 - 0.125 + 4, 3)
    expect(paints(copper, 15.95, 9.05)).not.toBe(paints(copper, 15.95, 10.95))
  })

  it("rounds a rectangle's mask opening by the margin that grows it", () => {
    const src = boardWith(
      `(footprint "R" (layer "F.Cu") (at 10 10)
        (pad "1" smd rect (at 0 0) (size 2 2) (layers "F.Cu" "F.Mask")))`,
      '(pad_to_mask_clearance 0.2)'
    )
    const mask = layerOf(src, 'F.Mask')
    expect(paints(mask, 11.12, 11.12)).toBe(true)
    expect(paints(mask, 11.18, 11.18)).toBe(false)
    expect(area(mask)).toBeCloseTo(2.4 * 2.4 - (4 - Math.PI) * 0.04, 2)
  })

  it('plots text on copper and mask, and footprint texts with their variables resolved', () => {
    const src = boardWith(`
      (gr_text "CU" (at 5 5) (layer "F.Cu") (effects (font (size 1 1) (thickness 0.15))))
      (footprint "F" (layer "F.Cu") (at 20 20)
        (property "Reference" "R7" (at 0 3) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15))))
        (fp_text user "\${REFERENCE}" (at 0 0) (layer "F.Fab") (effects (font (size 1 1) (thickness 0.15))))
        (fp_text user "MASK" (at 0 0) (layer "F.Mask") (effects (font (size 1 1) (thickness 0.15)))))`)
    expect(area(layerOf(src, 'F.Cu'))).toBeGreaterThan(0.1)
    expect(area(layerOf(src, 'F.Mask'))).toBeGreaterThan(0.1)
    const literal = src.replace('"${REFERENCE}"', '"R7"')
    expect(layerOf(src, 'F.Fab')).toBe(layerOf(literal, 'F.Fab'))
  })

  it('plots a TrueType text from the outlines saved with it, while they are for this text', () => {
    const src = boardWith(`
      (gr_text "AB" (at 10 10) (layer "F.SilkS")
        (effects (font (face "Some Face") (size 1 1) (thickness 0.15)))
        (render_cache "AB" 0
          (polygon (pts (xy 9 9) (xy 11 9) (xy 11 11) (xy 9 11)))))`)
    expect(area(layerOf(src, 'F.SilkS'))).toBeCloseTo(4, 6)
    // Stale outlines (other text) fall back to the stroke font.
    expect(area(layerOf(src.replace('"AB" 0', '"XY" 0'), 'F.SilkS'))).not.toBeCloseTo(4, 2)
  })

  it('cuts knockout text out of its box, grown by a ninth of the height', () => {
    const src = boardWith(`
      (gr_text "I" (at 10 10) (layer "F.SilkS" knockout)
        (effects (font (size 1.8 1.8) (thickness 0.2))))`)
    const silk = layerOf(src, 'F.SilkS')
    expect(paints(silk, 10, 10)).toBe(false)
    // The glyph's box, grown by 0.2 (1.8 / 9): just left of the stroke is box.
    expect(paints(silk, 9.75, 10)).toBe(true)
  })

  it('heals mask openings closer than the board minimum web into one', () => {
    const pads = `(footprint "Q" (layer "F.Cu") (at 10 10)
        (pad "1" smd rect (at 0 0) (size 0.3 1) (layers "F.Cu" "F.Mask"))
        (pad "2" smd rect (at 0.5 0) (size 0.3 1) (layers "F.Cu" "F.Mask")))`
    const apart = layerOf(boardWith(pads), 'F.Mask')
    const healed = layerOf(
      boardWith(pads, '(pad_to_mask_clearance 0) (solder_mask_min_width 0.25)'),
      'F.Mask'
    )
    expect(paints(apart, 10.25, 10)).toBe(false)
    expect(paints(healed, 10.25, 10)).toBe(true)
  })

  it('opens the mask over an exposed track and plots zones on mask and outline layers', () => {
    const src = boardWith(`
      (segment (start 0 5) (end 10 5) (width 0.2) (layers "F.Cu" "F.Mask") (solder_mask_margin 0.1) (net 1))
      (zone (net 0) (net_name "") (layers "*.Mask") (hatch edge 0.5)
        (polygon (pts (xy 20 0) (xy 22 0) (xy 22 2) (xy 20 2)))
        (filled_polygon (layer "F.Mask") (pts (xy 20 0) (xy 22 0) (xy 22 2) (xy 20 2)))
        (filled_polygon (layer "B.Mask") (pts (xy 20 0) (xy 22 0) (xy 22 2) (xy 20 2))))`)
    const mask = layerOf(src, 'F.Mask')
    expect(paints(mask, 5, 5.19)).toBe(true)
    expect(paints(mask, 21, 1)).toBe(true)
    expect(paints(layerOf(src, 'B.Mask'), 21, 1)).toBe(true)
  })

  it('draws text boxes, dimensions and alignment targets, and rounds a rectangle by its radius', () => {
    const src = boardWith(`
      (gr_text_box "T" (start 0 0) (end 6 3) (layer "F.SilkS")
        (effects (font (size 1 1) (thickness 0.15)) (justify left top))
        (border yes) (stroke (width 0.1) (type solid)))
      (target plus (at 20 20) (size 3) (width 0.1) (layer "Edge.Cuts"))
      (gr_rect (start 30 0) (end 40 10) (radius 2) (stroke (width 0.1) (type solid)) (fill no) (layer "Edge.Cuts"))`)
    // The rounded rectangle closes an outline the box sits outside: plot the silk unclipped.
    const silk = writeGerberLayer(parseKicadBoard(src), 'F.SilkS', { clipSilkToOutline: false })
    expect(paints(silk.content, 3, 0)).toBe(true)
    const edge = layerOf(src, 'Edge.Cuts')
    expect(paints(edge, 21.5, 20)).toBe(true)
    expect(paints(edge, 20, 21)).toBe(true)
    // A square corner would pass through (30, 0); the rounded one does not.
    expect(paints(edge, 30, 0)).toBe(false)
    expect(paints(edge, 32, 0)).toBe(true)
  })

  it("resolves a text's variables from the project the caller passes", () => {
    const src = boardWith(`
      (gr_text "\${REV}" (at 10 10) (layer "F.Cu") (effects (font (size 1 1) (thickness 0.15))))`)
    const board = parseKicadBoard(src)
    const resolved = writeGerberLayer(board, 'F.Cu', { textVariables: { REV: 'A' } }).content
    const literal = writeGerberLayer(
      parseKicadBoard(src.replace('"${REV}"', '"A"')),
      'F.Cu'
    ).content
    expect(resolved).toBe(literal)
  })

  it('drops a ring nothing joins on an inner layer, and plots no padstack layer of no extent', () => {
    const four = `(kicad_pcb (version 20240108) (generator pcbnew)
      (general (thickness 1.6))
      (layers (0 "F.Cu" signal) (1 "In1.Cu" signal) (2 "In2.Cu" signal) (31 "B.Cu" signal))
      (net 0 "") (net 1 "N")
      (via (at 10 10) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (remove_unused_layers yes) (keep_end_layers yes) (net 1))
      (footprint "P" (layer "F.Cu") (at 20 10)
        (pad "1" thru_hole rect (at 0 0) (size 1 1) (drill 0.5) (layers "*.Cu")
          (padstack (mode custom)
            (layer "F.Cu" (shape rect) (size 1 1))
            (layer "In1.Cu" (shape rect) (size 1 -1))
            (layer "In2.Cu" (shape rect) (size 1 1))
            (layer "B.Cu" (shape rect) (size 1 1))))))`
    expect(paints(layerOf(four, 'F.Cu'), 10, 10)).toBe(true)
    expect(paints(layerOf(four, 'In1.Cu'), 10, 10)).toBe(false)
    expect(paints(layerOf(four, 'In1.Cu'), 20, 10)).toBe(false)
    expect(paints(layerOf(four, 'In2.Cu'), 20, 10)).toBe(true)
  })

  it('leaves the named corners of a chamfered pad sharp at a ratio of 0', () => {
    const src = boardWith(`
      (footprint "C" (layer "F.Cu") (at 10 10)
        (pad "1" smd roundrect (at 0 0) (size 2 2) (layers "F.Cu")
          (roundrect_rratio 0.5) (chamfer_ratio 0) (chamfer top_left)))`)
    const copper = layerOf(src, 'F.Cu')
    expect(paints(copper, 9.03, 9.03)).toBe(true)
    expect(paints(copper, 10.97, 10.97)).toBe(false)
  })
})
