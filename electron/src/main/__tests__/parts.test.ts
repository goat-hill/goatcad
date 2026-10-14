import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import { join } from 'path'
import { PartsService, REQUEST_TIMEOUT_MS } from '../parts'
import type { SecretCipher } from '../partsCredentials'

const cipher: SecretCipher = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(plain, 'utf8'),
  decryptString: (buf) => buf.toString('utf8')
}

const EMPTY_FACETS = { manufacturers: [], packaging: [], status: [], series: [], parametric: [] }

const EMPTY_FILTERS = {
  inStock: false,
  rohs: false,
  hasDatasheet: false,
  has3dModel: false,
  manufacturerIds: [],
  packagingIds: [],
  statusIds: [],
  seriesIds: [],
  parameters: {}
}

const mouserPayload = (mpn: string): unknown => ({
  Errors: [],
  SearchResults: {
    NumberOfResult: 1,
    Parts: [{ ManufacturerPartNumber: mpn, MouserPartNumber: `511-${mpn}`, Manufacturer: 'ST' }]
  }
})

/** A fetch stub that records every call, so "did this touch the network" is a
 *  assertion rather than a guess. */
const stubFetch = (
  handler: (url: string) => { status?: number; body: unknown }
): { fetch: typeof globalThis.fetch; calls: string[] } => {
  const calls: string[] = []
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString()
    calls.push(url)
    const { status = 200, body } = handler(url)
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' }
    })
  }) as typeof globalThis.fetch
  return { fetch: fetchImpl, calls }
}

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(join(os.tmpdir(), 'goatcad-parts-svc-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('PartsService without credentials', () => {
  it('refuses before touching the network', async () => {
    const { fetch, calls } = stubFetch(() => ({ body: {} }))
    const service = new PartsService(dir, cipher, fetch)

    const result = await service.search('mouser', 'esp32')
    expect(result).toEqual({ ok: false, error: { kind: 'no-credentials' } })
    expect(calls).toEqual([])
  })

  it('reports an empty query as an empty result, not an error', async () => {
    const { fetch, calls } = stubFetch(() => ({ body: {} }))
    const service = new PartsService(dir, cipher, fetch)

    expect(await service.search('mouser', '   ')).toEqual({
      ok: true,
      value: { parts: [], total: 0, facets: EMPTY_FACETS }
    })
    expect(calls).toEqual([])
  })
})

describe('PartsService search', () => {
  it('normalizes a provider payload into records', async () => {
    const { fetch } = stubFetch(() => ({ body: mouserPayload('STM32F103C8T6') }))
    const service = new PartsService(dir, cipher, fetch)
    service.setCredentials('mouser', { apiKey: 'key-12345678' })

    const result = await service.search('mouser', 'stm32')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.parts[0]).toMatchObject({ provider: 'mouser', mpn: 'STM32F103C8T6' })
  })

  it('serves a repeated search from cache without spending a call', async () => {
    const { fetch, calls } = stubFetch(() => ({ body: mouserPayload('R-1') }))
    const service = new PartsService(dir, cipher, fetch)
    service.setCredentials('mouser', { apiKey: 'key-12345678' })

    await service.search('mouser', 'resistor')
    await service.search('mouser', '  RESISTOR ') // same query, different spelling
    expect(calls).toHaveLength(1)
    // Cache before quota is the point: the second search cost nothing at all.
    expect(service.usage().find((u) => u.provider === 'mouser')?.day.used).toBe(1)
  })

  it('makes searched parts individually addressable afterwards', async () => {
    const { fetch } = stubFetch(() => ({ body: mouserPayload('R-1') }))
    const service = new PartsService(dir, cipher, fetch)
    service.setCredentials('mouser', { apiKey: 'key-12345678' })

    await service.search('mouser', 'resistor')
    expect(service.detail('mouser', '511-R-1')?.mpn).toBe('R-1')
    expect(service.detail('mouser', 'never-seen')).toBeNull()
  })

  it('charges quota for a failed call, because the provider counted it', async () => {
    const { fetch } = stubFetch(() => ({ status: 500, body: {} }))
    const service = new PartsService(dir, cipher, fetch)
    service.setCredentials('mouser', { apiKey: 'key-12345678' })

    const result = await service.search('mouser', 'resistor')
    expect(result).toMatchObject({ ok: false, error: { kind: 'provider-error' } })
    expect(service.usage().find((u) => u.provider === 'mouser')?.day.used).toBe(1)
  })

  it('reads a Mouser 200-with-Errors as a credential failure, not an empty result', async () => {
    const { fetch } = stubFetch(() => ({
      body: { Errors: [{ Code: 'InvalidApiKey', Message: 'Invalid API key' }] }
    }))
    const service = new PartsService(dir, cipher, fetch)
    service.setCredentials('mouser', { apiKey: 'key-12345678' })

    const result = await service.search('mouser', 'resistor')
    expect(result).toMatchObject({ ok: false, error: { kind: 'invalid-credentials' } })
  })

  it('never lets the key reach the renderer through an error detail', async () => {
    const { fetch } = stubFetch(() => {
      throw new Error('connect failed to ?apiKey=key-12345678')
    })
    const service = new PartsService(dir, cipher, fetch)
    service.setCredentials('mouser', { apiKey: 'key-12345678' })

    const result = await service.search('mouser', 'resistor')
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain('key-12345678')
  })
})

