/**
 * The serialized menu the renderer hands to main so macOS can draw it in the
 * system menu bar. Lives here because both processes need it (see RULES.md §9).
 *
 * The menu tree itself is declared once, in the renderer (`TitleBar.vue`), where
 * `t()` and `hotkeyLabel()` live — main has no i18n. On macOS the renderer sends
 * this flattened form instead of rendering the dropdowns itself.
 */

export interface NativeMenuItem {
  /** Same command id the in-window menu emits, so both surfaces dispatch alike. */
  id: string
  label: string
  /** Electron accelerator (`CmdOrCtrl+S`), omitted when the item has no hotkey. */
  accelerator?: string
  enabled?: boolean
  submenu?: NativeMenuNode[]
}

export interface NativeMenuDivider {
  divider: true
}

export type NativeMenuNode = NativeMenuItem | NativeMenuDivider

export interface NativeMenuSection {
  /** `file` / `view` / `help` — main uses these to place the menu in macOS order. */
  id: string
  label: string
  items: NativeMenuNode[]
}

export interface NativeMenuTemplate {
  sections: NativeMenuSection[]
}
