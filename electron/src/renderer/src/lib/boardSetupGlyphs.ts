// Diagram glyphs for the Board Setup setting cards.
//
// Explainers, not decoration: each shows the thing its setting measures. One
// system for all of them, so the page reads as one set:
//
// - A 32x32 tile, drawn on that grid (shown at 40px, set in PcbBoardSetup).
// - Two views, never mixed within a glyph. A constraint is a PLAN view, a patch
//   of board seen from above on its mask; a stackup setting (and a microvia,
//   which is a matter of the build) is a SECTION, the board cut edge-on, its
//   layers straight on the page. Where there is no board — outside its edge,
//   through a hole — the page shows.
// - Materials in their own colors, the ones the stackup table and its 3D
//   drawing use (`KIND_SWATCHES`), so a glyph agrees with the rows beside it.
// - The value the setting sets is the one thing drawn in the theme's light
//   text color: a thin line with end ticks. It is the only part that is not a
//   material, so it is the only part that is not a material's color.

import { KIND_SWATCHES } from './board/boardSetupSchema'

/** What a part is, which is what gives it its color (`GLYPH_PALETTE`, and CSS for the rest). */
export type GlyphRole =
  | 'copper'
  /** A construction line — what stands in for a shape, not a material: dashed, muted. */
  | 'guide'
  | 'hole'
  /** The board's surface in a plan view. */
  | 'mask'
  | 'dielectric'
  | 'silk'
  /** Plating on a pad (the surface finish). */
  | 'finish'
  /** The value the setting sets. */
  | 'dim'

export interface GlyphPart {
  d: string
  role: GlyphRole
  /** Filled shapes; default is stroked. */
  fill?: boolean
  /** A stroked path at track weight — an arc drawn as the track it is. */
  wide?: boolean
  /** A stroke's width in grid units, for ink drawn as the pen that plots it. */
  weight?: number
}

/** Material colors, one home with the stackup rows' swatches. */
export const GLYPH_PALETTE = {
  copper: KIND_SWATCHES.copper,
  dielectric: KIND_SWATCHES.dielectric,
  mask: KIND_SWATCHES.mask,
  silk: KIND_SWATCHES.silk,
  /** ENIG-ish gold, the 3D view's pad finish. */
  finish: '#d9b45c'
} as const

const TILE = 'M3 0h26a3 3 0 013 3v26a3 3 0 01-3 3H3a3 3 0 01-3-3V3a3 3 0 013-3z'

const rect = (x: number, y: number, w: number, h: number): string => `M${x} ${y}h${w}v${h}h${-w}z`
const circle = (cx: number, cy: number, r: number): string =>
  `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0z`

const fill = (role: GlyphRole, d: string): GlyphPart => ({ d, role, fill: true })
const copper = (d: string): GlyphPart => fill('copper', d)
const hole = (d: string): GlyphPart => fill('hole', d)
const dielectric = (d: string): GlyphPart => fill('dielectric', d)

/** A track drawn as the copper it is, at track weight. */
const track = (d: string): GlyphPart => ({ d, role: 'copper', wide: true })
/** A board patch seen from above: the mask's green, then what is on it. */
const plan = (...parts: GlyphPart[]): GlyphPart[] => [fill('mask', TILE), ...parts]
/** A plan view of a board that stops short of the tile: `ground` is the board's shape. */
const planEdge = (ground: string, ...parts: GlyphPart[]): GlyphPart[] => [
  fill('mask', ground),
  ...parts
]
/** The board cut edge-on: its layers as bands, on the page itself. */
const section = (...parts: GlyphPart[]): GlyphPart[] => parts

