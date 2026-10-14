/**
 * Moving through the sheet hierarchy: into a sheet box, back out to its
 * parent, along a breadcrumb. A tab is a FILE, but a reused sheet has one
 * instance per path, so the path a file was entered through is remembered
 * here — its tab's editor reads it to know which instance it shows and which
 * parent Leave sheet returns to.
 */
import { ref } from 'vue'
import type { SchematicHierarchy, SheetInstance } from './hierarchy'

const keyOf = (filePath: string): string => filePath.replace(/[\\/]+/g, '/').toLowerCase()

/** The instance path each sheet file was last entered through, by file. */
const entered = ref<Record<string, string>>({})

export const enteredInstancePath = (filePath: string): string | undefined =>
  entered.value[keyOf(filePath)]

export const noteEnteredInstance = (filePath: string, sheetPath: string): void => {
  entered.value = { ...entered.value, [keyOf(filePath)]: sheetPath }
}

/** A child sheet's instance path: the parent's, then the sheet node's uuid. */
export const childSheetPath = (parentPath: string, sheetUuid: string): string =>
  `${parentPath.replace(/\/+$/, '')}/${sheetUuid}`

/** The path one level up, or null at the root (`/<root-uuid>`). */
export const parentSheetPath = (sheetPath: string): string | null => {
  const at = sheetPath.lastIndexOf('/')
  return at > 0 ? sheetPath.slice(0, at) : null
}

const sameFile = (a: string, b: string): boolean => keyOf(a) === keyOf(b)

/**
 * The instance a file's view shows: the one it was entered through when that
 * is still an instance of the file, else its first in the tree. Null when the
 * tree does not hold the file.
 */
export function currentInstance(
  hierarchy: SchematicHierarchy | null,
  filePath: string,
  preferred?: string
): SheetInstance | null {
  const mine = (hierarchy?.instances ?? []).filter((instance) =>
    sameFile(instance.filePath, filePath)
  )
  return mine.find((instance) => instance.sheetPath === preferred) ?? mine[0] ?? null
}

/** The instance a sheet box names from inside `parentPath`. */
export function childInstance(
  hierarchy: SchematicHierarchy | null,
  parentPath: string,
  sheetUuid: string
): SheetInstance | null {
  const path = childSheetPath(parentPath, sheetUuid)
  return hierarchy?.instances.find((instance) => instance.sheetPath === path) ?? null
}

/** The instance one level up, or null at the root. */
export function parentInstance(
  hierarchy: SchematicHierarchy | null,
  sheetPath: string
): SheetInstance | null {
  const path = parentSheetPath(sheetPath)
  if (!path) return null
  return hierarchy?.instances.find((instance) => instance.sheetPath === path) ?? null
}

/** A sheet instance as shown: the file its tab holds and the path it was entered by. */
export interface SheetVisit {
  filePath: string
  sheetPath: string
}

const sameVisit = (a: SheetVisit, b: SheetVisit): boolean =>
  a.sheetPath === b.sheetPath && sameFile(a.filePath, b.filePath)

/**
 * KiCad's sheet navigation history (`SCH_NAVIGATE_TOOL`): every instance
 * shown is visited; back and forward step through them. Visiting anew drops
 * whatever lay ahead, and showing the entry back or forward just stepped to
 * is not a new visit — which is what lets the step itself show the sheet.
 */
export interface SheetHistory {
  visit(visit: SheetVisit): void
  /** The entry behind (ahead of) the current one that `valid` accepts, stepped onto; null at the end. */
  back(valid?: (visit: SheetVisit) => boolean): SheetVisit | null
  forward(valid?: (visit: SheetVisit) => boolean): SheetVisit | null
  canBack(): boolean
  canForward(): boolean
}

export function createSheetHistory(limit = 100): SheetHistory {
  const state = ref<{ entries: SheetVisit[]; index: number }>({ entries: [], index: -1 })
  const step = (delta: number, valid: (visit: SheetVisit) => boolean): SheetVisit | null => {
    const { entries } = state.value
    for (
      let index = state.value.index + delta;
      index >= 0 && index < entries.length;
      index += delta
    ) {
      if (!valid(entries[index])) continue
      state.value = { entries, index }
      return entries[index]
    }
    return null
  }
  return {
    visit(visit) {
      const { entries, index } = state.value
      if (index >= 0 && sameVisit(entries[index], visit)) return
      const kept = [...entries.slice(0, index + 1), { ...visit }].slice(-limit)
      state.value = { entries: kept, index: kept.length - 1 }
    },
    back: (valid = () => true) => step(-1, valid),
    forward: (valid = () => true) => step(1, valid),
    canBack: () => state.value.index > 0,
    canForward: () => state.value.index < state.value.entries.length - 1
  }
}

/** The window's one history: every schematic tab shares it, as KiCad's frame does. */
export const sheetHistory = createSheetHistory()

/**
 * The instance `delta` pages from `sheetPath` in page order (KiCad's Previous /
 * Next Sheet walk the virtual page numbers and stop at either end), or null.
 */
export function adjacentSheet<T extends { sheetPath: string }>(
  inPageOrder: readonly T[],
  sheetPath: string,
  delta: 1 | -1
): T | null {
  const at = inPageOrder.findIndex((entry) => entry.sheetPath === sheetPath)
  if (at < 0) return null
  return inPageOrder[at + delta] ?? null
}

/** Root first, down to `sheetPath`: each ancestor the tree holds, then the instance itself. */
export function sheetBreadcrumb(
  hierarchy: SchematicHierarchy | null,
  sheetPath: string
): SheetInstance[] {
  const byPath = new Map((hierarchy?.instances ?? []).map((i) => [i.sheetPath, i]))
  const crumbs: SheetInstance[] = []
  for (let path: string | null = sheetPath; path; path = parentSheetPath(path)) {
    const instance = byPath.get(path)
    if (instance) crumbs.unshift(instance)
  }
  return crumbs
}
