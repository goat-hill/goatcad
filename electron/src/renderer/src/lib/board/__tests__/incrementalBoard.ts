/**
 * A small contrived board for the default suite's incremental check test
 * (boardChecksIncremental.test.ts): a few of everything the harness edits and
 * the rules read — two-pad parts with silk, courtyards and references, a
 * through-hole header, tracks between the parts, vias, a filled zone on each
 * side (the back one in two islands, so a refill can drop one), an outline and
 * a custom rule — packed close enough that the seeded edits make and clear
 * findings. The parity suite holds the same harness to the sample project and
 * KiCad's corpus; this keeps the per-commit run to a fraction of a second.
 */

let uuidCount = 0
const uuid = (): string => `00000000-0000-4000-8000-${String(++uuidCount).padStart(12, '0')}`

const COLS = 4
const ROWS = 3
const PITCH_X = 5
const PITCH_Y = 4
const ORIGIN = { x: 4, y: 4 }
const BOARD = { w: 26, h: 16 }

const netOf = (row: number, col: number): string => `N${row}_${col}`

const silkLine = (x0: number, y0: number, x1: number, y1: number, layer: string): string =>
  `(fp_line (start ${x0} ${y0}) (end ${x1} ${y1}) (stroke (width 0.12) (type solid)) (layer "${layer}") (uuid "${uuid()}"))`

const part = (row: number, col: number): string => {
  const x = ORIGIN.x + col * PITCH_X
  const y = ORIGIN.y + row * PITCH_Y
  const ref = `C${row * COLS + col + 1}`
  return `(footprint "T:C_0603" (layer "F.Cu") (uuid "${uuid()}") (at ${x} ${y})
    (property "Reference" "${ref}" (at 0 -1.4 0) (layer "F.SilkS") (uuid "${uuid()}")
      (effects (font (size 0.8 0.8) (thickness 0.12))))
    (property "Value" "100n" (at 0 1.4 0) (layer "F.Fab") (uuid "${uuid()}")
      (effects (font (size 0.8 0.8) (thickness 0.12))))
    (attr smd)
    ${silkLine(-0.14, -0.51, 0.14, -0.51, 'F.SilkS')}
    ${silkLine(-0.14, 0.51, 0.14, 0.51, 'F.SilkS')}
    ${silkLine(-1.48, -0.73, 1.48, -0.73, 'F.CrtYd')}
    ${silkLine(1.48, -0.73, 1.48, 0.73, 'F.CrtYd')}
    ${silkLine(1.48, 0.73, -1.48, 0.73, 'F.CrtYd')}
    ${silkLine(-1.48, 0.73, -1.48, -0.73, 'F.CrtYd')}
    (pad "1" smd roundrect (at -0.775 0) (size 0.9 0.95) (layers "F.Cu" "F.Mask" "F.Paste")
      (roundrect_rratio 0.25) (net "${netOf(row, col)}") (uuid "${uuid()}"))
    (pad "2" smd roundrect (at 0.775 0) (size 0.9 0.95) (layers "F.Cu" "F.Mask" "F.Paste")
      (roundrect_rratio 0.25) (net "${netOf(row, col + 1)}") (uuid "${uuid()}"))
  )`
}

const header = (): string => `(footprint "T:Header_1x02" (layer "F.Cu") (uuid "${uuid()}") (at 24 7)
    (property "Reference" "J1" (at 0 -2.4 0) (layer "F.SilkS") (uuid "${uuid()}")
      (effects (font (size 0.8 0.8) (thickness 0.12))))
    (property "Value" "PWR" (at 0 4.9 0) (layer "F.Fab") (uuid "${uuid()}")
      (effects (font (size 0.8 0.8) (thickness 0.12))))
    (attr through_hole)
    ${silkLine(-1.33, -1.33, 1.33, -1.33, 'F.SilkS')}
    ${silkLine(-1.8, -1.8, 1.8, -1.8, 'F.CrtYd')}
    ${silkLine(1.8, -1.8, 1.8, 4.35, 'F.CrtYd')}
    ${silkLine(1.8, 4.35, -1.8, 4.35, 'F.CrtYd')}
    ${silkLine(-1.8, 4.35, -1.8, -1.8, 'F.CrtYd')}
    (pad "1" thru_hole rect (at 0 0) (size 1.7 1.7) (drill 1) (layers "*.Cu" "*.Mask")
      (net "GND") (uuid "${uuid()}"))
    (pad "2" thru_hole oval (at 0 2.54) (size 1.7 1.7) (drill 1) (layers "*.Cu" "*.Mask")
      (net "VCC") (uuid "${uuid()}"))
  )`

