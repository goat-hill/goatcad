/**
 * What a parts provider is, and the tools for writing one.
 *
 * A registry rather than three integrations, the same shape as
 * `lib/manufacturingProfiles.ts` and `lib/exportProfiles.ts`: adding a
 * distributor is a new object implementing `PartsProvider`, not a new code path
 * anywhere above it. Everything upstream
 * speaks one `PartRecord`.
 *
 * The JSON readers below exist because these are *foreign* payloads: a provider
 * can rename a field in a release we do not control, and the app's answer to that
 * must be a part with a missing description rather than a thrown exception in a
 * search. So every read is optional-chained through a coercion that returns null,
 * and the normalizers are total — see the note in each on which fields are
 * confirmed against the vendor's own published spec.
 */
import type {
  PartCadAvailability,
  PartCategory,
  PartRecord,
  PartSearchResult,
  PartsCredentialField,
  PartsErrorKind,
  PartsFacets,
  PartsFilterState,
  PartsSort,
  PartsProviderId,
  PartsProviderInfo
} from '../preload/partsTypes'
import type { ProviderCredentials } from './partsCredentials'

/** A failure with a kind the renderer can translate — see partsTypes.d.ts. */
export class PartsRequestError extends Error {
  constructor(
    readonly kind: PartsErrorKind,
    readonly detail?: string
  ) {
    super(`${kind}${detail ? `: ${detail}` : ''}`)
    this.name = 'PartsRequestError'
  }
}

export interface ProviderContext {
  credentials: ProviderCredentials
  /** Injected so tests drive providers with a stub instead of the network. */
  fetch: typeof globalThis.fetch
  /** Charge one request against the quota. Called per outbound catalog call. */
  onRequest: () => void
  /** ISO-4217 the caller wants prices in, where the provider honors a choice. */
  currency: string
  signal?: AbortSignal
}

/** What a provider is asked for. An object rather than positional arguments
 *  because scope (a category, later a parameter set) is optional and provider-
 *  specific — Mouser's API cannot honor any of it and simply ignores it. */
export interface ProviderSearchRequest {
  keyword: string
  limit: number
  offset: number
  /** Restrict to one of the provider's own categories. DigiKey only. */
  categoryId?: number
  /** Server-side narrowing. A provider applies what its API supports and
   *  ignores the rest — Mouser honors only `inStock` and `rohs`. */
  filters?: PartsFilterState
  /** Server-side ordering. DigiKey only; Mouser's Search API has no sort field,
   *  so its results stay in the relevance order it chose. */
  sort?: PartsSort | null
}

export const emptyFacets = (): PartsFacets => ({
  manufacturers: [],
  packaging: [],
  status: [],
  series: [],
  parametric: []
})

export const emptyFilterState = (): PartsFilterState => ({
  inStock: false,
  rohs: false,
  hasDatasheet: false,
  has3dModel: false,
  manufacturerIds: [],
  packagingIds: [],
  statusIds: [],
  seriesIds: [],
  parameters: {}
})

export interface PartsProvider {
  id: PartsProviderId
  search(request: ProviderSearchRequest, ctx: ProviderContext): Promise<PartSearchResult>
  /**
   * The provider's category tree, for a browse surface. Optional because only
   * DigiKey has one — Mouser's Search API exposes no categories at all, so its
   * mode offers lookup rather than discovery.
   */
  categories?(ctx: ProviderContext): Promise<PartCategory[]>
  /**
   * CAD availability for one part. Optional, and deliberately *not* folded into
   * `search`: on DigiKey it is a second HTTP call per part, so asking during a
   * search would multiply the quota cost of every result set by the number of
   * rows. The UI asks for one part, when the user asks for it.
   */
  cad?(partId: string, ctx: ProviderContext): Promise<PartCadAvailability>
  /** One cheap real call, for the Settings card's Test connection button. */
  verify(ctx: ProviderContext): Promise<void>
  /** A non-secret fragment identifying which key is installed, for the card. */
  hint(credentials: ProviderCredentials): string | null
}

// ------------------------------------------------------------------ registry

const DIGIKEY_FIELDS: PartsCredentialField[] = [
  { key: 'clientId', labelKey: 'clientId', secret: false, placeholder: 'xxxxxxxx-xxxx-…' },
  { key: 'clientSecret', labelKey: 'clientSecret', secret: true }
]

const MOUSER_FIELDS: PartsCredentialField[] = [
  { key: 'apiKey', labelKey: 'apiKey', secret: true, placeholder: 'xxxxxxxx-xxxx-xxxx-…' }
]

