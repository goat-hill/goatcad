// The single home for the app's UI glyphs, rendered by shared/Icon.vue as
// `<Icon name="chevron-right" />`. Each entry is the inner markup for an
// `<svg viewBox=…>`; color comes from `currentColor` (so a glyph inherits its
// container's color and state), and size comes from the container's CSS — the
// `.activity-btn svg` / `.tab-icon svg` / `.status-item svg` rules in
// assets/main.css already size every icon by where it sits, so a call site keeps
// its wrapper class and the styling follows.
//
// Two idioms live here:
//   • fill glyphs (24×24 Material-style, the older set) declare no `fill` —
//     Icon.vue defaults it to `currentColor`, and container CSS overrides where
//     it must.
//   • line-art glyphs declare `fill: 'none'` and their own stroke: the BAR
//     family (activity bar, 24×24), the TOOL family (canvas palettes, 20×20)
//     and the LINE preset (3D/viewport toolbars, 16×16). Icon.vue pins that
//     `fill: none` inline, so no container rule can flood an outline.
// The eye toggle is fill-less on purpose: `.eye-icon` in LayersPanel drives it.
//
// Colored, multi-hue *file-kind* glyphs are not here — those belong to
// FileIcon.vue, the one place a file kind becomes a glyph. Decorative art (the
// Welcome hero, the brand mark) is not an icon and stays inline where it lives.

export interface IconDef {
  viewBox: string
  /** Inner SVG markup (paths/rects/circles/…). */
  body: string
  /** `'none'` for stroked line-art; omit for fill glyphs (defaults to currentColor). */
  fill?: string
  stroke?: string
  strokeWidth?: number
  strokeLinecap?: 'round' | 'butt' | 'square'
  strokeLinejoin?: 'round' | 'miter' | 'bevel'
}

// A stroked 16×16 line-art glyph, the shared preset for the 3D/viewport toolbars.
const LINE: Pick<IconDef, 'viewBox' | 'fill' | 'stroke' | 'strokeLinejoin'> = {
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeLinejoin: 'round'
}

// The activity-bar family (DESIGN.md §Icons): a 24-unit grid rendered at
// 24px, drawn inside 2–22, one shade of currentColor, round caps and joins.
// Consistent in weight rather than in stroke: a line is 2px (whole-number
// coordinates, so it stays crisp at 1x), a grip is 3px, and a compact object
// — a gear, a node, a package — is SOLID. A frame stays an outline.
// Declares `fill: 'none'`, which Icon.vue pins inline so a container rule
// that fills its glyphs (`.activity-btn svg { fill: currentColor }`) cannot
// flood an outline; solid parts carry their own fill.
const BAR: Pick<
  IconDef,
  'viewBox' | 'fill' | 'stroke' | 'strokeWidth' | 'strokeLinecap' | 'strokeLinejoin'
> = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round'
}

// The canvas tool-palette family (DESIGN.md §Icons). Drawn on a 20-unit grid
// and rendered at exactly 20px, so one unit is one pixel: a 1px stroke on a
// .5 coordinate fills one pixel column and stays crisp at 1x. Three tones of
// currentColor, so hover and active states still recolor the whole glyph:
// the stroke (full), TONE for the thing the tool makes, FACE for a body.
const TOOL: Pick<
  IconDef,
  'viewBox' | 'fill' | 'stroke' | 'strokeWidth' | 'strokeLinecap' | 'strokeLinejoin'
> = {
  viewBox: '0 0 20 20',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1,
  strokeLinecap: 'round',
  strokeLinejoin: 'miter'
}
const FACE = 'fill="currentColor" fill-opacity="0.2"'
const TONE = 'fill="currentColor" fill-opacity="0.5"'
const SOLID = 'fill="currentColor" stroke="none"'
// A 3×3 handle centered on a .5 point: a line or curve's endpoint.
const handle = (cx: number, cy: number): string =>
  `<rect x="${cx - 1.5}" y="${cy - 1.5}" width="3" height="3" ${SOLID}/>`
// A plated ring: copper annulus around a drill.
const ring = (cx: number, cy: number, r: number, hole: number): string =>
  `<path ${TONE} fill-rule="evenodd" d="M${cx} ${cy - r}a${r} ${r} 0 1 0 0 ${2 * r}a${r} ${r} 0 1 0 0-${2 * r}zM${cx} ${cy - hole}a${hole} ${hole} 0 1 0 0 ${2 * hole}a${hole} ${hole} 0 1 0 0-${2 * hole}z"/>`

// The two isometric-cube faces every cube variant shares.
const CUBE_BODY =
  '<path d="M8 1.8 13.4 4.9v6.2L8 14.2 2.6 11.1V4.9Z"/><path d="M2.6 4.9 8 8l5.4-3.1M8 8v6.2"/>'
const cubeFace = (d: string): string =>
  `${CUBE_BODY}<path d="${d}" fill="currentColor" stroke="none" opacity="0.55"/>`

