/**
 * Cross-platform path arithmetic on plain strings — no Node `path`, since these
 * run in the renderer against KiCad file references that may use either
 * separator. Separator-preserving by design: a Windows reference keeps its
 * backslashes so a rewrite round-trips byte-for-byte.
 *
 * Extracted from hierarchy.ts so the reference registry (references.ts) and the
 * hierarchy resolver share one implementation of relative-path resolution — the
 * exact operation both need to answer "what file does this reference point at?"
 */

/** The separator a path uses; `\` only when it actually contains one. */
export const separatorOf = (path: string): string => (path.includes('\\') ? '\\' : '/')

/** Directory portion of a path, or '' for a bare name / filesystem root. */
export const dirnameOf = (path: string): string => {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return index <= 0 ? '' : path.slice(0, index)
}

/** Final path segment. */
export const basenameOf = (path: string): string => {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return index < 0 ? path : path.slice(index + 1)
}

/**
 * Resolve a (possibly relative, possibly `../`) reference against a base dir.
 * Absolute inputs (leading separator or `C:` drive) pass through untouched;
 * `.` and empty segments are skipped and `..` pops, KiCad's Sheetfile rules.
 */
export const resolveRelativePath = (baseDir: string, ref: string): string => {
  const separator = separatorOf(baseDir || ref)
  const normalized = ref.replace(/[\\/]+/g, separator)
  if (normalized.startsWith(separator) || /^[a-zA-Z]:/.test(normalized)) return normalized
  const segments = baseDir ? baseDir.split(separator) : []
  for (const segment of normalized.split(separator)) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') segments.pop()
    else segments.push(segment)
  }
  return segments.join(separator)
}

/** Case-insensitive, separator-insensitive path equality (macOS/Windows-safe). */
export const samePath = (a: string, b: string): boolean =>
  a.replace(/[\\/]+/g, '/').toLowerCase() === b.replace(/[\\/]+/g, '/').toLowerCase()

/**
 * Swap the final segment of a reference for `newBasename`, preserving its
 * directory prefix and separator. A rename keeps a file in its directory, so
 * this turns `../power.kicad_sch` into `../regulator.kicad_sch` and a bare
 * `power.kicad_sch` into `regulator.kicad_sch`.
 */
export const rebaseReference = (ref: string, newBasename: string): string => {
  const index = Math.max(ref.lastIndexOf('/'), ref.lastIndexOf('\\'))
  return index < 0 ? newBasename : ref.slice(0, index + 1) + newBasename
}
