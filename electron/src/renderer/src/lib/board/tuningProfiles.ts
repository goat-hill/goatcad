/**
 * Board Setup's Tuning profiles (KiCad 10's PANEL_SETUP_TUNING_PROFILES): the
 * profiles as a model the page edits, pure. A profile gives each signal layer
 * the planes it is referenced to, a width, a pair gap and a unit delay; a net
 * class names the profile its nets take (`NetClass.tuningProfile`).
 *
 * Nothing here solves: a width or delay is what was typed or what an explicit
 * solve wrote (`applyLayerSolve`), never recomputed behind the user's back.
 * Delays are KiCad's attoseconds per millimeter; the page shows ps/mm.
 */

import type { NetClass, TuningProfile, TuningProfileLayer } from '../kicad/project'
import type { PropertyEditValue, PropertyField } from '../propertyTable'
import {
  analyseLayer,
  solveProfileLayer,
  type ProfileSolveError,
  type SolverStackup
} from './impedance'

/** A profile's own fields, as the page's header row edits them. */
export const PROFILE_FIELDS = [
  'name',
  'differential',
  'targetImpedance',
  'timeDomain',
  'viaDelay'
] as const
export type ProfileField = (typeof PROFILE_FIELDS)[number]

/** A layer row's columns, KiCad's Track Propagation grid's order. */
export const PROFILE_LAYER_COLUMNS = [
  'layer',
  'topReference',
  'bottomReference',
  'width',
  'gap',
  'delay'
] as const
export type ProfileLayerColumn = (typeof PROFILE_LAYER_COLUMNS)[number]

/** Attoseconds in a picosecond: the file's unit against the page's. */
export const AS_PER_PS = 1e6

type Translate = (key: string) => string

/** What the profile edits read and write. */
export interface TuningProfileModel {
  tuningProfiles: readonly TuningProfile[]
  classes: readonly NetClass[]
}

/** What one layer row reads as now: its impedance, or why it has none. */
export type LayerReadout = { ohms: number } | { error: string } | null

export interface TuningProfileLayerRow {
  index: number
  cells: Record<ProfileLayerColumn, PropertyField>
  readout: LayerReadout
}

export interface TuningProfileBlock {
  index: number
  name: string
  differential: boolean
  fields: Record<ProfileField, PropertyField>
  layers: TuningProfileLayerRow[]
  /** The classes that name this profile. */
  classes: string[]
  /** Under an interface preset draft: what Apply would do to the profile. */
  pending?: 'added' | 'edited'
}

const asNumber = (value: PropertyEditValue): number => {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : 0
}

const asString = (value: PropertyEditValue): string =>
  typeof value === 'string' ? value : value === null ? '' : String(value)

/** A name no other profile has: `wanted`, else `wanted 2`, `wanted 3`… */
export function uniqueProfileName(profiles: readonly TuningProfile[], wanted: string): string {
  const taken = new Set(profiles.map((p) => p.name))
  if (!taken.has(wanted)) return wanted
  for (let n = 2; ; n++) if (!taken.has(`${wanted} ${n}`)) return `${wanted} ${n}`
}

/** A new profile, as KiCad's Add starts one: single-ended, no target, no layers. */
export function addTuningProfile<M extends TuningProfileModel>(model: M, name: string): M {
  const profile: TuningProfile = {
    name: uniqueProfileName(model.tuningProfiles, name),
    differential: false,
    targetImpedance: 0,
    timeDomain: false,
    layers: [],
    viaDelay: 0,
    overrides: []
  }
  return { ...model, tuningProfiles: [...model.tuningProfiles, profile] }
}

/**
 * Remove a profile, and every class's reference to it: a class naming a
 * profile that is gone is config KiCad flags (`missing_tuning_profile`), so it
 * goes with the profile, as a class's patterns go with the class.
 */
export function removeTuningProfile<M extends TuningProfileModel>(model: M, index: number): M {
  const target = model.tuningProfiles[index]
  if (!target) return model
  return {
    ...model,
    tuningProfiles: model.tuningProfiles.filter((_, i) => i !== index),
    classes: model.classes.map((c) => (c.tuningProfile === target.name ? withProfile(c, '') : c))
  }
}

const withProfile = (netClass: NetClass, name: string): NetClass => {
  const next: NetClass = { ...netClass }
  if (name) next.tuningProfile = name
  else delete next.tuningProfile
  return next
}

