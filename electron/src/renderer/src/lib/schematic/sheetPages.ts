// Parts follow KiCad's source, named below: Copyright The KiCad Developers, GPL-3.0-or-later.
/**
 * Sheet page numbers, as KiCad keeps and orders them. A page belongs to a sheet
 * *instance*: the root's is the `(path "/" (page …))` in its `sheet_instances`,
 * and a subsheet's is the `(page …)` its `(sheet …)` node lists under the
 * parent instance's path in `(instances (project … (path … (page …))))`. A
 * page is a string — usually a number, but KiCad lets it be any text.
 *
 * One home for reading, comparing and assigning them, so the sheet tree, the
 * netlist, annotation and every way a sheet is made agree.
 */
import type { KicadSchematic, KicadSheet } from '../kicad/schematic'
import {
  findChild,
  findChildren,
  getAtomValues,
  makeAtom,
  makeList,
  updateAtom,
  type SExprList
} from '../kicad/sexpr'

const isDigit = (code: number): boolean => code >= 48 && code <= 57

/**
 * KiCad's `StrNumCmp` (`common/string_utils.cpp`): digit runs compare as
 * numbers, everything else by code unit — case-sensitive unless asked.
 */
export const strNumCmp = (a: string, b: string, ignoreCase = false): number => {
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    let c1 = a.charCodeAt(i)
    let c2 = b.charCodeAt(j)
    if (isDigit(c1) && isDigit(c2)) {
      let n1 = 0
      let n2 = 0
      do n1 = n1 * 10 + a.charCodeAt(i++) - 48
      while (i < a.length && isDigit(a.charCodeAt(i)))
      do n2 = n2 * 10 + b.charCodeAt(j++) - 48
      while (j < b.length && isDigit(b.charCodeAt(j)))
      if (n1 !== n2) return n1 < n2 ? -1 : 1
      c1 = i < a.length ? a.charCodeAt(i) : 0
      c2 = j < b.length ? b.charCodeAt(j) : 0
    }
    if (ignoreCase) {
      const u1 = String.fromCharCode(c1).toUpperCase()
      const u2 = String.fromCharCode(c2).toUpperCase()
      if (u1 !== u2) return u1 < u2 ? -1 : 1
    } else if (c1 !== c2) {
      return c1 < c2 ? -1 : 1
    }
    if (i < a.length) i++
    if (j < b.length) j++
  }
  if (i >= a.length && j < b.length) return -1
  if (i < a.length && j >= b.length) return 1
  return 0
}

// ---- reading ----------------------------------------------------------------

/** The `(page …)` of the `(path …)` entry for `path`, directly in `holder` or under its `(project …)`s. */
export const pageAt = (holder: SExprList | null | undefined, path: string): string | undefined => {
  if (!holder) return undefined
  for (const node of [holder, ...findChildren(holder, 'project')]) {
    for (const entry of findChildren(node, 'path')) {
      if (getAtomValues(entry)[0] !== path) continue
      const page = findChild(entry, 'page')
      if (page) return getAtomValues(page)[0]
    }
  }
  return undefined
}

/** The root sheet's page, from its `sheet_instances`. */
export const rootPageOf = (schematic: KicadSchematic): string | undefined =>
  pageAt(findChild(schematic._root, 'sheet_instances'), '/')

/** A sheet node's page for the instance of it under `parentPath`. */
export const sheetPageOf = (sheet: KicadSheet, parentPath: string): string | undefined =>
  pageAt(findChild(sheet._node, 'instances'), parentPath)

/** A sheet instance with its parsed file — a SheetSource, an annotation or connectivity input. */
export interface PagedSource {
  schematic: KicadSchematic
  sheetPath: string
}

/**
 * The page an instance is numbered with, read from the design's sheets: the
 * root's `sheet_instances`, or the parent's sheet node. Undefined when the
 * file does not say.
 */
