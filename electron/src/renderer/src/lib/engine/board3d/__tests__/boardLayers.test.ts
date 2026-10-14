import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseKicadBoard } from '../../../kicad/board'
import { buildBoardLayers } from '../boardLayers'
import { CANARY_BOARD } from '../../../__tests__/canaryFixture'

// One of everything the builder routes: SMD and through-hole pads, a track, a
// via, a zone fill, silkscreen graphics and text, and a comment-layer line.
const BOARD = parseKicadBoard(`
(kicad_pcb (version 20221018) (generator pcbnew)
  (general (thickness 1.6))
  (layers
    (0 "F.Cu" signal) (1 "In1.Cu" signal) (31 "B.Cu" signal)
    (36 "F.SilkS" user) (34 "F.Paste" user) (38 "F.Mask" user)
    (44 "Edge.Cuts" user) (46 "Cmts.User" user))
  (net 0 "")
  (net 1 "GND")
  (footprint "R_0603" (layer "F.Cu") (at 10 10 90)
    (property "Reference" "R1" (at 0 -1 90) (layer "F.SilkS")
      (effects (font (size 1 1) (thickness 0.15))))
    (pad "1" smd roundrect (at -0.8 0 90) (size 0.9 0.8)
      (layers "F.Cu" "F.Paste" "F.Mask") (roundrect_rratio 0.25))
    (fp_line (start -1 -0.5) (end 1 -0.5) (layer "F.SilkS") (stroke (width 0.12))))
  (footprint "D_TH" (layer "B.Cu") (at 20 20)
    (pad "1" thru_hole circle (at 0 0) (size 1.6 1.6) (drill 0.8) (layers "*.Cu" "*.Mask"))
    (pad "2" np_thru_hole circle (at 3 0) (size 2 2) (drill 2) (layers "*.Cu")))
  (segment (start 10 10) (end 20 10) (width 0.25) (layer "F.Cu") (net 1))
  (segment (start 20 10) (end 20 20) (width 0.25) (layer "B.Cu") (net 1))
  (via (at 15 12) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 1))
  (gr_line (start 0 0) (end 40 0) (layer "Cmts.User") (stroke (width 0.15)))
  (gr_line (start 0 0) (end 40 0) (layer "Edge.Cuts") (stroke (width 0.1)))
  (zone (net 1) (net_name "GND") (layers "F.Cu")
    (polygon (pts (xy 0 0) (xy 40 0) (xy 40 40) (xy 0 40)))
    (filled_polygon (layer "F.Cu") (pts (xy 1 1) (xy 39 1) (xy 39 39) (xy 1 39)))))
`)

const layers = buildBoardLayers(BOARD)

