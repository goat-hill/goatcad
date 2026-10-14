/**
 * The `parts:*` channels — a thin, validating skin over `PartsService`.
 *
 * Separate from `parts.ts` so the service stays Electron-free and unit-testable
 * (the `libraryIndex.ts` / `libraryIndex*.ts` split, same reason). Everything
 * here is either validation of renderer input or Electron plumbing.
 *
 * **Nothing on this surface can read a credential back.** There is deliberately
 * no `parts:get-credentials`; the renderer writes secrets one way and reads only
 * a `PartsCredentialStatus`. Adding a getter here would undo the whole point of
 * keeping the store in main.
 */
import { outboundFetch } from './outboundFetch'
import { join } from 'path'
import { app, BrowserWindow, ipcMain, safeStorage, shell } from 'electron'
import type {
  PartsCredentialStatus,
  PartsFilterState,
  PartsSort,
  PartsSortField,
  PartsProviderId,
  PartsProviderInfo,
  PartsUsage
} from '../preload/partsTypes'
import { PartsService } from './parts'
import type { ProviderCredentials } from './partsCredentials'
import { emptyFacets, PROVIDER_IDS, PROVIDER_INFO } from './partsProviders'
import { loadDevCredentials } from './partsDevCredentials'

let service: PartsService | null = null

/** Lazy: `safeStorage` is only meaningful after app ready, and a user who never
 *  opens the panel should not pay for the cache read. */
const parts = (): PartsService => {
  if (!service) {
    service = new PartsService(
      app.getPath('userData'),
      safeStorage,
      outboundFetch,
      // Unpackaged only, so a shipped build behaves as if this did not exist.
      loadDevCredentials(
        // The harness launches `out/main/index.js`, so `getAppPath()` lands
        // under `out/`; `cwd` is the project there. Both are tried.
        [process.cwd(), app.getAppPath(), join(app.getAppPath(), '..')],
        app.isPackaged
      )
    )
  }
  return service
}

export const flushParts = (): void => service?.flush()

/** The one service instance, for the other surfaces that speak to it — today
 *  the MCP server (`partsMcpIpc.ts`). Deliberately the same object the IPC
 *  handlers use: one credential store, one rate limiter, one cache, whether the
 *  caller is a window or an agent. */
export const partsService = (): PartsService => parts()

const isProviderId = (value: unknown): value is PartsProviderId =>
  typeof value === 'string' && (PROVIDER_IDS as string[]).includes(value)

/**
 * Tell every window a key was added, replaced or removed — the `config:changed`
 * pattern, for the same two reasons. Two windows share one credential store, and
 * within a single window the Part Search panel and the Settings tab are separate
 * surfaces: someone adds a key in Settings and the panel behind it would
 * otherwise still be showing its "connect a distributor" card.
 */
const broadcastCredentialsChanged = (): void => {
  const statuses = parts().credentialStatus()
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.webContents.isDestroyed()) win.webContents.send('parts:credentials-changed', statuses)
  }
}

/**
 * Coerce a credentials object from the renderer to exactly the fields the
 * provider declares. A renderer is not trusted to send a well-shaped object, and
 * an unbounded pass-through would let anything at all be written into the
 * encrypted blob.
 */
const sanitizeCredentials = (
  provider: PartsProviderId,
  raw: unknown
): ProviderCredentials | null => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const source = raw as Record<string, unknown>
  const result: ProviderCredentials = {}
  for (const field of PROVIDER_INFO[provider].fields) {
    const value = source[field.key]
    if (typeof value !== 'string' || !value.trim()) return null
    result[field.key] = value.trim()
  }
  return result
}

/**
 * The one rule for handing a URL to the OS: **https only**.
 *
 * `shell.openExternal` will happily launch a `file://` path or a registered
 * custom scheme, which is a live code-execution path from whatever a provider
 * put in a JSON field. A host allowlist is not workable — a datasheet legitimately
 * lives on any manufacturer's domain — so the scheme is the guard that actually
 * holds, and it is enough to close that path.
 */
const openExternalHttps = async (raw: unknown): Promise<boolean> => {
  if (typeof raw !== 'string') return false
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol !== 'https:') return false
  await shell.openExternal(url.toString())
  return true
}

