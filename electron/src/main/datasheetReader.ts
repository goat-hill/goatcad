/**
 * Reading PDFs through the pdfium wasm build (`src/main/wasm/`, built by
 * `electron/wasm/pdfium/build.sh`): the document wrapper over the flat C ABI,
 * and the reader that answers `parts.read_datasheet` from a small cache of
 * open documents. Electron-free and worker-agnostic — the worker
 * (`datasheetWorker.ts`) and the tests both drive this directly.
 */
import { readFileSync, statSync } from 'node:fs'
import type { PdfiumModule } from './wasm/pdfium.js'
import { layoutText, searchable, type GlyphBox } from './datasheetText'
import { encodePng } from './png'

export interface PageSize {
  width: number
  height: number
}

export interface OutlineEntry {
  depth: number
  /** 1-based; null when the bookmark points nowhere. */
  page: number | null
  title: string
}

export interface Region {
  x: number
  y: number
  width: number
  height: number
}

/** Rendered pixels stay under this so a page image is one picture a model
 *  can take, not a payload that fails on size; scale is reduced to fit. */
export const MAX_RENDER_PIXELS = 4_000_000

/** One open document: a handle into the module plus the bytes it reads from,
 *  which must outlive it (pdfium reads lazily). */
export class PdfDocument {
  private constructor(
    private readonly m: PdfiumModule,
    private readonly doc: number,
    private readonly bytesPtr: number,
    readonly pageCount: number
  ) {}

  /** Throws with pdfium's error code when the bytes are not a readable PDF. */
  static open(m: PdfiumModule, bytes: Uint8Array): PdfDocument {
    const ptr = m._malloc(bytes.length)
    m.HEAPU8.set(bytes, ptr)
    const doc = m._goat_pdf_open(ptr, bytes.length)
    if (!doc) {
      const code = m._goat_pdf_error()
      m._free(ptr)
      throw new Error(`pdfium could not open the document (error ${code})`)
    }
    return new PdfDocument(m, doc, ptr, m._goat_pdf_page_count(doc))
  }

  close(): void {
    this.m._goat_pdf_close(this.doc)
    this.m._free(this.bytesPtr)
  }

  /** In points; index is 0-based. */
  pageSize(index: number): PageSize {
    const out = this.m._malloc(8)
    const ok = this.m._goat_pdf_page_size(this.doc, index, out)
    const view = this.m.HEAPF32
    const size = { width: view[out >> 2], height: view[(out >> 2) + 1] }
    this.m._free(out)
    if (!ok) throw new RangeError(`no page ${index}`)
    return size
  }

  glyphs(index: number): GlyphBox[] {
    const countPtr = this.m._malloc(4)
    const ptr = this.m._goat_pdf_page_chars(this.doc, index, countPtr)
    const count = this.m.HEAP32[countPtr >> 2]
    this.m._free(countPtr)
    const out: GlyphBox[] = []
    if (ptr) {
      // GoatChar: uint32 unicode, then five floats — see glue.cpp.
      const u32 = this.m.HEAPU32
      const f32 = this.m.HEAPF32
      for (let i = 0; i < count; i++) {
        const base = (ptr >> 2) + i * 6
        out.push({
          code: u32[base],
          x0: f32[base + 1],
          y0: f32[base + 2],
          x1: f32[base + 3],
          y1: f32[base + 4],
          fontSize: f32[base + 5]
        })
      }
      this.m._goat_pdf_free(ptr)
    }
    return out
  }

  /** The page's text with its layout kept (`datasheetText.ts`). */
  text(index: number): string {
    return layoutText(this.glyphs(index))
  }

  outline(): OutlineEntry[] {
    const lenPtr = this.m._malloc(4)
    const ptr = this.m._goat_pdf_outline(this.doc, lenPtr)
    const len = this.m.HEAP32[lenPtr >> 2]
    this.m._free(lenPtr)
    if (!ptr) return []
    const text = utf16(this.m.HEAPU16, ptr, len)
    this.m._goat_pdf_free(ptr)
    const entries: OutlineEntry[] = []
    for (const line of text.split('\n')) {
      const [depth, page, ...title] = line.split('\t')
      if (title.length === 0) continue
      const pageIndex = Number(page)
      entries.push({
        depth: Number(depth),
        page: pageIndex >= 0 ? pageIndex + 1 : null,
        title: title.join('\t').trim()
      })
    }
    return entries
  }

