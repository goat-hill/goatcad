/**
 * The canvas toolbars' two behaviors that need the live DOM, after OnShape's
 * toolbar (DESIGN.md §Canvas tool palettes):
 *
 * - **Fit** (`vToolbarFit`): an editor's top bar shows every chip that fits
 *   its canvas, short of the canvas's top-right slot (find, the unit pickers),
 *   and hides the rest from the end inward. The tool search stays at the end
 *   whatever the width, and it lists every control, so a hidden chip is still
 *   one search away. The search rests a little wider than its copy; with room
 *   to spare it widens further on focus, and on a bar that is hiding chips it
 *   keeps its resting width instead, so no room sits empty waiting for it.
 * - **Tips** (`installToolbarTips`): a chip's name and hotkey appear the moment
 *   the pointer lands on it. The native `title` tooltip waits about a second
 *   and draws in the OS's style, which is too slow for learning a palette.
 * - **Focus** (`installToolbarFocus`): a click leaves focus where it was. A
 *   chip is a pointer target for an editor whose keys belong to the canvas, so
 *   a clicked chip keeps none, and the next key (Esc shutting its list) neither
 *   misses the editor nor paints the keyboard focus ring on the chip.
 */
import type { ObjectDirective } from 'vue'

/** One of a bar's items, as the fit plan needs it. */
export interface ToolbarFitItem {
  /** Outer width, margins included. */
  width: number
  divider: boolean
  /** Hidden only after every other chip: the armed tool, and the options it shows. */
  late: boolean
  /** Hidden before every other chip: commands a menu and a key also reach. */
  early?: boolean
  /** Chips side by side under one name show and hide together. */
  group?: string
}

/**
 * Which items to hide so a bar fits `budget` px wide. Chips go from the end
 * inward, the `early` ones before every other and the `late` ones only after
 * every other, a group of neighbors as one; a divider shows only while it
 * sits between two shown chips, so hiding never leaves one dangling or doubled.
 * `fixed` is what always shows (the bar's padding and border, the search) and
 * `gap` the flex gap after each shown item.
 */
export function planToolbarFit(
  items: readonly ToolbarFitItem[],
  fixed: number,
  gap: number,
  budget: number
): Set<number> {
  // The units that hide: a chip, or a run of neighbors sharing a group.
  const units: number[][] = []
  items.forEach((item, i) => {
    if (item.divider) return
    const last = units.at(-1)
    const previous = last ? items[last[last.length - 1]] : undefined
    if (item.group && previous?.group === item.group && last?.at(-1) === i - 1) last.push(i)
    else units.push([i])
  })
  const isLate = (unit: number[]): boolean => unit.some((i) => items[i].late)
  const isEarly = (unit: number[]): boolean => !isLate(unit) && unit.some((i) => items[i].early)
  const order = [
    ...units.filter(isEarly).reverse(),
    ...units.filter((unit) => !isEarly(unit) && !isLate(unit)).reverse(),
    ...units.filter(isLate).reverse()
  ]
  const hiddenChips = new Set<number>()

  const hiddenWith = (chipsOut: Set<number>): Set<number> => {
    const hidden = new Set(chipsOut)
    let lastShown: 'chip' | 'divider' | null = null
    items.forEach((item, i) => {
      if (hidden.has(i)) return
      if (!item.divider) {
        lastShown = 'chip'
        return
      }
      const chipAfter = items.some((next, j) => j > i && !next.divider && !chipsOut.has(j))
      if (lastShown !== 'chip' || !chipAfter) hidden.add(i)
      else lastShown = 'divider'
    })
    return hidden
  }
  const widthWith = (hidden: Set<number>): number =>
    items.reduce((sum, item, i) => (hidden.has(i) ? sum : sum + item.width + gap), fixed)

  let hidden = hiddenWith(hiddenChips)
  for (const unit of order) {
    if (widthWith(hidden) <= budget) break
    for (const chip of unit) hiddenChips.add(chip)
    hidden = hiddenWith(hiddenChips)
  }
  return hidden
}

/** Set on a chip the fit hides; `canvasToolbar.css` takes it out of the flow.
 *  An attribute rather than a class, so Vue's class patching never clears it. */
const HIDDEN = 'data-toolbar-hidden'
/** Marks a chip to hide last, with the armed tool — an armed tool's options. */
const LATE = 'data-toolbar-late'
/** Marks a chip to hide first. */
const EARLY = 'data-toolbar-early'
/** Names the group a chip shows and hides with. */
const GROUP = 'data-toolbar-group'

/** The search's resting width, kept for when it is open and wider than at rest. */
const restWidths = new WeakMap<HTMLElement, number>()

/** The width `fit` gives the search at rest, and while focused on a full bar. */
const SEARCH_WIDTH = '--search-width'
const SEARCH_FOCUS_WIDTH = '--search-focus-width'

