// Parts follow KiCad's source, named below: Copyright The KiCad Developers, GPL-3.0-or-later.
/**
 * The footprint swap: a placed footprint replaced by a library one, keeping
 * what the board gave it — KiCad's `PCB_EDIT_FRAME::ExchangeFootprint`, behind
 * both Update Footprints from Library and Change Footprints
 * (docs/libraries-workstream.md §5).
 *
 * Kept from the placed footprint: its uuid (groups name it), position, angle,
 * side and lock; its sheet link and footprint filters; each pad's net, pin
 * function and pin type, matched by pad number; its reference always, its
 * value unless the value only echoed the footprint's name. What else is kept
 * or taken fresh from the library is the caller's choice (`ExchangeOptions`),
 * with KiCad's defaults for each verb.
 *
 * Pure over the AST: `exchangeFootprints` replaces nodes in `board._raw`; the
 * caller runs it inside its command and remaps the board after.
 */
import type { KicadBoard, KicadBoardFootprint } from '../kicad/board'
import { nm } from '../kicad/coordinates'
import { parseFootprintNode, type KicadFootprint } from '../kicad/footprint'
import { boardLayerFlipper, isCopperLayer } from '../kicad/layers'
import {
  cloneNodeDeep,
  findChild,
  findChildren,
  getAtomValues,
  getToken,
  type SExprList,
  type SExprNode
} from '../kicad/sexpr'
import { instantiateLibraryFootprint, setFootprintAttributes } from './boardSync'
import { flippedFootprintNode } from './footprintFlip'
import { landFootprintNode } from './footprintPlace'

/** What the swap takes fresh from the library rather than keeping from the board. KiCad's checklist. */
export interface ExchangeOptions {
  /** Drop texts the placed footprint has and the library one does not. */
  removeExtraTexts: boolean
  /** Text layers and visibility. */
  resetTextLayers: boolean
  /** Text sizes, styles, justification and angle. */
  resetTextEffects: boolean
  /** Text positions. */
  resetTextPositions: boolean
  /** The text of fields other than Reference and Value. */
  resetTextContent: boolean
  /** SMD / through hole, position-file and courtyard flags, bridged mask. */
  resetFabricationAttributes: boolean
  /** Clearance, mask and paste margins, zone connection. */
  resetClearanceOverrides: boolean
  /** The 3D model links. */
  reset3DModels: boolean
}

export const EXCHANGE_OPTION_KEYS: readonly (keyof ExchangeOptions)[] = [
  'removeExtraTexts',
  'resetTextLayers',
  'resetTextEffects',
  'resetTextPositions',
  'resetTextContent',
  'resetFabricationAttributes',
  'resetClearanceOverrides',
  'reset3DModels'
]

/** KiCad's defaults for Update Footprints from Library: the design's text edits stay. */
export const UPDATE_DEFAULTS: ExchangeOptions = {
  removeExtraTexts: false,
  resetTextLayers: false,
  resetTextEffects: false,
  resetTextPositions: false,
  resetTextContent: false,
  resetFabricationAttributes: false,
  resetClearanceOverrides: true,
  reset3DModels: true
}

/** KiCad's defaults for Change Footprints: a new part comes as the library draws it. */
export const CHANGE_DEFAULTS: ExchangeOptions = {
  removeExtraTexts: false,
  resetTextLayers: true,
  resetTextEffects: true,
  resetTextPositions: true,
  resetTextContent: true,
  resetFabricationAttributes: true,
  resetClearanceOverrides: true,
  reset3DModels: true
}

/** A pad the swap could not carry over: on the placed footprint and not the new one, or the reverse. */
export interface ExchangePad {
  number: string
  /** The net the placed footprint's pad had; empty for a new pad. */
  net: string
}

export interface ExchangeReport {
  reference: string
  from: string
  to: string
  /** Pads with a net that the new footprint does not have: their tracks are left dangling. */
  droppedPads: ExchangePad[]
  /** Copper pads the new footprint adds, which come with no net. */
  addedPads: ExchangePad[]
}

// ---------------------------------------------------------------------------
// Small AST helpers
// ---------------------------------------------------------------------------

const tokenOf = (node: SExprNode): string | null => (node.type === 'list' ? getToken(node) : null)

const clone = <T extends SExprNode>(node: T): T => cloneNodeDeep(node) as T

