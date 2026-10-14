/**
 * Remembered 2D camera per subject, shared by every viewport.
 *
 * Zoom and pan must outlive the component. Every editor is rendered by
 * `EditorArea` with `:key="activeTabPath"`, so switching tabs — or switching
 * file type — destroys the viewport and builds a new one; a cache held in a
 * viewport's own `<script setup>` scope is rebuilt empty each time and can only
 * ever answer questions about the instance that filled it.
 *
 * That is why this module exists rather than a `const` in each component: a
 * `<script setup>` top-level binding compiles into `setup()`, so it is
 * per-instance no matter how much it reads like module state. Three viewports
 * had one each, and in two of them (footprint, PCB) the key was the file path
 * — the very thing that cannot change without a remount — so the cache could
 * never produce a hit at all.
 *
 * Keys are the caller's business: the footprint and PCB editors show one
 * document per file and key on the path, while the symbol editor keys on
 * `file::symbol::unit` because all three change under one mounted component.
 *
 * Persisted per tab in the window session (`TabState.cameras`), never in a
 * KiCad file: KiCad keeps no camera, and a file rewritten on every scroll is
 * one the user has to think about. Written as the view changes
 * (`ViewportEngine.onViewChanged`), not on unmount — a closing window unmounts
 * nothing, so a camera saved only then is lost at quit.
 */

import type { CameraState2D, TabCameras } from '../../../../preload/cameraTypes'

export type { CameraState2D }

/**
 * Enough to cover any plausible working set of open documents. Bounded because
 * this now outlives every component and would otherwise grow for the life of
 * the process.
 */
const MAX_ENTRIES = 100

/** Insertion-ordered, so the first key is the least recently written. */
const cameras = new Map<string, CameraState2D>()

/**
 * How long a run of camera changes may coalesce before listeners hear about
 * it. A pan reports on every mouse move; what is listening is the window
 * session, and it wants the frame the user settled on, not each one on the way.
 */
const NOTIFY_DELAY_MS = 300

const listeners = new Set<() => void>()
let notifyTimer: ReturnType<typeof setTimeout> | null = null

const notify = (): void => {
  if (notifyTimer) clearTimeout(notifyTimer)
  notifyTimer = setTimeout(() => {
    notifyTimer = null
    for (const listener of listeners) listener()
  }, NOTIFY_DELAY_MS)
}

export function saveCamera(key: string, state: CameraState2D): void {
  const previous = cameras.get(key)
  // Re-insert so recency tracks writes, not first sight.
  cameras.delete(key)
  cameras.set(key, state)
  if (cameras.size > MAX_ENTRIES) {
    const oldest = cameras.keys().next()
    if (!oldest.done) cameras.delete(oldest.value)
  }
  if (
    !previous ||
    previous.x !== state.x ||
    previous.y !== state.y ||
    previous.zoom !== state.zoom
  ) {
    notify()
  }
}

/**
 * Hear about camera changes, trailing-debounced. Returns its own unsubscribe.
 */
export function onCamerasChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Every camera filed under a subject's path, keyed by what follows it. */
export function camerasForPath(path: string): TabCameras | undefined {
  let found: TabCameras | undefined
  for (const [key, state] of cameras) {
    if (!key.startsWith(path)) continue
    found ??= {}
    found[key.slice(path.length)] = state
  }
  return found
}

/** Put a restored tab's cameras back, without displacing one already in hand. */
export function hydrateCameras(path: string, restored: TabCameras): void {
  for (const [suffix, state] of Object.entries(restored)) {
    const key = `${path}${suffix}`
    if (cameras.has(key)) continue
    if (
      !Number.isFinite(state.x) ||
      !Number.isFinite(state.y) ||
      !Number.isFinite(state.zoom) ||
      state.zoom <= 0
    ) {
      continue
    }
    cameras.set(key, { x: state.x, y: state.y, zoom: state.zoom })
  }
}

/** The remembered camera, or `undefined` if this subject has not been framed yet. */
export function loadCamera(key: string): CameraState2D | undefined {
  return cameras.get(key)
}

/** Re-file every camera under the `from` prefix at `to`, so a renamed subject
 *  keeps its framing. Prefix, not whole key: a subject may own a key per unit. */
export function retargetCameras(from: string, to: string): void {
  if (from === to) return
  for (const [key, state] of [...cameras]) {
    if (!key.startsWith(from)) continue
    cameras.delete(key)
    saveCamera(`${to}${key.slice(from.length)}`, state)
  }
}

/** Test seam — no production caller should need to forget a camera. */
export function clearCameras(): void {
  cameras.clear()
  listeners.clear()
  if (notifyTimer) clearTimeout(notifyTimer)
  notifyTimer = null
}