  /** `region` in points, top-left origin; scale in pixels per point. The
   *  scale actually used comes back, reduced when the picture would exceed
   *  MAX_RENDER_PIXELS. */
  render(
    index: number,
    scale: number,
    region?: Region
  ): { width: number; height: number; scale: number; frame: Region; png: Buffer } {
    const size = this.pageSize(index)
    const frame = region
      ? clampRegion(region, size)
      : { x: 0, y: 0, width: size.width, height: size.height }
    let used = scale
    const pixels = frame.width * frame.height * scale * scale
    if (pixels > MAX_RENDER_PIXELS) used = scale * Math.sqrt(MAX_RENDER_PIXELS / pixels)
    const clipPtr = this.m._malloc(16)
    this.m.HEAPF32.set(
      [frame.x, frame.y, frame.x + frame.width, frame.y + frame.height],
      clipPtr >> 2
    )
    const whPtr = this.m._malloc(8)
    const px = this.m._goat_pdf_render(this.doc, index, used, clipPtr, whPtr)
    const width = this.m.HEAP32[whPtr >> 2]
    const height = this.m.HEAP32[(whPtr >> 2) + 1]
    this.m._free(clipPtr)
    this.m._free(whPtr)
    if (!px) throw new Error('render produced no pixels')
    const bgra = this.m.HEAPU8.subarray(px, px + width * height * 4)
    const png = encodePng(bgra, width, height)
    this.m._goat_pdf_free(px)
    return { width, height, scale: used, frame, png }
  }
}

const utf16 = (heap: Uint16Array, ptr: number, len: number): string => {
  let out = ''
  const start = ptr >> 1
  for (let i = 0; i < len; i += 8192) {
    out += String.fromCharCode(...heap.subarray(start + i, start + Math.min(len, i + 8192)))
  }
  return out
}

const clampRegion = (region: Region, page: PageSize): Region => {
  const x = Math.max(0, Math.min(region.x, page.width))
  const y = Math.max(0, Math.min(region.y, page.height))
  return {
    x,
    y,
    width: Math.max(1, Math.min(region.width, page.width - x)),
    height: Math.max(1, Math.min(region.height, page.height - y))
  }
}

// --- The reader behind the operation -------------------------------------

export type DatasheetReadRequest =
  /** `depth` keeps outline entries at that depth or above (0 is the top level). */
  | { kind: 'overview'; path: string; depth?: number }
  | { kind: 'text'; path: string; pages: number[]; maxChars: number }
  | { kind: 'search'; path: string; query: string; maxHits: number }
  | { kind: 'render'; path: string; page: number; scale: number; region?: Region }

export interface SearchHit {
  page: number
  text: string
}

export type DatasheetReadResult =
  | {
      ok: true
      kind: 'overview'
      pages: number
      pageSize: PageSize
      /** At most MAX_OUTLINE entries, in document order. */
      outline: OutlineEntry[]
      /** Entries within the depth asked, before the cap. */
      outlineTotal: number
      /** The first page's text, for a document with no outline to orient by. */
      preview: string | null
    }
  | {
      ok: true
      kind: 'text'
      pages: { page: number; text: string }[]
      /** The page the character budget ran out on, when it did. */
      truncatedAt: number | null
    }
  | {
      ok: true
      kind: 'search'
      hits: SearchHit[]
      totalHits: number
      pagesWithHits: number[]
    }
  | {
      ok: true
      kind: 'render'
      page: number
      scale: number
      frame: Region
      width: number
      height: number
      pngBase64: string
    }
  | {
      ok: false
      error: 'not-found' | 'not-a-pdf' | 'unreadable' | 'bad-page' | 'internal'
      message: string
    }

interface CachedDocument {
  doc: PdfDocument
  mtimeMs: number
  size: number
  lastUsed: number
}

/** Documents kept open between calls: an agent reads several pages of the
 *  same file in a row, and parsing a 30 MB datasheet once is enough. */
const OPEN_DOCUMENTS = 2
/** Bookmark entries beyond this are noise, not a map. */
export const MAX_OUTLINE = 400
const PREVIEW_CHARS = 1500

export class DatasheetReader {
  private modulePromise: Promise<PdfiumModule> | null = null
  private readonly open = new Map<string, CachedDocument>()

  constructor(private readonly load: () => Promise<PdfiumModule>) {}

