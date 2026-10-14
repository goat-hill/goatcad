/**
 * Per-layer stackup edits as an agent sends them (`board.update_setup`'s
 * `stackup.layers`, `addDielectric` and `removeLayers`): the Board Setup
 * table's cell edits, Add dielectric and Remove layer, over the same row
 * model (`buildStackupRows`: which cells a row has), patches
 * (`stackupLayerPatch`) and mutators the page calls. Nothing is regenerated,
 * so every other row keeps its hand edits.
 */
import {
  addStackupDielectricInAST,
  removeStackupLayerInAST,
  updateStackupLayerInAST,
  type KicadStackup,
  type KicadStackupLayer
} from '../kicad/board'
import { mmToNm, nmToMm } from '../kicad/coordinates'
import { findChildren } from '../kicad/sexpr'
import {
  DIELECTRIC_TYPES,
  MASK_COLORS,
  SILK_COLORS,
  buildStackupRows,
  layerKindOf,
  stackupLayerPatch,
  type StackupColumn
} from './boardSetupSchema'

type Rec = Record<string, unknown>
type Patch = Partial<Omit<KicadStackupLayer, 'name' | '_raw'>>

/** The fields a stackup row is written with, as `board_get_setup` reads them. */
const LAYER_FIELDS = [
  'type',
  'material',
  'thickness',
  'epsilonR',
  'lossTangent',
  'color'
] as const satisfies readonly StackupColumn[]

export type StackupFailure = {
  ok: false
  error: 'invalid-record' | 'not-applicable'
  detail: string
  candidates?: string[]
}

/** The edits, by the names the rows had before the call; applied edits, removals, then additions. */
export interface StackupEditPlan {
  edits: Array<{ name: string; patch: Patch }>
  remove: string[]
  add: Array<{ after: string; patch: Patch }>
}

const fail = (
  error: StackupFailure['error'],
  detail: string,
  candidates?: string[]
): StackupFailure => ({ ok: false, error, detail, ...(candidates?.length ? { candidates } : {}) })

const isRecord = (value: unknown): value is Rec =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** A stackup row as `board_get_setup` reads it, in mm. */
export function stackupLayerRecord(layer: KicadStackupLayer): Rec {
  return {
    name: layer.name,
    ...(layer.type ? { type: layer.type } : {}),
    ...(layer.thickness !== undefined
      ? { thickness: Math.round(nmToMm(layer.thickness) * 1e6) / 1e6 }
      : {}),
    ...(layer.material ? { material: layer.material } : {}),
    ...(layer.epsilonR !== undefined ? { epsilonR: layer.epsilonR } : {}),
    ...(layer.lossTangent !== undefined ? { lossTangent: layer.lossTangent } : {}),
    ...(layer.color ? { color: layer.color } : {})
  }
}

/**
 * One row's fields as a patch, each a cell the row has in Board Setup's table.
 * A field the row has no cell for is refused, unless it repeats the value
 * read, so a record read can be sent back whole.
 */
