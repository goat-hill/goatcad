<script lang="ts">
import { ref as moduleRef } from 'vue'

// The view's splits, as shares of its height in the library chooser's ratios — the part over
// its details over its two associations, 3 : 1 : 2 — kept for the session.
const detailsShare = moduleRef(1 / 6)
const bottomShare = moduleRef(1 / 3)
</script>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { parseComponentTab } from '../lib/tabs'
import ComponentSlot from './ComponentSlot.vue'
import PartDetails from './shared/PartDetails.vue'
import PaneSplit from './shared/PaneSplit.vue'
import { percent, shareAfter } from '../lib/paneShares'
import { datasheetUrl } from '../lib/schematic/datasheet'
import {
  footprintsForSymbol,
  modelsForFootprint,
  openTargetFor,
  symbolsForFootprint
} from '../lib/componentAssociations'
import {
  loadIndex,
  indexLoaded,
  findSymbol,
  findFootprint,
  findModelByRef,
  footprintsUsingModel,
  type IndexRecord,
  type SymbolRecord,
  type FootprintRecord,
  type ModelRecord
} from '../lib/libraryIndex'

/**
 * Component view (see docs/libraries-workstream.md) —
 * a read-only main-editor tab. Top half renders the item you opened; the bottom
 * half is a split of its two associated primitive types, each in the real
 * read-only renderer with a breadcrumb + a "1/N" picker for many-to-one
 * associations. All resolution is from the library index.
 */
const props = defineProps<{ tabPath: string | null }>()
const emit = defineEmits<{
  (e: 'open-file', node: { name: string; path: string }): void
  (e: 'open-library-symbol', path: string, symbol: string): void
}>()
const { t } = useI18n()

// A pane's "Open" button: open the record in its full editor tab, read-only so
// nothing writes back to the source library (the save-where flow is a follow-up).
const openRecord = (r: IndexRecord): void => {
  const target = openTargetFor(r)
  if (target.kind === 'library-symbol') emit('open-library-symbol', target.file, target.name)
  else emit('open-file', target.node)
}

const parsed = computed(() => (props.tabPath ? parseComponentTab(props.tabPath) : null))
const kind = computed(() => parsed.value?.kind ?? null)

// Re-resolve once the index is available. (Declare the selection refs BEFORE the
// immediate watch — it runs synchronously during setup and touches them.)
const indexTick = ref(0)
const ready = ref(indexLoaded())
const selSymbol = ref(0)
const selFootprint = ref(0)
const selModel = ref(0)
watch(
  () => props.tabPath,
  () => {
    selSymbol.value = 0
    selFootprint.value = 0
    selModel.value = 0
    void loadIndex().then(() => {
      ready.value = true
      indexTick.value++
    })
  },
  { immediate: true }
)

// --- candidate resolution per primitive type ---
const symbolCandidates = computed<SymbolRecord[]>(() => {
  void indexTick.value
  const p = parsed.value
  if (!p) return []
  if (p.kind === 'symbol') {
    const s = findSymbol(`${p.segments[0]}:${p.segments[1]}`)
    return s ? [s] : []
  }
  if (p.kind === 'footprint') {
    const fp = findFootprint(`${p.segments[0]}:${p.segments[1]}`)
    return fp ? symbolsForFootprint(fp) : []
  }
  // model → symbols compatible with the selected footprint (the one whose 3D is
  // shown), keeping the three slots coherent as the footprint picker changes.
  const fp = footprintCandidates.value[selFootprint.value] ?? footprintCandidates.value[0]
  return fp ? symbolsForFootprint(fp) : []
})

const footprintCandidates = computed<FootprintRecord[]>(() => {
  void indexTick.value
  const p = parsed.value
  if (!p) return []
  if (p.kind === 'symbol') {
    const s = findSymbol(`${p.segments[0]}:${p.segments[1]}`)
    return s ? footprintsForSymbol(s) : []
  }
  if (p.kind === 'footprint') {
    const fp = findFootprint(`${p.segments[0]}:${p.segments[1]}`)
    return fp ? [fp] : []
  }
  return footprintsUsingModel(p.segments[0])
})

const modelCandidates = computed<ModelRecord[]>(() => {
  void indexTick.value
  const p = parsed.value
  if (!p) return []
  if (p.kind === 'model') {
    const m = findModelByRef(p.segments[0])
    return m ? [m] : []
  }
  // All models the currently-selected footprint's refs resolve to (the ✕ picker
  // in ComponentSlot handles more than one). Not fp.models[0]: the first raw ref
  // may be a dead package while a later one resolves.
  const fp = footprintCandidates.value[selFootprint.value] ?? footprintCandidates.value[0]
  return fp ? modelsForFootprint(fp.id) : []
})

// --- the shown part's details, and the splits ---

/** The primary record as its pane shows it, for the details under it. */
const primary = computed<IndexRecord | null>(() => {
  if (kind.value === 'symbol') return symbolCandidates.value[selSymbol.value] ?? null
  if (kind.value === 'footprint') return footprintCandidates.value[selFootprint.value] ?? null
  return modelCandidates.value[selModel.value] ?? null
})

