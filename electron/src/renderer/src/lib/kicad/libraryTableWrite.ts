/**
 * Writing KiCad's project-tier library tables — `sym-lib-table` and
 * `fp-lib-table`, the S-expression files that sit next to a `.kicad_pro` and
 * say which libraries *this project* pulls from
 * (docs/projects.md §7.5).
 *
 * Reading is `symbolLibraryTable.ts`; this is the other direction, and it is
 * deliberately **text-preserving rather than AST-regenerating**: KiCad writes
 * these files in its own single-line-per-lib style, and a project we touch
 * should diff by the one row we added, not by wholesale reformatting
 * (RULES.md §7). Adding a row is therefore an insertion before the closing paren,
 * not a parse-and-rewrite.
 */

export type LibraryTableKind = 'symbol' | 'footprint'

/** Root token and filename for each table. */
export const TABLE_TOKEN: Record<LibraryTableKind, string> = {
  symbol: 'sym_lib_table',
  footprint: 'fp_lib_table'
}

export const TABLE_FILENAME: Record<LibraryTableKind, string> = {
  symbol: 'sym-lib-table',
  footprint: 'fp-lib-table'
}

/** Split a path on either separator, tolerating both platforms' conventions. */
const segments = (path: string): string[] => path.split(/[/\\]/).filter(Boolean)

/**
 * Whether `absolutePath` sits under `dir`. Compared case-insensitively:
 * macOS/Windows resolve paths differing only by case onto the same file, and a
 * false mismatch here would treat a file genuinely inside the project as
 * outside it.
 */
export function pathIsInside(absolutePath: string, dir: string): boolean {
  const target = segments(absolutePath)
  const base = segments(dir)
  if (target.length <= base.length) return false
  return base.every((part, i) => part.toLowerCase() === target[i].toLowerCase())
}

/**
 * The URI to record for `absolutePath`. A target inside the project is written
 * `${KIPRJMOD}`-relative so the entry still resolves on a collaborator's
 * machine — an absolute path is legal but silently breaks the moment the design
 * is shared, which is the most common "missing symbols" report in KiCad.
 */
export function projectLibUri(absolutePath: string, projectDir: string): string {
  if (!pathIsInside(absolutePath, projectDir)) return absolutePath
  return `\${KIPRJMOD}/${segments(absolutePath).slice(segments(projectDir).length).join('/')}`
}

/** Escape a value for an S-expression quoted atom. */
const quote = (value: string): string => `"${value.replace(/(["\\])/g, '\\$1')}"`

/** One `(lib …)` row in KiCad's own single-line shape. */
export const libRow = (nickname: string, uri: string, descr = ''): string =>
  `  (lib (name ${quote(nickname)})(type "KiCad")(uri ${quote(uri)})(options "")(descr ${quote(descr)}))`

/** Nicknames already present in a table document. */
export function tableNicknames(source: string): string[] {
  return [...source.matchAll(/\(name\s+"((?:[^"\\]|\\.)*)"\)/g)].map((match) =>
    match[1].replace(/\\(["\\])/g, '$1')
  )
}

/**
 * A nickname not already taken, suffixed `-1`, `-2`, … The nickname is the
 * part's identity (`lib_id` is `Nickname:Name`), so a collision would silently
 * shadow an existing library rather than add one.
 */
export function uniqueNickname(base: string, taken: string[]): string {
  const used = new Set(taken.map((name) => name.toLowerCase()))
  if (!used.has(base.toLowerCase())) return base
  for (let index = 1; ; index++) {
    const candidate = `${base}-${index}`
    if (!used.has(candidate.toLowerCase())) return candidate
  }
}

/**
 * Insert a row into a table document, creating the document when absent (KiCad
 * only writes a project table once something is added at project scope, so
 * "no file" is the normal starting state). Existing content is preserved
 * verbatim; the row goes before the final closing paren.
 */
export function addLibraryToTable(
  source: string | null,
  kind: LibraryTableKind,
  nickname: string,
  uri: string,
  descr = ''
): string {
  const row = libRow(nickname, uri, descr)
  if (source === null || source.trim() === '') {
    return `(${TABLE_TOKEN[kind]}\n  (version 7)\n${row}\n)\n`
  }

  const close = source.lastIndexOf(')')
  if (close === -1) throw new Error(`Malformed ${TABLE_FILENAME[kind]}: no closing paren`)

  const head = source.slice(0, close).replace(/\s*$/, '')
  const tail = source.slice(close)
  return `${head}\n${row}\n${tail}`
}

/**
 * The nickname of the row that already names `absolutePath`, or null. A
 * `${KIPRJMOD}` uri resolves against `projectDir`; paths compare
 * case-insensitively, as `pathIsInside` does.
 */
export function tableNicknameFor(
  source: string | null,
  absolutePath: string,
  projectDir: string
): string | null {
  if (!source) return null
  const unquote = (value: string): string => value.replace(/\\(["\\])/g, '$1')
  const normal = (path: string): string => segments(path).join('/').toLowerCase()
  const wanted = normal(absolutePath)
  // KiCad writes one row per line.
  for (const row of source.split('\n').filter((line) => line.includes('(lib'))) {
    const name = /\(name\s+"((?:[^"\\]|\\.)*)"\)/.exec(row)
    const uri = /\(uri\s+"((?:[^"\\]|\\.)*)"\)/.exec(row)
    if (!name || !uri) continue
    const resolved = unquote(uri[1]).replace(/^\$\{KIPRJMOD\}/, projectDir)
    if (normal(resolved) === wanted) return unquote(name[1])
  }
  return null
}
