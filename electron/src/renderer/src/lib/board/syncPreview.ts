/**
 * A sync plan as Update PCB from Schematic shows it before applying
 * (`UpdatePcbDialog.vue`): one row per footprint it adds, finds no symbol for,
 * or updates — reference, value and footprint, and what about it changes —
 * and whether applying would write anything at all. Bookkeeping an update
 * also rewrites (sheet names, the symbol link, footprint filters, pin types)
 * is applied, not listed.
 */
import { compareReferencesNatural } from '../componentsTable'
import type { SyncChange, SyncPlan, SyncSkipReason } from './boardSync'

/** The options Update PCB from Schematic offers: KiCad's of these names. */
export interface UpdatePcbOptions {
  prune: boolean
  replaceFootprints: boolean
  updateFields: boolean
}

/** What an update changes on a footprint, as a reader names it. */
export type SyncRowChange = 'reference' | 'value' | 'footprint' | 'nets' | 'fields' | 'attributes'

export interface SyncPreviewRow {
  kind: 'add' | 'remove' | 'update'
  reference: string
  value: string
  /** The footprint, `lib:name`; '' when the part names none. */
  libId: string
  /** What an update changes from, where it changes it. */
  referenceFrom?: string
  valueFrom?: string
  libIdFrom?: string
  /** An update's changes, in reading order. */
  changes: SyncRowChange[]
  /** A part that cannot be added, and why. */
  problem?: SyncSkipReason
}

const KIND_ORDER = { add: 0, remove: 1, update: 2 }

/** An update's changes as a row names them, in the table's column order; bookkeeping left out. */
const rowChanges = (changes: readonly SyncChange[], swapped: boolean): SyncRowChange[] => {
  const shown: SyncRowChange[] = []
  if (changes.includes('reference')) shown.push('reference')
  if (changes.includes('value')) shown.push('value')
  if (swapped) shown.push('footprint')
  for (const change of ['nets', 'fields', 'attributes'] as const)
    if (changes.includes(change)) shown.push(change)
  return shown
}

export const syncPreviewRows = (plan: SyncPlan): SyncPreviewRow[] => {
  const rows: SyncPreviewRow[] = plan.add.map(({ part }) => ({
    kind: 'add',
    reference: part.reference,
    value: part.value,
    libId: part.libId,
    changes: []
  }))
  for (const skip of plan.skipped)
    rows.push({
      kind: 'add',
      reference: skip.reference,
      value: '',
      libId: skip.libId ?? '',
      changes: [],
      problem: skip.reason
    })
  for (const orphan of plan.orphans)
    rows.push({
      kind: 'remove',
      reference: orphan.reference,
      value: orphan.footprint.value ?? '',
      libId: orphan.libId,
      changes: []
    })

  // A footprint is one row however it changes: its update and its swap merge.
  const swaps = new Map(
    plan.footprintChanged
      .filter((change) => change.library)
      .map((change) => [change.footprint, change])
  )
  for (const { part, footprint, changes } of plan.update) {
    const swap = swaps.get(footprint)
    swaps.delete(footprint)
    const shown = rowChanges(changes, !!swap)
    if (!shown.length) continue
    rows.push({
      kind: 'update',
      reference: part.reference,
      value: part.value,
      libId: swap ? swap.schematic : footprint.libId,
      ...(changes.includes('reference') ? { referenceFrom: footprint.reference ?? '' } : {}),
      ...(changes.includes('value') ? { valueFrom: footprint.value ?? '' } : {}),
      ...(swap ? { libIdFrom: swap.board } : {}),
      changes: shown
    })
  }
  for (const swap of swaps.values())
    rows.push({
      kind: 'update',
      reference: swap.reference,
      value: swap.footprint.value ?? '',
      libId: swap.schematic,
      libIdFrom: swap.board,
      changes: ['footprint']
    })

  return rows.sort(
    (a, b) =>
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || compareReferencesNatural(a.reference, b.reference)
  )
}

/** Whether applying writes anything: orphans count only when they are to be removed. */
export const syncWouldChange = (plan: SyncPlan, prune: boolean): boolean =>
  plan.add.length > 0 ||
  plan.update.length > 0 ||
  plan.footprintChanged.some((change) => change.library) ||
  (prune && plan.orphans.length > 0)
