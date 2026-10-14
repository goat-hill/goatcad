/**
 * `parts.read_datasheet` — the document's text, a search through it, or a
 * picture of a page, from the PDF the project holds.
 *
 * The reader is pdfium in
 * wasm (`src/main/wasm/`), so the answer is the same on every platform and
 * needs nothing the machine happens to have installed; text keeps the page's
 * layout so a spec table reads as a table; and the shape of the operation —
 * overview, then a query, then pages, then an image of a region — is what
 * makes reading by the page rather than by the document the natural path.
 */
import { isAbsolute, join } from 'node:path'
import { defineOp } from '../registry'
import { s } from '../schema'
import { fail, internal, invalidArgs, notFound, refused, succeed, type OpOutcome } from '../errors'
import type { DatasheetReadResult, Region } from '../../datasheetReader'

const DEFAULT_MAX_CHARS = 12_000
const MAX_MAX_CHARS = 60_000
const MAX_PAGES_PER_CALL = 20
const MAX_HITS = 40
const DEFAULT_SCALE = 2
const MAX_SCALE = 6

const region = s.object({
  x: s.number().describe('Left edge, points from the page left.'),
  y: s.number().describe('Top edge, points from the page top.'),
  width: s.number().min(1),
  height: s.number().min(1)
})

const image = s.object({
  page: s.integer().min(1).describe('Page to draw, 1-based.'),
  scale: s.number().min(0.25).max(MAX_SCALE).describe('Pixels per point. Default 2.').optional(),
  region: region
    .describe(
      'Area to draw, in points from the top-left corner, as a whole-page image reports in frame.'
    )
    .optional()
})

/** "3", "3-5", "1,4-6" → sorted unique 1-based pages, or the offending token. */
export const parsePages = (
  spec: string,
  pageCount: number | null
): { ok: true; pages: number[] } | { ok: false; token: string } => {
  const pages = new Set<number>()
  for (const raw of spec.split(',')) {
    const token = raw.trim()
    if (!token) continue
    const range = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(token)
    if (!range) return { ok: false, token }
    const from = Number(range[1])
    const to = range[2] ? Number(range[2]) : from
    if (from < 1 || to < from) return { ok: false, token }
    if (pageCount !== null && from > pageCount) return { ok: false, token }
    for (let p = from; p <= Math.min(to, pageCount ?? to); p++) pages.add(p)
  }
  return { ok: true, pages: [...pages].sort((a, b) => a - b) }
}

const readerFailure = (result: Extract<DatasheetReadResult, { ok: false }>): OpOutcome => {
  switch (result.error) {
    case 'not-found':
      return notFound(
        result.message,
        'Check the path, or cache the datasheet first with parts_cache_datasheet.'
      )
    case 'bad-page':
      return invalidArgs(
        result.message,
        'pages',
        'Call with only mpn or path for the page count and outline.'
      )
    case 'not-a-pdf':
    case 'unreadable':
      return fail({
        code: 'refused',
        kind: result.error,
        message: result.message,
        fix: 'Only PDFs can be read. For a cached datasheet, call parts_cache_datasheet with refresh.'
      })
    case 'internal':
      return internal(result.message, 'reader-failed')
  }
}

