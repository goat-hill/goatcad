/**
 * How far an open board has drifted from its schematic, read off DRC's
 * schematic-parity findings (`drc/rules/schematicParity.ts`) — the check KiCad
 * runs with `--schematic-parity`, so a board is out of date on exactly what
 * KiCad's DRC flags, and bookkeeping an update would also rewrite (sheet
 * names, pin types) never raises it (netlist-sync-workstream.md, "Drift is
 * shown live; apply stays explicit").
 *
 * The shell reads the schematic, since its side lives there; a board editor
 * injects the source and hands the netlist to its checks.
 */
import type { InjectionKey } from 'vue'
import type { CheckResult } from '../schematic/checks'
import type { SchematicNetlist } from './schematicNetlist'

/** The project's schematic as a board's checks read it. */
export type SchematicRead =
  | { state: 'ready'; netlist: SchematicNetlist }
  /** Parts numbered `R?`: no netlist until they are annotated, as KiCad's refuses. */
  | { state: 'unannotated'; references: string[] }

export interface SchematicSource {
  /** The project's schematic; null when it has none. */
  read(): Promise<SchematicRead | null>
  /** Calls back on every change to a schematic; returns the unsubscribe. */
  onChange(listener: () => void): () => void
}

export const SCHEMATIC_SOURCE: InjectionKey<SchematicSource> = Symbol('schematic-source')

export type SyncDrift =
  /** The project has no schematic to update from. */
  | { state: 'none' }
  | { state: 'unannotated' }
  /** Footprints an update would add, that are not in the schematic, and that it would edit. */
  | { state: 'checked'; added: number; removed: number; edited: number }

/** Parity findings an update fixes on a footprint it keeps: its value, library footprint, attributes, fields or pad nets. */
const EDITED = new Set([
  'footprint-symbol-mismatch',
  'footprint-symbol-field-mismatch',
  'net-conflict'
])

/**
 * The drift in a board's findings, each footprint counted once per column:
 * a part with no footprint by reference, a footprint by its uuid (a pad's
 * finding names its footprint's). Excluded findings are the user's to ignore.
 */
export const driftOf = (results: readonly CheckResult[]): SyncDrift => {
  const added = new Set<string>()
  const removed = new Set<string>()
  const edited = new Set<string>()
  for (const result of results) {
    if (result.excluded) continue
    const footprint = result.targets?.[0] ?? result.items[0] ?? ''
    if (result.code === 'missing-footprint') added.add(result.subject ?? result.message)
    else if (result.code === 'extra-footprint') removed.add(footprint)
    else if (EDITED.has(result.code)) edited.add(footprint)
  }
  return { state: 'checked', added: added.size, removed: removed.size, edited: edited.size }
}
