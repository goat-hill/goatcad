/**
 * Remembered per-board view state: which layers are drawn, which one is being
 * edited, and how the rest of them render; and the router's *Use starting
 * track width*, which KiCad keeps beside them in the `.kicad_prl` (R1).
 *
 * This is the third home for view state, beside the two that already exist.
 * App-wide display options are one set everybody shares and live in the config
 * store (`pcbView.ts`); zoom and pan are per subject and live in `cameraStore`.
 * Layer visibility is per BOARD — the layer table is the board's own — so an
 * app-wide copy is wrong the moment two boards are open, which is why it lands
 * here and, when the board has a project, in that project's `.kicad_prl`.
 *
 * Module scope for the same reason `cameraStore` is: `EditorArea` keys each
 * editor on the tab path, so switching tabs destroys the component and a `ref`
 * inside it can only ever describe the instance that filled it.
 *
 * A board with no `.kicad_pro` is remembered for the run and no further: a
 * loose file gets no new file written beside it, matching KiCad, which has no
 * `.kicad_prl` without a project either.
 */

import { effect, effectScope, reactive, ref, stop } from 'vue'
import type { KicadBoardLayer } from '../kicad/board'
import { findProjectFile } from '../kicad/project'
import { legacyLayerId } from '../kicad/migrate'
import { formatUpgrader } from '../formatUpgrade'
import {
  emptyProjectLocal,
  extractBoardLocalView,
  patchBoardLocalView,
  projectLocalPathFor,
  type BoardLocalView
} from '../kicad/projectLocal'
import type { NonActiveLayerDisplay } from './layerPresets'

export interface BoardViewState {
  /** Layer name → drawn. Seeded from the board's own layer table. */
  layerVisibility: Record<string, boolean>
  /** The layer new copper lands on. */
  activeLayer: string
  nonActiveDisplay: NonActiveLayerDisplay
  /** *Use starting track width* (R1): a route started on a track draws at its width. */
  autoTrackWidth: boolean
}

/**
 * Off by default: annotation and manufacturing layers that make a board
 * unreadable when everything is drawn at once. KiCad's board editor opens the
 * same way.
 */
const DEFAULT_HIDDEN_LAYERS = new Set([
  'F.Mask',
  'B.Mask',
  'F.Paste',
  'B.Paste',
  'F.Fab',
  'B.Fab',
  'F.CrtYd',
  'B.CrtYd',
  'F.Adhes',
  'B.Adhes'
])

const DEFAULT_ACTIVE_LAYER = 'F.Cu'

/** How long a run of changes may coalesce: a preset is one write, not one per layer. */
const WRITE_DELAY_MS = 400

/** As in `cameraStore`: bounded, because this outlives every component. */
const MAX_ENTRIES = 100

interface Entry {
  path: string
  state: BoardViewState
  layers: readonly KicadBoardLayer[]
  /** The layer table has been seen, so what is on screen is no longer defaults. */
  seeded: boolean
  /**
   * The `.kicad_prl` has been asked for, so this board's view is not settled
   * until it answers. False for a board nobody prefetched, which is what keeps
   * `viewReady` from gating an editor that never asked.
   */
  armed: boolean
  /** The `.kicad_prl`'s text, once read; `undefined` until the read lands. */
  rawRemembered: string | null | undefined
  /** The read in flight, so a second asker waits on it rather than re-reading. */
  pending: Promise<void> | null
  /** Nothing further will change this board's view for this load. */
  ready: boolean
  /** Set while the store writes to its own state, which is not a user change. */
  quiet: boolean
  /** Bumped by every user change; a hydrate landing after one has been overtaken. */
  revision: number
  writeTimer: ReturnType<typeof setTimeout> | null
  stopWatch: () => void
}

const entries = new Map<string, Entry>()

const defaultState = (): BoardViewState => ({
  layerVisibility: {},
  activeLayer: DEFAULT_ACTIVE_LAYER,
  nonActiveDisplay: 'show',
  autoTrackWidth: true
})

const dispose = (entry: Entry): void => {
  if (entry.writeTimer) clearTimeout(entry.writeTimer)
  entry.stopWatch()
}

