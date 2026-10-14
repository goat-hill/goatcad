// GoatHerd's UI glyph registry. Call-site CSS controls color and size.

export interface IconDef {
  viewBox: string
  /** Inner SVG markup (paths/lines/rects/…). */
  body: string
  /** `'none'` for stroked line-art; omit for fill glyphs (defaults to currentColor). */
  fill?: string
  stroke?: string
  strokeWidth?: number
  strokeLinecap?: 'round' | 'butt' | 'square'
  strokeLinejoin?: 'round' | 'miter' | 'bevel'
}

// Shared 16×16 line-art defaults; callers may override them.
const LINE: Omit<IconDef, 'body'> = {
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round'
}

export const ICONS = {
  // Claude "burst" — six crossing spokes.
  claude: {
    ...LINE,
    body: '<line x1="14.5" y1="8" x2="1.5" y2="8"/><line x1="13.63" y1="11.25" x2="2.37" y2="4.75"/><line x1="11.25" y1="13.63" x2="4.75" y2="2.37"/><line x1="8" y1="14.5" x2="8" y2="1.5"/><line x1="4.75" y1="13.63" x2="11.25" y2="2.37"/><line x1="2.37" y1="11.25" x2="13.63" y2="4.75"/>'
  },
  // A prompt box with a `>` caret — the embedded terminal.
  terminal: {
    ...LINE,
    body: '<rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><polyline points="4.5 6 7 8.2 4.5 10.4"/><line x1="8.5" y1="10.5" x2="11.5" y2="10.5"/>'
  },
  // A globe — the dev-server / web view.
  globe: {
    ...LINE,
    body: '<circle cx="8" cy="8" r="6.5"/><ellipse cx="8" cy="8" rx="3" ry="6.5"/><line x1="1.5" y1="8" x2="14.5" y2="8"/>'
  },
  // Angle brackets `< >` — open in the code editor.
  code: {
    ...LINE,
    body: '<polyline points="5 4 1.5 8 5 12"/><polyline points="11 4 14.5 8 11 12"/>'
  },
  // A framed photo — the Workspace media view.
  image: {
    ...LINE,
    body: '<rect x="1.5" y="3.5" width="13" height="10" rx="1.5"/><path d="M1.5 6.5h13"/><path d="M5.5 3.5 6.8 5.5"/><circle cx="5" cy="10" r="1.2"/><path d="m7.6 11.5 1.6-2 1.4 1.6 1-1.1 1.4 1.5"/>'
  },
  // A waste bin — remove the worktree.
  trash: {
    ...LINE,
    body: '<path d="M3 4.5h10"/><path d="M5.5 4.5V3a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1.5"/><path d="M4.5 4.5l.7 9a1 1 0 0 0 1 .9h3.6a1 1 0 0 0 1-.9l.7-9"/>'
  },
  // Two panes side by side — split the group.
  split: {
    ...LINE,
    body: '<rect x="1.5" y="2.5" width="5.5" height="11" rx="1"/><rect x="9" y="2.5" width="5.5" height="11" rx="1"/>'
  },
  // A git branch — the Git Diff view.
  diff: {
    ...LINE,
    body: '<circle cx="4.5" cy="3.5" r="2"/><circle cx="4.5" cy="12.5" r="2"/><circle cx="11.5" cy="3.5" r="2"/><path d="M4.5 5.5v5"/><path d="M11.5 5.5v1.5a3 3 0 0 1-3 3H6.5"/>'
  },
  // A right-pointing caret — expand/collapse a file's diff (rotated by CSS).
  chevron: {
    ...LINE,
    body: '<polyline points="6 3.5 10.5 8 6 12.5"/>'
  },
  // A circular reload arrow — refresh (sidebar, quota, Workspace).
  refresh: {
    ...LINE,
    body: '<path d="M14 8a6 6 0 1 1-6-6c1.68 0 3.29.67 4.49 1.83L14 5.33"/><path d="M14 2v3.33h-3.33"/>'
  },

  // ── Fill glyphs (no baked fill; `.dirty-icon` / `.control-btn svg` drive) ──
  // A filled dot — uncommitted changes.
  dirty: {
    viewBox: '0 0 16 16',
    body: '<circle cx="8" cy="8" r="3.5"/>'
  },
  'window-minimize': {
    viewBox: '0 0 10 1',
    body: '<rect y="0" width="10" height="1"/>'
  },
  'window-maximize': {
    viewBox: '0 0 10 10',
    body: '<path d="M0,0v10h10V0H0z M9,9H1V1h8V9z"/>'
  },
  'window-close': {
    viewBox: '0 0 10 10',
    body: '<polygon points="10,0.7 9.3,0 5,4.3 0.7,0 0,0.7 4.3,5 0,9.3 0.7,10 5,5.7 9.3,10 10,9.3 5.7,5"/>'
  }
} satisfies Record<string, IconDef>

export type IconName = keyof typeof ICONS
