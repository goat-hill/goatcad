/**
 * The reference registry (docs/projects.md §8.1). Each
 * *reference kind* describes one kind of edge in the design graph: a place
 * where one file names another.
 * A rename is then "an edit to a set of files, one of which happens to be the
 * file's own name" — the registry is what makes every referencing file findable
 * and rewritable from one table instead of a pile of special cases.
 *
 * Everything here is pure over (sourceFile, text): a kind reads references out
 * of a parsed document and, given a new value, splices them back in. The
 * splice edits only the value token's source span, so untouched bytes stay
 * byte-identical (the RULES.md §7 round-trip invariant) with no re-serialization.
 *
 * Scope note: alpha ships one kind, `sheet.file` — the `.kicad_sch` → child
 * `.kicad_sch` link a schematic rename breaks. The spec's `project.root` and
 * `project.board` are *not* rewritable path refs in the current data model
 * (root is UUID-keyed, board is filename-stem-matched), so they carry no edge
 * to forward; the library-URI and footprint-model kinds are later additions.
 */
import { dirnameOf, resolveRelativePath } from './paths'
import { findChildren, parseSExpr, type SExprAtom, type SExprList } from './sexpr'
import { canonicalSheetFieldName } from './schematic'

export type ReferenceKindId = 'sheet.file'

/** A reference discovered in one source file, with the span needed to rewrite it. */
export interface FoundReference {
  kind: ReferenceKindId
  /** Absolute path of the file that contains the reference. */
  sourceFile: string
  /** Raw stored value, exactly as written (e.g. `../power.kicad_sch`). */
  rawValue: string
  /** Absolute path it points at (separators as resolved), or null if unresolvable. */
  resolved: string | null
  /** Half-open source-text span of the value token, for a surgical splice. */
  span: { start: number; end: number }
  /** Whether the value token was quoted (governs how a new value is emitted). */
  quoted: boolean
}

/** How to find and characterize one kind of cross-file reference. */
export interface ReferenceKind {
  id: ReferenceKindId
  /** Lower-case extensions of files that may contain this kind of reference. */
  sourceExtensions: string[]
  /** Every reference of this kind in a parsed source file. Pure; never throws. */
  enumerate(sourceFile: string, text: string): FoundReference[]
}

const lowerExt = (path: string): string => {
  const dot = path.lastIndexOf('.')
  return dot < 0 ? '' : path.slice(dot).toLowerCase()
}

/** Atom children of a list, in order (token, then values). */
const atomChildren = (node: SExprList): SExprAtom[] =>
  node.children.filter((child): child is SExprAtom => child.type === 'atom')

// ---- sheet.file: a parent .kicad_sch's Sheetfile → a child .kicad_sch -------

const enumerateSheetFile = (sourceFile: string, text: string): FoundReference[] => {
  let root: SExprList
  try {
    const parsed = parseSExpr(text)
    if (parsed.type !== 'list') return []
    root = parsed
  } catch {
    return []
  }

  const baseDir = dirnameOf(sourceFile)
  const refs: FoundReference[] = []
  for (const sheet of findChildren(root, 'sheet')) {
    for (const property of findChildren(sheet, 'property')) {
      // `(property "Sheetfile" "power.kicad_sch" ...)` — atoms are
      // [token, key, value]; the value token is the one we splice.
      const atoms = atomChildren(property)
      if (atoms.length < 3 || canonicalSheetFieldName(atoms[1].value) !== 'sheetfile') continue
      const valueAtom = atoms[2]
      refs.push({
        kind: 'sheet.file',
        sourceFile,
        rawValue: valueAtom.value,
        resolved: resolveRelativePath(baseDir, valueAtom.value),
        span: { start: valueAtom.start, end: valueAtom.end },
        quoted: valueAtom.quoted
      })
    }
  }
  return refs
}

export const SHEET_FILE_KIND: ReferenceKind = {
  id: 'sheet.file',
  sourceExtensions: ['.kicad_sch'],
  enumerate: enumerateSheetFile
}

/** Every registered reference kind. */
export const REFERENCE_KINDS: readonly ReferenceKind[] = [SHEET_FILE_KIND]

/** Kinds whose source files carry the given path's extension. */
export const kindsForFile = (path: string): ReferenceKind[] => {
  const ext = lowerExt(path)
  return REFERENCE_KINDS.filter((kind) => kind.sourceExtensions.includes(ext))
}

/** Every reference in a file, across all kinds it can hold. Never throws. */
export const enumerateReferences = (sourceFile: string, text: string): FoundReference[] =>
  kindsForFile(sourceFile).flatMap((kind) => kind.enumerate(sourceFile, text))

// ---- rewriting --------------------------------------------------------------

/** Emit a value token the way sexpr.ts's serializer does, so quoting matches. */
const emitToken = (value: string, quoted: boolean): string => {
  if (!quoted) return value
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
  return `"${escaped}"`
}

export interface ReferenceRewrite {
  /** Value-token span to replace (from the FoundReference). */
  span: { start: number; end: number }
  quoted: boolean
  /** The new raw value to store. */
  newValue: string
}

/**
 * Apply value-token splices to a file's text. Non-overlapping spans are applied
 * right-to-left so earlier offsets stay valid; every byte outside a spliced span
 * is preserved exactly (no re-serialization, so the round-trip is trivially
 * lossless).
 */
export const applyReferenceRewrites = (text: string, rewrites: ReferenceRewrite[]): string => {
  const ordered = [...rewrites].sort((a, b) => b.span.start - a.span.start)
  let out = text
  for (const rewrite of ordered) {
    out =
      out.slice(0, rewrite.span.start) +
      emitToken(rewrite.newValue, rewrite.quoted) +
      out.slice(rewrite.span.end)
  }
  return out
}