/** A horizontal measure from x1 to x2 at y (all on .5), with end ticks. */
const dimH = (x1: number, x2: number, y: number): GlyphPart => ({
  d: `M${x1} ${y}H${x2}M${x1} ${y - 3}v6M${x2} ${y - 3}v6`,
  role: 'dim'
})
/** A vertical measure from y1 to y2 at x (all on .5), with end ticks. */
const dimV = (y1: number, y2: number, x: number): GlyphPart => ({
  d: `M${x} ${y1}V${y2}M${x - 3} ${y1}h6M${x - 3} ${y2}h6`,
  role: 'dim'
})

/** A microvia, cut: a laser-drilled cone from a surface pad down to the next foil. */
const microviaSection = (measure: GlyphPart): GlyphPart[] =>
  section(
    dielectric(rect(0, 11, 32, 13)),
    copper(rect(0, 24, 32, 3)),
    copper(rect(7, 8, 18, 3)),
    hole('M11 8h10l-3 16h-4z'),
    measure
  )

export const BOARD_SETUP_GLYPHS: Record<string, GlyphPart[]> = {
  // --- Constraints: plan views ----------------------------------------------
  // Two conductors and the gap between them.
  clearance: plan(copper(rect(4, 4, 8, 24)), copper(rect(20, 4, 8, 24)), dimH(12.5, 19.5, 16.5)),
  // One track, measured across.
  trackWidth: plan(copper(rect(11, 3, 10, 26)), dimH(11.5, 20.5, 16.5)),
  // The narrow neck copper may run down to between two areas.
  // One outline, not three shapes meeting: shown off the grid, touching edges
  // would leave a hairline seam across the neck.
  connection: plan(copper('M3 5h9v8h8V5h9v22h-9v-8h-8v8H3z'), dimV(13.5, 18.5, 16.5)),
  // The copper ring left between the drill and the pad's edge.
  annular: plan(copper(circle(16, 16, 11)), hole(circle(16, 16, 5)), dimV(5.5, 10.5, 16.5)),
  // A via, measured across its pad.
  via: plan(copper(circle(16, 16, 10)), hole(circle(16, 16, 4)), dimH(6.5, 25.5, 16.5)),
  // Copper kept back from a drilled hole's wall.
  holeClearance: plan(hole(circle(10, 16, 5)), copper(rect(20, 4, 8, 24)), dimH(15.5, 19.5, 16.5)),
  // Copper kept back from the board's edge, where the board gives way to nothing.
  edgeClearance: planEdge(
    'M8 0h21a3 3 0 013 3v26a3 3 0 01-3 3H8z',
    copper(rect(18, 4, 10, 24)),
    dimH(8.5, 17.5, 16.5)
  ),
  // A drill, measured across.
  hole: plan(copper(circle(16, 16, 11)), hole(circle(16, 16, 7)), dimH(9.5, 22.5, 16.5)),
  // Two bare drills, measured wall to wall — no pads, so it is plain the gap
  // is between the holes and not between copper.
  holeSpacing: plan(
    hole(circle(8.5, 16, 4.5)),
    hole(circle(23.5, 16, 4.5)),
    dimH(13.5, 18.5, 16.5)
  ),
  // Microvias are a matter of the build, so they are cut: the pad measured...
  microvia: microviaSection(dimH(7.5, 24.5, 4.5)),
  // ...and the drill.
  microviaDrill: microviaSection(dimH(11.5, 20.5, 4.5)),
  // Silk kept back from a pad it must not print onto.
  silkClearance: plan(
    { d: 'M6 6v20', role: 'silk' },
    copper(rect(18, 8, 10, 16)),
    dimH(7.5, 17.5, 16.5)
  ),
  // A silkscreen letter, measured on its height...
  textHeight: plan(
    { d: 'M5 25L11.5 7L18 25M7.8 19h7.4', role: 'silk', weight: 3 },
    dimV(5.5, 26.5, 26.5)
  ),
  // ...and on the weight of the pen that draws it, round-ended as plotted.
  textThickness: plan({ d: 'M16 8V20', role: 'silk', weight: 6 }, dimH(13.5, 18.5, 27.5)),
  // An arc, the chord that stands in for it, and how far the chord strays at
  // its middle — the bound the setting sets.
  arcError: plan(
    { d: 'M5 27A22 22 0 0127 5', role: 'copper', wide: true },
    { d: 'M5 27L27 5', role: 'guide' },
    { d: 'M16 16L11.5 11.5M14 18l4-4M9.5 13.5l4-4', role: 'dim' }
  ),
  // A zone's outer corner, rounded where it meets the board's edge.
  zoneFillet: planEdge('M7 7h25v22a3 3 0 01-3 3H7z', copper('M10 32V17a7 7 0 017-7h15v22z')),
  // A thermal relief: the pad, the gap round it, and the spokes across the gap.
  spokes: plan(
    copper(rect(3, 3, 26, 26)),
    fill('mask', circle(16, 16, 10)),
    copper(circle(16, 16, 6)),
    copper(rect(14, 5, 4, 6)),
    copper(rect(14, 21, 4, 6)),
    copper(rect(5, 14, 6, 4)),
    copper(rect(21, 14, 6, 4))
  ),

  // --- Length-tuning patterns: a track's meander, seen from above -------------
  // How far a bump stands off its track.
  tuneAmplitude: plan(track('M0 25H10V8h7v17h15'), dimV(8.5, 24.5, 24.5)),
  // A bump's width, which is also the gap to the next.
  tuneSpacing: plan(track('M0 25H6V9h6v16h6V9h6v16h8'), dimH(6.5, 11.5, 4.5)),
  // A bump's corner, rounded: its radius from the arc's center.
  tuneRadius: plan(track('M0 25H8V16a8 8 0 0 1 16 0v9h8'), {
    d: 'M16 16L21.5 10.5',
    role: 'dim'
  }),
  // Every bump the one way; the other side, where alternating would go, left bare.
  tuneSides: plan(track('M0 20H5V8h6v12h10V8h6v12h5'), {
    d: 'M5 20v8h6v-8M21 20v8h6v-8',
    role: 'guide'
  }),

  // --- Teardrops: a track widening into its pad, seen from above --------------
  // How far the taper runs along the track (L).
  tdLength: plan(
    copper(circle(9, 16, 6)),
    track('M9 16H32'),
    copper('M11 10.5L24 15v2L11 21.5z'),
    dimH(15.5, 23.5, 26.5)
  ),
  // How wide the taper is where it meets the pad (W).
  tdWidth: plan(
    copper(circle(9, 16, 6)),
    track('M9 16H32'),
    copper('M11 10.5L24 15v2L11 21.5z'),
    dimV(10.5, 21.5, 13.5)
  ),
  // A track this near the pad's own size gets no teardrop: w against d.
  tdTrackLimit: plan(
    copper(circle(10, 16, 6)),
    copper(rect(10, 12, 22, 8)),
    dimV(12.5, 19.5, 26.5),
    dimV(10.5, 21.5, 3.5)
  ),
  // The taper's sides drawn as curves.
  tdCurved: plan(
    copper(circle(9, 16, 6)),
    track('M9 16H32'),
    copper('M11 10.5Q15 15 24 15v2Q15 17 11 21.5z')
  ),
  // A taper longer than its first track, carried on into the next.
  tdTwoSegments: plan(
    copper(circle(8, 22, 5)),
    track('M8 22H15L25 12H32'),
    copper('M9 17L15 21v2L9 27z'),
    { d: 'M15 22l4-4', role: 'dim' }
  ),
  // A pad a pour of its net already joins: no teardrop needed.
  tdZone: plan(copper(rect(0, 19, 32, 13)), copper(circle(11, 15, 5)), track('M11 15H32')),
  // A narrow track meeting a wider one, tapered between them.
  tdTrackToTrack: plan(
    track('M0 16H14'),
    copper(rect(18, 10, 14, 12)),
    copper('M9 15L18 11v10L9 17z')
  ),

  // --- The build: sections ----------------------------------------------------
  // A via's length through the board, which length tuning may count.
  lengthTuning: section(
    copper(rect(0, 6, 32, 3)),
    dielectric(rect(0, 9, 32, 14)),
    copper(rect(0, 23, 32, 3)),
    copper(rect(10, 6, 4, 20)),
    dimV(6.5, 25.5, 24.5)
  ),
  // Copper foils between laminate.
  layers: section(
    copper(rect(0, 6, 32, 3)),
    dielectric(rect(0, 9, 32, 5)),
    copper(rect(0, 14, 32, 3)),
    dielectric(rect(0, 17, 32, 5)),
    copper(rect(0, 22, 32, 3))
  ),
  // Pads standing on the laminate, plated where the mask leaves them bare.
  finish: section(
    dielectric(rect(0, 20, 32, 7)),
    copper(rect(5, 15, 9, 5)),
    copper(rect(18, 15, 9, 5)),
    fill('mask', rect(0, 17, 5, 3)),
    fill('mask', rect(14, 17, 4, 3)),
    fill('mask', rect(27, 17, 5, 3)),
    fill('finish', rect(5, 13, 9, 2)),
    fill('finish', rect(18, 13, 9, 2))
  )
}

