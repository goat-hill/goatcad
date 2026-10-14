// Parts follow KiCad's source, named below: Copyright The KiCad Developers, GPL-3.0-or-later.
/**
 * Units and body styles of a placed symbol: the choices a placement offers and
 * who else already holds a unit, for KiCad's Change Unit and Change Body Style
 * (`SCH_EDIT_FRAME::SelectUnit`, `SelectBodyStyle`). Pure; the writes are
 * `setSchematicSymbolUnit` / `setSchematicSymbolBodyStyle`.
 */
import {
  definitionIdOf,
  libSymbolChain,
  libSymbolUnitCount,
  referenceForSheetPath,
  type KicadLibSymbol,
  type KicadSchematic,
  type KicadSchematicSymbol
} from '../kicad/schematic'
import { findChild, findChildren, getAtomValues } from '../kicad/sexpr'

/** The definition a placement draws, with its `extends` parents, from the
 *  sheet's own `lib_symbols`; empty when the sheet does not carry it. */
export function placedSymbolChain(
  document: KicadSchematic,
  symbol: KicadSchematicSymbol
): KicadLibSymbol[] {
  const definition = document.libSymbols.get(definitionIdOf(symbol))
  return definition ? libSymbolChain(definition, (name) => document.libSymbols.get(name)) : []
}

/** How many units and body styles a placement can show. */
export function placedSymbolChoices(
  document: KicadSchematic,
  symbol: KicadSchematicSymbol
): { units: number; bodyStyles: number } {
  const chain = placedSymbolChain(document, symbol)
  return { units: libSymbolUnitCount(chain), bodyStyles: libBodyStyleCount(chain) }
}

/** KiCad's `LIB_SYMBOL::LetterSubReference`: 1 → A … 26 → Z, 27 → AA. */
export const letterSubReference = (unit: number): string => lettersFrom(unit, 65)

/** The same, counted from the character `initial` (a project's first id). */
const lettersFrom = (unit: number, initial: number): string => {
  let suffix = ''
  let n = unit
  do {
    const u = (n - 1) % 26
    suffix = String.fromCharCode(initial + u) + suffix
    n = Math.floor((n - u) / 26)
  } while (n > 0)
  return suffix
}

/**
 * How a project writes a unit after its reference: the project file's
 * `schematic.subpart_id_separator` and `subpart_first_id`, as character codes
 * (`extractSubpartSettings`). KiCad's default is no separator and A.
 */
export interface SubpartSettings {
  separator: number
  firstId: number
}

export const KICAD_SUBPART: SubpartSettings = { separator: 0, firstId: 65 }

/**
 * KiCad's `SCH_SYMBOL::SubReference` (`eeschema/sch_symbol.cpp`, with
 * `SCHEMATIC_SETTINGS::SubReference`): the library's name for the unit when it
 * has one, else a letter counted from the first id or, when that is a digit,
 * the unit number; the separator before either.
 */
export function subReference(
  unit: number,
  settings: SubpartSettings = KICAD_SUBPART,
  unitName?: string | null
): string {
  const separator = settings.separator ? String.fromCharCode(settings.separator) : ''
  if (unitName) return `${separator}${unitName}`
  if (unit < 1) return ''
  const digit = settings.firstId >= 48 && settings.firstId <= 57
  return `${separator}${digit ? String(unit) : lettersFrom(unit, settings.firstId)}`
}

/**
 * The library's `(unit_name …)` for `unit`. A sheet's copy names itself
 * `Nickname:Name` and its sub-symbols `Name_<unit>_<style>`, so the unit is
 * read off the end.
 */
const unitNameOf = (definition: KicadLibSymbol, unit: number): string | null => {
  for (const node of findChildren(definition._node, 'symbol')) {
    const match = /_(\d+)_(\d+)$/.exec(getAtomValues(node)[0] ?? '')
    if (!match || Number(match[1]) !== unit) continue
    const name = findChild(node, 'unit_name')
    const value = name ? getAtomValues(name)[0] : undefined
    if (value) return value
  }
  return null
}

/**
 * The item id of one placement: its reference, with the unit as KiCad shows it
 * (`U5A`) when the symbol draws more than one unit.
 */
export function unitItemId(
  document: KicadSchematic,
  symbol: KicadSchematicSymbol,
  reference: string,
  settings: SubpartSettings = KICAD_SUBPART
): string {
  const chain = placedSymbolChain(document, symbol)
  if (libSymbolUnitCount(chain) <= 1) return reference
  return `${reference}${subReference(symbol.unit, settings, libUnitName(chain, symbol.unit))}`
}

/** The library's name for `unit` anywhere along a definition chain, or null. */
export const libUnitName = (chain: readonly KicadLibSymbol[], unit: number): string | null =>
  chain.map((definition) => unitNameOf(definition, unit)).find(Boolean) ?? null

/** How many body styles a definition draws: the highest style any of its
 *  sub-symbols names, 1 at minimum (2 for a De Morgan pair). */
export function libBodyStyleCount(chain: KicadLibSymbol[]): number {
  let max = 1
  for (const definition of chain) {
    for (const variant of definition.variants) max = Math.max(max, variant.style)
  }
  return max
}

/** The style after `current`, wrapping — KiCad's Cycle Body Style. */
export const nextBodyStyle = (current: number, count: number): number =>
  count <= 1 ? 1 : (Math.max(1, current) % count) + 1

/** One sheet instance the search walks. */
export interface UnitSource {
  filePath: string
  sheetPath: string
  schematic: KicadSchematic
}

/** One placement under one sheet instance, with the reference it has there. */
export interface UnitPlacement<S extends UnitSource = UnitSource> {
  source: S
  index: number
  symbol: KicadSchematicSymbol
  reference: string
}

/** Every placement in `sources`, per sheet instance. */
export const unitPlacements = <S extends UnitSource>(sources: readonly S[]): UnitPlacement<S>[] =>
  sources.flatMap((source) =>
    source.schematic.symbols.map((symbol, index) => ({
      source,
      index,
      symbol,
      reference: referenceForSheetPath(symbol, source.sheetPath) ?? ''
    }))
  )

/** An unannotated reference (`U?`) names no part: every one of them is its own. */
export const isAnnotated = (reference: string): boolean => !reference.endsWith('?')

/** A placement of a part, addressed across sheet files. */
export interface UnitHolder {
  filePath: string
  sheetPath: string
  symbolIndex: number
}

/**
 * The placement that already shows `unit` of the part named `reference`
 * (KiCad's `FindSymbolByRefAndUnit`), other than `self`, or null. A unit is
 * per instance: the instance's own unit wins over the placement's.
 */
export function findUnitHolder(
  sources: readonly UnitSource[],
  reference: string,
  unit: number,
  self: UnitHolder,
  samePath: (a: string, b: string) => boolean = (a, b) => a === b
): UnitHolder | null {
  for (const source of sources) {
    const symbols = source.schematic.symbols
    for (let index = 0; index < symbols.length; index++) {
      const symbol = symbols[index]
      if (
        index === self.symbolIndex &&
        source.sheetPath === self.sheetPath &&
        samePath(source.filePath, self.filePath)
      ) {
        continue
      }
      if (referenceForSheetPath(symbol, source.sheetPath) !== reference) continue
      const instance = symbol.instances.find((item) => item.path === source.sheetPath)
      if ((instance?.unit ?? symbol.unit) !== unit) continue
      return { filePath: source.filePath, sheetPath: source.sheetPath, symbolIndex: index }
    }
  }
  return null
}
