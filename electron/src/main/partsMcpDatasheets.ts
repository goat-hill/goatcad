/**
 * Datasheets, cached into the project and provenance-recorded.
 *
 * Two decisions shape everything
 * here, and the second is the one with teeth.
 *
 * **They live in the repository.** `<project>/datasheets/`, committed rather
 * than ignored, because a datasheet is a design input and not a build artifact.
 * A manufacturer's link dies when the site is reorganised — routinely — and the
 * *revision* you designed against is the thing a reviewer needs a year later
 * (the SCD4x PDF that fixed this board's CO2 choice says "Version 1.7 – April
 * 2025" in its footer, and a later revision can move a spec underneath you).
 * The cost is repository size and it is worth paying.
 *
 * **There is no URL argument, deliberately.** An agent asked for a datasheet
 * will otherwise find *a* PDF — an aggregator's stale OCR, the wrong revision,
 * the wrong variant — and nothing downstream can tell that from the real one.
 * So the address is never something the caller supplies: it is resolved from
 * what a connected distributor returns for that exact MPN. This is the
 * `parts_list_filters` → `parts_search_category` handshake in another costume: the model
 * echoes back an identifier the tools gave it, and inventing one is not a thing
 * the interface permits. A local file the user hands over is the one other
 * route, and it is labelled as such.
 *
 * The pure half — naming, provenance shapes, manifest merge — is here and
 * unit-tested; `fs` and the network are injected.
 */
import { createHash } from 'node:crypto'

/** The folder, relative to the project root. Named in `board-intent.md` so an
 *  agent finds it without being told twice, and overridable there for a project
 *  that keeps them elsewhere. */
export const DATASHEET_DIR = 'datasheets'

/** What the folder's own index is called. */
export const DATASHEET_MANIFEST = 'index.json'

/** Past this a PDF is not a datasheet; it is someone's mistake, and pulling it
 *  into a repository is worse than refusing. */
export const MAX_DATASHEET_BYTES = 64 * 1024 * 1024

export type DatasheetSource = 'distributor' | 'user'

export interface DatasheetRecord {
  mpn: string
  /** File name within the datasheet directory. */
  file: string
  source: DatasheetSource
  /** Which distributor supplied the address; absent for a user's own file. */
  distributor?: string
  /** The address it came from, recorded verbatim so provenance is auditable. */
  url?: string
  fetchedAt: number
  bytes: number
  /** So a later reader can tell this copy from a different one. */
  sha256: string
}

/** One distributor's link for a part, as the listing reported it. */
export interface DatasheetCandidate {
  distributor: string
  url: string
}

/**
 * What one link came to. `saved` and `reused` end the list; the rest are facts
 * about the response, not guesses at why, so the caller decides what to do.
 */
export type DatasheetAttemptResult =
  'saved' | 'reused' | 'not-pdf' | 'http-error' | 'network-error' | 'too-large' | 'bad-url'

export interface DatasheetAttempt extends DatasheetCandidate {
  result: DatasheetAttemptResult
  /** The HTTP status, when a response came back. */
  status?: number
  contentType?: string
  /** The network error, or the address a redirect ended on when it was refused. */
  detail?: string
}

/**
 * Where a file the caller fetched came from, by echo-back: the URL is a
 * distributor's only when it is one the listing handed out, character for
 * character. Anything else is the caller's own, and is recorded as such — the
 * address is still kept, so a reviewer can judge it.
 */
export const provenanceFor = (
  url: string | undefined,
  candidates: readonly DatasheetCandidate[]
): Pick<DatasheetRecord, 'source' | 'distributor' | 'url'> => {
  const trimmed = url?.trim()
  if (!trimmed) return { source: 'user' }
  const match = candidates.find((candidate) => candidate.url === trimmed)
  return match
    ? { source: 'distributor', distributor: match.distributor, url: match.url }
    : { source: 'user', url: trimmed }
}

export interface DatasheetManifest {
  version: 1
  datasheets: DatasheetRecord[]
}

