/**
 * Update from library and Change, for symbols and footprints alike: what the
 * one dialog asks (`PartUpdateDialog.vue`) and how its scope picks the parts
 * (docs/libraries-workstream.md §5). KiCad's Update Symbols / Change
 * Symbols and Update Footprints / Change Footprints, as one sheet per editor.
 */
import { wildcard } from './board/rules/diffPairs'

export type PartUpdateMode = 'update' | 'change'

/** Which parts the run takes: KiCad's scopes, the whole design only when updating. */
export type PartUpdateScope = 'selection' | 'reference' | 'value' | 'libId' | 'all'

export interface PartUpdateRequest {
  mode: PartUpdateMode
  /** The lib id every part in scope takes; empty for an update that rebuilds each from its own. */
  libId: string
  scope: PartUpdateScope
  /** The reference, value or lib id to match, with `*` and `?` as wildcards. */
  pattern: string
  /** The checklist, by option key. */
  options: Record<string, boolean>
  /** Symbols: the fields the run may touch (KiCad's fields list). */
  fields: string[]
}

/** One part's outcome, listed before anything is written. */
export interface PartUpdateRow {
  reference: string
  from: string
  to: string
  /** Its library is still being read. */
  loading?: boolean
  /** No library holds `to`; it is left as it is. */
  notFound?: boolean
  /** Already its library's (an update that resets only what the checklist says). */
  matches?: boolean
  /** What else to know, worded by the editor. */
  notes?: string[]
  /** What the run loses (pads, units), worded by the editor. */
  warnings?: string[]
}

/** KiCad's wildcard match for the scope's patterns: `*` and `?`, case-insensitive. */
export const matchesPattern = (pattern: string, text: string): boolean =>
  wildcard(pattern.trim().toLowerCase(), text.toLowerCase())

/** What a scope matches a part on; the selection and the whole design need nothing. */
export interface PartIdentity {
  reference: string
  value: string
  libId: string
}

/** Whether a part falls in the request's scope; `selected` answers the selection scope. */
export const inScope = (
  request: Pick<PartUpdateRequest, 'scope' | 'pattern'>,
  part: PartIdentity,
  selected: boolean
): boolean => {
  switch (request.scope) {
    case 'selection':
      return selected
    case 'reference':
      return matchesPattern(request.pattern, part.reference)
    case 'value':
      return matchesPattern(request.pattern, part.value)
    case 'libId':
      return matchesPattern(request.pattern, part.libId)
    case 'all':
      return true
  }
}
