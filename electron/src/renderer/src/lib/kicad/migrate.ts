/**
 * Format migration: an older KiCad file to the one version we write (RULES.md §7,
 * format-migration-workstream.md). Each step ports one of the version gates in
 * KiCad's own parsers — where a later release reads the same syntax with a
 * different meaning — so that KiCad 10 reads the migrated file as the same
 * design it reads from the original. Defaults and spelling are not steps:
 * KiCad reads either, and the equivalence bar compares after its own upgrade.
 */
import {
  findChild,
  findChildren,
  getAtomValues,
  getNumericValue,
  getToken,
  makeAtom,
  makeList,
  markNodeDirty,
  setScalarChild,
  type SExprList,
  type SExprNode
} from './sexpr'
import {
  arcCenterFromAngle,
  arcCenterFromPoints,
  arcMid,
  arcSweep,
  kiRound,
  roundPoint,
  truncPoint,
  type IuPoint
} from './kicadArc'

export type KicadFormat = 'kicad_sch' | 'kicad_pcb' | 'kicad_symbol_lib' | 'footprint'

/** What KiCad 10 writes (`SEXPR_*_FILE_VERSION`; format spec, version table). */
export const CURRENT_FORMAT_VERSION: Readonly<Record<KicadFormat, number>> = {
  kicad_sch: 20260306,
  kicad_pcb: 20260206,
  kicad_symbol_lib: 20251024,
  footprint: 20260206
}

/**
 * What each KiCad release writes, oldest first (format spec, version table).
 * A development build's version reads as the release that follows it.
 */
const RELEASES: Readonly<Record<KicadFormat, ReadonlyArray<readonly [number, number]>>> = {
  kicad_sch: [
    [6, 20211123],
    [7, 20230121],
    [8, 20231120],
    [9, 20250114],
    [10, 20260306]
  ],
  kicad_pcb: [
    [6, 20211014],
    [7, 20221018],
    [8, 20240108],
    [9, 20241229],
    [10, 20260206]
  ],
  kicad_symbol_lib: [
    [6, 20211014],
    [7, 20220914],
    [8, 20231120],
    [9, 20241209],
    [10, 20251024]
  ],
  footprint: [
    [6, 20211014],
    [7, 20221018],
    [8, 20240108],
    [9, 20241229],
    [10, 20260206]
  ]
}

/**
 * The KiCad major release that writes this version (a development build's,
 * the one it led to); below KiCad 6, 5, and past the newest we know, null.
 */
export function kicadReleaseOf(format: KicadFormat, version: number): number | null {
  const releases = RELEASES[format]
  if (version < releases[0][1]) return 5
  return releases.find(([, written]) => version <= written)?.[0] ?? null
}

/** The oldest version we open: what KiCad 6 wrote. Older files are its development builds. */
export const MIN_FORMAT_VERSION: Readonly<Record<KicadFormat, number>> = {
  kicad_sch: 20211123,
  kicad_pcb: 20211014,
  kicad_symbol_lib: 20211014,
  footprint: 20211014
}

interface MigrationStep {
  /** The first format version that no longer needs this step. */
  before: number
  apply: (root: SExprList) => void
}

/**
 * Before PCB fields (20230620) a footprint's `(property "name" "value")` was a
 * hidden key/value pair, some names standing for what are now attributes
 * (`parseFOOTPRINT_unchecked`). From it, a property is a field, visible unless
 * it says otherwise.
 */
/** The fields every footprint has (`FOOTPRINT::FOOTPRINT`). */
const FOOTPRINT_FIELDS = new Set(['Reference', 'Value', 'Datasheet', 'Description'])