const entryFor = (path: string): Entry => {
  const existing = entries.get(path)
  if (existing) {
    // Re-insert so recency tracks use, not first sight.
    entries.delete(path)
    entries.set(path, existing)
    return existing
  }

  const entry: Entry = {
    path,
    state: reactive(defaultState()),
    layers: [],
    seeded: false,
    armed: false,
    rawRemembered: undefined,
    pending: null,
    ready: false,
    quiet: false,
    revision: 0,
    writeTimer: null,
    stopWatch: () => {}
  }
  // Persistence is the store's business, not the editor's: every way a user
  // reaches this state — the layers panel, a preset, the dim cycle, the router
  // switching layers mid-track — is one mutation, and one watcher sees them all.
  // An entry outlives the editor that first asked for it, so the watcher is
  // neither in that editor's scope (which stops it on unmount) nor a `watch`
  // (which keeps the component current at its creation, and with it the editor
  // and its board). It is synchronous, so the store's own seed and hydrate are
  // still inside `quietly` when it sees them; a deferred one would see every
  // open as a change and write a file.
  const runner = effectScope(true).run(() =>
    effect(() => JSON.stringify(entry.state), {
      scheduler: () => {
        runner?.()
        if (entry.quiet) return
        entry.revision++
        schedule(path, entry)
      }
    })
  )
  entry.stopWatch = () => runner && stop(runner)

  entries.set(path, entry)
  if (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next()
    if (!oldest.done) {
      const evicted = entries.get(oldest.value)
      if (evicted) dispose(evicted)
      entries.delete(oldest.value)
    }
  }
  return entry
}

/** The live state for a board. Empty until its layer table has been adopted. */
export function boardViewFor(path: string): BoardViewState {
  return entryFor(path).state
}

/** Apply something that came out of a file, so it does not read as a user change. */
const quietly = (entry: Entry, change: () => void): void => {
  entry.quiet = true
  try {
    change()
  } finally {
    entry.quiet = false
  }
}

const seed = (entry: Entry): void => {
  const visibility: Record<string, boolean> = {}
  for (const layer of entry.layers) visibility[layer.name] = !DEFAULT_HIDDEN_LAYERS.has(layer.name)
  entry.state.layerVisibility = visibility
  if (visibility[entry.state.activeLayer] === undefined) {
    entry.state.activeLayer = DEFAULT_ACTIVE_LAYER
  }
}

const apply = (entry: Entry, view: BoardLocalView): void => {
  entry.state.layerVisibility = { ...entry.state.layerVisibility, ...view.layerVisibility }
  entry.state.nonActiveDisplay = view.nonActiveDisplay
  entry.state.autoTrackWidth = view.autoTrackWidth
  if (view.activeLayer && entry.state.layerVisibility[view.activeLayer] !== undefined) {
    entry.state.activeLayer = view.activeLayer
  }
}

/**
 * Bumped whenever a board's view settles, so `boardViewReady` is something a
 * template can watch. A counter rather than a per-board ref: the set of boards
 * is not known ahead of time and the editors asking are few.
 */
const readiness = ref(0)

const settle = (entry: Entry): void => {
  entry.ready = true
  readiness.value++
}

/** The raw remembered view for a board, or null when there is none to have. */
const readRemembered = async (path: string): Promise<string | null> => {
  const projectPath = await findProjectFile(path)
  if (!projectPath) return null
  const result = await window.api.readFile(projectLocalPathFor(projectPath))
  return result.success && result.content !== undefined ? result.content : null
}

/**
 * A board's *Use starting track width* (R1), for an agent's route: the open
 * editor's, else its project's `.kicad_prl`, else on, as KiCad's default.
 */
export async function autoTrackWidthFor(path: string): Promise<boolean> {
  const entry = entries.get(path)
  if (entry?.seeded) {
    await entry.pending
    return entry.state.autoTrackWidth
  }
  const raw = await readRemembered(path).catch(() => null)
  return (raw !== null ? extractBoardLocalView(raw, [])?.autoTrackWidth : undefined) ?? true
}

/**
 * Start reading a board's remembered view before its layer table exists.
 *
 * The point is what the editor does NOT do meanwhile: a scene built from the
 * defaults and then rebuilt from the file is two full rebuilds and a visible
 * flash through the wrong layers, because the viewport rebuilds on every
 * visibility change. A board's parse is chunked over many frames and this is
 * two IPC reads, so asking at mount means the answer is in hand by the time
 * there is a layer table to interpret it against — and `adoptBoardLayers` can
 * then seed and restore in one breath, before anything is drawn.
 *
 * The content is kept raw until the layers arrive, since ordinals mean nothing
 * without the board's own table.
 */
export function prefetchBoardView(path: string): void {
  void ensureRemembered(entryFor(path), path)
}

/** Read once per board; a second asker joins the read already in flight. */
const ensureRemembered = (entry: Entry, path: string): Promise<void> => {
  if (entry.pending) return entry.pending
  entry.armed = true
  entry.pending = readRemembered(path)
    .catch(() => null)
    .then((content) => {
      entry.rawRemembered = content
      // The layer table beat the file here, so nothing else will apply it.
      if (entry.seeded && !entry.ready) finish(entry)
    })
  return entry.pending
}

