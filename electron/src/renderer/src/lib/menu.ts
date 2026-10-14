/**
 * Menu model shared by every menu surface (title-bar dropdowns, the file
 * explorer context menu, group-header creates). The item tree is data, not
 * markup: a surface passes `MenuNode[]` to `shared/ContextMenu.vue` and reacts
 * to the selected id, so "which commands exist" is declared once rather than
 * restated per surface.
 *
 * Everything here is pure and DOM-free — keyboard traversal and viewport
 * placement are the two things menus get subtly wrong, so both are unit-tested
 * rather than eyeballed.
 */

/**
 * A run of label text. `code: true` renders monospace — used for the literal
 * artifact a command acts on (`.kicad_sym`, `.pretty/`). Per BRAND.md's UI-copy
 * rules a filename is shorter and more precise than prose describing it, and
 * the code style is what makes it read as a filename rather than a word.
 *
 * Segments rather than markup in the string: a label is data all the way to the
 * renderer, so no surface has to trust or escape HTML.
 */
export interface LabelSegment {
  text: string
  code?: boolean
}

/** Normalizes either label form to segments for rendering. */
export const labelSegments = (label: string | LabelSegment[]): LabelSegment[] =>
  typeof label === 'string' ? [{ text: label }] : label

/** Plain-text form, for tooltips and tests. */
export const labelText = (label: string | LabelSegment[]): string =>
  typeof label === 'string' ? label : label.map((s) => s.text).join('')

export interface MenuItem {
  /** Stable command id emitted on select. */
  id: string
  /** Plain string, or segments when part of the label is a literal filename. */
  label: string | LabelSegment[]
  /** Right-aligned accelerator hint, e.g. `Ctrl+N`. Display only. */
  shortcut?: string
  /**
   * One key that picks the item while the menu is open (`1`, `a`), matched
   * without regard to case. Shown as the shortcut when `shortcut` is unset.
   */
  key?: string
  /** Color chips before the label, as CSS colors: a layer's, or a pair's two. */
  swatches?: string[]
  /** A color chip before the shortcut, when the shortcut names the colored thing (a layer). */
  shortcutSwatch?: string
  /** The current choice among its siblings; drawn as a trailing tick. */
  checked?: boolean
  disabled?: boolean
  /** Why it is disabled — surfaced as the item's tooltip. */
  disabledReason?: string
  /** Submenu contents; an item with children never emits a selection itself. */
  children?: MenuNode[]
}

export interface MenuDivider {
  divider: true
}

/**
 * A section title inside a menu — "Projects" over the project rows of Open
 * Recent. Distinct from a disabled item, which is a *command you cannot run
 * right now* and must not look the same as a label that was never a command.
 */
export interface MenuHeader {
  header: string
}

export type MenuNode = MenuItem | MenuDivider | MenuHeader

export const isDivider = (node: MenuNode): node is MenuDivider =>
  (node as MenuDivider).divider === true

export const isHeader = (node: MenuNode): node is MenuHeader =>
  typeof (node as MenuHeader).header === 'string'

/** Neither a divider nor a header: the rows that carry a command. */
export const isMenuItem = (node: MenuNode): node is MenuItem => !isDivider(node) && !isHeader(node)

export const hasChildren = (node: MenuNode): boolean =>
  isMenuItem(node) && Array.isArray(node.children) && node.children.length > 0

/**
 * Focusable rows: dividers, headers, and disabled items are skipped, as in
 * native menus.
 */
export const isFocusable = (node: MenuNode): boolean => isMenuItem(node) && node.disabled !== true

/**
 * Next focusable index in `direction` (+1 down, -1 up), wrapping at the ends.
 * Returns -1 when nothing is focusable, so callers can leave focus unset
 * instead of landing on a divider.
 *
 * `from` of -1 means "nothing focused yet" — the origin is placed just outside
 * the travelled end, so Down opens on the first row and Up on the last.
 */
export function nextFocusableIndex(nodes: MenuNode[], from: number, direction: 1 | -1): number {
  const count = nodes.length
  if (count === 0) return -1
  const origin = from < 0 ? (direction === 1 ? -1 : count) : from
  for (let step = 1; step <= count; step++) {
    const index = (((origin + direction * step) % count) + count) % count
    if (isFocusable(nodes[index])) return index
  }
  return -1
}

/** First focusable index, or -1. Used when a menu opens via the keyboard. */
export const firstFocusableIndex = (nodes: MenuNode[]): number => nextFocusableIndex(nodes, -1, 1)

/** Last focusable index, or -1 — where Up lands when a menu opens. */
export const lastFocusableIndex = (nodes: MenuNode[]): number => nextFocusableIndex(nodes, -1, -1)

/**
 * The row a key press picks: an enabled item without a submenu whose `key`
 * names it, ignoring case. A modified press or a named key (Enter, the arrows)
 * picks nothing, so it keeps its menu meaning. -1 when none does.
 */
export function keyedItemIndex(
  nodes: MenuNode[],
  press: { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }
): number {
  if (press.ctrlKey || press.metaKey || press.altKey || press.key.length !== 1) return -1
  const key = press.key.toLowerCase()
  return nodes.findIndex(
    (node) =>
      isMenuItem(node) &&
      !node.disabled &&
      !hasChildren(node) &&
      node.key !== undefined &&
      node.key.toLowerCase() === key
  )
}

export interface PlacementInput {
  /** Preferred top-left corner, in viewport coordinates. */
  x: number
  y: number
  width: number
  height: number
  viewportWidth: number
  viewportHeight: number
  /**
   * For a submenu: the parent item's horizontal span. Overflow flips the menu
   * to the parent's left edge rather than merely nudging it, which would cover
   * the parent item.
   */
  flipAnchorX?: number
  /** Keep this far from the viewport edge. */
  margin?: number
}

/**
 * Clamp a menu into the viewport: flip when it would overflow, then clamp so a
 * menu taller than the viewport still starts on-screen. Pure so the flip rules
 * are testable without a layout engine.
 */
export function resolveMenuPosition(input: PlacementInput): { x: number; y: number } {
  const margin = input.margin ?? 4
  let x = input.x
  let y = input.y

  if (x + input.width > input.viewportWidth - margin) {
    x =
      input.flipAnchorX !== undefined
        ? input.flipAnchorX - input.width
        : input.viewportWidth - margin - input.width
  }
  if (y + input.height > input.viewportHeight - margin) {
    y = input.viewportHeight - margin - input.height
  }

  return { x: Math.max(margin, x), y: Math.max(margin, y) }
}