const removeTokens = (node: SExprList, tokens: ReadonlySet<string>): void => {
  node.children = node.children.filter((child) => {
    const token = tokenOf(child)
    return !(token && tokens.has(token))
  })
}

const firstIndex = (node: SExprList, tokens: ReadonlySet<string>): number =>
  node.children.findIndex((child) => {
    const token = tokenOf(child)
    return token !== null && tokens.has(token)
  })

const afterLast = (node: SExprList, tokens: ReadonlySet<string>): number => {
  for (let index = node.children.length - 1; index >= 0; index--) {
    const token = tokenOf(node.children[index])
    if (token && tokens.has(token)) return index + 1
  }
  return -1
}

/** Put `items` where the first of `tokens` was, else before the first of `before`, else at the end. */
const replaceTokens = (
  node: SExprList,
  tokens: ReadonlySet<string>,
  items: SExprNode[],
  before: ReadonlySet<string>
): void => {
  const at = firstIndex(node, tokens)
  removeTokens(node, tokens)
  if (!items.length) return
  const index = at >= 0 ? at : firstIndex(node, before)
  node.children.splice(index >= 0 ? index : node.children.length, 0, ...items)
}

// ---------------------------------------------------------------------------
// Texts: fields and free texts
// ---------------------------------------------------------------------------

/** A text item's key: a field's name (`fp_text reference` is the Reference field), or null for a free text. */
const fieldName = (node: SExprList): string | null => {
  const token = getToken(node)
  const atoms = getAtomValues(node)
  if (token === 'property') return atoms[0] ?? ''
  if (token !== 'fp_text') return null
  if (atoms[0] === 'reference') return 'Reference'
  if (atoms[0] === 'value') return 'Value'
  return null
}

const textItems = (node: SExprList): SExprList[] =>
  node.children.filter(
    (child): child is SExprList =>
      child.type === 'list' && (getToken(child) === 'property' || getToken(child) === 'fp_text')
  )

const fieldsOf = (node: SExprList): Map<string, SExprList> => {
  const fields = new Map<string, SExprList>()
  for (const item of textItems(node)) {
    const name = fieldName(item)
    if (name !== null && !fields.has(name)) fields.set(name, item)
  }
  return fields
}

const freeTexts = (node: SExprList): SExprList[] =>
  textItems(node).filter((item) => fieldName(item) === null)

/** The text a text item shows: atom 2 of a property and of an `fp_text`. */
const textOf = (item: SExprList): string => {
  const atom = item.children[2]
  return atom?.type === 'atom' ? atom.value : ''
}

const setText = (item: SExprList, from: SExprList): void => {
  const source = from.children[2]
  if (source?.type !== 'atom') return
  if (item.children[2]?.type === 'atom') item.children[2] = clone(source)
}

const layerOf = (item: SExprList): string => {
  const layer = findChild(item, 'layer')
  return layer ? (getAtomValues(layer)[0] ?? '') : ''
}

/** A visibility mark outside the effects: `(hide yes)`, or the older bare `hide`. */
const isHideMark = (child: SExprNode): boolean =>
  child.type === 'atom' ? child.value === 'hide' : getToken(child) === 'hide'

const copyLayerAndVisibility = (item: SExprList, from: SExprList): void => {
  const layer = findChild(from, 'layer')
  if (layer) replaceTokens(item, new Set(['layer']), [clone(layer)], new Set(['uuid', 'effects']))
  const marks = from.children.filter((child, index) => index > 2 && isHideMark(child))
  item.children = item.children.filter((child, index) => index <= 2 || !isHideMark(child))
  if (marks.length) {
    const after = afterLast(item, new Set(['layer']))
    item.children.splice(after >= 0 ? after : item.children.length, 0, ...marks.map(clone))
  }
}

/** Atom `index` of an `(at x y [angle])`, written or dropped. */
const setAtAtom = (at: SExprList, index: number, value: SExprNode | undefined): void => {
  if (value?.type === 'atom') {
    if (at.children[index]?.type === 'atom') at.children[index] = clone(value)
    else at.children.splice(index, 0, clone(value))
  } else if (index === 3 && at.children[3]?.type === 'atom') at.children.splice(3, 1)
}

