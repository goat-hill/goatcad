// How much of a canvas its own floating chrome covers, measured rather than
// declared (`bringIntoView.ts` calls the rest of it the safe rect).
//
// Every 2D editor draws toolbars and status pills ON the canvas — the top-left
// tool pill, the board's left rail, the coordinate pills at the bottom
// (`assets/canvasToolbar.css`, `shared/ViewportStatusBar.vue`). A part under
// one of them is on screen and not in view, so a reveal has to treat that band
// as unusable.
//
// The numbers are read from the DOM instead of copied here as constants
// because they are already spelled in CSS and would drift: a toolbar that
// grows a button, a rail that gains a toggle, a theme with a different offset.
// The cost is one `getBoundingClientRect` per element per reveal, which
// happens on a user's click.
//
// Each chrome rect is charged to exactly ONE edge — the one where it costs
// least. The top-left tool pill sits 12px from the top and 12px from the left,
// but it is ~40px tall and ~220px wide, so charging it to the top costs 52px
// and to the left costs 232px: it is a top toolbar, and picking the cheaper
// edge is what says so without anything having to declare it.

import type { ViewInsets } from './bringIntoView'

/**
 * Breathing room added to every edge, on top of the measured chrome: a part
 * flush against the toolbar is technically clear of it and still reads as
 * "nearly off screen", and a reveal that leaves it there looks like a bug.
 */
export const VIEW_COMFORT_PX = 24

/**
 * Insets may not eat more than this fraction of each axis. A pane dragged
 * narrow can be mostly toolbar; past this point the chrome is unavoidable and
 * a safe rect that has collapsed to nothing would send every reveal down the
 * zoom-out branch.
 */
const MAX_INSET_FRACTION = 0.4

export const NO_INSETS: ViewInsets = { top: 0, right: 0, bottom: 0, left: 0 }

/**
 * Measure the chrome over `container`, which is the canvas host and so the
 * rectangle everything is charged against.
 *
 * `selectors` are queried inside `chromeRoot`, which defaults to the container
 * but need not be it: the board's toolbars are siblings of its canvas host
 * rather than children (they live in `PcbEditor.vue` so they survive the 2D/3D
 * swap), and the schematic's status pills are children. Each editor names its
 * own selectors, since one canvas host is reused by editors that float
 * different things over it.
 */
export const measureViewportInsets = (
  container: HTMLElement | null | undefined,
  selectors: readonly string[],
  chromeRoot?: HTMLElement | null
): ViewInsets => {
  const insets: ViewInsets = {
    top: VIEW_COMFORT_PX,
    right: VIEW_COMFORT_PX,
    bottom: VIEW_COMFORT_PX,
    left: VIEW_COMFORT_PX
  }
  if (!container) return insets

  const host = container.getBoundingClientRect()
  if (host.width <= 0 || host.height <= 0) return insets

  const root = chromeRoot ?? container
  for (const selector of selectors) {
    for (const element of root.querySelectorAll<HTMLElement>(selector)) {
      // `offsetParent` is null for a `display: none` element; a hidden toolbar
      // covers nothing. (An element made invisible by opacity still counts,
      // which is right — it is still in the way visually.)
      if (element.offsetParent === null) continue
      const rect = element.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) continue
      // Chrome that misses the canvas entirely (a toolbar belonging to the
      // other half of a 2D/3D swap, say) covers none of it.
      const overlaps =
        rect.right > host.left &&
        rect.left < host.right &&
        rect.bottom > host.top &&
        rect.top < host.bottom
      if (!overlaps) continue

      // What charging this rect to each edge would cost: how far the edge must
      // move inward to clear it.
      const costs: Array<[keyof ViewInsets, number]> = [
        ['top', rect.bottom - host.top],
        ['bottom', host.bottom - rect.top],
        ['left', rect.right - host.left],
        ['right', host.right - rect.left]
      ]
      let cheapest = costs[0]
      for (const cost of costs) if (cost[1] < cheapest[1]) cheapest = cost
      const [edge, cost] = cheapest
      if (cost > insets[edge]) insets[edge] = cost + VIEW_COMFORT_PX
    }
  }

  const maxX = host.width * MAX_INSET_FRACTION
  const maxY = host.height * MAX_INSET_FRACTION
  return {
    top: Math.min(insets.top, maxY),
    bottom: Math.min(insets.bottom, maxY),
    left: Math.min(insets.left, maxX),
    right: Math.min(insets.right, maxX)
  }
}
