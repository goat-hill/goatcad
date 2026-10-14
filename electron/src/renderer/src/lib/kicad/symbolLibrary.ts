// KiCad symbol library (.kicad_sym) mapper for the symbol library editor.
//
// The parsed library keeps the REAL (kicad_symbol_lib ...) root AST (`root`)
// as the sole serialization source, so authoring edits mutate real symbol
// nodes and save back byte-for-byte losslessly (RULES.md §7). Typed
// KicadLibSymbol views (`symbols`) are derived from that root — their `_node`
// points into it, so editing a view edits the file.
//
// A second, schematic-wrapped copy (`doc`) exists ONLY to build the render
// preview: rather than duplicate the lib-symbol grammar for the renderer, the
// symbol definitions are wrapped in a bare (kicad_sch ...) document that reuses
// the schematic placement plumbing (addSchematicSymbolToAST), so SchematicScene
// renders a library symbol exactly as it renders a placed instance. `doc` is
// NEVER an edit or serialize source — going through it would drop top-level
// nodes and reformat every symbol.

import {
  findChild,
  findChildren,
  getToken,
  parseSExpr,
  serializeSExpr,
  type SExprList
} from './sexpr'
import {
  addSchematicSymbolToAST,
  getLibSymbolProperty,
  libSymbolChain,
  libSymbolUnitPins,
  parseKicadSchematic,
  parseLibSymbol,
  schematicFieldKey,
  serializeKicadSchematic,
  symbolPartKey,
  type KicadLibSymbol,
  type KicadSchematic
} from './schematic'
import type { SymbolPartAddress } from '../symbol/symbolEdit'
import { nm } from './coordinates'
import { CURRENT_FORMAT_VERSION, migrateToCurrent } from './migrate'

export interface KicadSymbolLibrary {
  /** Top-level symbol names, in file order (units are nested, not listed). */
  names: string[]
  /** The real parsed (kicad_symbol_lib ...) root — the sole serialize source. */
  root: SExprList
  /** Typed views whose `_node` points into `root`'s real (symbol ...) children. */
  symbols: Map<string, KicadLibSymbol>
  /** Preview-only schematic wrapper. NEVER an edit or serialize source. */
  doc: KicadSchematic
}

const wrapInSchematic = (symbolSources: string[]): string =>
  `(kicad_sch\n  (version ${CURRENT_FORMAT_VERSION.kicad_sch})\n  (generator "goatcad")\n  (lib_symbols\n${symbolSources.join('\n')}\n  )\n)\n`

export function parseKicadSymbolLibrary(source: string): KicadSymbolLibrary {
  const parsed = parseSExpr(source)
  if (parsed.type !== 'list' || getToken(parsed) !== 'kicad_symbol_lib') {
    throw new Error('Expected a KiCad (kicad_symbol_lib ...) document')
  }
  // Library content is read everywhere; every reader sees KiCad 10's (RULES.md §7).
  migrateToCurrent(parsed)
  const symbolNodes = findChildren(parsed, 'symbol')
  // Typed views over the REAL nodes — edits target these, not the wrapper below.
  const symbols = new Map<string, KicadLibSymbol>()
  const names: string[] = []
  for (const node of symbolNodes) {
    const symbol = parseLibSymbol(node)
    symbols.set(symbol.name, symbol)
    names.push(symbol.name)
  }
  const doc = parseKicadSchematic(
    wrapInSchematic(symbolNodes.map((node) => serializeSExpr(node, 2)))
  )
  return { names, root: parsed, symbols, doc }
}

/**
 * Serialize back to `.kicad_sym` text from the real root — the only lossless
 * path. Because it serializes `library.root`, untouched symbols and unknown or
 * future top-level nodes round-trip byte-identically; a one-symbol edit diffs
 * to only that symbol's subtree. Mirrors serializeKicadSchematic's trailing
 * newline. Never serialize from `library.doc` (see the module header).
 */
export function serializeKicadSymbolLibrary(library: KicadSymbolLibrary): string {
  return `${serializeSExpr(library.root)}\n`
}

/** The name atom of a `(symbol "X" ...)` node — the second child. */
const symbolNameAtom = (
  node: ReturnType<typeof findChildren>[number]
): { value: string } | null => {
  const atom = node.children[1]
  return atom && atom.type === 'atom' ? atom : null
}

/**
 * Parse a `.kicad_sym` library and namespace every top-level symbol to
 * `nickname:name`, matching the `(lib_symbols ...)` shape KiCad writes into a
 * schematic when a library part is placed (`Device:R`, with nested unit
 * sub-symbols like `R_0_1` left bare). `(extends "Base")` references — always
 * to a sibling in the same library — are prefixed to stay resolvable. The
 * result feeds the schematic chooser exactly like an already-embedded symbol,
 * so placement (`ensureLibSymbolsInAST` + `addSchematicSymbolToAST`) is
 * unchanged.
 */