export const ICONS = {
  // Two sheets, one behind the other: files, plural.
  explorer: {
    ...BAR,
    body:
      '<path d="M8 5V3a1 1 0 0 1 1-1h6.5L20 6.5V17a1 1 0 0 1-1 1h-1"/>' +
      `<path ${SOLID} d="M5 7h6.5l4.5 4.5V21a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z"/>`
  },
  search: {
    ...BAR,
    body: '<circle cx="10" cy="10" r="6.5"/><path d="M15 15l5.5 5.5" stroke-width="3"/>'
  },
  'git-branch': {
    ...BAR,
    body:
      '<path d="M7 7v10"/><path d="M17 9v1a4 4 0 0 1-4 4h-2a4 4 0 0 0-4 4"/>' +
      `<circle ${SOLID} cx="7" cy="5" r="2.75"/><circle ${SOLID} cx="7" cy="19" r="2.75"/>` +
      `<circle ${SOLID} cx="17" cy="7" r="2.75"/>`
  },
  // Libraries: an open book — two pages curving from the spine, over the edge
  // of the cover, which is what makes it a book and not two sheets.
  libraries: {
    ...BAR,
    body:
      '<path d="M12 7c-2-1.6-5.5-2.1-9-1.5v12.5c3.5-.6 7-.1 9 1.5 2-1.6 5.5-2.1 9-1.5V5.5c-3.5-.6-7-.1-9 1.5zM12 7v12.5"/>' +
      '<path d="M3 18v2.5c3.5-.6 7-.1 9 1.5 2-1.6 5.5-2.1 9-1.5V18"/>'
  },
  // The agent launcher: a cluster of four-point sparkles, the common mark for
  // AI. Generic on purpose: the button launches whichever agent CLI Settings
  // names (Claude Code or Codex), and neither vendor's logo may ride a third
  // party's chrome.
  agent: {
    ...BAR,
    body: '<path fill="currentColor" stroke-width="1" d="M9.5 6.5Q11 12.5 17 14Q11 15.5 9.5 21.5Q8 15.5 2 14Q8 12.5 9.5 6.5ZM18 2Q18.8 5.2 22 6Q18.8 6.8 18 10Q17.2 6.8 14 6Q17.2 5.2 18 2ZM19 15.25Q19.45 17.05 21.25 17.5Q19.45 17.95 19 19.75Q18.55 17.95 16.75 17.5Q18.55 17.05 19 15.25Z"/>'
  },

  // Two panes side by side: send the tab in front across the split.
  'split-editor': {
    ...LINE,
    strokeWidth: 1.2,
    body: '<rect x="1.5" y="2.5" width="5.5" height="11" rx="1"/><rect x="9" y="2.5" width="5.5" height="11" rx="1"/>'
  },
  terminal: {
    ...BAR,
    body:
      '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 11.5l2.5 2.5L7 16.5M12 16.5h5"/>' +
      `<path ${SOLID} d="M5 4h14a2 2 0 0 1 2 2v2H3V6a2 2 0 0 1 2-2z"/>`
  },
  // Part Search — a taped cardboard carton: what it finds is stock at a
  // distributor, which a magnifier (plain `search` is workspace text) did
  // not say. The tape crosses the lid and folds down the side.
  'part-search': {
    ...BAR,
    body:
      '<path d="M12 2l9 4.5v11L12 22l-9-4.5v-11z"/><path d="M3 6.5l9 4.5 9-4.5M12 11v11"/>' +
      '<path d="M7.5 4.25l9 4.5v4.5"/>'
  },
  // Share app feedback: a speech bubble with two lines of text in it.
  feedback: {
    ...BAR,
    body:
      '<path d="M5 4h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-7l-5 4v-4H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/>' +
      '<path d="M8 9h8M8 12.5h5"/>'
  },
  // An eight-tooth gear. Shared by the activity-bar Settings button and the
  // Settings tab, which tints it copper through `color`.
  settings: {
    ...BAR,
    body:
      // Solid, its corners softened by a 1px stroke of the same color.
      `<path fill="currentColor" fill-rule="evenodd" stroke-width="1" d="M10.5 5.16L10.84 2.82L13.16 2.82L13.5 5.16L15.77 6.1L17.67 4.69L19.31 6.33L17.9 8.23L18.84 10.5L21.18 10.84L21.18 13.16L18.84 13.5L17.9 15.77L19.31 17.67L17.67 19.31L15.77 17.9L13.5 18.84L13.16 21.18L10.84 21.18L10.5 18.84L8.23 17.9L6.33 19.31L4.69 17.67L6.1 15.77L5.16 13.5L2.82 13.16L2.82 10.84L5.16 10.5L6.1 8.23L4.69 6.33L6.33 4.69L8.23 6.1ZM15.5 12a3.5 3.5 0 1 0-7 0a3.5 3.5 0 1 0 7 0z"/>`
  },
  // Twist drill bit — Manufacture mode (drilling is the archetypal fab step). A
  // fluted body tapering to a point; the flutes are evenodd cut-outs so they read
  // as diagonal stripes on the solid bit. Fill glyph (themes / takes a tab color
  // override like the others). fill-rule survives on the inner <path>.
  manufacture: {
    viewBox: '0 0 24 24',
    body:
      '<path fill-rule="evenodd" d="' +
      'M9 2 H15 V17 L12 22 L9 17 Z ' + // shank + fluted body + point
      'M9 9 L15 7.8 L15 9.2 L9 10.4 Z ' + // flute 1
      'M9 12 L15 10.8 L15 12.2 L9 13.4 Z ' + // flute 2
      'M9 15 L15 13.8 L15 15.2 L9 16.4 Z' + // flute 3
      '"/>'
  },
  'chevron-right': {
    viewBox: '0 0 24 24',
    body: '<path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6-1.41-1.41z"/>'
  },
  // The disclosure caret's closed-state twin for dropdown triggers ("Columns").
  'chevron-down': {
    viewBox: '0 0 24 24',
    body: '<path d="M16.59 8.59L12 13.17 7.41 8.59 6 10l6 6 6-6-1.41-1.41z"/>'
  },
  // A solid pointer marking the one active row (the active layer).
  'active-marker': {
    viewBox: '0 0 24 24',
    body: '<path d="M8 5v14l11-7z"/>'
  },
  // A tick: the current choice in a list (branch, project), a detected library.
  check: {
    viewBox: '0 0 24 24',
    body: '<path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>'
  },
  // In a keycap beside its number: the key steps a setting up or down (the tuner's 1–4).
  // An 8px grid, drawn at exactly 8px so the point stays crisp.
  'step-up': { viewBox: '0 0 8 8', body: '<path d="M4 1.5 7.5 6.5h-7z"/>' },
  'step-down': { viewBox: '0 0 8 8', body: '<path d="M.5 1.5h7L4 6.5z"/>' },
  // Sort direction on a table header, and move-row up/down.
  'arrow-up': {
    viewBox: '0 0 24 24',
    body: '<path d="M4 12l1.41 1.41L11 7.83V20h2V7.83l5.58 5.59L20 12l-8-8-8 8z"/>'
  },
  'arrow-down': {
    viewBox: '0 0 24 24',
    body: '<path d="M20 12l-1.41-1.41L13 16.17V4h-2v12.17l-5.58-5.59L4 12l8 8 8-8z"/>'
  },
  'arrow-back': {
    viewBox: '0 0 24 24',
    body: '<path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/>'
  },
  // Crosshair over a ring — "find this on the canvas".
  locate: {
    viewBox: '0 0 24 24',
    body: '<path d="M12 8a4 4 0 100 8 4 4 0 000-8zm8.94 3A9 9 0 0013 3.06V1h-2v2.06A9 9 0 003.06 11H1v2h2.06A9 9 0 0011 20.94V23h2v-2.06A9 9 0 0020.94 13H23v-2h-2.06zM12 19a7 7 0 110-14 7 7 0 010 14z"/>'
  },
  plus: {
    viewBox: '0 0 24 24',
    body: '<path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>'
  },
  minus: {
    viewBox: '0 0 24 24',
    body: '<path d="M19 13H5v-2h14v2z"/>'
  },
  // Floppy disk — "save this as a named thing", not "write the file to disk"
  // (that is Ctrl+S and has no button). Used by the layer-preset row.
  save: {
    viewBox: '0 0 24 24',
    body:
      '<path d="M17 3H5a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2V7l-4-4zm-5 16a3 3 0 110-6 ' +
      '3 3 0 010 6zm3-10H6V5h9v4z"/>'
  },
  // Waste basket — the standing glyph for removing a stored thing.
  trash: {
    viewBox: '0 0 24 24',
    body: '<path d="M6 19a2 2 0 002 2h8a2 2 0 002-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>'
  },
  refresh: {
    viewBox: '0 0 24 24',
    body: '<path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/>'
  },
  // Discard/restore — the "undo the change" arrow curling back to the left.
  discard: {
    viewBox: '0 0 24 24',
    body: '<path d="M12.5 8c-2.65 0-5.05.99-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.16 3.16-1.88 5.12-1.88 3.54 0 6.55 2.31 7.6 5.5l2.37-.78C21.08 11.03 17.15 8 12.5 8z"/>'
  },
  // Filled circle with an "i" — the status bar's "no problems" indicator.
  info: {
    viewBox: '0 0 24 24',
    body: '<path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/>'
  },
  // Design-health severities (shared/HealthPill.vue, FindingsDrawer.vue). Three
  // shapes, not one shape in three colors, so a severity reads without its hue.
  'status-error': {
    viewBox: '0 0 24 24',
    body: '<path d="M12 2C6.47 2 2 6.47 2 12s4.47 10 10 10 10-4.47 10-10S17.53 2 12 2zm5 13.59L15.59 17 12 13.41 8.41 17 7 15.59 10.59 12 7 8.41 8.41 7 12 10.59 15.59 7 17 8.41 13.41 12 17 15.59z"/>'
  },
  'status-warning': {
    viewBox: '0 0 24 24',
    body: '<path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/>'
  },
  'status-ok': {
    viewBox: '0 0 24 24',
    body: '<path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>'
  },
  // Two checked rows: the design-health pill before its first check (HealthPill.vue).
  checklist: {
    viewBox: '0 0 24 24',
    body: '<path d="M22 7h-9v2h9V7zm0 8h-9v2h9v-2zM5.54 11L2 7.46l1.41-1.41 2.12 2.12 4.24-4.24 1.41 1.41L5.54 11zm0 8L2 15.46l1.41-1.41 2.12 2.12 4.24-4.24 1.41 1.41L5.54 19z"/>'
  },
  // Full 24×24 X (the recents-list remove button).
  close: {
    viewBox: '0 0 24 24',
    body: '<path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>'
  },
  // Out of the box: open what a field names — a link, a library file.
  'open-external': {
    viewBox: '0 0 24 24',
    body: '<path d="M19 19H5V5h7V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z"/>'
  },

  // ── Welcome / file-info monochrome glyphs (24×24 fill, currentColor) ──
  // A plain folder outline. (FileIcon owns the *colored* file-tree folder.)
  folder: {
    viewBox: '0 0 24 24',
    body: '<path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/>'
  },
  // A document with a folded corner — "Open File".
  'file-doc': {
    viewBox: '0 0 24 24',
    body: '<path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm-1 7V3.5L18.5 9H13z"/>'
  },
  // A hierarchy tree — "Open Project". A project *is* the graph it roots
  // (docs/projects.md §1), which is what separates it from the plain
  // folder next to it in the same menu.
  project: {
    viewBox: '0 0 24 24',
    body: '<path d="M22 11V3h-7v3H9V3H2v8h7V8h2v10h4v3h7v-8h-7v3h-2V8h2v3z"/>'
  },
  // A framed plus — "New Project".
  'new-project': {
    viewBox: '0 0 24 24',
    body: '<path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-2 10h-4v4h-2v-4H7v-2h4V7h2v4h4v2z"/>'
  },
  // A download arrow — "Open sample project", which fetches the design first.
  'sample-project': {
    viewBox: '0 0 24 24',
    body: '<path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>'
  },

  // ── Window controls & tabs (tight-viewBox glyphs) ──
  // Tab-close and window-close share this compact 10×10 X.
  'close-tight': {
    viewBox: '0 0 10 10',
    body: '<polygon points="10,0.7 9.3,0 5,4.3 0.7,0 0,0.7 4.3,5 0,9.3 0.7,10 5,5.7 9.3,10 10,9.3 5.7,5"/>'
  },
  'window-minimize': {
    viewBox: '0 0 10 1',
    body: '<rect y="0" width="10" height="1"/>'
  },
  'window-maximize': {
    viewBox: '0 0 10 10',
    body: '<path d="M0,0v10h10V0H0z M9,9H1V1h8V9z"/>'
  },

  // ── Text editor / find widget (16×16 fill) ──
  'chevron-up-sm': {
    viewBox: '0 0 16 16',
    body: '<path d="M8 5 3.5 9.5l.9.9L8 6.8l3.6 3.6.9-.9z"/>'
  },
  'chevron-down-sm': {
    viewBox: '0 0 16 16',
    body: '<path d="M8 11 3.5 6.5l.9-.9L8 9.2l3.6-3.6.9.9z"/>'
  },
  'close-sm': {
    viewBox: '0 0 16 16',
    body: '<path d="M9 8l3.5-3.5-1-1L8 7 4.5 3.5l-1 1L7 8l-3.5 3.5 1 1L8 9l3.5 3.5 1-1z"/>'
  },

  // ── Visibility toggle (LayersPanel; `.eye-icon` CSS drives stroke/fill) ──
  eye: {
    viewBox: '0 0 24 24',
    body: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3" fill="currentColor"/>'
  },
  'eye-off': {
    viewBox: '0 0 24 24',
    body: '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" stroke-linecap="round" stroke-linejoin="round"/><line x1="1" y1="1" x2="23" y2="23" stroke-linecap="round" stroke-linejoin="round"/>'
  },

  // ── 3D / viewport toolbars (16×16 line-art) ──
  // Plain isometric cube (3D-view toggle, model tab). Mirrors CubeIcon.vue.
  cube: {
    ...LINE,
    strokeWidth: 1.2,
    strokeLinecap: 'round',
    body: CUBE_BODY
  },
  // View-preset cubes: same wireframe with one face shaded.
  'cube-front': { ...LINE, strokeWidth: 1.2, body: cubeFace('M2.6 4.9 8 8v6.2l-5.4-3.1Z') },
  'cube-top': { ...LINE, strokeWidth: 1.2, body: cubeFace('M8 1.8 13.4 4.9 8 8 2.6 4.9Z') },
  'cube-right': { ...LINE, strokeWidth: 1.2, body: cubeFace('M8 8l5.4-3.1v6.2L8 14.2Z') },
  // The underside: the face you cannot see, shaded through the cube.
  'cube-bottom': { ...LINE, strokeWidth: 1.2, body: cubeFace('M8 8 13.4 11.1 8 14.2 2.6 11.1Z') },
  // A board seen from directly above with two parts on it — the physical
  // render toggle over the layout.
  'render-board': {
    ...LINE,
    strokeWidth: 1.2,
    body:
      '<rect x="2" y="3.2" width="12" height="9.6" rx="1.2"/>' +
      '<rect x="4.1" y="5.3" width="4" height="2.8" fill="currentColor" stroke="none" opacity="0.55"/>' +
      '<rect x="9.2" y="8.4" width="3" height="2.4" fill="currentColor" stroke="none" opacity="0.55"/>'
  },
  // Axes with tick marks — the dimension/scale gauge.
  gauge: {
    ...LINE,
    strokeWidth: 1.3,
    body: '<path d="M3 2v11h11"/><path d="M5.5 13v-2M8 13v-2M10.5 13v-2M3 10.5h2M3 8h2M3 5.5h2"/>'
  },
  // A pencil, tip at the lower-left — the draw-tool cursor (see iconCursor).
  // Two arrows passing each other: one part swapped for another (Change symbol / footprint).
  swap: {
    ...LINE,
    strokeWidth: 1.3,
    strokeLinecap: 'round',
    body: '<path d="M2.5 5.5h10.5M10.5 3l2.5 2.5-2.5 2.5"/><path d="M13.5 10.5H3M5.5 8 3 10.5 5.5 13"/>'
  },
  pencil: {
    ...LINE,
    strokeWidth: 1.3,
    strokeLinecap: 'round',
    body: '<path d="M2.5 13.5l.7-2.9 7.4-7.4c.6-.6 1.6-.6 2.2 0 .6.6.6 1.6 0 2.2l-7.4 7.4-2.9.7z"/><path d="M9.8 4.4l1.8 1.8"/>'
  },
  // A 3x3 lattice — the drawing grid, on the viewport pill that sets it.
  grid: {
    ...LINE,
    strokeWidth: 1.2,
    body: '<rect x="2.5" y="2.5" width="11" height="11" rx="1"/><path d="M6.2 2.5v11M9.8 2.5v11M2.5 6.2h11M2.5 9.8h11"/>'
  },
  // An arrow pointer — "selection", the half the viewport filter's short "Filter"
  // label drops. Paired with that word rather than a funnel, which would only
  // redraw what the label already says.
  cursor: {
    ...LINE,
    strokeWidth: 1.3,
    strokeLinejoin: 'round',
    body: '<path d="M3 1.6v10.9l2.9-2.7 2 4.4 2.2-1-2-4.2 3.9-.3z"/>'
  },
  // A push-pin, point down — "keep this open" on a dismiss-on-interaction popover.
  pin: {
    ...LINE,
    strokeWidth: 1.3,
    strokeLinecap: 'round',
    body: '<path d="M6 1.8h4l-.6 3.6 2.1 2.2H4.5l2.1-2.2z"/><path d="M8 7.6v6.6"/>'
  },
  // Two values held together: either set, the other follows.
  link: {
    ...LINE,
    strokeWidth: 1.3,
    strokeLinecap: 'round',
    body: '<path d="M6.5 4.8H4.6a3.2 3.2 0 0 0 0 6.4h1.9"/><path d="M9.5 4.8h1.9a3.2 3.2 0 0 1 0 6.4H9.5"/><path d="M5.6 8h4.8"/>'
  },

  // ── Canvas tool palettes (20×20, TOOL; DESIGN.md §Icons) ──
  // The editors' floating toolbars, their tool searches and the PCB view rail.
  undo: {
    ...TOOL,
    body: '<path d="M7.5 4.5l-3 3 3 3"/><path d="M4.5 7.5h8a3.5 3.5 0 0 1 0 7h-3"/>'
  },
  redo: {
    ...TOOL,
    body: '<path d="M12.5 4.5l3 3-3 3"/><path d="M15.5 7.5h-8a3.5 3.5 0 0 0 0 7h3"/>'
  },
  'tool-select': {
    ...TOOL,
    body: `<path ${FACE} d="M5.5 2.5v13L9 12l2.3 5 2-.9-2.3-4.6h4.5z"/>`
  },
  // One trace between two vias: up, a 45° jog up-right, up again.
  'tool-route': {
    ...TOOL,
    body:
      `<circle cx="8" cy="15.5" r="2" ${TONE}/><circle cx="12" cy="4.5" r="2" ${TONE}/>` +
      '<path d="M8 13.5V12l4-4V6.5" stroke-width="2" stroke-linecap="butt" stroke-linejoin="round"/>'
  },
  // The route's trace doubled: two halves keeping their gap through the jog.
  'tool-route-pair': {
    ...TOOL,
    body: '<path d="M6 17v-6l4-4V3M10 17v-4l4-4V3" stroke-width="2" stroke-linecap="butt" stroke-linejoin="round"/>'
  },
  // KiCad's three tuners as the route each leaves: in from the left, meandered,
  // and out round a 45° bend, every corner rounded as KiCad lays them. A
  // track's bumps; a pair's halves turning together, a track apart, their
  // corners concentric; a skew's one bump on one half, the other running straight.
  'tool-tune-single': {
    ...TOOL,
    body: '<path d="M2 15.5L3.5 15.5A1 1 0 0 0 4.5 14.5L4.5 10.5A1 1 0 0 1 5.5 9.5L6.5 9.5A1 1 0 0 1 7.5 10.5L7.5 14.5A1 1 0 0 0 8.5 15.5A1 1 0 0 0 9.5 14.5L9.5 10.5A1 1 0 0 1 10.5 9.5L11.5 9.5A1 1 0 0 1 12.5 10.5L12.5 14.5A1 1 0 0 0 13.5 15.5L13.59 15.5A1 1 0 0 0 14.29 15.21L16.21 13.29A1 1 0 0 0 16.5 12.59L16.5 2"/>'
  },
  'tool-tune-pair': {
    ...TOOL,
    body:
      '<path d="M2 14.5L3.5 14.5A1 1 0 0 0 4.5 13.5L4.5 10.5A3 3 0 0 1 7.5 7.5L8.5 7.5A3 3 0 0 1 11.5 10.5L11.5 13.5A1 1 0 0 0 12.5 14.5L12.67 14.5A1 1 0 0 0 13.38 14.21L15.21 12.38A1 1 0 0 0 15.5 11.67L15.5 2"/>' +
      '<path d="M2 16.5L3.5 16.5A3 3 0 0 0 6.5 13.5L6.5 10.5A1 1 0 0 1 7.5 9.5L8.5 9.5A1 1 0 0 1 9.5 10.5L9.5 13.5A3 3 0 0 0 12.5 16.5L12.67 16.5A3 3 0 0 0 14.79 15.62L16.62 13.79A3 3 0 0 0 17.5 11.67L17.5 2"/>'
  },
  'tool-tune-skew': {
    ...TOOL,
    body:
      '<path d="M2 14.5L4.5 14.5A1 1 0 0 0 5.5 13.5L5.5 10.5A1 1 0 0 1 6.5 9.5L7.5 9.5A1 1 0 0 1 8.5 10.5L8.5 13.5A1 1 0 0 0 9.5 14.5L12.67 14.5A1 1 0 0 0 13.38 14.21L15.21 12.38A1 1 0 0 0 15.5 11.67L15.5 2"/>' +
      '<path d="M2 16.5L12.67 16.5A3 3 0 0 0 14.79 15.62L16.62 13.79A3 3 0 0 0 17.5 11.67L17.5 2"/>'
  },
  'tool-via': { ...TOOL, body: ring(10, 10, 6.5, 2.5) },
  // The board in section, every copper layer faint: a route in on the pair's
  // top layer, down the via's barrel through the thickness, and on along its
  // bottom, solid.
  'tool-layer-pair': {
    ...TOOL,
    body:
      `<path ${TONE} stroke="none" d="M11 3h7v1h-7zM2 7h16v1H2zM2 11h16v1H2zM2 15h7v1H2z"/>` +
      `<path ${SOLID} d="M2 3h9v1H2zM9 15h9v1H9zM9 4h2v11H9z"/>`
  },
  // A wire with its two ends, KiCad's connection squares.
  'tool-wire': {
    ...TOOL,
    body: `<path d="M3.5 15.5h6v-11h7"/>${handle(3.5, 15.5)}${handle(16.5, 4.5)}`
  },
  'tool-line': {
    ...TOOL,
    body: `<path d="M4.5 15.5l11-11"/>${handle(4.5, 15.5)}${handle(15.5, 4.5)}`
  },
  'tool-arc': {
    ...TOOL,
    body: `<path d="M4.5 15.5a11 11 0 0 1 11-11"/>${handle(4.5, 15.5)}${handle(15.5, 4.5)}`
  },
  'tool-bezier': {
    ...TOOL,
    body:
      '<path d="M3.5 15.5h8M16.5 4.5h-8" stroke-opacity="0.5"/>' +
      `<path d="M3.5 15.5C11.5 15.5 8.5 4.5 16.5 4.5"/>${handle(11.5, 15.5)}${handle(8.5, 4.5)}`
  },
  'tool-rect': { ...TOOL, body: `<rect x="3.5" y="5.5" width="13" height="9" ${FACE}/>` },
  'tool-circle': {
    ...TOOL,
    body: `<circle cx="10" cy="10" r="6.5" ${FACE}/><rect x="9" y="9" width="2" height="2" ${SOLID}/>`
  },
  'tool-polygon': { ...TOOL, body: `<path ${FACE} d="M10 3.5l6.5 4.7-2.5 8.3H6L3.5 8.2z"/>` },
  // Export a picture: a frame with an arrow leaving it, up and out.
  'tool-export': {
    ...TOOL,
    body: `<path ${FACE} d="M3.5 7.5v9h13v-9"/><path d="M10 12.5v-9M6.5 7 10 3.5 13.5 7"/>`
  },
  // A serifed capital T, drawn solid so it keeps its weight at 20px.
  'tool-text': {
    ...TOOL,
    body: `<path ${SOLID} d="M4 4h12v3.5h-1.2L14 5.5h-3V15h1.5v1.5h-5V15H9V5.5H6l-.8 2H4z"/>`
  },
  'tool-text-box': {
    ...TOOL,
    body:
      `<rect x="2.5" y="3.5" width="15" height="13" ${FACE}/>` +
      `<path ${SOLID} d="M6 7h8v1.5h-3V14H9V8.5H6z"/>`
  },
  // KiCad 10's point, marked as KiCad marks one: an X across it, a ring at its heart.
  'tool-point': {
    ...TOOL,
    body: `<path d="M4.5 4.5l11 11M15.5 4.5l-11 11"/><circle cx="10" cy="10" r="3" ${FACE}/>`
  },
  // A copper pour: a chamfered outline filled in the made-thing tone.
  // A copper pour: its outline, a corner cut as zones are drawn, hatched inside.
  'tool-zone': {
    ...TOOL,
    body:
      `<path ${FACE} d="M3.5 3.5h9l4 4v9h-13z"/>` +
      '<path d="M3.5 8.5l5-5M3.5 16.5l11-11M11.5 16.5l5-5" stroke-opacity="0.7"/>'
  },
  'tool-refill': {
    ...TOOL,
    body: '<path d="M15.5 10a5.5 5.5 0 1 1-1.6-3.9"/><path d="M14.5 2.5v4h-4"/>'
  },
  'tool-pad': { ...TOOL, body: `<rect x="4.5" y="4.5" width="11" height="11" rx="2" ${TONE}/>` },
  // A pin reaching from the symbol's body edge (faded) to its connection end,
  // KiCad's circle.
  'tool-pin': {
    ...TOOL,
    body:
      '<path d="M16.5 5.5v10" stroke-opacity="0.5"/>' +
      `<path d="M7.5 10.5h9"/><circle cx="5" cy="10.5" r="2.5" ${FACE}/>`
  },
  'tool-symbol': {
    ...TOOL,
    body: `<path ${FACE} d="M5.5 4.5v12l10-6z"/><path d="M2.5 7.5h3M2.5 13.5h3M15.5 10.5h2"/>`
  },
  // A land pattern: two rows of pads either side of the faded body outline.
  'tool-footprint': {
    ...TOOL,
    body:
      '<path d="M7.5 3.5h5v13h-5z" stroke-opacity="0.5"/>' +
      [4.5, 8.5, 12.5]
        .map(
          (y) =>
            `<rect x="2.5" y="${y}" width="4" height="2" ${TONE}/><rect x="13.5" y="${y}" width="4" height="2" ${TONE}/>`
        )
        .join('')
  },
  'tool-ground': { ...TOOL, body: '<path d="M10.5 3.5v6M4.5 9.5h12M6.5 12.5h8M8.5 15.5h4"/>' },
  // A letter sitting on its net line — KiCad's label tool.
  'tool-label': { ...TOOL, body: '<path d="M6.5 12.5l3.5-9 3.5 9M7.7 9.5h4.6M2.5 15.5h15"/>' },
  // KiCad's global label outline: a flag pointing at its net.
  'tool-flag': { ...TOOL, body: `<path ${FACE} d="M2.5 6.5h10l4 4-4 4h-10z"/>` },
  'tool-no-connect': { ...TOOL, body: '<path d="M5 5l10 10M15 5 5 15"/>' },
  'tool-junction': {
    ...TOOL,
    body: `<path d="M2.5 10.5h15M10.5 10.5v7"/><circle cx="10.5" cy="10.5" r="2.5" ${SOLID}/>`
  },
  // A sheet symbol: a box with its name band.
  'tool-sheet': {
    ...TOOL,
    body: `<rect x="3.5" y="3.5" width="13" height="13" ${FACE}/><path d="M3.5 6.5h13"/>`
  },
  // A pin on a sheet's edge (faded), its glyph pointing into the box, as
  // KiCad draws one, with the wire that meets it.
  'tool-sheet-pin': {
    ...TOOL,
    body:
      '<rect x="7.5" y="3.5" width="9" height="13" stroke-opacity="0.5"/>' +
      `<path ${TONE} d="M7.5 8.5h4l2 2-2 2h-4z"/><path d="M2.5 10.5h5"/>`
  },
  // A bus is drawn wide in KiCad, so it takes the physical 2px on whole pixels.
  'tool-bus': {
    ...TOOL,
    body: '<path d="M3 15h7V5h7" stroke-width="2"/>'
  },
  // A bus (2px) with an entry leaving it at 45° into its wire.
  'tool-bus-entry': {
    ...TOOL,
    body: `<path d="M5 2v16" stroke-width="2"/><path d="M6.5 12.5l4-4h6"/>${handle(16.5, 8.5)}`
  },
  // KiCad's directive label: a round flag on its pole, anchored at the foot.
  'tool-directive': {
    ...TOOL,
    body: `<circle cx="10.5" cy="6" r="3.5" ${FACE}/><path d="M10.5 9.5v7"/>${handle(10.5, 16.5)}`
  },
  // KiCad's rule area: a dashed outline over the tinted region it governs.
  'tool-rule-area': {
    ...TOOL,
    body: `<path ${FACE} stroke-dasharray="2 2" d="M3.5 5.5l9-2 4 6-3 7h-9z"/>`
  },
  // A table: its outline, a header rule and the column and row separators.
  'tool-table': {
    ...TOOL,
    body:
      `<rect x="2.5" y="4.5" width="15" height="12" ${FACE}/>` +
      '<path d="M2.5 8.5h15M2.5 12.5h15" /><path d="M9.5 4.5v12" stroke-opacity="0.5"/>'
  },
  // A picture: a frame holding a sun and a hill.
  'tool-image': {
    ...TOOL,
    body:
      '<rect x="2.5" y="3.5" width="15" height="13"/>' +
      `<circle cx="7" cy="8" r="1.5" ${SOLID}/><path ${TONE} d="M2.5 16.5l5-5 3 3 3-4 4 6z"/>`
  },
  'tool-annotate': {
    ...TOOL,
    body: '<path d="M8.5 3.5l-1 13M13.5 3.5l-1 13M4.5 7.5h12M3.5 12.5h12"/>'
  },
  // A second gate stacked behind the first.
  'tool-unit': {
    ...TOOL,
    body: `<path d="M7.5 7.5v-4h9v9h-4" stroke-opacity="0.5"/><rect x="3.5" y="7.5" width="9" height="9" ${FACE}/>`
  },
  // Align and distribute: two bodies against the line they meet, or spread
  // evenly between the two edges that stay.
  'align-left': {
    ...TOOL,
    body: `<path d="M3.5 2.5v15"/><rect x="5.5" y="4.5" width="10" height="4" ${FACE}/><rect x="5.5" y="11.5" width="6" height="4" ${FACE}/>`
  },
  'align-center-x': {
    ...TOOL,
    body: `<rect x="4.5" y="4.5" width="10" height="4" ${FACE}/><rect x="6.5" y="11.5" width="6" height="4" ${FACE}/><path d="M9.5 2.5v15"/>`
  },
  'align-right': {
    ...TOOL,
    body: `<path d="M16.5 2.5v15"/><rect x="4.5" y="4.5" width="10" height="4" ${FACE}/><rect x="8.5" y="11.5" width="6" height="4" ${FACE}/>`
  },
  'align-top': {
    ...TOOL,
    body: `<path d="M2.5 3.5h15"/><rect x="4.5" y="5.5" width="4" height="10" ${FACE}/><rect x="11.5" y="5.5" width="4" height="6" ${FACE}/>`
  },
  'align-center-y': {
    ...TOOL,
    body: `<rect x="4.5" y="4.5" width="4" height="10" ${FACE}/><rect x="11.5" y="6.5" width="4" height="6" ${FACE}/><path d="M2.5 9.5h15"/>`
  },
  'align-bottom': {
    ...TOOL,
    body: `<path d="M2.5 16.5h15"/><rect x="4.5" y="4.5" width="4" height="10" ${FACE}/><rect x="11.5" y="8.5" width="4" height="6" ${FACE}/>`
  },
  'distribute-horizontal': {
    ...TOOL,
    body: `<path d="M2.5 3.5v13M17.5 3.5v13"/><rect x="5.5" y="6.5" width="3" height="7" ${FACE}/><rect x="11.5" y="6.5" width="3" height="7" ${FACE}/>`
  },
  'distribute-vertical': {
    ...TOOL,
    body: `<path d="M3.5 2.5h13M3.5 17.5h13"/><rect x="6.5" y="5.5" width="7" height="3" ${FACE}/><rect x="6.5" y="11.5" width="7" height="3" ${FACE}/>`
  },
  // Rotate and mirror the selection: the turn's arrow around a body, the flip
  // as a body and its image across the axis.
  'tool-rotate-ccw': {
    ...TOOL,
    body: `<rect x="7.5" y="8.5" width="4" height="4" ${FACE}/><path d="M9.5 4.5a6 6 0 1 0 6 6M13.5 12.5l2-2 2 2"/>`
  },
  'tool-rotate-cw': {
    ...TOOL,
    body: `<rect x="8.5" y="8.5" width="4" height="4" ${FACE}/><path d="M10.5 4.5a6 6 0 1 1-6 6M2.5 12.5l2-2 2 2"/>`
  },
  'tool-mirror-horizontal': {
    ...TOOL,
    body: `<path d="M10.5 2.5v15" stroke-opacity="0.5"/><path ${FACE} d="M8.5 5.5v10h-5z"/><path d="M12.5 5.5v10h5z"/>`
  },
  'tool-mirror-vertical': {
    ...TOOL,
    body: `<path d="M2.5 10.5h15" stroke-opacity="0.5"/><path ${FACE} d="M5.5 8.5h10v-5z"/><path d="M5.5 12.5h10v5z"/>`
  },
  // Change side: a part and its outline on the far side, with the turn between.
  'tool-flip': {
    ...TOOL,
    body:
      `<rect x="2.5" y="9.5" width="6" height="7" ${FACE}/>` +
      '<rect x="11.5" y="9.5" width="6" height="7" stroke-opacity="0.5"/>' +
      '<path d="M5.5 6.5a4.5 3.5 0 0 1 9 0M12.5 4.5l2 2 2-2"/>'
  },
  // Move Symbol Anchor and Place Footprint Anchor: a ship's anchor, KiCad's
  // glyph for both tools.
  'tool-anchor': {
    ...TOOL,
    body:
      `<circle cx="10" cy="4" r="1.5" ${FACE}/>` +
      '<path d="M10 5.5v11M7 8.5h6M3.5 11.5a6.5 5 0 0 0 13 0"/>'
  },
  'tool-repeat': {
    ...TOOL,
    body: `<g ${SOLID}><circle cx="10" cy="4.5" r="1.5"/><circle cx="10" cy="10" r="1.5"/><circle cx="10" cy="15.5" r="1.5"/></g>`
  },
  'tool-add': { ...TOOL, body: '<path d="M10.5 4.5v12M4.5 10.5h12"/>' },
  'tool-remove': { ...TOOL, body: '<path d="M4.5 10.5h12"/>' },
  // The tool search's magnifier — the field's face while it is a chip.
  'tool-search': { ...TOOL, body: '<circle cx="8.5" cy="8.5" r="5"/><path d="M12.5 12.5l4 4"/>' },
  // Router modes. Shove pushes other tracks aside.
  'route-shove': {
    ...TOOL,
    body: '<path d="M3.5 7.5h12M3.5 12.5h12M12.5 4.5l3 3-3 3M12.5 9.5l3 3-3 3"/>'
  },
  // Walkaround: the new trace bends round an obstacle it leaves in place.
  'route-walkaround': {
    ...TOOL,
    body: `<circle cx="10.5" cy="13.5" r="2.5" ${TONE} stroke="none"/><path d="M2.5 13.5h2l5-5h2l5 5h1" stroke-width="2" stroke-linecap="butt"/>`
  },
  // Highlight: the router only marks the collision.
  'route-highlight': {
    ...TOOL,
    body:
      `<path ${FACE} d="M10 3 17.5 16.5h-15z"/>` +
      `<g ${SOLID}><rect x="9.5" y="7.5" width="1" height="5"/><rect x="9.5" y="13.5" width="1" height="1.5"/></g>`
  },
  // Ignore: clearance switched off — the route commits through what it meets.
  'route-ignore': {
    ...TOOL,
    body: `<circle cx="10" cy="10" r="6.5" ${FACE}/><path d="M5.4 14.6l9.2-9.2"/>`
  },
  // Corner modes: any angle, 90°, 45°.
  'corner-free': { ...TOOL, body: '<path d="M16.5 4.5l-13 11h13"/>' },
  'corner-90': { ...TOOL, body: '<path d="M4.5 3.5v12h12"/>' },
  // Track width: a trace with a dimension across it.
  'tool-track-width': {
    ...TOOL,
    body: `<rect x="2" y="8" width="16" height="4" ${TONE}/><path d="M10.5 2.5v4M8.5 4.5l2 2 2-2M10.5 17.5v-4M8.5 15.5l2-2 2 2"/>`
  },
  'corner-45': { ...TOOL, body: '<path d="M4.5 3.5v6l6 6h6"/>' },
  // The rounded modes: the same bends with their corner an arc (KiCad's Arc 45 / Arc 90).
  'corner-arc45': { ...TOOL, body: '<path d="M4.5 3.5v6a8.5 8.5 0 0 0 6 6h6"/>' },
  'corner-arc90': { ...TOOL, body: '<path d="M4.5 3.5v6a6 6 0 0 0 6 6h6"/>' },
  // Posture: which leg of a two-segment route comes first.
  'posture-diagonal': { ...TOOL, body: '<path d="M3.5 15.5l6-6h7"/>' },
  'posture-straight': { ...TOOL, body: '<path d="M3.5 15.5h6l6-6"/>' },
  // PCB view rail. The sketch toggles draw the item as its bare outline.
  'view-zone-fills': {
    ...TOOL,
    body:
      '<path d="M3.5 7.5l4-4M3.5 12.5l9-9M4.5 16.5 15 6M9.5 16.5l7-7M14.5 16.5l2-2" stroke-opacity="0.5" stroke-linecap="butt"/>' +
      '<path d="M3.5 3.5h9l4 4v9h-13z"/>'
  },
  'view-sketch-tracks': {
    ...TOOL,
    body: '<path d="M5.5 7.5h9a3 3 0 0 1 0 6h-9a3 3 0 0 1 0-6z"/>'
  },
  'view-sketch-vias': {
    ...TOOL,
    body: '<circle cx="10" cy="10" r="6.5"/><circle cx="10" cy="10" r="2.5"/>'
  },
  'view-sketch-pads': { ...TOOL, body: '<rect x="4.5" y="4.5" width="11" height="11" rx="2"/>' },
  // Footprint view rail: the polygon and text tools' glyphs as bare outlines.
  'view-sketch-graphics': { ...TOOL, body: '<path d="M10 3.5l6.5 4.7-2.5 8.3H6L3.5 8.2z"/>' },
  'view-sketch-text': {
    ...TOOL,
    body: '<path d="M4 4h12v3.5h-1.2L14 5.5h-3V15h1.5v1.5h-5V15H9V5.5H6l-.8 2H4z"/>'
  },
  // Two pads and the dashed airwire between them.
  'view-ratsnest': {
    ...TOOL,
    body:
      `<g ${TONE} stroke="none"><rect x="3" y="13" width="4" height="4"/><rect x="13" y="3" width="4" height="4"/></g>` +
      '<path d="M7.5 12.5l5-5" stroke-dasharray="1.5 1.5" stroke-linecap="butt"/>'
  },
  // The board-area tint: a board with its corner holes, its inside shaded.
  'view-board-area': {
    ...TOOL,
    body:
      `<rect x="3.5" y="4.5" width="13" height="11" rx="2" ${FACE}/>` +
      '<circle cx="6.5" cy="7.5" r="1"/><circle cx="13.5" cy="12.5" r="1"/>'
  },
  // Board selection verbs, found through the tool search (their keys: L, U,
  // Shift+Del; Select Net has none, as in KiCad).
  'tool-lock': {
    ...TOOL,
    body: `<rect x="4.5" y="9.5" width="11" height="7" rx="1" ${FACE}/><path d="M6.5 9.5v-3a3.5 3.5 0 0 1 7 0v3"/>`
  },
  // The same padlock with its shackle swung open.
  'tool-unlock': {
    ...TOOL,
    body: `<rect x="4.5" y="9.5" width="11" height="7" rx="1" ${FACE}/><path d="M6.5 9.5v-3a3.5 3.5 0 0 1 7 0"/>`
  },
  // A run of track between two pads.
  'tool-select-connection': {
    ...TOOL,
    body: `${ring(4.5, 15.5, 2.5, 1)}${ring(15.5, 4.5, 2.5, 1)}<path d="M6.5 13.5l3-3v-4h4"/>`
  },
  // One net branching to three pads.
  'tool-select-net': {
    ...TOOL,
    body:
      `<g ${TONE} stroke="none"><rect x="2.5" y="2.5" width="4" height="4"/>` +
      '<rect x="13.5" y="8" width="4" height="4"/><rect x="2.5" y="13.5" width="4" height="4"/></g>' +
      '<path d="M4.5 6.5v7M4.5 10h9"/>'
  },
  // The origins. The grid's (the board's tool search, the footprint editor's
  // toolbar): grid dots measured
  // from the crosshair in the corner; the drill / place files': KiCad's mark,
  // a ring on a cross, which is also how the canvas draws it.
  'tool-grid-origin': {
    ...TOOL,
    body:
      `<g ${SOLID}><circle cx="10.5" cy="4.5" r="1"/><circle cx="16.5" cy="4.5" r="1"/>` +
      '<circle cx="10.5" cy="10.5" r="1"/><circle cx="16.5" cy="10.5" r="1"/></g>' +
      '<circle cx="5.5" cy="14.5" r="2.5"/><path d="M1.5 14.5h8M5.5 10.5v8"/>'
  },
  'tool-drill-origin': {
    ...TOOL,
    body: '<circle cx="10" cy="10" r="4.5"/><path d="M10 2.5v15M2.5 10h15"/>'
  },
  // A track with the delete cross over its end.
  // A track from a pad with a stub off it, faded, and the stub's mark of removal:
  // KiCad's Cleanup Tracks & Vias.
  'tool-cleanup': {
    ...TOOL,
    body:
      `<circle cx="5" cy="15" r="2" ${TONE}/>` +
      '<path d="M6.5 13.5L12 8h6" stroke-width="2" stroke-linecap="butt" stroke-linejoin="round"/>' +
      '<path d="M12 7V3" stroke-width="2" stroke-linecap="butt" stroke-opacity="0.5"/>' +
      '<path d="M14.5 2.5l3 3M17.5 2.5l-3 3"/>'
  },
  // A via with a track leaving it, the taper between them: KiCad's Edit Teardrops.
  'tool-teardrop': {
    ...TOOL,
    body:
      `<circle cx="6" cy="10" r="3.5" ${TONE}/>` +
      '<path d="M8.5 7.5c3 1 5.5 2 9 2.5M8.5 12.5c3-1 5.5-2 9-2.5"/>'
  },
  'tool-delete-track': {
    ...TOOL,
    body: '<path d="M2.5 16.5l5-5h3" stroke-opacity="0.5"/><path d="M11.5 3.5l5 5M16.5 3.5l-5 5"/>'
  },
  'view-dim': {
    ...TOOL,
    body: `<circle cx="10" cy="10" r="6.5"/><path ${TONE} stroke="none" d="M10 3.5a6.5 6.5 0 0 1 0 13z"/>`
  },
  'view-flip': {
    ...TOOL,
    body: '<path d="M3.5 6.5h13M13.5 3.5l3 3-3 3M16.5 13.5h-13M6.5 10.5l-3 3 3 3"/>'
  },
  // A board seen from above with two parts on it — the assembly overlay.
  'view-assembly': {
    ...TOOL,
    body:
      `<rect x="2.5" y="4.5" width="15" height="11" ${FACE}/>` +
      `<g ${TONE} stroke="none"><rect x="5" y="7" width="5" height="3"/><rect x="11" y="10" width="4" height="3"/></g>`
  },
  // The 3D preview's toggle: an isometric cube, its top face shaded. The
  // verticals sit on .5 columns; the slopes are the only off-grid strokes.
  'tool-3d': {
    ...TOOL,
    body:
      `<path ${FACE} d="M10.5 2.5l7 4-7 4-7-4z"/>` +
      '<path d="M10.5 2.5l7 4v7l-7 4-7-4v-7zM3.5 6.5l7 4 7-4M10.5 10.5v7"/>'
  },
  // Zoom to fit: the view's corners closing on the content they frame.
  'tool-fit': {
    ...TOOL,
    body:
      '<path d="M2.5 6.5v-4h4M13.5 2.5h4v4M17.5 13.5v4h-4M6.5 17.5h-4v-4"/>' +
      `<rect x="6" y="6" width="8" height="8" ${FACE}/>`
  },
  // Zoom in / out: the magnifier, with its plus or minus.
  'tool-zoom-in': {
    ...TOOL,
    body: `<circle cx="8.5" cy="8.5" r="5.5" ${FACE}/><path d="M12.5 12.5l5 5M6 8.5h5M8.5 6v5"/>`
  },
  'tool-zoom-out': {
    ...TOOL,
    body: `<circle cx="8.5" cy="8.5" r="5.5" ${FACE}/><path d="M12.5 12.5l5 5M6 8.5h5"/>`
  },
  // Center on cursor: the view's corners around the cursor's crosshair.
  'tool-zoom-center': {
    ...TOOL,
    body:
      '<path d="M2.5 6.5v-4h4M12.5 2.5h4v4M16.5 12.5v4h-4M6.5 16.5h-4v-4"/>' +
      `<path d="M9.5 5.5v3M9.5 10.5v3M5.5 9.5h3M10.5 9.5h3"/><rect x="9" y="9" width="1" height="1" ${SOLID}/>`
  },
  // Zoom to selection: the view's corners closing on a selected item and its handles.
  'tool-zoom-selection': {
    ...TOOL,
    body:
      '<path d="M2.5 6.5v-4h4M13.5 2.5h4v4M17.5 13.5v4h-4M6.5 17.5h-4v-4"/>' +
      `<rect x="7.5" y="7.5" width="5" height="5" ${FACE}/>${handle(7.5, 7.5)}${handle(12.5, 12.5)}`
  },
  // Schematic view rail: a wire with the net's highlight band around it.
  'view-net-highlight': {
    ...TOOL,
    body: `<path ${TONE} stroke="none" d="M2 12h5V5h11v3h-8v7H2z"/><path d="M2.5 13.5h6v-7h9"/>`
  },
  // Hidden pins and fields: the pin and text tools' glyphs, their strokes dashed.
  'view-hidden-pins': {
    ...TOOL,
    body:
      '<path d="M16.5 5.5v10" stroke-opacity="0.5"/>' +
      `<path d="M7.5 10.5h9" stroke-dasharray="1.5 1.5" stroke-linecap="butt"/><circle cx="5" cy="10.5" r="2.5" ${FACE}/>`
  },
  'view-hidden-fields': {
    ...TOOL,
    body: '<path d="M4.5 7.5v-3h10v3M9.5 4.5v11M7.5 15.5h4" stroke-dasharray="1.5 1.5" stroke-linecap="butt"/>'
  },

  // ── Component-type glyphs (16×16 line-art; ComponentTypeIcon.vue) ──
  // An op-amp triangle with pins — the schematic symbol silhouette.
  'ctype-symbol': {
    ...LINE,
    strokeWidth: 1.2,
    strokeLinecap: 'round',
    body: '<path d="M4.5 3 4.5 13 12.5 8Z"/><path d="M1.5 5.8H4.5M1.5 10.2H4.5M12.5 8H14.5"/>'
  },
  // An SOIC land pattern — a stroked courtyard with solid copper pads.
  'ctype-footprint': {
    ...LINE,
    strokeWidth: 1.2,
    body: '<rect x="5" y="3" width="6" height="10" rx="1"/><g fill="currentColor" stroke="none"><rect x="1.7" y="4.6" width="3" height="2.2" rx="0.6"/><rect x="1.7" y="9.2" width="3" height="2.2" rx="0.6"/><rect x="11.3" y="4.6" width="3" height="2.2" rx="0.6"/><rect x="11.3" y="9.2" width="3" height="2.2" rx="0.6"/></g>'
  },

  // ── Virtual-tab glyphs (24×24; single-use) ──
  // The Component viewer tab — a cog with a hollow center, distinct from
  // `settings`; the tab tints it the component violet (main.css).
  'tab-component': {
    viewBox: '0 0 24 24',
    body: '<path d="M20 8h-2.81a5.985 5.985 0 00-1.82-1.96L17 3.86 15.14 2 12.6 4.55c-.4-.05-.79-.05-1.19 0L8.86 2 7 3.86l1.63 2.18A5.985 5.985 0 006.81 8H4v2h2.09c-.05.33-.09.66-.09 1s.04.67.09 1H4v2h2.81c.45.78 1.07 1.45 1.82 1.96L7 20.14 8.86 22l2.54-2.55c.39.05.79.05 1.19 0L15.14 22 17 20.14l-1.63-2.18A5.99 5.99 0 0017.19 16H20v-2h-2.09c.05-.33.09-.66.09-1s-.04-.67-.09-1H20V8zm-8 7a3 3 0 110-6 3 3 0 010 6z"/>'
  },
  // The Components table — rows under a header, for the tab and its button.
  'components-table': {
    viewBox: '0 0 24 24',
    body: '<path d="M4 4h16a1 1 0 011 1v14a1 1 0 01-1 1H4a1 1 0 01-1-1V5a1 1 0 011-1zm1 5v3h5V9H5zm7 0v3h7V9h-7zm-7 5v4h5v-4H5zm7 0v4h7v-4h-7z"/>'
  }
} satisfies Record<string, IconDef>

