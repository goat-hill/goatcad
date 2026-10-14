/**
 * The `fs` + network half of the 3D model cache.
 *
 * `partsMcpModels.ts` holds the decisions and the pure logic; this holds the
 * side effects, the split every `partsMcp*` pair uses.
 *
 * A fetched file is parsed before it is kept: the STEP worker is what the app
 * will have to read it with, so a file it cannot tessellate is refused here
 * rather than committed and discovered on the board. That parse also supplies
 * the size and triangle count the answer reports.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { measureMeshes, type MeshMeasurement } from './modelBounds'
import {
  findModel,
  hostOf,
  isFetchableModelUrl,
  looksLikeStep,
  MAX_MODEL_BYTES,
  MODEL_DIR_SUFFIX,
  MODEL_MANIFEST,
  modelFileName,
  parseModelManifest,
  serializeModelManifest,
  sha256,
  upsertModel,
  type ModelManifest,
  type ModelRecord,
  type ModelSource
} from './partsMcpModels'
import type { outboundFetch } from './outboundFetch'
import type { StepLoadResult } from '../preload/modelTypes'

export interface ModelStore {
  dir: string
  /** The folder as a `(model …)` path spells it, project-relative. */
  token: string
  manifestPath: string
}

/**
 * `<project>/<project>.3dshapes/`, named after the project file rather than the
 * folder: that is what KiCad's own libraries do, and what an agent writing the
 * path back would expect. A folder with no project file falls back to its own
 * name, which is what the rest of the server does with a nameless workspace.
 */
export const projectStem = (projectPath: string): string => {
  try {
    const project = readdirSync(projectPath).find((name) => name.endsWith('.kicad_pro'))
    if (project) return project.replace(/\.kicad_pro$/i, '')
  } catch {
    // An unreadable folder is the caller's problem to report, not ours to guess at.
  }
  return projectPath.split(/[/\\]/).filter(Boolean).pop() ?? 'project'
}

export const modelStoreFor = (projectPath: string): ModelStore => {
  const folder = `${projectStem(projectPath)}${MODEL_DIR_SUFFIX}`
  return {
    dir: join(projectPath, folder),
    token: folder,
    manifestPath: join(projectPath, folder, MODEL_MANIFEST)
  }
}

const readManifest = (store: ModelStore): ModelManifest => {
  try {
    return parseModelManifest(readFileSync(store.manifestPath, 'utf8'))
  } catch {
    return parseModelManifest(null)
  }
}

export type ModelCacheFailure =
  'not-step' | 'too-large' | 'unreadable' | 'model-exists' | 'not-cached'

export interface ModelCacheAttempt {
  url: string
  result: 'saved' | 'not-step' | 'http-error' | 'network-error' | 'too-large' | 'bad-url'
  status?: number
  contentType?: string
  detail?: string
}

export interface ModelSaved {
  ok: true
  record: ModelRecord
  path: string
  /** The `(model …)` path to write, project-relative so it resolves on any
   *  checkout — `parts_cache_datasheet`'s `field`, for models. */
  token: string
  measurement: MeshMeasurement
  attempt?: ModelCacheAttempt
}

export type ModelCacheOutcome =
  | ModelSaved
  | { ok: false; error: ModelCacheFailure; detail: string; attempts?: ModelCacheAttempt[] }

export interface ModelCacheInput {
  name: string
  source: ModelSource
  url?: string
  filePath?: string
  mpn?: string
  refresh?: boolean
}

/** One plain request. Redirects are followed and nothing else. */
const download = async (
  url: string,
  fetchImpl: typeof outboundFetch
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; attempt: ModelCacheAttempt }> => {
  if (!isFetchableModelUrl(url)) return { ok: false, attempt: { url, result: 'bad-url' } }
  let response: Response
  let bytes: Uint8Array
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(60_000), redirect: 'follow' })
    bytes = new Uint8Array(await response.arrayBuffer())
  } catch (err) {
    return {
      ok: false,
      attempt: {
        url,
        result: 'network-error',
        detail: err instanceof Error ? err.message : String(err)
      }
    }
  }
  const facts = {
    status: response.status,
    ...(response.headers.get('content-type')
      ? { contentType: response.headers.get('content-type') ?? '' }
      : {})
  }
  if (response.url && !isFetchableModelUrl(response.url)) {
    return { ok: false, attempt: { url, result: 'bad-url', ...facts, detail: response.url } }
  }
  if (!response.ok) return { ok: false, attempt: { url, result: 'http-error', ...facts } }
  if (bytes.byteLength > MAX_MODEL_BYTES) {
    return { ok: false, attempt: { url, result: 'too-large', ...facts } }
  }
  if (!looksLikeStep(bytes)) {
    return { ok: false, attempt: { url, result: 'not-step', ...facts } }
  }
  return { ok: true, bytes }
}