export const pageOfInstance = (
  sources: readonly PagedSource[],
  sheetPath: string
): string | undefined => {
  const uuids = sheetPath.split('/').filter(Boolean)
  if (uuids.length <= 1) {
    const root = sources.find((source) => source.sheetPath === sheetPath) ?? sources[0]
    return root ? rootPageOf(root.schematic) : undefined
  }
  const uuid = uuids[uuids.length - 1]
  const parentPath = `/${uuids.slice(0, -1).join('/')}`
  const parent = sources.find((source) => source.sheetPath === parentPath)
  const owners = parent ? [parent, ...sources] : sources
  for (const owner of owners) {
    const sheet = owner.schematic.sheets.find((candidate) => candidate.uuid === uuid)
    if (sheet) return sheetPageOf(sheet, parentPath)
  }
  return undefined
}

/**
 * Every page the design numbers: the root's, and each instance's sheets' under
 * it — read off the parents, so a child whose file is missing still holds its
 * page.
 */
export const pagesOf = (sources: readonly PagedSource[]): string[] => {
  const pages: string[] = []
  for (const source of sources) {
    if (source.sheetPath.split('/').filter(Boolean).length <= 1) {
      const root = rootPageOf(source.schematic)
      if (root !== undefined) pages.push(root)
    }
    for (const sheet of source.schematic.sheets) {
      const page = sheetPageOf(sheet, source.sheetPath)
      if (page !== undefined) pages.push(page)
    }
  }
  return pages
}

// ---- ordering ---------------------------------------------------------------

/** wxString::ToLong: a whole base-10 number, sign allowed, nothing trailing. */
const pageInteger = (page: string): number | null =>
  /^\s*[+-]?\d+$/.test(page) ? Number(page) : null

/**
 * `SCH_SHEET::ComparePageNum`: numbers numerically and before any text, text
 * by `StrNumCmp`. A page the file does not give is empty, as KiCad reads it.
 */
export const comparePages = (a: string | undefined, b: string | undefined): number => {
  const pa = a ?? ''
  const pb = b ?? ''
  if (pa === pb) return 0
  const na = pageInteger(pa)
  const nb = pageInteger(pb)
  if (na !== null && nb !== null) return na < nb ? -1 : na > nb ? 1 : 0
  if (na !== null) return -1
  if (nb !== null) return 1
  return Math.sign(strNumCmp(pa, pb))
}

/**
 * `SCH_SHEET_LIST::SortByPageNumbers`: instances by page, ties in the order
 * given (hierarchy order). Pages are looked up in `all`, which defaults to the
 * instances themselves — pass the whole design when sorting a part of it.
 */
export const inPageOrder = <T extends PagedSource>(
  instances: readonly T[],
  all: readonly PagedSource[] = instances
): T[] => {
  const pages = new Map(
    instances.map((instance) => [instance.sheetPath, pageOfInstance(all, instance.sheetPath)])
  )
  return instances
    .map((instance, index) => ({ instance, index }))
    .sort(
      (a, b) =>
        comparePages(pages.get(a.instance.sheetPath), pages.get(b.instance.sheetPath)) ||
        a.index - b.index
    )
    .map(({ instance }) => instance)
}

// ---- assigning --------------------------------------------------------------

/**
 * `SCH_SHEET_LIST::GetNextPageNumber`: the lowest positive whole number no
 * page in the design uses. Text pages take nothing.
 */
export const nextFreePage = (pages: Iterable<string | undefined>): string => {
  const used = new Set<number>()
  for (const page of pages) {
    const number = page === undefined ? null : pageInteger(page)
    if (number !== null && number > 0) used.add(number)
  }
  let next = 1
  while (used.has(next)) next++
  return String(next)
}

/**
 * Hands out free pages one at a time, each taken before the next is found —
 * one per instance of a new sheet, as KiCad numbers a sheet placed on a
 * repeated parent or pasted.
 */
export const pageAllocator = (pages: Iterable<string | undefined>): (() => string) => {
  const taken = [...pages]
  return () => {
    const page = nextFreePage(taken)
    taken.push(page)
    return page
  }
}

// ---- writing ----------------------------------------------------------------