function planPatch(
  label: string,
  kind: ReturnType<typeof layerKindOf>,
  editable: ReadonlySet<StackupColumn>,
  current: Rec,
  entry: Rec,
  keys: readonly string[]
): { ok: true; patch: Patch } | StackupFailure {
  const extra = Object.keys(entry).filter((key) => !keys.includes(key))
  if (extra.length)
    return fail(
      'not-applicable',
      `A stackup layer does not carry ${extra.join(', ')}; it takes ${keys.join(', ')}.`
    )
  let patch: Patch = {}
  for (const field of LAYER_FIELDS) {
    const value = entry[field]
    if (value === undefined) continue
    if (!editable.has(field)) {
      if (value === current[field]) continue
      return fail(
        'not-applicable',
        `${label} has no ${field} to set; a ${kind} row takes ${[...editable].join(', ') || 'nothing'}.`
      )
    }
    let cell: Parameters<typeof stackupLayerPatch>[1]
    if (field === 'thickness') {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
        return fail('invalid-record', `${label}.thickness is a positive length in mm.`)
      cell = mmToNm(value)
    } else if (field === 'epsilonR' || field === 'lossTangent') {
      const least = field === 'epsilonR' ? 1 : 0
      if (typeof value !== 'number' || !Number.isFinite(value) || value < least)
        return fail('invalid-record', `${label}.${field} is a number, ${least} or more.`)
      cell = value
    } else if (field === 'type') {
      if (typeof value !== 'string' || !DIELECTRIC_TYPES.includes(value))
        return fail('invalid-record', `${label}.type is one of ${DIELECTRIC_TYPES.join(', ')}.`, [
          ...DIELECTRIC_TYPES
        ])
      cell = value
    } else if (field === 'color') {
      const colors = kind === 'mask' ? MASK_COLORS : SILK_COLORS
      if (typeof value !== 'string' || !colors.includes(value))
        return fail('invalid-record', `${label}.color is one of ${colors.join(', ')}.`, [...colors])
      cell = value
    } else {
      if (typeof value !== 'string' || !value.trim())
        return fail('invalid-record', `${label}.material is a name, e.g. "FR4".`)
      cell = value.trim()
    }
    patch = { ...patch, ...stackupLayerPatch(field, cell) }
  }
  return { ok: true, patch }
}

/** What a new dielectric has cells for: Board Setup's dielectric row. */
const DIELECTRIC_CELLS: ReadonlySet<StackupColumn> = new Set([
  'type',
  'material',
  'thickness',
  'epsilonR',
  'lossTangent'
])

/**
 * Plan `stackup.layers`, `stackup.addDielectric` and `stackup.removeLayers`
 * against the board's rows, validated whole. `changed` names the rows touched
 * and `before` holds each edited or removed row as it was.
 */
