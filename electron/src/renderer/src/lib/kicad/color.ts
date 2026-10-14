/**
 * Shared model for KiCad's `(color r g b a)` node — one encoding, one place,
 * reused by every parser/editor that reads or writes a color (symbol/graphic
 * fill + stroke, junction, wire stroke).
 *
 * KiCad encodes color as `(color R G B A)` where R/G/B are integers 0–255 and
 * A is a float 0.0–1.0. The all-zero tuple `(0 0 0 0)` is KiCad's sentinel for
 * "unset" — use the theme/net default rather than an explicit color. Callers
 * that want a nullable value map an unset tuple to `null` at the schema layer;
 * this module keeps the faithful tuple so round-trips stay lossless.
 */

import { findChild, getAtomValues, type SExprAtom, type SExprList, type SExprNode } from './sexpr'
import { HEX_COLOR } from '../../../../shared/recordRules'

export interface Rgba {
  /** 0–255 */
  r: number
  /** 0–255 */
  g: number
  /** 0–255 */
  b: number
  /** 0.0–1.0 */
  a: number
}

/** KiCad's sentinel for "no explicit color" — inherit the theme/net default. */
export const COLOR_UNSET: Rgba = { r: 0, g: 0, b: 0, a: 0 }

/** True when a color is the all-zero unset sentinel. */
export function isColorUnset(c: Rgba): boolean {
  return c.r === 0 && c.g === 0 && c.b === 0 && c.a === 0
}

const clampByte = (n: number): number => Math.max(0, Math.min(255, Math.round(n)))
const clampAlpha = (n: number): number => Math.max(0, Math.min(1, n))

/**
 * Format an alpha value the way KiCad does — a clean decimal, trailing zeros
 * trimmed (so `1`, `0.5`, `0.25`), never float noise like `0.5000000001`.
 */
function formatAlpha(a: number): string {
  return parseFloat(clampAlpha(a).toFixed(4)).toString()
}

/** Parse a `(color r g b a)` list node into an `Rgba` (missing atoms → 0). */
export function parseColorNode(node: SExprList): Rgba {
  const atoms = getAtomValues(node)
  const at = (i: number): number => {
    const v = parseFloat(atoms[i])
    return Number.isNaN(v) ? 0 : v
  }
  return { r: clampByte(at(0)), g: clampByte(at(1)), b: clampByte(at(2)), a: clampAlpha(at(3)) }
}

/**
 * Read the `(color …)` child of `root`, or `undefined` when absent. Absent is
 * distinct from an explicit unset `(0 0 0 0)` — callers that treat both the
 * same should fall back to `COLOR_UNSET`.
 */
export function parseColorChild(root: SExprList): Rgba | undefined {
  const child = findChild(root, 'color')
  return child ? parseColorNode(child) : undefined
}

const atom = (value: string, quoted: boolean, at: number): SExprAtom => ({
  type: 'atom',
  value,
  quoted,
  start: at,
  end: at
})

/** Build the four `r g b a` atoms of a `(color …)` node from an `Rgba`. */
export function colorAtoms(color: Rgba, at: number): SExprNode[] {
  return [
    atom(clampByte(color.r).toString(), false, at),
    atom(clampByte(color.g).toString(), false, at),
    atom(clampByte(color.b).toString(), false, at),
    atom(formatAlpha(color.a), false, at)
  ]
}

/**
 * Set (or create) the `(color r g b a)` child of `root`. Mutates in place so
 * unrelated children are untouched; a one-color edit diffs to only this node.
 */
export function setColorChild(root: SExprList, color: Rgba): void {
  const at = root.start
  let child = findChild(root, 'color')
  if (!child) {
    child = { type: 'list', children: [atom('color', false, at)], start: at, end: at }
    root.children.push(child)
  }
  child.children = [atom('color', false, at), ...colorAtoms(color, at)]
}

const hexByte = (n: number): string => clampByte(n).toString(16).padStart(2, '0')

/**
 * A color as an agent reads it: `#rrggbb` when opaque, else `#rrggbbaa`. Null
 * for an absent or unset color, which draws in the default.
 */
export function rgbaToHexColor(color: Rgba | undefined): string | null {
  if (!color || isColorUnset(color)) return null
  const rgb = `#${hexByte(color.r)}${hexByte(color.g)}${hexByte(color.b)}`
  return color.a >= 1 ? rgb : `${rgb}${hexByte(clampAlpha(color.a) * 255)}`
}

/**
 * A color as an agent writes it (`#rrggbb` or `#rrggbbaa`, either case) as an
 * `Rgba`; null for null, which returns the item to the default, or for a
 * string that is neither.
 */
export function hexColorToRgba(hex: string | null): Rgba | null {
  const match = hex === null ? null : HEX_COLOR.exec(hex.trim())
  if (!match) return null
  const rgb = parseInt(match[1], 16)
  const alpha = match[2] === undefined ? 1 : parseInt(match[2], 16) / 255
  return { r: (rgb >> 16) & 255, g: (rgb >> 8) & 255, b: rgb & 255, a: Number(alpha.toFixed(4)) }
}

/**
 * A color in a project file, as KiCad writes one (`COLOR4D::ToCSSString`):
 * `rgb(r, g, b)`, or `rgba(r, g, b, a)` below opaque. Null for anything else,
 * and for transparent, which KiCad uses for "no color of its own".
 */
export function parseCssColor(text: unknown): Rgba | null {
  if (typeof text !== 'string') return null
  const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(
    text.trim()
  )
  if (!m) return null
  const color = {
    r: clampByte(Number(m[1])),
    g: clampByte(Number(m[2])),
    b: clampByte(Number(m[3])),
    a: m[4] === undefined ? 1 : clampAlpha(Number(m[4]))
  }
  return color.a === 0 ? null : color
}

/** `parseCssColor`'s inverse, in KiCad's spelling; null writes transparent. */
export function cssColor(color: Rgba | null): string {
  if (!color) return 'rgba(0, 0, 0, 0.000)'
  const rgb = `${clampByte(color.r)}, ${clampByte(color.g)}, ${clampByte(color.b)}`
  return color.a >= 1 ? `rgb(${rgb})` : `rgba(${rgb}, ${clampAlpha(color.a).toFixed(3)})`
}

/** Remove any `(color …)` child of `root` (e.g. to fully clear an override). */
export function removeColorChild(root: SExprList): void {
  root.children = root.children.filter(
    (c) => !(c.type === 'list' && c.children[0]?.type === 'atom' && c.children[0].value === 'color')
  )
}