describe('PartsService credentials', () => {
  it('exposes a status with no way to read the secret back', async () => {
    const { fetch } = stubFetch(() => ({ body: mouserPayload('R-1') }))
    const service = new PartsService(dir, cipher, fetch)
    service.setCredentials('mouser', { apiKey: 'key-12345678' })

    const statuses = service.credentialStatus()
    expect(JSON.stringify(statuses)).not.toContain('key-12345678')
    expect(statuses.find((s) => s.provider === 'mouser')?.configured).toBe(true)
    expect(statuses.find((s) => s.provider === 'digikey')?.configured).toBe(false)
  })

  it('records a verification against the provider', async () => {
    const { fetch } = stubFetch(() => ({ body: mouserPayload('R-1') }))
    const service = new PartsService(dir, cipher, fetch)
    service.setCredentials('mouser', { apiKey: 'key-12345678' })

    const result = await service.verify('mouser')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.lastVerifiedAt).toBeTypeOf('number')
  })

  it('surfaces an unsubscribed product distinctly from a bad key', async () => {
    const { fetch } = stubFetch(() => ({ status: 403, body: {} }))
    const service = new PartsService(dir, cipher, fetch)
    service.setCredentials('mouser', { apiKey: 'key-12345678' })

    expect(await service.verify('mouser')).toMatchObject({
      ok: false,
      error: { kind: 'forbidden' }
    })
  })
})

describe('PartsService CAD', () => {
  it('answers "none" for a provider with no CAD lookup, without a call', async () => {
    const { fetch, calls } = stubFetch(() => ({ body: {} }))
    const service = new PartsService(dir, cipher, fetch)
    service.setCredentials('mouser', { apiKey: 'key-12345678' })

    expect(await service.cad('mouser', '511-R-1')).toEqual({ ok: true, value: { mode: 'none' } })
    expect(calls).toEqual([])
  })

  it('resolves a DigiKey EDA model link to a hand-off', async () => {
    const { fetch } = stubFetch((url) =>
      url.includes('oauth2/token')
        ? { body: { access_token: 'tok', expires_in: 600 } }
        : {
            body: {
              MediaLinks: [
                { MediaType: 'EDA Models', Title: 'by SnapEDA', Url: 'https://snapeda.com/x' }
              ]
            }
          }
    )
    const service = new PartsService(dir, cipher, fetch)
    service.setCredentials('digikey', { clientId: 'id-1234', clientSecret: 'secret-12345678' })

    expect(await service.cad('digikey', '497-6063-ND')).toEqual({
      ok: true,
      value: { mode: 'handoff', url: 'https://snapeda.com/x', title: 'by SnapEDA' }
    })
  })
})

