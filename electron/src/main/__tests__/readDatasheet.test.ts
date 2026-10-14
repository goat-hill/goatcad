import { describe, expect, it } from 'vitest'
import { partsReadDatasheet, parsePages } from '../ops/parts/readDatasheet'
import type { OpContext } from '../ops/context'
import type { DatasheetReadRequest, DatasheetReadResult } from '../datasheetReader'
import type { DatasheetRecord } from '../partsMcpDatasheets'
import type { PartsService } from '../ops/context'

/** The operation over a recording reader: what it asks for, and how it
 *  answers, without pdfium. The reader itself is tested with the real wasm. */

const record: DatasheetRecord = {
  mpn: 'X1',
  file: 'X1.pdf',
  source: 'distributor',
  fetchedAt: 1,
  bytes: 10,
  sha256: 'abc'
}

const overview: DatasheetReadResult = {
  ok: true,
  kind: 'overview',
  pages: 3,
  pageSize: { width: 612, height: 792 },
  outline: [{ depth: 0, page: 2, title: 'Specifications' }],
  outlineTotal: 1,
  preview: null
}

const harness = (
  answer: DatasheetReadResult = overview,
  over: Partial<OpContext> = {}
): { ctx: OpContext; requests: DatasheetReadRequest[] } => {
  const requests: DatasheetReadRequest[] = []
  const ctx: OpContext = {
    parts: {} as PartsService,
    project: () => '/proj',
    datasheets: {
      cached: (_project, mpn) => (mpn === 'X1' ? record : null),
      path: (project, rec) => `${project}/datasheets/${rec.file}`,
      fetch: async () => {
        throw new Error('unused')
      },
      adopt: () => {
        throw new Error('unused')
      }
    },
    datasheetReader: {
      read: async (request) => {
        requests.push(request)
        return answer
      }
    },
    ...over
  }
  return { ctx, requests }
}

const failure = (
  outcome: Awaited<ReturnType<typeof partsReadDatasheet.invoke>>
): { code: string; kind?: string } => {
  if (outcome.ok) throw new Error('expected a failure')
  return outcome.error
}

const value = (
  outcome: Awaited<ReturnType<typeof partsReadDatasheet.invoke>>
): Record<string, unknown> => {
  if (!outcome.ok) throw new Error(`expected success: ${outcome.error.message}`)
  return outcome.value as Record<string, unknown>
}

describe('parsePages', () => {
  it('reads pages and ranges into sorted unique pages', () => {
    expect(parsePages('5', null)).toEqual({ ok: true, pages: [5] })
    expect(parsePages('2, 9-10, 3-4, 3', null)).toEqual({ ok: true, pages: [2, 3, 4, 9, 10] })
  })
  it('names the token it cannot read', () => {
    expect(parsePages('5-3', null)).toEqual({ ok: false, token: '5-3' })
    expect(parsePages('a', null)).toEqual({ ok: false, token: 'a' })
    expect(parsePages('0', null)).toEqual({ ok: false, token: '0' })
  })
})

