/**
 * `parts.cache_datasheet` — the document, in the repository, from an official
 * source.
 *
 * There is no URL argument and
 * that is the whole design: the address is resolved from what a connected
 * distributor published for that exact MPN, because an aggregator's copy can be
 * a stale revision, the wrong variant, or an OCR of one, and nothing downstream
 * can tell it from the real thing.
 */
import { PROVIDER_INFO } from '../../partsProviders'
import { DATASHEET_DIR, provenanceFor } from '../../partsMcpDatasheets'
import type {
  DatasheetAttempt,
  DatasheetCandidate,
  DatasheetRecord
} from '../../partsMcpDatasheets'
import type { PartRecord } from '../../../preload/partsTypes'
import { callerOf, type OpContext } from '../context'
import { defineOp } from '../registry'
import { s } from '../schema'
import { fail, notFound, refused, succeed, type OpOutcome } from '../errors'
import { byManufacturer, listingsForMpn, manufacturersOf, quotaSummary } from './shared'

const NO_PROJECT_FIX =
  'No project is open to hold the datasheet. Ask the user to open their project.'

const NOT_CACHED_FIX =
  'Fetch the PDF yourself from the links in data.attempts and pass it as path with url set to the address it really came from, or put data.datasheetUrl in the Datasheet field.'

/** What was wrong with a file the caller handed over. */
const ADOPT_FIX: Record<string, string> = {
  'not-pdf': 'The file does not begin with %PDF-. Pass the PDF itself.',
  'too-large': 'The file is too large to be a datasheet and was not saved.',
  unreadable: 'The file could not be read. Check the path.'
}

/**
 * `path` is where the file is on this machine; `field` is the same file as the
 * Datasheet field should carry it — `${KIPRJMOD}`-relative, so it resolves on
 * any checkout. The caller writes `field`, never `path`.
 */
const datasheetSummary = (record: DatasheetRecord, path: string): Record<string, unknown> => ({
  mpn: record.mpn,
  path,
  field: `\${KIPRJMOD}/${DATASHEET_DIR}/${record.file}`,
  source: record.source,
  distributor: record.distributor ?? null,
  url: record.url ?? null,
  fetchedAt: record.fetchedAt,
  bytes: record.bytes,
  sha256: record.sha256
})

/**
 * No link gave a PDF. One answer for every way that happens — none published,
 * a page in place of the file, a refusal, a timeout — with what each link
 * answered, so the caller decides whether to fetch it some other way or to
 * leave the link in the BOM.
 */
const notCached = (
  mpn: string,
  candidates: readonly DatasheetCandidate[],
  attempts: readonly DatasheetAttempt[]
): OpOutcome =>
  fail({
    code: 'refused',
    kind: 'not-cached',
    message: attempts.length
      ? `No PDF from ${attempts.length} link${attempts.length === 1 ? '' : 's'} for ${mpn}: ${attempts
          .map((a) => `${a.distributor} → ${a.result}${a.status ? ` (HTTP ${a.status})` : ''}`)
          .join('; ')}.`
      : `No connected distributor published a datasheet link for ${mpn}.`,
    fix: NOT_CACHED_FIX,
    data: { datasheetUrl: candidates[0]?.url ?? null, attempts }
  })

/** Every matching row's datasheet link, named for its distributor, in the
 *  distributors' order; a link two rows share is tried once. */
