/**
 * Distributor part search — the shapes that cross the process bridge.
 *
 * Design: `docs/parts-sourcing-workstream.md`. Two rules shape this file.
 *
 * **No secret is ever in a type here.** Credentials live only in the main
 * process (`partsCredentials.ts`); the renderer sends them one way and only ever
 * reads back a `PartsCredentialStatus`, whose `hint` is a non-secret fragment.
 *
 * **Failures are a typed kind, not a message.** Main has no vue-i18n, and every
 * one of these failures has a different user fix — "invalid key" and "you are out
 * of quota until midnight" must not both render as "search failed". Main names
 * the kind; the renderer translates it.
 */

/** Distributors with a self-service API key. LCSC is deliberately absent — its
 *  official API is B2B-gated, so it is not a BYO-key provider. */
export type PartsProviderId = 'digikey' | 'mouser'

export interface PartPriceBreak {
  quantity: number
  unitPrice: number
}

/** One distributor's commercial terms for a part. */
export interface PartOffer {
  /** The distributor's own ordering code, not the MPN. */
  distributorPartNumber: string
  stock: number | null
  moq: number | null
  /** ISO-4217, as reported by the provider — never inferred. */
  currency: string
  priceBreaks: PartPriceBreak[]
  packaging: string | null
  productUrl: string | null
}

/** A provider's own parameter name and value, deliberately not normalized across
 *  providers: a mapped spec is a wrong spec. */
export interface PartParameter {
  name: string
  value: string
  /**
   * The provider's id for this parameter, where it publishes one. DigiKey uses
   * the same id space here as in `ParametricFilters`, which is what lets a
   * category's facet list become table columns and still find each row's cell:
   * matching on the display name would be a string join between two payloads
   * that are only conventionally spelled alike. Null for Mouser, which reports
   * no ids at all.
   */
  parameterId: number | null
}

export type PartLifecycle = 'active' | 'nrnd' | 'obsolete' | 'unknown'

/**
 * Whether CAD assets can be had for this part. Neither DigiKey nor Mouser serves
 * footprints as data — their "EDA Models" media entry is a link to a SnapEDA /
 * Ultra Librarian *page* — so `handoff` is the honest answer for both, and the UI
 * says so rather than implying a download that cannot happen.
 */
export type PartCadAvailability =
  { mode: 'none' } | { mode: 'handoff'; url: string; title: string | null }

/** A part as the app models it, normalized across providers. */
export interface PartRecord {
  provider: PartsProviderId
  /** The provider's own id for this part, used to re-fetch detail. */
  providerPartId: string
  mpn: string
  manufacturer: string
  description: string
  datasheetUrl: string | null
  photoUrl: string | null
  productUrl: string | null
  lifecycle: PartLifecycle
  /** Provider-reported RoHS wording, verbatim; null when not reported. */
  rohs: string | null
  parameters: PartParameter[]
  offers: PartOffer[]
  cad: PartCadAvailability
  /** Epoch ms this record was fetched. */
  fetchedAt: number
}

export interface PartSearchResult {
  parts: PartRecord[]
  /** Provider-reported total, which is usually far larger than `parts.length`. */
  total: number
  /** What this result set can be narrowed by, as the provider reported it. */
  facets: PartsFacets
}

/** One distributor's listing of a part, inside a universal-search row. */
export interface PartGroupSource {
  provider: PartsProviderId
  record: PartRecord
}

/**
 * One physical part, with every connected distributor that stocks it — the row
 * unit of universal search. Shared fields are *picked* from
 * whichever distributor supplied them, never blended; anything commercial stays
 * inside its own `sources` entry, which is both what the API terms require and
 * the more useful presentation.
 */
export interface PartGroup {
  key: string
  mpn: string
  manufacturer: string
  description: string
  datasheetUrl: string | null
  /** Every distributor's link, in source order. */
  datasheetUrls: { provider: PartsProviderId; url: string }[]
  photoUrl: string | null
  lifecycle: PartLifecycle
  rohs: string | null
  sources: PartGroupSource[]
}

/** A universal search: grouped rows, plus what each distributor said happened.
 *  A provider that failed is reported rather than silently dropped — otherwise
 *  "no results" and "your Mouser key expired" look identical. */
export interface PartsUniversalResult {
  groups: PartGroup[]
  /** Facets of the single provider searched; empty in universal mode, where two
   *  catalogs' facets cannot be merged without inventing a shared taxonomy. */
  facets: PartsFacets
  providers: Array<{
    provider: PartsProviderId
    ok: boolean
    total: number
    error?: PartsError
  }>
}

export type PartsErrorKind =
  | 'no-credentials'
  | 'invalid-credentials'
  | 'forbidden'
  | 'rate-limited'
  | 'quota-exhausted'
  | 'network'
  /** The request was still running when its deadline passed. Distinct from
   *  `network`: nothing refused us, the distributor just never answered. */
  | 'timeout'
  | 'provider-error'
  | 'bad-response'
  /** The OS keyring refused to encrypt, so the key was **not** stored. Never
   *  silently downgraded to plaintext — see `PartsService.setCredentials`. */
  | 'storage-unavailable'

export interface PartsError {
  kind: PartsErrorKind
  /** Provider/transport wording for the details line. Never contains a secret. */
  detail?: string
}