export function namespaceSymbolLibrary(source: string, nickname: string): KicadSymbolLibrary {
  const parsed = parseSExpr(source)
  if (parsed.type !== 'list') {
    throw new Error('Expected a KiCad (kicad_symbol_lib ...) or (kicad_sch ...) document')
  }
  const token = getToken(parsed)
  // Embedded project symbols live in a schematic's `(lib_symbols …)` block, where
  // the definitions are already namespaced to full lib_ids (`Device:C`). The index
  // records such a symbol with the sheet as its `file`, so the viewer can be handed
  // a `(kicad_sch …)` document instead of a `.kicad_sym` — parse it as a schematic
  // and hand back its lib symbols directly, no per-symbol namespacing needed.
  if (token === 'kicad_sch') {
    const doc = parseKicadSchematic(migrateToCurrent(parsed) ? serializeSExpr(parsed) : source)
    return { names: [...doc.libSymbols.keys()], root: parsed, symbols: doc.libSymbols, doc }
  }
  if (token !== 'kicad_symbol_lib') {
    throw new Error('Expected a KiCad (kicad_symbol_lib ...) or (kicad_sch ...) document')
  }
  migrateToCurrent(parsed)
  const symbolNodes = findChildren(parsed, 'symbol')
  // Early KiCad 6 libraries wrote names with a library prefix (`lib:Name`); the
  // name is what follows it, as KiCad reads it.
  const namespaced = (name: string): string => `${nickname}:${name.slice(name.indexOf(':') + 1)}`
  for (const node of symbolNodes) {
    const name = symbolNameAtom(node)
    if (name) name.value = namespaced(name.value)
    const extendsNode = findChild(node, 'extends')
    const parent = extendsNode ? symbolNameAtom(extendsNode) : null
    if (parent) parent.value = namespaced(parent.value)
  }
  const symbols = new Map<string, KicadLibSymbol>()
  const names: string[] = []
  for (const node of symbolNodes) {
    const symbol = parseLibSymbol(node)
    symbols.set(symbol.name, symbol)
    names.push(symbol.name)
  }
  const doc = parseKicadSchematic(
    wrapInSchematic(symbolNodes.map((node) => serializeSExpr(node, 2)))
  )
  return { names, root: parsed, symbols, doc }
}

/**
 * A single-symbol schematic document for the viewer: the chosen definition
 * (plus its extends chain) is copied into a fresh document and placed at the
 * origin with its lib properties. `unit` selects which gate of a multi-unit
 * package is drawn — the unit-0 common body always renders with it — and
 * `bodyStyle` which alternate representation, style 0 always rendering with it.
 * Returns null for unknown names.
 */
export function buildSymbolPreviewSchematic(
  library: KicadSymbolLibrary,
  name: string,
  unit = 1,
  bodyStyle = 1
): KicadSchematic | null {
  return buildSymbolPreviewFromDefinitions(library.symbols, name, unit, bodyStyle)
}

/**
 * The same preview from any map of definitions — a parsed library's, or the
 * `lib_symbols` of the schematic a symbol source wraps a library in — so a
 * caller holding a `LibrarySymbol` entry can draw it without re-parsing.
 */
export function buildSymbolPreviewFromDefinitions(
  definitions: ReadonlyMap<string, KicadLibSymbol>,
  name: string,
  unit = 1,
  bodyStyle = 1
): KicadSchematic | null {
  const definition = definitions.get(name)
  if (!definition) return null
  // Wrap only this symbol's extends chain — a large library carries hundreds
  // of sibling definitions the preview doesn't need to re-serialize.
  const chain = libSymbolChain(definition, (parent) => definitions.get(parent))
  const doc = parseKicadSchematic(
    wrapInSchematic(chain.map((entry) => serializeSExpr(entry._node, 2)))
  )
  const target = doc.libSymbols.get(name)
  if (!target) return null
  const targetChain = libSymbolChain(target, (parent) => doc.libSymbols.get(parent))
  const reference = getLibSymbolProperty(target, 'Reference') ?? 'U'
  addSchematicSymbolToAST(
    doc,
    target,
    { x: nm(0), y: nm(0), angle: 0 },
    reference,
    libSymbolUnitPins(targetChain, unit, bodyStyle),
    [],
    unit,
    bodyStyle
  )
  // The editors' serialize→reparse cycle: re-derive the typed views from the
  // mutated AST so the scene sees the placed symbol.
  return parseKicadSchematic(serializeKicadSchematic(doc))
}

/**
 * What `SchematicScene` files a part's paint under, in a preview document from
 * `buildSymbolPreviewSchematic` — the one name the symbol editor and the
 * renderer must agree on, so a selection haloes and moves the strokes it names.
 *
 * Two facts about the preview fix everything the renderer's own key needs
 * beyond the address, which is why this lives here rather than with the edit
 * helpers:
 *
 * - The document holds exactly ONE placed symbol, so it is always `symbol:0`.
 * - The editor only ever addresses parts the edited definition declares itself.
 *   Inherited geometry belongs to a parent in the `extends` chain and is not
 *   editable here (a derived symbol carries none of its own), so the chain
 *   depth is always 0.
 *
 * `symbolPartKey` spells the rest, so the naming rule lives in exactly one
 * place and this cannot drift from what the scene actually wrote.
 */
export function symbolPreviewPartKey(address: SymbolPartAddress): string {
  // A field is named, not indexed — the scene's own rule.
  if (address.kind === 'field') {
    return `symbol:0/${schematicFieldKey(address.field ?? '')}`
  }
  return `symbol:0/${symbolPartKey(address.kind, {
    depth: 0,
    unit: address.unit,
    style: address.style,
    index: address.index
  })}`
}
