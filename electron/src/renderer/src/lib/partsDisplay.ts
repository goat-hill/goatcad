/**
 * Turning a distributor record into the numbers a row shows.
 *
 * Renderer-side on purpose: the quantity control re-prices the whole result set
 * as it changes, and that must never cost a request.
 * Grouping lives in main because it shapes the response; these are pure
 * display arithmetic over a response already in hand.
 */
import type {
  PartGroup,
  PartRecord,
  PartSearchResult,
  PartsProviderId,
  PartsResult,
  PartsUniversalResult
} from '../../../preload/partsTypes'

export interface AppliedPrice {
  unitPrice: number
  currency: string
  /** The break that applied — useful when it is far below what was asked for. */
  breakQuantity: number
}

/**
 * The unit price for a target quantity, from one distributor's own breaks.
 *
 * Deliberately per-record, never "cheapest across distributors": a blended
 * figure is what both API agreements forbid, and it would mislead anyway since breaks carry
 * different minimum quantities and packaging. Null when no break applies — a
 * part whose smallest order is 250 has no price at qty 10, and saying so beats
 * quoting a number nobody can buy at.
 */
export const priceAtQuantity = (record: PartRecord, quantity: number): AppliedPrice | null => {
  let best: AppliedPrice | null = null
  for (const offer of record.offers) {
    for (const priceBreak of offer.priceBreaks) {
      // The applicable break is the largest at or below the target: buying 10
      // does not get you the 100-piece price.
      if (priceBreak.quantity > quantity) continue
      if (!best || priceBreak.quantity > best.breakQuantity) {
        best = {
          unitPrice: priceBreak.unitPrice,
          currency: offer.currency,
          breakQuantity: priceBreak.quantity
        }
      }
    }
  }
  return best
}

/** Stock across a distributor's packagings, or null if none of them reported.
 *  "Unknown" and "none in stock" are different answers and render apart. */
export const totalStock = (record: PartRecord): number | null => {
  const known = record.offers.map((offer) => offer.stock).filter((s): s is number => s !== null)
  return known.length === 0 ? null : known.reduce((sum, value) => sum + value, 0)
}

/**
 * A single distributor's result, in the same shape universal search produces.
 *
 * Grouping a one-provider answer looks redundant — every row will have exactly
 * one seller — but it is what lets one results UI serve all three modes:
 * the component never branches on mode, because the data it
 * renders is the same type either way. Grouping also still does real work here,
 * folding a provider's duplicate listings of one part into a single row.
 */
export const groupSingleProvider = (
  provider: PartsProviderId,
  result: PartsResult<PartSearchResult>
): PartsUniversalResult => {
  const noFacets = { manufacturers: [], packaging: [], status: [], series: [], parametric: [] }
  if (!result.ok) {
    return {
      groups: [],
      facets: noFacets,
      providers: [{ provider, ok: false, total: 0, error: result.error }]
    }
  }
  const groups = new Map<string, PartGroup>()
  for (const record of result.value.parts) {
    if (!record.mpn.trim()) continue
    const key = `${record.mpn.trim().toUpperCase()}|${record.manufacturer.trim().toUpperCase()}`
    if (groups.has(key)) continue
    groups.set(key, {
      key: `${record.provider}:${record.providerPartId}`,
      mpn: record.mpn,
      manufacturer: record.manufacturer,
      description: record.description,
      datasheetUrl: record.datasheetUrl,
      datasheetUrls: record.datasheetUrl
        ? [{ provider: record.provider, url: record.datasheetUrl }]
        : [],
      photoUrl: record.photoUrl,
      lifecycle: record.lifecycle,
      rohs: record.rohs,
      sources: [{ provider: record.provider, record }]
    })
  }
  return {
    groups: [...groups.values()],
    // A distributor mode carries its own facets straight through — this is the
    // mode where server-side narrowing is actually available.
    facets: result.value.facets,
    providers: [{ provider, ok: true, total: result.value.total }]
  }
}
