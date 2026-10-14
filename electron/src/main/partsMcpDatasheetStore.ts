/**
 * The `fs` + network half of the datasheet cache.
 *
 * `partsMcpDatasheets.ts` holds the decisions and the pure logic; this holds the
 * side effects, the same split every `partsMcp*` pair uses.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DatasheetAdoptOutcome, DatasheetFetchOutcome, DatasheetSaved } from './ops/context'
import {
  DATASHEET_DIR,
  DATASHEET_MANIFEST,
  datasheetFileName,
  findDatasheet,
  isFetchableDatasheetUrl,
  looksLikePdf,
  MAX_DATASHEET_BYTES,
  parseManifest,
  serializeManifest,
  sha256,
  upsertDatasheet,
  type DatasheetAttempt,
  type DatasheetCandidate,
  type DatasheetManifest,
  type DatasheetRecord
} from './partsMcpDatasheets'
import type { outboundFetch } from './outboundFetch'

export interface DatasheetStore {
  dir: string
  manifestPath: string
}

export const storeFor = (projectPath: string): DatasheetStore => ({
  dir: join(projectPath, DATASHEET_DIR),
  manifestPath: join(projectPath, DATASHEET_DIR, DATASHEET_MANIFEST)
})

const readManifest = (store: DatasheetStore): ReturnType<typeof parseManifest> => {
  try {
    return parseManifest(readFileSync(store.manifestPath, 'utf8'))
  } catch {
    return parseManifest(null)
  }
}

/** The record for an MPN, only when the file it names is still on disk — a
 *  manifest entry whose PDF was deleted is a lie, and re-fetching is cheap. */
export function cachedDatasheet(projectPath: string, mpn: string): DatasheetRecord | null {
  const store = storeFor(projectPath)
  const record = findDatasheet(readManifest(store), mpn)
  if (!record) return null
  return existsSync(join(store.dir, record.file)) ? record : null
}

export const datasheetPath = (projectPath: string, record: DatasheetRecord): string =>
  join(projectPath, DATASHEET_DIR, record.file)

const sameMpn = (record: DatasheetRecord, mpn: string): boolean =>
  record.mpn.toLowerCase() === mpn.trim().toLowerCase()

/** The records of other parts whose file is still on disk — the ones a new
 *  part may share. */
const sharable = (
  store: DatasheetStore,
  manifest: DatasheetManifest,
  mpn: string
): DatasheetRecord[] =>
  manifest.datasheets.filter(
    (record) => !sameMpn(record, mpn) && existsSync(join(store.dir, record.file))
  )

/**
 * Other parts sharing the file `mpn` is about to overwrite keep the bytes they
 * recorded: the file is copied to the first of them's own name and they all
 * point there. Only a refresh of the part that first saved a shared file with
 * different bytes gets here.
 */
const detach = (
  store: DatasheetStore,
  manifest: DatasheetManifest,
  mpn: string,
  file: string
): DatasheetManifest => {
  const sharing = manifest.datasheets.filter((r) => !sameMpn(r, mpn) && r.file === file)
  const target = sharing[0] ? datasheetFileName(sharing[0].mpn) : file
  if (target === file || !existsSync(join(store.dir, file))) return manifest
  copyFileSync(join(store.dir, file), join(store.dir, target))
  return {
    ...manifest,
    datasheets: manifest.datasheets.map((r) => (sharing.includes(r) ? { ...r, file: target } : r))
  }
}

/**
 * Record `mpn` against these bytes. A part whose file already holds the same
 * bytes is shared rather than written again; otherwise the file is the part's
 * own name.
 */
const save = (
  projectPath: string,
  mpn: string,
  bytes: Uint8Array,
  provenance: Omit<DatasheetRecord, 'mpn' | 'file' | 'bytes' | 'sha256'>,
  attempts: DatasheetAttempt[]
): DatasheetSaved => {
  const store = storeFor(projectPath)
  let manifest = readManifest(store)
  const hash = sha256(bytes)
  const twin = sharable(store, manifest, mpn).find((record) => record.sha256 === hash)
  let file = twin?.file
  if (!file) {
    file = datasheetFileName(mpn)
    mkdirSync(store.dir, { recursive: true })
    manifest = detach(store, manifest, mpn, file)
    writeFileSync(join(store.dir, file), bytes)
  }
  const record: DatasheetRecord = {
    mpn: mpn.trim(),
    file,
    ...provenance,
    bytes: bytes.byteLength,
    sha256: hash
  }
  return commit(projectPath, manifest, record, attempts, twin?.mpn)
}

