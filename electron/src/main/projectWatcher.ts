// Filesystem watching for the workspace a window has open
// (docs/projects.md §8.4). Feeds the *same* project change
// bus the renderer's own mutations feed, so nothing subscribes twice: a file
// KiCad wrote, a `git checkout` on the command line, and a New Schematic from
// our own menu all arrive as the same event.
//
// This is the reason §6.4 says build the bus first. Bolted on the other way
// round, the watcher would have had to be wired into every derived store by
// hand — which is precisely the fan-out the bus replaced.
//
// **Deliberately coarse.** We report *that* the workspace changed, not a precise
// per-file diff: `fs.watch` gives different event granularity on every platform
// (rename-vs-change, missing filenames on some, duplicate events on others), and
// the subscribers all re-read from disk anyway. A coarse, debounced, honest
// signal beats a detailed one that is wrong on macOS.
//
// Our own writes trigger it too, so a save is followed by one extra refresh a
// debounce later. That is left alone rather than suppressed: every subscriber is
// an idempotent re-read, and a suppression list keyed on paths we just wrote is
// a race waiting to drop a real external change that landed in the same window.

import * as fs from 'fs'
import { join } from 'path'
import type { ProjectChangeBatch } from '../preload/projectChangeTypes'

/** Directories whose churn is never a design change — `.git` above all: a single
 *  `git status` rewrites index files and would otherwise fire continuously. */
const IGNORED_SEGMENTS = new Set(['.git', 'node_modules', 'dist', 'out', '.goatherd'])

export const isIgnoredChange = (relativePath: string): boolean =>
  relativePath
    .split(/[/\\]/)
    .some((segment) => IGNORED_SEGMENTS.has(segment) || segment.endsWith('.tmp'))

/**
 * Coalescing window. Long enough that an editor writing a file as
 * truncate-then-write, or a `git checkout` touching two hundred files, lands as
 * one refresh; short enough to feel immediate.
 */
const DEBOUNCE_MS = 300

/**
 * How many directories a workspace may hold before we decline to watch it.
 *
 * `fs.watch` takes no filter, so `IGNORED_SEGMENTS` above filters *events* while
 * the watches themselves are still established on every directory under the
 * root. On macOS and Windows that costs nothing — recursive watching is one
 * native call — but **Linux has no recursive inotify**, so Node emulates it by
 * walking the tree and taking one inotify watch per directory, out of a limit
 * (`fs.inotify.max_user_watches`, commonly 65536) shared with every other
 * program the user is running.
 *
 * The bad trade is a folder that is mostly *not* a design: a repo with a
 * `node_modules` can be 50× more directories than meaningful ones, and spending
 * thousands of the machine's watches to notice edits in a handful of files is
 * not worth it. Above this bound we simply do not watch, and the window falls
 * back to what it did before the watcher existed — refresh on focus, and the
 * File Explorer's refresh button, which stays for exactly this reason (plus the
 * cases no watcher covers at all: network mounts, symlinked library folders,
 * and libraries referenced from outside the workspace).
 *
 * 2000 sits well above any real ECAD project (a KiCad project plus its `.git` is
 * a few hundred) and well below the pathological cases.
 */
export const MAX_WATCHED_DIRECTORIES = 2000

/**
 * Whether watching `root` would exceed the budget. Counts **every** directory,
 * ignored ones included, because that is what `fs.watch` will actually watch —
 * counting only the interesting ones would measure the wrong thing.
 *
 * Bounded by construction: it stops the moment the limit is passed, so the walk
 * it performs to avoid an expensive watch is never itself expensive. `readDir`
 * is injected, and returns subdirectory names only.
 */
export function exceedsWatchBudget(
  root: string,
  readDir: (dir: string) => string[],
  limit = MAX_WATCHED_DIRECTORIES
): boolean {
  const queue = [root]
  let seen = 0
  while (queue.length > 0) {
    const dir = queue.pop() as string
    for (const name of readDir(dir)) {
      if (++seen > limit) return true
      queue.push(join(dir, name))
    }
  }
  return false
}

