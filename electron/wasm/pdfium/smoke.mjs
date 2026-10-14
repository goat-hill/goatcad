// Smoke test for the build: loads src/main/wasm/pdfium.js, opens a PDF generated
// here, extracts its text and renders page 1. Run with a plain `node`.
import createPdfium from '../../src/main/wasm/pdfium.js'

const TEXT = 'Hello GoatCAD 3V3 100nF'

function minimalPdf(text) {
  const content = `BT /F1 24 Tf 20 40 Td (${text}) Tj ET`
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ]
  let out = '%PDF-1.4\n'
  const offsets = []
  objs.forEach((body, i) => {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

async function main() {
  const t0 = performance.now()
  const m = await createPdfium()
  const tLoad = performance.now() - t0

  const pdf = minimalPdf(TEXT)
  const ptr = m._malloc(pdf.length)
  m.HEAPU8.set(pdf, ptr)
  const doc = m._goat_pdf_open(ptr, pdf.length)
  if (!doc) throw new Error(`goat_pdf_open failed, FPDF error ${m._goat_pdf_error()}`)
  const pages = m._goat_pdf_page_count(doc)

  const sizePtr = m._malloc(8)
  m._goat_pdf_page_size(doc, 0, sizePtr)
  const pageSizePt = Array.from(m.HEAPF32.subarray(sizePtr >> 2, (sizePtr >> 2) + 2))
  m._free(sizePtr)

  const lenPtr = m._malloc(4)
  const textPtr = m._goat_pdf_page_text(doc, 0, lenPtr)
  const len = m.HEAP32[lenPtr >> 2]
  const text = String.fromCharCode(...m.HEAPU16.subarray(textPtr >> 1, (textPtr >> 1) + len))
  m._goat_pdf_free(textPtr)

  const charsPtr = m._goat_pdf_page_chars(doc, 0, lenPtr)
  const count = m.HEAP32[lenPtr >> 2]
  // GoatChar is 7 x 4 bytes: unicode, x0, y0, x1, y1, fontSize
  const first = {
    ch: String.fromCharCode(m.HEAPU32[charsPtr >> 2]),
    box: Array.from(m.HEAPF32.subarray((charsPtr >> 2) + 1, (charsPtr >> 2) + 5)).map(
      (v) => +v.toFixed(1)
    ),
    fontSize: m.HEAPF32[(charsPtr >> 2) + 5]
  }
  m._goat_pdf_free(charsPtr)
  m._free(lenPtr)

  const scale = 2
  const whPtr = m._malloc(8)
  const t1 = performance.now()
  const px = m._goat_pdf_render(doc, 0, scale, 0, whPtr)
  const tRender = performance.now() - t1
  const [w, h] = [m.HEAP32[whPtr >> 2], m.HEAP32[(whPtr >> 2) + 1]]
  let dark = 0
  const bgra = m.HEAPU8.subarray(px, px + w * h * 4)
  for (let i = 0; i < bgra.length; i += 4) if (bgra[i] < 128) dark++
  m._goat_pdf_free(px)

  // A clip around the first glyph must render darker per pixel than the page.
  const clipPtr = m._malloc(16)
  m.HEAPF32.set([first.box[0], first.box[1], first.box[2], first.box[3]], clipPtr >> 2)
  const px2 = m._goat_pdf_render(doc, 0, 4, clipPtr, whPtr)
  const [cw, chh] = [m.HEAP32[whPtr >> 2], m.HEAP32[(whPtr >> 2) + 1]]
  let dark2 = 0
  const bgra2 = m.HEAPU8.subarray(px2, px2 + cw * chh * 4)
  for (let i = 0; i < bgra2.length; i += 4) if (bgra2[i] < 128) dark2++
  m._goat_pdf_free(px2)
  m._free(clipPtr)
  m._free(whPtr)

  m._goat_pdf_close(doc)
  m._free(ptr)

  const result = {
    moduleLoadMs: Math.round(tLoad),
    pages,
    pageSizePt,
    text,
    textMatches: text === TEXT,
    chars: { count, first },
    render: { w, h, ms: Math.round(tRender), darkFraction: +(dark / (w * h)).toFixed(4) },
    clipRender: { w: cw, h: chh, darkFraction: +(dark2 / (cw * chh)).toFixed(4) }
  }
  console.log(JSON.stringify(result, null, 2))
  const ok =
    text === TEXT && count === TEXT.length && dark > 100 && dark2 / (cw * chh) > dark / (w * h)
  process.exit(ok ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
