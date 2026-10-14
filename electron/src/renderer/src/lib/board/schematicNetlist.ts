/**
 * The schematic as the board's parity checks read it: one entry per part the
 * board should carry — what KiCad's DRC reads from the netlist it fetches from
 * the schematic (`pcb drc --schematic-parity`). Built from the board sync's
 * parts (`syncParts`), so the checks, Update PCB from Schematic and the
 * netlist export read the schematic one way.
 */
import { syncParts, type SyncDesign } from './boardSync'

export interface NetlistPart {
  reference: string
  value: string
  /** The Footprint field, `lib:name`; '' when the symbol names none. */
  libId: string
  /** The symbol's footprint filters, each a wildcard. */
  filters: string[]
  /** Every field the board should carry but Reference, Value and Footprint: Datasheet, Description, the user's. */
  fields: ReadonlyArray<readonly [string, string]>
  dnp: boolean
  excludeFromBom: boolean
  /** Each pin by its number, with its net's name; every pin has a net, a lone one `unconnected-(…)`. */
  pins: ReadonlyMap<string, string>
}

export interface SchematicNetlist {
  parts: readonly NetlistPart[]
}

/** The netlist a design would export, as the parity checks read it. */
export function schematicNetlistOf(design: SyncDesign): SchematicNetlist {
  return {
    parts: syncParts(design).parts.map((part) => ({
      reference: part.reference,
      value: part.value,
      libId: part.libId,
      filters: (part.fpFilters ?? '').split(/\s+/).filter(Boolean),
      fields: part.fields,
      dnp: part.dnp,
      excludeFromBom: part.excludeFromBom,
      pins: new Map([...part.pads].map(([number, pad]) => [number, pad.net]))
    }))
  }
}
