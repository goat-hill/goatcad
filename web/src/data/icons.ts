/*
 * The single home for the site's UI glyphs, so they can be compared as one set
 * and reused by name. Each value is the inner markup of an `<svg>`; the
 * consuming component supplies the `<svg>` wrapper (viewBox, stroke, size) via
 * its own scoped CSS — Astro scopes styles per component, so the wrapper must
 * live where it's styled. Everything draws in `currentColor`, no external
 * request — the ~0 KB-JS / no-external-assets rule in WEB.md §3.
 *
 * These are the APP's glyphs, ported so the site shows what GoatCAD shows.
 * Duplicated by necessity (web/ is its own npm project, as with tokens.css):
 * change one side, change the other.
 *
 * Not here: the platform marks (PlatformIcon.astro — a self-contained reusable
 * component, kept separate for its trademark note and fill-based idiom) and the
 * brand mark (BrandMark.astro / the favicon — a brand asset, intentionally
 * duplicated per BRAND.md, not a UI icon).
 */

/**
 * KiCad file kinds, as the app's File Explorer and tab strip draw them
 * (electron/src/renderer/src/components/shared/FileIcon.vue). A 16-unit grid:
 * wrap in `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor"
 * stroke-width="1" stroke-linecap="round" stroke-linejoin="round">` and set
 * `color` to the kind's hue (`FILE_HUE`); the 50% and 20% tones follow it.
 */
export const FILE_ICONS = {
  // A sheet with a symbol on it: an op-amp and its inputs.
  schematic:
    '<path d="M3.5 1.5h6l3 3v10h-9z" fill="currentColor" fill-opacity="0.2"/>' +
    '<path d="M9.5 1.5v3h3"/>' +
    '<path d="M6.5 7.5v6l4.5-3z" fill="currentColor" fill-opacity="0.5"/>' +
    '<path d="M5 9h1.5M5 12h1.5"/>',
  // Solder mask, and a trace between two pads.
  board:
    '<rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="currentColor" fill-opacity="0.2"/>' +
    '<path d="M4.5 10.5l3-3h4"/>' +
    '<circle cx="4.5" cy="10.5" r="1.5" fill="currentColor" stroke="none"/>' +
    '<circle cx="11.5" cy="7.5" r="1.5" fill="currentColor" stroke="none"/>',
  // One land pattern: two rows of pads, as an IC's.
  footprint:
    '<path d="M2 3h4v2H2zM2 7h4v2H2zM2 11h4v2H2zM10 3h4v2h-4zM10 7h4v2h-4zM10 11h4v2h-4z" fill="currentColor" stroke="none"/>',
  // One op-amp: its inputs and its output.
  symbol:
    '<path d="M4.5 3.5v9l7-4.5z" fill="currentColor" fill-opacity="0.5"/>' +
    '<path d="M1.5 6h3M1.5 10h3M11.5 8h3"/>'
} satisfies Record<string, string>

export type FileIconName = keyof typeof FILE_ICONS

/** The side of the design each kind is on: schematic violet, board cyan. */
export const FILE_HUE: Record<FileIconName, string> = {
  schematic: 'var(--file-schematic)',
  symbol: 'var(--file-schematic)',
  board: 'var(--file-board)',
  footprint: 'var(--file-board)'
}

/**
 * The app's activity-bar family (electron/src/renderer/src/lib/icons.ts): a
 * 24-unit grid, `stroke-width="2"`, round caps and joins.
 */
export const ICONS = {
  // A terminal tab: a window with its title bar filled, a prompt and a cursor.
  terminal:
    '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 11.5l2.5 2.5L7 16.5M12 16.5h5"/>' +
    '<path fill="currentColor" stroke="none" d="M5 4h14a2 2 0 0 1 2 2v2H3V6a2 2 0 0 1 2-2z"/>'
} satisfies Record<string, string>

export type IconName = keyof typeof ICONS
