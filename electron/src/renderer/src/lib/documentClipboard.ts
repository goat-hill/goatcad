/**
 * The app's one clipboard, shared by every editor.
 *
 * Serialized s-expressions are the payload, and that is what makes a single
 * store enough: every document the app edits is a KiCad SExpr AST, so a copied
 * item is the same text whichever editor produced it. Module-scoped, so the
 * contents survive an editor remount and never alias a live AST.
 *
 * **Cross-editor paste follows KiCad's rule, not our own** (pcb-editor-workstream.md):
 * within the PCB domain a board and a footprint interoperate, and across
 * the schematic/PCB divide a paste is refused. KiCad's own cross-domain paste is
 * an open feature request (kicad#15287); being ahead of it here would mint files
 * KiCad cannot read back, which §7 of RULES.md does not allow.
 */

import { computed, ref, type ComputedRef } from 'vue'

/** The four document kinds the app edits, one per editor. */
export const DOCUMENT_KINDS = ['schematic', 'symbol', 'board', 'footprint'] as const
export type DocumentKind = (typeof DOCUMENT_KINDS)[number]

/**
 * The kinds that share one clipboard format. `PCB_CONTROL::Paste` accepts a
 * clipboard rooted at either a board or a footprint and converts between them;
 * the schematic and symbol editors each parse only their own.
 */
const PCB_DOMAIN: ReadonlySet<DocumentKind> = new Set<DocumentKind>(['board', 'footprint'])

export interface ClipboardContents {
  /** The editor the items were copied out of, which decides where they can go. */
  kind: DocumentKind
  /** One serialized top-level s-expression per copied item. */
  items: readonly string[]
}

/**
 * Whether a paste from `source` into `target` is allowed — KiCad's matrix,
 * which reduces to two rules: same kind always, and the PCB domain is one
 * world. Everything else is what KiCad reports as "Invalid clipboard contents".
 */
export function canPasteInto(source: DocumentKind, target: DocumentKind): boolean {
  if (source === target) return true
  return PCB_DOMAIN.has(source) && PCB_DOMAIN.has(target)
}

/**
 * Top-level board nodes that cannot survive a paste into a footprint: a
 * footprint has no tracks, vias or zones. KiCad drops them silently (the
 * `default:` arm of `PCB_CONTROL::Paste`'s `PCB_T` case); we drop them too but
 * owe the user a count, because the board never lies (pcb-editor-workstream.md).
 */
const BOARD_ONLY_NODES: ReadonlySet<string> = new Set(['segment', 'arc', 'via', 'zone'])

export function survivesFootprintPaste(nodeName: string): boolean {
  return !BOARD_ONLY_NODES.has(nodeName)
}

/**
 * Graphics are spelled `gr_*` on a board and `fp_*` in a footprint — the same
 * geometry under two names, so crossing the domain is a rename. A name with no
 * counterpart (a bare `footprint` node, `segment`) returns null: those are
 * handled structurally by the caller, not renamed.
 */
const GRAPHICS_STEMS = [
  'line',
  'arc',
  'circle',
  'rect',
  'poly',
  'text',
  'curve',
  'text_box'
] as const

export function translateGraphicsNode(nodeName: string, target: DocumentKind): string | null {
  const prefix = target === 'footprint' ? 'fp_' : 'gr_'
  const from = target === 'footprint' ? 'gr_' : 'fp_'
  if (!nodeName.startsWith(from)) return null
  const stem = nodeName.slice(from.length)
  return (GRAPHICS_STEMS as readonly string[]).includes(stem) ? `${prefix}${stem}` : null
}

const contents = ref<ClipboardContents | null>(null)

/** Replace the clipboard. An empty item list clears it rather than storing nothing. */
export function setClipboard(kind: DocumentKind, items: readonly string[]): void {
  contents.value = items.length > 0 ? { kind, items: [...items] } : null
}

export function clipboardContents(): ClipboardContents | null {
  return contents.value
}

/**
 * What an editor of `target` kind could paste right now — null when the
 * clipboard is empty or holds something this editor must refuse. Reactive, so
 * Paste renders grayed with a reason rather than failing on click.
 */
export function usePasteable(target: DocumentKind): ComputedRef<ClipboardContents | null> {
  return computed(() => {
    const held = contents.value
    if (!held) return null
    return canPasteInto(held.kind, target) ? held : null
  })
}

/** Test seam: drop the clipboard so a suite starts empty. */
export function __resetClipboard(): void {
  contents.value = null
}
