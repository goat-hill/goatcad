/**
 * DigiKey Product Information v4.
 *
 * Endpoint, method, headers and the top-level product field names are taken from
 * DigiKey's own OpenAPI download on developer.digikey.com, not a third-party
 * wrapper:
 *
 * - token   `POST https://api.digikey.com/v1/oauth2/token` (form-encoded)
 * - search  `POST https://api.digikey.com/products/v4/search/keyword`
 * - media   `GET  https://api.digikey.com/products/v4/search/{pn}/media`
 * - headers `X-DIGIKEY-Client-Id` (required), `X-DIGIKEY-Locale-Site` /
 *           `-Language` / `-Currency` (optional), plus the bearer token
 * - product `Description{ProductDescription,DetailedDescription}`,
 *           `Manufacturer{Id,Name}`, `ManufacturerProductNumber`, `DatasheetUrl`,
 *           `PhotoUrl`, `ProductUrl`, `QuantityAvailable`, `ProductStatus`,
 *           `Parameters`, `ProductVariations`
 *
 * **Two-legged client credentials, deliberately.** We want catalog data, not the
 * user's cart or orders, and the 2-legged flow needs no redirect URI, no loopback
 * listener and no browser round trip. If
 * order history is ever wanted, that is a separate additive opt-in.
 *
 * **Nested shapes are read defensively.** DigiKey's published spec truncates the
 * nested definitions, so the `ProductVariations` / `Classifications` readers below
 * accept more than one plausible spelling and fall back to null. That is the right
 * posture for a payload we do not control either way — a renamed field costs a
 * blank column, never a thrown search.
 */
import type {
  PartCadAvailability,
  PartCategory,
  PartFacetValue,
  PartParameter,
  PartParametricFacet,
  PartRecord,
  PartSearchResult,
  PartsFacets,
  PartsFilterState,
  PartsSort
} from '../preload/partsTypes'
import type { ProviderCredentials } from './partsCredentials'
import {
  asArray,
  asCount,
  asPrice,
  asRecord,
  asRequestError,
  asText,
  asUrl,
  emptyRecord,
  errorKindForStatus,
  PartsRequestError,
  type PartsProvider,
  type ProviderContext
} from './partsProviders'

const TOKEN_URL = 'https://api.digikey.com/v1/oauth2/token'
const BASE_URL = 'https://api.digikey.com/products/v4'

/** Refresh this far before expiry so a token cannot die mid-request. */
const TOKEN_SKEW_MS = 60_000

interface CachedToken {
  clientId: string
  accessToken: string
  expiresAt: number
}

/**
 * In memory only, and never written to disk — a bearer token is a credential
 * with none of the offline value that justifies persisting the key itself.
 * Keyed by client id so replacing the key cannot reuse the old token.
 */
let cachedToken: CachedToken | null = null

/** Exported for tests, and for the credential store to call on a key change. */
export const clearDigikeyToken = (): void => {
  cachedToken = null
}

const fetchToken = async (ctx: ProviderContext): Promise<string> => {
  const clientId = ctx.credentials.clientId ?? ''
  const clientSecret = ctx.credentials.clientSecret ?? ''
  if (!clientId || !clientSecret) throw new PartsRequestError('no-credentials')

  if (cachedToken && cachedToken.clientId === clientId && cachedToken.expiresAt > Date.now()) {
    return cachedToken.accessToken
  }

  // Deliberately not charged to the catalog quota: the token endpoint is a
  // different product from Product Information and is not metered with it.
  let response: Response
  try {
    response = await ctx.fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'client_credentials'
      }).toString(),
      signal: ctx.signal
    })
  } catch (err) {
    throw asRequestError(err)
  }

  if (!response.ok) {
    // The token endpoint is where a wrong client id/secret actually surfaces;
    // 400 here means bad credentials, not a malformed request of ours.
    const kind =
      response.status === 400 ? 'invalid-credentials' : errorKindForStatus(response.status)
    throw new PartsRequestError(kind, `HTTP ${response.status}`)
  }

  const payload = asRecord(await response.json().catch(() => null))
  const accessToken = asText(payload?.access_token)
  if (!accessToken)
    throw new PartsRequestError('bad-response', 'token response had no access_token')
  const expiresIn = asCount(payload?.expires_in) ?? 600

  cachedToken = {
    clientId,
    accessToken,
    expiresAt: Date.now() + Math.max(0, expiresIn * 1000 - TOKEN_SKEW_MS)
  }
  return accessToken
}

