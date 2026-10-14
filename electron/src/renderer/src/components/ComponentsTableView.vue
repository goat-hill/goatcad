<script setup lang="ts">
/**
 * The Components tab (`goatcad://components/<root sheet>`): every part of one
 * design, across all of its sheets, as an editable table — KiCad's Symbol Fields
 * Table as a full surface rather than a panel under one sheet.
 *
 * It draws nothing of its own. It reads and edits through the ROOT sheet's
 * session (`lib/schematic/sheetSession.ts`), which already resolves the whole
 * hierarchy and rewrites sibling sheets as one undoable command, so an edit here
 * lands on the sheets' tabs exactly as the same edit made from a sheet does.
 */
import { computed, inject, onUnmounted, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  findProjectFile,
  readProjectBomSettings,
  writeProjectBomSettings,
  type BomSettings
} from '../lib/kicad/project'
import {
  buildProjectComponentRecords,
  collectCustomFieldNames,
  defaultBomSettings,
  reconcileBomSettings,
  type ComponentRecord,
  type FlagKey
} from '../lib/componentsTable'
import { FLAG_TOKENS, fieldEdits, flagEdits } from '../lib/schematic/componentEdits'
import { openSheetsVersion } from '../lib/schematic/openSheets'
import type { SheetSession } from '../lib/schematic/sheetSession'
import { EDITOR_WORKSPACE, useEditorGroup, useGroupKeydown } from '../lib/editorWorkspace'
import { emitCrossProbe } from '../lib/crossProbe'
import { isTypingTarget, matchesHotkey } from '../lib/hotkeys'
import { basenameOf } from '../lib/kicad/paths'
import ComponentsTable from './shared/ComponentsTable.vue'
import Icon from './shared/Icon.vue'
import LibraryChooser from './shared/LibraryChooser.vue'
import { commandTitle } from '../lib/libraryChooser'
import {
  getLibSymbolProperty,
  libSymbolChain,
  type KicadSchematic,
  type KicadSchematicSymbol
} from '../lib/kicad/schematic'
import { libSymbolPins } from '../lib/libraryLoad'
import { openTargetFor } from '../lib/componentAssociations'
import type { IndexRecord } from '../lib/libraryIndex'
import type { PinRef } from '../lib/pinPadMatch'

const props = defineProps<{
  /** The design's root `.kicad_sch`, decoded from the tab path. */
  rootPath: string
}>()

const emit = defineEmits<{
  /** Go to a part: open its sheet here and reveal the symbol. */
  (e: 'open-symbol', path: string, uuid: string): void
  /** The chooser's Open: a library symbol in the symbol library viewer. */
  (e: 'open-library-symbol', path: string, symbol: string): void
  /** The chooser's Open: a footprint or model in its own tab. */
  (e: 'open-file', node: { name: string; path: string }): void
}>()

const { t } = useI18n()
const { groupId } = useEditorGroup()
const workspace = inject(EDITOR_WORKSPACE)

const session = shallowRef<SheetSession | null>(null)
const failed = ref(false)
const revision = ref(0)
let stopSession: (() => void) | null = null

const attach = async (): Promise<void> => {
  stopSession?.()
  session.value = null
  failed.value = false
  const opened = (await workspace?.openSheetSession(props.rootPath)) ?? null
  if (!opened) {
    failed.value = true
    return
  }
  await opened.ready()
  stopSession = opened.subscribe(() => revision.value++)
  session.value = opened
}
watch(() => props.rootPath, attach, { immediate: true })
onUnmounted(() => stopSession?.())

const records = computed<ComponentRecord[]>(() => {
  void revision.value
  void openSheetsVersion.value
  return session.value ? buildProjectComponentRecords(session.value.sheetSources()) : []
})
const recordsById = computed(() => new Map(records.value.map((record) => [record.id, record])))
const recordsFor = (ids: string[]): ComponentRecord[] =>
  ids.flatMap((id) => recordsById.value.get(id) ?? [])

// ---- selection --------------------------------------------------------------

const selectedIds = ref<string[]>([])
watch(records, () => {
  selectedIds.value = selectedIds.value.filter((id) => recordsById.value.has(id))
})

const symbolOf = (record: ComponentRecord): { path: string; uuid: string } | null => {
  const location = record.locations[0]
  if (!location || !session.value) return null
  const sheet = session.value
    .sheetSources()
    .find((source) => source.filePath === location.filePath)?.schematic
  const uuid = sheet?.symbols[location.symbolIndex]?.uuid
  return uuid ? { path: location.filePath, uuid } : null
}

/** Selecting rows selects the parts in a schematic and a board beside this tab,
 *  in the other pane or another window (lib/crossProbe.ts). */
