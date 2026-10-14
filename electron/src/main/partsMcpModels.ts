/**
 * 3D models, cached into the project and provenance-recorded.
 *
 * The datasheet cache's
 * twin (`partsMcpDatasheets.ts`), with one deliberate difference: **the caller
 * supplies the address.** No distributor API publishes a model file — DigiKey
 * answers with a link to a web page and Mouser with nothing at all — so the
 * echo-back rule that keeps `parts_cache_datasheet` honest has nothing to echo. What
 * replaces it is a record rather than a gate: the agent states what kind of
 * source it used, that claim is written down as stated, and the host the bytes
 * actually came from is written down beside it, so the two can be read against
 * each other later.
 *
 * GoatCAD keeps no list of trusted or blocked hosts. There is no such list
 * worth maintaining, and a bad one is worse than none; judging a source is the
 * agent's job, and asking the user about an unreviewed one is in the project's
 * conventions, not in this code.
 *
 * The pure half — naming, the manifest, what counts as a STEP file — is here
 * and unit-tested; `fs` and the network are injected.
 */
import { createHash } from 'node:crypto'

/** The folder inside the project, named after the project the way KiCad names
 *  a `.3dshapes` folder. `<project>.3dshapes` is spelled by the store. */
export const MODEL_DIR_SUFFIX = '.3dshapes'

/** What the folder's own index is called. */
export const MODEL_MANIFEST = 'index.json'

/**
 * Past this a file is not a part's model. The installed KiCad set's largest is
 * 8.6 MB and its 99th percentile is 2.6 MB, so this is far past anything real
 * — it stops a whole assembly, or someone's mistake, being pulled into a
 * repository. A guess from one install; raise it when a real part needs it.
 */
export const MAX_MODEL_BYTES = 50 * 1024 * 1024

/** Where the agent says the file came from. Recorded as stated, never checked:
 *  GoatCAD cannot tell a manufacturer's own STEP file from a copy of it. */
export type ModelSource = 'manufacturer' | 'distributor' | 'third-party' | 'user'

export const MODEL_SOURCES: ModelSource[] = ['manufacturer', 'distributor', 'third-party', 'user']

export interface ModelRecord {
  /** File name within the models directory. */
  file: string
  source: ModelSource
  /** The host the bytes actually came from, as a fact beside the claim. */
  host?: string
  /** The address it came from, recorded verbatim. */
  url?: string
  /** The part it was fetched for, when the caller named one. */
  mpn?: string
  fetchedAt: number
  bytes: number
  sha256: string
}

export interface ModelManifest {
  version: 1
  models: ModelRecord[]
}

export const emptyModelManifest = (): ModelManifest => ({ version: 1, models: [] })

/**
 * A model file name from the name the caller asked for.
 *
 * A footprint's own naming rule (`bad-name`): what a file system refuses is
 * refused here rather than sanitized, because the name is quoted back in a
 * `(model …)` path the agent writes, and a name silently changed under it is a
 * path that does not resolve.
 */
export const isLegalModelName = (name: string): boolean =>
  /^[^\\/:*?"<>|]+$/.test(name.trim()) && !name.trim().startsWith('.')

export const modelFileName = (name: string): string => `${name.trim()}.step`

/** A STEP file begins with `ISO-10303-21;`, whitespace and a byte-order mark
 *  aside. Checked because a dead link commonly answers 200 with an HTML page,
 *  and a repository full of those is worse than one with a gap in it. */
export const looksLikeStep = (bytes: Uint8Array): boolean => {
  const head = new TextDecoder('utf-8', { fatal: false })
    .decode(bytes.subarray(0, 256))
    .replace(/^\uFEFF/, '')
    .trimStart()
  return head.startsWith('ISO-10303-21')
}

/** Only STEP is cached: it is what the app's own worker reads, and what a
 *  manufacturer publishes. A `.wrl` already installed still renders. */
export const isStepFileName = (name: string): boolean => /\.(step|stp)$/i.test(name.trim())

export const sha256 = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex')

export const findModel = (manifest: ModelManifest, file: string): ModelRecord | undefined =>
  manifest.models.find((entry) => entry.file.toLowerCase() === file.toLowerCase())

/** Replace an entry for the same file rather than appending a second one, and
 *  keep the list sorted so the committed file's diff is readable. */
export const upsertModel = (manifest: ModelManifest, record: ModelRecord): ModelManifest => ({
  version: 1,
  models: [
    ...manifest.models.filter((entry) => entry.file.toLowerCase() !== record.file.toLowerCase()),
    record
  ].sort((a, b) => a.file.localeCompare(b.file))
})

/** Tolerate anything on disk: a hand-edited or truncated manifest must not stop
 *  the tool, it must be replaced. The models are the real content. */
/**
 * Older manifests kept a copied file's `originalPath`: a local, often
 * temporary, path in a file the project commits. Read past it, so the next
 * write leaves it out.
 */
const withoutSourcePath = (entry: ModelRecord): ModelRecord => {
  const kept: ModelRecord & { originalPath?: unknown } = { ...entry }
  delete kept.originalPath
  return kept
}

export const parseModelManifest = (text: string | null): ModelManifest => {
  if (!text) return emptyModelManifest()
  try {
    const parsed = JSON.parse(text) as Partial<ModelManifest>
    if (!parsed || !Array.isArray(parsed.models)) return emptyModelManifest()
    return {
      version: 1,
      models: parsed.models
        .filter((entry): entry is ModelRecord => !!entry && typeof entry.file === 'string')
        .map(withoutSourcePath)
    }
  } catch {
    return emptyModelManifest()
  }
}

export const serializeModelManifest = (manifest: ModelManifest): string =>
  `${JSON.stringify(manifest, null, 2)}\n`

/** https only, and nothing else claimed about it. The caller supplies this
 *  address, so this is a floor under the transport, not a judgment of the
 *  source (see the module note). */
export const isFetchableModelUrl = (url: string): boolean => {
  try {
    return new URL(url).protocol === 'https:'
  } catch {
    return false
  }
}

/** The host bytes came from, for the record; null when the address is not one. */
export const hostOf = (url: string | undefined): string | undefined => {
  if (!url) return undefined
  try {
    return new URL(url).host
  } catch {
    return undefined
  }
}