const segment = (x0: number, y0: number, x1: number, y1: number, net: string): string =>
  `(segment (start ${x0} ${y0}) (end ${x1} ${y1}) (width 0.25) (layer "F.Cu") (net "${net}") (uuid "${uuid()}"))`

const via = (x: number, y: number, net: string): string =>
  `(via (at ${x} ${y}) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net "${net}") (uuid "${uuid()}"))`

const rect = (x0: number, y0: number, x1: number, y1: number): string =>
  `(xy ${x0} ${y0}) (xy ${x1} ${y0}) (xy ${x1} ${y1}) (xy ${x0} ${y1})`

const zone = (
  net: string,
  layer: string,
  outline: string,
  fills: readonly string[]
): string => `(zone (net "${net}") (layer "${layer}") (uuid "${uuid()}") (hatch edge 0.5)
    (connect_pads (clearance 0.25)) (min_thickness 0.25)
    (fill yes (thermal_gap 0.5) (thermal_bridge_width 0.5) (island_removal_mode 1))
    (polygon (pts ${outline}))
    ${fills.map((pts) => `(filled_polygon (layer "${layer}") (pts ${pts}))`).join('\n    ')}
  )`

const edge = (x0: number, y0: number, x1: number, y1: number): string =>
  `(gr_line (start ${x0} ${y0}) (end ${x1} ${y1}) (stroke (width 0.05) (type default)) (layer "Edge.Cuts") (uuid "${uuid()}"))`

/** The board's text, the same on every call. */
export function incrementalBoard(): string {
  uuidCount = 0
  const items: string[] = []
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) items.push(part(row, col))
    // A track from each part's pad 2 to the next part's pad 1: the same net.
    for (let col = 0; col + 1 < COLS; col++) {
      const y = ORIGIN.y + row * PITCH_Y
      const x0 = ORIGIN.x + col * PITCH_X + 0.775
      const x1 = ORIGIN.x + (col + 1) * PITCH_X - 0.775
      items.push(segment(x0, y, x1, y, netOf(row, col + 1)))
    }
  }
  items.push(header())
  // GND vias between the rows, and the header's ground down to them.
  for (let col = 0; col < COLS; col++) {
    items.push(via(ORIGIN.x + col * PITCH_X + 2.5, ORIGIN.y + PITCH_Y / 2, 'GND'))
  }
  items.push(segment(19.5, 6, 24, 6, 'GND'), segment(24, 6, 24, 7, 'GND'))
  // The back ground pour in two islands, split down the middle.
  items.push(
    zone('GND', 'B.Cu', rect(0.5, 0.5, BOARD.w - 0.5, BOARD.h - 0.5), [
      rect(0.75, 0.75, 12.5, BOARD.h - 0.75),
      rect(13.5, 0.75, BOARD.w - 0.75, BOARD.h - 0.75)
    ])
  )
  // A front VCC pour along the bottom edge, close under the last row.
  items.push(
    zone('VCC', 'F.Cu', rect(0.5, 13, BOARD.w - 0.5, BOARD.h - 0.5), [
      rect(0.75, 13.25, BOARD.w - 0.75, BOARD.h - 0.75)
    ])
  )
  items.push(
    edge(0, 0, BOARD.w, 0),
    edge(BOARD.w, 0, BOARD.w, BOARD.h),
    edge(BOARD.w, BOARD.h, 0, BOARD.h),
    edge(0, BOARD.h, 0, 0)
  )
  return `(kicad_pcb
  (version 20260206)
  (generator "pcbnew")
  (generator_version "10.0")
  (general (thickness 1.6))
  (paper "A4")
  (layers
    (0 "F.Cu" signal) (2 "B.Cu" signal)
    (13 "F.Paste" user) (15 "B.Paste" user)
    (5 "F.SilkS" user "F.Silkscreen") (7 "B.SilkS" user "B.Silkscreen")
    (1 "F.Mask" user) (3 "B.Mask" user)
    (25 "Edge.Cuts" user) (31 "F.CrtYd" user "F.Courtyard") (29 "B.CrtYd" user "B.Courtyard")
    (35 "F.Fab" user) (33 "B.Fab" user))
  (setup (pad_to_mask_clearance 0))
  ${items.join('\n  ')}
)`
}

/** A custom rule, so the resolver's conditions are part of what an edit re-checks. */
export const incrementalRules = `(version 1)
(rule "ground keeps wider"
  (constraint clearance (min 0.3))
  (condition "A.NetName == 'GND'"))
`