/** Subdirectory names of `dir`; [] when unreadable. Symlinks are not followed —
 *  `Dirent.isDirectory` reflects an lstat, so a link reads as a link, which also
 *  makes the walk loop-proof. */
const subdirectories = (dir: string): string[] => {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

interface Watch {
  watcher: fs.FSWatcher
  timer: NodeJS.Timeout | null
  /** Windows sharing this root, by `webContents.id`. */
  subscribers: Set<number>
}

const watches = new Map<string, Watch>()

export interface WatcherDeps {
  /** Deliver a batch to every window; the renderer filters by root. */
  broadcast: (batch: ProjectChangeBatch) => void
}

let deps: WatcherDeps | null = null

export function configureProjectWatcher(next: WatcherDeps): void {
  deps = next
}

const stop = (root: string): void => {
  const watch = watches.get(root)
  if (!watch) return
  if (watch.timer) clearTimeout(watch.timer)
  watch.watcher.close()
  watches.delete(root)
}

/**
 * Watch `root` on behalf of one window. Several windows on one workspace share a
 * single watcher; the last one to leave closes it.
 *
 * Recursive watching is native on macOS and Windows and emulated by Node on
 * Linux. A root that cannot be watched at all (a network mount, a permissions
 * wall, a platform without support) degrades to no watcher rather than failing
 * the open — window focus still refreshes, which is what the app did before this
 * existed (RULES.md §8, "degrade gracefully").
 */
export function watchWorkspace(root: string, webContentsId: number): void {
  const existing = watches.get(root)
  if (existing) {
    existing.subscribers.add(webContentsId)
    return
  }

  // Linux only: it is the platform whose recursive watching costs one inotify
  // watch per directory. Applying the bound elsewhere would decline a watch that
  // is free (see MAX_WATCHED_DIRECTORIES).
  if (process.platform === 'linux' && exceedsWatchBudget(root, subdirectories)) {
    console.warn(
      `Not watching ${root}: over ${MAX_WATCHED_DIRECTORIES} directories. ` +
        'External changes will be picked up on window focus or manual refresh.'
    )
    return
  }

  let watcher: fs.FSWatcher
  try {
    watcher = fs.watch(root, { recursive: true, persistent: false })
  } catch (err) {
    console.error(`Not watching ${root}`, err)
    return
  }

  const watch: Watch = { watcher, timer: null, subscribers: new Set([webContentsId]) }
  watches.set(root, watch)

  watcher.on('error', (err) => {
    console.error(`Watch failed for ${root}`, err)
    stop(root)
  })

  watcher.on('change', (_event, filename) => {
    const relative = typeof filename === 'string' ? filename : filename?.toString()
    // Some platforms omit the filename. Without one we cannot tell whether the
    // change was in `.git`, and treating it as a real change is the safe
    // direction: a redundant refresh costs a readdir, a missed one shows the
    // user a stale tree.
    if (relative && isIgnoredChange(relative)) return
    if (watch.timer) clearTimeout(watch.timer)
    watch.timer = setTimeout(() => {
      watch.timer = null
      deps?.broadcast({
        root,
        changes: [
          {
            kind: 'file-changed',
            path: relative ? join(root, relative) : root,
            fileType: 'other'
          }
        ]
      })
    }, DEBOUNCE_MS)
  })
}

/** Drop one window's interest; closes the watcher when it was the last. */
export function unwatchWorkspace(root: string, webContentsId: number): void {
  const watch = watches.get(root)
  if (!watch) return
  watch.subscribers.delete(webContentsId)
  if (watch.subscribers.size === 0) stop(root)
}

/** Every root this window was watching — called when it closes. */
export function unwatchAllForWindow(webContentsId: number): void {
  for (const root of [...watches.keys()]) unwatchWorkspace(root, webContentsId)
}
