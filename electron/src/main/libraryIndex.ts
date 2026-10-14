import { Worker } from 'worker_threads'
import workerPath from './libraryIndexWorker?modulePath'
import { app, ipcMain, BrowserWindow } from 'electron'
import { join, dirname } from 'path'
import * as fs from 'fs'
import { detectSystemLibraries } from './kicadLibraries'
import { scanRequest, type BuildRequest, type ScanDeps } from './libraryIndexScan'
import { computeManifestDiff, diffIsEmpty, mergeIndex, planPartialBuild } from './libraryIndexMerge'
import {
  buildProjectIndex,
  projectManifest,
  manifestEquals,
  type ProjectDeps,
  type ProjectIndex
} from './libraryIndexProject'
import {
  INDEX_SCHEMA_VERSION,
  EXTRACTOR_VERSION,
  type IndexRecord,
  type IndexCache,
  type IndexLibrary
} from './libraryIndexTypes'

/**
 * Library index orchestration (see docs/libraries-workstream.md). Builds the system
 * index in a worker thread, persists a versioned cache with a coarse mtime
 * manifest, and serves records + progress over IPC. The index covers the
 * standard read-only libraries (`system` scope) and the user-added machine-wide
 * libraries (`global` scope); the open design (`project` scope) is served
 * separately (see project-index IPC below).
 */

const readJson = <T>(path: string, fallback: T): T => {
  try {
    return JSON.parse(fs.readFileSync(path, 'utf8')) as T
  } catch {
    return fallback
  }
}

const cachePath = (): string => join(app.getPath('userData'), 'index', 'system.json')

/** Gather the build inputs from the library tables + detection. Standard rows are
 *  tagged `system` (read-only, coarse dir-mtime manifest); user-added rows are
 *  tagged `global` (writable, so footprints use a `fineGrained` per-file manifest).
 *  Both live in the same index; only 3D stays system-only (see libraries-workstream.md §2). */
function systemBuildRequest(): BuildRequest {
  const userData = app.getPath('userData')
  // `libraries` may be missing from a hand-edited table — normalize, don't throw.
  const symTable = readJson<{ libraries?: { nickname: string; path: string; source?: string }[] }>(
    join(userData, 'symbol-libraries.json'),
    { libraries: [] }
  )
  const fpTable = readJson<{
    libraries?: { nickname: string; path: string; readOnly?: boolean }[]
  }>(join(userData, 'libraries.json'), { libraries: [] })
  const detected = detectSystemLibraries({
    platform: process.platform,
    existsSync: fs.existsSync,
    home: app.getPath('home')
  })
  return {
    symbolFiles: (Array.isArray(symTable.libraries) ? symTable.libraries : []).map((l) => ({
      library: l.nickname,
      file: l.path,
      scope: l.source === 'standard' ? 'system' : 'global'
    })),
    footprintRoots: (Array.isArray(fpTable.libraries) ? fpTable.libraries : []).map((l) => ({
      nickname: l.nickname,
      dir: l.path,
      scope: l.readOnly ? 'system' : 'global',
      fineGrained: !l.readOnly
    })),
    modelRoot: detected?.models3d ?? null
  }
}

/** Load the persisted cache iff both version stamps match (a stamp mismatch always
 *  forces a full rebuild). The manifest is NOT validated here — a mismatch feeds
 *  the incremental diff rather than throwing the whole cache away. */
function loadRawCache(): IndexCache | null {
  const cache = readJson<IndexCache | null>(cachePath(), null)
  if (
    !cache ||
    cache.schemaVersion !== INDEX_SCHEMA_VERSION ||
    cache.extractorVersion !== EXTRACTOR_VERSION
  ) {
    return null
  }
  return cache
}

/** `fs` for the shared scan, used by main's own change-detection walk (the worker
 *  has its own copy). readdir + stat only — no file reads. */
const scanDeps: ScanDeps = {
  readDir: (dir) => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true }).map((e) => ({
        name: e.name,
        isDirectory: e.isDirectory()
      }))
    } catch {
      return []
    }
  },
  mtimeMs: (p) => {
    try {
      return fs.statSync(p).mtimeMs
    } catch {
      return 0
    }
  }
}

