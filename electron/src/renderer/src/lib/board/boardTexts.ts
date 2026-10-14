/**
 * Every text a board's DRC reads, in the order KiCad's `forEachGeometryItem`
 * visits them: the board's texts, text boxes, table cells and dimensions,
 * then each footprint's fields, texts, text boxes and dimensions (a
 * footprint's tables are not visited). What the text rules hold each to:
 * its height, its pen, which way it reads, and what it says once its
 * variables resolve (`drc/rules/texts.ts`).
 *
 * A text's variables resolve as KiCad's `GetShownText` resolves them: a
 * footprint's text through its footprint (`${REFERENCE}`, `${VALUE}`, a field
 * by name, `${NET_NAME(3)}`…), then the board's — a cross-reference to
 * another footprint (`${R1:VALUE}`), the file and project names, the title
 * block, the project's text variables and the board's own properties.
 * World space: millimeters, y up.
 */
import type { KicadBoard } from '../kicad/board'
import { getNetName } from '../kicad/board'
import type { KicadFontEffects, KicadFootprint } from '../kicad/footprint'
import { getReference, getValue } from '../kicad/footprint'
import { findChild, findChildren, getAtomValues, type SExprNode } from '../kicad/sexpr'
import type { Nm } from '../kicad/coordinates'
import { footprintTransform, tfPoint, worldPoint, type Pt } from '../schematic/placement'
import { tableGrid } from './extraGraphics'

export type BoardTextKind = 'field' | 'text' | 'textbox' | 'cell' | 'dimension' | 'table'

export interface BoardText {
  kind: BoardTextKind
  layer: string
  /** As written, variables unresolved. */
  text: string
  /** A hidden footprint field or text; a board's own text always shows. */
  visible: boolean
  mirrored: boolean
  /** Glyph height and width, nm. */
  height: Nm
  width: Nm
  /** The pen KiCad strokes it with (`GetEffectiveTextPenWidth`), nm. */
  pen: Nm
  /** Drawn in a TrueType face, which has no stroke width of its own. */
  outlineFont: boolean
  /** KiCad's `GetPosition`: a text's anchor, a box's or cell's corner, a dimension's start. */
  position: Pt
  uuid?: string
  /** The footprint it belongs to. */
  fp?: number
  /** A field's name. */
  field?: string
}

/** Every text on the board, cached per board. */
export function boardTexts(board: KicadBoard): readonly BoardText[] {
  let texts = cache.get(board)
  if (!texts) cache.set(board, (texts = collect(board)))
  return texts
}

const cache = new WeakMap<KicadBoard, BoardText[]>()

function collect(board: KicadBoard): BoardText[] {
  const out: BoardText[] = []
  const add = (
    kind: BoardTextKind,
    layer: string | undefined,
    text: string,
    effects: KicadFontEffects | undefined,
    raw: SExprNode | undefined,
    position: Pt,
    extra: Partial<BoardText> = {}
  ): void => {
    if (!layer) return
    const size = effects ?? DEFAULT_EFFECTS
    out.push({
      kind,
      layer,
      text,
      visible: true,
      mirrored: !!size.mirror,
      height: size.height,
      width: size.width,
      pen: penOf(size, raw ? fontChild(raw, 'thickness') !== null : true),
      outlineFont: raw ? fontChild(raw, 'face') !== null : false,
      position,
      ...(raw ? withUuid(raw) : {}),
      ...extra
    })
  }

  for (const t of board.grTexts)
    if (t.position) add('text', t.layer, t.text, t.fontEffects, t._raw, worldPoint(t.position))
  for (const box of board.grTextBoxes)
    add('textbox', box.layer, box.text, box.fontEffects, box._raw, boxCorner(box, worldPoint))
  for (const table of board.tables) {
    // A table is on its layer too, whose cells draw its text.
    add('table', table.layer, '', undefined, table._raw, tableCorner(table, worldPoint))
    for (const cell of table.cells) {
      if (cell.colSpan <= 0 || cell.rowSpan <= 0) continue
      add(
        'cell',
        cell.layer ?? table.layer,
        cell.text,
        cell.fontEffects,
        cell._raw,
        boxCorner(cell, worldPoint)
      )
    }
  }
  for (const dim of board.dimensions) {
    const start = dim.points[0]
    add(
      'dimension',
      dim.layer,
      dim.text?.text ?? '',
      dim.text?.fontEffects,
      dim._raw,
      start ? worldPoint(start) : { x: 0, y: 0 }
    )
  }

  board.footprints.forEach((bfp, fp) => {
    const tf = footprintTransform(bfp)
    const at = (p: { x: Nm; y: Nm }): Pt => tfPoint(tf, p.x, p.y)
    const footprint = bfp.footprint
    const origin = worldPoint(bfp.position)
    // A pre-v8 file's reference and value texts load as fields, KiCad's first two.
    for (const t of footprint.fpTexts) {
      if (t.type === 'user') continue
      add('field', t.layer, t.text, t.fontEffects, t._raw, t.position ? at(t.position) : origin, {
        fp,
        visible: !t.hide,
        field: t.type === 'reference' ? 'Reference' : 'Value'
      })
    }
    for (const property of footprint.properties) {
      add(
        'field',
        property.layer,
        property.value,
        property.fontEffects,
        property._raw,
        property.position ? at(property.position) : origin,
        { fp, visible: !property.hide, field: property.key }
      )
    }
    for (const t of footprint.fpTexts) {
      if (t.type !== 'user') continue
      add('text', t.layer, t.text, t.fontEffects, t._raw, t.position ? at(t.position) : origin, {
        fp,
        visible: !t.hide
      })
    }
    for (const box of footprint.fpTextBoxes)
      add('textbox', box.layer, box.text, box.fontEffects, box._raw, boxCorner(box, at), { fp })
    for (const dim of footprint.dimensions) {
      const start = dim.points[0]
      add(
        'dimension',
        dim.layer,
        dim.text?.text ?? '',
        dim.text?.fontEffects,
        dim._raw,
        start ? worldPoint(start) : origin,
        { fp }
      )
    }
  })
  return out
}

