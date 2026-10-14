// Parts follow KiCad's source, named below: Copyright The KiCad Developers, GPL-3.0-or-later.
/**
 * KiCad project-local settings (`.kicad_prl`) — the per-user sibling of the
 * `.kicad_pro`, holding view state that follows the board rather than the app.
 *
 * KiCad splits persisted view state three ways and we follow it: app-wide
 * display options live in our config store (`pcbView.ts`), per-board layer
 * visibility and the active layer live here, and zoom/pan is remembered by the
 * window session rather than written to any KiCad file. `.kicad_prl` is
 * per-user by design — KiCad's own project template gitignores it — so it is
 * the right home for state one screen owns and a repo should not carry. KiCad
 * keeps the router's *Use starting track width* here too (`board.auto_track_width`).
 *
 * Every key other than the four patched here round-trips untouched, and the
 * visible-layer bitmask is merged bit by bit rather than rewritten, so layers a
 * future KiCad knows about and we do not stay as the user left them.
 */

import type { NonActiveLayerDisplay } from '../board/layerPresets'
import type { KicadBoardLayer } from './board'

/** The per-board half of `.kicad_prl`, in our own terms (layer names, not ordinals). */
export interface BoardLocalView {
  /** Layer name → visible. Covers only layers the board itself declares. */
  layerVisibility: Record<string, boolean>
  /** The layer being edited, by name; null when the file names one the board has not got. */
  activeLayer: string | null
  nonActiveDisplay: NonActiveLayerDisplay
  /** *Use starting track width* (R1); on where the file says nothing, as KiCad's default. */
  autoTrackWidth: boolean
}

/**
 * `board.high_contrast_mode` (KiCad's `HIGH_CONTRAST_MODE`), which is the same
 * three states as our inactive-layer cycle.
 */
const CONTRAST_MODES: readonly NonActiveLayerDisplay[] = ['show', 'dim', 'hide']

/**
 * Written only into a file we create. The lowest version carrying the keys
 * we own, deliberately: every migration above it is guarded on
 * `board.visible_items`, which we never write, so KiCad migrates our file
 * forward as a no-op — whereas declaring a version newer than the reader's
 * marks the file as a future format.
 */
const PRL_SCHEMA_VERSION = 1

/**
 * How wide a mask we emit. KiCad's `PCB_LAYER_ID_COUNT` (128 as of KiCad 9);
 * its `ParseHex` reads right to left and stops at its own layer count, so an
 * older KiCad harmlessly drops the high bits it has no layers for.
 */
const LAYER_MASK_BITS = 128

