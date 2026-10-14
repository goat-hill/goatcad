import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { adoptDatasheet, cachedDatasheet, fetchDatasheet } from '../partsMcpDatasheetStore'
import type { outboundFetch } from '../outboundFetch'

const PDF = new TextEncoder().encode('%PDF-1.4 a datasheet')
const PDF_B = new TextEncoder().encode('%PDF-1.7 another revision')
const HTML = new TextEncoder().encode('<html>please enable javascript</html>')

/** A fetch that answers per URL: bytes with a 200, a status alone, or throws. */
const answering =
  (script: Record<string, Uint8Array | number | Error>): typeof outboundFetch =>
  async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const answer = script[url]
    if (answer instanceof Error) throw answer
    if (typeof answer === 'number') return new Response(null, { status: answer })
    if (!answer) throw new Error(`unexpected fetch of ${url}`)
    const contentType = answer === HTML ? 'text/html' : 'application/pdf'
    return new Response(Buffer.from(answer), {
      status: 200,
      headers: { 'content-type': contentType }
    })
  }

const LINKS = [
  { distributor: 'DigiKey', url: 'https://mfr.example/x.pdf' },
  { distributor: 'Mouser', url: 'https://mouser.example/x.pdf' }
]

let project: string
beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'goatcad-ds-'))
})
afterEach(() => {
  rmSync(project, { recursive: true, force: true })
})

describe('fetching a datasheet', () => {
  it('saves the first link that answers with a PDF and records it', async () => {
    const result = await fetchDatasheet(
      project,
      'X1',
      LINKS,
      answering({ 'https://mfr.example/x.pdf': PDF }),
      5
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.attempts).toEqual([{ ...LINKS[0], result: 'saved' }])
    expect(result.record).toMatchObject({
      mpn: 'X1',
      source: 'distributor',
      distributor: 'DigiKey',
      url: 'https://mfr.example/x.pdf',
      fetchedAt: 5
    })
    expect(readFileSync(result.path)).toEqual(Buffer.from(PDF))
    expect(cachedDatasheet(project, 'x1')?.file).toBe('X1.pdf')
  })

  it("falls through to the next distributor's link when the first refuses", async () => {
    // The manufacturer's page 403s a plain request; the distributor's own
    // copy does not. Both attempts are in the answer.
    const result = await fetchDatasheet(
      project,
      'X1',
      LINKS,
      answering({ 'https://mfr.example/x.pdf': 403, 'https://mouser.example/x.pdf': PDF }),
      5
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.attempts).toEqual([
      { ...LINKS[0], result: 'http-error', status: 403 },
      { ...LINKS[1], result: 'saved' }
    ])
    expect(result.record.distributor).toBe('Mouser')
  })

  it('treats an HTML page as no datasheet and keeps trying', async () => {
    const result = await fetchDatasheet(
      project,
      'X1',
      LINKS,
      answering({ 'https://mfr.example/x.pdf': HTML, 'https://mouser.example/x.pdf': PDF }),
      5
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.attempts[0]).toEqual({
      ...LINKS[0],
      result: 'not-pdf',
      status: 200,
      contentType: 'text/html'
    })
  })

  it('reports every attempt when no link gives a PDF, and writes nothing', async () => {
    const result = await fetchDatasheet(
      project,
      'X1',
      LINKS,
      answering({
        'https://mfr.example/x.pdf': new Error('stream reset'),
        'https://mouser.example/x.pdf': HTML
      }),
      5
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.attempts).toEqual([
      { ...LINKS[0], result: 'network-error', detail: 'stream reset' },
      { ...LINKS[1], result: 'not-pdf', status: 200, contentType: 'text/html' }
    ])
    expect(existsSync(join(project, 'datasheets'))).toBe(false)
  })

  it('refuses a link that is not https without fetching it', async () => {
    const result = await fetchDatasheet(
      project,
      'X1',
      [{ distributor: 'DigiKey', url: 'http://mfr.example/x.pdf' }],
      answering({}),
      5
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.attempts[0].result).toBe('bad-url')
  })
})

