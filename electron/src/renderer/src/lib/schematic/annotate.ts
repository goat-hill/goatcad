/**
 * Reference annotation — KiCad's *Annotate Schematic*, as a plan over parsed
 * sheets that the editor then applies as one command.
 *
 * A designator is unique across the whole design, and since KiCad 6 it belongs
 * to a sheet *instance* (`referenceForSheetPath`): one file placed twice holds
 * two references per symbol. So the plan is made per sheet instance, in the
 * hierarchy's own order, and the pool it numbers against is every reference in
 * every sheet instance of the design — a run on one sheet can never collide
 * with a sibling, and never renumbers one it was not asked to.
 *
 * KiCad's dialog, trimmed to the choices that change the result: the order the
 * numbers follow across the page, whether they start after a number of the
 * user's or at the sheet's page × 100 (so `C203` says "page 2"), and whether
 * existing numbers are kept — in which case only the unannotated (`R?`) and the
 * duplicated get new ones — or reset.
 *
 * Units of one part (`U1A`, `U1B`) share a reference and must stay together;
 * they are grouped by reference and lib id before anything is numbered, so a
 * reset moves all of them to one new number.
 */
import { referenceForSheetPath, type KicadSchematic } from '../kicad/schematic'
import { pageOfInstance } from './sheetPages'

export type AnnotateOrder = 'xy' | 'yx'
export type AnnotateNumbering = 'sequential' | 'sheet100' | 'sheet1000'

export interface AnnotateOptions {
  /** Left to right then top to bottom (`xy`), or top to bottom then across. */
  order: AnnotateOrder
  /** Where each prefix's count starts: after `start`, or the sheet's page × 100 or × 1000. */
  numbering: AnnotateNumbering
  /** KiCad's "use first free number after": numbers begin above this. 0 by default. */
  start?: number
  /** Renumber everything in scope, rather than only the unannotated and duplicated. */
  reset: boolean
}

/**
 * Every scope KiCad offers: the whole design, the current sheet with or without
 * the sheets beneath it, or the selection.
 */
export type AnnotateScope = 'design' | 'sheet' | 'selection'
export interface AnnotateRequest extends AnnotateOptions {
  scope: AnnotateScope
  /** With `sheet`: the sheets beneath this one too. KiCad's "recurse into subsheets". */
  recurse: boolean
}

/** One sheet instance: its parsed document and where it hangs in the hierarchy. */
export interface AnnotateSource {
  schematic: KicadSchematic
  sheetPath: string
  filePath: string
}

export interface AnnotateTarget {
  /** Every sheet instance in the design, pre-order — the reference pool. */
  sources: AnnotateSource[]
  /** The instances to annotate, in the order to number them; each is one of `sources`. */
  scope: AnnotateSource[]
  /** Symbol indices to confine the run to, within every scoped instance; omitted means all. */
  selection?: ReadonlySet<number>
}

export interface AnnotationChange {
  filePath: string
  sheetPath: string
  symbolIndex: number
  from: string
  to: string
}

export interface AnnotationPlan {
  /** Only the references that actually change, in the order they are assigned. */
  changes: AnnotationChange[]
  /** Symbols the run looked at, over every scoped instance. */
  considered: number
}

/** `R?` → prefix `R`, unannotated; `#PWR01` → `#PWR`, 1; `U1` → `U`, 1. */
export const parseReference = (reference: string): { prefix: string; number: number | null } => {
  const match = /^(.*?)(\d+)$/.exec(reference)
  if (match && !match[1].endsWith('?')) {
    return { prefix: match[1], number: Number(match[2]) }
  }
  return { prefix: reference.replace(/\?+$/, '') || '?', number: null }
}

/**
 * The instances a scope names, in hierarchy order: every instance of the
 * given file paths, and with `recurse` everything beneath them too — KiCad's
 * "current sheet only" with "recurse into subsheets".
 */
export const instancesOf = (
  sources: readonly AnnotateSource[],
  filePaths: readonly string[],
  recurse: boolean,
  samePath: (a: string, b: string) => boolean = (a, b) => a === b
): AnnotateSource[] => {
  const roots = sources.filter((source) =>
    filePaths.some((file) => samePath(file, source.filePath))
  )
  if (!recurse) return roots
  const under = (source: AnnotateSource): boolean =>
    roots.some((root) => source.sheetPath.startsWith(`${root.sheetPath}/`))
  return sources.filter((source) => roots.includes(source) || under(source))
}

/**
 * The page a sheet instance is drawn on, from the file: the root's own
 * `sheet_instances`, or the `(instances …)` block of the parent's sheet node
 * for the path in question. Undefined when the file does not say.
 */
export const pageOfSheetPath = (
  sources: readonly AnnotateSource[],
  sheetPath: string
): number | undefined => {
  const page = pageOfInstance(sources, sheetPath)
  const number = page === undefined ? NaN : Number(page)
  return Number.isFinite(number) ? number : undefined
}

interface Part {
  /** Symbol indices of every unit, first unit first. */
  units: number[]
  /** The unit numbers those are, so a second `U3` unit 1 reads as a duplicate. */
  unitNumbers: Set<number>
  reference: string
  prefix: string
  annotated: boolean
  x: number
  y: number
}

const byOrder =
  (order: AnnotateOrder) =>
  (a: Part, b: Part): number =>
    order === 'xy' ? a.x - b.x || a.y - b.y : a.y - b.y || a.x - b.x

const instanceKey = (source: AnnotateSource): string => `${source.filePath}|${source.sheetPath}`