function footprintPropertiesToFields(footprint: SExprList): void {
  const at = footprint.start
  const quotedPair = (token: string, value: string): SExprList =>
    makeList([makeAtom(token, false, at), makeAtom(value, true, at)], at)
  const angle = getAtomValues(findChild(footprint, 'at') ?? footprint)[2] ?? '0'
  const children: SExprNode[] = []
  for (const child of footprint.children) {
    if (child.type !== 'list' || getToken(child) !== 'property') {
      children.push(child)
      continue
    }
    const [name = '', value = ''] = getAtomValues(child)
    if (name === 'ki_keywords' || name === 'ki_locked') continue
    if (name === 'Sheetfile' || name === 'Sheet file') {
      children.push(quotedPair('sheetfile', value))
      continue
    }
    if (name === 'Sheetname' || name === 'Sheet name') {
      children.push(quotedPair('sheetname', value))
      continue
    }
    const field = makeList(
      [
        makeAtom('property', false, at),
        makeAtom(name === 'ki_description' ? 'Description' : name, true, at),
        makeAtom(value, true, at),
        ...child.children.slice(3)
      ],
      at
    )
    // A footprint's own fields sit at its origin, turned with it; KiCad makes
    // any other as a new field, placed as a field without `(at …)` is.
    const fieldName = getAtomValues(field)[0] ?? ''
    if (FOOTPRINT_FIELDS.has(fieldName) && !findChild(field, 'at')) {
      field.children.splice(
        3,
        0,
        makeList(
          ['at', '0', '0', angle].map((v) => makeAtom(v, false, at)),
          at
        )
      )
    }
    if (!findChild(field, 'hide')) {
      field.children.push(makeList([makeAtom('hide', false, at), makeAtom('yes', false, at)], at))
    }
    children.push(field)
  }
  footprint.children = children
  markNodeDirty(footprint)
}

/** Where an atom that is exactly `~` meant empty text, make it empty. */
function tildeToEmpty(node: SExprList, index: number): void {
  const atom = node.children[index]
  if (atom?.type === 'atom' && atom.value === '~') {
    atom.value = ''
    atom.quoted = true
  }
}

/**
 * Before 20250318 a lone `~` was how KiCad wrote empty text; from it, `~` is
 * literal. In a symbol definition: property values, pin names and numbers
 * (`parseProperty`, `parseSymbolPin`).
 */
function symbolTildesToEmpty(symbol: SExprList): void {
  for (const property of findChildren(symbol, 'property')) tildeToEmpty(property, 2)
  for (const unit of findChildren(symbol, 'symbol')) {
    for (const pin of findChildren(unit, 'pin')) {
      for (const token of ['name', 'number']) {
        const child = findChild(pin, token)
        if (child) tildeToEmpty(child, 1)
      }
    }
  }
}

/** A unit symbol is named `<symbol>_<unit>_<body style>`. */
const bodyStyleOf = (unit: SExprList): number =>
  Number(/_(\d+)$/.exec(getAtomValues(unit)[0] ?? '')?.[1] ?? 1)

/**
 * Before 20250827 a symbol had a De Morgan body style when any drawing used
 * the second one, its own or its root's (`HasLegacyAlternateBodyStyle`); from
 * it, the symbol says so.
 */
function markDeMorganSymbols(symbols: SExprList[]): void {
  const byName = new Map(symbols.map((symbol) => [getAtomValues(symbol)[0] ?? '', symbol]))
  const drawsAlternate = (symbol: SExprList, seen = new Set<SExprList>()): boolean => {
    if (seen.has(symbol)) return false
    seen.add(symbol)
    if (findChildren(symbol, 'symbol').some((unit) => bodyStyleOf(unit) > 1)) return true
    const extended = findChild(symbol, 'extends')
    const parent = extended && byName.get(getAtomValues(extended)[0] ?? '')
    return !!parent && drawsAlternate(parent, seen)
  }
  for (const symbol of symbols) {
    if (findChild(symbol, 'body_styles') || !drawsAlternate(symbol)) continue
    const at = symbol.start
    // KiCad writes it after the name and any `extends`/`power`.
    let index = 2
    while (
      index < symbol.children.length &&
      ['extends', 'power'].includes(getToken(symbol.children[index]) ?? '')
    )
      index++
    symbol.children.splice(
      index,
      0,
      makeList([makeAtom('body_styles', false, at), makeAtom('demorgan', false, at)], at)
    )
  }
}

