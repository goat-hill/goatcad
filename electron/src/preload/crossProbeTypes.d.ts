/**
 * Cross-select between a schematic and its board (split-view-workstream.md §6):
 * what was just selected in one, said in the one vocabulary both sides share —
 * the symbol's uuid, which a board footprint carries as the last segment of its
 * `(path …)`.
 *
 * Shared by main and the renderer because the other editor may be in another
 * window, and main is the only point two windows have in common.
 */
export interface CrossProbe {
  /** Workspace root it happened under; a window on another root ignores it. */
  root: string | null
  /** `components` is the Components tab: both a schematic and a board answer it. */
  origin: 'schematic' | 'board' | 'components'
  /** One entry per selected part; none on a net probe. */
  targets: CrossProbeTarget[]
  /**
   * A net highlighted (KiCad's `$NET:`) by name, which a board's nets share
   * with its schematic; '' cleared it. Absent on a part probe.
   */
  net?: string
}

export interface CrossProbeTarget {
  symbolUuid: string
  /** The part's reference, for a board whose footprint links to another unit. */
  reference?: string
  /**
   * The schematic file holding the symbol, absolute. Always set from a
   * schematic; from a board it is the footprint's `(sheetfile …)` resolved
   * beside the board, and absent when the footprint names none.
   */
  sheetFile?: string
}