/** Every parts channel answers in this shape — a rejected promise would lose the
 *  kind, and every one of these failures is expected rather than exceptional. */
export type PartsResult<T> = { ok: true; value: T } | { ok: false; error: PartsError }

/** One credential input a provider needs, driving the Settings form. */
export interface PartsCredentialField {
  key: string
  /** Renderer i18n key suffix under `parts.fields.` — main has no vue-i18n. */
  labelKey: string
  /** Secret fields are write-only: never read back, masked on entry. */
  secret: boolean
  placeholder?: string
}

/** Everything the Settings card needs to describe a provider, from one object. */
export interface PartsProviderInfo {
  id: PartsProviderId
  /** A company name — a proper noun, so not translated. */
  name: string
  /** Deep link to the provider's own key-registration flow. The app only ever
   *  opens this; it never submits anything or creates an account. */
  registrationUrl: string
  fields: PartsCredentialField[]
  /** Published quota, for the usage meter. Verify against the live service. */
  quota: { perMinute: number; perDay: number }
}

export interface PartsCredentialStatus {
  provider: PartsProviderId
  configured: boolean
  /** A non-secret fragment (e.g. a DigiKey Client ID) so the user can tell which
   *  key is installed without the app ever handing back the secret. */
  hint: string | null
  lastVerifiedAt: number | null
  /**
   * Whether the OS keyring backed the encryption. False on a Linux box with no
   * libsecret/kwallet, where Electron falls back to a hardcoded key — that is
   * obfuscation, not encryption, and the card says so rather than implying a
   * protection we do not have.
   */
  encryptionAvailable: boolean
}

export interface PartsUsage {
  provider: PartsProviderId
  minute: { used: number; limit: number }
  day: { used: number; limit: number; resetsAt: number }
  lastSuccessAt: number | null
}

/**
 * A node in a distributor's own category tree. DigiKey returns the whole tree in
 * one call with `Children` nested and a product count per node, which is what
 * makes a browse surface cheap: fetched once per session, walked locally.
 */
export interface PartCategory {
  id: number
  name: string
  productCount: number
  children: PartCategory[]
}

/** Which catalog a search is asking. Universal fans out to every configured
 *  distributor and groups the answers; a distributor mode asks only that one and
 *  can therefore use its paging, sorting and filters. */
export type PartsSearchMode = 'universal' | PartsProviderId

/** One selectable facet value, as the distributor reports it. */
export interface PartFacetValue {
  /** Echoed back verbatim to filter — an opaque token, never parsed. */
  id: string
  label: string
  productCount: number
}

/** A parametric facet: DigiKey's `ParametricFilters[]`. Only present once a
 *  search is scoped to a category — a bare keyword search returns none. */
export interface PartParametricFacet {
  parameterId: number
  name: string
  values: PartFacetValue[]
}

/** What the distributor says this result set can be narrowed by. Empty for a
 *  provider whose API has no facets (Mouser). */
export interface PartsFacets {
  manufacturers: PartFacetValue[]
  packaging: PartFacetValue[]
  status: PartFacetValue[]
  /** A manufacturer's product family (DigiKey's `Series`). Real and useful on a
   *  narrow category — it is how you get from "ceramic capacitors" to one
   *  vendor's actual line. */
  series: PartFacetValue[]
  parametric: PartParametricFacet[]
}

/**
 * Filters applied **to the request**, not to the rows already fetched.
 *
 * Server-side because a client-side rail can only narrow what the first page
 * happened to contain — it can never surface a part the search did not return.
 * The cost is that changing one re-queries, which is why the UI accumulates
 * changes behind an Apply rather than firing per checkbox.
 *
 * Support varies: `inStock` and `rohs` map to both APIs; everything else is
 * DigiKey-only and is simply absent from the rail in other modes.
 */
export interface PartsFilterState {
  inStock: boolean
  rohs: boolean
  /** DigiKey `SearchOptions.HasDatasheet`. */
  hasDatasheet: boolean
  /** DigiKey `SearchOptions.Has3DModel`. */
  has3dModel: boolean
  manufacturerIds: string[]
  packagingIds: string[]
  statusIds: string[]
  seriesIds: string[]
  /** `ParameterId` → the `ValueId`s selected under it. */
  parameters: Record<number, string[]>
}

/**
 * The fields a distributor will sort on, server-side.
 *
 * These are DigiKey's `SortField` enum members, confirmed by probe
 * rather than read from the spec, which truncates the definition. The
 * names are the API's own — spelling them ourselves and mapping would only add
 * a translation layer between a column and the value it sends.
 *
 * Two absences decide the table's design. There is **no relevance member**, so
 * "unsorted" is the absence of a sort rather than a value. And **`Parameter` is
 * rejected**, so a parametric column cannot be sorted at the API — and sorting
 * one locally would order a page against a total in the hundreds of thousands,
 * which is the same lie a client-side filter would tell.
 */
export type PartsSortField =
  | 'Price'
  | 'QuantityAvailable'
  | 'Manufacturer'
  | 'ManufacturerProductNumber'
  | 'ProductStatus'
  | 'Packaging'
  | 'Supplier'

export interface PartsSort {
  field: PartsSortField
  order: 'asc' | 'desc'
}

export interface PartsQuery {
  provider: PartsProviderId
  keyword: string
  /** Provider maximum is 50 (DigiKey); we ask for less by default. */
  limit?: number
  offset?: number
}
