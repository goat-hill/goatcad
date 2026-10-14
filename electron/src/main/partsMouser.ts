/**
 * Mouser Search API v1.
 *
 * Shapes taken from Mouser's own published Swagger (`api.mouser.com/api/docs/V1`),
 * not a third-party wrapper:
 *
 * - `POST https://api.mouser.com/api/v1/search/keyword?apiKey=<key>`
 * - body wrapper `SearchByKeywordRequest` — `{ keyword, records, startingRecord }`
 * - response `{ Errors: [], SearchResults: { NumberOfResult, Parts: [] } }`
 * - part fields `MouserPartNumber`, `Manufacturer`, `ManufacturerPartNumber`,
 *   `Description`, `Availability`, `PriceBreaks[{Quantity, Price, Currency}]`,
 *   `LeadTime`, `DataSheetUrl`, `ProductDetailUrl`, `ROHSStatus`,
 *   `LifecycleStatus`, `Category`, `ProductAttributes[{AttributeName,
 *   AttributeValue, AttributeCost}]`
 *
 * **The auth is a query parameter**, which is why `redactSecrets` scrubs
 * `apiKey=` out of anything bound for a log or an error detail: a plain rethrow
 * of a fetch failure would otherwise carry the user's key in the URL.
 *
 * **Mouser answers 200 with an `Errors` array** rather than an HTTP status for
 * several real failures, including a bad key. Reading only `response.ok` would
 * therefore report "no results" for "your key is wrong", so `Errors` is checked
 * before the payload.
 */
import type {
  PartParameter,
  PartRecord,
  PartSearchResult,
  PartsFilterState
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
  emptyFacets,
  emptyRecord,
  errorKindForStatus,
  PartsRequestError,
  type PartsProvider,
  type ProviderContext
} from './partsProviders'

const BASE_URL = 'https://api.mouser.com/api/v1'

/** Mouser's entire filter vocabulary, per its published Swagger. Anything the
 *  rail offers beyond these two is DigiKey-only and never reaches here. */
export const mouserSearchOption = (filters?: PartsFilterState): string => {
  if (filters?.inStock && filters?.rohs) return 'RohsAndInStock'
  if (filters?.inStock) return 'InStock'
  if (filters?.rohs) return 'Rohs'
  return 'None'
}

/** Mouser reports lifecycle as free text; anything we do not recognize stays
 *  `unknown` rather than being guessed into `active`. */
export const mouserLifecycle = (raw: unknown): PartRecord['lifecycle'] => {
  const text = asText(raw).toLowerCase()
  if (!text) return 'unknown'
  if (text.includes('obsolete') || text.includes('discontinued') || text.includes('eol')) {
    return 'obsolete'
  }
  if (text.includes('not recommended') || text.includes('nrnd')) return 'nrnd'
  if (text.includes('active') || text.includes('production')) return 'active'
  return 'unknown'
}

/**
 * One `Parts[]` entry → `PartRecord`. Total: a part with no MPN is dropped
 * (there is nothing to bind to a component), everything else degrades to empty.
 */
export const normalizeMouserPart = (raw: unknown, now: number): PartRecord | null => {
  const part = asRecord(raw)
  if (!part) return null

  const mpn = asText(part.ManufacturerPartNumber)
  const mouserPn = asText(part.MouserPartNumber)
  if (!mpn && !mouserPn) return null

  const priceBreaks = asArray(part.PriceBreaks)
    .map((entry) => {
      const row = asRecord(entry)
      if (!row) return null
      const quantity = asCount(row.Quantity)
      const unitPrice = asPrice(row.Price)
      return quantity !== null && unitPrice !== null ? { quantity, unitPrice } : null
    })
    .filter((row): row is { quantity: number; unitPrice: number } => row !== null)
    .sort((a, b) => a.quantity - b.quantity)

  // Currency is per-price-break in Mouser's model; they agree in practice, and
  // the first one is what the whole offer is quoted in.
  const currency = asText(asRecord(asArray(part.PriceBreaks)[0])?.Currency) || 'USD'

  // No parameter ids: Mouser's attributes are names and values only, which is
  // also why its results carry no parametric columns.
  const parameters = asArray(part.ProductAttributes)
    .map((entry): PartParameter | null => {
      const row = asRecord(entry)
      const name = asText(row?.AttributeName)
      const value = asText(row?.AttributeValue)
      return name && value ? { name, value, parameterId: null } : null
    })
    .filter((row): row is PartParameter => row !== null)

  // Packaging is a product attribute, listed once per packaging the Mouser
  // number ships in (Reel, Cut Tape, MouseReel); `Category` is the product
  // category, not a packaging.
  const packaging = parameters
    .filter((parameter) => parameter.name === 'Packaging')
    .map((parameter) => parameter.value)

  // `AvailabilityInStock` is the plain number when present; `Availability` is
  // display text ("1,234 In Stock") that asCount reads the leading number out of.
  const stock = asCount(part.AvailabilityInStock) ?? asCount(part.Availability)

  return {
    ...emptyRecord('mouser', mouserPn || mpn, now),
    mpn: mpn || mouserPn,
    manufacturer: asText(part.Manufacturer),
    description: asText(part.Description),
    datasheetUrl: asUrl(part.DataSheetUrl),
    photoUrl: asUrl(part.ImagePath),
    productUrl: asUrl(part.ProductDetailUrl),
    lifecycle: mouserLifecycle(part.LifecycleStatus),
    rohs: asText(part.ROHSStatus) || null,
    parameters,
    offers: [
      {
        distributorPartNumber: mouserPn,
        stock,
        moq: asCount(part.Min),
        currency,
        priceBreaks,
        packaging: packaging.length ? packaging.join(', ') : null,
        productUrl: asUrl(part.ProductDetailUrl)
      }
    ],
    // Mouser's API exposes no CAD asset. Its site links models through partners,
    // but not as an API field — so the honest answer is none rather than a
    // fabricated deep link.
    cad: { mode: 'none' }
  }
}