/**
 * Published quotas and the vendors' own key-registration pages.
 *
 * **The app never registers anything.** `registrationUrl` is opened in the
 * system browser and that is the whole interaction — the user creates their own
 * account and pastes their own key back. Verify the quotas against the live
 * services before trusting the meter; both vendors have changed them before.
 */
export const PROVIDER_INFO: Record<PartsProviderId, PartsProviderInfo> = {
  digikey: {
    id: 'digikey',
    name: 'DigiKey',
    registrationUrl: 'https://developer.digikey.com/',
    fields: DIGIKEY_FIELDS,
    quota: { perMinute: 120, perDay: 1000 }
  },
  mouser: {
    id: 'mouser',
    name: 'Mouser',
    registrationUrl: 'https://www.mouser.com/api-hub/',
    fields: MOUSER_FIELDS,
    quota: { perMinute: 30, perDay: 1000 }
  }
}

export const PROVIDER_IDS: PartsProviderId[] = ['digikey', 'mouser']

// -------------------------------------------------------------- JSON readers

export const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

export const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

export const asText = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : ''

/** A URL field only counts when it is actually a web URL — providers use `''`,
 *  `'N/A'` and relative placeholders interchangeably for "no datasheet". */
export const asUrl = (value: unknown): string | null => {
  const text = asText(value)
  return /^https?:\/\//i.test(text) ? text : null
}

/**
 * A count that may arrive as a number, a plain string, or a grouped string
 * (`"10,000"`, `"10 000"`). Returns null rather than 0 for absent — "unknown
 * stock" and "out of stock" are different answers and the UI shows them apart.
 */
export const asCount = (value: unknown): number | null => {
  if (typeof value === 'number')
    return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : null
  if (typeof value !== 'string') return null
  // U+00A0 spelled as an escape, not typed: providers group digits with a
  // non-breaking space, and a literal one here is invisible in review.
  const match = value.replace(/[\s,\u00a0]/g, '').match(/-?\d+/)
  if (!match) return null
  const parsed = Number.parseInt(match[0], 10)
  return Number.isFinite(parsed) ? Math.max(0, parsed) : null
}

/**
 * A price that may arrive as a number or a *localized currency string* — Mouser
 * returns display text like `"$0.34"`, `"1,50 €"` or `"£12.00"`. The ambiguity
 * that matters is `,` as a decimal separator versus a thousands separator, and
 * the only reliable discriminator in the string itself is which of `.` and `,`
 * appears last. Returns null on anything it cannot read, so an unparseable price
 * shows as "—" rather than as a confidently wrong 0.
 */
export const asPrice = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  const digits = value.replace(/[^\d.,-]/g, '')
  if (!digits) return null
  const lastDot = digits.lastIndexOf('.')
  const lastComma = digits.lastIndexOf(',')
  let normalized: string
  if (lastDot === -1 && lastComma === -1) {
    normalized = digits
  } else if (lastComma > lastDot) {
    // `1.234,56` — comma is the decimal mark.
    normalized = digits.replace(/\./g, '').replace(',', '.')
  } else {
    // `1,234.56` — dot is the decimal mark.
    normalized = digits.replace(/,/g, '')
  }
  const parsed = Number.parseFloat(normalized)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Map an HTTP status onto the kind whose fix the user can act on. The split that
 * earns its keep is 401 vs 403: a bad key is re-pasted, an unsubscribed API
 * product is fixed on the vendor's portal, and telling someone to re-check their
 * key when the key is fine is a dead end.
 */
export const errorKindForStatus = (status: number): PartsErrorKind => {
  if (status === 401) return 'invalid-credentials'
  if (status === 403) return 'forbidden'
  if (status === 429) return 'rate-limited'
  if (status >= 500) return 'provider-error'
  return 'provider-error'
}

/** One place where a transport failure becomes a typed one, so no provider has
 *  to decide what a DNS error means. */
export const asRequestError = (err: unknown): PartsRequestError => {
  if (err instanceof PartsRequestError) return err
  if (err instanceof Error && err.name === 'AbortError') {
    return new PartsRequestError('network', 'aborted')
  }
  return new PartsRequestError('network', err instanceof Error ? err.message : String(err))
}

/** Shared skeleton so a provider only fills what it actually knows. */
export const emptyRecord = (
  provider: PartsProviderId,
  providerPartId: string,
  now: number
): PartRecord => ({
  provider,
  providerPartId,
  mpn: '',
  manufacturer: '',
  description: '',
  datasheetUrl: null,
  photoUrl: null,
  productUrl: null,
  lifecycle: 'unknown',
  rohs: null,
  parameters: [],
  offers: [],
  cad: { mode: 'none' },
  fetchedAt: now
})
