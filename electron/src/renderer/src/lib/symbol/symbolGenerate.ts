/**
 * Writing a laid-out symbol into a `.kicad_sym` library.
 *
 * `symbolLayout.ts` decides where everything goes; this puts it in the file,
 * through the same `symbolEdit.ts` helpers the symbol editor uses for a hand
 * edit. Nothing here makes a drafting decision — if a number appears in this
 * file that is not copied from the layout, it belongs in that one.
 */
import {
  addPin,
  addRectangle,
  addSymbol,
  removeSymbol,
  setSymbolPowerKind,
  setSymbolProperty,
  setSymbolPropertyVisible,
  symbolPropertyNode,
  setSymbolPropertyJustify,
  translateSymbolPropertyNode,
  updatePin,
  type SymbolPowerKind
} from './symbolEdit'
import { parseKicadSymbolLibrary, type KicadSymbolLibrary } from '../kicad/symbolLibrary'
import type { SExprList } from '../kicad/sexpr'
import { mmToNm, type Nm } from '../kicad/coordinates'
import type { SymbolLayout } from './symbolLayout'

/** An empty library, for a project that has none yet. The version is KiCad's
 *  current `kicad_symbol_editor` output; it is rewritten on first save by
 *  whatever KiCad the user runs. */
export const EMPTY_SYMBOL_LIBRARY = `(kicad_symbol_lib
	(version 20241209)
	(generator "goatcad")
	(generator_version "1.0")
)
`

export interface SymbolFields {
  /** Shown on the schematic; the rest are data. */
  reference: string
  value: string
  description?: string
  keywords?: string
  datasheet?: string
  /** Anything else — MPN, Manufacturer. Written hidden. */
  extra?: Record<string, string>
}

export interface GenerateResult {
  library: KicadSymbolLibrary
  /** True when a symbol of that name was replaced rather than added. */
  replaced: boolean
}

/**
 * Add (or replace) a symbol in a parsed library.
 *
 * **`Footprint` is written empty, deliberately.** Guessing it from a package
 * string produces a symbol/footprint mismatch. Empty is honest
 * and ERC-visible; wrong is silent.
 */
export function generateSymbol(
  library: KicadSymbolLibrary,
  name: string,
  layout: SymbolLayout,
  fields: SymbolFields
): GenerateResult {
  const existing = library.symbols.get(name)
  const replaced = existing !== undefined
  if (existing) removeSymbol(library.root, existing._node)

  const node = addSymbol(library.root, name)
  writeFields(node, fields)
  // Both are drawn on the sheet, so both need a home. `addSymbol` scaffolds them
  // at the origin, which is inside the body and on top of each other.
  placeField(node, 'Reference', layout.fields.reference)
  placeField(node, 'Value', layout.fields.value)

  // Body into unit 0 (drawn for every unit); pins into unit 1. That is the
  // `<name>_0_1` / `<name>_1_1` split `addSymbol` already scaffolds.
  addRectangle(
    node,
    { x: layout.body.minX, y: layout.body.maxY },
    { x: layout.body.maxX, y: layout.body.minY },
    0,
    'background'
  )

  for (const pin of layout.pins) {
    const pinNode = addPin(
      node,
      {
        name: pin.name,
        number: pin.number,
        x: pin.x,
        y: pin.y,
        angle: pin.angle,
        length: pin.length,
        electricalType: pin.type,
        graphicStyle: 'line'
      },
      1
    )
    // Every pad after the first in a stack is hidden, as the standard library
    // does it. Two visible pins at one coordinate look like a drawing mistake
    // in the editor and give a reader no way to tell one from the other.
    if (pin.hidden) updatePin(pinNode, { hidden: true })
  }

  return { library, replaced }
}

/** The fields every new symbol carries; all but Reference and Value hidden. */
function writeFields(node: SExprList, fields: SymbolFields): void {
  setSymbolProperty(node, 'Reference', fields.reference)
  setSymbolProperty(node, 'Value', fields.value)
  setSymbolProperty(node, 'Footprint', '')
  setSymbolProperty(node, 'Datasheet', fields.datasheet ?? '')
  if (fields.description) setSymbolProperty(node, 'Description', fields.description)
  if (fields.keywords) setSymbolProperty(node, 'ki_keywords', fields.keywords)
  for (const [key, value] of Object.entries(fields.extra ?? {})) {
    if (value) setSymbolProperty(node, key, value)
  }

  // Reference and Value are read off the sheet; everything else is data a
  // reader opens the fields dialog for, so it is hidden like the library's own.
  for (const key of ['Footprint', 'Datasheet', 'Description', ...Object.keys(fields.extra ?? {})]) {
    const property = symbolPropertyNode(node, key)
    if (property) setSymbolPropertyVisible(property, false)
  }
}

/**
 * Add (or replace) a symbol with fields and no body, for one drawn by hand:
 * the editor's New Symbol, with the fields `generateSymbol` writes. Reference
 * sits above the origin and Value below; a power port's Reference is hidden,
 * as the standard `power` library writes it.
 */
export function generateBlankSymbol(
  library: KicadSymbolLibrary,
  name: string,
  fields: SymbolFields,
  power?: SymbolPowerKind
): GenerateResult {
  const existing = library.symbols.get(name)
  if (existing) removeSymbol(library.root, existing._node)
  const node = addSymbol(library.root, name)
  writeFields(node, fields)
  const pitch = mmToNm(2.54)
  placeAt(node, 'Reference', pitch)
  placeAt(node, 'Value', (0 - pitch) as Nm)
  if (power) {
    setSymbolPowerKind(node, power)
    const reference = symbolPropertyNode(node, 'Reference')
    if (reference) setSymbolPropertyVisible(reference, false)
  }
  return { library, replaced: existing !== undefined }
}

/** Move a field `y` (file frame, y up) from the origin `addSymbol` scaffolds it at. */
function placeAt(symbolNode: SExprList, key: string, y: Nm): void {
  const property = symbolPropertyNode(symbolNode, key)
  if (property) translateSymbolPropertyNode(property, 0 as Nm, y)
}

/**
 * Put a property where the layout says.
 *
 * A *translate*, which is an absolute placement here because both routes that
 * create a property — `addSymbol`'s Reference/Value scaffold and
 * `setSymbolProperty`'s new node — put it at the origin. Stated rather than
 * assumed, since it is only true of a freshly built symbol.
 */
function placeField(
  symbolNode: SExprList,
  key: string,
  at: { x: Nm; y: Nm; justify: 'left' }
): void {
  const property = symbolPropertyNode(symbolNode, key)
  if (!property) return
  translateSymbolPropertyNode(property, at.x, at.y)
  // Left-justified, so the `at` is the text's left edge rather than its center —
  // otherwise a long Value grows back over the pins the position was chosen to
  // clear.
  setSymbolPropertyJustify(property, at.justify)
}

/** Parse a library, or start an empty one when the project has none. */
export const parseOrCreateLibrary = (source: string | null): KicadSymbolLibrary =>
  parseKicadSymbolLibrary(source && source.trim() ? source : EMPTY_SYMBOL_LIBRARY)
