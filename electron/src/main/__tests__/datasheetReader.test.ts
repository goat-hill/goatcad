import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import createPdfium from '../wasm/pdfium.js'
import { DatasheetReader, MAX_RENDER_PIXELS, type DatasheetReadResult } from '../datasheetReader'
import { buildPdf, specSheet } from './pdfFixture'

/** The real wasm build, so these prove the committed artifact and the glue. */

let dir: string
let sheet: string
const reader = new DatasheetReader(() => createPdfium())

type ReadOk = Extract<DatasheetReadResult, { ok: true }>

const ok = <K extends ReadOk['kind']>(
  result: DatasheetReadResult,
  kind: K
): Extract<ReadOk, { kind: K }> => {
  if (!result.ok) throw new Error(`reader failed: ${result.message}`)
  if (result.kind !== kind) throw new Error(`expected ${kind}, got ${result.kind}`)
  return result as Extract<ReadOk, { kind: K }>
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'goatcad-pdf-'))
  sheet = join(dir, 'spec.pdf')
  writeFileSync(sheet, specSheet())
})

afterAll(() => {
  reader.dispose()
  rmSync(dir, { recursive: true, force: true })
})

describe('DatasheetReader', () => {
  it('overviews a document without an outline through its first page', async () => {
    const result = ok(await reader.read({ kind: 'overview', path: sheet }), 'overview')
    expect(result.pages).toBe(2)
    expect(result.pageSize).toEqual({ width: 612, height: 792 })
    expect(result.outline).toEqual([])
    expect(result.preview).toContain('GoatCAD Test Regulator')
  })

  it('reads the bookmark outline as a map of the document', async () => {
    const path = join(dir, 'outlined.pdf')
    writeFileSync(
      path,
      buildPdf(
        [
          { items: [{ x: 72, y: 72, text: 'Cover' }] },
          { items: [{ x: 72, y: 72, text: 'Pins' }] },
          { items: [{ x: 72, y: 72, text: 'Specs' }] }
        ],
        [
          { title: 'Pin Configuration', page: 2 },
          {
            title: 'Specifications',
            page: 3,
            children: [{ title: 'Electrical Characteristics', page: 3 }]
          }
        ]
      )
    )
    const result = ok(await reader.read({ kind: 'overview', path }), 'overview')
    expect(result.outline).toEqual([
      { depth: 0, page: 2, title: 'Pin Configuration' },
      { depth: 0, page: 3, title: 'Specifications' },
      { depth: 1, page: 3, title: 'Electrical Characteristics' }
    ])
    expect(result.outlineTotal).toBe(3)
    expect(result.preview).toBeNull()

    const top = ok(await reader.read({ kind: 'overview', path, depth: 0 }), 'overview')
    expect(top.outline.map((entry) => entry.title)).toEqual(['Pin Configuration', 'Specifications'])
    expect(top.outlineTotal).toBe(2)
  })

  it('returns page text with its columns lined up', async () => {
    const result = ok(
      await reader.read({ kind: 'text', path: sheet, pages: [2], maxChars: 10_000 }),
      'text'
    )
    expect(result.truncatedAt).toBeNull()
    const lines = result.pages[0].text.split('\n')
    const header = lines.find((l) => l.includes('PARAMETER'))!
    const row = lines.find((l) => l.includes('Input voltage range'))!
    expect(Math.abs(header.indexOf('MIN') - row.indexOf('3'))).toBeLessThanOrEqual(1)
    expect(Math.abs(header.indexOf('MAX') - row.indexOf('17'))).toBeLessThanOrEqual(1)
  })

  it('truncates at the character budget and says where', async () => {
    const result = ok(
      await reader.read({ kind: 'text', path: sheet, pages: [1, 2], maxChars: 30 }),
      'text'
    )
    expect(result.pages).toHaveLength(2)
    expect(result.truncatedAt).toBe(2)
    expect(result.pages[1].text.length).toBeLessThanOrEqual(30)
  })

  it('finds a phrase across pages regardless of layout spacing', async () => {
    const result = ok(
      await reader.read({
        kind: 'search',
        path: sheet,
        query: 'ELECTRICAL  characteristics',
        maxHits: 10
      }),
      'search'
    )
    expect(result.pagesWithHits).toEqual([2])
    expect(result.totalHits).toBe(1)
    expect(result.hits[0].page).toBe(2)
    expect(result.hits[0].text).toContain('electrical characteristics')
  })

  it('renders a page and a region as PNG at the scale asked', async () => {
    const page = ok(await reader.read({ kind: 'render', path: sheet, page: 1, scale: 1 }), 'render')
    expect([page.width, page.height]).toEqual([612, 792])
    expect(page.frame).toEqual({ x: 0, y: 0, width: 612, height: 792 })
    expect(Buffer.from(page.pngBase64, 'base64').subarray(1, 4).toString('ascii')).toBe('PNG')
    const region = ok(
      await reader.read({
        kind: 'render',
        path: sheet,
        page: 1,
        scale: 2,
        region: { x: 60, y: 80, width: 300, height: 40 }
      }),
      'render'
    )
    expect([region.width, region.height]).toEqual([600, 80])
    expect(region.scale).toBe(2)
  })

  it('reduces the scale rather than exceed the pixel cap', async () => {
    const result = ok(
      await reader.read({ kind: 'render', path: sheet, page: 1, scale: 6 }),
      'render'
    )
    expect(result.scale).toBeLessThan(6)
    expect(result.width * result.height).toBeLessThanOrEqual(MAX_RENDER_PIXELS)
  })

  it('reports a page out of range', async () => {
    const result = await reader.read({ kind: 'text', path: sheet, pages: [3], maxChars: 100 })
    expect(result).toMatchObject({ ok: false, error: 'bad-page' })
  })

  it('refuses a file that is not a PDF, and names a missing one', async () => {
    const text = join(dir, 'notes.txt')
    writeFileSync(text, 'hello')
    expect(await reader.read({ kind: 'overview', path: text })).toMatchObject({
      ok: false,
      error: 'not-a-pdf'
    })
    expect(await reader.read({ kind: 'overview', path: join(dir, 'missing.pdf') })).toMatchObject({
      ok: false,
      error: 'not-found'
    })
  })

  it('reopens a document whose file changed on disk', async () => {
    const path = join(dir, 'changing.pdf')
    writeFileSync(path, buildPdf([{ items: [{ x: 72, y: 72, text: 'one' }] }]))
    utimesSync(path, new Date(1_000_000_000_000), new Date(1_000_000_000_000))
    expect(ok(await reader.read({ kind: 'overview', path }), 'overview').pages).toBe(1)
    writeFileSync(
      path,
      buildPdf([
        { items: [{ x: 72, y: 72, text: 'one' }] },
        { items: [{ x: 72, y: 72, text: 'two' }] }
      ])
    )
    utimesSync(path, new Date(1_000_000_005_000), new Date(1_000_000_005_000))
    expect(ok(await reader.read({ kind: 'overview', path }), 'overview').pages).toBe(2)
  })
})
