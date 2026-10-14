import type { KicadBoardFootprint } from '../../../kicad/board'
import { getNetName } from '../../../kicad/board'
import { findChild, getFirstAtomValue, type SExprNode } from '../../../kicad/sexpr'
import { COPPER_LAYERS, expandLayerToken, isCopperLayer } from '../../../kicad/layers'
import { footprintTransform, tfPoint } from '../../../schematic/placement'
import type { NetlistPart } from '../../schematicNetlist'
import type { DrcContext } from '../context'
import { worldOf } from '../shared'

/** Fields a footprint carries that are not the symbol's to match (`PCB_FIELD::IsReference`…). */
const OWN_FIELDS = new Set(['Reference', 'Value', 'Component Class'])
/** Symbol fields the parity check leaves out: the footprint carries them otherwise. */
const SKIPPED_FIELDS = new Set(['Reference', 'Value', 'Footprint', 'Component Class'])

/**
 * The board against its schematic, as KiCad's schematic-parity check reads
 * them (`pcb drc --schematic-parity`): footprints sharing a reference, parts
 * with no footprint and footprints with no part, a part whose value, library
 * footprint, attributes or fields differ from its footprint's, a footprint
 * outside its symbol's filters, and pads whose nets are not the pins'.
 * Parts and footprints meet by reference, as KiCad's check matches them.
 * Board-scoped, and only where the caller read the schematic.
 */
export function* schematicParity(ctx: DrcContext): Generator<void> {
  const { board, schematic, one, emit, pair, footprintSubject, padSubject, tick } = ctx
  if (!schematic) return
  const footprints = board.footprints
  const boardOnly = (bfp: KicadBoardFootprint): boolean =>
    bfp.footprint.attributes.includes('board_only')
  const referenceOf = (bfp: KicadBoardFootprint): string => bfp.reference ?? ''

  // Two footprints of one reference, case aside; a board-only one is never the duplicate.
  const first = new Map<string, KicadBoardFootprint>()
  for (const bfp of footprints) {
    const key = referenceOf(bfp).toLowerCase()
    const earlier = first.get(key)
    if (!earlier) {
      first.set(key, bfp)
      continue
    }
    if (boardOnly(bfp)) continue
    const a = footprintSubject(bfp)
    const b = footprintSubject(earlier)
    emit(
      {
        code: 'duplicate-footprints',
        severity: 'warning',
        message: `${a.name} and ${b.name} share a reference.`,
        position: at(bfp),
        ...pair(a, b)
      },
      []
    )
  }

  const byReference = new Map<string, KicadBoardFootprint>()
  for (const bfp of footprints)
    if (!byReference.has(referenceOf(bfp))) byReference.set(referenceOf(bfp), bfp)

  for (const part of schematic.parts) {
    if (tick()) yield
    const bfp = byReference.get(part.reference)
    if (!bfp) {
      emit(
        {
          code: 'missing-footprint',
          severity: 'warning',
          message: `${part.reference} (${part.value}) is in the schematic but has no footprint on the board. Update the PCB from the schematic.`,
          items: [],
          targets: [],
          subject: part.reference
        },
        []
      )
      continue
    }
    const subject = footprintSubject(bfp)
    const position = worldOf(bfp.position)
    const mismatch = (message: string): void =>
      one('footprint-symbol-mismatch', 'warning', message, subject, position)

    if (part.value !== (bfp.value ?? ''))
      mismatch(
        `The value of ${subject.name} (${bfp.value ?? ''}) is not its symbol's (${part.value}).`
      )
    if (part.libId !== bfp.libId)
      mismatch(
        `${subject.name} is ${bfp.libId || 'no library footprint'}; its symbol names ${part.libId || 'none'}.`
      )
    if (part.filters.length > 0 && !part.filters.some((filter) => filterMatches(filter, bfp.libId)))
      one(
        'footprint-filters-mismatch',
        'warning',
        `${subject.name} is ${bfp.libId}, which its symbol's footprint filters (${part.filters.join(' ')}) do not allow.`,
        subject,
        position
      )
    const attrs = bfp.footprint.attributes
    if (part.dnp !== attrs.includes('dnp'))
      mismatch(`${subject.name} and its symbol differ on Do not populate.`)
    if (part.excludeFromBom !== attrs.includes('exclude_from_bom'))
      mismatch(`${subject.name} and its symbol differ on Exclude from bill of materials.`)

    const fieldMismatch = fieldDifference(part, footprintFields(bfp, board.version ?? 0))
    if (fieldMismatch)
      one(
        'footprint-symbol-field-mismatch',
        'warning',
        `${subject.name}: ${fieldMismatch}`,
        subject,
        position
      )

    // Each numbered pad's net against its pin's; each pin against a pad.
    const tf = footprintTransform(bfp)
    for (const pad of bfp.footprint.pads) {
      if (pad.type === 'np_thru_hole' || !onCopper(pad.layers)) continue
      const netName = pad.net ? getNetName(board, pad.net.number) || pad.net.name : ''
      const pinNet = part.pins.get(pad.number)
      const padSubjectOf = padSubject(bfp, pad, tfPoint(tf, pad.position.x, pad.position.y))
      let message: string | null = null
      if (netName && pinNet === undefined)
        message = `${padSubjectOf.name} has net ${netName}, but its symbol has no pin ${pad.number}.`
      else if (!netName && pinNet)
        message = `${padSubjectOf.name} has no net; the schematic gives it ${pinNet}.`
      else if (
        pinNet !== undefined &&
        netName !== pinNet &&
        !(netName.startsWith('unconnected-') && netName.startsWith(pinNet)) &&
        !(noConnectPin(pad._raw) && netName.startsWith(`${pinNet}_`))
      )
        message = `${padSubjectOf.name} is on ${netName}; the schematic puts it on ${pinNet}.`
      if (message) one('net-conflict', 'warning', message, padSubjectOf, position)
    }
    const numbers = new Set(bfp.footprint.pads.map((pad) => pad.number))
    for (const [pin, net] of part.pins) {
      if (numbers.has(pin)) continue
      const named = net.startsWith('unconnected-') ? pin : `${pin} (${net})`
      one(
        'net-conflict',
        'warning',
        `${subject.name} has no pad for the schematic's pin ${named}.`,
        subject,
        position
      )
    }
  }

  // Footprints no part names; a board-only one needs none.
  const parts = new Set(schematic.parts.map((part) => part.reference))
  for (const bfp of footprints) {
    if (boardOnly(bfp) || parts.has(referenceOf(bfp))) continue
    const subject = footprintSubject(bfp)
    one(
      'extra-footprint',
      'warning',
      `${subject.name} is on the board but not in the schematic.`,
      subject,
      worldOf(bfp.position)
    )
  }
}

