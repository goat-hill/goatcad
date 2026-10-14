/**
 * The parts service — what the `parts:*` IPC channels are a thin skin over.
 *
 * Everything network- and secret-touching about distributor search lives in the
 * main process, for three independent reasons (parts-sourcing-workstream.md
 * §3.1): a secret must never enter a renderer (RULES.md §9), widening the
 * renderer's CSP to reach `api.digikey.com` would be a real regression, and the
 * quota, token and cache are process-global — two windows share one 1000-call
 * day, the same reasoning that put config and the library index in main.
 *
 * The order of operations in `search` is the whole design: **cache → quota →
 * network**. A cache hit costs nothing and is never charged; a refusal happens
 * locally rather than by spending a call to be told we are out of calls.
 */
import * as fs from 'fs'
import { join } from 'path'
import type {
  PartCadAvailability,
  PartCategory,
  PartRecord,
  PartSearchResult,
  PartsCredentialStatus,
  PartsError,
  PartsProviderId,
  PartsFilterState,
  PartsSort,
  PartsResult,
  PartsUsage,
  PartsUniversalResult
} from '../preload/partsTypes'
import { groupParts } from './partsGroup'
import { PartsCache, searchKey } from './partsCache'
import {
  PartsCredentialStore,
  redactSecrets,
  type ProviderCredentials,
  type SecretCipher
} from './partsCredentials'
import { clearDigikeyToken, digikeyProvider } from './partsDigikey'
import { mouserProvider } from './partsMouser'
import {
  PartsRequestError,
  emptyFacets,
  PROVIDER_IDS,
  PROVIDER_INFO,
  type PartsProvider,
  type ProviderContext
} from './partsProviders'
import {
  normalizeUsageFile,
  PartsQuotaTracker,
  type PartsUsageFile,
  type QuotaLimits
} from './partsRateLimit'

const USAGE_FILE = 'parts-usage.json'

/** A search asks for this many rows unless told otherwise. Well under DigiKey's
 *  50-row maximum: a first page the user actually reads beats a big one that
 *  costs the same call but takes longer to scan. */
export const DEFAULT_SEARCH_LIMIT = 20
const MAX_SEARCH_LIMIT = 50

/**
 * Deadline on every outbound request.
 *
 * `fetch` has no default timeout, so a distributor that accepts a connection and
 * then never answers hangs the promise for as long as the process lives. That is
 * not hypothetical — it stranded the Settings card's Save in a permanent
 * "Saving…" with nothing to cancel. Anything user-facing needs a *bounded* wait
 * far more than it needs a generous one, so this is short enough that the UI can
 * simply wait it out. A timed-out request reports `timeout`, not `network`
 * (nothing refused us), and is still charged to the quota: the request left.
 */
export const REQUEST_TIMEOUT_MS = 15_000

const PROVIDERS: Record<PartsProviderId, PartsProvider> = {
  digikey: digikeyProvider,
  mouser: mouserProvider
}

const QUOTA_LIMITS: Record<PartsProviderId, QuotaLimits> = {
  digikey: PROVIDER_INFO.digikey.quota,
  mouser: PROVIDER_INFO.mouser.quota
}

const readJsonFile = (path: string): unknown => {
  try {
    return JSON.parse(fs.readFileSync(path, 'utf8'))
  } catch {
    // A cache or a usage counter is reconstructible; never fail a launch on one.
    return null
  }
}