const onSelect = (ids: string[]): void => {
  selectedIds.value = ids
  const targets = recordsFor(ids).flatMap((record) => {
    const symbol = symbolOf(record)
    return symbol
      ? [{ symbolUuid: symbol.uuid, sheetFile: symbol.path, reference: record.reference }]
      : []
  })
  emitCrossProbe('components', targets, groupId)
}

const firstSelected = computed(() => {
  const record = recordsFor(selectedIds.value)[0]
  return record ? symbolOf(record) : null
})

const showInSchematic = (): void => {
  if (firstSelected.value) emit('open-symbol', firstSelected.value.path, firstSelected.value.uuid)
}

// ---- edits ------------------------------------------------------------------

const onEditField = (ids: string[], field: string, value: string): void => {
  const label =
    ids.length > 1
      ? t('schematicEditor.commands.editFieldMultiple', { field, count: ids.length })
      : t('schematicEditor.commands.editField', { field })
  session.value?.applySymbolEdits(label, fieldEdits(recordsFor(ids), field, value))
}

// ---- footprint chooser (docs/libraries-workstream.md) -------------------

const footprintChooser = ref<{
  ids: string[]
  target: string
  /** The lone part's reference and value, shown on the footprint previews. */
  fields: { reference?: string; value?: string }
  initial: string
  fit: { filters: string[]; pins: PinRef[] } | null
} | null>(null)

/** A record's first placed symbol and the sheet that carries its definition. */
const placedSymbol = (
  record: ComponentRecord
): { symbol: KicadSchematicSymbol; sheet: KicadSchematic } | null => {
  const location = record.locations[0]
  const sheet = session.value
    ?.sheetSources()
    .find((source) => source.filePath === location?.filePath)?.schematic
  const symbol = location ? sheet?.symbols[location.symbolIndex] : undefined
  return sheet && symbol ? { symbol, sheet } : null
}

/** Choose a footprint for these rows, fitted to their symbol when they share one. */
const onBrowseFootprint = (ids: string[]): void => {
  const chosen = recordsFor(ids)
  if (!chosen.length) return
  const placed = chosen.map(placedSymbol)
  const libIds = new Set(placed.map((entry) => entry?.symbol.libId))
  const first = placed[0]
  const definition =
    libIds.size === 1 && first ? first.sheet.libSymbols.get(first.symbol.libId) : undefined
  const chain =
    definition && first
      ? libSymbolChain(definition, (name) => first.sheet.libSymbols.get(name))
      : null
  const footprints = new Set(chosen.map((record) => record.fields.Footprint ?? ''))
  footprintChooser.value = {
    ids,
    fields:
      chosen.length === 1 ? { reference: chosen[0].reference, value: chosen[0].fields.Value } : {},
    target:
      chosen.length === 1
        ? `${chosen[0].reference} · ${chosen[0].fields.Value ?? ''}`
        : t('schematicEditor.footprintChooser.parts', { n: chosen.length }),
    initial: footprints.size === 1 ? [...footprints][0] : '',
    fit: chain
      ? {
          filters: (definition ? (getLibSymbolProperty(definition, 'ki_fp_filters') ?? '') : '')
            .split(/\s+/)
            .filter(Boolean),
          pins: libSymbolPins(chain)
        }
      : null
  }
}

/** A chooser pane's Open: the chooser goes, and the part opens read-only in its own tab. */
const openFromChooser = (record: IndexRecord): void => {
  footprintChooser.value = null
  const target = openTargetFor(record)
  if (target.kind === 'library-symbol') emit('open-library-symbol', target.file, target.name)
  else emit('open-file', target.node)
}

const onFootprintPick = (libId: string): void => {
  const chooser = footprintChooser.value
  footprintChooser.value = null
  if (chooser) onEditField(chooser.ids, 'Footprint', libId)
}

/** Footprints the design's parts already name. */
const designFootprints = computed(() => [
  ...new Set(
    records.value
      .map((record) => record.fields.Footprint?.trim())
      .filter((id): id is string => !!id)
  )
])

const onEditFlag = (ids: string[], flag: FlagKey, value: boolean): void => {
  const { token } = FLAG_TOKENS[flag]
  const label =
    ids.length > 1
      ? t('schematicEditor.commands.editFlagMultiple', { token, count: ids.length })
      : t('schematicEditor.commands.editFlag', { token })
  session.value?.applySymbolEdits(label, flagEdits(recordsFor(ids), flag, value))
}

useGroupKeydown((event) => {
  if (isTypingTarget() || !session.value) return
  if (matchesHotkey(event, 'editor.undo')) {
    event.preventDefault()
    session.value.undo()
  } else if (matchesHotkey(event, 'editor.redo')) {
    event.preventDefault()
    session.value.redo()
  }
})

