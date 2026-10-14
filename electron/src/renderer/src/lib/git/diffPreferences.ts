/**
 * How diff tabs draw, shared by every diff tab in the window so switching one
 * to inline switches them all. Per window and per run: a view mode, not a
 * setting worth the config store.
 */
import { readonly, ref } from 'vue'

export type DiffLayout = 'split' | 'unified'
export type DiffViewMode = 'visual' | 'text'
/** Which sheet a visual diff shows: either version alone, or the two overlaid. */
export type DiffVersion = 'before' | 'after' | 'diff'

const layout = ref<DiffLayout>('split')
const view = ref<DiffViewMode>('visual')

export const diffLayout = readonly(layout)
export const diffView = readonly(view)

export const setDiffLayout = (next: DiffLayout): void => {
  layout.value = next
}

export const setDiffView = (next: DiffViewMode): void => {
  view.value = next
}

/**
 * What a diff tab can draw as a picture. A `.kicad_sym` has no picture of its
 * own — a library is a list — so its symbols are diffed one at a time
 * (`symbol`), each from its own tab.
 */
export type VisualDiffKind = 'schematic' | 'board' | 'symbol'

export const visualDiffKind = (path: string, symbol?: string): VisualDiffKind | null => {
  if (symbol !== undefined) return 'symbol'
  const lower = path.toLowerCase()
  if (lower.endsWith('.kicad_sch')) return 'schematic'
  return lower.endsWith('.kicad_pcb') ? 'board' : null
}