/** Product thumbnails are small and re-requested on every re-render; this keeps
 *  a scroll from re-fetching. Memory only, and bounded so a long session cannot
 *  grow it without limit. */
const imageCache = new Map<string, string>()
const MAX_CACHED_IMAGES = 200
/** A product thumbnail that is not a thumbnail is not something we render. */
const MAX_IMAGE_BYTES = 2 * 1024 * 1024

const fetchImage = async (url: unknown): Promise<string | null> => {
  if (typeof url !== 'string') return null
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:') return null

  const cached = imageCache.get(url)
  if (cached) return cached

  try {
    const response = await outboundFetch(url, { signal: AbortSignal.timeout(10_000) })
    if (!response.ok) return null
    const type = response.headers.get('content-type') ?? ''
    // Never turn an HTML error page into an <img> src.
    if (!type.startsWith('image/')) return null
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.byteLength > MAX_IMAGE_BYTES) return null

    const dataUrl = `data:${type.split(';')[0]};base64,${buffer.toString('base64')}`
    // Crude eviction: a thumbnail cache does not warrant an LRU, and the bound
    // is what matters. Oldest insertion goes first.
    if (imageCache.size >= MAX_CACHED_IMAGES) {
      const oldest = imageCache.keys().next().value
      if (oldest !== undefined) imageCache.delete(oldest)
    }
    imageCache.set(url, dataUrl)
    return dataUrl
  } catch {
    // A missing photo is a cosmetic gap, never a failed search.
    return null
  }
}

/**
 * A sort from the renderer, allowlisted against the fields DigiKey actually
 * accepts. Anything else becomes "no sort" rather than travelling on: these are
 * enum members, so a wrong one costs a call to earn a 400.
 */
const SORT_FIELDS: PartsSortField[] = [
  'Price',
  'QuantityAvailable',
  'Manufacturer',
  'ManufacturerProductNumber',
  'ProductStatus',
  'Packaging',
  'Supplier'
]

const sanitizeSort = (raw: unknown): PartsSort | null => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const source = raw as Record<string, unknown>
  const field = SORT_FIELDS.find((candidate) => candidate === source.field)
  if (!field) return null
  return { field, order: source.order === 'desc' ? 'desc' : 'asc' }
}

/** Coerce a filter object from the renderer to exactly the shape a provider will
 *  read. Unknown keys are dropped rather than forwarded into an API request. */
const sanitizeFilters = (raw: unknown): PartsFilterState | undefined => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const source = raw as Record<string, unknown>
  const flag = (key: string): boolean => source[key] === true
  const idList = (key: string): string[] =>
    Array.isArray(source[key])
      ? (source[key] as unknown[]).filter((id): id is string => typeof id === 'string')
      : []

  const parameters: Record<number, string[]> = {}
  const rawParameters = source.parameters
  if (typeof rawParameters === 'object' && rawParameters !== null) {
    for (const [key, values] of Object.entries(rawParameters as Record<string, unknown>)) {
      const parameterId = Number(key)
      if (!Number.isInteger(parameterId) || !Array.isArray(values)) continue
      const ids = values.filter((id): id is string => typeof id === 'string')
      if (ids.length) parameters[parameterId] = ids
    }
  }

  return {
    inStock: flag('inStock'),
    rohs: flag('rohs'),
    hasDatasheet: flag('hasDatasheet'),
    has3dModel: flag('has3dModel'),
    manufacturerIds: idList('manufacturerIds'),
    packagingIds: idList('packagingIds'),
    statusIds: idList('statusIds'),
    seriesIds: idList('seriesIds'),
    parameters
  }
}