describe('DigiKey token handling', () => {
  it('does not charge the token call against the catalog quota', async () => {
    const { fetch, calls } = stubFetch((url) =>
      url.includes('oauth2/token')
        ? { body: { access_token: 'tok', expires_in: 600 } }
        : { body: { Products: [{ ManufacturerProductNumber: 'X' }], ProductsCount: 1 } }
    )
    const service = new PartsService(dir, cipher, fetch)
    service.setCredentials('digikey', { clientId: 'id-1234', clientSecret: 'secret-12345678' })

    await service.search('digikey', 'stm32')
    expect(calls.filter((c) => c.includes('oauth2/token'))).toHaveLength(1)
    // Two HTTP calls, one metered request — the token endpoint is a different
    // product and is not counted with Product Information.
    expect(service.usage().find((u) => u.provider === 'digikey')?.day.used).toBe(1)
  })

  it('reuses the cached token across searches', async () => {
    const { fetch, calls } = stubFetch((url) =>
      url.includes('oauth2/token')
        ? { body: { access_token: 'tok', expires_in: 600 } }
        : { body: { Products: [{ ManufacturerProductNumber: 'X' }], ProductsCount: 1 } }
    )
    const service = new PartsService(dir, cipher, fetch)
    service.setCredentials('digikey', { clientId: 'id-1234', clientSecret: 'secret-12345678' })

    await service.search('digikey', 'stm32')
    await service.search('digikey', 'esp32')
    expect(calls.filter((c) => c.includes('oauth2/token'))).toHaveLength(1)
  })

  it('reads a rejected client secret as invalid credentials', async () => {
    const { fetch } = stubFetch(() => ({ status: 400, body: { error: 'invalid_client' } }))
    const service = new PartsService(dir, cipher, fetch)
    service.setCredentials('digikey', { clientId: 'id-1234', clientSecret: 'wrong-12345678' })

    expect(await service.search('digikey', 'stm32')).toMatchObject({
      ok: false,
      error: { kind: 'invalid-credentials' }
    })
  })

  it('reads ExactMatches when Products is empty, so a part-number search returns', async () => {
    const { fetch } = stubFetch((url) =>
      url.includes('oauth2/token')
        ? { body: { access_token: 'tok', expires_in: 600 } }
        : {
            body: {
              Products: [],
              ExactMatches: [{ ManufacturerProductNumber: 'STM32F103C8T6' }],
              ProductsCount: 1
            }
          }
    )
    const service = new PartsService(dir, cipher, fetch)
    service.setCredentials('digikey', { clientId: 'id-1234', clientSecret: 'secret-12345678' })

    const result = await service.search('digikey', 'STM32F103C8T6')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.parts[0].mpn).toBe('STM32F103C8T6')
  })
})

describe('a distributor that never answers', () => {
  // The bug this covers stranded the Settings card in a permanent "Saving…":
  // `fetch` has no default timeout, so a connection that is accepted and then
  // ignored leaves the promise pending for the life of the process, and every
  // await above it with it.
  const hangingFetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () =>
        reject(new DOMException('The operation was aborted.', 'AbortError'))
      )
    })) as typeof globalThis.fetch

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('gives up on its own deadline rather than hanging forever', async () => {
    const service = new PartsService(dir, cipher, hangingFetch)
    service.setCredentials('mouser', { apiKey: 'key-12345678' })

    const pending = service.search('mouser', 'resistor')
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 1)

    // Distinct from `network`: nothing refused us, the answer never came.
    expect(await pending).toEqual({ ok: false, error: { kind: 'timeout' } })
  })

  it('reports the timeout as a result, never as a rejection', async () => {
    // The renderer branches on `ok`; a rejected invoke would strand whatever
    // spinner was waiting on it, which is the failure mode being fixed.
    const service = new PartsService(dir, cipher, hangingFetch)
    service.setCredentials('mouser', { apiKey: 'key-12345678' })

    const pending = service.verify('mouser')
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 1)
    await expect(pending).resolves.toMatchObject({ ok: false })
  })

  it('still charges the attempt, since the request did leave', async () => {
    const service = new PartsService(dir, cipher, hangingFetch)
    service.setCredentials('mouser', { apiKey: 'key-12345678' })

    const pending = service.search('mouser', 'resistor')
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 1)
    await pending

    expect(service.usage().find((u) => u.provider === 'mouser')?.day.used).toBe(1)
  })
})

