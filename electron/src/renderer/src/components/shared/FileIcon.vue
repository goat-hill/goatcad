<script setup lang="ts">
import { computed } from 'vue'
import { isImageFile } from '../../lib/imageFiles'
import { isGerberFile } from '../../lib/gerber/files'
import { isPdfFile, isHtmlFile } from '../../lib/documentFiles'

/**
 * The one place a file kind becomes a glyph. Shared so the File Explorer, the
 * Project pane and the tab strip cannot drift.
 *
 * Drawn by DESIGN.md §Icons → File glyphs: a 16-unit grid rendered at 16px,
 * 1px strokes on .5 coordinates, and the canvas palette's tones (full stroke,
 * a 50% tone for the working part, a 20% face for the body), here tinted by
 * kind rather than by state.
 *
 * - The glyph is the thing itself, never the thing on a sheet or in a frame:
 *   an op-amp, a land pattern, a cube, a landscape, a tag, lines of text.
 *   Only the two design documents keep a body — a schematic is a sheet, a
 *   board is a board.
 * - The hue says which side of the design it is on: the schematic side is
 *   violet, the board side cyan. Neither is gold or green, and nothing here
 *   is drawn in the accent, because those are the git colors (modified,
 *   added) the tree paints on its labels.
 * - Foreign formats take one hue each; plain files stay neutral so the design
 *   files stand out in a busy tree.
 * - A folder has no glyph, a `.pretty` library included: its caret already
 *   says it opens, and a row of folder shapes was noise between the files.
 *   The explorer and the Project pane draw no glyph on a `.kicad_sym` row
 *   either; `library-symbol` is here for its editor tab.
 *
 * Every hue is a `--vscode-file-*` token (base.css), set as the glyph's
 * `color` so strokes, tones and faces follow it through `currentColor`.
 */
type FileIconKind =
  | 'schematic'
  | 'pcb'
  | 'symbol'
  | 'library-symbol'
  | 'footprint'
  | 'model3d'
  | 'image'
  | 'gerber'
  | 'pdf'
  | 'html'
  | 'markdown'
  | 'file'

const props = defineProps<{
  /** Filename to classify. Ignored when `kind` is given. */
  name?: string
  isDirectory?: boolean
  /** Explicit kind, for rows that aren't files (a library nickname). */
  kind?: FileIconKind
}>()

const kindForFileName = (name: string, isDirectory = false): FileIconKind | null => {
  const lower = name.toLowerCase()
  // Folders have no glyph, a `.pretty` library included: in the explorer it
  // is a folder of `.kicad_mod` files, each of which shows the footprint.
  if (isDirectory) return null
  if (lower.endsWith('.kicad_sch')) return 'schematic'
  if (lower.endsWith('.kicad_pcb')) return 'pcb'
  if (lower.endsWith('.kicad_sym')) return 'library-symbol'
  // A `.kicad_mod` is one footprint; a `.pretty` directory is a library of
  // them. Sharing a glyph made a single part look like a collection.
  if (lower.endsWith('.kicad_mod')) return 'footprint'
  if (lower.endsWith('.step') || lower.endsWith('.stp') || lower.endsWith('.wrl')) return 'model3d'
  if (isImageFile(lower)) return 'image'
  if (isGerberFile(lower)) return 'gerber'
  if (isPdfFile(lower)) return 'pdf'
  if (isHtmlFile(lower)) return 'html'
  if (lower.endsWith('.md')) return 'markdown'
  return 'file'
}

const icon = computed(
  (): FileIconKind | null => props.kind ?? kindForFileName(props.name ?? '', props.isDirectory)
)

const HUE: Record<FileIconKind, string> = {
  schematic: 'var(--vscode-file-schematic)',
  symbol: 'var(--vscode-file-schematic)',
  'library-symbol': 'var(--vscode-file-schematic)',
  pcb: 'var(--vscode-file-board)',
  footprint: 'var(--vscode-file-board)',
  gerber: 'var(--vscode-file-board)',
  model3d: 'var(--vscode-file-board)',
  image: 'var(--vscode-file-image)',
  pdf: 'var(--vscode-file-pdf)',
  html: 'var(--vscode-file-html)',
  markdown: 'var(--vscode-file-markdown)',
  file: 'var(--vscode-file-plain)'
}
</script>

