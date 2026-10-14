// Library index record types + version stamps (see docs/libraries-workstream.md).
// Defined in main (the index is built there) and imported type-only by the
// renderer, like appConfig. Records are metadata only — no geometry.

/** Bump when the record/manifest SHAPE changes → full rebuild. */
export const INDEX_SCHEMA_VERSION = 5
/** Bump when extraction LOGIC changes (new field, bug fix) → full rebuild even
 *  though source files are unchanged. */
export const EXTRACTOR_VERSION = 5

export type IndexType = 'symbol' | 'footprint' | 'model'
/** `system` = standard/provisioned read-only rows; `global` = user-added
 *  machine-wide rows (`symbol-libraries.json` / `libraries.json`); `project` =
 *  the open design's own libraries + embedded symbols (see libraries-workstream.md §2). */
export type IndexScope = 'system' | 'global' | 'project'

export interface BaseRecord {
  type: IndexType
  /** lib_id (`Nickname:Name`) for symbol/footprint; the model path for a model. */
  id: string
  name: string
  /** Nickname (symbol/footprint) or `.3dshapes` package (model). */
  library: string
  scope: IndexScope
  /** Absolute path to open / reveal in an editor. */
  file: string
}

export interface SymbolRecord extends BaseRecord {
  type: 'symbol'
  /** KiCad `(power)` flag; inherited through the `extends` chain. */
  isPower: boolean
  value: string
  description: string
  keywords: string
  datasheet: string
  /** Assigned footprint lib_id; '' for generic parts. Forward association. */
  footprint: string
  /** ki_fp_filters candidate patterns. */
  fpFilters: string[]
  /** Pin count, inherited through `extends` when a derived symbol draws none of
   *  its own. The cheapest check that a symbol matches a chosen part's package
   *  — an LQFP64 part and a 48-pin symbol disagree, and nothing else in a
   *  record catches it. */
  pins: number
}

export interface FootprintRecord extends BaseRecord {
  type: 'footprint'
  description: string
  tags: string
  pads: number
  /** Distinct non-empty pad numbers — what a symbol's pins map onto, so a
   *  thermal pad's via array or a mechanical pad does not count. */
  padNumbers: number
  /** 3D model paths referenced by `(model …)`. Forward association. */
  models: string[]
}

export interface ModelRecord extends BaseRecord {
  type: 'model'
}

export type IndexRecord = SymbolRecord | FootprintRecord | ModelRecord

/**
 * A symbol or footprint library the index found, empty ones included. The
 * records say what a library holds; only this says it is there at all, since an
 * empty library has no records — so "is this library reachable?" is answered
 * here, never from the records or the raw tables.
 */
export interface IndexLibrary {
  type: 'symbol' | 'footprint'
  /** The nickname a lib_id names it by. */
  name: string
  /** The `.kicad_sym` file, or the `.pretty` directory. */
  file: string
  scope: IndexScope
  /** False when the table points at nothing there. */
  readable: boolean
}

/** Persisted per-scope cache; validated against the two version stamps + manifest. */
export interface IndexCache {
  schemaVersion: number
  extractorVersion: number
  /** Coarse change-detection: unit path → mtimeMs (see libraries-workstream.md §2). */
  manifest: Record<string, number>
  records: IndexRecord[]
  libraries: IndexLibrary[]
}
