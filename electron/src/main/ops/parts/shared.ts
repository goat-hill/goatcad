/**
 * What every parts operation needs: capabilities, quota, remedies, and the
 * category vocabulary that makes the browse handshake enforceable.
 *
 * Two rules shape every answer here.
 *
 * **A failure is a typed kind, never an opaque message** — the same
 * `PartsErrorKind` the renderer already translates, carried as `kind` alongside
 * the eight-way `code`. An agent that cannot tell "your key is invalid" from
 * "you are out of quota until midnight" retries the one it should not.
 *
 * **Every answer carries the remaining quota**, successes included. An agent
 * that knows it has twelve calls left behaves differently from one that does
 * not, and the difference is whether the user's day survives.
 */
import type {
  PartCategory,
  PartRecord,
  PartsError,
  PartsErrorKind,
  PartsFilterState,
  PartsProviderId,
  PartSearchResult,
  PartsSortField,
  PartsUsage
} from '../../../preload/partsTypes'
import { emptyFilterState, PROVIDER_INFO } from '../../partsProviders'
import type { OpContext } from '../context'
import { fail, refused, type OpErrorCode, type OpOutcome } from '../errors'
import { s } from '../schema'

/**
 * What each catalog can actually do.
 *
 * A tool response rather than documentation, because a capability the model has
 * to recall is a capability it will get wrong — it will offer DigiKey's
 * parametric narrowing on Mouser, which has no categories and no facets at all.
 */
export const PROVIDER_CAPABILITIES: Record<
  PartsProviderId,
  {
    keywordSearch: boolean
    categoryBrowse: boolean
    parametricFilters: boolean
    stockFilter: boolean
    sort: boolean
    paging: boolean
  }
> = {
  digikey: {
    keywordSearch: true,
    categoryBrowse: true,
    parametricFilters: true,
    stockFilter: true,
    sort: true,
    paging: true
  },
  mouser: {
    keywordSearch: true,
    categoryBrowse: false,
    parametricFilters: false,
    stockFilter: true,
    sort: false,
    paging: true
  }
}

/** The quota block every answer carries. */
export const quotaSummary = (
  usage: PartsUsage[]
): Array<{
  provider: PartsProviderId
  minuteRemaining: number
  dayRemaining: number
  resetsAt: number
}> =>
  usage.map((entry) => ({
    provider: entry.provider,
    minuteRemaining: Math.max(0, entry.minute.limit - entry.minute.used),
    dayRemaining: Math.max(0, entry.day.limit - entry.day.used),
    resetsAt: entry.day.resetsAt
  }))

/**
 * The one-line remedy for a failure kind.
 *
 * Written for a reader who cannot see the app, and specific where being vague
 * would send them to the wrong place: `forbidden` is nearly always a DigiKey
 * app without Product Information V4 ticked, which "check your key" would send
 * someone to re-paste a key that was never the problem.
 */
export const REMEDY: Record<PartsErrorKind, string> = {
  'no-credentials':
    'No distributor API key is installed. Ask the user to add one in Settings ▸ Distributor APIs (parts_open_settings opens it); DigiKey and Mouser keys are free.',
  'invalid-credentials':
    'The key was rejected. Do not retry; ask the user to re-enter it in Settings ▸ Distributor APIs.',
  forbidden:
    "The key is valid but this API is not enabled for it. For DigiKey, ask the user to tick 'Product Information V4' in the app's Production products list.",
  'rate-limited': 'Per-minute limit reached. Wait and retry once.',
  'quota-exhausted':
    'The daily quota is spent until resetsAt. Stop searching and report what you found.',
  network: 'Could not reach the distributor. Retry once, then report it.',
  timeout: 'The distributor did not answer in time. Retry once with a narrower query.',
  'provider-error': 'The distributor reported an error. Report it verbatim.',
  'bad-response':
    "The distributor's answer did not parse, a GoatCAD fault. Report it; do not retry.",
  'storage-unavailable':
    'The OS keyring refused to encrypt, so the key was not saved. Tell the user so.'
}

/**
 * Which of the eight codes a distributor failure is.
 *
 * Most are `refused`: the call could not be served and the `kind` says why. The
 * two exceptions are the ones where the code carries real information a client
 * would otherwise have to infer — a timeout is retryable, and an answer we
 * could not parse is our gap, not the user's.
 */