/** Apply what was read and declare the view settled, whatever came of it. */
const finish = (entry: Entry): void => {
  try {
    applyRemembered(entry)
  } finally {
    // Unconditional: an editor holds its viewport back on this, and a board
    // that never appears is far worse than one that opens on its defaults.
    settle(entry)
  }
}

/** The layer ids KiCad 9 renumbered in (lib/kicad/migrate.ts). */
const RENUMBERED_LAYERS_VERSION = 20241229

/**
 * The layer table as the `.kicad_prl` numbers it. A board read at an older
 * version is renumbered in memory, but until its upgrade is saved the file
 * beside it still speaks the old ids.
 */
const prlLayers = (entry: Entry): readonly KicadBoardLayer[] => {
  const state = formatUpgrader.stateOf(entry.path)
  if (state?.status !== 'older' || state.version >= RENUMBERED_LAYERS_VERSION) return entry.layers
  return entry.layers.map((layer) => ({
    ...layer,
    ordinal: legacyLayerId(layer.ordinal) ?? layer.ordinal
  }))
}

/**
 * The upgrade of a pre-KiCad 9 board is being saved: rewrite its `.kicad_prl`
 * in the new ids, so KiCad and we read the same layers visible. Call before
 * the save is noted, while the old ids still apply.
 */
export async function migrateBoardViewIds(path: string): Promise<void> {
  const entry = entries.get(path)
  if (!entry?.seeded) return
  const legacy = prlLayers(entry)
  if (legacy === entry.layers) return
  const projectPath = await findProjectFile(path)
  if (!projectPath) return
  const localPath = projectLocalPathFor(projectPath)
  const current = await window.api.readFile(localPath)
  if (!current.success || current.content === undefined) return
  const view = extractBoardLocalView(current.content, legacy)
  if (!view) return
  const patched = patchBoardLocalView(current.content, view, entry.layers)
  if (patched !== null) await window.api.createFile(localPath, patched)
}

/** Interpret whatever was read against the layer table, once both are in hand. */
const applyRemembered = (entry: Entry): void => {
  const raw = entry.rawRemembered
  if (!raw) return
  const view = extractBoardLocalView(raw, prlLayers(entry))
  // `revision` counts the user's own changes (the seed is quiet), so a non-zero
  // one means they got there first and their board is not to be repainted.
  if (!view || entry.revision !== 0) return
  quietly(entry, () => apply(entry, view))
}

/**
 * A string of its own: a parsed name is a slice of the board's text, and this
 * store outlives the board.
 */
const own = (value: string): string => (' ' + value).slice(1)

/**
 * Take the board's layer table, seeding the view the first time it is seen and
 * then applying whatever its project remembered. Idempotent — every mount of the
 * editor calls it, and only the first one for a board does any work.
 */
export async function adoptBoardLayers(
  path: string,
  layers: readonly KicadBoardLayer[]
): Promise<void> {
  const entry = entryFor(path)
  entry.layers = layers.map((layer) => ({
    ...layer,
    name: own(layer.name),
    type: own(layer.type),
    ...(layer.userName === undefined ? {} : { userName: own(layer.userName) })
  }))
  if (entry.seeded) return
  entry.seeded = true
  quietly(entry, () => seed(entry))

  await ensureRemembered(entry, path)
  if (!entry.ready) finish(entry)
}

/**
 * Whether a board's view has settled — false only between a `prefetchBoardView`
 * and the answer it is waiting for. An editor holds its viewport back on this,
 * so the first scene it builds is the one the user left.
 */
export function boardViewReady(path: string): boolean {
  void readiness.value
  const entry = entries.get(path)
  return !entry || !entry.armed || entry.ready
}

const write = async (path: string, entry: Entry): Promise<void> => {
  const projectPath = await findProjectFile(path)
  if (!projectPath) return
  const localPath = projectLocalPathFor(projectPath)
  const current = await window.api.readFile(localPath)
  // Created on the first change, never on open: a file appears beside the
  // project only once there is something of the user's in it to keep.
  const source =
    current.success && current.content !== undefined
      ? current.content
      : emptyProjectLocal(localPath.split(/[/\\]/).pop() ?? '')
  const patched = patchBoardLocalView(source, entry.state, prlLayers(entry))
  if (patched === null) return
  await window.api.createFile(localPath, patched)
}

function schedule(path: string, entry: Entry): void {
  if (!entry.seeded) return
  if (entry.writeTimer) clearTimeout(entry.writeTimer)
  entry.writeTimer = setTimeout(() => {
    entry.writeTimer = null
    void write(path, entry).catch(() => {
      // Losing a view preference must never interrupt an edit.
    })
  }, WRITE_DELAY_MS)
}

/** Test seam — no production caller should need to forget a board. */
export function clearBoardViews(): void {
  for (const entry of entries.values()) dispose(entry)
  entries.clear()
}