export function planStackupEdits(
  layers: readonly KicadStackupLayer[],
  value: Rec
): { ok: true; plan: StackupEditPlan; changed: Rec; before: Rec } | StackupFailure {
  const rows = buildStackupRows(layers, (key) => key)
  const names = rows.map((row) => row.name)
  const rowNamed = (name: unknown): (typeof rows)[number] | undefined =>
    typeof name === 'string' ? rows.find((row) => row.name === name) : undefined
  const plan: StackupEditPlan = { edits: [], remove: [], add: [] }
  const before: Rec[] = []
  const list = (key: string): unknown[] | StackupFailure | undefined => {
    const v = value[key]
    if (v === undefined) return undefined
    return Array.isArray(v) ? v : fail('invalid-record', `stackup.${key} is a list.`)
  }
  const isFailure = (v: unknown): v is StackupFailure => isRecord(v) && v.ok === false

  const edits = list('layers')
  if (isFailure(edits)) return edits
  for (const entry of edits ?? []) {
    if (!isRecord(entry) || typeof entry.name !== 'string')
      return fail('invalid-record', 'Each stackup.layers entry names its row: {name, ...fields}.')
    const row = rowNamed(entry.name)
    if (!row) return fail('invalid-record', `The stackup has no layer ${entry.name}.`, names)
    if (plan.edits.some((e) => e.name === row.name))
      return fail('invalid-record', `stackup.layers names ${row.name} twice.`)
    const editable = new Set(
      (Object.keys(row.cells) as StackupColumn[]).filter((c) => row.cells[c] !== null)
    )
    const current = stackupLayerRecord(layers[row.index])
    const planned = planPatch(row.name, row.kind, editable, current, entry, [
      'name',
      ...LAYER_FIELDS
    ])
    if (!planned.ok) return planned
    if (Object.keys(planned.patch).length === 0) continue
    plan.edits.push({ name: row.name, patch: planned.patch })
    before.push(current)
  }

  const removals = list('removeLayers')
  if (isFailure(removals)) return removals
  for (const name of removals ?? []) {
    const row = rowNamed(name)
    if (!row) return fail('invalid-record', `The stackup has no layer ${String(name)}.`, names)
    if (row.kind !== 'dielectric')
      return fail(
        'not-applicable',
        `${row.name} is a ${row.kind} row; only dielectrics are removed, as in Board Setup. The copper count is stackup.copperLayers.`
      )
    if (!plan.remove.includes(row.name)) plan.remove.push(row.name)
    if (!before.some((r) => r.name === row.name)) before.push(stackupLayerRecord(layers[row.index]))
  }
  const dielectrics = rows.filter((row) => row.kind === 'dielectric').length
  if (plan.remove.length && dielectrics - plan.remove.length < 1)
    return fail('not-applicable', 'A build keeps at least one dielectric between its copper.')

  const additions = list('addDielectric')
  if (isFailure(additions)) return additions
  for (const entry of additions ?? []) {
    if (!isRecord(entry) || typeof entry.after !== 'string')
      return fail(
        'invalid-record',
        'Each stackup.addDielectric entry is {after, ...fields}: the row it goes below.'
      )
    const row = rowNamed(entry.after)
    if (!row) return fail('invalid-record', `The stackup has no layer ${entry.after}.`, names)
    if (row.kind !== 'copper')
      return fail(
        'invalid-record',
        `${row.name} is a ${row.kind} row; a dielectric goes below a copper layer, as in Board Setup.`
      )
    if (plan.remove.includes(row.name))
      return fail(
        'invalid-record',
        `addDielectric goes after ${row.name}, which removeLayers takes.`
      )
    const planned = planPatch('The new dielectric', 'dielectric', DIELECTRIC_CELLS, {}, entry, [
      'after',
      ...DIELECTRIC_CELLS
    ])
    if (!planned.ok) return planned
    plan.add.push({ after: row.name, patch: planned.patch })
  }

  if (!plan.edits.length && !plan.remove.length && !plan.add.length)
    return fail('invalid-record', 'stackup names no layer change.')
  return {
    ok: true,
    plan,
    changed: {
      ...(plan.edits.length ? { edited: plan.edits.map((e) => e.name) } : {}),
      ...(plan.remove.length ? { removed: plan.remove } : {}),
      ...(plan.add.length ? { added: plan.add.length } : {})
    },
    before: { layers: before }
  }
}

/**
 * Land a plan on the board's stackup, as Board Setup's cell edits, Remove
 * layer and Add dielectric do it; rows are found by name first, since a
 * removal or an addition renumbers the dielectrics after it.
 */
export function applyStackupEdits(stackup: KicadStackup, plan: StackupEditPlan): void {
  const byName = new Map(stackup.layers.map((layer) => [layer.name, layer]))
  const editTargets = plan.edits.map((e) => ({ layer: byName.get(e.name), patch: e.patch }))
  const removeNodes = plan.remove.map((name) => byName.get(name)?._raw)
  const anchors = plan.add.map((a) => ({ node: byName.get(a.after)?._raw, patch: a.patch }))
  for (const { layer, patch } of editTargets)
    if (layer) updateStackupLayerInAST(stackup, layer, patch)
  const nodes = (): ReturnType<typeof findChildren> => findChildren(stackup._raw, 'layer')
  for (const node of removeNodes) if (node) removeStackupLayerInAST(stackup, nodes().indexOf(node))
  // Each addition after its anchor; several after one anchor stack in order below it.
  const placed = new Map<unknown, number>()
  for (const { node, patch } of anchors) {
    if (!node) continue
    const after = nodes().indexOf(node) + (placed.get(node) ?? 0)
    const index = addStackupDielectricInAST(stackup, after)
    placed.set(node, (placed.get(node) ?? 0) + 1)
    const added = nodes()[index]
    if (added && Object.keys(patch).length)
      updateStackupLayerInAST(stackup, { name: '', _raw: added }, patch)
  }
}