<template>
  <span v-if="icon" class="tree-node-icon">
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1"
      stroke-linecap="round"
      stroke-linejoin="round"
      :style="{ color: HUE[icon] }"
    >
      <!-- Schematic: a sheet with a symbol on it, an op-amp and its inputs. -->
      <template v-if="icon === 'schematic'">
        <path d="M3.5 1.5h6l3 3v10h-9z" fill="currentColor" fill-opacity="0.2" />
        <path d="M9.5 1.5v3h3" />
        <path d="M6.5 7.5v6l4.5-3z" fill="currentColor" fill-opacity="0.5" />
        <path d="M5 9h1.5M5 12h1.5" />
      </template>

      <!-- Board: solder mask, and a trace between two pads. -->
      <template v-else-if="icon === 'pcb'">
        <rect
          x="1.5"
          y="2.5"
          width="13"
          height="11"
          rx="1.5"
          fill="currentColor"
          fill-opacity="0.2"
        />
        <path d="M4.5 10.5l3-3h4" />
        <circle cx="4.5" cy="10.5" r="1.5" fill="currentColor" stroke="none" />
        <circle cx="11.5" cy="7.5" r="1.5" fill="currentColor" stroke="none" />
      </template>

      <!-- Symbol, and a library of them: one op-amp — its inputs and its output. -->
      <template v-else-if="icon === 'symbol' || icon === 'library-symbol'">
        <path d="M4.5 3.5v9l7-4.5z" fill="currentColor" fill-opacity="0.5" />
        <path d="M1.5 6h3M1.5 10h3M11.5 8h3" />
      </template>

      <!-- Footprint: one land pattern — two rows of
           pads, as an IC's. A lone pair read as "00" (outlined) or a pause
           sign (solid). -->
      <path
        v-else-if="icon === 'footprint'"
        d="M2 3h4v2H2zM2 7h4v2H2zM2 11h4v2H2zM10 3h4v2h-4zM10 7h4v2h-4zM10 11h4v2h-4z"
        fill="currentColor"
        stroke="none"
      />

      <!-- Gerber: fabrication layers, the copper one on top. -->
      <template v-else-if="icon === 'gerber'">
        <path d="M8 2.5l6 3-6 3-6-3z" fill="currentColor" fill-opacity="0.5" />
        <path d="M2 8.5l6 3 6-3M2 11.5l6 3 6-3" />
      </template>

      <!-- 3D geometry: a cube, its top face toned. -->
      <template v-else-if="icon === 'model3d'">
        <path d="M8 1.5l6 3.25v6.5L8 14.5l-6-3.25v-6.5z" fill="currentColor" fill-opacity="0.2" />
        <path d="M8 1.5l6 3.25L8 8 2 4.75z" fill="currentColor" fill-opacity="0.5" stroke="none" />
        <path d="M2 4.75L8 8l6-3.25M8 8v6.5" />
      </template>

      <!-- Image: a landscape, a sun over two peaks. -->
      <template v-else-if="icon === 'image'">
        <path d="M1.5 13.5l4-6.5 3.5 4.5 2-2.5 3.5 4.5z" fill="currentColor" fill-opacity="0.5" />
        <circle cx="11.5" cy="4.5" r="1.5" fill="currentColor" stroke="none" />
      </template>

      <!-- HTML: a tag, </>. -->
      <path
        v-else-if="icon === 'html'"
        d="M4.5 4.5L1.5 8l3 3.5M11.5 4.5l3 3.5-3 3.5M9.5 3.5l-3 9"
      />

      <!-- Markdown: the heading mark. -->
      <path v-else-if="icon === 'markdown'" d="M5.5 2.5v11M10.5 2.5v11M2.5 5.5h11M2.5 10.5h11" />

      <!-- PDF and plain files: lines of text. The hue tells them apart. -->
      <path v-else d="M2.5 3.5h11M2.5 6.5h11M2.5 9.5h11M2.5 12.5h7" />
    </svg>
  </span>
</template>