const copyEffects = (item: SExprList, from: SExprList): void => {
  const effects = findChild(from, 'effects')
  if (effects) replaceTokens(item, new Set(['effects']), [clone(effects)], new Set())
  const unlocked = findChild(from, 'unlocked')
  replaceTokens(item, new Set(['unlocked']), unlocked ? [clone(unlocked)] : [], new Set(['layer']))
  const at = findChild(item, 'at')
  const source = findChild(from, 'at')
  if (at && source) setAtAtom(at, 3, source.children[3])
}

const copyPosition = (item: SExprList, from: SExprList): void => {
  const at = findChild(item, 'at')
  const source = findChild(from, 'at')
  if (!at || !source) return
  setAtAtom(at, 1, source.children[1])
  setAtAtom(at, 2, source.children[2])
}

/** KiCad's `processTextItem`: what the options keep, copied from the placed text onto the library's. */
const keepText = (
  item: SExprList,
  from: SExprList,
  resetText: boolean,
  options: ExchangeOptions
): void => {
  if (!resetText) setText(item, from)
  if (!options.resetTextLayers) copyLayerAndVisibility(item, from)
  if (!options.resetTextEffects) copyEffects(item, from)
  if (!options.resetTextPositions) copyPosition(item, from)
}

/** The library's text that stands for a placed free text: the same words, on the same layer when there is a choice. */
const matchingText = (from: SExprList, candidates: SExprList[]): SExprList | null => {
  const same = candidates.filter((item) => textOf(item) === textOf(from))
  return same.find((item) => layerOf(item) === layerOf(from)) ?? same[0] ?? null
}

const carryTexts = (
  node: SExprList,
  old: SExprList,
  oldLibId: string,
  newLibId: string,
  options: ExchangeOptions
): void => {
  const fresh = fieldsOf(node)
  const insertAfter = (item: SExprList): void => {
    const after = afterLast(node, new Set(['property']))
    const fallback = afterLast(node, new Set(['tags', 'descr', 'at', 'uuid', 'layer']))
    const index = after >= 0 ? after : fallback
    node.children.splice(index >= 0 ? index : node.children.length, 0, item)
  }
  const oldName = oldLibId.slice(oldLibId.indexOf(':') + 1)
  for (const [name, item] of fieldsOf(old)) {
    // Filters are the symbol's; the Footprint field names the footprint, so it follows the swap.
    if (name === 'ki_fp_filters') continue
    const target = fresh.get(name)
    if (name === 'Footprint') {
      const copy = target ?? clone(item)
      keepText(copy, item, true, options)
      if (copy.children[2]?.type === 'atom') copy.children[2].value = newLibId
      if (!target) insertAfter(copy)
      continue
    }
    // The reference is never reset; the value only when it echoed the old footprint's name.
    const resetText =
      name === 'Reference'
        ? false
        : name === 'Value'
          ? textOf(item) === oldName
          : options.resetTextContent
    if (target) keepText(target, item, resetText, options)
    else insertAfter(clone(item))
  }
  // The placed footprint's filters replace the library's, after the fields.
  const filters = fieldsOf(old).get('ki_fp_filters')
  const ownFilters = fresh.get('ki_fp_filters')
  if (ownFilters) node.children = node.children.filter((child) => child !== ownFilters)
  if (filters) insertAfter(clone(filters))

  const libraryTexts = freeTexts(node)
  const used = new Set<SExprList>()
  for (const text of freeTexts(old)) {
    const target = matchingText(
      text,
      libraryTexts.filter((item) => !used.has(item))
    )
    if (target) {
      used.add(target)
      keepText(target, text, false, options)
    } else if (!options.removeExtraTexts) {
      const after = afterLast(node, new Set(['fp_text']))
      const copy = clone(text)
      if (after >= 0) node.children.splice(after, 0, copy)
      else insertAfter(copy)
    }
  }
}

// ---------------------------------------------------------------------------
// Footprint-level settings
// ---------------------------------------------------------------------------

/** The sheet link, written after the fields (`pcb_io_kicad_sexpr.cpp`). */
const SHEET_LINK = ['path', 'sheetname', 'sheetfile']

const CLEARANCE = new Set([
  'solder_mask_margin',
  'solder_paste_margin',
  'solder_paste_ratio',
  'solder_paste_margin_ratio',
  'clearance',
  'zone_connect',
  'thermal_width',
  'thermal_gap'
])

/** Flags the placement owns rather than the library: board-only, and the schematic's DNP and BOM flags. */
const PLACEMENT_ATTRIBUTES = ['board_only', 'dnp', 'exclude_from_bom']

