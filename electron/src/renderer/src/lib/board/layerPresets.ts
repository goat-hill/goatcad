/**
 * Layer visibility preset groups shared by the footprint and PCB editors.
 *
 * Presets are generated from the list of layers an editor actually has, so
 * the footprint editor's fixed 12-layer set and a board's own layer table
 * both produce sensible groups. Edge.Cuts (when present) stays visible in
 * every preset except "No Layers" — a board without its outline is
 * disorienting.
 */

import { isCopperLayer } from '../kicad/layers'
import type { SavedLayerPreset } from '../../../../preload/layerPresetTypes'

/** Repeated as `FootprintNonActiveDisplay` in `preload/footprintViewTypes.d.ts`,
 *  which is the persisted copy — change both (RULES.md §5). */
export type NonActiveLayerDisplay = 'show' | 'dim' | 'hide'

const NEXT_NON_ACTIVE: Record<NonActiveLayerDisplay, NonActiveLayerDisplay> = {
  show: 'dim',
  dim: 'hide',
  hide: 'show'
}

/** The display one click of the cycling control moves to: show → dim → hide. */
export const nextNonActiveDisplay = (mode: NonActiveLayerDisplay): NonActiveLayerDisplay =>
  NEXT_NON_ACTIVE[mode]

export interface LayerPreset {
  id: string
  label: string
  visibility: Record<string, boolean>
}

const INNER_COPPER_RE = /^In\d+\.Cu$/

export type LayerPresetKey =
  'all' | 'frontAssembly' | 'front' | 'backAssembly' | 'back' | 'copper' | 'innerCopper' | 'none'

/**
 * `label` looks up the display text for a preset key (e.g. from vue-i18n) so
 * this pure domain module doesn't need to import a UI framework directly.
 */
export function buildLayerPresets(
  layerNames: string[],
  label: (key: LayerPresetKey) => string
): LayerPreset[] {
  const make = (id: string, key: LayerPresetKey, pred: (name: string) => boolean): LayerPreset => ({
    id,
    label: label(key),
    visibility: Object.fromEntries(
      layerNames.map((name) => [name, name === 'Edge.Cuts' || pred(name)])
    )
  })

  const presets: LayerPreset[] = [
    make('all', 'all', () => true),
    make('front_assembly', 'frontAssembly', (n) => n.startsWith('F.') && n !== 'F.Paste'),
    make('front', 'front', (n) => n.startsWith('F.')),
    make('back_assembly', 'backAssembly', (n) => n.startsWith('B.') && n !== 'B.Paste'),
    make('back', 'back', (n) => n.startsWith('B.')),
    make('copper', 'copper', (n) => isCopperLayer(n))
  ]

  if (layerNames.some((n) => INNER_COPPER_RE.test(n))) {
    presets.push(make('inner_copper', 'innerCopper', (n) => INNER_COPPER_RE.test(n)))
  }

  presets.push({
    id: 'none',
    label: label('none'),
    visibility: Object.fromEntries(layerNames.map((name) => [name, false]))
  })

  return presets
}

// ---------------------------------------------------------------------------
// Saved presets
// ---------------------------------------------------------------------------

/** Keeps a saved preset's id clear of the generated ones ('all', 'front', …). */
const SAVED_PRESET_PREFIX = 'user:'

export const savedPresetId = (name: string): string => `${SAVED_PRESET_PREFIX}${name}`

export const isSavedPresetId = (id: string): boolean => id.startsWith(SAVED_PRESET_PREFIX)

export const savedPresetName = (id: string): string => id.slice(SAVED_PRESET_PREFIX.length)

/**
 * The saved presets a document can actually use: one is offered only when every
 * layer it names exists here. That single test is what keeps a board's presets
 * out of the footprint editor's list, and a Gerber set's out of both, without
 * any of them being told the others exist.
 */
export function usableSavedPresets(
  saved: readonly SavedLayerPreset[],
  layerVisibility: Record<string, boolean>
): LayerPreset[] {
  return saved
    .filter((preset) => Object.keys(preset.visibility).every((layer) => layer in layerVisibility))
    .map((preset) => ({
      id: savedPresetId(preset.name),
      label: preset.name,
      visibility: preset.visibility
    }))
}

/**
 * Which preset a visibility set currently IS, or `''` for none of them.
 *
 * Derived rather than remembered, which is the whole trick: a preset is a
 * shorthand for a set of layers, so the moment one is toggled it is no longer
 * what is on screen, and the moment it is toggled back it is again. Nothing has
 * to notice an edit and clear a stored id, and nothing has to be persisted for
 * the selection to survive a reopen — the layers already are.
 *
 * A preset matches on the layers IT names, so a saved preset covering part of a
 * board matches whenever that part agrees. First match wins, so the built-in
 * sets keep their names when a saved one happens to duplicate them.
 */
export function matchingPresetId(
  presets: readonly LayerPreset[],
  layerVisibility: Record<string, boolean>
): string {
  const match = presets.find((preset) =>
    Object.entries(preset.visibility).every(([layer, on]) => layerVisibility[layer] === on)
  )
  return match?.id ?? ''
}