const broadcast = (channel: string, payload: unknown): void => {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, payload)
}

function runWorker(req: BuildRequest): Promise<{
  records: IndexRecord[]
  manifest: Record<string, number>
  libraries: IndexLibrary[]
}> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath)
    worker.on('message', (msg: { type: string; [k: string]: unknown }) => {
      if (msg.type === 'progress') {
        broadcast('index:progress', { scope: 'system', done: msg.done, total: msg.total })
      } else if (msg.type === 'done') {
        void worker.terminate()
        resolve({
          records: msg.records as IndexRecord[],
          manifest: msg.manifest as Record<string, number>,
          libraries: msg.libraries as IndexLibrary[]
        })
      } else if (msg.type === 'error') {
        void worker.terminate()
        reject(new Error(String(msg.message)))
      }
    })
    worker.on('error', reject)
    worker.postMessage(req)
  })
}

let cached: IndexCache | null = null
let building: Promise<IndexCache> | null = null

function persist(cache: IndexCache): void {
  try {
    fs.mkdirSync(join(app.getPath('userData'), 'index'), { recursive: true })
    fs.writeFileSync(cachePath(), JSON.stringify(cache), 'utf8')
  } catch (err) {
    console.error('Failed to persist library index', err)
  }
  cached = cache
  broadcast('index:progress', { scope: 'system', done: 1, total: 1, complete: true })
}

/** Full rebuild — reparse every library from scratch. */
async function buildSystem(): Promise<IndexCache> {
  const { records, manifest, libraries } = await runWorker(systemBuildRequest())
  const cache: IndexCache = {
    schemaVersion: INDEX_SCHEMA_VERSION,
    extractorVersion: EXTRACTOR_VERSION,
    manifest,
    records,
    libraries
  }
  persist(cache)
  return cache
}

/** A library the tables now call by another name, at the same place. The
 *  manifest is keyed by path, so it cannot see this, and every record kept
 *  would carry the old nickname. */
const renamed = (before: IndexLibrary[], after: IndexLibrary[]): boolean => {
  const names = new Map(before.map((library) => [`${library.type} ${library.file}`, library.name]))
  return after.some((library) => {
    const name = names.get(`${library.type} ${library.file}`)
    return name !== undefined && name !== library.name
  })
}

/**
 * Incremental update — diff the freshly-scanned manifest against `base`, reparse
 * only the changed/added units in the worker, and merge them over the kept
 * records. Returns `base` untouched when nothing changed (the common launch
 * fast path). The caller decides when there is no `base` to diff (→ full build).
 */
async function incrementalUpdate(base: IndexCache): Promise<IndexCache> {
  const scan = scanRequest(systemBuildRequest(), scanDeps)
  if (renamed(base.libraries, scan.libraries)) return buildSystem()
  const diff = computeManifestDiff(base.manifest, scan.manifest)
  if (diffIsEmpty(diff)) {
    cached = base
    return base
  }
  const { records: fresh } = await runWorker(planPartialBuild(diff, scan))
  const cache: IndexCache = {
    schemaVersion: INDEX_SCHEMA_VERSION,
    extractorVersion: EXTRACTOR_VERSION,
    manifest: scan.manifest,
    records: mergeIndex(base.records, fresh, diff),
    libraries: scan.libraries
  }
  persist(cache)
  return cache
}

type EnsureMode = 'cached' | 'refresh' | 'full'

/**
 * Return the system+global index. `cached` serves the in-memory copy when present;
 * `refresh` re-diffs against the current tables even when a copy is cached (used
 * after a library add/remove); `full` forces a from-scratch rebuild (manual ⟳,
 * provisioning). Builds are deduped through `building`; progress fires over
 * `index:progress`.
 */