const PARTS_CODE: Partial<Record<PartsErrorKind, OpErrorCode>> = {
  timeout: 'timeout',
  'bad-response': 'internal'
}

/** A distributor failure, with its remedy and the quota that survives it. */
export const distributorFailure = (
  ctx: OpContext,
  kind: PartsErrorKind,
  detail?: string
): OpOutcome =>
  fail({
    code: PARTS_CODE[kind] ?? 'refused',
    kind,
    message: detail ?? REMEDY[kind],
    fix: REMEDY[kind],
    data: { detail: detail ?? null, quota: quotaSummary(ctx.parts.usage()) }
  })

/** The keys a part row answers besides `mpn`, which is always kept. A
 *  dotted name is one key of each offer. */
export const PART_COLUMNS = [
  'manufacturer',
  'description',
  'lifecycle',
  'rohs',
  'datasheetUrl',
  'productUrl',
  'parameters',
  'offers',
  'offers.distributorPartNumber',
  'offers.packaging',
  'offers.moq',
  'offers.stock',
  'offers.currency',
  'offers.priceAtQty',
  'offers.priceBreaks'
] as const
export type PartColumn = (typeof PART_COLUMNS)[number]

/** The `columns` argument every op answering part rows takes. */
export const partColumnsArg = s
  .array(s.enum(PART_COLUMNS))
  .min(1)
  .describe(
    'Keys each row answers; default all. mpn is always kept. "offers" keeps whole offers, "offers.stock" one key of each.'
  )
  .optional()

interface PartOfferRow {
  distributorPartNumber: string
  packaging: string | null
  moq: number | null
  stock: number | null
  currency: string
  priceAtQty: { quantity: number; unitPrice: number } | null
  priceBreaks: { quantity: number; unitPrice: number }[]
}

/**
 * One distributor product as the agent ops answer it, narrowed to `columns`
 * when given. Every offer the distributor lists stays, in its order: a DigiKey
 * product's packaging variations, a Mouser part's one listing.
 */
export const partRow = (
  record: PartRecord,
  qty: number,
  columns?: readonly PartColumn[]
): Record<string, unknown> => {
  const offers: PartOfferRow[] = record.offers.map((offer) => ({
    distributorPartNumber: offer.distributorPartNumber,
    packaging: offer.packaging,
    moq: offer.moq,
    stock: offer.stock,
    currency: offer.currency,
    priceAtQty: priceAtQuantity(offer.priceBreaks, qty),
    priceBreaks: offer.priceBreaks
  }))
  const row: Record<string, unknown> = {
    mpn: record.mpn,
    manufacturer: record.manufacturer,
    description: record.description,
    lifecycle: record.lifecycle,
    rohs: record.rohs,
    datasheetUrl: record.datasheetUrl,
    productUrl: record.productUrl ?? record.offers[0]?.productUrl ?? null,
    parameters: record.parameters.map((parameter) => ({
      name: parameter.name,
      value: parameter.value
    })),
    offers
  }
  if (!columns) return row

  const out: Record<string, unknown> = { mpn: row.mpn }
  for (const column of columns) {
    if (!column.startsWith('offers')) out[column] = row[column]
  }
  const offerKeys = columns
    .filter((column) => column.startsWith('offers.'))
    .map((column) => column.slice('offers.'.length) as keyof PartOfferRow)
  if (columns.includes('offers')) out.offers = offers
  else if (offerKeys.length) {
    out.offers = offers.map((offer) =>
      Object.fromEntries(offerKeys.map((key) => [key, offer[key]]))
    )
  }
  return out
}

/** Rows asked of each distributor for one MPN: the maximum, since the call
 *  costs the same and an exact match can rank below longer part numbers. */
const MPN_LOOKUP_ROWS = 50

/** One distributor's answer for an exact MPN. */
export interface MpnListing {
  provider: PartsProviderId
  /** Set when the distributor was asked and failed. */
  error: PartsError | null
  /** Its rows whose MPN equals the one asked, ignoring case, in its order. */
  rows: PartRecord[]
}