export function registerPartsIpc(): void {
  ipcMain.handle('parts:providers', (): PartsProviderInfo[] =>
    PROVIDER_IDS.map((id) => PROVIDER_INFO[id])
  )

  ipcMain.handle('parts:credential-status', (): PartsCredentialStatus[] =>
    parts().credentialStatus()
  )

  ipcMain.handle('parts:usage', (): PartsUsage[] => parts().usage())

  ipcMain.handle('parts:set-credentials', (_event, provider: unknown, credentials: unknown) => {
    if (!isProviderId(provider)) return { ok: false, error: { kind: 'provider-error' } }
    const sanitized = sanitizeCredentials(provider, credentials)
    if (!sanitized) return { ok: false, error: { kind: 'no-credentials' } }
    const result = parts().setCredentials(provider, sanitized)
    if (result.ok) broadcastCredentialsChanged()
    return result
  })

  ipcMain.handle('parts:remove-credentials', (_event, provider: unknown) => {
    if (!isProviderId(provider)) return null
    const status = parts().removeCredentials(provider)
    broadcastCredentialsChanged()
    return status
  })

  ipcMain.handle('parts:test-credentials', async (_event, provider: unknown) => {
    if (!isProviderId(provider)) return { ok: false, error: { kind: 'provider-error' } }
    return parts().verify(provider)
  })

  ipcMain.handle(
    'parts:search',
    async (
      _event,
      provider: unknown,
      keyword: unknown,
      limit: unknown,
      offset: unknown,
      categoryId: unknown,
      filters: unknown,
      sort: unknown
    ) => {
      if (!isProviderId(provider)) return { ok: false, error: { kind: 'provider-error' } }
      if (typeof keyword !== 'string') {
        return { ok: true, value: { parts: [], total: 0, facets: emptyFacets() } }
      }
      return parts().search(
        provider,
        keyword,
        typeof limit === 'number' ? limit : undefined,
        typeof offset === 'number' ? offset : 0,
        typeof categoryId === 'number' ? categoryId : undefined,
        sanitizeFilters(filters),
        sanitizeSort(sort)
      )
    }
  )

  /** A distributor's category tree. One call per session — see PartsService. */
  ipcMain.handle('parts:categories', async (_event, provider: unknown) => {
    if (!isProviderId(provider)) return { ok: false, error: { kind: 'provider-error' } }
    return parts().categories(provider)
  })

  /** Universal search across every configured distributor. */
  ipcMain.handle(
    'parts:search-all',
    async (_event, keyword: unknown, limit: unknown, filters: unknown) => {
      if (typeof keyword !== 'string') return { groups: [], facets: emptyFacets(), providers: [] }
      return parts().searchAll(
        keyword,
        typeof limit === 'number' ? limit : undefined,
        sanitizeFilters(filters)
      )
    }
  )

  /**
   * Product photos, fetched here rather than by the renderer.
   *
   * Both agreements permit displaying a product image and permit proportional
   * resizing, but not storing it — so this returns a `data:` URL held in
   * memory and never touches disk. Main also keeps the renderer's CSP as it is:
   * `img-src 'self' data:` already covers a data URL, where pointing an `<img>`
   * at a distributor CDN would mean widening it to remote hosts and loading
   * third-party content into an app window (RULES.md §9).
   */
  ipcMain.handle('parts:image', async (_event, url: unknown): Promise<string | null> =>
    fetchImage(url)
  )

  ipcMain.handle('parts:detail', (_event, provider: unknown, partId: unknown) => {
    if (!isProviderId(provider) || typeof partId !== 'string') return null
    return parts().detail(provider, partId)
  })

  ipcMain.handle('parts:cad', async (_event, provider: unknown, partId: unknown) => {
    if (!isProviderId(provider) || typeof partId !== 'string') {
      return { ok: false, error: { kind: 'provider-error' } }
    }
    return parts().cad(provider, partId)
  })

  /**
   * Open a provider's own key-registration page. The app **never** creates an
   * account or submits anything — this opens a browser and stops. The URL comes
   * from our own registry rather than from the renderer, so this channel cannot
   * be used to open something else.
   */
  ipcMain.handle('parts:open-registration', async (_event, provider: unknown): Promise<boolean> => {
    if (!isProviderId(provider)) return false
    return openExternalHttps(PROVIDER_INFO[provider].registrationUrl)
  })

  /** Datasheet / product / EDA-model links, which legitimately point anywhere. */
  ipcMain.handle('parts:open-external', async (_event, url: unknown): Promise<boolean> =>
    openExternalHttps(url)
  )
}
