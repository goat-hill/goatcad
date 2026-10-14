/**
 * Find and replace over a schematic, as KiCad's Find/Replace dialog reads it:
 * symbol fields (the Reference per sheet instance, since a reused sheet names
 * its parts per path), labels, free text, text boxes and sheet names. The raw
 * stored text is what matches, as KiCad compares — `{slash}` and markup
 * included.
 *
 * Pure: the editor supplies the sheets, runs the edits through one command,
 * and asks `duplicateReferences` before a replace renames a part onto another.
 */
import {
  referenceForSheetPath,
  setSchematicLabelText,
  setSchematicPropertyValue,
  setSchematicTextBoxContent,
  setSchematicTextContent,
  setSymbolInstanceReference,
  type KicadSchematic,
  type Point
} from '../kicad/schematic'
import { nm } from '../kicad/coordinates'
import { compileQuery, FIND_TEXT_DEFAULTS, hitsIn, type FindTextOptions } from '../canvasFind'

export interface FindOptions extends FindTextOptions {
  /** KiCad's "Replace matching reference designators": off, references are found, not renamed. */
  replaceReferences: boolean
}

export const FIND_DEFAULTS: FindOptions = { ...FIND_TEXT_DEFAULTS, replaceReferences: false }

/** One sheet instance to search, as the hierarchy names it. */
export interface FindSource {
  filePath: string
  sheetPath: string
  schematic: KicadSchematic
}

/** What a match is in, addressed the way the editor selects it. */
export type FindTarget =
  | { kind: 'field'; index: number; field: string }
  | { kind: 'label'; index: number }
  | { kind: 'text'; index: number }
  | { kind: 'text_box'; index: number }
  | { kind: 'sheet_field'; index: number; field: string }

export interface FindMatch {
  /** Unique in one search, and the same for the same hit on the next. */
  key: string
  filePath: string
  sheetPath: string
  target: FindTarget
  /** The whole stored text the hit is in, and where in it. */
  text: string
  start: number
  end: number
  /** Where to look, sheet nm. */
  position: Point
  /** The item's uuid, to select it from another sheet (a field's symbol's). */
  uuid?: string
}

const targetKey = (target: FindTarget): string =>
  target.kind === 'field' || target.kind === 'sheet_field'
    ? `${target.kind}:${target.index}:${target.field}`
    : `${target.kind}:${target.index}`

interface Candidate {
  target: FindTarget
  text: string
  position: Point
  uuid?: string
}

/** The texts one sheet instance offers, in document order. */
function candidatesOf(source: FindSource, perFile: boolean): Candidate[] {
  const { schematic, sheetPath } = source
  const found: Candidate[] = []
  schematic.symbols.forEach((symbol, index) => {
    for (const property of symbol.properties) {
      if (property.key.startsWith('ki_')) continue
      // A reference is the instance's; everything else is the file's, found once.
      const isReference = property.key === 'Reference'
      if (!isReference && !perFile) continue
      found.push({
        target: { kind: 'field', index, field: property.key },
        text: isReference
          ? (referenceForSheetPath(symbol, sheetPath) ?? property.value)
          : property.value,
        position: property.position,
        uuid: symbol.uuid
      })
    }
  })
  if (!perFile) return found
  schematic.labels.forEach((label, index) =>
    found.push({
      target: { kind: 'label', index },
      text: label.text,
      position: label.position,
      uuid: label.uuid
    })
  )
  schematic.texts.forEach((text, index) =>
    found.push({
      target: { kind: 'text', index },
      text: text.text,
      position: text.position,
      uuid: text.uuid
    })
  )
  schematic.textBoxes.forEach((box, index) => {
    const { position, size, text } = box.graphic
    found.push({
      target: { kind: 'text_box', index },
      text,
      position: { x: nm(position.x + size.width / 2), y: nm(position.y + size.height / 2) },
      uuid: box.uuid
    })
  })
  schematic.sheets.forEach((sheet, index) => {
    const name = sheet.properties.find((property) => property.key === 'Sheetname')
    if (name)
      found.push({
        target: { kind: 'sheet_field', index, field: 'Sheetname' },
        text: name.value,
        position: name.position,
        uuid: sheet.uuid
      })
  })
  return found
}

/**
 * Every hit, sheet by sheet in the order given, then top to bottom and left
 * to right as a reader scans. A file reused under several paths is searched
 * once for its text and once per path for its references.
 */
