import { describe, it, expect } from 'vitest'
import {
  datasheetFileName,
  emptyManifest,
  findDatasheet,
  isFetchableDatasheetUrl,
  looksLikePdf,
  parseManifest,
  provenanceFor,
  serializeManifest,
  sha256,
  upsertDatasheet,
  type DatasheetRecord
} from '../partsMcpDatasheets'

const record = (mpn: string, over: Partial<DatasheetRecord> = {}): DatasheetRecord => ({
  mpn,
  file: `${mpn}.pdf`,
  source: 'distributor',
  distributor: 'DigiKey',
  url: 'https://example.com/x.pdf',
  fetchedAt: 1_700_000_000_000,
  bytes: 1234,
  sha256: 'abc',
  ...over
})

describe('datasheet file naming', () => {
  it('keeps an MPN readable while making it a safe file name', () => {
    expect(datasheetFileName('SGP41-D-R4')).toBe('SGP41-D-R4.pdf')
    expect(datasheetFileName('AP2112K-3.3TRG1')).toBe('AP2112K-3.3TRG1.pdf')
  })

  it('cannot be talked into writing outside the folder', () => {
    // MPNs really do contain slashes (LM317/NOPB), so this is a live path, not
    // a hypothetical one.
    expect(datasheetFileName('../../etc/passwd')).not.toContain('/')
    expect(datasheetFileName('LM317/NOPB')).toBe('LM317_NOPB.pdf')
    expect(datasheetFileName('..')).toBe('part.pdf')
    expect(datasheetFileName('')).toBe('part.pdf')
  })

  it('preserves case, because MPNs carry it', () => {
    expect(datasheetFileName('SCD40-D-R2')).toBe('SCD40-D-R2.pdf')
  })
})

describe('the manifest', () => {
  it('replaces an entry for the same part rather than accumulating duplicates', () => {
    const first = upsertDatasheet(emptyManifest(), record('SGP41-D-R4'))
    const second = upsertDatasheet(first, record('SGP41-D-R4', { sha256: 'def' }))
    expect(second.datasheets).toHaveLength(1)
    expect(second.datasheets[0].sha256).toBe('def')
  })

  it('sorts, so a committed file has a readable diff', () => {
    let m = emptyManifest()
    for (const mpn of ['SGP41-D-R4', 'AP2112K-3.3TRG1', 'SCD40-D-R2'])
      m = upsertDatasheet(m, record(mpn))
    expect(m.datasheets.map((entry) => entry.mpn)).toEqual([
      'AP2112K-3.3TRG1',
      'SCD40-D-R2',
      'SGP41-D-R4'
    ])
  })

  it('finds a part however the caller cased it', () => {
    const m = upsertDatasheet(emptyManifest(), record('SCD40-D-R2'))
    expect(findDatasheet(m, 'scd40-d-r2')?.mpn).toBe('SCD40-D-R2')
    expect(findDatasheet(m, '  SCD40-D-R2 ')?.mpn).toBe('SCD40-D-R2')
  })

  it('treats a damaged manifest as empty rather than throwing', () => {
    // This file is committed and therefore hand-editable and merge-conflictable.
    // The PDFs are the real content; the index must never be what stops the tool.
    expect(parseManifest('{not json').datasheets).toEqual([])
    expect(parseManifest('{"version":1}').datasheets).toEqual([])
    expect(parseManifest(null).datasheets).toEqual([])
    expect(parseManifest('{"version":1,"datasheets":[{"mpn":"X"}]}').datasheets).toEqual([])
  })

  it('round-trips, and ends with a newline so it is a well-formed text file', () => {
    const m = upsertDatasheet(emptyManifest(), record('SCD40-D-R2'))
    const text = serializeManifest(m)
    expect(text.endsWith('\n')).toBe(true)
    expect(parseManifest(text)).toEqual(m)
  })

  it('records provenance on every entry, which is the point of having it', () => {
    const m = upsertDatasheet(emptyManifest(), record('SCD40-D-R2'))
    expect(m.datasheets[0]).toMatchObject({ source: 'distributor', distributor: 'DigiKey' })
    const user = upsertDatasheet(emptyManifest(), record('X', { source: 'user', url: undefined }))
    expect(user.datasheets[0].source).toBe('user')
  })

  it("reads an older manifest's originalPath and writes it back without one", () => {
    const old = JSON.stringify({
      version: 1,
      datasheets: [{ ...record('X', { source: 'user' }), originalPath: '/tmp/x.pdf' }]
    })
    const m = parseManifest(old)
    expect(m.datasheets[0].mpn).toBe('X')
    expect(serializeManifest(m)).not.toContain('originalPath')
  })
})

describe('provenance of a file the caller fetched', () => {
  const listed = [
    { distributor: 'DigiKey', url: 'https://mfr.example/x.pdf' },
    { distributor: 'Mouser', url: 'https://mouser.example/x.pdf' }
  ]

  it("is the distributor's when the URL is one the listing handed out", () => {
    expect(provenanceFor('https://mouser.example/x.pdf', listed)).toEqual({
      source: 'distributor',
      distributor: 'Mouser',
      url: 'https://mouser.example/x.pdf'
    })
  })

  it("is the user's, with the address kept, for any other URL", () => {
    expect(provenanceFor('https://aggregator.example/x.pdf', listed)).toEqual({
      source: 'user',
      url: 'https://aggregator.example/x.pdf'
    })
  })

  it("is the user's with no address when none was given", () => {
    expect(provenanceFor(undefined, listed)).toEqual({ source: 'user' })
    expect(provenanceFor('  ', listed)).toEqual({ source: 'user' })
  })

  it('matches the address character for character, never loosely', () => {
    expect(provenanceFor('https://MOUSER.example/x.pdf', listed).source).toBe('user')
  })
})

describe('what is fetchable', () => {
  it('accepts https and nothing else', () => {
    expect(isFetchableDatasheetUrl('https://sensirion.com/x.pdf')).toBe(true)
    expect(isFetchableDatasheetUrl('http://sensirion.com/x.pdf')).toBe(false)
    expect(isFetchableDatasheetUrl('file:///etc/passwd')).toBe(false)
    expect(isFetchableDatasheetUrl('not a url')).toBe(false)
  })
})

describe('what got downloaded', () => {
  it('recognises a PDF by its header', () => {
    expect(looksLikePdf(new TextEncoder().encode('%PDF-1.7\n...'))).toBe(true)
  })

  it('rejects an HTML error page served with a 200', () => {
    // The common failure of a rotted vendor link. Committing one of these puts
    // a file named like a datasheet, that is not one, into the repository.
    expect(looksLikePdf(new TextEncoder().encode('<!DOCTYPE html><title>404'))).toBe(false)
    expect(looksLikePdf(new Uint8Array([]))).toBe(false)
  })
})

describe('content hashing', () => {
  it('distinguishes two copies of the same part number', () => {
    const a = sha256(new TextEncoder().encode('revision 1.7'))
    const b = sha256(new TextEncoder().encode('revision 1.8'))
    expect(a).not.toBe(b)
    expect(a).toHaveLength(64)
  })
})
