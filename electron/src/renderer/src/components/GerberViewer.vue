<script setup lang="ts">
import { computed, onMounted, ref, shallowRef, watch } from 'vue'
import { useContextPanels, useGroupKeydown } from '../lib/editorWorkspace'
import { useI18n } from 'vue-i18n'
import { parseGerber, type GerberImage } from '../lib/gerber/parse'
import { identifyGerberLayer, isGerberFile } from '../lib/gerber/files'
import { kicadLayerColorsForTheme, themeColor, useAppTheme } from '../lib/theme'
import { buildLayerPresets, type NonActiveLayerDisplay } from '../lib/board/layerPresets'
import type { GerberSceneLayer } from '../lib/engine/GerberScene'
import GerberViewport2D from './gerber/GerberViewport2D.vue'
import LayersPanel, { type LayerDisplayItem } from './shared/LayersPanel.vue'
import NonActiveDisplayButton from './shared/NonActiveDisplayButton.vue'
import FitViewButton from './shared/FitViewButton.vue'
import Icon from './shared/Icon.vue'
import ResizeHandle from './shared/ResizeHandle.vue'
import { panelWidth, setPanelWidth } from '../lib/panelLayout'
import { matchesHotkey, isTypingTarget } from '../lib/hotkeys'

const { t } = useI18n()
const { show: showPanels, inline: panelsInline, rail: panelRail } = useContextPanels()

// The one rail width every tab shares (panelLayout.ts), so switching to this
// viewer beside a design never resizes the panes.
const railWidth = panelWidth()
let railResizeStart = 0

const props = defineProps<{
  /** Content of the opened file (loaded by EditorArea). */
  modelValue: string
  filePath: string
  name: string
}>()

/** One loaded Gerber layer file. */
interface LayerEntry {
  /** Unique key: the KiCad layer name when identified, else the filename. */
  id: string
  fileName: string
  image: GerberImage
  kicadLayer: string | null
  order: number
  /** True for the file this tab was opened on. */
  isOpened: boolean
}

// Keep at most this many sibling files — a directory that trips it is
// probably not a Gerber output folder.
const MAX_LAYER_FILES = 40

const BASE_OPACITY = 0.75

const entries = shallowRef<LayerEntry[]>([])
const parseError = ref<string | null>(null)
const fileWarnings = shallowRef<Array<{ file: string; message: string }>>([])
const loadingSiblings = ref(true)

const activeLayerId = ref<string | null>(null)
const visibility = ref<Record<string, boolean>>({})
const nonActiveDisplay = ref<NonActiveLayerDisplay>('show')

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

interface FileItem {
  name: string
  path: string
  isDirectory: boolean
  children?: FileItem[]
}