export const partsReadDatasheet = defineOp({
  name: 'parts.read_datasheet',
  scope: 'project',
  mutates: false,
  summary:
    'Read a cached datasheet (by MPN) or a PDF (by path) as an outline, search hits, page text or a page image.',
  guidance:
    'Use this rather than your own PDF tools. Pass one of pages, query or image per call; with none, the answer is the page count and outline, which depth narrows to its upper levels. Read outward: outline, then query to find the pages, then pages for their text (layout kept, so table columns stay aligned), then image for a drawing such as pin numbers on a package. Zoom with region rather than a larger scale. Do not read a datasheet whole.',
  input: s.object({
    mpn: s
      .string()
      .trim()
      .describe('MPN of a datasheet parts_cache_datasheet saved. One of mpn or path.')
      .optional(),
    path: s
      .string()
      .trim()
      .describe('PDF path, absolute or project-relative (docs/appnote.pdf). One of mpn or path.')
      .optional(),
    pages: s
      .string()
      .trim()
      .describe('Pages as text, 1-based: "5", "5-7", "2,9-10". At most 20, cut at maxChars.')
      .optional(),
    query: s
      .string()
      .trim()
      .describe(
        'Phrase to find on every page, case-insensitive; returns matching lines and their pages.'
      )
      .optional(),
    image: image.describe('A page, or a region of one, drawn as a PNG.').optional(),
    depth: s
      .integer()
      .min(0)
      .describe(
        'Outline: keep entries at this depth or above; 0 is the top level. Default every level.'
      )
      .optional(),
    maxChars: s
      .integer()
      .min(500)
      .max(MAX_MAX_CHARS)
      .describe(`Character budget for pages text. Default ${DEFAULT_MAX_CHARS}.`)
      .optional()
  }),
  examples: [
    { args: { mpn: 'TPS62130RGTR' }, note: 'page count and outline' },
    { args: { mpn: 'STM32F405RGT6', depth: 1 }, note: 'the top two outline levels' },
    {
      args: { mpn: 'TPS62130RGTR', query: 'electrical characteristics' },
      note: 'find the spec table'
    },
    { args: { mpn: 'TPS62130RGTR', pages: '5-6' }, note: 'those pages as text' },
    {
      args: { mpn: 'TPS62130RGTR', image: { page: 3 } },
      note: 'the pinout page as an image'
    },
    {
      args: {
        mpn: 'TPS62130RGTR',
        image: { page: 3, region: { x: 60, y: 90, width: 250, height: 220 }, scale: 3 }
      },
      note: 'zoomed on the package drawing'
    },
    {
      args: { path: 'docs/layout-guide.pdf', query: 'thermal via' },
      note: 'a project PDF by path'
    }
  ],
  async run(args, ctx) {
    if (!ctx.datasheetReader) {
      return fail({
        code: 'internal',
        kind: 'reader-unavailable',
        message: 'This build of the server cannot read PDFs.'
      })
    }
    const modes = [args.pages, args.query, args.image].filter((v) => v !== undefined).length
    if (modes > 1) {
      return refused(
        'pages, query and image are separate calls.',
        'Pass one per call: query to find pages, pages for their text, image for a drawing.'
      )
    }
    if (args.depth !== undefined && modes > 0) {
      return refused(
        'depth narrows the outline, which only a call without pages, query or image answers.',
        'Call with mpn or path and depth alone.'
      )
    }
    const projectPath = ctx.project?.() ?? null
    let file: string
    if (args.mpn) {
      if (!ctx.datasheets || !projectPath) {
        return fail({
          code: 'no-document',
          kind: 'no-project',
          message: 'No project is open to hold a cached datasheet.',
          fix: 'Ask the user to open their project, or pass an absolute path.'
        })
      }
      const record = ctx.datasheets.cached(projectPath, args.mpn)
      if (!record) {
        return notFound(
          `No datasheet is cached for ${args.mpn}.`,
          'Call parts_cache_datasheet with that MPN first.',
          { kind: 'not-cached' }
        )
      }
      file = ctx.datasheets.path(projectPath, record)
    } else if (args.path) {
      if (isAbsolute(args.path)) {
        file = args.path
      } else if (projectPath) {
        file = join(projectPath, args.path)
      } else {
        return fail({
          code: 'no-document',
          kind: 'no-project',
          message: 'No project is open to resolve a relative path against.',
          fix: 'Pass an absolute path, or ask the user to open their project.'
        })
      }
    } else {
      return refused(
        'One of mpn or path is required.',
        'Pass the MPN parts_cache_datasheet saved, or a path to a PDF.'
      )
    }

    const reader = ctx.datasheetReader
    if (args.image) {
      const result = await reader.read({
        kind: 'render',
        path: file,
        page: args.image.page,
        scale: args.image.scale ?? DEFAULT_SCALE,
        region: args.image.region as Region | undefined
      })
      if (!result.ok) return readerFailure(result)
      if (result.kind !== 'render') return internal('Unexpected reader answer.', 'reader-mismatch')
      return succeed({
        file,
        page: result.page,
        scale: result.scale,
        frame: result.frame,
        pixels: { width: result.width, height: result.height },
        image: { mimeType: 'image/png', base64: result.pngBase64 },
        guidance:
          'frame is the area drawn, in points from the top-left; pixel (px, py) is point (frame.x + px / scale, frame.y + py / scale). For fine print, call again with a region.'
      })
    }
    if (args.query !== undefined) {
      if (!args.query) return invalidArgs('query must not be empty.', 'query')
      const result = await reader.read({
        kind: 'search',
        path: file,
        query: args.query,
        maxHits: MAX_HITS
      })
      if (!result.ok) return readerFailure(result)
      if (result.kind !== 'search') return internal('Unexpected reader answer.', 'reader-mismatch')
      return succeed({
        file,
        query: args.query,
        hits: result.hits,
        totalHits: result.totalHits,
        pagesWithHits: result.pagesWithHits,
        guidance: result.totalHits
          ? 'Each hit is one line on the page it names. Read that page with pages, or image for a drawing.'
          : "No line contains that phrase. Try a shorter one, or the outline's wording."
      })
    }
    if (args.pages !== undefined) {
      const parsed = parsePages(args.pages, null)
      if (!parsed.ok) {
        return invalidArgs(
          `pages: "${parsed.token}" is not a page or a range.`,
          'pages',
          'Use 1-based pages and ranges: "5", "5-7", "2,9-10".'
        )
      }
      if (!parsed.pages.length) return invalidArgs('pages names no page.', 'pages')
      if (parsed.pages.length > MAX_PAGES_PER_CALL) {
        return refused(
          `pages names ${parsed.pages.length} pages; the limit is ${MAX_PAGES_PER_CALL} per call.`,
          'Read the pages the outline or a query points to, a few at a time.'
        )
      }
      const result = await reader.read({
        kind: 'text',
        path: file,
        pages: parsed.pages,
        maxChars: args.maxChars ?? DEFAULT_MAX_CHARS
      })
      if (!result.ok) return readerFailure(result)
      if (result.kind !== 'text') return internal('Unexpected reader answer.', 'reader-mismatch')
      return succeed({
        file,
        pages: result.pages,
        ...(result.truncatedAt !== null
          ? {
              truncatedAt: result.truncatedAt,
              guidance: `The budget ran out on page ${result.truncatedAt}; later pages were not read. Call again from that page, or raise maxChars.`
            }
          : {})
      })
    }
    const result = await reader.read({
      kind: 'overview',
      path: file,
      ...(args.depth !== undefined ? { depth: args.depth } : {})
    })
    if (!result.ok) return readerFailure(result)
    if (result.kind !== 'overview') return internal('Unexpected reader answer.', 'reader-mismatch')
    const truncated = result.outlineTotal > result.outline.length
    return succeed({
      file,
      pages: result.pages,
      pageSize: result.pageSize,
      outline: result.outline,
      ...(truncated ? { outlineCount: result.outlineTotal, truncated: true } : {}),
      ...(result.preview !== null ? { preview: result.preview } : {}),
      guidance: truncated
        ? `The outline has ${result.outlineTotal} entries; the first ${result.outline.length} are listed. Pass depth for the upper levels.`
        : result.outline.length
          ? 'Pick a section from the outline and read its pages, or query for a phrase to find the page.'
          : 'No outline; preview is the first page. Use query to find the pages you need.'
    })
  }
})
