/**
 * Splits held as shares of what they divide, so a layout keeps its proportions
 * at any window size (the library chooser and the Component view). A drag
 * moves a share by the pixels dragged over that size; pixel minimums keep every
 * pane usable however small the window.
 */

/** `start` moved by `grow` px of `size`, held between `min` px and `size - keep` px. */
export function shareAfter(
  start: number,
  grow: number,
  size: number,
  min: number,
  keep: number
): number {
  if (size <= 0) return start
  return Math.max(min / size, Math.min((size - keep) / size, start + grow / size))
}

/** A share as a CSS length. */
export const percent = (share: number): string => `${(share * 100).toFixed(3)}%`