const dirOf = (p: string): string => p.slice(0, Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')))

const buildEntry = (
  fileName: string,
  content: string,
  isOpened: boolean,
  taken: Set<string>
): LayerEntry | null => {
  let image: GerberImage
  try {
    image = parseGerber(content)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (isOpened) parseError.value = message
    else fileWarnings.value = [...fileWarnings.value, { file: fileName, message }]
    return null
  }
  for (const warning of image.warnings) {
    fileWarnings.value = [...fileWarnings.value, { file: fileName, message: warning }]
  }
  const identity = identifyGerberLayer(fileName, image.fileFunction)
  let id = identity.kicadLayer ?? fileName
  if (taken.has(id)) id = fileName
  if (taken.has(id)) id = `${fileName} (${taken.size})`
  taken.add(id)
  return { id, fileName, image, kicadLayer: identity.kicadLayer, order: identity.order, isOpened }
}

/** The opened file re-parses on content change; siblings load once per mount. */
const load = async (): Promise<void> => {
  parseError.value = null
  fileWarnings.value = []
  const taken = new Set<string>()
  const nextEntries: LayerEntry[] = []

  const own = buildEntry(props.name, props.modelValue, true, taken)
  if (own) nextEntries.push(own)

  try {
    const listing = (await window.api.readDirectory(dirOf(props.filePath))) as FileItem[]
    const siblings = listing
      .filter(
        (f) =>
          !f.isDirectory &&
          isGerberFile(f.name) &&
          f.path !== props.filePath &&
          f.name !== props.name
      )
      .slice(0, MAX_LAYER_FILES)
    for (const sibling of siblings) {
      const res = await window.api.readFile(sibling.path)
      if (!res.success || res.content === undefined) {
        fileWarnings.value = [
          ...fileWarnings.value,
          { file: sibling.name, message: res.error ?? 'read failed' }
        ]
        continue
      }
      const entry = buildEntry(sibling.name, res.content, false, taken)
      if (entry) nextEntries.push(entry)
    }
  } catch (err) {
    console.error('Gerber sibling discovery failed:', err)
  }

  // Stack order: bottom of the board first, opened-file ties first
  nextEntries.sort((a, b) => a.order - b.order || a.fileName.localeCompare(b.fileName))
  entries.value = nextEntries

  const opened = nextEntries.find((e) => e.isOpened)
  activeLayerId.value = opened?.id ?? nextEntries[0]?.id ?? null
  const nextVisibility: Record<string, boolean> = {}
  for (const entry of nextEntries) nextVisibility[entry.id] = true
  visibility.value = nextVisibility
  loadingSiblings.value = false
}

onMounted(load)

// A save (or external change) re-parses just the opened file in place.
watch(
  () => props.modelValue,
  (content) => {
    if (loadingSiblings.value) return
    parseError.value = null
    const taken = new Set(entries.value.filter((e) => !e.isOpened).map((e) => e.id))
    const own = buildEntry(props.name, content, true, taken)
    const others = entries.value.filter((e) => !e.isOpened)
    const next = own ? [...others, own] : others
    next.sort((a, b) => a.order - b.order || a.fileName.localeCompare(b.fileName))
    entries.value = next
  }
)

// ---------------------------------------------------------------------------
// Scene + panel bindings
// ---------------------------------------------------------------------------

const appTheme = useAppTheme()
const sceneLayers = computed<GerberSceneLayer[]>(() => {
  const colors = kicadLayerColorsForTheme(appTheme.value)
  const unknown = themeColor('--vscode-canvas-layer-unknown', '#ffffff')
  return entries.value.map((entry) => ({
    id: entry.id,
    image: entry.image,
    color: (entry.kicadLayer && colors[entry.kicadLayer]) || unknown,
    opacity: entry.kicadLayer === 'Edge.Cuts' ? 1 : BASE_OPACITY
  }))
})

// Panel lists top of the stack first (KiCad convention: F.Cu at the top)
const panelLayers = computed<LayerDisplayItem[]>(() =>
  [...entries.value].reverse().map((entry) => ({ name: entry.id, title: entry.fileName }))
)

const layerPresets = computed(() =>
  buildLayerPresets(
    entries.value.map((e) => e.id),
    (key) => t(`shared.layerPresets.${key}`)
  )
)

const activeEntry = computed(() => entries.value.find((e) => e.id === activeLayerId.value) ?? null)

const toggleLayer = (layer: string): void => {
  visibility.value = { ...visibility.value, [layer]: !visibility.value[layer] }
}

const applyPreset = (map: Record<string, boolean>): void => {
  visibility.value = { ...map }
}

// Fit hotkey (a viewer, so this is its only key)
const viewportRef = ref<InstanceType<typeof GerberViewport2D> | null>(null)
const handleKeydown = (e: KeyboardEvent): void => {
  if (isTypingTarget()) return
  if (matchesHotkey(e, 'editor.fitView')) {
    e.preventDefault()
    viewportRef.value?.zoomToFit()
  }
}
useGroupKeydown(handleKeydown)

const showWarnings = ref(false)
</script>

<template>
  <div class="gerber-viewer">
    <div v-if="parseError && entries.length === 0" class="gerber-error">
      <strong>{{ t('gerberViewer.errorTitle') }}</strong>
      <span>{{ parseError }}</span>
    </div>

    <template v-else>
      <div class="viewport-host-area">
        <GerberViewport2D
          ref="viewportRef"
          :layers="sceneLayers"
          :active-layer="activeLayerId"
          :visibility="visibility"
          :non-active-display="nonActiveDisplay"
        />
        <!-- A viewer has no tools, so its view rail stands alone. -->
        <div class="canvas-floating-toolbar toolbar-left-rail rail-solo">
          <FitViewButton @fit="viewportRef?.zoomToFit()" />
          <div class="toolbar-divider"></div>
          <NonActiveDisplayButton v-model:mode="nonActiveDisplay" />
        </div>
        <div v-if="parseError" class="gerber-error-banner">
          {{ t('gerberViewer.errorTitle') }}: {{ parseError }}
        </div>
      </div>

      <Teleport v-if="showPanels" :to="panelRail" :disabled="panelsInline">
        <aside class="gerber-properties" :style="{ width: railWidth + 'px' }">
          <ResizeHandle
            edge="left"
            @resize-start="railResizeStart = railWidth"
            @resize="(grow) => setPanelWidth(railResizeStart + grow)"
            @resize-end="setPanelWidth(railWidth, true)"
          />
          <LayersPanel
            :layers="panelLayers"
            :layer-visibility="visibility"
            :active-layer="activeLayerId ?? ''"
            :presets="layerPresets"
            @toggle-layer-visibility="toggleLayer"
            @set-active-layer="(layer) => (activeLayerId = layer)"
            @apply-layer-preset="applyPreset"
          />

          <div class="panel-section">
            <h3>{{ t('gerberViewer.panel.fileTitle') }}</h3>
            <dl v-if="activeEntry">
              <dt>{{ t('gerberViewer.properties.file') }}</dt>
              <dd>{{ activeEntry.fileName }}</dd>
              <dt>{{ t('gerberViewer.properties.function') }}</dt>
              <dd>{{ activeEntry.image.fileFunction ?? '—' }}</dd>
              <dt>{{ t('gerberViewer.properties.units') }}</dt>
              <dd>{{ activeEntry.image.units === 'in' ? 'inch' : 'mm' }}</dd>
              <dt>{{ t('gerberViewer.properties.apertures') }}</dt>
              <dd>{{ activeEntry.image.apertureCount }}</dd>
              <dt>{{ t('gerberViewer.properties.objects') }}</dt>
              <dd>{{ activeEntry.image.items.length }}</dd>
            </dl>
            <p class="gerber-note">
              {{
                loadingSiblings
                  ? t('gerberViewer.loading')
                  : t('gerberViewer.layerCount', entries.length)
              }}
            </p>
          </div>

          <div v-if="fileWarnings.length > 0" class="panel-section">
            <button class="gerber-warnings-toggle" @click="showWarnings = !showWarnings">
              {{ t('gerberViewer.warningsTitle', { count: fileWarnings.length }) }}
              <Icon name="chevron-right" class="disclosure" :class="{ open: showWarnings }" />
            </button>
            <ul v-if="showWarnings" class="gerber-warnings">
              <li v-for="(warning, i) in fileWarnings" :key="i">
                <span class="gerber-warning-file">{{ warning.file }}</span>
                {{ warning.message }}
              </li>
            </ul>
          </div>

          <p class="gerber-note gerber-readonly-note">{{ t('gerberViewer.readOnlyNote') }}</p>
        </aside>
      </Teleport>
    </template>
  </div>
</template>

<style scoped>
.gerber-viewer {
  display: flex;
  flex-direction: row;
  width: 100%;
  height: 100%;
  background: var(--vscode-bg-viewport);
}

.viewport-host-area {
  flex: 1;
  min-width: 0;
  height: 100%;
  position: relative;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

/* Width inline, the rail's shared one; `relative` places the resize handle. */
.gerber-properties {
  position: relative;
  flex: none;
  overflow: auto;
  border-left: 1px solid var(--vscode-border);
  background: var(--vscode-bg-editor);
  color: var(--vscode-text);
  font-size: var(--text-body-sm);
}

.panel-section {
  padding: 12px 14px;
  border-bottom: 1px solid var(--vscode-border, #24302b);
}

.panel-section h3 {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--vscode-accent, #cca250);
  margin-bottom: 10px;
  font-weight: 700;
}

.panel-section dl {
  display: grid;
  grid-template-columns: 76px minmax(0, 1fr);
  gap: 7px 8px;
  margin: 0;
}

.panel-section dt {
  color: var(--vscode-text-muted);
}

.panel-section dd {
  margin: 0;
  overflow-wrap: anywhere;
  color: var(--vscode-text);
  font-family: var(--font-mono);
}

.gerber-note {
  margin: 10px 0 0;
  color: var(--vscode-text-muted);
  font-size: var(--text-caption);
  line-height: 1.5;
}

.gerber-readonly-note {
  padding: 12px 14px;
}

.gerber-warnings-toggle .disclosure {
  color: inherit;
}

.gerber-warnings-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--vscode-warning);
  font-size: var(--text-body-sm);
  font-weight: 600;
  cursor: pointer;
}

.gerber-warnings {
  margin: 8px 0 0;
  padding: 0 0 0 2px;
  list-style: none;
  color: var(--vscode-text-muted);
  font-size: var(--text-body-sm);
  line-height: 1.5;
}

.gerber-warnings li {
  margin-bottom: 6px;
}

.gerber-warning-file {
  display: block;
  color: var(--vscode-text);
  font-family: var(--font-mono);
}

.gerber-error {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--vscode-text-muted);
}

.gerber-error strong {
  color: var(--vscode-error);
}

.gerber-error-banner {
  position: absolute;
  left: 12px;
  bottom: 10px;
  z-index: 12;
  max-width: 60%;
  padding: 4px 8px;
  border: 1px solid var(--vscode-error);
  border-radius: 3px;
  background: var(--vscode-overlay);
  color: var(--vscode-error);
  font-size: var(--text-body-sm);
}
</style>
