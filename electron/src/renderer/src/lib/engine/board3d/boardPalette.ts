/**
 * What the board is actually made of, as colors.
 *
 * The stackup a design carries already names its solder-mask and silkscreen
 * colors — that is what the fab quotes against — so the 3D view reads them out
 * of the board rather than always painting the same green. A board set up for
 * black mask and white silk looks like the thing that will arrive.
 *
 * KiCad writes either one of its named finishes (`"Green"`, `"Black"`, …) or a
 * literal `#RRGGBB`/`#RRGGBBAA`; both are handled, and anything unrecognized
 * falls back to the default rather than throwing.
 */

import type { KicadBoard, KicadStackupLayer } from '../../kicad/board'

export interface BoardPalette {
  /** Exposed substrate — the routed edge of the board. */
  substrate: string
  /** Solder mask over bare laminate. */
  mask: string
  /** Copper seen through the mask: a track reads as a raised shadow. */
  maskedCopper: string
  /** Copper with no mask over it — mask switched off. */
  bareCopper: string
  /** Pad finish in a mask opening (ENIG-ish). */
  padFinish: string
  /** Front silkscreen; each side's stackup layer names its own ink. */
  silk: string
  backSilk: string
  paste: string
  /** User drawing / comment layers floating above the board. */
  drawings: string
  /** Plated barrel inside a drilled hole. */
  holeWall: string
}

/** KiCad's named solder-mask finishes. */
export const MASK_COLORS: Record<string, string> = {
  green: '#177a41',
  red: '#a3211f',
  blue: '#17457f',
  purple: '#4a2168',
  black: '#151515',
  white: '#d6d6d6',
  yellow: '#c2a520'
}

/** KiCad's named silkscreen finishes. */
export const SILK_COLORS: Record<string, string> = {
  white: '#e6e8e4',
  black: '#141414',
  yellow: '#d8c15a'
}

/** Everything that does not come from the stackup. */
const FIXED = {
  substrate: '#b79b62',
  bareCopper: '#c08a3e',
  padFinish: '#d9b45c',
  paste: '#b9c0be',
  drawings: '#7bc0f4',
  holeWall: '#8a6a3c'
} as const

const HEX = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/i

/** A stackup color token → a CSS hex, or null when it names nothing we know. */
export function resolveStackupColor(
  value: string | undefined,
  named: Record<string, string>
): string | null {
  if (!value) return null
  const trimmed = value.trim()
  if (HEX.test(trimmed)) return `#${trimmed.slice(1, 7)}`
  return named[trimmed.toLowerCase()] ?? null
}

const findStackupLayer = (board: KicadBoard, name: string): KicadStackupLayer | undefined =>
  board.stackup?.layers.find((layer) => layer.name === name)

/**
 * Lighten/darken toward a target — how a track under mask is derived from the
 * mask color, so a black-mask board's traces stay visible instead of vanishing.
 */
function mix(from: string, to: string, amount: number): string {
  const parse = (hex: string): [number, number, number] => [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16)
  ]
  const a = parse(from)
  const b = parse(to)
  const channel = (i: number): string =>
    Math.round(a[i] + (b[i] - a[i]) * amount)
      .toString(16)
      .padStart(2, '0')
  return `#${channel(0)}${channel(1)}${channel(2)}`
}

/** Assemble a palette from a mask and silk color. One path, so the defaults
 *  and a stackup-driven set are derived the same way. */
const paletteFrom = (mask: string, silk: string, backSilk = silk): BoardPalette => ({
  ...FIXED,
  mask,
  silk,
  backSilk,
  // Copper under mask is the mask color pulled a little toward the copper —
  // one relationship at any mask color, rather than a second table.
  maskedCopper: mix(mask, FIXED.bareCopper, 0.22)
})

export const DEFAULT_BOARD_PALETTE: BoardPalette = paletteFrom(MASK_COLORS.green, SILK_COLORS.white)

/** Finishes to draw in place of the stackup's: a preview of a board not yet
 *  set up that way. Named finishes or `#RRGGBB`, as the stackup takes. */
export interface PaletteOverrides {
  mask?: string
  silk?: string
}

export function boardPalette(
  board: KicadBoard | null,
  overrides: PaletteOverrides = {}
): BoardPalette {
  const color = (
    layer: KicadStackupLayer | undefined,
    named: Record<string, string>
  ): string | null => (layer ? resolveStackupColor(layer.color, named) : null)
  const front = board ? findStackupLayer(board, 'F.SilkS') : undefined
  const back = board ? findStackupLayer(board, 'B.SilkS') : undefined
  const maskLayer = board
    ? (findStackupLayer(board, 'F.Mask') ?? findStackupLayer(board, 'B.Mask'))
    : undefined

  const override = {
    mask: resolveStackupColor(overrides.mask, MASK_COLORS),
    silk: resolveStackupColor(overrides.silk, SILK_COLORS)
  }
  // A side whose layer names no ink is KiCad's "not specified": white.
  return paletteFrom(
    override.mask ?? color(maskLayer, MASK_COLORS) ?? DEFAULT_BOARD_PALETTE.mask,
    override.silk ?? color(front, SILK_COLORS) ?? DEFAULT_BOARD_PALETTE.silk,
    override.silk ?? color(back, SILK_COLORS) ?? DEFAULT_BOARD_PALETTE.silk
  )
}