/** Schematic internal units per millimeter (`schIUScale`). */
const SCH_IU_PER_MM = 10_000

/**
 * Before KiCad 7 (up to 20230121) a symbol arc of 180° or more is repaired on
 * load (`parseSymbolArc`): one past 180° becomes its complement, one of exactly
 * 180° is pulled to 179.5°. KiCad's own integer math, so the written arc is the
 * one KiCad would write. Symbol y is flipped on load, and back on save.
 */
function repairSymbolArc(arc: SExprList): void {
  const read = (token: string): IuPoint | null => {
    const node = findChild(arc, token)
    const [x, y] = node ? getAtomValues(node).map(Number) : []
    if (x === undefined || y === undefined || Number.isNaN(x) || Number.isNaN(y)) return null
    return { x: kiRound(x * SCH_IU_PER_MM), y: -kiRound(y * SCH_IU_PER_MM) }
  }
  const startPoint = read('start')
  const midPoint = read('mid')
  const endPoint = read('end')
  if (!startPoint || !midPoint || !endPoint) return

  // `SetArcGeometry`: the center, then ends swapped if the winding disagrees.
  const center0 = roundPoint(arcCenterFromPoints(startPoint, midPoint, endPoint))
  const computedMid = arcMid(startPoint, endPoint, center0)
  const squared = (a: IuPoint, b: IuPoint): number => (a.x - b.x) ** 2 + (a.y - b.y) ** 2
  const swapped = squared(computedMid, midPoint) > squared(computedMid, center0)
  let start = swapped ? endPoint : startPoint
  let end = swapped ? startPoint : endPoint

  const sweep = arcSweep(start, end, center0)
  let center: IuPoint
  if (sweep > 180) {
    start = endPoint
    end = startPoint
    center = truncPoint(arcCenterFromAngle(start, end, 360 - sweep))
  } else if (sweep === 180) {
    center = truncPoint(arcCenterFromAngle(start, end, 179.5))
  } else {
    return
  }

  const mm = (iu: number): string => String(Number((iu / SCH_IU_PER_MM).toFixed(4)))
  const write = (token: string, p: IuPoint): void => {
    const node = findChild(arc, token)
    if (!node) return
    node.children = [
      node.children[0],
      makeAtom(mm(p.x), false, node.start),
      makeAtom(mm(-p.y), false, node.start)
    ]
  }
  write('start', start)
  write('mid', arcMid(start, end, center))
  write('end', end)
}

/** Every drawn arc of the given symbol definitions' units. */
const repairSymbolArcs = (symbols: SExprList[]): void => {
  for (const symbol of symbols) {
    for (const unit of findChildren(symbol, 'symbol'))
      findChildren(unit, 'arc').forEach(repairSymbolArc)
  }
}

/** The step over a symbol library's definitions, marking each one it may touch. */
const librarySymbols =
  (apply: (symbols: SExprList[]) => void) =>
  (root: SExprList): void => {
    const symbols = findChildren(root, 'symbol')
    apply(symbols)
    symbols.forEach(markNodeDirty)
  }

/**
 * The same change across a schematic: every field (`parseSchField` — symbol,
 * sheet and label fields — and `parseProperty` in `lib_symbols`), a library
 * symbol's pins, and a symbol instance's `(value …)` and `(footprint …)`
 * (`parseSchSymbolInstances`, `parseSchematicSymbol`).
 */
function schematicTildesToEmpty(root: SExprList): void {
  const walk = (node: SExprList, parent: string | null): void => {
    const token = getToken(node)
    if (token === 'property') tildeToEmpty(node, 2)
    else if (
      (token === 'value' || token === 'footprint') &&
      (parent === 'path' || parent === 'default_instance')
    )
      tildeToEmpty(node, 1)
    for (const child of node.children) if (child.type === 'list') walk(child, token)
  }
  for (const child of root.children) {
    if (child.type !== 'list') continue
    walk(child, null)
    markNodeDirty(child)
  }
  const libSymbols = findChild(root, 'lib_symbols')
  if (libSymbols) findChildren(libSymbols, 'symbol').forEach(symbolTildesToEmpty)
}