/** A letter a legend names a measure by, at its place on the drawing. */
export interface LegendLabel {
  x: number
  y: number
  text: string
}

/**
 * Length-tuning patterns' legends, one under each tuner's heading, as KiCad's
 * page has: a fixed drawing of the meander that tuner lays, its measures
 * lettered as the cards' labels are (A amplitude, s spacing, r corner radius).
 * Fixed, not drawn from the values, so it still reads with one of them at 0.
 * A 160x56 tile. The pair's halves turn concentric with its centerline, an r
 * of 6 each way less and more the half gap, as the pair tuner lays them
 * (router-behavior.md T5).
 */
const LEGEND_TILE = 'M3 0h154a3 3 0 013 3v50a3 3 0 01-3 3H3a3 3 0 01-3-3V3a3 3 0 013-3z'

export const TUNING_LEGENDS: Record<
  'tuneSingle' | 'tunePair' | 'tuneSkew',
  { parts: GlyphPart[]; labels: LegendLabel[] }
> = {
  // Two-sided, KiCad's default: one serpentine across the track.
  tuneSingle: {
    parts: [
      fill('mask', LEGEND_TILE),
      track(
        'M8 28H26a6 6 0 0 0 6-6V18a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6V38a6 6 0 0 0 6 6h4a6 6 0 0 0 6-6V18a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6V38a6 6 0 0 0 6 6h4a6 6 0 0 0 6-6V34a6 6 0 0 1 6-6H152'
      ),
      dimV(12.5, 27.5, 56.5),
      dimH(64.5, 79.5, 51.5),
      { d: 'M38 18L33.8 13.8', role: 'dim' }
    ],
    labels: [
      { x: 56.5, y: 8, text: 'A' },
      { x: 72, y: 45, text: 's' },
      { x: 40, y: 25, text: 'r' }
    ]
  },
  // The pair's halves either side of its meandered centerline.
  tunePair: {
    parts: [
      fill('mask', LEGEND_TILE),
      track(
        'M8 25L26 25A3 3 0 0 0 29 22L29 18A9 9 0 0 1 38 9L42 9A9 9 0 0 1 51 18L51 38A3 3 0 0 0 54 41L58 41A3 3 0 0 0 61 38L61 18A9 9 0 0 1 70 9L74 9A9 9 0 0 1 83 18L83 22A3 3 0 0 0 86 25L152 25'
      ),
      track(
        'M8 31L26 31A9 9 0 0 0 35 22L35 18A3 3 0 0 1 38 15L42 15A3 3 0 0 1 45 18L45 38A9 9 0 0 0 54 47L58 47A9 9 0 0 0 67 38L67 18A3 3 0 0 1 70 15L74 15A3 3 0 0 1 77 18L77 22A9 9 0 0 0 86 31L152 31'
      ),
      dimV(12.5, 27.5, 56.5),
      dimH(64.5, 79.5, 52.5),
      { d: 'M38 18L33.8 13.8', role: 'dim' }
    ],
    labels: [
      { x: 56.5, y: 6, text: 'A' },
      { x: 72, y: 43, text: 's' },
      { x: 40, y: 25, text: 'r' }
    ]
  },
  // One half meandered away from the other, which runs straight.
  tuneSkew: {
    parts: [
      fill('mask', LEGEND_TILE),
      track('M8 10H152'),
      track(
        'M8 20H26a6 6 0 0 1 6 6V38a6 6 0 0 0 6 6h4a6 6 0 0 0 6-6V26a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6V38a6 6 0 0 0 6 6h4a6 6 0 0 0 6-6V26a6 6 0 0 1 6-6H152'
      ),
      dimV(20.5, 43.5, 56.5),
      dimH(32.5, 47.5, 32.5),
      { d: 'M38 38L33.8 42.2', role: 'dim' }
    ],
    labels: [
      { x: 56.5, y: 53, text: 'A' },
      { x: 40, y: 29, text: 's' },
      { x: 43, y: 41, text: 'r' }
    ]
  }
}