/** Each connected distributor's rows for an exact MPN, in registry order. A
 *  cached search costs no quota, so callers share one lookup per MPN. */
export const listingsForMpn = async (ctx: OpContext, mpn: string): Promise<MpnListing[]> => {
  const wanted = mpn.toLowerCase()
  const configured = ctx.parts
    .credentialStatus()
    .filter((status) => status.configured)
    .map((status) => status.provider)
  return Promise.all(
    configured.map(async (provider): Promise<MpnListing> => {
      const result = await ctx.parts.search(provider, mpn, MPN_LOOKUP_ROWS)
      if (!result.ok) return { provider, error: result.error, rows: [] }
      const rows = result.value.parts.filter((record) => record.mpn.toLowerCase() === wanted)
      return { provider, error: null, rows }
    })
  )
}

/** Rows whose manufacturer is the one named, as a distributor spells it,
 *  ignoring case; every row when none is named. */
export const byManufacturer = (
  rows: readonly PartRecord[],
  manufacturer: string | undefined
): PartRecord[] => {
  if (!manufacturer) return [...rows]
  const wanted = manufacturer.toLowerCase()
  return rows.filter((record) => record.manufacturer.toLowerCase() === wanted)
}

/** The distinct manufacturer names of some rows, ignoring case, first spelling kept. */
export const manufacturersOf = (rows: readonly PartRecord[]): string[] => {
  const seen = new Map<string, string>()
  for (const record of rows) {
    const key = record.manufacturer.toLowerCase()
    if (!seen.has(key)) seen.set(key, record.manufacturer)
  }
  return [...seen.values()]
}

/** No key for `provider`, or for any distributor when none is named, refused before any call. */
export const noCredentials = (
  ctx: OpContext,
  provider?: PartsProviderId,
  message = provider
    ? `No ${PROVIDER_INFO[provider].name} key is installed.`
    : REMEDY['no-credentials'],
  fix = REMEDY['no-credentials']
): OpOutcome =>
  refused(message, fix, {
    kind: 'no-credentials',
    data: { ...(provider ? { provider } : {}), quota: quotaSummary(ctx.parts.usage()) }
  })

/** The unit price at a build quantity: the highest break at or below it. Price
 *  breaks arrive ascending, but this does not assume that. */
export const priceAtQuantity = (
  breaks: Array<{ quantity: number; unitPrice: number }>,
  qty: number
): { quantity: number; unitPrice: number } | null => {
  let best: { quantity: number; unitPrice: number } | null = null
  for (const entry of breaks) {
    if (entry.quantity > qty) continue
    if (!best || entry.quantity > best.quantity) best = entry
  }
  // Below the smallest break there is no price *at* this quantity; report the
  // smallest one rather than null, since "no price" reads as "not for sale".
  if (!best && breaks.length > 0) {
    best = breaks.reduce((low, entry) => (entry.quantity < low.quantity ? entry : low))
  }
  return best
}

// ------------------------------------------------------------------ browse path

/**
 * The parameter vocabulary a category actually has, remembered from the last
 * `parts_list_filters` for it.
 *
 * Memory only and never written to disk, exactly like the search cache
 * (`partsCache.ts`). It exists to make the
 * `parts_list_filters` → `parts_search_category` handshake **enforceable** rather than
 * merely documented: a filter the distributor never offered is rejected here,
 * instead of being dropped at the API and returning a broader result set that
 * looks like a successful narrow. That silent widening is the failure most
 * likely to end in a wrong recommendation, and it is invisible from the outside.
 */
const categoryVocabulary = new Map<
  number,
  { parameters: Map<number, Set<string>>; names: Map<number, string> }
>()

/** Test seam — the map is process-global, which two tests in a row would share. */
export const resetCategoryVocabulary = (): void => categoryVocabulary.clear()

export const rememberVocabulary = (categoryId: number, result: PartSearchResult): void => {
  const parameters = new Map<number, Set<string>>()
  const names = new Map<number, string>()
  for (const facet of result.facets.parametric) {
    parameters.set(facet.parameterId, new Set(facet.values.map((value) => value.id)))
    names.set(facet.parameterId, facet.name)
  }
  categoryVocabulary.set(categoryId, { parameters, names })
}