/** The width of the search's copy: measured with any width `fit` gave it taken off. */
const restWidthOf = (search: HTMLElement): number => {
  if (search.matches(':focus-within, .open')) {
    return restWidths.get(search) ?? search.getBoundingClientRect().width
  }
  const { transition } = search.style
  const width = search.style.getPropertyValue(SEARCH_WIDTH)
  search.style.transition = 'none'
  search.style.removeProperty(SEARCH_WIDTH)
  const rest = search.getBoundingClientRect().width
  if (width) search.style.setProperty(SEARCH_WIDTH, width)
  void search.offsetWidth
  search.style.transition = transition
  restWidths.set(search, rest)
  return rest
}

/** The canvas's top-right slot (canvasToolbar.css), which the bar stops short of. */
const TOP_RIGHT = ':scope > .canvas-top-right'
/** Space kept between the bar and the slot, as between the slot's own items. */
const SLOT_GAP = 8

const outerWidth = (el: HTMLElement): number => {
  const style = getComputedStyle(el)
  return (
    el.getBoundingClientRect().width +
    (parseFloat(style.marginLeft) || 0) +
    (parseFloat(style.marginRight) || 0)
  )
}

function fit(bar: HTMLElement): void {
  const host = bar.parentElement
  if (!host) return
  const children = [...bar.children] as HTMLElement[]
  for (const child of children) child.removeAttribute(HIDDEN)
  const search = children.find((child) => child.classList.contains('insert-search'))
  const items = children.filter((child) => child !== search)

  const gap = parseFloat(getComputedStyle(bar).columnGap) || 0
  const plan = items.map((el) => ({
    width: outerWidth(el),
    divider: el.classList.contains('toolbar-divider'),
    late: el.classList.contains('active') || el.hasAttribute(LATE),
    early: el.hasAttribute(EARLY),
    group: el.getAttribute(GROUP) ?? undefined
  }))
  const rest = search ? restWidthOf(search) : 0
  const barRect = bar.getBoundingClientRect()
  const hostRect = host.getBoundingClientRect()
  // What always shows, with the search at its resting width.
  const fixed =
    barRect.width -
    plan.reduce((sum, item) => sum + item.width + gap, 0) -
    (search ? search.getBoundingClientRect().width - rest : 0)
  // The bar's left inset, mirrored on the right — or the slot's left edge,
  // when something sits in the top-right slot.
  const inset = barRect.left - hostRect.left
  const slot = host.querySelector<HTMLElement>(TOP_RIGHT)?.getBoundingClientRect()
  const right = slot && slot.width > 0 ? slot.left - SLOT_GAP : hostRect.right - inset
  const budget = right - barRect.left

  const style = search ? getComputedStyle(search) : null
  const open = parseFloat(style?.getPropertyValue('--search-open-width') ?? '') || rest
  const snug = Math.min(
    open,
    rest + (parseFloat(style?.getPropertyValue('--search-snug-extra') ?? '') || 0)
  )
  // Budgeted at its typing width, so focusing it never pushes a chip off
  // mid-keystroke — while that costs no chip.
  let hidden = planToolbarFit(plan, fixed + Math.max(snug, open) - rest, gap, budget)
  const full = [...hidden].some((i) => !plan[i].divider)
  if (full) hidden = planToolbarFit(plan, fixed + snug - rest, gap, budget)
  if (search) {
    search.style.setProperty(SEARCH_WIDTH, `${snug}px`)
    if (full) search.style.setProperty(SEARCH_FOCUS_WIDTH, `${snug}px`)
    else search.style.removeProperty(SEARCH_FOCUS_WIDTH)
  }
  for (const i of hidden) items[i].setAttribute(HIDDEN, '')
}

const fitState = new WeakMap<HTMLElement, () => void>()

/**
 * `v-toolbar-fit` on an editor's top `.canvas-floating-toolbar`. Refits when
 * the canvas resizes and when the bar's contents change: a tool armed (it hides
 * last), route options appearing, a locale swapping the search's copy.
 */
export const vToolbarFit: ObjectDirective<HTMLElement> = {
  mounted(bar) {
    let frame = 0
    const schedule = (): void => {
      if (frame) return
      // Before the next paint, so a changed bar is never drawn overflowing.
      frame = requestAnimationFrame(() => {
        frame = 0
        fit(bar)
      })
    }
    const resize = new ResizeObserver(schedule)
    if (bar.parentElement) resize.observe(bar.parentElement)
    // Find opening, or a unit picker appearing, narrows the bar's room.
    const slot = bar.parentElement?.querySelector<HTMLElement>(TOP_RIGHT)
    if (slot) resize.observe(slot)
    const mutation = new MutationObserver(schedule)
    mutation.observe(bar, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class']
    })
    void document.fonts?.ready.then(schedule)
    fit(bar)
    fitState.set(bar, () => {
      cancelAnimationFrame(frame)
      resize.disconnect()
      mutation.disconnect()
    })
  },
  unmounted(bar) {
    fitState.get(bar)?.()
    fitState.delete(bar)
  }
}