const request = async (
  path: string,
  init: { method: 'GET' | 'POST'; body?: unknown },
  ctx: ProviderContext
): Promise<Record<string, unknown>> => {
  const call = async (token: string): Promise<Response> => {
    ctx.onRequest()
    return ctx.fetch(`${BASE_URL}${path}`, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${token}`,
        'X-DIGIKEY-Client-Id': ctx.credentials.clientId ?? '',
        'X-DIGIKEY-Locale-Site': 'US',
        'X-DIGIKEY-Locale-Language': 'en',
        'X-DIGIKEY-Locale-Currency': ctx.currency,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: ctx.signal
    })
  }

  let response: Response
  try {
    response = await call(await fetchToken(ctx))
    // Refresh exactly once. A revoked key must surface as "reconnect", not spin:
    // the retry is for a token that expired early, not for a wrong credential.
    if (response.status === 401) {
      clearDigikeyToken()
      response = await call(await fetchToken(ctx))
    }
  } catch (err) {
    throw asRequestError(err)
  }

  if (!response.ok) {
    throw new PartsRequestError(errorKindForStatus(response.status), `HTTP ${response.status}`)
  }
  const payload = asRecord(await response.json().catch(() => null))
  if (!payload) throw new PartsRequestError('bad-response', 'response was not an object')
  return payload
}

/** DigiKey's `ProductStatus.Status` wording; unrecognized stays `unknown`. */
export const digikeyLifecycle = (raw: unknown): PartRecord['lifecycle'] => {
  const status = asRecord(raw)
  const text = (asText(status?.Status) || asText(raw)).toLowerCase()
  if (!text) return 'unknown'
  if (text.includes('obsolete') || text.includes('discontinued')) return 'obsolete'
  if (text.includes('not for new designs') || text.includes('last time buy')) return 'nrnd'
  if (text.includes('active')) return 'active'
  return 'unknown'
}

/** One `ProductVariations[]` entry → an offer. Each variation is a packaging
 *  option (Cut Tape, Tape & Reel, Digi-Reel) with its own stock and pricing, so
 *  they genuinely are separate offers rather than duplicates of one. */
const normalizeVariation = (
  raw: unknown,
  currency: string
): PartRecord['offers'][number] | null => {
  const variation = asRecord(raw)
  if (!variation) return null
  const distributorPartNumber = asText(variation.DigiKeyProductNumber)
  if (!distributorPartNumber) return null

  const priceBreaks = asArray(variation.StandardPricing)
    .map((entry) => {
      const row = asRecord(entry)
      const quantity = asCount(row?.BreakQuantity)
      const unitPrice = asPrice(row?.UnitPrice)
      return quantity !== null && unitPrice !== null ? { quantity, unitPrice } : null
    })
    .filter((row): row is { quantity: number; unitPrice: number } => row !== null)
    .sort((a, b) => a.quantity - b.quantity)

  return {
    distributorPartNumber,
    // DigiKey's own spelling has a lowercase `f` in "for"; accept the obvious
    // alternative too rather than silently reporting no stock if it is fixed.
    stock:
      asCount(variation.QuantityAvailableforPackageType) ??
      asCount(variation.QuantityAvailableForPackageType),
    moq: asCount(variation.MinimumOrderQuantity),
    currency,
    priceBreaks,
    packaging: asText(asRecord(variation.PackageType)?.Name) || null,
    productUrl: asUrl(variation.ProductUrl)
  }
}

/** One `Products[]` entry → `PartRecord`. Total; a product with no MPN is
 *  dropped, since there is nothing to bind to a component. */
export const normalizeDigikeyProduct = (
  raw: unknown,
  currency: string,
  now: number
): PartRecord | null => {
  const product = asRecord(raw)
  if (!product) return null

  const mpn = asText(product.ManufacturerProductNumber)
  if (!mpn) return null

  const description = asRecord(product.Description)
  const offers = asArray(product.ProductVariations)
    .map((entry) => normalizeVariation(entry, currency))
    .filter((offer): offer is PartRecord['offers'][number] => offer !== null)

  // `ParameterId` is the join key for the per-category columns: it matches the
  // ids in `ParametricFilters`, so a column finds its cell without comparing
  // display names across two payloads.
  const parameters = asArray(product.Parameters)
    .map((entry): PartParameter | null => {
      const row = asRecord(entry)
      const name = asText(row?.ParameterText) || asText(row?.Parameter)
      const value = asText(row?.ValueText) || asText(row?.Value)
      const parameterId = asCount(row?.ParameterId)
      return name && value ? { name, value, parameterId } : null
    })
    .filter((row): row is PartParameter => row !== null)

  // Product-level stock is the sum across packagings; prefer it when reported,
  // since an offer-level figure alone understates what is actually available.
  const productStock = asCount(product.QuantityAvailable)
  if (productStock !== null && offers.length === 0) {
    // No variations came back but the product has stock — keep the commercial
    // half rather than dropping it, using the product's own identifiers.
    offers.push({
      distributorPartNumber: asText(product.DigiKeyProductNumber) || mpn,
      stock: productStock,
      moq: null,
      currency,
      priceBreaks: [],
      packaging: null,
      productUrl: asUrl(product.ProductUrl)
    })
  }

  return {
    ...emptyRecord('digikey', offers[0]?.distributorPartNumber || mpn, now),
    mpn,
    manufacturer: asText(asRecord(product.Manufacturer)?.Name),
    description:
      asText(description?.ProductDescription) || asText(description?.DetailedDescription),
    datasheetUrl: asUrl(product.DatasheetUrl),
    photoUrl: asUrl(product.PhotoUrl),
    productUrl: asUrl(product.ProductUrl),
    lifecycle: digikeyLifecycle(product.ProductStatus),
    rohs: asText(asRecord(product.Classifications)?.RohsStatus) || null,
    parameters,
    offers
  }
}

/**
 * `MediaLinks[]` → CAD availability.
 *
 * The `EDA Models` entry is a **URL to a SnapEDA / Ultra Librarian web page**,
 * not a downloadable model — so this can only ever produce a `handoff`, and the
 * UI must say "open the model page", never "download". That asymmetry is the
 * whole reason `PartCadAvailability` has a mode.
 */
export const cadFromMediaLinks = (payload: unknown): PartCadAvailability => {
  const links = asArray(asRecord(payload)?.MediaLinks)
  for (const entry of links) {
    const link = asRecord(entry)
    if (!/eda|cad/i.test(asText(link?.MediaType))) continue
    const url = asUrl(link?.Url)
    if (url) return { mode: 'handoff', url, title: asText(link?.Title) || null }
  }
  return { mode: 'none' }
}

/** `Categories[]` → our tree. Total, like every other normalizer here: a node
 *  missing an id or a name is dropped rather than rendered as a blank row. */
export const normalizeCategories = (raw: unknown): PartCategory[] =>
  asArray(raw)
    .map((entry) => {
      const node = asRecord(entry)
      const id = asCount(node?.CategoryId)
      const name = asText(node?.Name)
      if (id === null || !name) return null
      return {
        id,
        name,
        productCount: asCount(node?.ProductCount) ?? 0,
        children: normalizeCategories(node?.Children)
      }
    })
    .filter((node): node is PartCategory => node !== null)

/**
 * `FilterOptions` → our facet model. Field names verified live:
 * `Manufacturers`/`Packaging`/`Status` are `BaseFilterV4`
 * (`{Id, Value, ProductCount}`), and `ParametricFilters[]` carries
 * `{ParameterId, ParameterName, FilterValues:[{ValueId, ValueName, ProductCount}]}`.
 *
 * A `ValueId` is a **display string** (`"0.1 pF"`), not a numeric id — so it is
 * carried opaquely and echoed back untouched rather than parsed.
 */
export const normalizeFacets = (raw: unknown): PartsFacets => {
  const options = asRecord(raw)
  const values = (list: unknown): PartFacetValue[] =>
    asArray(list)
      .map((entry) => {
        const node = asRecord(entry)
        const id = asText(node?.Id) || asText(node?.ValueId)
        const label = asText(node?.Value) || asText(node?.ValueName) || id
        if (!id) return null
        return { id, label, productCount: asCount(node?.ProductCount) ?? 0 }
      })
      .filter((value): value is PartFacetValue => value !== null)

  return {
    manufacturers: values(options?.Manufacturers),
    packaging: values(options?.Packaging),
    status: values(options?.Status),
    series: values(options?.Series),
    parametric: asArray(options?.ParametricFilters)
      .map((entry) => {
        const node = asRecord(entry)
        const parameterId = asCount(node?.ParameterId)
        const name = asText(node?.ParameterName)
        if (parameterId === null || !name) return null
        return { parameterId, name, values: values(node?.FilterValues) }
      })
      .filter((facet): facet is PartParametricFacet => facet !== null && facet.values.length > 0)
  }
}

/**
 * Our filter state → DigiKey's `FilterOptionsRequest`.
 *
 * Every shape here is verified, including the one the published spec
 * omits: `ParameterFilterRequest.ParameterFilters[].ParameterId` is an **Int32**
 * — DigiKey's own validator named that path when it was sent a null. Only
 * non-empty sections are emitted, since an empty array reads as "match nothing"
 * to some of these filters.
 */
export const buildFilterOptions = (
  filters: PartsFilterState | undefined,
  categoryId: number | undefined
): Record<string, unknown> | null => {
  const request: Record<string, unknown> = {}
  if (categoryId !== undefined) request.CategoryFilter = [{ Id: String(categoryId) }]

  const searchOptions: string[] = []
  if (filters?.inStock) searchOptions.push('InStock')
  if (filters?.rohs) searchOptions.push('RohsCompliant')
  if (filters?.hasDatasheet) searchOptions.push('HasDatasheet')
  if (filters?.has3dModel) searchOptions.push('Has3DModel')
  if (searchOptions.length) request.SearchOptions = searchOptions

  const ids = (list: string[] | undefined): { Id: string }[] | null =>
    list && list.length ? list.map((id) => ({ Id: id })) : null
  const manufacturers = ids(filters?.manufacturerIds)
  if (manufacturers) request.ManufacturerFilter = manufacturers
  const packaging = ids(filters?.packagingIds)
  if (packaging) request.PackagingFilter = packaging
  const status = ids(filters?.statusIds)
  if (status) request.StatusFilter = status
  const series = ids(filters?.seriesIds)
  if (series) request.SeriesFilter = series

  const parameterFilters = Object.entries(filters?.parameters ?? {})
    .filter(([, values]) => values.length > 0)
    .map(([parameterId, values]) => ({
      ParameterId: Number(parameterId),
      FilterValues: values.map((id) => ({ Id: id }))
    }))
  if (parameterFilters.length) {
    // Parametric filters are only offered once a category is chosen — DigiKey
    // returns none for a bare keyword search — so the category always travels
    // with them, and it is **required**: omitting it answers
    // "The CategoryFilter field is required."
    //
    // Note the key. Inside `ParameterFilterRequest` it is `CategoryFilter` and a
    // single object, where the outer `FilterOptionsRequest.CategoryFilter` is an
    // array. Calling it `Category` here — the obvious guess, and what shipped
    // first — is rejected, which is what made Apply do nothing.
    request.ParameterFilterRequest = {
      ...(categoryId === undefined ? {} : { CategoryFilter: { Id: String(categoryId) } }),
      ParameterFilters: parameterFilters
    }
  }

  return Object.keys(request).length ? request : null
}

/**
 * Our sort → DigiKey's `SortOptions`, verified by probe.
 *
 * `Field` and `SortOrder` are both C# enums, so unlike the filter shapes a wrong
 * name here is a 400 rather than a silently dropped property. Omitted entirely
 * when nothing is sorted: the enum has no relevance member, so the default
 * ordering is the absence of this object, never a value in it.
 */
export const buildSortOptions = (
  sort: PartsSort | null | undefined
): Record<string, string> | null =>
  sort ? { Field: sort.field, SortOrder: sort.order === 'desc' ? 'Descending' : 'Ascending' } : null

export const digikeyProvider: PartsProvider = {
  id: 'digikey',

  async search(
    { keyword, limit, offset, categoryId, filters, sort },
    ctx
  ): Promise<PartSearchResult> {
    // Browsing a category is a keyword search scoped by CategoryFilter — DigiKey
    // needs no keyword alongside it, which is what lets a category click be a
    // search in its own right.
    const filterOptions = buildFilterOptions(filters, categoryId)
    const sortOptions = buildSortOptions(sort)
    const payload = await request(
      '/search/keyword',
      {
        method: 'POST',
        body: {
          Keywords: keyword,
          Limit: limit,
          Offset: offset,
          ...(filterOptions ? { FilterOptionsRequest: filterOptions } : {}),
          ...(sortOptions ? { SortOptions: sortOptions } : {})
        }
      },
      ctx
    )
    const now = Date.now()
    // `ExactMatches` is populated instead of `Products` for an exact part-number
    // query, so reading only `Products` would return nothing for the most
    // precise search a user can make.
    const raw = asArray(payload.Products)
    const products = raw.length > 0 ? raw : asArray(payload.ExactMatches)
    const parts = products
      .map((entry) => normalizeDigikeyProduct(entry, ctx.currency, now))
      .filter((part): part is PartRecord => part !== null)
    return {
      parts,
      total: asCount(payload.ProductsCount) ?? parts.length,
      facets: normalizeFacets(payload.FilterOptions)
    }
  },

  async cad(partId, ctx): Promise<PartCadAvailability> {
    return cadFromMediaLinks(
      await request(`/search/${encodeURIComponent(partId)}/media`, { method: 'GET' }, ctx)
    )
  },

  /**
   * The whole category tree, in one call. `Children` nests the hierarchy and
   * every node carries a `ProductCount`, so a browse surface needs exactly one
   * request per session and walks the rest locally — which matters a great deal
   * against a 1000-call day.
   */
  async categories(ctx): Promise<PartCategory[]> {
    const payload = await request('/search/categories', { method: 'GET' }, ctx)
    return normalizeCategories(payload.Categories)
  },

  async verify(ctx): Promise<void> {
    // Proves the token *and* that the account is subscribed to Product
    // Information — a token alone would still 403 on the catalog.
    await request(
      '/search/keyword',
      { method: 'POST', body: { Keywords: 'resistor', Limit: 1, Offset: 0 } },
      ctx
    )
  },

  hint(credentials: ProviderCredentials): string | null {
    // The Client ID is an identifier, not the secret, so it is safe to show —
    // and it is the field a user checks when two apps are registered.
    const clientId = credentials.clientId ?? ''
    return clientId ? `${clientId.slice(0, 8)}…` : null
  }
}