/** KiCad's default text: 1 mm square, auto pen. */
const DEFAULT_EFFECTS: KicadFontEffects = {
  width: 1_000_000 as Nm,
  height: 1_000_000 as Nm,
  thickness: 0 as Nm
}

/**
 * KiCad's `GetEffectiveTextPenWidth` on a board: the text's own thickness
 * where the file sets one, else width / 5 bold or width / 8, clamped to a
 * quarter of the smaller glyph dimension (`ClampTextPenSize`) — in whole
 * nanometers, as KiCad rounds.
 */
export function penOf(effects: KicadFontEffects, explicit: boolean): Nm {
  const w = Math.abs(effects.width)
  const h = Math.abs(effects.height)
  let pen: number = explicit ? (effects.thickness ?? 0) : 0
  if (pen <= 1) pen = Math.round(effects.bold ? w / 5 : w / 8)
  return Math.min(pen, Math.round(0.25 * Math.min(w, h))) as Nm
}

/** A child of a text's `(effects (font …))`: its `thickness`, its TrueType `face`. */
function fontChild(raw: SExprNode, token: string): SExprNode | null {
  if (raw.type !== 'list') return null
  // A dimension's text is its nested `gr_text`.
  const text = findChild(raw, 'effects') ? raw : (findChild(raw, 'gr_text') ?? raw)
  const effects = findChild(text, 'effects')
  const font = effects ? findChild(effects, 'font') : null
  return font ? findChild(font, token) : null
}

function withUuid(raw: SExprNode): { uuid?: string } {
  if (raw.type !== 'list') return {}
  const node = findChild(raw, 'uuid') ?? findChild(raw, 'tstamp')
  const uuid = node ? getAtomValues(node)[0] : undefined
  return uuid ? { uuid } : {}
}

function boxCorner(
  box: { start?: { x: Nm; y: Nm }; points?: Array<{ x: Nm; y: Nm }> },
  at: (p: { x: Nm; y: Nm }) => Pt
): Pt {
  const first = box.start ?? box.points?.[0]
  return first ? at(first) : { x: 0, y: 0 }
}

function tableCorner(table: KicadBoard['tables'][number], at: (p: { x: Nm; y: Nm }) => Pt): Pt {
  const grid = tableGrid(table)
  return grid ? at({ x: grid.xs[0] as Nm, y: grid.ys[0] as Nm }) : { x: 0, y: 0 }
}

/** A board layer as `${LAYER}` shows it: its user name, else its own. */
export const layerDisplayName = (board: KicadBoard, layer: string): string =>
  board.layers.find((l) => l.name === layer)?.userName ?? layer

/** What resolving a text's variables needs beyond the board: the project's variables and names. */
export interface TextScope {
  variables: Readonly<Record<string, string>>
  /** A net's effective class name, for `${NET_CLASS(n)}`. */
  netClassOf?: (net: number) => string
}

/** How deep variables may nest before resolution stops, as KiCad's depth guard. */
const MAX_DEPTH = 10