const candidatesOf = (rows: readonly PartRecord[]): DatasheetCandidate[] => {
  const seen = new Set<string>()
  const out: DatasheetCandidate[] = []
  for (const record of rows) {
    if (!record.datasheetUrl) continue
    const distributor = PROVIDER_INFO[record.provider].name
    const key = `${distributor} ${record.datasheetUrl}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ distributor, url: record.datasheetUrl })
  }
  return out
}

/**
 * The catalogs' rows for an MPN. The addresses come from here and never from
 * the caller; a cached search costs no quota, which is why this is affordable
 * per part. More than one maker is real: a marketplace lists clones under the
 * original's part number, and the first row is not the original.
 */
const rowsFor = async (
  ctx: OpContext,
  mpn: string,
  manufacturer: string | undefined
): Promise<PartRecord[]> =>
  byManufacturer(
    (await listingsForMpn(ctx, mpn)).flatMap((listing) => listing.rows),
    manufacturer
  )

/** Several makers share the part number and the caller did not say which. */
const ambiguous = (mpn: string, makers: readonly string[]): OpOutcome =>
  fail({
    code: 'refused',
    kind: 'ambiguous-mpn',
    message: `${makers.length} manufacturers list ${mpn}: ${makers.join(', ')}.`,
    fix: 'Pass manufacturer as one of the candidates, as a distributor spells it.',
    candidates: [...makers]
  })

export const partsCacheDatasheet = defineOp({
  name: 'parts.cache_datasheet',
  scope: 'project',
  mutates: false,
  summary: "Save a part's datasheet PDF into the project's datasheets/ folder and return its path.",
  guidance:
    "The address comes from what a connected distributor published for that exact MPN; there is no url-only fetch. A file another part already saved is reused and named in sharedWith (a series datasheet: find your part inside it). When no link gives a PDF, the refusal lists each link's answer: fetch it yourself and pass path with url, or put data.datasheetUrl in the Datasheet field. Prefer the distributor links over an aggregator's copy. For the user's own PDF pass path alone. Writes the file and datasheets/index.json. Read it with parts_read_datasheet.",
  input: s.object({
    mpn: s
      .string()
      .trim()
      .describe('Manufacturer part number, exactly as parts_search returned it.'),
    manufacturer: s
      .string()
      .trim()
      .describe(
        'Manufacturer as a distributor reports it, ignoring case; required when several makers list the MPN.'
      )
      .optional(),
    path: s
      .string()
      .trim()
      .describe('Absolute path to a PDF on disk to adopt instead of fetching.')
      .optional(),
    url: s
      .string()
      .trim()
      .describe(
        "With path: the address it came from. A distributor's published link is recorded as that distributor's; any other as user-supplied."
      )
      .optional(),
    refresh: s.boolean().describe('Re-download even if cached. Default false.').optional()
  }),
  async run(args, ctx) {
    if (!args.mpn) {
      return refused(
        'mpn is required and must not be empty.',
        'Pass the manufacturer part number exactly as parts_search returned it.'
      )
    }
    if (!ctx.datasheets) {
      return fail({
        code: 'internal',
        kind: 'datasheets-unavailable',
        message: 'This build of the server has no datasheet store.'
      })
    }
    const projectPath = ctx.project?.(callerOf(ctx)) ?? null
    if (!projectPath) {
      return fail({
        code: 'no-document',
        kind: 'no-project',
        message: 'No project is open, so there is nowhere to put a datasheet.',
        fix: NO_PROJECT_FIX
      })
    }

    const filePath = args.path ?? ''
    if (filePath) {
      // Provenance by echo-back: a URL counts as a distributor's only when the
      // listing handed it out. A cached search costs no quota.
      const listed = args.url ? await rowsFor(ctx, args.mpn, args.manufacturer) : []
      const candidates = manufacturersOf(listed).length === 1 ? candidatesOf(listed) : []
      const adopted = ctx.datasheets.adopt(
        projectPath,
        args.mpn,
        filePath,
        provenanceFor(args.url, candidates)
      )
      return adopted.ok
        ? succeed({
            datasheet: datasheetSummary(adopted.record, adopted.path),
            ...(adopted.sharedWith ? { sharedWith: adopted.sharedWith } : {}),
            folder: DATASHEET_DIR
          })
        : fail({
            code: 'refused',
            kind: adopted.error,
            message: adopted.detail,
            fix: ADOPT_FIX[adopted.error]
          })
    }
    if (args.url) {
      return refused('url goes with path.', 'Pass path too, or omit url to fetch.')
    }

    if (args.refresh !== true) {
      const existing = ctx.datasheets.cached(projectPath, args.mpn)
      if (existing) {
        return succeed({
          datasheet: datasheetSummary(existing, ctx.datasheets.path(projectPath, existing)),
          alreadyCached: true,
          guidance:
            'Already in the project. Read it with parts_read_datasheet: the outline, then the pages you need.'
        })
      }
    }

    const rows = await rowsFor(ctx, args.mpn, args.manufacturer)
    if (!rows.length) {
      return notFound(
        `No connected distributor returned ${args.mpn}${args.manufacturer ? ` by ${args.manufacturer}` : ''}.`,
        'Check the MPN with parts_search, or pass the PDF as path.',
        { kind: 'not-found', data: { quota: quotaSummary(ctx.parts.usage()) } }
      )
    }
    const makers = manufacturersOf(rows)
    if (makers.length > 1) return ambiguous(args.mpn, makers)
    const candidates = candidatesOf(rows)
    const saved = candidates.length
      ? await ctx.datasheets.fetch(projectPath, args.mpn, candidates, args.refresh === true)
      : { ok: false as const, attempts: [] }
    if (!saved.ok) return notCached(args.mpn, candidates, saved.attempts)

    return succeed({
      datasheet: datasheetSummary(saved.record, saved.path),
      ...(saved.sharedWith ? { sharedWith: saved.sharedWith } : {}),
      folder: DATASHEET_DIR,
      attempts: saved.attempts,
      guidance:
        'Saved and recorded in datasheets/index.json. datasheet.field is the Datasheet field value. Read it with parts_read_datasheet: the outline, then the pages you need; a package drawing as an image.'
    })
  }
})