/** Edit one of a profile's own fields. A rename carries the classes that name it. */
export function editTuningProfile<M extends TuningProfileModel>(
  model: M,
  index: number,
  field: ProfileField,
  value: PropertyEditValue
): M {
  const target = model.tuningProfiles[index]
  if (!target) return model
  const replace = (profile: TuningProfile, classes = model.classes): M => ({
    ...model,
    tuningProfiles: model.tuningProfiles.map((p, i) => (i === index ? profile : p)),
    classes
  })
  switch (field) {
    case 'name': {
      const wanted = asString(value).trim()
      if (!wanted || wanted === target.name) return model
      const name = uniqueProfileName(
        model.tuningProfiles.filter((_, i) => i !== index),
        wanted
      )
      return replace(
        { ...target, name },
        model.classes.map((c) => (c.tuningProfile === target.name ? withProfile(c, name) : c))
      )
    }
    case 'differential': {
      const differential = value === true || value === 'differential'
      return differential === target.differential ? model : replace({ ...target, differential })
    }
    case 'timeDomain':
      return replace({ ...target, timeDomain: value === true })
    case 'targetImpedance':
      return replace({ ...target, targetImpedance: Math.max(0, asNumber(value)) })
    case 'viaDelay':
      return replace({ ...target, viaDelay: Math.max(0, asNumber(value)) * AS_PER_PS })
  }
}

/**
 * Add the next layer row as KiCad's OnAddTrackRow does: the first is the top
 * copper referenced to the layer below it; each after it is the copper after
 * the last row's, referenced to its neighbors; past the bottom, the top again.
 */
export function addProfileLayer<M extends TuningProfileModel>(
  model: M,
  index: number,
  copperLayers: readonly string[]
): M {
  const target = model.tuningProfiles[index]
  if (!target || !copperLayers.length) return model
  const front = (): TuningProfileLayer => blankLayer(copperLayers[0], '', copperLayers[1] ?? '')
  const last = target.layers[target.layers.length - 1]
  let row: TuningProfileLayer
  if (!last) row = front()
  else {
    const at = copperLayers.indexOf(last.layer)
    if (at < 0) return model
    row =
      at === copperLayers.length - 1
        ? front()
        : blankLayer(copperLayers[at + 1], copperLayers[at], copperLayers[at + 2] ?? '')
  }
  return replaceProfile(model, index, { ...target, layers: [...target.layers, row] })
}

const blankLayer = (layer: string, top: string, bottom: string): TuningProfileLayer => ({
  layer,
  topReference: top,
  bottomReference: bottom,
  width: 0,
  gap: 0,
  delay: 0
})

const replaceProfile = <M extends TuningProfileModel>(
  model: M,
  index: number,
  profile: TuningProfile
): M => ({
  ...model,
  tuningProfiles: model.tuningProfiles.map((p, i) => (i === index ? profile : p))
})

export function removeProfileLayer<M extends TuningProfileModel>(
  model: M,
  index: number,
  row: number
): M {
  const target = model.tuningProfiles[index]
  if (!target?.layers[row]) return model
  return replaceProfile(model, index, {
    ...target,
    layers: target.layers.filter((_, i) => i !== row)
  })
}

/** Edit one cell of a layer row: a layer by name, a size in mm, a delay in ps/mm. */
export function editProfileLayer<M extends TuningProfileModel>(
  model: M,
  index: number,
  row: number,
  column: ProfileLayerColumn,
  value: PropertyEditValue
): M {
  const target = model.tuningProfiles[index]
  const layer = target?.layers[row]
  if (!target || !layer) return model
  let next: TuningProfileLayer
  if (column === 'layer' || column === 'topReference' || column === 'bottomReference') {
    const name = asString(value)
    // One row per signal layer, as KiCad's ValidateProfile holds it.
    if (column === 'layer' && target.layers.some((l, i) => i !== row && l.layer === name))
      return model
    next = { ...layer, [column]: name }
  } else if (column === 'delay')
    next = { ...layer, delay: Math.max(0, asNumber(value)) * AS_PER_PS }
  else next = { ...layer, [column]: Math.max(0, asNumber(value)) }
  return replaceProfile(model, index, {
    ...target,
    layers: target.layers.map((l, i) => (i === row ? next : l))
  })
}

/** What a solve hands back for one row: the cells it fills. */
export interface LayerSolve {
  width?: number
  gap?: number
  delay: number
}

/** Write a solve into its row: the one explicit way a computed number lands. */
export function applyLayerSolve<M extends TuningProfileModel>(
  model: M,
  index: number,
  row: number,
  solve: LayerSolve
): M {
  const target = model.tuningProfiles[index]
  const layer = target?.layers[row]
  if (!target || !layer) return model
  const next: TuningProfileLayer = {
    ...layer,
    ...(solve.width !== undefined ? { width: solve.width } : {}),
    ...(solve.gap !== undefined ? { gap: solve.gap } : {}),
    delay: solve.delay
  }
  return replaceProfile(model, index, {
    ...target,
    layers: target.layers.map((l, i) => (i === row ? next : l))
  })
}