/**
 * Save bytes as `<name>.step`, once the STEP worker has proved they tessellate.
 *
 * The parse runs on a temporary file rather than on the destination, so a file
 * that turns out to be unreadable never lands in the project at all.
 */
const save = async (
  projectPath: string,
  input: ModelCacheInput,
  bytes: Uint8Array,
  provenance: Pick<ModelRecord, 'source' | 'host' | 'url'>,
  loadStep: (path: string) => Promise<StepLoadResult>,
  now: number,
  attempt?: ModelCacheAttempt
): Promise<ModelCacheOutcome> => {
  const store = modelStoreFor(projectPath)
  const file = modelFileName(input.name)
  const scratch = join(tmpdir(), `goatcad-model-${now}-${file}`)
  let measurement: MeshMeasurement
  try {
    writeFileSync(scratch, bytes)
    const parsed = await loadStep(scratch)
    if (!parsed.success || !parsed.meshes.length) {
      return {
        ok: false,
        error: 'not-step',
        detail: parsed.error ?? 'The file parsed to no geometry at all.'
      }
    }
    measurement = measureMeshes(parsed.meshes)
  } catch (err) {
    return {
      ok: false,
      error: 'unreadable',
      detail: err instanceof Error ? err.message : String(err)
    }
  } finally {
    rmSync(scratch, { force: true })
  }

  mkdirSync(store.dir, { recursive: true })
  writeFileSync(join(store.dir, file), bytes)
  const record: ModelRecord = {
    file,
    ...provenance,
    ...(input.mpn ? { mpn: input.mpn.trim() } : {}),
    fetchedAt: now,
    bytes: bytes.byteLength,
    sha256: sha256(bytes)
  }
  writeFileSync(
    store.manifestPath,
    serializeModelManifest(upsertModel(readManifest(store), record))
  )
  return {
    ok: true,
    record,
    path: join(store.dir, file),
    token: `\${KIPRJMOD}/${store.token}/${file}`,
    measurement,
    ...(attempt ? { attempt } : {})
  }
}

/**
 * Put a model in the project: fetched from the address the caller states, or
 * adopted from a file it already has.
 *
 * Unlike a datasheet there is no candidate list to walk — one address, one
 * attempt, reported as it went.
 */
export async function cacheModel(
  projectPath: string,
  input: ModelCacheInput,
  fetchImpl: typeof outboundFetch,
  loadStep: (path: string) => Promise<StepLoadResult>,
  now: number
): Promise<ModelCacheOutcome> {
  const store = modelStoreFor(projectPath)
  const file = modelFileName(input.name)
  if (input.refresh !== true) {
    const existing = findModel(readManifest(store), file)
    if (existing && existsSync(join(store.dir, file))) {
      return {
        ok: false,
        error: 'model-exists',
        detail: `${store.token}/${file} is already in the project (saved ${new Date(
          existing.fetchedAt
        ).toISOString()}, ${existing.bytes} bytes).`
      }
    }
    if (existsSync(join(store.dir, file))) {
      return { ok: false, error: 'model-exists', detail: `${store.token}/${file} already exists.` }
    }
  }

  if (input.filePath) {
    let bytes: Uint8Array
    try {
      if (statSync(input.filePath).size > MAX_MODEL_BYTES) {
        return { ok: false, error: 'too-large', detail: input.filePath }
      }
      bytes = readFileSync(input.filePath)
    } catch (err) {
      return {
        ok: false,
        error: 'unreadable',
        detail: err instanceof Error ? err.message : String(err)
      }
    }
    if (!looksLikeStep(bytes)) {
      return { ok: false, error: 'not-step', detail: input.filePath }
    }
    return save(
      projectPath,
      input,
      bytes,
      {
        source: input.source,
        ...(input.url
          ? { url: input.url, ...(hostOf(input.url) ? { host: hostOf(input.url) } : {}) }
          : {})
      },
      loadStep,
      now
    )
  }

  const url = input.url ?? ''
  const fetched = await download(url, fetchImpl)
  if (!fetched.ok) {
    return {
      ok: false,
      error: 'not-cached',
      detail: `${fetched.attempt.result}${fetched.attempt.status ? ` (HTTP ${fetched.attempt.status})` : ''}`,
      attempts: [fetched.attempt]
    }
  }
  return save(
    projectPath,
    input,
    fetched.bytes,
    {
      source: input.source,
      url,
      ...(hostOf(url) ? { host: hostOf(url) } : {})
    },
    loadStep,
    now,
    { url, result: 'saved' }
  )
}
