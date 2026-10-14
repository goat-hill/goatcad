/**
 * An item picked on the visual diff's canvas, found in each version, so the
 * properties panel can build its table from both (`diffPropertyGroups`).
 *
 * The canvas draws one document — Before, After, or Diff's After with the
 * removed items appended (`withRemovedItems`, `withRemovedBoardItems`) — so a
 * pick is a render key in that document. A change names the item's key in
 * each version; an item no change names is the same in both, and is read
 * from the document drawn.
 */
import type { DiffVersion } from './diffPreferences'

/** What a pick needs of a schematic or board change. */
export interface PickableChange {
  id: string
  kind: string
  beforeKey?: string
  afterKey?: string
}

/** A picked item's render key in each version; null where it does not exist. */
export interface PickedSides {
  before: string | null
  after: string | null
}

/**
 * Where the item drawn under `key` is in each version, or null when no change
 * names it (it is the same in both). Pure.
 */
export function pickedSides(
  changes: readonly PickableChange[],
  removedKeys: ReadonlyMap<string, string>,
  version: DiffVersion,
  key: string
): PickedSides | null {
  if (version === 'before') {
    const change = changes.find((c) => c.beforeKey === key)
    return change ? { before: key, after: change.afterKey ?? null } : null
  }
  if (version === 'diff') {
    const removed = changes.find((c) => c.kind === 'removed' && removedKeys.get(c.id) === key)
    if (removed) return { before: removed.beforeKey ?? null, after: null }
  }
  const change = changes.find((c) => c.kind !== 'removed' && c.afterKey === key)
  return change ? { before: change.beforeKey ?? null, after: key } : null
}

/** The index a render key (`symbol:3`) names. */
export const keyIndex = (key: string): number => Number(key.slice(key.lastIndexOf(':') + 1))

/**
 * The render key of the item a schematic pick belongs to: a field is its
 * symbol's, a sheet's field or pin its sheet's, and a text is drawn under
 * `schematic-text`.
 */
export function schematicPickKey(ref: { type: string; index: number }): string {
  if (ref.type === 'field') return `symbol:${ref.index}`
  if (ref.type === 'sheet_field' || ref.type === 'sheet_pin') return `sheet:${ref.index}`
  if (ref.type === 'text') return `schematic-text:${ref.index}`
  return `${ref.type}:${ref.index}`
}

/** The render key of the item a board pick belongs to: a pad, field or text is its footprint's. */
export function boardPickKey(ref: { type: string; index: number }): string {
  return ref.type === 'pad' || ref.type === 'fp_field' || ref.type === 'fp_text'
    ? `footprint:${ref.index}`
    : `${ref.type}:${ref.index}`
}