describe('parts.read_datasheet', () => {
  it('resolves an MPN through the datasheet store and overviews it', async () => {
    const { ctx, requests } = harness()
    const out = value(await partsReadDatasheet.invoke({ mpn: 'X1' }, ctx))
    expect(requests).toEqual([{ kind: 'overview', path: '/proj/datasheets/X1.pdf' }])
    expect(out.pages).toBe(3)
    expect(out.outline).toEqual([{ depth: 0, page: 2, title: 'Specifications' }])
    expect(out.preview).toBeUndefined()
    expect(out.truncated).toBeUndefined()
  })

  it('passes depth to the outline, and refuses it beside another mode', async () => {
    const { ctx, requests } = harness()
    value(await partsReadDatasheet.invoke({ mpn: 'X1', depth: 1 }, ctx))
    expect(requests).toEqual([{ kind: 'overview', path: '/proj/datasheets/X1.pdf', depth: 1 }])
    expect(
      failure(await partsReadDatasheet.invoke({ mpn: 'X1', depth: 1, pages: '2' }, ctx)).code
    ).toBe('refused')
    expect(failure(await partsReadDatasheet.invoke({ mpn: 'X1', depth: -1 }, ctx)).code).toBe(
      'invalid-args'
    )
  })

  it('says when the outline was capped, with its count and the narrowing argument', async () => {
    const { ctx } = harness({ ...overview, outlineTotal: 900 })
    const out = value(await partsReadDatasheet.invoke({ mpn: 'X1' }, ctx))
    expect(out.truncated).toBe(true)
    expect(out.outlineCount).toBe(900)
    expect(out.guidance).toContain('depth')
  })

  it('refuses an MPN nothing cached, pointing at parts_cache_datasheet', async () => {
    const { ctx } = harness()
    const error = failure(await partsReadDatasheet.invoke({ mpn: 'X9' }, ctx))
    expect(error.code).toBe('not-found')
    expect(error.kind).toBe('not-cached')
  })

  it('takes a path relative to the project, or absolute without one', async () => {
    const relative = harness()
    await partsReadDatasheet.invoke({ path: 'docs/app.pdf' }, relative.ctx)
    expect(relative.requests[0]).toMatchObject({ path: '/proj/docs/app.pdf' })
    const absolute = harness(overview, { project: () => null })
    await partsReadDatasheet.invoke({ path: '/elsewhere/app.pdf' }, absolute.ctx)
    expect(absolute.requests[0]).toMatchObject({ path: '/elsewhere/app.pdf' })
    const noProject = harness(overview, { project: () => null })
    expect(
      failure(await partsReadDatasheet.invoke({ path: 'docs/app.pdf' }, noProject.ctx)).code
    ).toBe('no-document')
  })

  it('needs one of mpn or path, and one mode per call', async () => {
    const { ctx } = harness()
    expect(failure(await partsReadDatasheet.invoke({}, ctx)).code).toBe('refused')
    expect(
      failure(await partsReadDatasheet.invoke({ mpn: 'X1', pages: '1', query: 'x' }, ctx)).code
    ).toBe('refused')
  })

  it('asks for the text of parsed pages and relays truncation', async () => {
    const { ctx, requests } = harness({
      ok: true,
      kind: 'text',
      pages: [
        { page: 2, text: 'two' },
        { page: 3, text: 'thr' }
      ],
      truncatedAt: 3
    })
    const out = value(
      await partsReadDatasheet.invoke({ mpn: 'X1', pages: '2-3', maxChars: 600 }, ctx)
    )
    expect(requests[0]).toEqual({
      kind: 'text',
      path: '/proj/datasheets/X1.pdf',
      pages: [2, 3],
      maxChars: 600
    })
    expect(out.truncatedAt).toBe(3)
    expect(out.guidance).toBeDefined()
  })

  it('rejects a page spec it cannot read, and too many pages', async () => {
    const { ctx } = harness()
    expect(failure(await partsReadDatasheet.invoke({ mpn: 'X1', pages: 'five' }, ctx)).code).toBe(
      'invalid-args'
    )
    expect(failure(await partsReadDatasheet.invoke({ mpn: 'X1', pages: '1-40' }, ctx)).code).toBe(
      'refused'
    )
  })

  it('searches, and says when nothing matched', async () => {
    const { ctx, requests } = harness({
      ok: true,
      kind: 'search',
      hits: [],
      totalHits: 0,
      pagesWithHits: []
    })
    const out = value(await partsReadDatasheet.invoke({ mpn: 'X1', query: 'thermal' }, ctx))
    expect(requests[0]).toMatchObject({ kind: 'search', query: 'thermal' })
    expect(out.totalHits).toBe(0)
    expect(out.hits).toEqual([])
  })

  it('answers an image with the frame and MCP-shaped image content', async () => {
    const { ctx, requests } = harness({
      ok: true,
      kind: 'render',
      page: 2,
      scale: 3,
      frame: { x: 10, y: 20, width: 100, height: 50 },
      width: 300,
      height: 150,
      pngBase64: 'UElORw=='
    })
    const out = value(
      await partsReadDatasheet.invoke(
        {
          mpn: 'X1',
          image: { page: 2, scale: 3, region: { x: 10, y: 20, width: 100, height: 50 } }
        },
        ctx
      )
    )
    expect(requests[0]).toEqual({
      kind: 'render',
      path: '/proj/datasheets/X1.pdf',
      page: 2,
      scale: 3,
      region: { x: 10, y: 20, width: 100, height: 50 }
    })
    expect(out.image).toEqual({ mimeType: 'image/png', base64: 'UElORw==' })
    expect(out.frame).toEqual({ x: 10, y: 20, width: 100, height: 50 })
    expect(out.pixels).toEqual({ width: 300, height: 150 })
  })

  it('maps reader failures to the surface', async () => {
    const notPdf = harness({ ok: false, error: 'not-a-pdf', message: 'nope' })
    expect(failure(await partsReadDatasheet.invoke({ mpn: 'X1' }, notPdf.ctx))).toMatchObject({
      code: 'refused',
      kind: 'not-a-pdf'
    })
    const badPage = harness({ ok: false, error: 'bad-page', message: 'no page 9' })
    expect(
      failure(await partsReadDatasheet.invoke({ mpn: 'X1', pages: '9' }, badPage.ctx)).code
    ).toBe('invalid-args')
  })

  it('fails plainly in a build without a reader', async () => {
    const { ctx } = harness(overview, { datasheetReader: undefined })
    expect(failure(await partsReadDatasheet.invoke({ mpn: 'X1' }, ctx)).code).toBe('internal')
  })
})