/** DigiKey is the only catalog with categories or facets; Mouser's API has
 *  neither, so its mode is lookup rather than discovery. */
export const BROWSE_PROVIDER: PartsProviderId = 'digikey'

export const requireBrowseProvider = (ctx: OpContext): OpOutcome | null => {
  const status = ctx.parts.credentialStatus().find((entry) => entry.provider === BROWSE_PROVIDER)
  if (status?.configured) return null
  const name = PROVIDER_INFO[BROWSE_PROVIDER].name
  return noCredentials(
    ctx,
    BROWSE_PROVIDER,
    `Category browsing and parametric filtering are ${name}-only, and no ${name} key is installed.`,
    `${REMEDY['no-credentials']} Meanwhile parts_search works by keyword or part number.`
  )
}

/** Flatten one level: the tree arrives whole, and an agent wants the children of
 *  where it is standing, not eighty thousand nodes. */
export const findCategory = (nodes: PartCategory[], id: number): PartCategory | null => {
  for (const node of nodes) {
    if (node.id === id) return node
    const hit = findCategory(node.children, id)
    if (hit) return hit
  }
  return null
}

export const SORT_FIELDS: PartsSortField[] = [
  'Price',
  'QuantityAvailable',
  'Manufacturer',
  'ManufacturerProductNumber',
  'ProductStatus',
  'Packaging',
  'Supplier'
]

/** The narrowing an agent may ask for, as the schema now types it. */
export interface FilterArgs {
  inStock?: boolean
  rohs?: boolean
  hasDatasheet?: boolean
  has3dModel?: boolean
  manufacturerIds?: string[]
  packagingIds?: string[]
  statusIds?: string[]
  seriesIds?: string[]
  parameters?: Record<string, string[]>
}

/**
 * Turn the agent's filter object into distributor state, rejecting anything the
 * category did not offer.
 *
 * The shape is now guaranteed by the schema, so what is left here is the part
 * no schema can check: whether these ids are ones `parts_list_filters` actually handed
 * out for this category.
 */
export const buildFilters = (
  raw: FilterArgs | undefined,
  categoryId: number
): { ok: true; filters: PartsFilterState } | { ok: false; reason: string } => {
  const filters = emptyFilterState()
  if (raw === undefined) return { ok: true, filters }

  filters.inStock = raw.inStock === true
  filters.rohs = raw.rohs === true
  filters.hasDatasheet = raw.hasDatasheet === true
  filters.has3dModel = raw.has3dModel === true

  filters.manufacturerIds = raw.manufacturerIds ?? []
  filters.packagingIds = raw.packagingIds ?? []
  filters.statusIds = raw.statusIds ?? []
  filters.seriesIds = raw.seriesIds ?? []

  const parameters = raw.parameters
  if (parameters) {
    const known = categoryVocabulary.get(categoryId)
    if (!known) {
      return {
        ok: false,
        reason: `Call parts_list_filters(${categoryId}) before filtering by parameter; parameter and value ids come from it.`
      }
    }
    for (const [key, values] of Object.entries(parameters)) {
      const parameterId = Number(key)
      if (!Number.isInteger(parameterId)) {
        return {
          ok: false,
          reason: `Parameter key "${key}" is not a parameter id. Use the numeric parameterId from parts_list_filters.`
        }
      }
      const allowed = known.parameters.get(parameterId)
      if (!allowed) {
        return {
          ok: false,
          reason: `Category ${categoryId} has no parameter ${parameterId}. Call parts_list_filters(${categoryId}) and use the parameterIds it returns.`
        }
      }
      if (values.length === 0) {
        return {
          ok: false,
          reason: `Parameter ${parameterId} was given no values. Pass an array of valueId strings from parts_list_filters.`
        }
      }
      const unknownValue = values.find((entry) => !allowed.has(entry))
      if (unknownValue !== undefined) {
        return {
          ok: false,
          // Naming the parameter, not just its id, is what makes this
          // actionable to a reader who cannot see the last response.
          reason: `"${unknownValue}" is not a value of ${known.names.get(parameterId) ?? `parameter ${parameterId}`}. Pass valueIds exactly as parts_list_filters returned them.`
        }
      }
      filters.parameters[parameterId] = values
    }
  }

  return { ok: true, filters }
}