const rootUuidOf = (path: string): string | undefined => path.split('/').filter(Boolean)[0]

/** Give a `(path …)` entry `page`: its `(page …)` rewritten, or one added after the path. */
const setEntryPage = (entry: SExprList, page: string): void => {
  const at = entry.start
  const existing = findChild(entry, 'page')
  if (!existing)
    entry.children.splice(
      2,
      0,
      makeList([makeAtom('page', false, at), makeAtom(page, true, at)], at)
    )
  // Always quoted, as KiCad writes it: a bare atom cannot hold an empty or spaced page.
  else if (existing.children[1]?.type === 'atom') updateAtom(existing.children[1], page, true)
  else existing.children.splice(1, 0, makeAtom(page, true, at))
}

/**
 * Number the root sheet with `page`: the `(page …)` of its `(path "/")` in
 * `sheet_instances`, an entry added when there is none, and `sheet_instances`
 * itself written where KiCad's writer puts it — after the drawing, before
 * `embedded_fonts` — when the file has none.
 */
export const setRootPage = (schematic: KicadSchematic, page: string): void => {
  const root = schematic._root
  const at = root.start
  let holder = findChild(root, 'sheet_instances')
  if (!holder) {
    holder = makeList([makeAtom('sheet_instances', false, at)], at)
    const fonts = findChild(root, 'embedded_fonts')
    root.children.splice(fonts ? root.children.indexOf(fonts) : root.children.length, 0, holder)
  }
  const entry = [holder, ...findChildren(holder, 'project')]
    .flatMap((node) => findChildren(node, 'path'))
    .filter((candidate) => getAtomValues(candidate)[0] === '/')
    .sort((a, b) => Number(!findChild(a, 'page')) - Number(!findChild(b, 'page')))[0]
  if (entry) {
    setEntryPage(entry, page)
    return
  }
  holder.children.push(makeList([makeAtom('path', false, at), makeAtom('/', true, at)], at))
  setEntryPage(holder.children[holder.children.length - 1] as SExprList, page)
}

/**
 * Number a sheet's instance under `parentPath` with `page`, as
 * `SCH_SHEET_PATH::SetPageNumber` does: the `(page …)` of that path's entry is
 * rewritten, or given to an entry without one, or a new `(path … (page …))` is
 * filed under the project that holds this design's paths — `project`'s when
 * none does, `(instances …)` itself made last in the sheet when missing, where
 * KiCad writes it. Every other entry is left as it is.
 */
export const setSheetPage = (
  sheet: KicadSheet,
  parentPath: string,
  page: string,
  project: string
): void => {
  const node = sheet._node
  const at = node.start
  const pageNode = (): SExprList =>
    makeList([makeAtom('page', false, at), makeAtom(page, true, at)], at)
  let instances = findChild(node, 'instances')
  const entries = instances
    ? [instances, ...findChildren(instances, 'project')]
        .flatMap((holder) => findChildren(holder, 'path'))
        .filter((entry) => getAtomValues(entry)[0] === parentPath)
    : []
  // The entry `pageAt` reads, so the edit is the page shown.
  const entry = entries.find((candidate) => findChild(candidate, 'page')) ?? entries[0]
  if (entry) {
    setEntryPage(entry, page)
    return
  }
  if (!instances) {
    instances = makeList([makeAtom('instances', false, at)], at)
    node.children.push(instances)
  }
  const pathNode = makeList(
    [makeAtom('path', false, at), makeAtom(parentPath, true, at), pageNode()],
    at
  )
  const projects = findChildren(instances, 'project')
  const root = rootUuidOf(parentPath)
  const owner =
    projects.find((candidate) =>
      findChildren(candidate, 'path').some(
        (other) => rootUuidOf(getAtomValues(other)[0] ?? '') === root
      )
    ) ?? projects.find((candidate) => getAtomValues(candidate)[0] === project)
  if (owner) owner.children.push(pathNode)
  else
    instances.children.push(
      makeList([makeAtom('project', false, at), makeAtom(project, true, at), pathNode], at)
    )
}