const commit = (
  projectPath: string,
  manifest: DatasheetManifest,
  record: DatasheetRecord,
  attempts: DatasheetAttempt[],
  sharedWith: string | undefined
): DatasheetSaved => {
  const store = storeFor(projectPath)
  writeFileSync(store.manifestPath, serializeManifest(upsertDatasheet(manifest, record)))
  return {
    ok: true,
    record,
    path: datasheetPath(projectPath, record),
    attempts,
    ...(sharedWith ? { sharedWith } : {})
  }
}

type Fetched =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; attempt: Omit<DatasheetAttempt, keyof DatasheetCandidate> }

/** One plain request. Redirects are followed and nothing else: no script, no
 *  reading the page for a link. What came back is reported as it was. */
const download = async (url: string, fetchImpl: typeof outboundFetch): Promise<Fetched> => {
  if (!isFetchableDatasheetUrl(url)) return { ok: false, attempt: { result: 'bad-url' } }
  let response: Response
  let bytes: Uint8Array
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(30_000), redirect: 'follow' })
    bytes = new Uint8Array(await response.arrayBuffer())
  } catch (err) {
    return {
      ok: false,
      attempt: {
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
  // The https rule holds where the bytes came from, not only where the
  // listing pointed.
  if (response.url && !isFetchableDatasheetUrl(response.url)) {
    return { ok: false, attempt: { result: 'bad-url', ...facts, detail: response.url } }
  }
  if (!response.ok) return { ok: false, attempt: { result: 'http-error', ...facts } }
  if (bytes.byteLength > MAX_DATASHEET_BYTES) {
    return { ok: false, attempt: { result: 'too-large', ...facts } }
  }
  if (!looksLikePdf(bytes)) return { ok: false, attempt: { result: 'not-pdf', ...facts } }
  return { ok: true, bytes }
}

/**
 * Put a distributor-published datasheet into the project.
 *
 * The URLs are never a caller's: `cacheDatasheet.ts` resolves them from a live
 * search for that MPN. A link another part already saved is reused without a
 * request, unless this is a refresh — a series datasheet is one file for every part in it. Otherwise each
 * link is requested once, in order, and the first PDF is kept. Every link tried
 * is reported with what it answered; what to do when none gave a PDF is the
 * caller's decision.
 */
export async function fetchDatasheet(
  projectPath: string,
  mpn: string,
  candidates: readonly DatasheetCandidate[],
  fetchImpl: typeof outboundFetch,
  now: number,
  refresh = false
): Promise<DatasheetFetchOutcome> {
  const store = storeFor(projectPath)
  const manifest = readManifest(store)
  const others = refresh ? [] : sharable(store, manifest, mpn)
  for (const candidate of candidates) {
    const twin = others.find((record) => record.url === candidate.url)
    if (!twin) continue
    const record: DatasheetRecord = {
      mpn: mpn.trim(),
      file: twin.file,
      source: 'distributor',
      distributor: candidate.distributor,
      url: candidate.url,
      fetchedAt: now,
      bytes: twin.bytes,
      sha256: twin.sha256
    }
    return commit(projectPath, manifest, record, [{ ...candidate, result: 'reused' }], twin.mpn)
  }

  const attempts: DatasheetAttempt[] = []
  for (const candidate of candidates) {
    const fetched = await download(candidate.url, fetchImpl)
    if (!fetched.ok) {
      attempts.push({ ...candidate, ...fetched.attempt })
      continue
    }
    attempts.push({ ...candidate, result: 'saved' })
    return save(
      projectPath,
      mpn,
      fetched.bytes,
      {
        source: 'distributor',
        distributor: candidate.distributor,
        url: candidate.url,
        fetchedAt: now
      },
      attempts
    )
  }
  return { ok: false, attempts }
}

/** Adopt a file the caller has: one the user supplied, or one the agent got
 *  itself. The provenance says which, and the address it came from. */
export function adoptDatasheet(
  projectPath: string,
  mpn: string,
  sourcePath: string,
  now: number,
  provenance: Pick<DatasheetRecord, 'source' | 'distributor' | 'url'> = { source: 'user' }
): DatasheetAdoptOutcome {
  let bytes: Uint8Array
  try {
    if (statSync(sourcePath).size > MAX_DATASHEET_BYTES) {
      return { ok: false, error: 'too-large', detail: sourcePath }
    }
    bytes = readFileSync(sourcePath)
  } catch (err) {
    return {
      ok: false,
      error: 'unreadable',
      detail: err instanceof Error ? err.message : String(err)
    }
  }
  if (!looksLikePdf(bytes)) return { ok: false, error: 'not-pdf', detail: sourcePath }
  return save(projectPath, mpn, bytes, { ...provenance, fetchedAt: now }, [])
}
