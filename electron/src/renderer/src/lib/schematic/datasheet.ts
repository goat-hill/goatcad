/**
 * What Show Datasheet (D) opens for a symbol's Datasheet field — a web
 * address, as KiCad's `GetAssociatedDocument` sends anything that reads as a
 * URL to the browser. KiCad's `~` means "none". A bare `www.` host gets the
 * scheme a browser would give it. Anything else (a local path, an
 * environment-variable path) is not a link this opens.
 */
export function datasheetUrl(value: string | undefined): string | null {
  const text = (value ?? '').trim()
  if (!text || text === '~') return null
  const candidate = /^www\./i.test(text) ? `https://${text}` : text
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return null
  }
  return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null
}

export type DatasheetTarget = { kind: 'url'; url: string } | { kind: 'file'; path: string }

/**
 * Where a Datasheet field's value leads: a web address to the browser, or a
 * file to the app's own tab. A project file is written `${KIPRJMOD}/…` so it
 * resolves on any checkout (`parts_cache_datasheet`); an absolute path is taken as
 * it is. `projectDir` is the design's folder.
 */
export function datasheetTarget(
  value: string | undefined,
  projectDir: string | null
): DatasheetTarget | null {
  const url = datasheetUrl(value)
  if (url) return { kind: 'url', url }
  const text = (value ?? '').trim()
  const project = /^\$\{KIPRJMOD\}[\\/](.+)$/.exec(text)
  if (project) {
    if (!projectDir) return null
    const separator = projectDir.includes('\\') && !projectDir.includes('/') ? '\\' : '/'
    return { kind: 'file', path: `${projectDir.replace(/[\\/]+$/, '')}${separator}${project[1]}` }
  }
  if (/^(\/|[A-Za-z]:[\\/])/.test(text)) return { kind: 'file', path: text }
  return null
}