/** What follows the settings in KiCad's footprint order, for inserting before. */
const AFTER_SETTINGS = new Set([
  'attr',
  'private_layers',
  'net_tie_pad_groups',
  'fp_text',
  'fp_text_box',
  'fp_line',
  'fp_rect',
  'fp_circle',
  'fp_arc',
  'fp_poly',
  'fp_curve',
  'pad',
  'zone',
  'group',
  'model'
])

const isLockMark = (child: SExprNode): boolean =>
  child.type === 'atom' ? child.value === 'locked' : getToken(child) === 'locked'

const carryLock = (node: SExprList, old: SExprList): void => {
  node.children = node.children.filter((child, index) => index < 2 || !isLockMark(child))
  const mark = old.children.find((child, index) => index >= 2 && isLockMark(child))
  if (mark) node.children.splice(2, 0, clone(mark))
}

const carrySheetLink = (node: SExprList, old: SExprList): void => {
  const links = SHEET_LINK.map((token) => findChild(old, token)).filter(
    (link): link is SExprList => link !== null
  )
  removeTokens(node, new Set(SHEET_LINK))
  if (!links.length) return
  const after = afterLast(node, new Set(['property', 'tags', 'descr', 'at', 'uuid', 'layer']))
  node.children.splice(after >= 0 ? after : node.children.length, 0, ...links.map(clone))
}

const attributesOf = (node: SExprList): string[] => {
  const attr = findChild(node, 'attr')
  return attr ? getAtomValues(attr) : []
}

const carryAttributes = (node: SExprList, old: SExprList, reset: boolean): void => {
  const own = new Set(attributesOf(old))
  if (!reset) {
    const attr = findChild(old, 'attr')
    replaceTokens(node, new Set(['attr']), attr ? [clone(attr)] : [], AFTER_SETTINGS)
    return
  }
  setFootprintAttributes(node, (want) => {
    for (const token of PLACEMENT_ATTRIBUTES) {
      if (own.has(token)) want.add(token)
      else want.delete(token)
    }
  })
}

const carryClearance = (node: SExprList, old: SExprList): void => {
  const settings = old.children.filter((child) => {
    const token = tokenOf(child)
    return token !== null && CLEARANCE.has(token)
  })
  replaceTokens(node, CLEARANCE, settings.map(clone), AFTER_SETTINGS)
}

const carryModels = (node: SExprList, old: SExprList): void => {
  const models = findChildren(old, 'model')
  replaceTokens(node, new Set(['model']), models.map(clone), new Set(['embedded_files']))
}

// ---------------------------------------------------------------------------
// Pads
// ---------------------------------------------------------------------------

const PAD_NET = new Set(['net', 'pinfunction', 'pintype'])

/** Children that follow the net in KiCad's pad order. */
const AFTER_PAD_NET = new Set([
  'die_length',
  'solder_mask_margin',
  'solder_paste_margin',
  'solder_paste_margin_ratio',
  'clearance',
  'zone_connect',
  'thermal_bridge_width',
  'thermal_bridge_angle',
  'thermal_gap',
  'teardrops',
  'options',
  'primitives',
  'uuid',
  'tstamp'
])

const padNumber = (pad: SExprList): string => getAtomValues(pad)[0] ?? ''

const padNetName = (pad: SExprList): string => {
  const net = findChild(pad, 'net')
  if (!net) return ''
  const atoms = getAtomValues(net)
  return atoms.length >= 2 ? (atoms[1] ?? '') : (atoms[0] ?? '')
}

const onCopper = (pad: SExprList): boolean => {
  const layers = findChild(pad, 'layers')
  return (layers ? getAtomValues(layers) : []).some(
    (layer) => layer === '*.Cu' || layer === '*' || isCopperLayer(layer)
  )
}