const primaryDetails = computed(() => {
  const r = primary.value
  if (!r) return null
  const scope =
    r.scope === 'project'
      ? t('componentView.scope.project')
      : r.scope === 'global'
        ? t('componentView.scope.global')
        : t('componentView.scope.system')
  return {
    id: r.id,
    description: r.type === 'model' ? r.file : r.description,
    keywords: r.type === 'symbol' ? r.keywords : r.type === 'footprint' ? r.tags : '',
    source: scope,
    datasheet: r.type === 'symbol' ? datasheetUrl(r.datasheet) : null
  }
})

const PRIMARY_MIN = 120
const DETAILS_MIN = 56
const BOTTOM_MIN = 120

const view = ref<HTMLElement | null>(null)
let detailsStart = 0
let bottomStart = 0

const resizeDetails = (grow: number): void => {
  const size = view.value?.clientHeight ?? 0
  detailsShare.value = shareAfter(
    detailsStart,
    grow,
    size,
    DETAILS_MIN,
    PRIMARY_MIN + bottomShare.value * size
  )
}

const resizeBottom = (grow: number): void => {
  const size = view.value?.clientHeight ?? 0
  bottomShare.value = shareAfter(
    bottomStart,
    grow,
    size,
    BOTTOM_MIN,
    PRIMARY_MIN + detailsShare.value * size
  )
}
</script>

<template>
  <div ref="view" class="component-view">
    <div v-if="!kind" class="cv-msg">{{ t('componentView.notFound') }}</div>
    <div v-else-if="!ready" class="cv-msg">{{ t('componentView.indexLoading') }}</div>
    <template v-else>
      <!-- TOP: the primary item -->
      <div class="top">
        <ComponentSlot
          v-if="kind === 'symbol'"
          v-model:selected="selSymbol"
          type="symbol"
          :records="symbolCandidates"
          primary
          @open="openRecord"
        />
        <ComponentSlot
          v-else-if="kind === 'footprint'"
          v-model:selected="selFootprint"
          type="footprint"
          :records="footprintCandidates"
          primary
          @open="openRecord"
        />
        <ComponentSlot
          v-else
          v-model:selected="selModel"
          type="model"
          :records="modelCandidates"
          primary
          @open="openRecord"
        />
      </div>

      <PaneSplit
        axis="y"
        grows="after"
        @resize-start="detailsStart = detailsShare"
        @resize="resizeDetails"
      />
      <!-- MIDDLE: what the shown part is -->
      <div class="details" :style="{ height: percent(detailsShare) }">
        <PartDetails v-if="primaryDetails" v-bind="primaryDetails" />
      </div>
      <PaneSplit
        axis="y"
        grows="after"
        @resize-start="bottomStart = bottomShare"
        @resize="resizeBottom"
      />
      <!-- BOTTOM: the two associated types -->
      <div class="bottom" :style="{ height: percent(bottomShare) }">
        <template v-if="kind === 'symbol'">
          <ComponentSlot
            v-model:selected="selFootprint"
            type="footprint"
            :records="footprintCandidates"
            @open="openRecord"
          />
          <ComponentSlot
            v-model:selected="selModel"
            type="model"
            :records="modelCandidates"
            @open="openRecord"
          />
        </template>
        <template v-else-if="kind === 'footprint'">
          <ComponentSlot
            v-model:selected="selSymbol"
            type="symbol"
            :records="symbolCandidates"
            @open="openRecord"
          />
          <ComponentSlot
            v-model:selected="selModel"
            type="model"
            :records="modelCandidates"
            @open="openRecord"
          />
        </template>
        <template v-else>
          <ComponentSlot
            v-model:selected="selFootprint"
            type="footprint"
            :records="footprintCandidates"
            @open="openRecord"
          />
          <ComponentSlot
            v-model:selected="selSymbol"
            type="symbol"
            :records="symbolCandidates"
            @open="openRecord"
          />
        </template>
      </div>
    </template>
  </div>
</template>

<style scoped>
.component-view {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--vscode-bg, #151c19);
  color: var(--vscode-text, #d8e0dc);
  font-family:
    system-ui,
    -apple-system,
    BlinkMacSystemFont,
    'Segoe UI',
    Roboto,
    sans-serif;
}

.cv-msg {
  margin: auto;
  color: var(--vscode-text-muted, #858585);
  font-size: 13px;
}

.top {
  flex: 1;
  min-height: 0;
  display: flex;
}

.details {
  flex-shrink: 0;
  min-height: 0;
}

.top > * {
  flex: 1;
  min-width: 0;
}

.bottom {
  flex-shrink: 0;
  min-height: 0;
  display: flex;
}

.bottom > * {
  flex: 1;
  min-width: 0;
  border-right: 1px solid var(--vscode-border, #24302b);
}

.bottom > *:last-child {
  border-right: none;
}
</style>