async function ensureSystem(mode: EnsureMode = 'cached'): Promise<IndexCache> {
  if (mode === 'cached' && cached) return cached
  // Let any in-flight build settle first; 'cached' is satisfied by its result,
  // while 'refresh'/'full' then run their own pass over the now-current tables.
  if (building) {
    const current = await building.catch(() => null)
    if (mode === 'cached' && current) return current
  }
  const run = (async (): Promise<IndexCache> => {
    if (mode === 'full') return buildSystem()
    const base = cached ?? loadRawCache()
    return base ? incrementalUpdate(base) : buildSystem()
  })()
  building = run
  try {
    return await run
  } finally {
    if (building === run) building = null
  }
}

/**
 * Fire-and-forget rebuild of the system index — called after a provisioning
 * change (download / reset) mutates the standard-library tables so search and
 * associations reflect the new libraries without a restart. Progress broadcasts
 * over `index:progress`; renderers reload when it completes.
 */
export function rebuildSystemIndex(): void {
  void ensureSystem('full').catch((err) => console.error('Library index rebuild failed', err))
}

/**
 * Fire-and-forget refresh after the user adds/removes a library in the navigator
 * (the `libraries:save-table` / `symbol-libraries:save-table` handlers call this
 * when the saved rows changed). A refresh re-diffs the tables and reparses only
 * the affected units (the incremental path), falling back to a full build when
 * there is no cache to diff against.
 */
export function refreshSystemIndex(): void {
  void ensureSystem('refresh').catch((err) => console.error('Library index refresh failed', err))
}

// --- project scope (in-memory, rebuilt on demand; see libraries-workstream.md §2) ---

const projectDeps: ProjectDeps = {
  readFile: (p) => {
    try {
      return fs.readFileSync(p, 'utf8')
    } catch {
      return null
    }
  },
  listDir: (dir) => {
    try {
      return fs.readdirSync(dir)
    } catch {
      return []
    }
  },
  mtimeMs: (p) => {
    try {
      return fs.statSync(p).mtimeMs
    } catch {
      return 0
    }
  }
}

const projectMemo = new Map<string, ProjectIndex>()

/** Resolve to the project directory, then serve the memo when the inputs are
 *  unchanged, else rebuild. `projectPath` may be a `.kicad_pro`/file or the dir. */
function getProjectIndex(projectPath: string): ProjectIndex {
  let dir = projectPath
  try {
    if (!(fs.existsSync(projectPath) && fs.statSync(projectPath).isDirectory())) {
      dir = dirname(projectPath)
    }
  } catch {
    dir = dirname(projectPath)
  }
  const memo = projectMemo.get(dir)
  if (memo && manifestEquals(memo.manifest, projectManifest(dir, projectDeps))) return memo
  const built = buildProjectIndex(dir, projectDeps)
  projectMemo.set(dir, built)
  return built
}

/**
 * The system+global records, for callers in main that are not a window.
 *
 * The MCP library tools (`partsMcpLibrary.ts`) read through here rather than
 * re-scanning: the index is already built, already incrementally maintained, and
 * already the thing the Libraries panel and the symbol chooser agree on. A
 * second reader of the same array is free; a second scanner would be a second
 * answer.
 */
export async function systemIndexRecords(): Promise<IndexRecord[]> {
  return (await ensureSystem()).records
}

/** Project-scope records (design libraries + embedded symbols), memoized on the
 *  project's own manifest exactly as `index:get-project` serves them. */
export function projectIndexRecords(projectPath: string): IndexRecord[] {
  return getProjectIndex(projectPath).records
}

export function registerLibraryIndexIpc(): void {
  ipcMain.handle('index:get-system', async () => {
    const { records, libraries } = await ensureSystem()
    return { records, libraries }
  })
  ipcMain.handle('index:rebuild-system', async () => {
    const { records, libraries } = await ensureSystem('full')
    return { records, libraries }
  })
  ipcMain.handle('index:get-project', (_, projectPath: string) => {
    const { records, assignments, libraries } = getProjectIndex(projectPath)
    return { records, assignments, libraries }
  })

  // Warm the cache on launch (non-blocking) so search is ready when first opened.
  void ensureSystem().catch((err) => console.error('Initial library index build failed', err))
}
