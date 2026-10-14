import { mmToSpacing, type LengthUnit } from './kicad/coordinates'

/**
 * Selection and cursor-readout rules shared by every 2D viewport: the
 * click-to-toggle rule, and the coordinate readout converted through
 * `mmToSpacing` rather than a rounded inline mm→mil factor like `39.3701` —
 * which is not the exact reciprocal of the `0.0254` the rest of the app
 * converts by.
 */

/** Anything a viewport can select: a kind plus an index into the parsed arrays. */
export interface SelectableRef {
  type: string
  index: number
}

/** Shift / Ctrl / Cmd — what every editor reads as "add to the selection". */
export function isMultiSelect(e: {
  shiftKey: boolean
  ctrlKey: boolean
  metaKey: boolean
}): boolean {
  return e.shiftKey || e.ctrlKey || e.metaKey
}

/**
 * Ctrl+Shift / Cmd+Shift — "take out of the selection", KiCad's remove
 * modifier. Ctrl / Cmd alone is the pan (a trackpad has no middle button),
 * so the remove needs Shift beside it.
 */
export function isRemoveSelect(e: {
  shiftKey: boolean
  ctrlKey: boolean
  metaKey: boolean
}): boolean {
  return e.shiftKey && (e.ctrlKey || e.metaKey)
}

export function sameRef(a: SelectableRef, b: SelectableRef): boolean {
  return a.type === b.type && a.index === b.index
}

/**
 * The selection after clicking `item`. A plain click replaces; a modified
 * click adds, or removes when the item was already selected.
 *
 * Editors that name their items rather than numbering them — the symbol
 * editor, whose parts carry a `SymbolPartAddress` — supply their own equality
 * and take the second form.
 */
export function toggleSelection<T extends SelectableRef>(
  items: readonly T[],
  item: T,
  multi: boolean
): T[]
export function toggleSelection<T>(
  items: readonly T[],
  item: T,
  multi: boolean,
  equals: (a: T, b: T) => boolean
): T[]
export function toggleSelection<T>(
  items: readonly T[],
  item: T,
  multi: boolean,
  equals?: (a: T, b: T) => boolean
): T[] {
  // Sound by construction: the overload without `equals` is the only one that
  // reaches this fallback, and it constrains T to SelectableRef.
  const same = equals ?? ((a: T, b: T): boolean => sameRef(a as SelectableRef, b as SelectableRef))
  if (!multi) return [item]
  return items.some((selected) => same(selected, item))
    ? items.filter((selected) => !same(selected, item))
    : [...items, item]
}

/**
 * Decimal places a grid of this spacing can actually land on.
 *
 * Spacing is written in the same unit the readout displays, so its own
 * fractional length is the answer: a 50 mil grid puts the cursor on whole mils,
 * a 1.27 mm grid on hundredths. Exponent forms (`1e-3`) are normalized through
 * a round-trip rather than parsed, since only a hand-edited config produces one.
 */
export function gridDecimals(spacing: number): number {
  if (!Number.isFinite(spacing)) return 0
  const text = String(Math.abs(spacing))
  if (text.includes('e'))
    return Math.min(6, spacing.toFixed(6).replace(/0+$/, '').split('.')[1]?.length ?? 0)
  return text.split('.')[1]?.length ?? 0
}

/**
 * Decimals the readout shows.
 *
 * Without a grid, precision is per unit: a mil is ~0.025 mm, so three decimals
 * of mm, one of a mil and four of an inch are the same real resolution.
 *
 * With one — snap is on, so every reported point IS a grid point — the grid sets
 * it instead. Printing more decimals than the grid can land on is trailing
 * zeroes pretending to be precision, and printing fewer rounds the cursor to
 * somewhere it is not.
 */
const UNGRIDDED_DECIMALS: Record<LengthUnit, number> = { mm: 3, mil: 1, in: 4 }

const coordinateDecimals = (unit: LengthUnit, gridSpacing?: number): number =>
  gridSpacing === undefined ? UNGRIDDED_DECIMALS[unit] : gridDecimals(gridSpacing)

/** A world-space (mm) ordinate as the cursor readout shows it. */
export function formatCoordinate(mm: number, unit: LengthUnit, gridSpacing?: number): string {
  return mmToSpacing(mm, unit).toFixed(coordinateDecimals(unit, gridSpacing))
}

/**
 * Integer digits a coordinate field holds open, by unit. Generous against the
 * real work — 9999 mm is ten meters, 99999 mil or 999 in two and a half — because the
 * cost of over-reserving is one blank column and the cost of under-reserving is
 * the jitter this exists to remove.
 */
const INTEGER_DIGITS: Record<LengthUnit, number> = { mm: 4, mil: 5, in: 3 }

/**
 * The same ordinate padded to a FIXED width, right-aligned.
 *
 * A readout you track with your eyes has to hold still: unpadded, `9.9 → 10.0`
 * moves every digit left, drags Y along behind X, and resizes a right-anchored
 * pill from its left edge — so the number you were watching walks across the
 * screen while you move the mouse. Reserving sign + integer + decimals pins the
 * rightmost digit, which is the one that changes most and the one being read.
 *
 * Leading SPACES rather than zeroes: `0012.700` reads as significant figures.
 * That makes the strip's `white-space: pre` load-bearing — collapsing runs of
 * spaces would undo all of this.
 *
 * A value past the allowance simply gets longer. Widening is ugly for one frame;
 * clipping or an ellipsis would make the readout wrong.
 */
export function coordinateField(mm: number, unit: LengthUnit, gridSpacing?: number): string {
  const decimals = coordinateDecimals(unit, gridSpacing)
  const width = 1 + INTEGER_DIGITS[unit] + (decimals > 0 ? decimals + 1 : 0)
  return formatCoordinate(mm, unit, gridSpacing).padStart(width, ' ')
}