/** Each new pad takes the net, pin function and pin type of the placed pad with its number. */
const carryPadNets = (
  node: SExprList,
  old: SExprList
): { droppedPads: ExchangePad[]; addedPads: ExchangePad[] } => {
  const oldPads = new Map<string, SExprList>()
  for (const pad of findChildren(old, 'pad')) {
    const number = padNumber(pad)
    if (number && onCopper(pad) && !oldPads.has(number)) oldPads.set(number, pad)
  }
  const newNumbers = new Set<string>()
  const addedPads: ExchangePad[] = []
  for (const pad of findChildren(node, 'pad')) {
    const number = padNumber(pad)
    if (!number || !onCopper(pad)) continue
    newNumbers.add(number)
    const source = oldPads.get(number)
    if (!source) {
      if (!addedPads.some((added) => added.number === number)) addedPads.push({ number, net: '' })
      continue
    }
    const carried = source.children.filter((child) => {
      const token = tokenOf(child)
      return token !== null && PAD_NET.has(token)
    })
    removeTokens(pad, PAD_NET)
    if (!carried.length) continue
    const before = firstIndex(pad, AFTER_PAD_NET)
    pad.children.splice(before >= 0 ? before : pad.children.length, 0, ...carried.map(clone))
  }
  const droppedPads = [...oldPads]
    .filter(([number, pad]) => !newNumbers.has(number) && padNetName(pad))
    .map(([number, pad]) => ({ number, net: padNetName(pad) }))
  return { droppedPads, addedPads }
}

// ---------------------------------------------------------------------------
// The swap
// ---------------------------------------------------------------------------

/**
 * Whether a symbol owns this footprint: it carries a sheet link and is not
 * board-only. The schematic owns which footprint such a part uses, so a change
 * goes through its Footprint field.
 */
export const isSymbolOwned = (footprint: KicadBoardFootprint): boolean => {
  const node = footprint._raw as SExprList
  const path = findChild(node, 'path')
  return !!(path && getAtomValues(path)[0]) && !attributesOf(node).includes('board_only')
}

/** The library footprint on the placed one's side: flipped top to bottom for the back, as parity compares. */
const librarySided = (
  board: KicadBoard,
  placed: KicadBoardFootprint,
  library: KicadFootprint
): KicadFootprint => {
  const onBack = placed.layer === 'B.Cu'
  const libraryBack = (library.layer ?? 'F.Cu') === 'B.Cu'
  if (onBack === libraryBack || library._raw.type !== 'list') return library
  return parseFootprintNode(
    flippedFootprintNode(
      library._raw,
      { x: nm(0), y: nm(0) },
      'topBottom',
      boardLayerFlipper(board.layers)
    )
  )
}

/**
 * The node that replaces `placed`: `library` named `libId`, where and as
 * `placed` sits, carrying what `options` keep. Pure; the board is read for its
 * layers only.
 */
export function exchangedFootprintNode(
  board: KicadBoard,
  placed: KicadBoardFootprint,
  library: KicadFootprint,
  libId: string,
  options: ExchangeOptions
): { node: SExprList; report: ExchangeReport } {
  const old = placed._raw as SExprList
  const node = instantiateLibraryFootprint(librarySided(board, placed, library), libId, {
    x: nm(0),
    y: nm(0)
  })
  const ownUuid = findChild(old, 'uuid')
  if (ownUuid) replaceTokens(node, new Set(['uuid']), [clone(ownUuid)], new Set(['at']))
  landFootprintNode(node, placed.position, placed.position.angle ?? 0)
  carryLock(node, old)
  carryTexts(node, old, placed.libId, libId, options)
  carrySheetLink(node, old)
  carryAttributes(node, old, options.resetFabricationAttributes)
  if (!options.resetClearanceOverrides) carryClearance(node, old)
  if (!options.reset3DModels) carryModels(node, old)
  const pads = carryPadNets(node, old)
  return {
    node,
    report: { reference: placed.reference ?? '', from: placed.libId, to: libId, ...pads }
  }
}

export interface ExchangeTarget {
  footprint: KicadBoardFootprint
  library: KicadFootprint
  /** The lib id the footprint takes: its own for an update, the new one for a change. */
  libId: string
}

/**
 * Swap each target in `board._raw` for its library footprint. Mutates the
 * AST only; the caller owns the command and the remap.
 */
export function exchangeFootprints(
  board: KicadBoard,
  targets: readonly ExchangeTarget[],
  options: ExchangeOptions
): ExchangeReport[] {
  const root = board._raw as SExprList
  const reports: ExchangeReport[] = []
  for (const target of targets) {
    const index = root.children.indexOf(target.footprint._raw as SExprNode)
    if (index < 0) continue
    const { node, report } = exchangedFootprintNode(
      board,
      target.footprint,
      target.library,
      target.libId,
      options
    )
    root.children[index] = node
    reports.push(report)
  }
  return reports
}