/**
 * In KiCad 6 (up to 20211123) a schematic graphic line's default style was
 * dashed (`parseSchPolyLine`); after it, default is solid.
 */
function defaultSchematicLinesToDash(root: SExprList): void {
  for (const polyline of findChildren(root, 'polyline')) {
    const at = polyline.start
    let stroke = findChild(polyline, 'stroke')
    if (!stroke) {
      stroke = makeList([makeAtom('stroke', false, at)], at)
      polyline.children.push(stroke)
    }
    const type = findChild(stroke, 'type')
    if (type && getAtomValues(type)[0] !== 'default') continue
    setScalarChild(stroke, 'type', 'dash')
    markNodeDirty(polyline)
  }
}

/**
 * Before 20260306 a variant's `(in_bom …)` was written inverted — `yes` meant
 * excluded from the BOM (`parseSchematicSymbol`, `parseSheet`); from it, `yes`
 * means included, as everywhere else.
 */
function invertVariantInBom(root: SExprList): void {
  const walk = (node: SExprList): boolean => {
    let touched = false
    if (getToken(node) === 'variant') {
      const inBom = findChild(node, 'in_bom')
      if (inBom) {
        setScalarChild(node, 'in_bom', getAtomValues(inBom)[0] === 'yes' ? 'no' : 'yes')
        touched = true
      }
    }
    for (const child of node.children) if (child.type === 'list' && walk(child)) touched = true
    return touched
  }
  for (const child of root.children) if (child.type === 'list' && walk(child)) markNodeDirty(child)
}

/**
 * Before 20230221 a power symbol's net was its hidden pin's name; from it, the
 * Value. KiCad copies the one to the other on open
 * (`SCH_SCREEN::FixLegacyPowerSymbolMismatches`): a placed symbol whose
 * library symbol is a global power symbol, with a hidden power-input first pin,
 * takes that pin's name as its Value.
 */
export function legacyPowerValuesFromPins(root: SExprList): void {
  const libSymbols = findChild(root, 'lib_symbols')
  if (!libSymbols) return
  const pinNameOf = new Map<string, string>()
  for (const symbol of findChildren(libSymbols, 'symbol')) {
    const power = findChild(symbol, 'power')
    if (!power || getAtomValues(power)[0] === 'local') continue
    const pin = findChildren(symbol, 'symbol').flatMap((unit) => findChildren(unit, 'pin'))[0]
    if (!pin || getAtomValues(pin)[0] !== 'power_in') continue
    const hide = findChild(pin, 'hide')
    const hidden = hide ? getAtomValues(hide)[0] !== 'no' : getAtomValues(pin).includes('hide')
    const name = findChild(pin, 'name')
    if (hidden && name) pinNameOf.set(getAtomValues(symbol)[0] ?? '', getAtomValues(name)[0] ?? '')
  }
  for (const symbol of findChildren(root, 'symbol')) {
    const libName = findChild(symbol, 'lib_name') ?? findChild(symbol, 'lib_id')
    const pinName = libName ? pinNameOf.get(getAtomValues(libName)[0] ?? '') : undefined
    if (pinName === undefined) continue
    setPropertyValue(symbol, 'Value', pinName)
    markNodeDirty(symbol)
  }
}

/** A schematic's embedded library symbols, for the steps symbol libraries share. */
const embeddedSymbols =
  (apply: (symbols: SExprList[]) => void) =>
  (root: SExprList): void => {
    const libSymbols = findChild(root, 'lib_symbols')
    if (!libSymbols) return
    apply(findChildren(libSymbols, 'symbol'))
    markNodeDirty(libSymbols)
  }

/**
 * KiCad 9's layer ids by KiCad 8's (`BoardLayerFromLegacyId`): copper 0/1–30/31
 * becomes 0/2n+2/2, the rest (32–59) the odd ids, by name.
 */
