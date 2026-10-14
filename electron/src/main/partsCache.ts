/**
 * In-memory result cache, scoped to what is on screen.
 *
 * The rule: hold results while a view needs
 * them, and no longer. Both API agreements prohibit storing their content or
 * building a database from it, so nothing here is written to disk and nothing
 * survives a restart. The short TTL exists so paging back to a search just run
 * does not spend quota twice, not to accumulate a store.
 *
 * Metadata the user deliberately writes onto a component — MPN, manufacturer,
 * datasheet — is out of scope entirely: that is manufacturer fact in the user's
 * own design file, not a copy of a catalog.
 */
import type { PartRecord, PartSearchResult, PartsProviderId } from '../preload/partsTypes'

/**
 * How long a result stays worth reusing. Short on purpose: this exists to make
 * paging and re-running the same search free, not to build up a store. Prices
 * and stock move, and nothing here should ever be old enough to mislead.
 */
export const RESULT_TTL_MS = 5 * 60 * 1000

export const cacheKey = (provider: PartsProviderId, partId: string): string =>
  `${provider}:${partId}`

/** Queries that differ only in spacing or case are the same query. */
export const searchKey = (
  provider: PartsProviderId,
  keyword: string,
  limit: number,
  offset: number
): string => `${provider}:${keyword.trim().toLowerCase().replace(/\s+/g, ' ')}:${limit}:${offset}`

export class PartsCache {
  private readonly records = new Map<string, { at: number; record: PartRecord }>()
  private readonly searches = new Map<string, { at: number; result: PartSearchResult }>()

  constructor(private readonly now: () => number = Date.now) {}

  private fresh(at: number): boolean {
    return this.now() - at <= RESULT_TTL_MS
  }

  get(provider: PartsProviderId, partId: string): PartRecord | null {
    const key = cacheKey(provider, partId)
    const hit = this.records.get(key)
    if (!hit) return null
    if (!this.fresh(hit.at)) {
      this.records.delete(key)
      return null
    }
    return hit.record
  }

  put(record: PartRecord): void {
    this.records.set(cacheKey(record.provider, record.providerPartId), {
      at: this.now(),
      record
    })
  }

  getSearch(key: string): PartSearchResult | null {
    const hit = this.searches.get(key)
    if (!hit) return null
    if (!this.fresh(hit.at)) {
      this.searches.delete(key)
      return null
    }
    return hit.result
  }

  /** Facets travel with the result they describe — they are a property of that
   *  narrowing, not of the keyword. */
  putSearch(key: string, result: PartSearchResult): void {
    this.searches.set(key, { at: this.now(), result })
    for (const part of result.parts) this.put(part)
  }

  /** Held record count, for tests. Deliberately not a serializer. */
  size(): number {
    return this.records.size
  }
}
