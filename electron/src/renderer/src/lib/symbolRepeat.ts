// Repeat Last Item — stamp another copy of the selection one step on, with pin
// numbers and names ticking up. KiCad's `Insert` idiom, which is the fast way to
// draw a connector's pin column without inserting each pin by hand.
//
// Deliberately parameterless: there is no dialog, no count and no direction
// picker. You press the key once per pin and watch the row grow, which is what
// makes it feel like a gesture rather than a form — and it means the only thing
// this module has to get right is WHERE the next copy goes.
//
// Coordinates are symbol space (y-up, integer nanometers).

import { nm, NM_PER_MIL, type Nm } from './kicad/coordinates'

/**
 * Distance to the next copy — KiCad's 100 mil, which is also a fresh pin's
 * length and the spacing every through-hole connector is drawn on. Not the grid
 * step, which defaults to 50 mil: half the pitch pins actually want.
 */
export const REPEAT_PITCH: Nm = nm(100 * NM_PER_MIL)

/** How far a repeated pin's trailing number and name digits step on. */
export const REPEAT_NUMBER_STEP = 1

/**
 * Where the next copy goes, from the heading of the pin being repeated.
 *
 * **Only the pin's AXIS matters, never which way along it it points.** A row of
 * horizontal pins runs *down*; a row of vertical pins runs *right*. So a pin on
 * the left edge and a pin on the right edge both column downward, and a pin on
 * the top edge and one on the bottom edge both run rightward.
 *
 * The reason is the same one that governs text: KiCad draws symbol text either
 * horizontally or rotated a quarter-turn left, never upside down and never
 * right-to-left, so everything reads left-to-right or bottom-to-top. Rows follow
 * the same grain. Turning the direction through a full circle with the pin — so
 * that a right-edge column ran *upward* — would be symmetric and wrong: it
 * reverses the reading order for half the symbol.
 *
 * `null` — a graphic, which has no heading — takes the horizontal case and goes
 * down, since there is nothing to be relative to.
 *
 * KiCad itself is simpler and worse here: its symbol editor holds a single
 * `pin_step` scalar rather than a pair, so a repeat always moves down whichever
 * way the pin points. The vertical-pin case is ours.
 */
export function repeatOffset(angle: number | null, pitch: Nm = REPEAT_PITCH): { x: Nm; y: Nm } {
  // Snapped to a quarter turn, so a pin at some odd angle still picks an axis
  // rather than producing a diagonal step nothing lines up with.
  const heading = (((Math.round((angle ?? 0) / 90) * 90) % 360) + 360) % 360
  const vertical = heading === 90 || heading === 270
  return vertical ? { x: pitch, y: nm(0) } : { x: nm(0), y: nm(-pitch) }
}