export function findMatches(
  sources: FindSource[],
  query: string,
  options: FindOptions
): FindMatch[] {
  const pattern = compileQuery(query, options)
  if (!pattern) return []
  const seenFiles = new Set<string>()
  const matches: FindMatch[] = []
  for (const source of sources) {
    const fileKey = source.filePath.replace(/[\\/]+/g, '/').toLowerCase()
    const perFile = !seenFiles.has(fileKey)
    seenFiles.add(fileKey)
    const here: FindMatch[] = []
    for (const candidate of candidatesOf(source, perFile)) {
      for (const hit of hitsIn(candidate.text, pattern)) {
        here.push({
          key: `${source.sheetPath}|${targetKey(candidate.target)}|${hit.start}`,
          filePath: source.filePath,
          sheetPath: source.sheetPath,
          target: candidate.target,
          text: candidate.text,
          ...hit,
          position: { x: candidate.position.x, y: candidate.position.y },
          ...(candidate.uuid ? { uuid: candidate.uuid } : {})
        })
      }
    }
    here.sort(
      (a, b) => a.position.y - b.position.y || a.position.x - b.position.x || a.start - b.start
    )
    matches.push(...here)
  }
  return matches
}

/** One item's text before and after a replace. */
export interface ReplaceEdit {
  filePath: string
  sheetPath: string
  target: FindTarget
  before: string
  after: string
}

const isReference = (target: FindTarget): boolean =>
  target.kind === 'field' && target.field === 'Reference'

/** Whether a replace may write this hit (references only when asked). */
export const replaceable = (match: FindMatch, options: FindOptions): boolean =>
  options.replaceReferences || !isReference(match.target)

/**
 * The edits a replace makes: one hit (`only`), or every replaceable hit, each
 * item written once with all of its hits replaced. A regex replacement takes
 * `$1`-style groups, as the text editor's does.
 */
export function replaceEdits(
  matches: FindMatch[],
  query: string,
  replacement: string,
  options: FindOptions,
  only?: FindMatch
): ReplaceEdit[] {
  const pattern = compileQuery(query, options)
  if (!pattern) return []
  const chosen = (only ? [only] : matches).filter((match) => replaceable(match, options))
  const edits = new Map<string, ReplaceEdit>()
  for (const match of chosen) {
    const scope = isReference(match.target) ? match.sheetPath : ''
    const key = `${match.filePath}|${scope}|${targetKey(match.target)}`
    if (edits.has(key)) continue
    let after: string
    if (only) {
      const single = new RegExp(pattern.source, pattern.flags.replace('g', ''))
      const hit = match.text.slice(match.start, match.end)
      after =
        match.text.slice(0, match.start) +
        hit.replace(single, replacement) +
        match.text.slice(match.end)
    } else {
      pattern.lastIndex = 0
      after = match.text.replace(pattern, replacement)
    }
    if (after === match.text) continue
    edits.set(key, {
      filePath: match.filePath,
      sheetPath: match.sheetPath,
      target: match.target,
      before: match.text,
      after
    })
  }
  return [...edits.values()]
}

/**
 * References the edits would give to more than one part. A part is its old
 * reference: the units of one package share it, and renaming them together is
 * no duplicate. Only names an edit writes are reported; a clash the design
 * already had is not this replace's doing. Unannotated names (`R?`) never clash.
 */
export function duplicateReferences(sources: FindSource[], edits: ReplaceEdit[]): string[] {
  const renamed = new Map<string, string>()
  for (const edit of edits) {
    if (edit.target.kind === 'field' && edit.target.field === 'Reference')
      renamed.set(`${edit.sheetPath}|${edit.target.index}`, edit.after)
  }
  if (!renamed.size) return []
  const holders = new Map<string, Set<string>>()
  for (const { sheetPath, schematic } of sources) {
    schematic.symbols.forEach((symbol, index) => {
      const before = referenceForSheetPath(symbol, sheetPath) ?? ''
      const after = renamed.get(`${sheetPath}|${index}`) ?? before
      const set = holders.get(after) ?? new Set<string>()
      set.add(before)
      holders.set(after, set)
    })
  }
  return [...new Set(renamed.values())]
    .filter((name) => !name.endsWith('?') && (holders.get(name)?.size ?? 0) > 1)
    .sort()
}

/** Write one edit into the sheet it names. */
export function applyReplaceEdit(schematic: KicadSchematic, edit: ReplaceEdit): void {
  const { target } = edit
  if (target.kind === 'field') {
    const symbol = schematic.symbols[target.index]
    if (!symbol) return
    if (target.field === 'Reference') {
      setSymbolInstanceReference(symbol, edit.sheetPath, edit.after)
      return
    }
    const property = symbol.properties.find((field) => field.key === target.field)
    if (property) setSchematicPropertyValue(property, edit.after)
  } else if (target.kind === 'label') {
    const label = schematic.labels[target.index]
    if (label) setSchematicLabelText(label, edit.after)
  } else if (target.kind === 'text') {
    const text = schematic.texts[target.index]
    if (text) setSchematicTextContent(text, edit.after)
  } else if (target.kind === 'text_box') {
    const box = schematic.textBoxes[target.index]
    if (box) setSchematicTextBoxContent(box, edit.after)
  } else {
    const property = schematic.sheets[target.index]?.properties.find(
      (field) => field.key === target.field
    )
    if (property) setSchematicPropertyValue(property, edit.after)
  }
}
