/**
 * Which footprints a symbol can take, which symbols a footprint suits, and which
 * 3D models a footprint draws — one answer, read from the library index, for
 * every surface that shows a part with its associations: the Component view
 * (docs/libraries-workstream.md §2) and the library chooser's preview
 * (§3).
 */
import { basenameOf } from './kicad/paths'
import { readonlyLibTabPath } from './tabs'
import {
  findFootprint,
  footprintModels,
  footprintsMatchingFilters,
  symbolsMatchingFootprint,
  symbolsUsingFootprint,
  type FootprintRecord,
  type IndexRecord,
  type ModelRecord,
  type SymbolRecord
} from './libraryIndex'

/**
 * A symbol's footprints: the one its Footprint field assigns first (a concrete
 * choice), then every footprint its `ki_fp_filters` match — so a generic part
 * (Device:C) lists the packages it can take. Deduped.
 */
export function footprintsForSymbol(symbol: {
  footprint: string
  fpFilters: string[]
}): FootprintRecord[] {
  const out: FootprintRecord[] = []
  const seen = new Set<string>()
  const assigned = symbol.footprint ? findFootprint(symbol.footprint) : undefined
  if (assigned) {
    out.push(assigned)
    seen.add(assigned.id)
  }
  for (const footprint of footprintsMatchingFilters(symbol.fpFilters)) {
    if (seen.has(footprint.id)) continue
    seen.add(footprint.id)
    out.push(footprint)
  }
  return out
}

/**
 * A footprint's symbols: those that assign it first, then those merely
 * compatible with it — so a generic footprint (D_0402_1005Metric, assigned by no
 * symbol) still lists the parts that can take it. Deduped.
 */
export function symbolsForFootprint(footprint: FootprintRecord): SymbolRecord[] {
  const out: SymbolRecord[] = []
  const seen = new Set<string>()
  for (const symbol of [
    ...symbolsUsingFootprint(footprint.id),
    ...symbolsMatchingFootprint(footprint)
  ]) {
    if (seen.has(symbol.id)) continue
    seen.add(symbol.id)
    out.push(symbol)
  }
  return out
}

/**
 * The model records a footprint's `(model …)` refs resolve to. Several are one
 * assembly (a module and its shield), drawn together, not alternatives.
 */
export const modelsForFootprint = (footprintId: string): ModelRecord[] =>
  footprintModels(footprintId)

/** Where a part opens for a look: read-only, so nothing writes back to its library. */
export type OpenTarget =
  | { kind: 'library-symbol'; file: string; name: string }
  | { kind: 'file'; node: { name: string; path: string } }

/**
 * The tab a record opens in — the Component view's Open and the library
 * chooser's alike: a symbol in the symbol library viewer at its name, a
 * footprint in the footprint editor read-only, a model in the model viewer.
 */
export function openTargetFor(record: IndexRecord): OpenTarget {
  if (record.type === 'symbol')
    return { kind: 'library-symbol', file: record.file, name: record.name }
  if (record.type === 'footprint')
    return { kind: 'file', node: { name: record.name, path: readonlyLibTabPath(record.file) } }
  return { kind: 'file', node: { name: basenameOf(record.file), path: record.file } }
}
