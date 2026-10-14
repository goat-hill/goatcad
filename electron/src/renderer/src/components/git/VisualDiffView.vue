<script setup lang="ts">
/**
 * The visual diff of a schematic, a board, or one symbol out of a library: the
 * drawing with only the changes in color — added, moved and changed items in
 * their own colors, everything else dimmed. `version` picks what is drawn:
 * Diff (the new version with the removed items drawn back in red), After or
 * Before (one version alone).
 *
 * Presentational: the diff tab loads and parses both versions and hands them
 * in. A schematic or board pairs by uuid (`diffSchematics`, `diffBoards`); a
 * symbol pairs its parts by content (`symbolDiffView`).
 *
 * The right rail holds the editor's properties table, read-only, built from
 * each version and merged (`diffPropertyGroups`): a click on a schematic or
 * board item shows its rows, nothing picked shows the sheet's, the board's or
 * the symbol's. A symbol's parts pair by content, so a changed part has no
 * counterpart to compare with, and the symbol's canvas picks nothing.
 */
import { computed, defineAsyncComponent, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import SchematicViewport2D from '../schematic/SchematicViewport2D.vue'
import FitViewButton from '../shared/FitViewButton.vue'
import Icon from '../shared/Icon.vue'
import CollapsiblePanel from '../shared/CollapsiblePanel.vue'
import PropertyTable from '../shared/PropertyTable.vue'
import ResizeHandle from '../shared/ResizeHandle.vue'
import { schematicViewState, setSchematicView } from '../../lib/schematicView'
import type { KicadBoard } from '../../lib/kicad/board'
import type { KicadSchematic } from '../../lib/kicad/schematic'
import type { KicadSymbolLibrary } from '../../lib/kicad/symbolLibrary'
import { diffSchematics, withRemovedItems } from '../../lib/git/schematicDiff'
import { diffBoards, withRemovedBoardItems } from '../../lib/git/boardDiff'
import { symbolDiffView } from '../../lib/git/symbolLibraryDiff'
import type { DiffVersion } from '../../lib/git/diffPreferences'
import type { SchematicDiffPaint, SchematicItemRef } from '../../lib/engine/SchematicScene'
import type { BoardDiffPaint, BoardItemRef } from '../../lib/engine/BoardScene'
import type { GridSettings } from '../../lib/engine/ViewportEngine'
import { SCHEMATIC_GRID_DEFAULTS, useGridSettings } from '../../lib/gridPreferences'
import type { PropertyGroup } from '../../lib/propertyTable'
import { diffPropertyGroups } from '../../lib/git/propertyDiff'
import {
  boardPickKey,
  keyIndex,
  pickedSides,
  schematicPickKey,
  type PickedSides
} from '../../lib/git/diffPick'
import { buildSchematicGroups } from '../../lib/schematic/schematicPropertySchema'
import { boardOptions, buildBoardGroups } from '../../lib/board/pcbPropertySchema'
import { buildSymbolGroups } from '../../lib/symbol/symbolPropertySchema'
import { kicadLayerColorsForTheme, useAppTheme } from '../../lib/theme'
import { useContextPanels } from '../../lib/editorWorkspace'
import { panelWidth, setPanelWidth } from '../../lib/panelLayout'

const BoardDiffViewport = defineAsyncComponent(() => import('./BoardDiffViewport.vue'))

/** Both versions, parsed; null for a side the file (or symbol) does not exist on. */
export type VisualDiffModel =
  | { kind: 'schematic'; before: KicadSchematic | null; after: KicadSchematic | null }
  | { kind: 'board'; before: KicadBoard | null; after: KicadBoard | null }
  | {
      kind: 'symbol'
      before: KicadSymbolLibrary | null
      after: KicadSymbolLibrary | null
      symbol: string
      unit: number
    }

const { t } = useI18n()

const props = defineProps<{
  model: VisualDiffModel
  version: DiffVersion
  /** Bumped when the versions are re-read, so the viewport rebuilds. */
  revision: number
  /** The file, repo-relative: the sheet's File row. */
  filePath: string
}>()

/** Whether anything changed at all, which tells "nothing here" from "nothing on this side". */
const hasChanges = computed((): boolean => {
  const m = props.model
  if (m.kind === 'symbol')
    return symbolDiffView(m.before, m.after, m.symbol, 'diff', m.unit) !== null
  if (m.kind === 'board') return boardChanges.value.length > 0
  return diffSchematics(m.before, m.after).changes.length > 0
})

const boardChanges = computed(() =>
  props.model.kind === 'board' ? diffBoards(props.model.before, props.model.after).changes : []
)

const schematicChanges = computed(() =>
  props.model.kind === 'schematic'
    ? diffSchematics(props.model.before, props.model.after).changes
    : []
)

/** Removed items' keys in Diff's drawing, by change id. */
const removedBoardKeys = computed(() =>
  props.model.kind === 'board'
    ? withRemovedBoardItems(props.model.after, props.model.before, boardChanges.value).removedKeys
    : new Map<string, string>()
)
const removedSchematicKeys = computed(() =>
  props.model.kind === 'schematic'
    ? withRemovedItems(props.model.after, props.model.before, schematicChanges.value).removedKeys
    : new Map<string, string>()
)

/** The board's counterpart of `view`, drawn by `BoardDiffViewport`. */
const boardView = computed((): { board: KicadBoard; paint: BoardDiffPaint } | null => {
  const m = props.model
  if (m.kind !== 'board') return null
  const changes = boardChanges.value
  if (changes.length === 0) return null
  const changed = new Set<string>()
  const removed = new Set<string>()
  if (props.version !== 'diff') {
    const board = props.version === 'before' ? m.before : m.after
    if (!board) return null
    for (const change of changes) {
      const key = props.version === 'before' ? change.beforeKey : change.afterKey
      if (key) changed.add(key)
    }
    return { board, paint: { changed, removed } }
  }
  const combined = withRemovedBoardItems(m.after, m.before, changes)
  if (!combined.board) return null
  for (const change of changes) {
    if (change.kind === 'removed') {
      const key = removedBoardKeys.value.get(change.id)
      if (key) removed.add(key)
    } else if (change.afterKey) {
      changed.add(change.afterKey)
    }
  }
  return { board: combined.board, paint: { changed, removed } }
})

/**
 * What is drawn and how it is painted, or null when there is nothing to draw.
 * In every version what changed keeps its colors and everything else is
 * dimmed; red is Diff's alone.
 */
const view = computed((): { doc: KicadSchematic | null; paint: SchematicDiffPaint } | null => {
  const m = props.model
  if (m.kind === 'symbol') return symbolDiffView(m.before, m.after, m.symbol, props.version, m.unit)
  if (m.kind === 'board') return null
  const changes = schematicChanges.value
  if (changes.length === 0) return null
  const changed = new Set<string>()
  const removed = new Set<string>()
  if (props.version === 'before') {
    if (!m.before) return null
    for (const change of changes) if (change.beforeKey) changed.add(change.beforeKey)
    return { doc: m.before, paint: { changed, removed } }
  }
  if (props.version === 'after') {
    if (!m.after) return null
    for (const change of changes) if (change.afterKey) changed.add(change.afterKey)
    return { doc: m.after, paint: { changed, removed } }
  }
  const combined = withRemovedItems(m.after, m.before, changes)
  for (const change of changes) {
    if (change.kind === 'removed') {
      const key = removedSchematicKeys.value.get(change.id)
      if (key) removed.add(key)
    } else if (change.afterKey) {
      changed.add(change.afterKey)
    }
  }
  return { doc: combined.doc, paint: { changed, removed } }
})

const viewport = ref<InstanceType<typeof SchematicViewport2D> | null>(null)
/**
 * The schematic editor's own hidden-pin and hidden-field switches, app-wide.
 * Net highlight is left out: a diff computes no connectivity to light.
 */
const schematicView = schematicViewState()

// ---- Properties ------------------------------------------------------------

/** The item picked on the canvas, as the drawing indexes it. A new drawing drops it. */
const schematicPick = ref<SchematicItemRef[]>([])
const boardPick = ref<BoardItemRef[]>([])
watch([() => props.model, () => props.version, () => props.revision], () => {
  schematicPick.value = []
  boardPick.value = []
})

/** Where the picked item is in each version; for one no change names, the version drawn. */
const sidesOf = (key: string, found: PickedSides | null): PickedSides =>
  found ??
  (props.version === 'before' ? { before: key, after: null } : { before: null, after: key })

/** The table's rows from each version, merged; one version alone when the pick is unchanged. */
const merged = (
  sides: PickedSides,
  found: boolean,
  build: (version: 'before' | 'after', key: string | null) => PropertyGroup[]
): PropertyGroup[] => {
  const before = build('before', sides.before)
  const after = build('after', sides.after)
  if (!found) return sides.before ? before : after
  return diffPropertyGroups(before, after)
}

const schematicGrid = useGridSettings('schematic', SCHEMATIC_GRID_DEFAULTS)
/** The schematic editor's grid and unit, unsnapped: the readout says where the pointer is. */
const grid = computed((): GridSettings => ({ ...schematicGrid.value, visible: true, snap: false }))
const appTheme = useAppTheme()

const schematicGroups = computed((): PropertyGroup[] => {
  const m = props.model
  if (m.kind !== 'schematic') return []
  const pick = schematicPick.value[0]
  const build = (doc: KicadSchematic | null, picked: SchematicItemRef[]): PropertyGroup[] =>
    doc
      ? buildSchematicGroups(picked, t, {
          symbols: doc.symbols,
          labels: doc.labels,
          wires: doc.wires,
          junctions: doc.junctions,
          noConnects: doc.noConnects,
          netName: null,
          document: doc,
          ...(picked.length
            ? {}
            : {
                screen: {
                  filePath: props.filePath,
                  document: doc,
                  root: false,
                  designPages: [],
                  project: ''
                }
              })
        })
      : []
  if (!pick) return diffPropertyGroups(build(m.before, []), build(m.after, []))
  const key = schematicPickKey(pick)
  const found = pickedSides(schematicChanges.value, removedSchematicKeys.value, props.version, key)
  return merged(sidesOf(key, found), !!found, (version, sideKey) =>
    sideKey ? build(m[version], [{ ...pick, index: keyIndex(sideKey) }]) : []
  )
})

const boardGroups = computed((): PropertyGroup[] => {
  const m = props.model
  if (m.kind !== 'board') return []
  const colors = kicadLayerColorsForTheme(appTheme.value)
  const pick = boardPick.value[0]
  const build = (board: KicadBoard | null, picked: BoardItemRef[]): PropertyGroup[] =>
    buildBoardGroups(board, picked, t, boardOptions(board, colors))
  if (!pick) return diffPropertyGroups(build(m.before, []), build(m.after, []))
  const key = boardPickKey(pick)
  const found = pickedSides(boardChanges.value, removedBoardKeys.value, props.version, key)
  return merged(sidesOf(key, found), !!found, (version, sideKey) =>
    sideKey ? build(m[version], [{ ...pick, index: keyIndex(sideKey) }]) : []
  )
})

/** A symbol's own rows: its name, flags and fields, in each version. */
const symbolGroups = computed((): PropertyGroup[] => {
  const m = props.model
  if (m.kind !== 'symbol') return []
  const of = (library: KicadSymbolLibrary | null): PropertyGroup[] =>
    buildSymbolGroups(library?.symbols.get(m.symbol) ?? null, [], t, { unit: m.unit })
  return diffPropertyGroups(of(m.before), of(m.after))
})

const { show: showPanels, inline: panelsInline, rail: panelRail } = useContextPanels()
const railWidth = panelWidth()
let railResizeStart = 0
</script>

<template>
  <div class="visual-diff">
    <p v-if="!hasChanges" class="visual-diff-message">
      {{ t('git.visual.noChanges') }}
    </p>
    <template v-else-if="model.kind === 'board'">
      <BoardDiffViewport
        v-if="boardView"
        v-model:selected-items="boardPick"
        :board="boardView.board"
        :paint="boardView.paint"
        :revision="revision"
        :groups="boardGroups"
      />
      <p v-else class="visual-diff-message">
        {{ t('git.visual.nothingOnSide') }}
      </p>
    </template>
    <p v-else-if="!view" class="visual-diff-message">
      {{ t('git.visual.nothingOnSide') }}
    </p>
    <template v-else-if="view.doc">
      <SchematicViewport2D
        ref="viewport"
        :schematic="view.doc"
        :revision="revision"
        :selected-items="schematicPick"
        :grid-settings="grid"
        :connectivity="null"
        :show-hidden-pins="schematicView.showHiddenPins"
        :show-hidden-fields="schematicView.showHiddenFields"
        sheet-path="/"
        active-tool="select"
        :wire-draft="[]"
        wire-posture="hv"
        :placement="null"
        :diff-paint="view.paint"
        preview
        :pickable="model.kind === 'schematic'"
        @update:selected-items="(items: SchematicItemRef[]) => (schematicPick = items)"
      />
      <!-- The schematic editor's view rail, less net highlight. -->
      <div class="canvas-floating-toolbar toolbar-left-rail rail-solo">
        <FitViewButton @fit="viewport?.zoomToFit()" />
        <div class="toolbar-divider"></div>
        <button
          class="floating-btn tool-btn toggle-btn"
          :class="{ active: schematicView.showHiddenPins }"
          :title="t('schematicEditor.viewRail.showHiddenPins')"
          @click="setSchematicView({ showHiddenPins: !schematicView.showHiddenPins })"
        >
          <Icon name="view-hidden-pins" />
        </button>
        <button
          class="floating-btn tool-btn toggle-btn"
          :class="{ active: schematicView.showHiddenFields }"
          :title="t('schematicEditor.viewRail.showHiddenFields')"
          @click="setSchematicView({ showHiddenFields: !schematicView.showHiddenFields })"
        >
          <Icon name="view-hidden-fields" />
        </button>
      </div>

      <Teleport v-if="showPanels" :to="panelRail" :disabled="panelsInline">
        <aside class="visual-diff-panel" :style="{ width: railWidth + 'px' }">
          <ResizeHandle
            edge="left"
            @resize-start="railResizeStart = railWidth"
            @resize="(grow: number) => setPanelWidth(railResizeStart + grow)"
            @resize-end="setPanelWidth(railWidth, true)"
          />
          <CollapsiblePanel :title="t('shared.propertiesPanel.title')" flex>
            <PropertyTable
              review
              :groups="model.kind === 'symbol' ? symbolGroups : schematicGroups"
              :distance-unit="schematicGrid.unit"
            />
          </CollapsiblePanel>
        </aside>
      </Teleport>
    </template>
  </div>
</template>

<style scoped>
.visual-diff {
  flex: 1;
  min-height: 0;
  position: relative;
  display: flex;
}

/* The rail as the board diff (BoardDiffViewport) draws it. */
.visual-diff-panel {
  position: relative;
  flex: none;
  height: 100%;
  display: flex;
  flex-direction: column;
  border-left: 1px solid var(--vscode-border);
  background: var(--vscode-bg-sidebar);
  color: var(--vscode-text);
  font-size: var(--text-body-sm);
}

.visual-diff-message {
  margin: 0;
  padding: 24px;
  text-align: center;
  color: var(--vscode-text-muted);
  font-size: var(--text-body);
  flex: 1;
}
</style>