const at = (bfp: KicadBoardFootprint): { x: number; y: number } => {
  const p = worldOf(bfp.position)
  return { x: Math.round(p.x * 1e4) / 1e4, y: Math.round(-p.y * 1e4) / 1e4 }
}

/** A pad with a number: one on a copper layer (`PAD::CanHaveNumber`, an aperture has none). */
const onCopper = (layers: readonly string[]): boolean =>
  layers.some(
    (token) => isCopperLayer(token) || expandLayerToken(token, COPPER_LAYERS).some(isCopperLayer)
  )

/** `(pintype "…no_connect…")`: the pin was left open on purpose (`PAD::IsNoConnectPad`). */
const noConnectPin = (raw: SExprNode): boolean => {
  const node = raw.type === 'list' ? findChild(raw, 'pintype') : null
  return !!node && (getFirstAtomValue(node) ?? '').includes('no_connect')
}

/**
 * A footprint's fields as KiCad loads them: every property but its reference,
 * value and footprint filters, with Datasheet and Description always there. A
 * file from before board fields (20230620) kept some as plain properties
 * KiCad drops or renames on load.
 */
function footprintFields(bfp: KicadBoardFootprint, version: number): Map<string, string> {
  const fields = new Map<string, string>([
    ['Datasheet', ''],
    ['Description', '']
  ])
  const legacy = version < 20230620
  for (const property of bfp.footprint.properties) {
    let name = property.key
    if (name === 'ki_fp_filters' || name === 'Footprint') continue
    if (legacy) {
      if (
        ['ki_keywords', 'ki_locked', 'Sheetfile', 'Sheet file', 'Sheetname', 'Sheet name'].includes(
          name
        )
      )
        continue
      if (name === 'ki_description') name = 'Description'
    }
    if (OWN_FIELDS.has(name)) continue
    fields.set(name, property.value)
  }
  return fields
}

/** The first of a part's fields its footprint lacks or holds otherwise, as a sentence; null when all match. */
function fieldDifference(part: NetlistPart, fields: Map<string, string>): string | null {
  for (const [name, value] of part.fields) {
    if (SKIPPED_FIELDS.has(name)) continue
    const held = fields.get(name)
    if (held === undefined) return `the footprint has no field ${name}, which its symbol has.`
    if (held !== value)
      return `field ${name} is '${held}' on the board and '${value}' in the schematic.`
  }
  return null
}

/**
 * A footprint filter against a library footprint, as KiCad matches one: case
 * aside, `*` and `?` wildcards, against the whole `lib:name` when the filter
 * names a library and the name alone otherwise.
 */
export function filterMatches(filter: string, libId: string): boolean {
  const colon = libId.indexOf(':')
  const target = (
    filter.includes(':') ? libId : colon >= 0 ? libId.slice(colon + 1) : libId
  ).toLowerCase()
  const pattern = filter
    .toLowerCase()
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^${pattern}$`, 's').test(target)
}