describe('buildBoardLayers', () => {
  it('separates masked copper from mask-opened pad copper', () => {
    // Track + zone + via annulus land in copper; the pads land in pads.
    expect(layers.copper.get('F.Cu')?.isEmpty).toBe(false)
    expect(layers.copper.get('B.Cu')?.isEmpty).toBe(false)
    expect(layers.pads.get('F.Cu')?.isEmpty).toBe(false)
  })

  it('puts a `*.Cu` through-hole pad on every copper layer the board has', () => {
    // Only the through-hole footprint reaches In1.Cu — no track or zone does.
    expect(layers.pads.get('In1.Cu')?.isEmpty).toBe(false)
    expect(layers.copper.has('In1.Cu')).toBe(false)
  })

  it('routes silkscreen graphics and reference text to the silk layer', () => {
    expect(layers.silk.get('F.SilkS')?.isEmpty).toBe(false)
    // The reference alone is many stroke capsules; the fp_line is one more.
    expect(layers.silk.get('F.SilkS')!.triangleCount).toBeGreaterThan(20)
  })

  it('routes paste-layer pads to paste, not to copper', () => {
    expect(layers.paste.get('F.Paste')?.isEmpty).toBe(false)
    expect(layers.paste.has('F.Cu')).toBe(false)
  })

  it('collects the comment layer and leaves Edge.Cuts to the outline builder', () => {
    expect(layers.drawings.isEmpty).toBe(false)
    // Both gr_lines are the same geometry; only the Cmts.User one is drawn, so
    // a single stroke's worth of triangles is the tell.
    const edgeOnly = buildBoardLayers(
      parseKicadBoard(`
(kicad_pcb (version 20221018) (layers (44 "Edge.Cuts" user)) (net 0 "")
  (gr_line (start 0 0) (end 40 0) (layer "Edge.Cuts") (stroke (width 0.1))))
`)
    )
    expect(edgeOnly.drawings.isEmpty).toBe(true)
  })

  it('collects one drill per through-hole pad and via, plated where it should be', () => {
    // Two pads (one plated, one not) plus the via.
    expect(layers.holes).toHaveLength(3)
    expect(layers.holes.filter((h) => h.plated)).toHaveLength(2)
    const via = layers.holes.find((h) => h.halfW === 0.15)
    expect(via).toMatchObject({ x: 15, y: -12, plated: true })
  })

  it('models a round drill as an equal-sided round-rect', () => {
    const npth = layers.holes.find((h) => !h.plated)!
    expect(npth.halfW).toBe(1)
    expect(npth.halfH).toBe(1)
    expect(npth.cornerR).toBe(1)
  })

  // The defect this guards: a drilled pad drawn as a solid disc covers its own
  // bore, and the board reads as undrilled from directly above even though the
  // substrate is cut and the barrel is in place.
  it('leaves the bore open in a drilled pad, rather than lidding it', () => {
    const drilled = buildBoardLayers(
      parseKicadBoard(`
(kicad_pcb (version 20221018) (layers (0 "F.Cu" signal) (31 "B.Cu" signal)) (net 0 "")
  (footprint "TH" (layer "F.Cu") (at 0 0)
    (pad "1" thru_hole circle (at 0 0) (size 1.7 1.7) (drill 1.0) (layers "*.Cu"))))
`)
    )
    const solid = buildBoardLayers(
      parseKicadBoard(`
(kicad_pcb (version 20221018) (layers (0 "F.Cu" signal) (31 "B.Cu" signal)) (net 0 "")
  (footprint "SMD" (layer "F.Cu") (at 0 0)
    (pad "1" smd circle (at 0 0) (size 1.7 1.7) (layers "F.Cu"))))
`)
    )
    // Same outline, but the annulus is triangulated around a hole, so it needs
    // strictly more triangles than the disc of identical size.
    const ring = drilled.pads.get('F.Cu')!.triangleCount
    const disc = solid.pads.get('F.Cu')!.triangleCount
    expect(ring).toBeGreaterThan(disc)
    expect(drilled.holes).toHaveLength(1)
  })

  it('leaves the bore open in a via too, for the same reason', () => {
    const vias = buildBoardLayers(
      parseKicadBoard(`
(kicad_pcb (version 20221018) (layers (0 "F.Cu" signal) (31 "B.Cu" signal)) (net 0 "")
  (via (at 5 5) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 0)))
`)
    )
    // A ring is quads round the circumference; a disc is a fan of the same
    // segment count. Equal triangle counts would mean the middle got filled.
    const ring = vias.copper.get('F.Cu')!.triangleCount
    const disc = buildBoardLayers(
      parseKicadBoard(`
(kicad_pcb (version 20221018) (layers (0 "F.Cu" signal) (31 "B.Cu" signal)) (net 0 "")
  (via (at 5 5) (size 0.6) (drill 0) (layers "F.Cu" "B.Cu") (net 0)))
`)
    ).copper.get('F.Cu')!.triangleCount
    expect(ring).toBeGreaterThan(disc)
    expect(vias.holes).toHaveLength(1)
  })

  it('draws no copper at all where the drill swallows the pad', () => {
    // An unplated mounting hole whose pad exists only to carry the drill.
    const mount = buildBoardLayers(
      parseKicadBoard(`
(kicad_pcb (version 20221018) (layers (0 "F.Cu" signal)) (net 0 "")
  (footprint "Mount" (layer "F.Cu") (at 0 0)
    (pad "" np_thru_hole circle (at 0 0) (size 3.2 3.2) (drill 3.2) (layers "*.Cu"))))
`)
    )
    expect(mount.pads.get('F.Cu')?.isEmpty ?? true).toBe(true)
    expect(mount.holes).toHaveLength(1)
    expect(mount.holes[0].plated).toBe(false)
  })

  it('keeps an oval (slot) drill open too', () => {
    const slot = buildBoardLayers(
      parseKicadBoard(`
(kicad_pcb (version 20221018) (layers (0 "F.Cu" signal)) (net 0 "")
  (footprint "Slot" (layer "F.Cu") (at 0 0)
    (pad "1" thru_hole oval (at 0 0) (size 3 4) (drill oval 1 2) (layers "*.Cu"))))
`)
    )
    expect(slot.holes[0]).toMatchObject({ halfW: 0.5, halfH: 1 })
    expect(slot.pads.get('F.Cu')?.isEmpty).toBe(false)
  })

  it('emits nothing for an empty board', () => {
    const empty = buildBoardLayers(
      parseKicadBoard('(kicad_pcb (version 20221018) (layers (0 "F.Cu" signal)) (net 0 ""))')
    )
    expect(empty.copper.size).toBe(0)
    expect(empty.holes).toEqual([])
    expect(empty.drawings.isEmpty).toBe(true)
  })
})

const FIXTURE = CANARY_BOARD

describe('smoke test — a real KiCad board', () => {
  it('builds dense outer copper, silk and drills without throwing', () => {
    const real = buildBoardLayers(parseKicadBoard(readFileSync(FIXTURE, 'utf8')))
    expect(real.copper.get('F.Cu')!.triangleCount).toBeGreaterThan(500)
    expect(real.pads.get('F.Cu')!.triangleCount).toBeGreaterThan(100)
    expect(real.silk.get('F.SilkS')!.triangleCount).toBeGreaterThan(100)
    expect(real.holes.length).toBeGreaterThan(10)
  })
})
