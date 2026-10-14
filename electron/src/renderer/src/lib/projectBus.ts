/** Typed, per-tick-coalesced invalidation bus for project file changes. */
import type {
  ProjectChange,
  ProjectChangeBatch,
  ProjectFileType
} from '../../../preload/projectChangeTypes'

export type { ProjectChange, ProjectChangeBatch, ProjectFileType }

type Listener = (changes: ProjectChange[]) => void | Promise<void>

const listeners = new Set<Listener>()
let queue: ProjectChange[] = []
let pending: Promise<void> | null = null

/** Subscribe to committed-file changes; returns its own unsubscribe. */
export function onProjectChange(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const notify = async (changes: ProjectChange[]): Promise<void> => {
  // A failed subscriber must not prevent other invalidations.
  await Promise.allSettled([...listeners].map(async (listener) => listener(changes)))
}

/**
 * Announce one or more committed changes. Returns a promise that settles once
 * this window's subscribers have handled the coalesced batch.
 *
 * `root` tags the batch for main's rebroadcast; pass the workspace root so other
 * windows can tell whether the batch concerns them. Omit it to keep the batch
 * local (nothing outside this window could act on it anyway).
 */
export function emitProjectChange(root: string | null, ...changes: ProjectChange[]): Promise<void> {
  if (changes.length === 0) return pending ?? Promise.resolve()
  queue.push(...changes)
  if (pending) return pending

  pending = Promise.resolve().then(async () => {
    const batch = queue
    queue = []
    pending = null
    // Tell the other windows first: their refresh is IPC-bound and can overlap
    // with ours rather than queue behind it.
    if (root) window.api.notifyProjectChange({ root, changes: batch })
    await notify(batch)
  })
  return pending
}

/**
 * Wire main's rebroadcast into this window. `rootOf` is read at delivery time,
 * not at install time, so a window that changes workspace keeps filtering
 * correctly. Returns a cleanup.
 */
export function installProjectBus(rootOf: () => string | null): () => void {
  return window.api.onProjectChanged((batch) => {
    // A batch from a workspace this window is not looking at invalidates
    // nothing here. Compared case-insensitively, as paths are everywhere else.
    const root = rootOf()
    if (batch.root && root && batch.root.toLowerCase() !== root.toLowerCase()) return
    void notify(batch.changes)
  })
}

const EXTENSION_TYPES: Array<[string, ProjectFileType]> = [
  ['.kicad_sch', 'schematic'],
  ['.kicad_pcb', 'board'],
  ['.kicad_sym', 'symbol-library'],
  ['.kicad_mod', 'footprint'],
  ['.kicad_pro', 'project']
]

/** Classify a path for subscribers that only care about one file type. */
export function projectFileType(path: string): ProjectFileType {
  const lower = path.toLowerCase()
  for (const [extension, type] of EXTENSION_TYPES) {
    if (lower.endsWith(extension)) return type
  }
  return 'other'
}

/** `file-created` / `file-changed` / `file-deleted`, with the type filled in. */
export const fileChange = (
  kind: 'file-created' | 'file-changed' | 'file-deleted',
  path: string
): ProjectChange => ({ kind, path, fileType: projectFileType(path) })

export const fileRenamed = (from: string, to: string): ProjectChange => ({
  kind: 'file-renamed',
  from,
  to,
  fileType: projectFileType(to)
})
