/**
 * Edits to placed symbols that may live in several sheet files, applied as one
 * command: the file the command runs in is edited through its live document,
 * every other file through a parse of its current text, and those rewrites are
 * handed back for the history entry to carry. Annotate, the Components table
 * and `bom.update` all write through here, so a design-wide edit lands the same
 * way whichever door it came through.
 */
import {
  parseKicadSchematic,
  serializeKicadSchematic,
  type KicadSchematic,
  type KicadSchematicSymbol
} from '../kicad/schematic'
import { samePath } from '../kicad/paths'

export interface SymbolEdit {
  /** The .kicad_sch file the symbol node lives in. */
  filePath: string
  /** Index into that file's `symbols`. */
  symbolIndex: number
  apply(symbol: KicadSchematicSymbol): void
}

/** A sibling file an edit rewrote; `loaded` is the disk text of a sheet no tab
 *  held, so the tab store can call it that sheet's baseline. */
export interface SiblingTextEdit {
  path: string
  before: string
  after: string
  loaded?: string
}

export interface SymbolEditHost {
  filePath: string
  document: KicadSchematic
  /** Another sheet as it is now: its tab's buffer, else the copy read from disk. */
  sibling(path: string): KicadSchematic | undefined
  /** Whether a tab holds that sheet. */
  isOpen(path: string): boolean
}

/** Apply `edits` and return the sibling rewrites for the command to record. */
export function applySymbolEdits(edits: SymbolEdit[], host: SymbolEditHost): SiblingTextEdit[] {
  return applyDocumentEdits(
    edits.map((edit) => ({
      filePath: edit.filePath,
      apply: (document) => {
        const symbol = document.symbols[edit.symbolIndex]
        if (symbol) edit.apply(symbol)
      }
    })),
    host
  )
}

/** An edit to a whole sheet file, for what is not one symbol: a label, a text,
 *  the sheet's library copies. */
export interface DocumentEdit {
  filePath: string
  apply(document: KicadSchematic): void
}

/** Apply `edits`, in order, each file once, and return the sibling rewrites. */
export function applyDocumentEdits(edits: DocumentEdit[], host: SymbolEditHost): SiblingTextEdit[] {
  const bySibling = new Map<string, DocumentEdit[]>()
  for (const edit of edits) {
    if (samePath(edit.filePath, host.filePath)) {
      edit.apply(host.document)
      continue
    }
    const list = bySibling.get(edit.filePath) ?? []
    list.push(edit)
    bySibling.set(edit.filePath, list)
  }
  const rewrites: SiblingTextEdit[] = []
  for (const [path, list] of bySibling) {
    const live = host.sibling(path)
    if (!live) continue
    const before = serializeKicadSchematic(live)
    const document = parseKicadSchematic(before)
    for (const edit of list) edit.apply(document)
    rewrites.push({
      path,
      before,
      after: serializeKicadSchematic(document),
      ...(host.isOpen(path) ? {} : { loaded: before })
    })
  }
  return rewrites
}