/** A parsed `board.visible_layers`, and how much of it the file actually spelled. */
export interface LayerMask {
  /** Ordinals the mask marks visible. */
  visible: Set<number>
  /** Bits the string carried; anything at or above this was never written. */
  bitCount: number
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * KiCad's `LSET::ParseHex` (`include/base_set.h`): nibble *n* holds bits
 * 4n…4n+3 least-significant-first, nibbles run most-significant first, and `_`
 * separates groups of eight counted from the right.
 */
export function parseLayerMask(hex: string): LayerMask {
  const visible = new Set<number>()
  let nibbleIndex = 0
  for (let i = hex.length - 1; i >= 0; i--) {
    const char = hex[i]
    if (char === '_') continue
    const nibble = parseInt(char, 16)
    if (Number.isNaN(nibble)) break
    for (let bit = 0; bit < 4; bit++) {
      if (nibble & (1 << bit)) visible.add(nibbleIndex * 4 + bit)
    }
    nibbleIndex++
  }
  return { visible, bitCount: nibbleIndex * 4 }
}

/** The inverse — KiCad's `LSET::FmtHex`. */
export function formatLayerMask(visible: ReadonlySet<number>, bitCount: number): string {
  const nibbleCount = Math.ceil(bitCount / 4)
  const nibbles: string[] = []
  for (let nibbleIndex = 0; nibbleIndex < nibbleCount; nibbleIndex++) {
    let value = 0
    for (let bit = 0; bit < 4; bit++) {
      if (visible.has(nibbleIndex * 4 + bit)) value |= 1 << bit
    }
    if (nibbleIndex && nibbleIndex % 8 === 0) nibbles.push('_')
    nibbles.push(value.toString(16))
  }
  return nibbles.reverse().join('')
}

const readBoard = (prlJsonText: string): Record<string, unknown> | null => {
  let root: unknown
  try {
    root = JSON.parse(prlJsonText)
  } catch {
    return null
  }
  if (!isRecord(root) || !isRecord(root.board)) return null
  return root.board
}

/**
 * Read the per-board view state, resolving ordinals against the board's own
 * layer table — which is what keeps this right across KiCad's renumbering of
 * the copper layers, since the `.kicad_pcb` declares the ordinals it uses.
 * Null when the file names nothing we understand.
 */
export function extractBoardLocalView(
  prlJsonText: string,
  layers: readonly KicadBoardLayer[]
): BoardLocalView | null {
  const board = readBoard(prlJsonText)
  if (!board) return null

  const view: BoardLocalView = {
    layerVisibility: {},
    activeLayer: null,
    nonActiveDisplay: 'show',
    autoTrackWidth: true
  }
  let found = false

  if (typeof board.visible_layers === 'string') {
    const mask = parseLayerMask(board.visible_layers)
    for (const layer of layers) {
      // A layer the mask never reached is one the writer had no bit for, and
      // KiCad's own default is visible.
      view.layerVisibility[layer.name] =
        layer.ordinal >= mask.bitCount || mask.visible.has(layer.ordinal)
    }
    found = true
  }

  if (typeof board.active_layer === 'number') {
    const active = layers.find((layer) => layer.ordinal === board.active_layer)
    if (active) {
      view.activeLayer = active.name
      found = true
    }
  }

  if (typeof board.high_contrast_mode === 'number') {
    const mode = CONTRAST_MODES[board.high_contrast_mode]
    if (mode) {
      view.nonActiveDisplay = mode
      found = true
    }
  }

  if (typeof board.auto_track_width === 'boolean') {
    view.autoTrackWidth = board.auto_track_width
    found = true
  }

  return found ? view : null
}

/**
 * Write the per-board view state back, leaving every sibling key alone. Bits
 * for layers the board does not declare keep whatever the file gave them, so
 * a `.kicad_prl` written by a KiCad that knows more layers than we do survives
 * the round trip. Returns null for malformed input rather than clobbering it.
 */
export function patchBoardLocalView(
  prlJsonText: string,
  view: BoardLocalView,
  layers: readonly KicadBoardLayer[]
): string | null {
  let root: unknown
  try {
    root = JSON.parse(prlJsonText)
  } catch {
    return null
  }
  if (!isRecord(root)) return null
  const board = isRecord(root.board) ? root.board : {}

  const current =
    typeof board.visible_layers === 'string'
      ? parseLayerMask(board.visible_layers)
      : { visible: new Set<number>(), bitCount: 0 }
  const visible = current.visible
  for (let bit = current.bitCount; bit < LAYER_MASK_BITS; bit++) visible.add(bit)
  for (const layer of layers) {
    if (view.layerVisibility[layer.name] === false) visible.delete(layer.ordinal)
    else visible.add(layer.ordinal)
  }
  board.visible_layers = formatLayerMask(visible, Math.max(LAYER_MASK_BITS, current.bitCount))

  const active = layers.find((layer) => layer.name === view.activeLayer)
  if (active) board.active_layer = active.ordinal
  board.high_contrast_mode = CONTRAST_MODES.indexOf(view.nonActiveDisplay)
  board.auto_track_width = view.autoTrackWidth

  root.board = board
  return `${JSON.stringify(root, null, 2)}\n`
}

/**
 * The skeleton for a `.kicad_prl` we create ourselves: the keys we own and
 * nothing else, so KiCad fills in its own defaults the first time it saves.
 */
export function emptyProjectLocal(fileName: string): string {
  return `${JSON.stringify(
    {
      board: {},
      meta: { filename: fileName, version: PRL_SCHEMA_VERSION },
      project: { files: [] }
    },
    null,
    2
  )}\n`
}

/** The `.kicad_prl` belonging to a `.kicad_pro` — KiCad names them off one stem. */
export function projectLocalPathFor(projectPath: string): string {
  return projectPath.replace(/\.kicad_pro$/i, '.kicad_prl')
}