/** `Errors[]` carries a code and message; surface the first, it is the cause. */
const throwIfApiError = (payload: Record<string, unknown>): void => {
  const errors = asArray(payload.Errors)
  if (errors.length === 0) return
  const first = asRecord(errors[0])
  const message = asText(first?.Message) || asText(first?.message)
  const code = asText(first?.Code) || asText(first?.code)
  const text = `${code}${code && message ? ' ' : ''}${message}`.trim() || 'unknown error'
  // Mouser reports an unknown/expired key this way, with HTTP 200.
  const invalid = /api ?key|not ?authori|invalid/i.test(text)
  throw new PartsRequestError(invalid ? 'invalid-credentials' : 'provider-error', text)
}

const postJson = async (
  path: string,
  body: unknown,
  ctx: ProviderContext
): Promise<Record<string, unknown>> => {
  const apiKey = ctx.credentials.apiKey ?? ''
  if (!apiKey) throw new PartsRequestError('no-credentials')

  const url = `${BASE_URL}${path}?apiKey=${encodeURIComponent(apiKey)}`
  ctx.onRequest()
  let response: Response
  try {
    response = await ctx.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: ctx.signal
    })
  } catch (err) {
    throw asRequestError(err)
  }

  if (!response.ok) {
    throw new PartsRequestError(errorKindForStatus(response.status), `HTTP ${response.status}`)
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new PartsRequestError('bad-response', 'response was not JSON')
  }
  const record = asRecord(payload)
  if (!record) throw new PartsRequestError('bad-response', 'response was not an object')
  throwIfApiError(record)
  return record
}

export const mouserProvider: PartsProvider = {
  id: 'mouser',

  /**
   * `categoryId` and every DigiKey-only filter are accepted and ignored:
   * Mouser's Search API has no categories and no parametric filters. Its whole
   * filter surface is `searchOptions`, which takes one of four values — so the
   * two switches it *does* support are mapped and the rest simply does not exist
   * in Mouser mode's rail.
   */
  async search({ keyword, limit, offset, filters }, ctx): Promise<PartSearchResult> {
    const payload = await postJson(
      '/search/keyword',
      {
        SearchByKeywordRequest: {
          keyword,
          records: limit,
          startingRecord: offset,
          searchOptions: mouserSearchOption(filters),
          searchWithYourSignUpLanguage: ''
        }
      },
      ctx
    )
    const results = asRecord(payload.SearchResults)
    const now = Date.now()
    const parts = asArray(results?.Parts)
      .map((entry) => normalizeMouserPart(entry, now))
      .filter((part): part is PartRecord => part !== null)
    // No facets: Mouser reports none, and inventing them would mean guessing at
    // a taxonomy its API never exposes.
    return { parts, total: asCount(results?.NumberOfResult) ?? parts.length, facets: emptyFacets() }
  },

  async verify(ctx): Promise<void> {
    // One record of a keyword every catalog has — the cheapest call that still
    // proves the key is accepted rather than merely well-formed.
    await postJson(
      '/search/keyword',
      { SearchByKeywordRequest: { keyword: 'resistor', records: 1, startingRecord: 0 } },
      ctx
    )
  },

  hint(credentials: ProviderCredentials): string | null {
    // A GUID's last block is enough to tell two keys apart and is not usable on
    // its own. Never show the leading bytes, which is the reconstructible half.
    const key = credentials.apiKey ?? ''
    return key.length > 6 ? `…${key.slice(-6)}` : null
  }
}
