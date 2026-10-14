/**
 * Universal search: many distributors' listings → one row per physical part.
 *
 * The entity model everyone converges on (Altium's Manufacturer Part Search,
 * Octopart/Nexar's `offers`): **the manufacturer part is the thing, and who sells
 * it is an attribute of it**.
 *
 * It is also what the API terms require. Both forbid aggregating their data with
 * a competitor's "without distinction", so a merged listing — one row
 * whose price came from whichever distributor happened to be cheapest — is out.
 * Grouping keeps every distributor's numbers in their own attributed row, which
 * is both the compliant shape and the more useful one: prices carry different
 * minimum quantities and packaging, so a single "cheapest" figure would hide
 * more than it tells you.
 *
 * Pure and unit-tested. The matching rules below are the whole risk surface — a
 * key that is too loose merges two different components into one row, and one
 * that is too strict shows the same part twice.
 */
import type { PartLifecycle, PartRecord, PartsProviderId } from '../preload/partsTypes'

/** One distributor's listing of a part, inside a group. */
export interface PartGroupSource {
  provider: PartsProviderId
  /** The record as that provider reported it — never blended with another's. */
  record: PartRecord
}

/** One physical part, with every connected distributor that stocks it. */
export interface PartGroup {
  /** Stable across a result set; `provider:partId` of the first source. */
  key: string
  mpn: string
  manufacturer: string
  description: string
  datasheetUrl: string | null
  /** Every distributor's link, in source order — one manufacturer's page can
   *  refuse a plain request where another distributor's own copy does not. */
  datasheetUrls: { provider: PartsProviderId; url: string }[]
  photoUrl: string | null
  lifecycle: PartLifecycle
  rohs: string | null
  sources: PartGroupSource[]
}

/**
 * Manufacturer part numbers are printed on parts and typed by humans, so the
 * same part arrives spaced, cased and punctuated differently between catalogs.
 * Case and whitespace are always noise. **Hyphens are not** — `LM358-N` and
 * `LM358N` can be different orderable parts — so they are kept.
 */
export const normalizeMpn = (mpn: string): string => mpn.trim().toUpperCase().replace(/\s+/g, '')

/**
 * Manufacturer names vary far more than part numbers do ("Texas Instruments" vs
 * "Texas Instruments Inc."), and unlike an MPN the differences are never
 * meaningful. Corporate suffixes and punctuation go; the rest is compared as
 * letters and digits.
 */
export const normalizeManufacturer = (name: string): string =>
  name
    .toUpperCase()
    .replace(/\b(INC|INCORPORATED|CORP|CORPORATION|CO|LTD|LIMITED|LLC|GMBH|SA|AG|BV|PLC)\b/g, '')
    .replace(/[^A-Z0-9]/g, '')

/**
 * The grouping key. Manufacturer is part of it deliberately: generic part
 * numbers genuinely collide across makers (any number of vendors sell an
 * `LM358`), and merging those would present two different components as one.
 * A record with no manufacturer groups on its MPN alone rather than being
 * dropped — it is still a real listing, and a missing field is the provider's
 * gap, not the user's.
 */
export const groupKey = (record: PartRecord): string =>
  `${normalizeMpn(record.mpn)}|${normalizeManufacturer(record.manufacturer)}`

/** Prefer a non-empty value, in source order — the first provider that knew. */
const firstNonEmpty = <T>(values: readonly T[], empty: (value: T) => boolean): T | null => {
  for (const value of values) if (!empty(value)) return value
  return null
}

/**
 * Merge per-provider records into one row per part.
 *
 * **Shared fields are picked, never blended.** Description, datasheet and photo
 * come from whichever provider actually supplied one, in the order given — never
 * concatenated or averaged, both because it would be meaningless and because
 * modifying their content is prohibited. Anything commercial (price,
 * stock, order code) stays untouched inside its own source.
 *
 * Order is preserved: groups come out in the order their first record appeared,
 * so the provider the user searched first leads.
 */
export function groupParts(records: readonly PartRecord[]): PartGroup[] {
  const groups = new Map<string, PartGroup>()

  for (const record of records) {
    if (!record.mpn.trim()) continue
    const key = groupKey(record)
    const existing = groups.get(key)
    if (existing) {
      // A provider returning the same part twice in one result set is its own
      // pagination artifact, not a second seller.
      if (existing.sources.some((source) => source.provider === record.provider)) continue
      existing.sources.push({ provider: record.provider, record })
      continue
    }
    groups.set(key, {
      key: `${record.provider}:${record.providerPartId}`,
      mpn: record.mpn,
      manufacturer: record.manufacturer,
      description: record.description,
      datasheetUrl: record.datasheetUrl,
      datasheetUrls: [],
      photoUrl: record.photoUrl,
      lifecycle: record.lifecycle,
      rohs: record.rohs,
      sources: [{ provider: record.provider, record }]
    })
  }

  // Fill the shared fields from whichever source knew them. Done after the walk
  // so a later provider can supply what the first one left blank.
  for (const group of groups.values()) {
    const records = group.sources.map((source) => source.record)
    group.description =
      firstNonEmpty(
        records.map((r) => r.description),
        (value) => !value
      ) ?? ''
    group.datasheetUrl = firstNonEmpty(
      records.map((r) => r.datasheetUrl),
      (value) => value === null
    )
    group.datasheetUrls = group.sources.flatMap((source) =>
      source.record.datasheetUrl
        ? [{ provider: source.provider, url: source.record.datasheetUrl }]
        : []
    )
    group.photoUrl = firstNonEmpty(
      records.map((r) => r.photoUrl),
      (value) => value === null
    )
    group.rohs = firstNonEmpty(
      records.map((r) => r.rohs),
      (value) => value === null
    )
    // Lifecycle is the one field where disagreement matters and the safe answer
    // is the pessimistic one: if any distributor says obsolete, the buyer needs
    // to see obsolete, not the other one's cheerier "active".
    group.lifecycle = worstLifecycle(records.map((r) => r.lifecycle))
  }

  return [...groups.values()]
}

const LIFECYCLE_SEVERITY: Record<PartLifecycle, number> = {
  obsolete: 3,
  nrnd: 2,
  active: 1,
  unknown: 0
}

/** The most cautionary status any source reported. `unknown` loses to a real
 *  answer — one provider not knowing is not evidence of anything. */
export const worstLifecycle = (values: readonly PartLifecycle[]): PartLifecycle => {
  let worst: PartLifecycle = 'unknown'
  for (const value of values) {
    if (LIFECYCLE_SEVERITY[value] > LIFECYCLE_SEVERITY[worst]) worst = value
  }
  return worst
}