// ---- table presets ------------------------------------------------------------
// Columns, grouping and sort live in the sibling .kicad_pro when there is one
// (KiCad behavior); a design with no project keeps them for the tab's life.

const bomSettings = ref<BomSettings>(defaultBomSettings([]))
let projectFile: string | null = null
let persistTimer: ReturnType<typeof setTimeout> | undefined
let settingsDirty = false

const persistSettings = (): void => {
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = undefined
  if (!projectFile || !settingsDirty) return
  settingsDirty = false
  void writeProjectBomSettings(projectFile, bomSettings.value)
}

watch(records, (current) => {
  bomSettings.value = reconcileBomSettings(bomSettings.value, collectCustomFieldNames(current))
})

watch(
  () => props.rootPath,
  async (rootPath) => {
    projectFile = await findProjectFile(rootPath)
    const saved = projectFile ? await readProjectBomSettings(projectFile) : null
    const customFields = collectCustomFieldNames(records.value)
    bomSettings.value = reconcileBomSettings(
      saved ?? defaultBomSettings(customFields),
      customFields
    )
  },
  { immediate: true }
)

// A tab has no save of its own, so a preset change is written shortly after it
// is made rather than waiting for one.
const onSettingsChange = (settings: BomSettings): void => {
  bomSettings.value = settings
  settingsDirty = true
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(persistSettings, 800)
}
onUnmounted(persistSettings)
</script>

<template>
  <div class="components-view">
    <header class="components-header">
      <h1 class="components-title">{{ t('schematicEditor.componentsPanel.title') }}</h1>
      <div class="components-meta">
        <span class="components-meta-label">{{ t('schematicEditor.componentsPanel.design') }}</span>
        <span class="components-design">{{ basenameOf(rootPath) }}</span>
      </div>
      <span v-if="session" class="components-count">
        {{ t('schematicEditor.componentsPanel.count', records.length) }}
      </span>
      <div class="components-actions">
        <button class="btn-outline btn-md" :disabled="!firstSelected" @click="showInSchematic">
          <Icon name="components-table" />
          {{ t('schematicEditor.componentsPanel.showInSchematic') }}
        </button>
      </div>
    </header>

    <div v-if="failed" class="components-empty">
      {{ t('schematicEditor.componentsPanel.unreadable') }}
    </div>
    <div v-else-if="!session" class="components-empty">
      {{ t('schematicEditor.componentsPanel.loading') }}
    </div>
    <div v-else class="components-body">
      <ComponentsTable
        :records="records"
        :settings="bomSettings"
        :selected-ids="selectedIds"
        @update:settings="onSettingsChange"
        @select="onSelect"
        @edit-field="onEditField"
        @edit-flag="onEditFlag"
        @browse-footprint="onBrowseFootprint"
      />
    </div>
    <LibraryChooser
      v-if="footprintChooser"
      kind="footprint"
      icon="tool-footprint"
      :title="commandTitle(t('shared.properties.browseFootprint'))"
      :verb="
        footprintChooser.ids.length > 1
          ? t('shared.libraryChooser.assignMany', { n: footprintChooser.ids.length })
          : t('shared.libraryChooser.assign')
      "
      :target="footprintChooser.target"
      :initial-id="footprintChooser.initial"
      :fit="footprintChooser.fit"
      :fields-for="() => footprintChooser?.fields ?? {}"
      :in-design="designFootprints"
      @pick="onFootprintPick"
      @close="footprintChooser = null"
      @open="openFromChooser"
    />
  </div>
</template>

<style scoped>
.components-view {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-height: 0;
  background-color: var(--vscode-bg-editor);
  color: var(--vscode-text);
}

.components-header {
  display: flex;
  flex-wrap: wrap;
  gap: 24px;
  align-items: flex-end;
  padding: 16px 20px;
  border-bottom: 1px solid var(--vscode-border);
}

.components-title {
  align-self: center;
  margin: 0;
  font-size: var(--text-heading);
  font-weight: 600;
  color: var(--vscode-text-light);
}

.components-meta {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.components-meta-label {
  font-size: var(--text-caption);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--vscode-text-muted);
}

.components-design {
  padding: 6px 0;
  font-family: var(--font-mono);
  font-size: var(--text-body);
}

.components-count {
  padding: 6px 0;
  font-size: var(--text-body);
  color: var(--vscode-text-muted);
}

.components-actions {
  margin-left: auto;
}

.components-actions :deep(svg) {
  width: 15px;
  height: 15px;
  fill: currentColor;
}

.components-body {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.components-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--text-body);
  color: var(--vscode-text-muted);
}
</style>
