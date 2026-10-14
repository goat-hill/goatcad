/**
 * The ERC rules about the libraries a design points into: a symbol whose
 * library the project does not have (or cannot read, or that lacks it), a
 * footprint field that does not resolve to a footprint, and — off by default
 * in KiCad — a footprint its symbol's filters would not offer. What the project
 * can reach comes in `ErcContext`; a fact not known yet keeps the rule quiet.
 */
import type { CheckResult, LibrarySymbolLookup } from './checks'
import type { SheetConnectivityInput } from './connectivity'
import type { ErcContext, LibraryState } from './ercContext'
import {
  definitionIdOf,
  getLibSymbolProperty,
  getSymbolProperty,
  referenceForSheetPath,
  type KicadSchematicSymbol
} from '../kicad/schematic'
import { asMm } from './schematicAgent'

/** `Nick:Name` split; null when either half is missing. */
const splitLibId = (text: string): { nickname: string; name: string } | null => {
  const colon = text.indexOf(':')
  if (colon <= 0 || colon === text.length - 1) return null
  return { nickname: text.slice(0, colon), name: text.slice(colon + 1) }
}

const perFile = (sheets: SheetConnectivityInput[]): SheetConnectivityInput[] => {
  const seen = new Set<object>()
  return sheets.filter(({ schematic }) => {
    if (seen.has(schematic)) return false
    seen.add(schematic)
    return true
  })
}

const finding = (
  code: string,
  severity: CheckResult['severity'],
  message: string,
  symbol: KicadSchematicSymbol,
  sheetPath: string,
  reference: string
): CheckResult => ({
  code,
  severity,
  message,
  items: [reference],
  position: { x: asMm(symbol.position.x), y: asMm(symbol.position.y) },
  sheetPath,
  targets: symbol.uuid ? [symbol.uuid] : [],
  kicadIds: symbol.uuid ? [symbol.uuid] : [],
  subject: reference
})

const referenceOf = (symbol: KicadSchematicSymbol, sheetPath: string): string =>
  referenceForSheetPath(symbol, sheetPath) ?? getSymbolProperty(symbol, 'Reference') ?? '?'

const libraryProblem = (
  state: LibraryState | undefined,
  kind: string,
  nickname: string
): string | null =>
  state === 'missing'
    ? `the project's ${kind} library tables do not include '${nickname}'`
    : state === 'disabled'
      ? `the ${kind} library '${nickname}' is disabled in the project's tables`
      : state === 'unreadable'
        ? `the ${kind} library '${nickname}' cannot be read where its table points`
        : null

/** A symbol whose library is not reachable, or does not hold it. */
const symbolLibraryIssues = (
  sheets: SheetConnectivityInput[],
  libraries: LibrarySymbolLookup,
  context: ErcContext
): CheckResult[] => {
  if (!context.symbolLibrary) return []
  const results: CheckResult[] = []
  for (const { sheetPath, schematic } of perFile(sheets)) {
    for (const symbol of schematic.symbols) {
      if (!schematic.libSymbols.get(definitionIdOf(symbol))) continue
      const id = splitLibId(symbol.libId)
      if (!id) continue
      const state = context.symbolLibrary(id.nickname)
      const reference = referenceOf(symbol, sheetPath)
      const problem =
        libraryProblem(state, 'symbol', id.nickname) ??
        (state === 'ok' &&
        (context.hasSymbol ? context.hasSymbol(symbol.libId) : !!libraries(symbol.libId)) === false
          ? `the library '${id.nickname}' has no symbol '${id.name}'`
          : null)
      if (!problem) continue
      results.push(
        finding(
          'symbol-library-issue',
          'warning',
          `${reference} (${symbol.libId}): ${problem}. The sheet keeps its own copy, so it still draws, but it cannot be updated from the library; add the library or change the symbol.`,
          symbol,
          sheetPath,
          reference
        )
      )
    }
  }
  return results
}

/** A footprint field that is not `Library:Footprint`, or names one the project cannot reach. */
const footprintLinkIssues = (
  sheets: SheetConnectivityInput[],
  context: ErcContext
): CheckResult[] => {
  if (!context.footprintLibrary) return []
  const results: CheckResult[] = []
  for (const { sheetPath, schematic } of perFile(sheets)) {
    for (const symbol of schematic.symbols) {
      const footprint = getSymbolProperty(symbol, 'Footprint') ?? ''
      if (!footprint) continue
      const reference = referenceOf(symbol, sheetPath)
      const id = splitLibId(footprint)
      const problem = !id
        ? `'${footprint}' is not a footprint id (Library:Footprint)`
        : (libraryProblem(context.footprintLibrary(id.nickname), 'footprint', id.nickname) ??
          (context.footprintLibrary(id.nickname) === 'ok' &&
          context.hasFootprint?.(id.nickname, id.name) === false
            ? `the library '${id.nickname}' has no footprint '${id.name}'`
            : null))
      if (!problem) continue
      results.push(
        finding(
          'footprint-link-issue',
          'warning',
          `${reference}'s footprint ${footprint}: ${problem}. The board cannot place it; add the library or pick a footprint it has.`,
          symbol,
          sheetPath,
          reference
        )
      )
    }
  }
  return results
}

/** KiCad's wildcard match: `*` any run, `?` one character, whole string. */
const wildcard = (pattern: string, text: string): boolean =>
  new RegExp(
    `^${pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.')}$`
  ).test(text)

/** Off by default in KiCad: a footprint the symbol's own filters would not offer. */
const footprintFilters = (sheets: SheetConnectivityInput[]): CheckResult[] => {
  const results: CheckResult[] = []
  for (const { sheetPath, schematic } of perFile(sheets)) {
    for (const symbol of schematic.symbols) {
      const definition = schematic.libSymbols.get(definitionIdOf(symbol))
      const filters = (definition && getLibSymbolProperty(definition, 'ki_fp_filters'))
        ?.split(/\s+/)
        .filter(Boolean)
      if (!filters?.length) continue
      const footprint = (getSymbolProperty(symbol, 'Footprint') ?? '').toLowerCase()
      const name = footprint.slice(footprint.indexOf(':') + 1)
      const matched = filters.some((filter) =>
        filter.includes(':')
          ? wildcard(filter.toLowerCase(), footprint)
          : wildcard(filter.toLowerCase(), name)
      )
      if (matched) continue
      const reference = referenceOf(symbol, sheetPath)
      results.push(
        finding(
          'footprint-filter',
          'warning',
          `${reference}'s footprint ${getSymbolProperty(symbol, 'Footprint') || '(none)'} does not match its symbol's footprint filters (${filters.join(' ')}).`,
          symbol,
          sheetPath,
          reference
        )
      )
    }
  }
  return results
}

export const libraryChecks = (
  sheets: SheetConnectivityInput[],
  libraries: LibrarySymbolLookup,
  context: ErcContext
): CheckResult[] => [
  ...symbolLibraryIssues(sheets, libraries, context),
  ...footprintLinkIssues(sheets, context),
  ...footprintFilters(sheets)
]

export const LIBRARY_RULES: Record<string, string> = {
  'symbol-library-issue':
    "A symbol whose library the project's tables do not include, cannot read, or that lacks it.",
  'footprint-link-issue':
    'A footprint field that is not Library:Footprint, or names a library or footprint the project cannot reach.',
  'footprint-filter': "A footprint its symbol's own filters would not offer (off by default)."
}

export const LIBRARY_KICAD_KEYS: Record<string, string> = {
  'symbol-library-issue': 'lib_symbol_issues',
  'footprint-link-issue': 'footprint_link_issues',
  'footprint-filter': 'footprint_filter'
}