export const emptyManifest = (): DatasheetManifest => ({ version: 1, datasheets: [] })

/**
 * A file name for an MPN.
 *
 * MPNs carry slashes, spaces and plus signs (`AP2112K-3.3TRG1`, `LM317/NOPB`),
 * so the name is sanitised rather than trusted — a path separator in an MPN is
 * a write outside the folder. Case is preserved because MPNs are case-carrying,
 * but lookups are case-insensitive.
 */
export const datasheetFileName = (mpn: string): string => {
  const safe = mpn
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._]+/, '')
    .slice(0, 120)
  return `${safe || 'part'}.pdf`
}

export const sha256 = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex')

/** Case-insensitive lookup, since an agent rarely reproduces an MPN's case. */
export const findDatasheet = (
  manifest: DatasheetManifest,
  mpn: string
): DatasheetRecord | undefined =>
  manifest.datasheets.find((entry) => entry.mpn.toLowerCase() === mpn.trim().toLowerCase())

/** Replace an entry for the same MPN rather than appending a second one, and
 *  keep the list sorted so the file's diff is readable when it is committed. */
export const upsertDatasheet = (
  manifest: DatasheetManifest,
  record: DatasheetRecord
): DatasheetManifest => ({
  version: 1,
  datasheets: [
    ...manifest.datasheets.filter((entry) => entry.mpn.toLowerCase() !== record.mpn.toLowerCase()),
    record
  ].sort((a, b) => a.mpn.localeCompare(b.mpn))
})

/**
 * Older manifests kept an adopted file's `originalPath`: a local, often
 * temporary, path in a file the project commits. Read past it, so the next
 * write leaves it out.
 */
const withoutSourcePath = (entry: DatasheetRecord): DatasheetRecord => {
  const kept: DatasheetRecord & { originalPath?: unknown } = { ...entry }
  delete kept.originalPath
  return kept
}

/** Tolerate anything on disk: a hand-edited or truncated manifest must not stop
 *  the tool, it must be replaced. The PDFs are the real content. */
export const parseManifest = (text: string | null): DatasheetManifest => {
  if (!text) return emptyManifest()
  try {
    const parsed = JSON.parse(text) as Partial<DatasheetManifest>
    if (!parsed || !Array.isArray(parsed.datasheets)) return emptyManifest()
    return {
      version: 1,
      datasheets: parsed.datasheets
        .filter(
          (entry): entry is DatasheetRecord =>
            !!entry && typeof entry.mpn === 'string' && typeof entry.file === 'string'
        )
        .map(withoutSourcePath)
    }
  } catch {
    return emptyManifest()
  }
}

export const serializeManifest = (manifest: DatasheetManifest): string =>
  `${JSON.stringify(manifest, null, 2)}\n`

/**
 * Is this address one we are willing to fetch?
 *
 * Not an allowlist of manufacturers — there is no such list, and maintaining a
 * bad one is worse than none. The rule is narrower and checkable: **https, and
 * the address must be the one a distributor reported for this part.** The
 * caller never supplies it, so this guards against a provider returning
 * something odd rather than against the model.
 */
export const isFetchableDatasheetUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:'
  } catch {
    return false
  }
}

/** A PDF starts with `%PDF-`. Checked because a dead link commonly answers 200
 *  with an HTML "not found" page, and a repository full of those is worse than
 *  a repository with a gap in it. */
export const looksLikePdf = (bytes: Uint8Array): boolean =>
  bytes.length > 4 &&
  bytes[0] === 0x25 &&
  bytes[1] === 0x50 &&
  bytes[2] === 0x44 &&
  bytes[3] === 0x46

/**
 * What `board-intent.md` should say so an agent finds these without being told.
 *
 * Emitted by the `init` prompt into the frontmatter. A project that keeps some
 * datasheets elsewhere adds paths; one that keeps them all elsewhere replaces
 * the default.
 */
export const INTENT_DATASHEET_BLOCK = `datasheets:
  path: ${DATASHEET_DIR}/
  committed: true
  extra_paths: []`
