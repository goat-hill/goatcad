<script setup lang="ts">
/**
 * Live Gerber preview for Manufacture mode — the payoff of exporting our own
 * format (fabrication-export-workstream.md): we generate the exact Gerbers
 * we are about to write, parse them back with our own reader, and composite them
 * in the shared engine. "The demo is the product drawing the board."
 *
 * Everything below the props is derived: change the board, the selected layers,
 * the coordinate precision, or the drill set and the preview regenerates.
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { KicadBoard } from '../../lib/kicad/board'
import { loadClipper } from '../../lib/geometry/clip'
import { writeGerberSet } from '../../lib/gerber/write'
import { drillPreviewGerber, type DrillHit } from '../../lib/gerber/drill'
import { parseGerber, type GerberImage } from '../../lib/gerber/parse'
import { layerFromFileFunction } from '../../lib/gerber/files'
import { kicadLayerColorsForTheme, themeColor, useAppTheme } from '../../lib/theme'
import { buildLayerPresets, type NonActiveLayerDisplay } from '../../lib/board/layerPresets'
import type { GerberSceneLayer } from '../../lib/engine/GerberScene'
import GerberViewport2D from '../gerber/GerberViewport2D.vue'
import LayersPanel, { type LayerDisplayItem } from '../shared/LayersPanel.vue'
import NonActiveDisplayButton from '../shared/NonActiveDisplayButton.vue'

const { t } = useI18n()

const props = defineProps<{
  board: KicadBoard | null
  /** KiCad layer names to plot, in package (stack) order. */
  layers: string[]
  decimals: number
  /** The project's text variables, which board text resolves `${NAME}` from. */
  textVariables?: Readonly<Record<string, string>>
  /** Drill hits for the synthetic "Drills" layer; empty to omit it. */
  drillHits: DrillHit[]
  /** Make the Drills layer active (used by the Drill output view). */
  emphasizeDrill?: boolean
}>()

const DRILLS_ID = 'Drills'
const BASE_OPACITY = 0.75
/** Order the synthetic drill layer on top of everything else. */
const DRILLS_ORDER = 1000

interface PreviewLayer {
  id: string
  image: GerberImage
  opacity: number
  order: number
  warnings: string[]
}

/**
 * Generate + parse every selected layer plus the drill preview. Kept as one
 * computed so any input change rebuilds the whole set atomically.
 */
// The plot needs the geometry engine (knockouts, healed mask, clipped silk):
// the preview waits for it, empty until it lands.
const clipperReady = ref(false)
void loadClipper().then(() => (clipperReady.value = true))

const previewLayers = computed<PreviewLayer[]>(() => {
  const board = props.board
  if (!board) return []
  const out: PreviewLayer[] = []

  void clipperReady.value
  const generated = writeGerberSet(board, props.layers, {
    decimals: props.decimals,
    textVariables: props.textVariables
  })
  for (const layer of generated) {
    let image: GerberImage
    try {
      image = parseGerber(layer.content)
    } catch {
      continue
    }
    out.push({
      id: layer.kicadLayer,
      image,
      opacity: layer.kicadLayer === 'Edge.Cuts' ? 1 : BASE_OPACITY,
      order: layerFromFileFunction(layer.fileFunction).order,
      warnings: layer.warnings
    })
  }

  if (props.drillHits.length > 0) {
    try {
      out.push({
        id: DRILLS_ID,
        image: parseGerber(drillPreviewGerber(props.drillHits)),
        opacity: 1,
        order: DRILLS_ORDER,
        warnings: []
      })
    } catch {
      /* preview-only; ignore */
    }
  }

  // Stack order: board bottom first, drills on top.
  out.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
  return out
})

// Colors resolve here, not in previewLayers, so a theme change repaints
// without regenerating the Gerber set.
const appTheme = useAppTheme()
const sceneLayers = computed<GerberSceneLayer[]>(() => {
  const colors = kicadLayerColorsForTheme(appTheme.value)
  const drills = themeColor('--vscode-canvas-drill', '#cfd6d2')
  const unknown = themeColor('--vscode-canvas-layer-unknown', '#ffffff')
  return previewLayers.value.map((l) => ({
    id: l.id,
    image: l.image,
    color: l.id === DRILLS_ID ? drills : (colors[l.id] ?? unknown),
    opacity: l.opacity
  }))
})

