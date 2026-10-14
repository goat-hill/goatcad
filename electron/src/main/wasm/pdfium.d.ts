/**
 * Hand-written types for the generated Emscripten loader (`pdfium.js`, built
 * by `electron/wasm/pdfium/build.sh`). The surface is exactly what the glue
 * exports — see `electron/wasm/pdfium/glue.cpp` for each function's contract.
 * Every coordinate crossing the boundary is in page points with a top-left
 * origin and y growing downward.
 *
 * The heap views are replaced wholesale when wasm memory grows, so read them
 * off the module at each use; never cache one across a call that allocates.
 */

export interface PdfiumModule {
  _goat_pdf_open(data: number, len: number): number
  _goat_pdf_error(): number
  _goat_pdf_close(doc: number): void
  _goat_pdf_page_count(doc: number): number
  _goat_pdf_page_size(doc: number, index: number, outWH: number): number
  _goat_pdf_page_text(doc: number, index: number, outLen: number): number
  _goat_pdf_page_chars(doc: number, index: number, outCount: number): number
  _goat_pdf_render(doc: number, index: number, scale: number, clip: number, outWH: number): number
  _goat_pdf_outline(doc: number, outLen: number): number
  _goat_pdf_free(ptr: number): void
  _malloc(bytes: number): number
  _free(ptr: number): void
  HEAPU8: Uint8Array
  HEAPU16: Uint16Array
  HEAP32: Int32Array
  HEAPU32: Uint32Array
  HEAPF32: Float32Array
}

declare const createPdfium: (options?: {
  locateFile?: (file: string) => string
}) => Promise<PdfiumModule>

export default createPdfium