describe('filters reach the wire', () => {
  /** Captures each outgoing request body, so "did the filter actually go out?"
   *  is an assertion rather than an inference. */
  const recordingFetch = (): { fetch: typeof globalThis.fetch; bodies: unknown[] } => {
    const bodies: unknown[] = []
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (typeof init?.body === 'string') bodies.push(JSON.parse(init.body))
      return new Response(JSON.stringify(mouserPayload('R-1')), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    }) as typeof globalThis.fetch
    return { fetch: fetchImpl, bodies }
  }

  it('sends the filter, and does not serve the unfiltered result from cache', async () => {
    // The failure this guards: if filters were left out of the cache key, the
    // filtered search would return the unfiltered result — the results *and*
    // the facets would both sit unchanged, with no error anywhere.
    const { fetch, bodies } = recordingFetch()
    const service = new PartsService(dir, cipher, fetch)
    service.setCredentials('mouser', { apiKey: 'key-12345678' })

    await service.search('mouser', 'resistor')
    await service.search('mouser', 'resistor', undefined, 0, undefined, {
      ...EMPTY_FILTERS,
      inStock: true
    })

    expect(bodies).toHaveLength(2)
    expect(
      (bodies[0] as { SearchByKeywordRequest: { searchOptions: string } }).SearchByKeywordRequest
        .searchOptions
    ).toBe('None')
    expect(
      (bodies[1] as { SearchByKeywordRequest: { searchOptions: string } }).SearchByKeywordRequest
        .searchOptions
    ).toBe('InStock')
  })

  it('re-queries when only the sort changed, and caches when it did not', async () => {
    // Same failure shape as the filter bug above: the same rows in a different
    // order is a different answer, so a sort left out of the key would make a
    // header click return the previous ordering with no request sent.
    const { fetch, bodies } = recordingFetch()
    const service = new PartsService(dir, cipher, fetch)
    service.setCredentials('mouser', { apiKey: 'key-12345678' })

    await service.search('mouser', 'resistor', undefined, 0, undefined, undefined, null)
    await service.search('mouser', 'resistor', undefined, 0, undefined, undefined, {
      field: 'Price',
      order: 'asc'
    })
    await service.search('mouser', 'resistor', undefined, 0, undefined, undefined, {
      field: 'Price',
      order: 'desc'
    })
    // The third differs from the second only in direction, which still has to
    // reach the wire.
    expect(bodies).toHaveLength(3)

    await service.search('mouser', 'resistor', undefined, 0, undefined, undefined, {
      field: 'Price',
      order: 'desc'
    })
    expect(bodies).toHaveLength(3)
  })

  it('still caches when the filters are identical', async () => {
    const { fetch, bodies } = recordingFetch()
    const service = new PartsService(dir, cipher, fetch)
    service.setCredentials('mouser', { apiKey: 'key-12345678' })

    const filters = { ...EMPTY_FILTERS, rohs: true }
    await service.search('mouser', 'resistor', undefined, 0, undefined, filters)
    await service.search('mouser', 'resistor', undefined, 0, undefined, filters)

    expect(bodies).toHaveLength(1)
  })

  it('treats undefined filters and an all-false filter set as the same request', async () => {
    // They produce an identical request, so sharing a cache entry is correct —
    // but only because `sanitizeFilters` never turns a real selection into
    // undefined, which would collapse every filter onto this one key.
    const { fetch, bodies } = recordingFetch()
    const service = new PartsService(dir, cipher, fetch)
    service.setCredentials('mouser', { apiKey: 'key-12345678' })

    await service.search('mouser', 'resistor')
    await service.search('mouser', 'resistor', undefined, 0, undefined, EMPTY_FILTERS)
    expect(bodies).toHaveLength(2)
  })
})