const LEGACY_LAYER_IDS: readonly number[] = [
  0,
  ...Array.from({ length: 30 }, (_, i) => 2 * (i + 1) + 2),
  2,
  // B.Adhes F.Adhes B.Paste F.Paste B.SilkS F.SilkS B.Mask F.Mask
  11,
  9,
  15,
  13,
  7,
  5,
  3,
  1,
  // Dwgs Cmts Eco1 Eco2 Edge.Cuts Margin B.CrtYd F.CrtYd B.Fab F.Fab
  17,
  19,
  21,
  23,
  25,
  27,
  29,
  31,
  33,
  35,
  // User.1–9, Rescue
  39,
  41,
  43,
  45,
  47,
  49,
  51,
  53,
  55,
  37
]

/**
 * A layer mask in KiCad 8's ids, as `BASE_SET::FmtHex` wrote it (hex, least
 * significant bit first from the right, `_` every 8 digits), in KiCad 9's.
 */
function remapLegacyLayerMask(hex: string): string {
  let legacy = 0n
  for (const digit of hex.replace(/_/g, '')) legacy = (legacy << 4n) | BigInt(parseInt(digit, 16))
  let mask = 0n
  LEGACY_LAYER_IDS.forEach((id, legacyId) => {
    if ((legacy >> BigInt(legacyId)) & 1n) mask |= 1n << BigInt(id)
  })
  const digits = mask.toString(16).padStart(32, '0')
  return digits.match(/.{8}/g)!.join('_')
}

/**
 * The plot settings' layer masks moved to the new ids at 20240819, ahead of
 * the board's (`PCB_PLOT_PARAMS_PARSER`, `remapLegacyLayerLSET`).
 */
function remapPlotLayerMasks(root: SExprList): void {
  const params = findChild(findChild(root, 'setup') ?? root, 'pcbplotparams')
  if (!params) return
  for (const token of ['layerselection', 'plot_on_all_layers_selection']) {
    const atom = findChild(params, token)?.children[1]
    if (atom?.type !== 'atom' || !atom.value.startsWith('0x')) continue
    atom.value = `0x${remapLegacyLayerMask(atom.value.slice(2))}`
  }
  markNodeDirty(findChild(root, 'setup') ?? root)
}

/** KiCad 9's layer id for a KiCad 8 one (`BoardLayerFromLegacyId`); undefined past 59. */
export const layerIdFromLegacy = (legacy: number): number | undefined => LEGACY_LAYER_IDS[legacy]

/** KiCad 8's layer id for a KiCad 9 one, for data still written in the old ids. */
export const legacyLayerId = (id: number): number | undefined => {
  const legacy = LEGACY_LAYER_IDS.indexOf(id)
  return legacy < 0 ? undefined : legacy
}

/**
 * KiCad 9 renumbered the layers (20241229): the board's layer table moves to
 * the new ids. KiCad reads the table by name, so this changes nothing it sees;
 * it is what lets every writer here speak KiCad 10's ids alone.
 */
function renumberLayerTable(root: SExprList): void {
  const layers = findChild(root, 'layers')
  if (!layers) return
  for (const row of layers.children) {
    const id = row.type === 'list' ? row.children[0] : undefined
    if (id?.type !== 'atom' || !/^\d+$/.test(id.value)) continue
    const renumbered = layerIdFromLegacy(Number(id.value))
    if (renumbered !== undefined) id.value = String(renumbered)
  }
  markNodeDirty(layers)
}

/**
 * Before 20250228 a via had no protection but tenting, so KiCad reads its
 * capping, covering, plugging and filling as off (`parsePCB_VIA`); from it, a
 * missing token inherits the board's stackup, so an older via says no.
 */
