/**
 * The Board Setup presets the user saved — constraint configurations and
 * stackup builds — beside the shipped ones, shared by every window.
 *
 * Modeled on `layerPresetStore.ts`: the main-process config store holds them
 * (RULES.md §8), reads are empty until the first load lands, and a missing
 * bridge degrades to an in-memory copy. Why they are app-wide is in
 * `src/preload/boardSetupPresetTypes.d.ts`. A saved preset is the user's, so
 * only these can be removed; the shipped set is read-only.
 */

import { ref } from 'vue'
import type {
  BoardSetupPresets,
  SavedSetupProfile,
  SavedStackupPreset
} from '../../../../preload/boardSetupPresetTypes'
import type { StackupSpec } from '../kicad/board'
import {
  DEFAULT_DESIGN_RULES,
  DEFAULT_NET_CLASSES,
  type DesignRules,
  type RoutingDefaults
} from '../kicad/project'
import {
  BUILT_IN_PROFILES,
  DEFAULT_PROFILE_ID,
  allStackupPresets,
  defaultStackupOf,
  findProfile,
  type ManufacturingProfile,
  type StackupPreset
} from '../manufacturingProfiles'
import { nearestCopperLayerCount } from './boardSetupSchema'

/** Sets a saved preset's id apart from every shipped id. */
const USER_PREFIX = 'user:'

export const isUserPresetId = (id: string | null | undefined): id is string =>
  !!id && id.startsWith(USER_PREFIX)

/** The id a name already has, or a new one: see `SavedSetupProfile.id`. */
const idFor = (list: ReadonlyArray<{ id: string; name: string }>, name: string): string =>
  list.find((entry) => entry.name === name)?.id ?? `${USER_PREFIX}${crypto.randomUUID()}`

const store = ref<BoardSetupPresets>({ profiles: [], stackups: [] })

let loading: Promise<void> | null = null

const api = (): typeof window.api | null =>
  typeof window !== 'undefined' && window.api ? window.api : null

const adopt = (next: BoardSetupPresets | undefined): void => {
  store.value = next ?? { profiles: [], stackups: [] }
}

/** Load once per window and keep in step with other windows. Idempotent. */
export function loadUserSetupPresets(): Promise<void> {
  if (loading) return loading
  const bridge = api()
  if (!bridge) return (loading = Promise.resolve())
  loading = bridge
    .getConfig()
    .then((config) => adopt(config.boardSetupPresets))
    .catch(() => {
      // A config that cannot be read costs the saved presets, not the page.
    })
  bridge.onConfigChanged((config) => adopt(config.boardSetupPresets))
  return loading
}

const persist = (next: BoardSetupPresets): void => {
  store.value = next
  // Plain data across the bridge: the store's entries are Vue proxies, which
  // fail to clone (RULES.md §9) and would throw before the save is picked.
  const plain = JSON.parse(JSON.stringify(next)) as BoardSetupPresets
  void api()?.updateConfig({ boardSetupPresets: plain })
}

const FALLBACK_DEFAULTS: RoutingDefaults = {
  trackWidth: DEFAULT_NET_CLASSES[0].trackWidth,
  clearance: DEFAULT_NET_CLASSES[0].clearance,
  viaDiameter: DEFAULT_NET_CLASSES[0].viaDiameter,
  viaDrill: DEFAULT_NET_CLASSES[0].viaDrill
}

/** Each known key from the saved record where its type matches, else the fallback's. */
const overlay = <T extends object>(fallback: T, saved: Record<string, unknown>): T =>
  Object.fromEntries(
    Object.entries(fallback).map(([key, value]) => [
      key,
      typeof saved[key] === typeof value ? saved[key] : value
    ])
  ) as T

/**
 * A saved configuration as a profile: its rules and Default sizes, and no
 * stackup catalog of its own. The stackup is saved, and picked, on its own.
 */
const profileOf = (saved: SavedSetupProfile): ManufacturingProfile => ({
  id: saved.id,
  vendor: saved.name,
  tier: '',
  builtIn: false,
  stackups: [],
  rules: overlay<DesignRules>(DEFAULT_DESIGN_RULES, saved.rules),
  defaults: overlay<RoutingDefaults>(FALLBACK_DEFAULTS, saved.defaults)
})