export type IconName = keyof typeof ICONS

/**
 * A CSS `cursor` value rendered from a registry glyph — the canvas draw-tool
 * cursors, so the pointer glyph is the same pencil the UI shows elsewhere.
 * Line-art glyphs only: the body is stroked twice, a dark halo under a light
 * stroke, so the cursor reads on both copper and empty canvas. `hotspotX/Y`
 * are in rendered-cursor pixels (of `size`). Falls back to `crosshair` where
 * image cursors are unsupported.
 */
export function iconCursor(name: IconName, hotspotX: number, hotspotY: number, size = 18): string {
  const def: IconDef = ICONS[name]
  const cap = def.strokeLinecap ?? 'round'
  const join = def.strokeLinejoin ?? 'round'
  const width = def.strokeWidth ?? 1.5
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${def.viewBox}">` +
    `<g fill="none" stroke="#10221b" stroke-opacity="0.9" stroke-width="${width + 1.6}" stroke-linecap="${cap}" stroke-linejoin="${join}">${def.body}</g>` +
    `<g fill="none" stroke="#f2efe9" stroke-width="${width}" stroke-linecap="${cap}" stroke-linejoin="${join}">${def.body}</g>` +
    `</svg>`
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${hotspotX} ${hotspotY}, crosshair`
}