function viaProtectionOff(root: SExprList): void {
  const at = root.start
  const atom = (value: string): SExprNode => makeAtom(value, false, at)
  const flag = (token: string): SExprList => makeList([atom(token), atom('no')], at)
  const sides = (token: string): SExprList =>
    makeList([atom(token), flag('front'), flag('back')], at)
  for (const via of findChildren(root, 'via')) {
    const add: SExprList[] = []
    if (!findChild(via, 'capping')) add.push(flag('capping'))
    if (!findChild(via, 'covering')) add.push(sides('covering'))
    if (!findChild(via, 'plugging')) add.push(sides('plugging'))
    if (!findChild(via, 'filling')) add.push(flag('filling'))
    if (!add.length) continue
    via.children.push(...add)
    markNodeDirty(via)
  }
}

/**
 * Before 20230517 a board with a teardrop zone had KiCad 7's teardrops, which
 * KiCad marks on load (`parseZONE`); from it, the board says so.
 */
function markLegacyTeardrops(root: SExprList): void {
  const zones = [
    ...findChildren(root, 'zone'),
    ...findChildren(root, 'footprint').flatMap((footprint) => findChildren(footprint, 'zone'))
  ]
  if (!zones.some((zone) => findChild(findChild(zone, 'attr') ?? zone, 'teardrop'))) return
  const general = findChild(root, 'general')
  if (!general) return
  setScalarChild(general, 'legacy_teardrops', 'yes')
  markNodeDirty(general)
}

/** Oldest first; a file runs every step whose `before` is above its version. */
const STEPS: Readonly<Record<KicadFormat, readonly MigrationStep[]>> = {
  kicad_sch: [
    { before: 20211124, apply: defaultSchematicLinesToDash },
    { before: 20230122, apply: embeddedSymbols(repairSymbolArcs) },
    { before: 20230221, apply: legacyPowerValuesFromPins },
    { before: 20250318, apply: schematicTildesToEmpty },
    { before: 20250827, apply: embeddedSymbols(markDeMorganSymbols) },
    { before: 20260306, apply: invertVariantInBom }
  ],
  kicad_pcb: [
    {
      before: 20230620,
      apply: (root) => findChildren(root, 'footprint').forEach(footprintPropertiesToFields)
    },
    { before: 20230517, apply: markLegacyTeardrops },
    { before: 20240819, apply: remapPlotLayerMasks },
    { before: 20241229, apply: renumberLayerTable },
    { before: 20250228, apply: viaProtectionOff }
  ],
  kicad_symbol_lib: [
    { before: 20230122, apply: librarySymbols(repairSymbolArcs) },
    { before: 20250318, apply: librarySymbols((symbols) => symbols.forEach(symbolTildesToEmpty)) },
    { before: 20250827, apply: librarySymbols(markDeMorganSymbols) }
  ],
  footprint: [{ before: 20230620, apply: footprintPropertiesToFields }]
}

/** The format a document's root token names, if it is one we migrate. */
export const formatOfToken = (token: string | null): KicadFormat | null =>
  token === 'kicad_sch' ||
  token === 'kicad_pcb' ||
  token === 'kicad_symbol_lib' ||
  token === 'footprint'
    ? token
    : null

export const formatOf = (root: SExprList): KicadFormat | null => formatOfToken(getToken(root))

/** The file's `(version …)`; undefined where it has none (a board's footprints). */
export const formatVersion = (root: SExprList): number | undefined => {
  const node = findChild(root, 'version')
  return node ? getNumericValue(node) : undefined
}

/** Older than we open (`unsupported`), migrated on save (`older`), or read-only (`newer`). */
export type FormatStatus = 'unsupported' | 'older' | 'current' | 'newer'

/** Where a version stands against what we open and write. */
export const versionStatus = (format: KicadFormat, version: number): FormatStatus => {
  if (version < MIN_FORMAT_VERSION[format]) return 'unsupported'
  const current = CURRENT_FORMAT_VERSION[format]
  return version < current ? 'older' : version > current ? 'newer' : 'current'
}

export const formatStatus = (root: SExprList): FormatStatus | null => {
  const format = formatOf(root)
  const version = formatVersion(root)
  return format && version !== undefined ? versionStatus(format, version) : null
}

/**
 * Bring an older file to the current version, in place. Any other file —
 * current, newer, older than we open, or not a KiCad document — is left alone.
 */
