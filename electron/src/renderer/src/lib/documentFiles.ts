/**
 * Document-viewer file-type support: which extensions route to the PDF and
 * rendered-HTML viewer tabs (EditorArea), and the goatcad-media:// URL their
 * iframes load. The main process serves those URLs — streamed, with HTTP
 * Range support — in src/main/mediaProtocol.ts; `mediaUrlForPath` here is the
 * encoder for that module's decoder, so the two must change together.
 */

const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase()
}

/** True for files the PDF viewer tab handles. */
export const isPdfFile = (name: string): boolean => extensionOf(name) === 'pdf'

/** True for files the rendered-HTML viewer tab handles. */
export const isHtmlFile = (name: string): boolean => {
  const ext = extensionOf(name)
  return ext === 'html' || ext === 'htm'
}

/**
 * Absolute filesystem path → goatcad-media:// URL. Each path segment is
 * percent-encoded individually so the URL structure mirrors the filesystem —
 * that is what makes relative subresource references inside an HTML document
 * (img src="images/fig1.png") resolve to their real sibling files. A Windows
 * drive segment ("C:") takes the place of the POSIX leading slash.
 */
export const mediaUrlForPath = (absPath: string): string => {
  const segments = absPath
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s !== '')
    .map(encodeURIComponent)
  return `goatcad-media://local/${segments.join('/')}`
}