/**
 * A text as KiCad shows it, its variables resolved; one it cannot resolve
 * stays as written (`${NAME}`), which is what KiCad draws.
 */
export function shownText(board: KicadBoard, t: BoardText, scope: TextScope): string {
  return shownTextOf(board, t.text, t.layer, t.fp, scope)
}

/** `shownText` for a text given by its parts: what it says, its layer and its footprint's index. */
export function shownTextOf(
  board: KicadBoard,
  written: string,
  layer: string,
  fp: number | undefined,
  scope: TextScope
): string {
  const footprint = fp !== undefined ? board.footprints[fp] : undefined
  const resolve = (name: string): string | null => {
    if (name === 'LAYER') return layerDisplayName(board, layer)
    if (footprint) {
      const own = footprintVariable(board, footprint.footprint, footprint.libId, name, scope)
      if (own !== null) return own
    }
    return boardVariable(board, name, scope)
  }
  // A design-rule marker raises its own finding and shows as nothing.
  const text = written.replace(/(^|[^\\])\$\{DRC_(?:ERROR|WARNING)\b[^}]*\}/g, '$1')
  return expand(text, resolve, 0)
}

/** `${…}` references in text, replaced where `resolve` answers; a nested one resolved too. */
function expand(text: string, resolve: (name: string) => string | null, depth: number): string {
  if (depth > MAX_DEPTH || !text.includes('${')) return text
  let out = ''
  let i = 0
  while (i < text.length) {
    const start = text.indexOf('${', i)
    if (start < 0) {
      out += text.slice(i)
      break
    }
    // An escaped reference stays as written, and still reads as a reference.
    if (start > 0 && text[start - 1] === '\\') {
      out += text.slice(i, start - 1) + '${'
      i = start + 2
      continue
    }
    const end = closing(text, start + 2)
    if (end < 0) {
      out += text.slice(i)
      break
    }
    out += text.slice(i, start)
    const inner = expand(text.slice(start + 2, end), resolve, depth + 1)
    const value = resolve(inner)
    out += value === null ? `\${${inner}}` : expand(value, resolve, depth + 1)
    i = end + 1
  }
  return out
}

/** The `}` that closes a reference opened before `from`, nested references included; -1 when none. */
function closing(text: string, from: number): number {
  let depth = 1
  for (let i = from; i < text.length; i++) {
    if (text[i] === '{' && text[i - 1] === '$') depth++
    else if (text[i] === '}' && --depth === 0) return i
  }
  return -1
}

/** A footprint's own variables (`FOOTPRINT::ResolveTextVar`); null to fall through to the board. */
function footprintVariable(
  board: KicadBoard,
  fp: KicadFootprint,
  libId: string,
  name: string,
  scope: TextScope
): string | null {
  switch (name) {
    case 'REFERENCE':
      return getReference(fp) ?? ''
    case 'VALUE':
      return getValue(fp) ?? ''
    case 'LAYER':
      return layerDisplayName(board, fp.layer ?? 'F.Cu')
    case 'FOOTPRINT_LIBRARY':
      return libId.includes(':') ? libId.slice(0, libId.indexOf(':')) : ''
    case 'FOOTPRINT_NAME':
      return libId.includes(':') ? libId.slice(libId.indexOf(':') + 1) : libId
  }
  const call = /^(SHORT_NET_NAME|NET_NAME|NET_CLASS|PIN_NAME)\((.*)\)$/s.exec(name)
  if (call) {
    const pad = fp.pads.find((p) => p.number === call[2])
    if (pad) {
      const net = pad.net ? getNetName(board, pad.net.number) || pad.net.name : ''
      switch (call[1]) {
        case 'NET_NAME':
          return net
        case 'SHORT_NET_NAME':
          return net.includes('/') ? net.slice(net.lastIndexOf('/') + 1) : net
        case 'NET_CLASS':
          return scope.netClassOf?.(pad.net?.number ?? 0) ?? ''
        default: {
          const node = pad._raw.type === 'list' ? findChild(pad._raw, 'pinfunction') : null
          return (node && getAtomValues(node)[0]) ?? ''
        }
      }
    }
  }
  const field = fp.properties.find((p) => p.key === name)
  return field ? field.value : null
}