export function migrateToCurrent(root: SExprList): boolean {
  if (formatStatus(root) !== 'older') return false
  const format = formatOf(root)!
  const version = formatVersion(root)!
  for (const step of STEPS[format]) if (version < step.before) step.apply(root)
  const versionNode = findChild(root, 'version')!
  markNodeDirty(versionNode)
  setScalarChild(root, 'version', String(CURRENT_FORMAT_VERSION[format]))
  return true
}

/** Before this, the root schematic held every symbol's instance data (`symbol_instances`). */
const SYMBOL_INSTANCES_IN_ROOT_BEFORE = 20221002
/** Before this, it held every sheet's page number (`sheet_instances`). */
const SHEET_INSTANCES_IN_ROOT_BEFORE = 20221110

const quoted = (value: string, at: number): SExprNode => makeAtom(value, true, at)
const pair = (token: string, value: SExprNode, at: number): SExprList =>
  makeList([makeAtom(token, false, at), value], at)

const uuidOf = (node: SExprList): string => getAtomValues(findChild(node, 'uuid') ?? node)[0] ?? ''

/** A sheet field's value, matched as KiCad does: case-insensitive, KiCad 6's names aliased. */
const sheetFieldValue = (node: SExprList, canonical: string): string | undefined => {
  for (const property of findChildren(node, 'property')) {
    const [name = '', value] = getAtomValues(property)
    const lower = name.toLowerCase()
    if (lower === canonical || lower === canonical.replace('sheet', 'sheet ')) return value
  }
  return undefined
}

/** Set an existing field's value; KiCad leaves a field the symbol lacks alone. */
const setPropertyValue = (node: SExprList, name: string, value: string): void => {
  const property = findChildren(node, 'property').find((p) => getAtomValues(p)[0] === name)
  const atom = property?.children[2]
  if (atom?.type === 'atom') {
    atom.value = value
    atom.quoted = true
  }
}

/** Add `(path "<path>" …entries)` under the node's `(instances (project "<name>" …))`. */
function addInstance(node: SExprList, project: string, path: string, entries: SExprList[]): void {
  const at = node.start
  let instances = findChild(node, 'instances')
  if (!instances) {
    instances = makeList([makeAtom('instances', false, at)], at)
    node.children.push(instances)
  }
  let projectNode = findChildren(instances, 'project').find(
    (candidate) => getAtomValues(candidate)[0] === project
  )
  if (!projectNode) {
    projectNode = makeList([makeAtom('project', false, at), quoted(project, at)], at)
    instances.children.push(projectNode)
  }
  if (findChildren(projectNode, 'path').some((candidate) => getAtomValues(candidate)[0] === path))
    return
  projectNode.children.push(
    makeList([makeAtom('path', false, at), quoted(path, at), ...entries], at)
  )
}

interface LegacySymbolInstance {
  reference: string
  unit: string
  value: string
  footprint: string
}

/**
 * Move a legacy root's instance data into the hierarchy, as KiCad does on
 * open (`SCH_SHEET_LIST::UpdateSymbolInstanceData`, `UpdateSheetInstanceData`):
 * each placed symbol gets its `(instances …)` and takes its reference, value
 * and footprint from the root's record, and each sheet its page number. The
 * root's records are keyed by path without the root's own uuid, which the
 * moved paths start with. Run on the root before `migrateToCurrent` — the
 * version decides — with every sheet file `sheetFile` can resolve; a shared
 * sheet's symbols take one instance per path. Returns every schematic it
 * changed, for the caller to save together: once the root is saved, the data
 * is gone from it.
 */