const STRING_SPEC_KEYS = ['dielectricMaterial', 'maskColor', 'silkColor', 'copperFinish'] as const
const NUMBER_SPEC_KEYS = [
  'boardThickness',
  'copperThickness',
  'innerCopperThickness',
  'prepregThickness',
  'prepregEpsilonR',
  'epsilonR',
  'lossTangent'
] as const

/** A saved build as a spec: what it holds, where valid, over the default build. */
const specOf = (saved: Record<string, number | string>): StackupSpec => {
  const spec: StackupSpec = { ...defaultStackupOf(findProfile(DEFAULT_PROFILE_ID)!) }
  if (typeof saved.copperLayers === 'number')
    spec.copperLayers = nearestCopperLayerCount(saved.copperLayers)
  for (const key of NUMBER_SPEC_KEYS) {
    const value = saved[key]
    if (typeof value === 'number' && value >= 0) spec[key] = value
  }
  for (const key of STRING_SPEC_KEYS) {
    const value = saved[key]
    if (typeof value === 'string' && value.trim()) spec[key] = value
  }
  return spec
}

const stackupOf = (saved: SavedStackupPreset): StackupPreset => ({
  id: saved.id,
  name: saved.name,
  spec: specOf(saved.spec)
})

/** The saved configurations, as profiles. Reactive inside a computed. */
export const userProfiles = (): ManufacturingProfile[] => store.value.profiles.map(profileOf)

/** The saved builds. Reactive inside a computed. */
export const userStackupPresets = (): StackupPreset[] => store.value.stackups.map(stackupOf)

/** A shipped or saved profile by id. */
export const findAnyProfile = (id: string): ManufacturingProfile | null =>
  BUILT_IN_PROFILES.find((p) => p.id === id) ?? userProfiles().find((p) => p.id === id) ?? null

/** A shipped or saved build by id. */
export const findAnyStackupPreset = (id: string): StackupPreset | null =>
  allStackupPresets().find((p) => p.id === id) ??
  userStackupPresets().find((p) => p.id === id) ??
  null

/**
 * Save a configuration by name, replacing one of the same name: typing a name
 * that exists is how a saved preset is updated. Returns its id.
 */
export function saveUserProfile(
  name: string,
  rules: DesignRules,
  defaults: RoutingDefaults
): string | null {
  const trimmed = name.trim()
  if (!trimmed) return null
  const id = idFor(store.value.profiles, trimmed)
  persist({
    ...store.value,
    profiles: [
      ...store.value.profiles.filter((p) => p.name !== trimmed),
      { id, name: trimmed, rules: { ...rules }, defaults: { ...defaults } }
    ]
  })
  return id
}

/** Save a build by name, as `saveUserProfile` does. Returns its id. */
export function saveUserStackup(name: string, spec: StackupSpec): string | null {
  const trimmed = name.trim()
  if (!trimmed) return null
  const id = idFor(store.value.stackups, trimmed)
  const saved = Object.fromEntries(
    Object.entries(spec).filter(([, v]) => typeof v === 'number' || typeof v === 'string')
  ) as Record<string, number | string>
  persist({
    ...store.value,
    stackups: [
      ...store.value.stackups.filter((s) => s.name !== trimmed),
      { id, name: trimmed, spec: saved }
    ]
  })
  return id
}

/** Remove a saved configuration; a shipped id matches none. */
export function removeUserProfile(id: string): void {
  persist({ ...store.value, profiles: store.value.profiles.filter((p) => p.id !== id) })
}

/** Remove a saved build; a shipped id matches none. */
export function removeUserStackup(id: string): void {
  persist({ ...store.value, stackups: store.value.stackups.filter((s) => s.id !== id) })
}

/** Test seam — the module-scope store outlives any one test otherwise. */
export function __resetUserSetupPresets(): void {
  loading = null
  store.value = { profiles: [], stackups: [] }
}
