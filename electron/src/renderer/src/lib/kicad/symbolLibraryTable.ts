// Parser for KiCad's project-tier `sym-lib-table` — the S-expr file that lives
// next to a `.kicad_pro` and lists the symbol libraries a project pulls from.
// Using KiCad's own format (rather than a GoatCAD sidecar) means a KiCad
// project's tables load as-is, and GoatCAD-authored projects open in KiCad.
//
// This is a source registry only: placed symbols are embedded in the schematic
// (see ensureLibSymbolsInAST), so an unresolved entry degrades gracefully — the
// design still renders; only *adding* new parts from that library is affected.

import { findChild, findChildren, getToken, parseSExpr, type SExprList } from './sexpr'

export interface RegisteredSymbolLibrary {
  /** Library nickname — the `lib_id` prefix (e.g. `Device` in `Device:R`). */
  nickname: string
  /** Absolute path to the `.kicad_sym` file, URI variables resolved. */
  path: string
  scope: 'global' | 'project'
}

/** Read the quoted value of a `(key "value")` child, or null. */
const field = (lib: SExprList, key: string): string | null => {
  const node = findChild(lib, key)
  const atom = node?.children[1]
  return atom && atom.type === 'atom' ? atom.value : null
}

/**
 * Expand the KiCad URI variables we can resolve locally. `${KIPRJMOD}` is the
 * project directory. Other vars (`${KICAD_SYMBOL_DIR}`, custom paths) are left
 * intact — the caller's read will simply miss, which is the graceful-degrade
 * path until global-tier resolution covers them.
 */
export function resolveLibUri(uri: string, projectDir: string | null): string {
  let out = uri
  // KiCad also reads the older `$(KIPRJMOD)`.
  if (projectDir) out = out.replace(/\$[{(]KIPRJMOD[})]/g, projectDir)
  return out
}

/**
 * Parse a `sym-lib-table` document into registered libraries. `projectDir`
 * resolves `${KIPRJMOD}`. Entries without a name or uri are skipped.
 */
export function parseSymLibTable(
  source: string,
  projectDir: string | null
): RegisteredSymbolLibrary[] {
  const parsed = parseSExpr(source)
  if (parsed.type !== 'list' || getToken(parsed) !== 'sym_lib_table') {
    throw new Error('Expected a KiCad (sym_lib_table ...) document')
  }
  const libs: RegisteredSymbolLibrary[] = []
  for (const lib of findChildren(parsed, 'lib')) {
    const nickname = field(lib, 'name')
    const uri = field(lib, 'uri')
    if (!nickname || !uri) continue
    libs.push({ nickname, path: resolveLibUri(uri, projectDir), scope: 'project' })
  }
  return libs
}