export function moveLegacyInstances(
  root: SExprList,
  project: string,
  sheetFile: (name: string, parent: SExprList) => SExprList | undefined
): SExprList[] {
  const version = formatVersion(root)
  if (formatOf(root) !== 'kicad_sch' || version === undefined) return []
  const movesSymbols = version < SYMBOL_INSTANCES_IN_ROOT_BEFORE
  const movesSheets = version < SHEET_INSTANCES_IN_ROOT_BEFORE
  if (!movesSymbols && !movesSheets) return []

  const rootUuid = uuidOf(root)
  const symbolRecords = new Map<string, LegacySymbolInstance>()
  const symbolInstances = findChild(root, 'symbol_instances')
  for (const path of symbolInstances ? findChildren(symbolInstances, 'path') : []) {
    const scalar = (token: string): string => getAtomValues(findChild(path, token) ?? path)[0] ?? ''
    symbolRecords.set(getAtomValues(path)[0] ?? '', {
      reference: findChild(path, 'reference') ? scalar('reference') : '',
      unit: findChild(path, 'unit') ? scalar('unit') : '1',
      value: findChild(path, 'value') ? scalar('value') : '',
      footprint: findChild(path, 'footprint') ? scalar('footprint') : ''
    })
  }
  // Only a pre-20221002 root writes its sheet records without its own uuid.
  const sheetKey = (path: SExprList): string => {
    const key = getAtomValues(path)[0] ?? ''
    if (movesSymbols || !key.startsWith(`/${rootUuid}`)) return key
    return key.slice(rootUuid.length + 1) || '/'
  }
  const pages = new Map<string, string>()
  const sheetInstances = findChild(root, 'sheet_instances')
  for (const path of sheetInstances ? findChildren(sheetInstances, 'path') : []) {
    const page = findChild(path, 'page')
    if (page) pages.set(sheetKey(path), getAtomValues(page)[0] ?? '')
  }

  const changed = new Set<SExprList>()
  const walk = (screen: SExprList, sheetPath: string[], seen: Set<SExprList>): void => {
    const at = screen.start
    // A sheet saved since the move already holds its instances; the root's
    // records are stale for it.
    const screenVersion = formatVersion(screen) ?? 0
    const takesSymbols = movesSymbols && screenVersion < SYMBOL_INSTANCES_IN_ROOT_BEFORE
    const takesSheets = movesSheets && screenVersion < SHEET_INSTANCES_IN_ROOT_BEFORE
    const instancePath = `/${[rootUuid, ...sheetPath].join('/')}`
    for (const child of screen.children) {
      if (child.type !== 'list') continue
      const token = getToken(child)
      if (token === 'symbol' && takesSymbols && findChild(child, 'lib_id')) {
        const record = symbolRecords.get(`/${[...sheetPath, uuidOf(child)].join('/')}`)
        if (!record) continue
        addInstance(child, project, instancePath, [
          pair('reference', quoted(record.reference, at), at),
          pair('unit', makeAtom(record.unit, false, at), at)
        ])
        setPropertyValue(child, 'Reference', record.reference)
        if (record.value) setPropertyValue(child, 'Value', record.value)
        if (record.footprint) setPropertyValue(child, 'Footprint', record.footprint)
        markNodeDirty(child)
        changed.add(screen)
      } else if (token === 'sheet') {
        const childPath = [...sheetPath, uuidOf(child)]
        const page = pages.get(`/${childPath.join('/')}`)
        if (takesSheets && page !== undefined) {
          addInstance(child, project, instancePath, [pair('page', quoted(page, at), at)])
          markNodeDirty(child)
          changed.add(screen)
        }
        const name = sheetFieldValue(child, 'sheetfile')
        const sub = name === undefined ? undefined : sheetFile(name, screen)
        if (sub && !seen.has(sub)) walk(sub, childPath, new Set([...seen, sub]))
      }
    }
  }
  walk(root, [], new Set([root]))

  // The root keeps only its own page; the rest now live on the sheets.
  root.children = root.children.filter((child) => child !== symbolInstances)
  if (sheetInstances && movesSheets) {
    sheetInstances.children = sheetInstances.children.filter(
      (child) => child.type !== 'list' || sheetKey(child) === '/'
    )
    for (const path of findChildren(sheetInstances, 'path')) {
      const atom = path.children[1]
      if (atom?.type === 'atom') atom.value = '/'
    }
    markNodeDirty(sheetInstances)
  }
  changed.add(root)
  return [...changed]
}