/** The page's blocks, one per profile; `readout` says what each row's geometry comes to. */
export function buildTuningProfileBlocks(
  model: TuningProfileModel,
  copperLayers: readonly string[],
  t: Translate,
  readout: (profile: TuningProfile, layer: TuningProfileLayer) => LayerReadout = () => null,
  /** Each layer's color, its swatch beside its name (DESIGN.md, Layer swatches). */
  layerColors: Readonly<Record<string, string>> = {}
): TuningProfileBlock[] {
  const tr = (key: string): string => t(`boardSetup.tuningProfiles.${key}`)
  const layerOptions = copperLayers.map((name) => ({
    value: name,
    label: name,
    ...(layerColors[name] ? { color: layerColors[name] } : {})
  }))
  const referenceOptions = [{ value: '', label: tr('none') }, ...layerOptions]
  return model.tuningProfiles.map((profile, index) => ({
    index,
    name: profile.name,
    differential: profile.differential,
    classes: model.classes.filter((c) => c.tuningProfile === profile.name).map((c) => c.name),
    fields: {
      name: { key: 'name', label: tr('name'), editor: { kind: 'text' }, value: profile.name },
      differential: {
        key: 'differential',
        label: tr('type'),
        editor: {
          kind: 'select',
          options: [
            { value: 'single', label: tr('single') },
            { value: 'differential', label: tr('differential') }
          ]
        },
        value: profile.differential ? 'differential' : 'single'
      },
      targetImpedance: {
        key: 'targetImpedance',
        label: tr('target'),
        editor: { kind: 'number', step: 1, min: 0, unit: 'Ω' },
        value: profile.targetImpedance
      },
      timeDomain: {
        key: 'timeDomain',
        label: tr('timeDomain'),
        editor: { kind: 'checkbox' },
        value: profile.timeDomain
      },
      viaDelay: {
        key: 'viaDelay',
        label: tr('viaDelay'),
        editor: { kind: 'number', step: 0.01, min: 0, unit: 'ps/mm' },
        value: profile.viaDelay / AS_PER_PS
      }
    },
    layers: profile.layers.map((layer, row) => ({
      index: row,
      readout: readout(profile, layer),
      cells: {
        layer: {
          key: 'layer',
          label: tr('columns.layer'),
          editor: { kind: 'select', options: layerOptions },
          value: layer.layer
        },
        topReference: {
          key: 'topReference',
          label: tr('columns.topReference'),
          editor: { kind: 'select', options: referenceOptions },
          value: layer.topReference
        },
        bottomReference: {
          key: 'bottomReference',
          label: tr('columns.bottomReference'),
          editor: { kind: 'select', options: referenceOptions },
          value: layer.bottomReference
        },
        width: {
          key: 'width',
          label: tr('columns.width'),
          editor: { kind: 'distance', step: 0.001 },
          value: layer.width
        },
        gap: {
          key: 'gap',
          label: tr('columns.gap'),
          editor: { kind: 'distance', step: 0.001 },
          value: layer.gap
        },
        delay: {
          key: 'delay',
          label: tr('columns.delay'),
          editor: { kind: 'number', step: 0.01, min: 0, unit: 'ps/mm' },
          value: Math.round((layer.delay / AS_PER_PS) * 1e4) / 1e4
        }
      }
    }))
  }))
}

/** What the page's Solve does for one row, held to KiCad's calculator: the width for the target, then its delay. */
export function solveProfileRow(
  stackup: SolverStackup,
  profile: TuningProfile,
  layer: TuningProfileLayer
): { ok: true; solve: LayerSolve } | { ok: false; error: ProfileSolveError } {
  const solved = solveProfileLayer({
    stackup,
    signalLayer: layer.layer,
    topReference: layer.topReference || undefined,
    bottomReference: layer.bottomReference || undefined,
    differential: profile.differential,
    targetOhms: profile.targetImpedance,
    solveFor: 'width',
    ...(profile.differential ? { gapMm: layer.gap } : {})
  })
  return solved.ok
    ? { ok: true, solve: { width: solved.widthMm, delay: solved.delay } }
    : { ok: false, error: solved.error }
}

/** A row's impedance as drawn; none until it has a width. */
export function profileRowReadout(
  stackup: SolverStackup,
  profile: TuningProfile,
  layer: TuningProfileLayer
): { ok: true; ohms: number } | { ok: false; error: ProfileSolveError } | null {
  if (layer.width <= 0 || (profile.differential && layer.gap <= 0)) return null
  const analysed = analyseLayer({
    stackup,
    signalLayer: layer.layer,
    topReference: layer.topReference || undefined,
    bottomReference: layer.bottomReference || undefined,
    differential: profile.differential,
    widthMm: layer.width,
    ...(profile.differential ? { gapMm: layer.gap } : {})
  })
  return analysed.ok ? { ok: true, ohms: analysed.ohms } : analysed
}