/**
 * A tooltip string split into its name and hotkeys, as `toolTitle` builds it:
 * "Arc (Ctrl+Shift+A)", or "Zoom to fit (Home, Ctrl+0)" for several. Only
 * spaceless keys count, so a title that merely ends in a parenthetical stays
 * whole.
 */
export function splitToolTitle(title: string): { name: string; hotkeys: string[] } {
  const match = /^(.+) \(([^\s(),]+(?:, [^\s(),]+)*)\)$/.exec(title)
  return match ? { name: match[1], hotkeys: match[2].split(', ') } : { name: title, hotkeys: [] }
}

const TIP_GAP = 6
const VIEWPORT_MARGIN = 8

/**
 * Instant tooltips on every canvas toolbar chip, installed once for the window.
 * While a chip is hovered its `title` moves to `aria-label` (so the native tip
 * never shows on top and the chip keeps its accessible name) and comes back
 * when the pointer leaves. A chip on a top bar tips below; on a vertical rail,
 * to its right.
 */
export function installToolbarTips(): void {
  const tip = document.createElement('div')
  tip.className = 'canvas-tool-tip'
  tip.setAttribute('role', 'tooltip')
  tip.hidden = true
  document.body.appendChild(tip)

  let current: HTMLElement | null = null
  let addedLabel = false
  let title = ''
  // A title Vue rewrites while hovered (a toggle's on/off text) re-stashes here.
  const titleWatch = new MutationObserver(() => {
    if (!current?.hasAttribute('title')) return
    stash(current)
    render(current)
  })

  const stash = (chip: HTMLElement): void => {
    title = chip.getAttribute('title') ?? title
    chip.removeAttribute('title')
    if (addedLabel || !chip.hasAttribute('aria-label')) {
      chip.setAttribute('aria-label', title)
      addedLabel = true
    }
  }

  const render = (chip: HTMLElement): void => {
    const { name, hotkeys } = splitToolTitle(title)
    tip.replaceChildren(name)
    for (const hotkey of hotkeys) {
      const kbd = document.createElement('kbd')
      kbd.className = 'kbd'
      const span = document.createElement('span')
      span.textContent = hotkey
      kbd.appendChild(span)
      tip.appendChild(kbd)
    }
    tip.hidden = false
    const bar = chip.closest('.canvas-floating-toolbar')
    const rail = bar ? getComputedStyle(bar).flexDirection === 'column' : false
    const anchor = (bar ?? chip).getBoundingClientRect()
    const box = chip.getBoundingClientRect()
    const width = tip.offsetWidth
    const height = tip.offsetHeight
    const clamp = (value: number, size: number, limit: number): number =>
      Math.max(VIEWPORT_MARGIN, Math.min(value, limit - size - VIEWPORT_MARGIN))
    const left = rail ? anchor.right + TIP_GAP : box.left + box.width / 2 - width / 2
    const top = rail ? box.top + box.height / 2 - height / 2 : anchor.bottom + TIP_GAP
    tip.style.left = `${Math.round(clamp(left, width, window.innerWidth))}px`
    tip.style.top = `${Math.round(clamp(top, height, window.innerHeight))}px`
  }

  const hide = (): void => {
    titleWatch.disconnect()
    if (current) {
      if (!current.hasAttribute('title')) current.setAttribute('title', title)
      if (addedLabel) current.removeAttribute('aria-label')
    }
    current = null
    addedLabel = false
    title = ''
    tip.hidden = true
  }

  const chipOf = (target: EventTarget | null): HTMLElement | null => {
    if (!(target instanceof Element)) return null
    const chip = target.closest<HTMLElement>('.canvas-floating-toolbar button')
    if (!chip || chip.closest('.insert-search')) return null
    return chip === current || chip.hasAttribute('title') ? chip : null
  }

  document.addEventListener('pointerover', (event) => {
    const chip = chipOf(event.target)
    // A chip Vue removed while hovered never sends its pointerout.
    if (chip === current && current?.isConnected) return
    hide()
    if (!chip) return
    current = chip
    stash(chip)
    render(chip)
    titleWatch.observe(chip, { attributes: true, attributeFilter: ['title'] })
  })
  document.addEventListener('pointerout', (event) => {
    if (current && !(event.relatedTarget instanceof Node && current.contains(event.relatedTarget)))
      hide()
  })
  // A press shuts the tip, as a native one does: what the chip opens (a size
  // list, a menu) drops right where the tip sits. It returns on the next hover.
  document.addEventListener('pointerdown', (event) => {
    if (current && event.target instanceof Node && current.contains(event.target)) tip.hidden = true
  })
  window.addEventListener('blur', hide)
  document.addEventListener('scroll', hide, true)
}

/** Canvas toolbar buttons never take focus from a click (see Focus, above); Tab still reaches them. */
export function installToolbarFocus(): void {
  document.addEventListener('mousedown', (event) => {
    if (!(event.target instanceof Element)) return
    if (event.target.closest('.canvas-floating-toolbar button')) event.preventDefault()
  })
}