export function planAnnotation(target: AnnotateTarget, options: AnnotateOptions): AnnotationPlan {
  const changes: AnnotationChange[] = []
  let considered = 0
  // Instances are numbered one after another and the plan is not applied
  // between them, so what one was given is held here for the next.
  const assigned = new Set<string>()
  const scopedInstances = new Set(target.scope.map(instanceKey))
  const inScope = (index: number): boolean => !target.selection || target.selection.has(index)

  target.scope.forEach((instance, position) => {
    const { schematic, sheetPath, filePath } = instance
    const later = new Set(target.scope.slice(position + 1).map(instanceKey))
    const symbols = schematic.symbols

    // Units of one part share a reference and a lib id and differ in unit
    // number; a second symbol with the same reference AND the same unit is a
    // duplicate, which is a part of its own. Unannotated symbols are one part
    // each: there is nothing to say which `U?` goes with which.
    const parts: Part[] = []
    const byKey = new Map<string, Part>()
    symbols.forEach((symbol, index) => {
      if (!inScope(index)) return
      considered += 1
      const reference = referenceForSheetPath(symbol, sheetPath) ?? '?'
      const { prefix, number } = parseReference(reference)
      const annotated = number !== null
      const key = annotated ? `${reference}|${symbol.libId}` : `#${index}`
      const existing = byKey.get(key)
      if (existing && !existing.unitNumbers.has(symbol.unit)) {
        existing.units.push(index)
        existing.unitNumbers.add(symbol.unit)
        return
      }
      const part: Part = {
        units: [index],
        unitNumbers: new Set([symbol.unit]),
        reference,
        prefix,
        annotated,
        x: symbol.position.x,
        y: symbol.position.y
      }
      if (!existing) byKey.set(key, part)
      parts.push(part)
    })
    parts.sort(byOrder(options.order))

    // The pool: every reference in the design that this run will not hand
    // out afresh. This instance's scoped symbols are the ones being numbered;
    // on a reset, so are every other scoped instance's, since their old
    // numbers are about to go too. A number this instance holds and a LATER
    // scoped instance also holds is a duplicate the earlier one keeps, so the
    // later copy does not count against it here — it is renumbered when its
    // own turn comes and finds the number taken. What an earlier instance was
    // given this run is in `assigned`.
    const own = new Set(parts.flatMap((part) => part.units))
    const ownAnnotated = new Set(
      parts.filter((part) => part.annotated).map((part) => part.reference)
    )
    const taken = new Set<string>(assigned)
    for (const source of target.sources) {
      const key = instanceKey(source)
      const scoped = scopedInstances.has(key)
      const isThis = source.schematic === schematic && source.sheetPath === sheetPath
      source.schematic.symbols.forEach((symbol, index) => {
        if (isThis && own.has(index)) return
        if (scoped && options.reset && inScope(index)) return
        const reference = referenceForSheetPath(symbol, source.sheetPath)
        if (!reference) return
        if (later.has(key) && inScope(index) && ownAnnotated.has(reference)) return
        taken.add(reference)
      })
    }

    const page = pageOfSheetPath(target.sources, sheetPath) ?? 1
    const base =
      options.numbering === 'sheet100'
        ? page * 100
        : options.numbering === 'sheet1000'
          ? page * 1000
          : Math.max(0, Math.floor(options.start ?? 0))
    const counters = new Map<string, number>()
    const nextFor = (prefix: string): string => {
      let n = counters.get(prefix) ?? base + 1
      while (taken.has(`${prefix}${n}`)) n += 1
      counters.set(prefix, n + 1)
      return `${prefix}${n}`
    }

    // Two passes so a kept number is never handed out again: first everything
    // that keeps its reference claims it, then the rest are numbered in order.
    const renumber: Part[] = []
    for (const part of parts) {
      const keep = !options.reset && part.annotated && !taken.has(part.reference)
      if (keep) taken.add(part.reference)
      else renumber.push(part)
    }
    for (const part of renumber) {
      const to = nextFor(part.prefix)
      taken.add(to)
      assigned.add(to)
      for (const symbolIndex of part.units) {
        const from = referenceForSheetPath(symbols[symbolIndex], sheetPath) ?? '?'
        if (from !== to) changes.push({ filePath, sheetPath, symbolIndex, from, to })
      }
    }
  })

  return { changes, considered }
}

/**
 * KiCad's Increment Annotations From… (`SCH_EDITOR_CONTROL::IncrementAnnotations`):
 * every reference with `first`'s prefix numbered at or above it moves up by
 * `increment`, in the given instances — the sheet on screen, or all of them.
 * Nothing is checked for collisions, as KiCad checks nothing; a `first` with
 * no number plans nothing.
 */
export function planIncrementAnnotations(
  scope: readonly AnnotateSource[],
  first: string,
  increment: number
): AnnotationPlan {
  const start = /^(.*?)(\d+)$/.exec(first.trim())
  const changes: AnnotationChange[] = []
  let considered = 0
  if (!start || !Number.isInteger(increment)) return { changes, considered }
  const prefix = start[1]
  const from = Number(start[2])
  for (const { schematic, sheetPath, filePath } of scope) {
    schematic.symbols.forEach((symbol, symbolIndex) => {
      considered += 1
      const reference = referenceForSheetPath(symbol, sheetPath)
      if (!reference) return
      const parsed = parseReference(reference)
      if (parsed.prefix !== prefix || parsed.number === null || parsed.number < from) return
      const to = `${prefix}${parsed.number + increment}`
      if (to !== reference) changes.push({ filePath, sheetPath, symbolIndex, from: reference, to })
    })
  }
  return { changes, considered }
}
