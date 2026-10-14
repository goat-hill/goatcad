/**
 * An agent's undo and redo (`*.undo`, `*.redo`, `main/ops/history.ts`) over a
 * document's own undo list, as Edit ▸ Undo and Redo step it: each door hands
 * its session here and fingerprints its items before and after.
 */
import type { McpChanged } from '../../../preload/mcpTypes'

/** A document's undo list, as its session steps it. */
export interface HistoryHost {
  undo(): { label: string } | null
  redo(): { label: string } | null
  undoLabel(): string | null
  redoLabel(): string | null
}

export type HistoryStep =
  | { ok: true; labels: string[] }
  | { ok: false; error: 'nothing-to-undo' | 'nothing-to-redo'; detail: string }

/**
 * `steps` steps back (or forward with `redo`), all or none: when the list runs
 * out partway, the steps taken are stepped the other way and nothing changed.
 * `what` names the document in the refusal ("The board").
 */
export const stepHistory = (
  host: HistoryHost,
  redo: boolean,
  steps: number,
  what: string
): HistoryStep => {
  const labels: string[] = []
  for (let taken = 0; taken < steps; taken++) {
    const entry = redo ? host.redo() : host.undo()
    if (entry) {
      labels.push(entry.label)
      continue
    }
    for (let back = 0; back < labels.length; back++) {
      if (redo) host.undo()
      else host.redo()
    }
    const list = redo ? 'redo' : 'undo'
    const held = `${labels.length} step${labels.length === 1 ? '' : 's'}`
    const detail = `${what}'s ${list} list holds ${held}; ${steps} were asked. Nothing was ${redo ? 'redone' : 'undone'}.`
    return redo
      ? { ok: false, error: 'nothing-to-redo', detail }
      : { ok: false, error: 'nothing-to-undo', detail }
  }
  return { ok: true, labels }
}

/**
 * The ids that differ between two readings of a document's items, each id
 * mapped to a fingerprint compared by identity: a board's top-level node, a
 * text document's serialized record.
 */
export const changedBetween = (
  before: ReadonlyMap<string, unknown>,
  after: ReadonlyMap<string, unknown>
): McpChanged => {
  const created: string[] = []
  const updated: string[] = []
  const deleted: string[] = []
  for (const [id, print] of after) {
    if (!before.has(id)) created.push(id)
    else if (before.get(id) !== print) updated.push(id)
  }
  for (const id of before.keys()) if (!after.has(id)) deleted.push(id)
  return { created, updated, deleted }
}

/** What an undo or redo answers beyond the document's name: the write shape, and the lists. */
export const historyAnswer = (
  redo: boolean,
  labels: string[],
  changed: McpChanged,
  host: Pick<HistoryHost, 'undoLabel' | 'redoLabel'>,
  revision: number
): Record<string, unknown> => ({
  ...(redo ? { redone: labels } : { undone: labels }),
  changed,
  revision,
  next: { undo: host.undoLabel(), redo: host.redoLabel() }
})

/** The answer's guidance: what happened to the tab, and how to take it back. */
export const historyGuidance = (redo: boolean): string =>
  redo
    ? "Redone on the tab, unsaved; the same document's undo takes the steps back."
    : "Undone on the tab, unsaved; the same document's redo puts the steps back until its next edit."