/** The board's variables (`BOARD::ResolveTextVar`); null when nothing answers. */
function boardVariable(board: KicadBoard, name: string, scope: TextScope): string | null {
  const colon = name.indexOf(':')
  if (colon > 0) {
    const ref = name.slice(0, colon)
    const rest = name.slice(colon + 1)
    const byUuid = board.footprints.find((bfp) => bfp.uuid === ref)
    if (byUuid) {
      const value = footprintVariable(board, byUuid.footprint, byUuid.libId, rest, scope)
      if (value !== null) return value
    } else {
      const byRef = board.footprints.find(
        (bfp) => (bfp.reference ?? '').toLowerCase() === ref.toLowerCase()
      )
      // KiCad answers an unknown reference or field with a note in the text, never `${…}`.
      if (!byRef) return `<Unknown reference: ${ref}>`
      return (
        footprintVariable(board, byRef.footprint, byRef.libId, rest, scope) ??
        `<Unresolved: ${byRef.reference}:${rest}>`
      )
    }
  }
  switch (name) {
    case 'FILENAME':
    case 'FILEPATH':
    case 'PROJECTNAME':
    case 'VARIANT':
    case 'VARIANT_DESC':
    case 'CURRENT_DATE':
    case 'CURRENT_TIME_HH_MM_SS':
    case 'CURRENT_TIME_LOCALE':
      return ''
  }
  // The title block answers its own fields first, a blank one included (`${REVISION}`
  // with no `(rev …)` is empty); then the project's variables, then the board's
  // properties (`BOARD::ResolveTextVar`).
  const block = titleBlockVariable(board, name)
  if (block !== null) return projectExpanded(block, scope)
  if (Object.hasOwn(scope.variables, name)) return scope.variables[name]
  const own = boardProperties(board).get(name)
  if (own !== undefined) return own
  // Environment variables KiCad always sets: the project's folder and its own paths.
  if (name === 'KIPRJMOD' || /^KICAD\d*_/.test(name)) return ''
  return null
}

/** The title block's variables: always answered, empty where the block leaves a field blank. */
function titleBlockVariable(board: KicadBoard, name: string): string | null {
  const token =
    name === 'TITLE'
      ? 'title'
      : name === 'ISSUE_DATE'
        ? 'date'
        : name === 'REVISION'
          ? 'rev'
          : name === 'COMPANY'
            ? 'company'
            : null
  const block = board._raw.type === 'list' ? findChild(board._raw, 'title_block') : null
  if (token) {
    const node = block ? findChild(block, token) : null
    return (node && getAtomValues(node)[0]) ?? ''
  }
  const comment = /^COMMENT([1-9])$/.exec(name)
  if (!comment) return null
  for (const node of block ? findChildren(block, 'comment') : []) {
    const [index, value] = getAtomValues(node)
    if (Number(index) === Number(comment[1])) return value ?? ''
  }
  return ''
}

/** The board's own `(property "key" "value")` pairs. */
function boardProperties(board: KicadBoard): Map<string, string> {
  const out = new Map<string, string>()
  if (board._raw.type !== 'list') return out
  for (const node of findChildren(board._raw, 'property')) {
    const [key, value] = getAtomValues(node)
    if (key !== undefined) out.set(key, value ?? '')
  }
  return out
}

/**
 * The title block's texts as KiCad's default drawing sheet shows them — the
 * title, date, revision, company and comments 1 to 4 — each resolved: where
 * KiCad's unresolved-variable check reads them.
 */
/** The title block's fields by their token (`title`, `comment 2`), each as the drawing sheet shows it. */
export function titleBlockFields(
  board: KicadBoard,
  scope: TextScope
): Array<{ field: string; shown: string }> {
  const block = board._raw.type === 'list' ? findChild(board._raw, 'title_block') : null
  if (!block) return []
  const fields: Array<{ field: string; value: string }> = []
  for (const token of ['title', 'date', 'rev', 'company']) {
    const node = findChild(block, token)
    const value = node ? getAtomValues(node)[0] : undefined
    if (value) fields.push({ field: token, value })
  }
  for (const node of findChildren(block, 'comment')) {
    const [index, value] = getAtomValues(node)
    if (value && Number(index) >= 1 && Number(index) <= 4)
      fields.push({ field: `comment ${index}`, value })
  }
  return fields.map(({ field, value }) => ({ field, shown: projectExpanded(value, scope) }))
}

/**
 * A title-block field as KiCad expands it (`TITLE_BLOCK::TextVarResolver`):
 * from the project's text variables alone, never the board's properties.
 */
const projectExpanded = (value: string, scope: TextScope): string =>
  expand(value, (name) => (Object.hasOwn(scope.variables, name) ? scope.variables[name] : null), 0)

/** Whether a shown text still holds a reference: KiCad's `*${*}*`. */
export const unresolved = (shown: string): boolean => /\$\{[^]*\}/.test(shown)