  async read(request: DatasheetReadRequest): Promise<DatasheetReadResult> {
    const opened = await this.document(request.path)
    if (!opened.ok) return opened
    const doc = opened.doc
    try {
      switch (request.kind) {
        case 'overview': {
          const depth = request.depth
          const entries = doc
            .outline()
            .filter((entry) => depth === undefined || entry.depth <= depth)
          const outline = entries.slice(0, MAX_OUTLINE)
          return {
            ok: true,
            kind: 'overview',
            pages: doc.pageCount,
            pageSize: doc.pageSize(0),
            outline,
            outlineTotal: entries.length,
            preview: outline.length ? null : doc.text(0).slice(0, PREVIEW_CHARS)
          }
        }
        case 'text': {
          const bad = request.pages.find((p) => p < 1 || p > doc.pageCount)
          if (bad !== undefined) return badPage(bad, doc.pageCount)
          const pages: { page: number; text: string }[] = []
          let budget = request.maxChars
          let truncatedAt: number | null = null
          for (const page of request.pages) {
            const text = doc.text(page - 1)
            if (text.length > budget) {
              pages.push({ page, text: text.slice(0, Math.max(0, budget)) })
              truncatedAt = page
              break
            }
            pages.push({ page, text })
            budget -= text.length
          }
          return { ok: true, kind: 'text', pages, truncatedAt }
        }
        case 'search': {
          const needle = searchable(request.query)
          const hits: SearchHit[] = []
          const pagesWithHits: number[] = []
          let totalHits = 0
          if (needle) {
            for (let i = 0; i < doc.pageCount; i++) {
              let onPage = 0
              for (const line of doc.text(i).split('\n')) {
                const flat = searchable(line)
                if (!flat.includes(needle)) continue
                onPage++
                totalHits++
                if (hits.length < request.maxHits) hits.push({ page: i + 1, text: flat })
              }
              if (onPage) pagesWithHits.push(i + 1)
            }
          }
          return { ok: true, kind: 'search', hits, totalHits, pagesWithHits }
        }
        case 'render': {
          if (request.page < 1 || request.page > doc.pageCount) {
            return badPage(request.page, doc.pageCount)
          }
          const image = doc.render(request.page - 1, request.scale, request.region)
          return {
            ok: true,
            kind: 'render',
            page: request.page,
            scale: image.scale,
            frame: image.frame,
            width: image.width,
            height: image.height,
            pngBase64: image.png.toString('base64')
          }
        }
      }
    } catch (err) {
      return {
        ok: false,
        error: 'internal',
        message: err instanceof Error ? err.message : String(err)
      }
    }
  }

  /** Close every document and forget the module; the next read reloads. */
  dispose(): void {
    for (const entry of this.open.values()) entry.doc.close()
    this.open.clear()
    this.modulePromise = null
  }

  private async document(
    path: string
  ): Promise<{ ok: true; doc: PdfDocument } | Extract<DatasheetReadResult, { ok: false }>> {
    let stat: { mtimeMs: number; size: number }
    try {
      stat = statSync(path)
    } catch {
      return { ok: false, error: 'not-found', message: `No file at ${path}.` }
    }
    const cached = this.open.get(path)
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      cached.lastUsed = Date.now()
      return { ok: true, doc: cached.doc }
    }
    if (cached) {
      cached.doc.close()
      this.open.delete(path)
    }
    let bytes: Buffer
    try {
      bytes = readFileSync(path)
    } catch {
      return { ok: false, error: 'unreadable', message: `${path} could not be read.` }
    }
    if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') {
      return { ok: false, error: 'not-a-pdf', message: `${path} is not a PDF.` }
    }
    this.modulePromise ??= this.load()
    const m = await this.modulePromise
    let doc: PdfDocument
    try {
      doc = PdfDocument.open(m, bytes)
    } catch (err) {
      return {
        ok: false,
        error: 'unreadable',
        message: err instanceof Error ? err.message : String(err)
      }
    }
    this.evict()
    this.open.set(path, { doc, mtimeMs: stat.mtimeMs, size: stat.size, lastUsed: Date.now() })
    return { ok: true, doc }
  }

  private evict(): void {
    while (this.open.size >= OPEN_DOCUMENTS) {
      let oldest: [string, CachedDocument] | null = null
      for (const entry of this.open) {
        if (!oldest || entry[1].lastUsed < oldest[1].lastUsed) oldest = entry
      }
      if (!oldest) return
      oldest[1].doc.close()
      this.open.delete(oldest[0])
    }
  }
}

const badPage = (page: number, count: number): DatasheetReadResult => ({
  ok: false,
  error: 'bad-page',
  message: `Page ${page} is out of range; the document has ${count} page${count === 1 ? '' : 's'}.`
})