/**
 * Teardrops' legends, one under each block's heading, as KiCad's Teardrops
 * page has: a pad (or a wider track) and the track leaving it, the taper
 * between them lettered as the cards are: L its length, W its width at the
 * pad, d the pad's size, w the track's width. A 160x56 tile, fixed.
 */
export const TEARDROP_LEGENDS: Record<
  'teardropRound' | 'teardropRect' | 'teardropTrack',
  { parts: GlyphPart[]; labels: LegendLabel[] }
> = {
  teardropRound: {
    parts: [
      fill('mask', LEGEND_TILE),
      copper(circle(40, 28, 14)),
      track('M40 28H152'),
      copper('M44 14.6L86 26.5v3L44 41.4z'),
      dimV(14.5, 41.5, 18.5),
      dimV(16.5, 39.5, 48.5),
      dimH(54.5, 85.5, 50.5),
      dimV(26.5, 29.5, 136.5)
    ],
    labels: [
      { x: 11, y: 31, text: 'd' },
      { x: 48.5, y: 11, text: 'W' },
      { x: 70, y: 46, text: 'L' },
      { x: 136.5, y: 21, text: 'w' }
    ]
  },
  teardropRect: {
    parts: [
      fill('mask', LEGEND_TILE),
      copper(rect(26, 12, 28, 32)),
      track('M40 28H152'),
      copper('M54 16L88 26.5v3L54 40z'),
      dimV(12.5, 43.5, 18.5),
      dimV(16.5, 39.5, 58.5),
      dimH(54.5, 87.5, 50.5),
      dimV(26.5, 29.5, 136.5)
    ],
    labels: [
      { x: 11, y: 31, text: 'd' },
      { x: 58.5, y: 11, text: 'W' },
      { x: 71, y: 46, text: 'L' },
      { x: 136.5, y: 21, text: 'w' }
    ]
  },
  teardropTrack: {
    parts: [
      fill('mask', LEGEND_TILE),
      track('M8 28H100'),
      copper(rect(100, 18, 52, 20)),
      copper('M68 26.5L100 20v16L68 29.5z'),
      dimH(68.5, 99.5, 48.5),
      dimV(20.5, 35.5, 106.5),
      dimV(26.5, 29.5, 30.5)
    ],
    labels: [
      { x: 84, y: 44, text: 'L' },
      { x: 106.5, y: 14, text: 'W' },
      { x: 30.5, y: 21, text: 'w' }
    ]
  }
}