// Panel lists top of the stack first (KiCad convention).
const panelLayers = computed<LayerDisplayItem[]>(() =>
  [...previewLayers.value].reverse().map((l) => ({ name: l.id, title: l.id }))
)

const layerPresets = computed(() =>
  buildLayerPresets(
    previewLayers.value.map((l) => l.id),
    (key) => t(`shared.layerPresets.${key}`)
  )
)

// Deduped warnings across the generated set — the pre-flight signal (stale
// pours, approximated pads) surfaced right beside the preview.
const warnings = computed<string[]>(() => {
  const seen = new Set<string>()
  for (const l of previewLayers.value) for (const w of l.warnings) seen.add(w)
  return [...seen]
})

const activeLayerId = ref<string | null>(null)
const visibility = ref<Record<string, boolean>>({})
const nonActiveDisplay = ref<NonActiveLayerDisplay>('show')

watch(
  previewLayers,
  (layers) => {
    const ids = layers.map((l) => l.id)
    const nextVis: Record<string, boolean> = {}
    for (const id of ids) nextVis[id] = true
    visibility.value = nextVis
    const wantDrills = props.emphasizeDrill && ids.includes(DRILLS_ID)
    if (!activeLayerId.value || !ids.includes(activeLayerId.value) || wantDrills) {
      activeLayerId.value = wantDrills ? DRILLS_ID : (ids[ids.length - 1] ?? null)
    }
  },
  { immediate: true }
)

const toggleLayer = (layer: string): void => {
  visibility.value = { ...visibility.value, [layer]: !visibility.value[layer] }
}
const applyPreset = (map: Record<string, boolean>): void => {
  visibility.value = { ...map }
}
</script>

<template>
  <div class="gerber-preview">
    <div v-if="!board" class="gp-empty">{{ t('manufacture.gerber.previewLoading') }}</div>
    <div v-else-if="sceneLayers.length === 0" class="gp-empty">
      {{ t('manufacture.gerber.previewEmpty') }}
    </div>
    <template v-else>
      <div class="gp-viewport">
        <GerberViewport2D
          :layers="sceneLayers"
          :active-layer="activeLayerId"
          :visibility="visibility"
          :non-active-display="nonActiveDisplay"
        />
        <div class="canvas-floating-toolbar">
          <NonActiveDisplayButton v-model:mode="nonActiveDisplay" />
        </div>
        <ul v-if="warnings.length" class="gp-warnings">
          <li v-for="(w, i) in warnings" :key="i">{{ w }}</li>
        </ul>
      </div>
      <aside class="gp-layers">
        <LayersPanel
          :layers="panelLayers"
          :layer-visibility="visibility"
          :active-layer="activeLayerId ?? ''"
          :presets="layerPresets"
          @toggle-layer-visibility="toggleLayer"
          @set-active-layer="(layer) => (activeLayerId = layer)"
          @apply-layer-preset="applyPreset"
        />
      </aside>
    </template>
  </div>
</template>

<style scoped>
.gerber-preview {
  flex: 1;
  min-height: 0;
  display: flex;
  border-top: 1px solid var(--vscode-border);
  background: var(--vscode-bg-viewport);
}

.gp-viewport {
  flex: 1;
  min-width: 0;
  position: relative;
  overflow: hidden;
}

.gp-layers {
  flex: 0 0 230px;
  overflow: auto;
  border-left: 1px solid var(--vscode-border);
  background: var(--vscode-bg-editor);
  font-size: var(--text-body-sm);
}

.gp-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--vscode-text-muted);
  font-size: 12px;
}

/* Pre-flight warnings float over the composite, bottom-left. */
.gp-warnings {
  position: absolute;
  left: 12px;
  bottom: 10px;
  z-index: 12;
  max-width: 70%;
  margin: 0;
  padding: 6px 10px;
  list-style: none;
  border: 1px solid var(--vscode-warning);
  border-radius: 4px;
  background: var(--vscode-overlay);
  color: var(--vscode-warning);
  font-size: var(--text-body-sm);
  line-height: 1.5;
}
</style>
