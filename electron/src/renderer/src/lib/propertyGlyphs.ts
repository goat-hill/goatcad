// SVG path data for the icon-only segments of a `segmented` property editor
// (PropertyTable.vue). Rendered inside a `<svg viewBox="0 0 24 24">` with a
// stroked `<path>`, matching the app's hand-inlined icon convention (the eye in
// LayersPanel, FileIcon, …) — no icon-library dependency.
//
// The horizontal alignment glyphs are Lucide's `align-left/center/right` path
// data verbatim (Lucide, ISC-licensed). The vertical set is those same three
// glyphs rotated 90° clockwise about the 12,12 center, so the horizontal and
// vertical toggles read as one family with identical stroke lengths.

export const SEGMENT_GLYPHS: Record<string, string> = {
  // Text horizontal alignment — Lucide align-{left,center,right}.
  'align-left': 'M21 6H3 M15 12H3 M17 18H3',
  'align-center': 'M21 6H3 M17 12H7 M19 18H5',
  'align-right': 'M21 6H3 M21 12H9 M21 18H7',
  // Text vertical alignment — the above rotated 90° (bars anchored top/mid/bottom).
  'align-top': 'M6 3V21 M12 3V15 M18 3V17',
  'align-middle': 'M6 3V21 M12 7V17 M18 5V19',
  'align-bottom': 'M6 3V21 M12 9V21 M18 7V21'
}
