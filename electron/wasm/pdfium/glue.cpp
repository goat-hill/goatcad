// GoatCAD's flat C ABI over pdfium, for the wasm build (see build.sh).
//
// Only these functions are exported, so the linker drops every part of pdfium
// they do not reach. Every coordinate that crosses the boundary is in page
// points with the origin at the page's top-left corner and y growing
// downward — the frame a rendered page image is in — so text boxes and
// render clips line up with pixels by a single scale factor. All buffers
// returned are malloc'd and released with goat_pdf_free.
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>

#include "fpdf_doc.h"
#include "fpdf_text.h"
#include "fpdfview.h"

extern "C" {

struct GoatChar {
  uint32_t unicode;
  float x0, y0, x1, y1;  // loose glyph box, top-left origin
  float fontSize;
};

static bool g_initialized = false;
static unsigned long g_lastError = 0;

static void ensureLibrary() {
  if (g_initialized) return;
  FPDF_LIBRARY_CONFIG config = {};
  config.version = 2;
  FPDF_InitLibraryWithConfig(&config);
  g_initialized = true;
}

// Returns a document handle, or 0 with goat_pdf_error() set. The bytes must
// stay alive until goat_pdf_close: pdfium reads from them lazily.
FPDF_DOCUMENT goat_pdf_open(const uint8_t* data, int32_t len) {
  ensureLibrary();
  FPDF_DOCUMENT doc = FPDF_LoadMemDocument(data, len, nullptr);
  g_lastError = doc ? 0 : FPDF_GetLastError();
  return doc;
}

uint32_t goat_pdf_error() { return static_cast<uint32_t>(g_lastError); }

void goat_pdf_close(FPDF_DOCUMENT doc) {
  if (doc) FPDF_CloseDocument(doc);
}

int32_t goat_pdf_page_count(FPDF_DOCUMENT doc) { return FPDF_GetPageCount(doc); }

// out[0] = width, out[1] = height, in points. Returns 0 on a bad index.
int32_t goat_pdf_page_size(FPDF_DOCUMENT doc, int32_t index, float* out) {
  FS_SIZEF size;
  if (!FPDF_GetPageSizeByIndexF(doc, index, &size)) return 0;
  out[0] = size.width;
  out[1] = size.height;
  return 1;
}

// The page's text in pdfium's reading order as UTF-16LE, *outLen code units,
// no terminator. Line breaks are pdfium's own.
uint16_t* goat_pdf_page_text(FPDF_DOCUMENT doc, int32_t index, int32_t* outLen) {
  *outLen = 0;
  FPDF_PAGE page = FPDF_LoadPage(doc, index);
  if (!page) return nullptr;
  FPDF_TEXTPAGE text = FPDFText_LoadPage(page);
  uint16_t* buf = nullptr;
  if (text) {
    int count = FPDFText_CountChars(text);
    if (count > 0) {
      buf = static_cast<uint16_t*>(malloc(sizeof(uint16_t) * (count + 1)));
      int written = FPDFText_GetText(text, 0, count, buf);
      *outLen = written > 0 ? written - 1 : 0;
    }
    FPDFText_ClosePage(text);
  }
  FPDF_ClosePage(page);
  return buf;
}

// One record per character with its glyph box, for layout reconstruction on
// the JS side (columns, tables). *outCount records.
GoatChar* goat_pdf_page_chars(FPDF_DOCUMENT doc, int32_t index, int32_t* outCount) {
  *outCount = 0;
  FPDF_PAGE page = FPDF_LoadPage(doc, index);
  if (!page) return nullptr;
  const float pageHeight = static_cast<float>(FPDF_GetPageHeightF(page));
  FPDF_TEXTPAGE text = FPDFText_LoadPage(page);
  GoatChar* out = nullptr;
  if (text) {
    int count = FPDFText_CountChars(text);
    if (count > 0) {
      out = static_cast<GoatChar*>(malloc(sizeof(GoatChar) * count));
      for (int i = 0; i < count; i++) {
        FS_RECTF r = {};
        FPDFText_GetLooseCharBox(text, i, &r);
        out[i].unicode = FPDFText_GetUnicode(text, i);
        out[i].x0 = r.left;
        out[i].x1 = r.right;
        // PDF user space has y up from the bottom edge; flip to top-left origin.
        out[i].y0 = pageHeight - r.top;
        out[i].y1 = pageHeight - r.bottom;
        out[i].fontSize = static_cast<float>(FPDFText_GetFontSize(text, i));
      }
      *outCount = count;
    }
    FPDFText_ClosePage(text);
  }
  FPDF_ClosePage(page);
  return out;
}

// Renders `clip` (x0, y0, x1, y1 in top-left-origin points; null = whole
// page) at `scale` pixels per point. Returns BGRA8 rows, tightly packed,
// outWH[0] x outWH[1] pixels, on white.
uint8_t* goat_pdf_render(FPDF_DOCUMENT doc, int32_t index, float scale, const float* clip,
                         int32_t* outWH) {
  outWH[0] = outWH[1] = 0;
  FPDF_PAGE page = FPDF_LoadPage(doc, index);
  if (!page) return nullptr;
  float x0 = 0, y0 = 0;
  float x1 = static_cast<float>(FPDF_GetPageWidthF(page));
  float y1 = static_cast<float>(FPDF_GetPageHeightF(page));
  if (clip) {
    x0 = clip[0];
    y0 = clip[1];
    x1 = clip[2];
    y1 = clip[3];
  }
  const int w = static_cast<int>((x1 - x0) * scale + 0.5f);
  const int h = static_cast<int>((y1 - y0) * scale + 0.5f);
  uint8_t* out = nullptr;
  if (w > 0 && h > 0) {
    FPDF_BITMAP bitmap = FPDFBitmap_CreateEx(w, h, FPDFBitmap_BGRA, nullptr, 0);
    if (bitmap) {
      FPDFBitmap_FillRect(bitmap, 0, 0, w, h, 0xFFFFFFFF);
      // With the identity matrix pdfium draws the page at one pixel per point,
      // top-left origin; scale about that origin and shift the clip to it.
      FS_MATRIX matrix = {scale, 0, 0, scale, -x0 * scale, -y0 * scale};
      FS_RECTF clipping = {0, 0, static_cast<float>(w), static_cast<float>(h)};
      FPDF_RenderPageBitmapWithMatrix(bitmap, page, &matrix, &clipping, FPDF_ANNOT);
      const int stride = FPDFBitmap_GetStride(bitmap);
      const uint8_t* src = static_cast<const uint8_t*>(FPDFBitmap_GetBuffer(bitmap));
      out = static_cast<uint8_t*>(malloc(static_cast<size_t>(w) * h * 4));
      for (int row = 0; row < h; row++) memcpy(out + row * w * 4, src + row * stride, w * 4);
      FPDFBitmap_Destroy(bitmap);
      outWH[0] = w;
      outWH[1] = h;
    }
  }
  FPDF_ClosePage(page);
  return out;
}

// The document's bookmark tree, depth first, as UTF-16LE lines of
// "<depth>\t<page index or -1>\t<title>\n". Datasheets mostly carry one, and
// it is the cheapest map of where things are. *outLen code units.
static void appendOutline(FPDF_DOCUMENT doc, FPDF_BOOKMARK node, int depth,
                          std::vector<uint16_t>& out) {
  for (; node; node = FPDFBookmark_GetNextSibling(doc, node)) {
    if (out.size() > 200000) return;  // a pathological tree is not a map
    int page = -1;
    FPDF_DEST dest = FPDFBookmark_GetDest(doc, node);
    if (!dest) {
      FPDF_ACTION action = FPDFBookmark_GetAction(node);
      if (action && FPDFAction_GetType(action) == PDFACTION_GOTO) dest = FPDFAction_GetDest(doc, action);
    }
    if (dest) page = FPDFDest_GetDestPageIndex(doc, dest);
    char prefix[32];
    int n = snprintf(prefix, sizeof prefix, "%d\t%d\t", depth, page);
    for (int i = 0; i < n; i++) out.push_back(static_cast<uint16_t>(prefix[i]));
    unsigned long bytes = FPDFBookmark_GetTitle(node, nullptr, 0);
    if (bytes > 2) {
      std::vector<uint16_t> title(bytes / 2);
      FPDFBookmark_GetTitle(node, title.data(), bytes);
      for (size_t i = 0; i + 1 < title.size(); i++) {
        uint16_t c = title[i];
        out.push_back(c == '\n' || c == '\t' ? ' ' : c);
      }
    }
    out.push_back('\n');
    if (depth < 8) appendOutline(doc, FPDFBookmark_GetFirstChild(doc, node), depth + 1, out);
  }
}

uint16_t* goat_pdf_outline(FPDF_DOCUMENT doc, int32_t* outLen) {
  *outLen = 0;
  std::vector<uint16_t> out;
  appendOutline(doc, FPDFBookmark_GetFirstChild(doc, nullptr), 0, out);
  if (out.empty()) return nullptr;
  uint16_t* buf = static_cast<uint16_t*>(malloc(sizeof(uint16_t) * out.size()));
  memcpy(buf, out.data(), sizeof(uint16_t) * out.size());
  *outLen = static_cast<int32_t>(out.size());
  return buf;
}

void goat_pdf_free(void* p) { free(p); }

}  // extern "C"