export class PartsService {
  private readonly cache: PartsCache
  private readonly quota: PartsQuotaTracker
  private readonly credentials: PartsCredentialStore
  /** One tree per provider per session — see `categories`. */
  private readonly categoryCache = new Map<PartsProviderId, PartCategory[]>()
  private writeTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly dir: string,
    cipher: SecretCipher,
    private readonly fetchImpl: typeof globalThis.fetch = globalThis.fetch,
    /** Development-only, and resolved by the caller — this module stays free of
     *  Electron, so it never asks whether the app is packaged. */
    devCredentials: Partial<Record<PartsProviderId, ProviderCredentials>> = {}
  ) {
    this.credentials = new PartsCredentialStore(dir, cipher, devCredentials)
    // Memory only, and never seeded from disk — see partsCache.ts.
    this.cache = new PartsCache()
    this.quota = new PartsQuotaTracker(
      QUOTA_LIMITS,
      Date.now,
      normalizeUsageFile(readJsonFile(join(dir, USAGE_FILE))) as PartsUsageFile
    )
  }

  // ------------------------------------------------------------ persistence

  /** Debounced. Only the quota counter is written — it is ours, and it exists to
   *  honor their rate limit. Their content never reaches disk. */
  private schedulePersist(): void {
    if (this.writeTimer) clearTimeout(this.writeTimer)
    this.writeTimer = setTimeout(() => this.flush(), 1000)
  }

  flush(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer)
      this.writeTimer = null
    }
    this.writeJson(USAGE_FILE, this.quota.snapshot())
  }

  private writeJson(name: string, value: unknown): void {
    const target = join(this.dir, name)
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      fs.writeFileSync(`${target}.tmp`, JSON.stringify(value), 'utf8')
      fs.renameSync(`${target}.tmp`, target)
    } catch (err) {
      console.error(`Failed to write ${name}:`, err instanceof Error ? err.message : err)
    }
  }

  // ------------------------------------------------------------ credentials

  providerInfo(): typeof PROVIDER_INFO {
    return PROVIDER_INFO
  }

  credentialStatus(): PartsCredentialStatus[] {
    return PROVIDER_IDS.map((id) => this.credentials.status(id))
  }

  /**
   * Returns a result rather than a status because encryption can genuinely fail
   * — a Linux box whose keyring backend is unavailable will throw here. The one
   * thing we must not do is catch that and write the key in the clear anyway, so
   * the failure travels to the card and the key is simply not stored.
   */
  setCredentials(
    provider: PartsProviderId,
    credentials: ProviderCredentials
  ): PartsResult<PartsCredentialStatus> {
    // A new DigiKey key invalidates any token minted from the old one; keeping
    // it would authenticate as the previous app and mask a bad paste.
    if (provider === 'digikey') clearDigikeyToken()
    try {
      this.credentials.set(provider, credentials, PROVIDERS[provider].hint(credentials))
    } catch (err) {
      return {
        ok: false,
        error: {
          kind: 'storage-unavailable',
          detail: redactSecrets(
            err instanceof Error ? err.message : String(err),
            Object.values(credentials)
          )
        }
      }
    }
    return { ok: true, value: this.credentials.status(provider) }
  }

  removeCredentials(provider: PartsProviderId): PartsCredentialStatus {
    if (provider === 'digikey') clearDigikeyToken()
    this.credentials.remove(provider)
    return this.credentials.status(provider)
  }

  usage(): PartsUsage[] {
    return PROVIDER_IDS.map((id) => this.quota.usage(id))
  }

  // ---------------------------------------------------------------- calling

  /**
   * The one path every network call takes: resolve credentials, check the quota
   * locally, run, and translate any failure into a typed kind with its detail
   * scrubbed of the user's key.
   */
  private async run<T>(
    provider: PartsProviderId,
    action: (ctx: ProviderContext) => Promise<T>
  ): Promise<PartsResult<T>> {
    const credentials = this.credentials.get(provider)
    if (!credentials) return { ok: false, error: { kind: 'no-credentials' } }

    const verdict = this.quota.check(provider)
    if (!verdict.allowed) {
      return {
        ok: false,
        error: {
          kind: verdict.reason,
          detail: String(Math.ceil(verdict.retryAfterMs / 1000))
        }
      }
    }

    const secrets = Object.values(credentials)
    // Tracked separately from the signal: an abort tells us the request stopped,
    // not why, and "the distributor never answered" is a different message from
    // "the connection failed".
    let timedOut = false
    const controller = new AbortController()
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, REQUEST_TIMEOUT_MS)

    const ctx: ProviderContext = {
      credentials,
      fetch: this.fetchImpl,
      onRequest: () => {
        this.quota.record(provider)
        this.schedulePersist()
      },
      currency: 'USD',
      signal: controller.signal
    }

    try {
      const value = await action(ctx)
      this.quota.markSuccess(provider)
      this.schedulePersist()
      return { ok: true, value }
    } catch (err) {
      if (timedOut) return { ok: false, error: { kind: 'timeout' } }
      return { ok: false, error: toPartsError(err, secrets) }
    } finally {
      clearTimeout(timer)
    }
  }

  async search(
    provider: PartsProviderId,
    keyword: string,
    limit = DEFAULT_SEARCH_LIMIT,
    offset = 0,
    categoryId?: number,
    filters?: PartsFilterState,
    sort?: PartsSort | null
  ): Promise<PartsResult<PartSearchResult>> {
    const query = keyword.trim()
    // A category browse is a search with no keyword, so an empty query is only
    // "nothing to do" when there is no scope either.
    if (!query && categoryId === undefined) {
      return { ok: true, value: { parts: [], total: 0, facets: emptyFacets() } }
    }

    const boundedLimit = Math.min(Math.max(1, Math.trunc(limit)), MAX_SEARCH_LIMIT)
    const boundedOffset = Math.max(0, Math.trunc(offset))
    // Filters are part of a query's identity, not a modifier on it: the same
    // keyword under different narrowing is a different result set. Leaving them
    // out makes a filtered search collide with the unfiltered one already
    // cached, which returns the old rows *and* the old facets with no request
    // sent and nothing to see — the filter simply appears not to work.
    //
    // Key order is stable because both `sanitizeFilters` and the renderer's
    // `toPlainFilters` build the object field by field in a fixed order. The
    // scope and filters are appended *after* `searchKey`, so its case- and
    // whitespace-folding applies to the keyword alone — facet ids are opaque
    // tokens and must compare byte-exact.
    // Sort joins the key for the same reason filters do: the same rows in a
    // different order is a different answer, and serving the cached one back
    // makes a header click do nothing.
    const key =
      `${searchKey(provider, query, boundedLimit, boundedOffset)}` +
      `#${categoryId ?? ''}#${JSON.stringify(filters ?? {})}` +
      `#${sort ? `${sort.field}:${sort.order}` : ''}`

    // Cache before quota: re-running the same search (a back-navigation, a
    // second window) must be free, and a charged cache hit is the fastest way
    // to spend a day's calls on nothing.
    const cached = this.cache.getSearch(key)
    if (cached) return { ok: true, value: cached }

    const result = await this.run(provider, (ctx) =>
      PROVIDERS[provider].search(
        { keyword: query, limit: boundedLimit, offset: boundedOffset, categoryId, filters, sort },
        ctx
      )
    )
    if (result.ok) {
      this.cache.putSearch(key, result.value)
      this.schedulePersist()
    }
    return result
  }

  /** A part already seen in a search, served from the in-memory result set. */
  detail(provider: PartsProviderId, partId: string): PartRecord | null {
    return this.cache.get(provider, partId)
  }

  /**
   * Universal search: ask every configured distributor, group by physical part.
   *
   * Providers are queried **concurrently and independently**, and one failing
   * does not fail the search — a dead Mouser key must not hide DigiKey's
   * results. Each provider's outcome is reported back so the UI can say which
   * distributor is missing and why, rather than presenting a short list as if
   * it were complete.
   */
  async searchAll(
    keyword: string,
    limit = DEFAULT_SEARCH_LIMIT,
    filters?: PartsFilterState
  ): Promise<PartsUniversalResult> {
    const configured = PROVIDER_IDS.filter((id) => this.credentials.status(id).configured)
    const settled = await Promise.all(
      configured.map(async (provider) => ({
        provider,
        result: await this.search(provider, keyword, limit, 0, undefined, filters)
      }))
    )

    const records: PartRecord[] = []
    const providers: PartsUniversalResult['providers'] = []
    for (const { provider, result } of settled) {
      if (result.ok) {
        records.push(...result.value.parts)
        providers.push({ provider, ok: true, total: result.value.total })
      } else {
        providers.push({ provider, ok: false, total: 0, error: result.error })
      }
    }
    // No facets in universal mode: two catalogs' facets cannot be merged without
    // inventing a shared taxonomy, and a mapped spec is a wrong spec.
    return { groups: groupParts(records), facets: emptyFacets(), providers }
  }

  async cad(provider: PartsProviderId, partId: string): Promise<PartsResult<PartCadAvailability>> {
    const lookup = PROVIDERS[provider].cad
    // Not every provider exposes CAD availability at all, and "none" is a real
    // answer rather than a failure — Mouser's API simply has no such field.
    if (!lookup) return { ok: true, value: { mode: 'none' } }
    return this.run(provider, (ctx) => lookup.call(PROVIDERS[provider], partId, ctx))
  }

  /**
   * A distributor's category tree, fetched **at most once per session**.
   *
   * The whole tree arrives in one call, so memoizing it turns an entire browse
   * surface into a single request against a 1000-a-day budget. Held in memory
   * like every other piece of their data — it is theirs, and the no-persistence rule
   * applies to a taxonomy exactly as it does to a price.
   */
  async categories(provider: PartsProviderId): Promise<PartsResult<PartCategory[]>> {
    const lookup = PROVIDERS[provider].categories
    // Not a failure: Mouser's API simply has no categories, and its mode offers
    // lookup rather than discovery.
    if (!lookup) return { ok: true, value: [] }

    const cached = this.categoryCache.get(provider)
    if (cached) return { ok: true, value: cached }

    const result = await this.run(provider, (ctx) => lookup.call(PROVIDERS[provider], ctx))
    if (result.ok) this.categoryCache.set(provider, result.value)
    return result
  }

  async verify(provider: PartsProviderId): Promise<PartsResult<PartsCredentialStatus>> {
    const result = await this.run(provider, (ctx) => PROVIDERS[provider].verify(ctx))
    if (!result.ok) return result
    this.credentials.markVerified(provider)
    return { ok: true, value: this.credentials.status(provider) }
  }
}

/**
 * Any thrown value → a typed, renderer-safe error.
 *
 * The redaction is not belt-and-braces: Mouser authenticates with a query
 * parameter, so a bare transport error can carry the user's key inside the URL
 * it quotes. This is the single place a failure becomes something the renderer
 * sees, which is why the scrub lives here rather than at each call site.
 */
export const toPartsError = (err: unknown, secrets: readonly string[]): PartsError => {
  if (err instanceof PartsRequestError) {
    return {
      kind: err.kind,
      ...(err.detail ? { detail: redactSecrets(err.detail, secrets) } : {})
    }
  }
  const message = err instanceof Error ? err.message : String(err)
  return { kind: 'network', detail: redactSecrets(message, secrets) }
}