describe('one file for parts that share a datasheet', () => {
  const SERIES = [{ distributor: 'DigiKey', url: 'https://mfr.example/series.pdf' }]
  const pdfs = (): string[] =>
    readdirSync(join(project, 'datasheets')).filter((f) => f.endsWith('.pdf'))

  it('reuses a link another part saved, without a request', async () => {
    await fetchDatasheet(project, 'R1', SERIES, answering({ [SERIES[0].url]: PDF }), 1)
    const second = await fetchDatasheet(project, 'R2', SERIES, answering({}), 2)
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.sharedWith).toBe('R1')
    expect(second.attempts).toEqual([{ ...SERIES[0], result: 'reused' }])
    expect(second.record).toMatchObject({ mpn: 'R2', file: 'R1.pdf', distributor: 'DigiKey' })
    expect(pdfs()).toEqual(['R1.pdf'])
    expect(cachedDatasheet(project, 'R2')?.file).toBe('R1.pdf')
  })

  it('downloads on a refresh even when another part saved the link', async () => {
    await fetchDatasheet(project, 'R1', SERIES, answering({ [SERIES[0].url]: PDF }), 1)
    await fetchDatasheet(project, 'R2', SERIES, answering({}), 2)
    const refreshed = await fetchDatasheet(
      project,
      'R1',
      SERIES,
      answering({ [SERIES[0].url]: PDF_B }),
      3,
      true
    )
    expect(refreshed.ok && refreshed.attempts).toEqual([{ ...SERIES[0], result: 'saved' }])
    expect(readFileSync(join(project, 'datasheets', 'R1.pdf'))).toEqual(Buffer.from(PDF_B))
    // R2 keeps the revision it recorded.
    expect(readFileSync(join(project, 'datasheets', 'R2.pdf'))).toEqual(Buffer.from(PDF))
  })

  it('shares a file whose bytes match, whatever address they came from', async () => {
    await fetchDatasheet(project, 'R1', SERIES, answering({ [SERIES[0].url]: PDF }), 1)
    const elsewhere = [{ distributor: 'Mouser', url: 'https://mouser.example/r2.pdf' }]
    const second = await fetchDatasheet(
      project,
      'R2',
      elsewhere,
      answering({ [elsewhere[0].url]: PDF }),
      2
    )
    expect(second.ok && second.sharedWith).toBe('R1')
    expect(pdfs()).toEqual(['R1.pdf'])
  })

  it('shares an adopted file whose bytes match', async () => {
    await fetchDatasheet(project, 'R1', SERIES, answering({ [SERIES[0].url]: PDF }), 1)
    const source = join(project, 'mine.pdf')
    writeFileSync(source, PDF)
    const adopted = adoptDatasheet(project, 'R2', source, 2)
    expect(adopted.ok && adopted.sharedWith).toBe('R1')
    expect(pdfs()).toEqual(['R1.pdf'])
  })

  it('keeps what a sharing part recorded when the first part is refreshed with new bytes', async () => {
    await fetchDatasheet(project, 'R1', SERIES, answering({ [SERIES[0].url]: PDF }), 1)
    await fetchDatasheet(project, 'R2', SERIES, answering({}), 2)
    const other = [{ distributor: 'Mouser', url: 'https://mouser.example/r1.pdf' }]
    const refreshed = await fetchDatasheet(
      project,
      'R1',
      other,
      answering({ [other[0].url]: PDF_B }),
      3
    )
    expect(refreshed.ok && refreshed.sharedWith).toBeUndefined()
    expect(readFileSync(join(project, 'datasheets', 'R1.pdf'))).toEqual(Buffer.from(PDF_B))
    expect(cachedDatasheet(project, 'R2')?.file).toBe('R2.pdf')
    expect(readFileSync(join(project, 'datasheets', 'R2.pdf'))).toEqual(Buffer.from(PDF))
  })
})

describe('adopting a file', () => {
  it("records the caller's provenance", () => {
    const source = join(project, 'x.pdf')
    writeFileSync(source, PDF)
    const result = adoptDatasheet(project, 'X1', source, 7, {
      source: 'distributor',
      distributor: 'Mouser',
      url: 'https://mouser.example/x.pdf'
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.record).toMatchObject({
      source: 'distributor',
      distributor: 'Mouser',
      url: 'https://mouser.example/x.pdf'
    })
    // Where the file was copied from is a local path; the manifest is committed.
    expect(result.record).not.toHaveProperty('originalPath')
    expect(readFileSync(join(project, 'datasheets', 'index.json'), 'utf8')).not.toContain(source)
  })

  it('defaults to the user as the source', () => {
    const source = join(project, 'x.pdf')
    writeFileSync(source, PDF)
    const result = adoptDatasheet(project, 'X1', source, 7)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.record.source).toBe('user')
    expect(result.record.url).toBeUndefined()
  })
})
