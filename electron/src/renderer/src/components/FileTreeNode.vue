<script setup lang="ts">
import { computed, inject, nextTick, ref, watch } from 'vue'
import { isOpenableFile } from '../lib/fileTypes'
import type { TreeSelection } from '../lib/fileTreeNav'
import FileIcon from './shared/FileIcon.vue'
import Icon from './shared/Icon.vue'
import { RENAME_SESSION_KEY, SYMBOL_RENAME_SESSION_KEY } from '../lib/fileMenu'
import {
  EMPTY_GIT_DECORATIONS,
  GIT_DECORATIONS_KEY,
  normalizeFsPath,
  type GitDecoration,
  type GitDecorClass
} from '../lib/gitDecorations'

interface FileItem {
  name: string
  path: string
  isDirectory: boolean
  children?: FileItem[]
}

const props = defineProps<{
  node: FileItem
  depth: number
  activeTabPath: string | null
  expandedPaths: Record<string, boolean>
  /**
   * Drop the extension from the displayed name. Used by the Project pane, where
   * the group heading already says what kind of file these are, so repeating
   * `.kicad_sch` on every row is noise. The tooltip keeps the real filename.
   */
  hideExtension?: boolean
  /**
   * Symbol names per `.kicad_sym` path — a symbol library expands like a folder
   * to its symbols (lazily filled by the Sidebar on first expand). A leaf opens
   * that symbol in the editor (`open-library-symbol`).
   */
  symbolChildren?: Record<string, string[]>
  /**
   * The File Explorer's own selection, independent of which tab is active —
   * opening a tab from anywhere else must not move it. When `selectionMode` is
   * set the highlight follows this; otherwise it falls back to `activeTabPath`
   * (the Project pane, which has no selection of its own).
   */
  selection?: TreeSelection | null
  selectionMode?: boolean
  /** False dims the selection: the Explorer isn't the last-interacted pane. */
  paneActive?: boolean
}>()

const emit = defineEmits<{
  (e: 'open-file', node: FileItem, options?: { preview?: boolean }): void
  (e: 'toggle-folder', path: string): void
  (e: 'context-menu', node: FileItem, event: MouseEvent): void
  (e: 'open-library-symbol', path: string, symbol: string, options?: { preview?: boolean }): void
  (e: 'select', selection: TreeSelection): void
  (e: 'symbol-context-menu', path: string, symbol: string, event: MouseEvent): void
}>()

const isExpanded = computed((): boolean => !!props.expandedPaths[props.node.path])

// A `.kicad_sym` holds many symbols and has no per-symbol file, so it expands
// like a folder to let the user open one symbol directly.
const isSymbolLibrary = computed(
  (): boolean => !props.node.isDirectory && props.node.name.endsWith('.kicad_sym')
)
const isExpandable = computed((): boolean => props.node.isDirectory || isSymbolLibrary.value)
const symbolNames = computed((): string[] => props.symbolChildren?.[props.node.path] ?? [])

/**
 * The row is selected when the selection names it and no symbol — a selected
 * symbol belongs to its own leaf, so the library row does not also light up.
 */
const isSelectedRow = computed((): boolean =>
  props.selectionMode
    ? props.selection?.path === props.node.path && !props.selection?.symbol
    : props.activeTabPath === props.node.path
)
const isSelectedSymbol = (symbol: string): boolean =>
  !!props.selectionMode &&
  props.selection?.path === props.node.path &&
  props.selection?.symbol === symbol

// Only the final extension is dropped, and only from files: `power.kicad_sch`
// becomes `power`, while a `fp.pretty` directory keeps its name, since there
// the suffix *is* what identifies it as a library.
const displayName = computed((): string => {
  if (!props.hideExtension || props.node.isDirectory) return props.node.name
  const dot = props.node.name.lastIndexOf('.')
  return dot > 0 ? props.node.name.slice(0, dot) : props.node.name
})

// Git decorations arrive by injection (Sidebar provides them) because this
// component is recursive — no prop to re-thread at every depth.
const gitDecorations = inject(
  GIT_DECORATIONS_KEY,
  computed(() => EMPTY_GIT_DECORATIONS)
)

/** Status letter + color for file rows (VSCode-style badge on the right). */
const gitDecoration = computed((): GitDecoration | undefined =>
  props.node.isDirectory
    ? undefined
    : gitDecorations.value.files.get(normalizeFsPath(props.node.path))
)

/** Folders containing changes get a label tint only, no letter. */
const gitDirClass = computed((): GitDecorClass | undefined =>
  props.node.isDirectory
    ? gitDecorations.value.dirs.get(normalizeFsPath(props.node.path))
    : undefined
)

const gitLabelClass = computed(
  (): GitDecorClass | undefined => gitDecoration.value?.cls ?? gitDirClass.value
)

// Files with no editor/viewer route render dimmed (still clickable — they
// open the file-info tab).
const isUnsupported = computed(
  (): boolean => !props.node.isDirectory && !isOpenableFile(props.node.name)
)

// VS Code preview semantics: a single click selects the row and opens the file
// as a preview tab (italic, replaced by the next preview); a double click pins
// it and hands focus to the editor. Selecting always happens, so the Explorer
// keeps its own place regardless of what the click opens.
const handleClick = (): void => {
  emit('select', { path: props.node.path })
  // Directories and `.kicad_sym` libraries expand instead of opening — a
  // library has no single thing to show, so you pick a symbol from it.
  if (isExpandable.value) emit('toggle-folder', props.node.path)
  else emit('open-file', props.node, { preview: true })
}

const handleDoubleClick = (): void => {
  // An expandable row has already toggled twice by now; opening as well would
  // be a third, unrelated action.
  if (!isExpandable.value) emit('open-file', props.node)
}

/** A symbol leaf is the openable unit of a `.kicad_sym`: preview, then pin. */
const onSymbolClick = (symbol: string): void => {
  emit('select', { path: props.node.path, symbol })
  emit('open-library-symbol', props.node.path, symbol, { preview: true })
}
const onSymbolDoubleClick = (symbol: string): void =>
  emit('open-library-symbol', props.node.path, symbol)

// ---- Inline rename --------------------------------------------------------

const rename = inject(RENAME_SESSION_KEY, undefined)
const renameInput = ref<HTMLInputElement | null>(null)
const isRenaming = computed((): boolean => rename?.path.value === props.node.path)

// Symbol-leaf inline rename (parallel session, keyed by `<libPath>#<symbol>`).
const symbolRename = inject(SYMBOL_RENAME_SESSION_KEY, undefined)
const isRenamingSymbol = (symbol: string): boolean =>
  symbolRename?.key.value === `${props.node.path}#${symbol}`
// Focus + select the input the moment it renders (one leaf renames at a time).
const vFocus = {
  mounted: (el: HTMLInputElement): void => {
    el.focus()
    el.select()
  }
}

watch(isRenaming, async (active) => {
  if (!active) return
  await nextTick()
  const input = renameInput.value
  if (!input) return
  input.focus()
  // Select the stem only: renaming almost never means changing the extension,
  // and a full select would make typing discard it.
  const dot = props.node.name.lastIndexOf('.')
  input.setSelectionRange(0, dot > 0 ? dot : props.node.name.length)
})
</script>

<template>
  <div class="tree-item-wrapper">
    <div
      class="tree-node"
      :class="{
        active: isSelectedRow,
        inactive: isSelectedRow && selectionMode && !paneActive,
        unsupported: isUnsupported
      }"
      :style="{ '--depth': depth }"
      @click="handleClick"
      @dblclick="handleDoubleClick"
      @contextmenu.prevent.stop="emit('context-menu', node, $event)"
    >
      <!-- Caret for expandable rows (directories + symbol libraries). A file
           has none: its glyph takes the caret's column, so a folder's caret
           and its sibling files' glyphs line up. -->
      <span v-if="isExpandable" class="tree-node-arrow" :class="{ expanded: isExpanded }">
        <Icon name="chevron-right" />
      </span>

      <!-- A library row is a caret and a name, like a folder: its symbols,
           one step in, each show the glyph. -->
      <FileIcon v-if="!isSymbolLibrary" :name="node.name" :is-directory="node.isDirectory" />

      <!-- Label, or the inline rename editor for this row -->
      <input
        v-if="isRenaming"
        ref="renameInput"
        class="tree-node-rename"
        :class="{ invalid: rename?.error.value }"
        :value="node.name"
        @click.stop
        @dblclick.stop
        @input="rename?.onInput(($event.target as HTMLInputElement).value)"
        @keydown.enter.stop.prevent="rename?.commit()"
        @keydown.escape.stop.prevent="rename?.cancel()"
        @blur="rename?.cancel()"
      />
      <span v-else class="tree-node-label" :class="gitLabelClass" :title="node.name">{{
        displayName
      }}</span>

      <!-- Git status letter (files only) -->
      <span
        v-if="gitDecoration && !isRenaming"
        class="tree-node-git-badge"
        :class="gitDecoration.cls"
      >
        {{ gitDecoration.letter }}
      </span>
    </div>

    <!-- Recursive children rendering (directories) -->
    <div v-if="node.isDirectory && isExpanded && node.children">
      <FileTreeNode
        v-for="child in node.children"
        :key="child.path"
        :node="child"
        :depth="depth + 1"
        :active-tab-path="activeTabPath"
        :selection="selection"
        :selection-mode="selectionMode"
        :pane-active="paneActive"
        :expanded-paths="expandedPaths"
        :hide-extension="hideExtension"
        :symbol-children="symbolChildren"
        @open-file="(n, o) => $emit('open-file', n, o)"
        @toggle-folder="(p) => $emit('toggle-folder', p)"
        @context-menu="(n, e) => $emit('context-menu', n, e)"
        @open-library-symbol="(p, s, o) => $emit('open-library-symbol', p, s, o)"
        @select="(sel) => $emit('select', sel)"
        @symbol-context-menu="(p, s, e) => $emit('symbol-context-menu', p, s, e)"
      />
    </div>

    <!-- Symbol leaves of an expanded .kicad_sym library -->
    <div v-else-if="isSymbolLibrary && isExpanded">
      <div
        v-for="symbol in symbolNames"
        :key="symbol"
        class="tree-node symbol-leaf"
        :class="{
          active: isSelectedSymbol(symbol),
          inactive: isSelectedSymbol(symbol) && !paneActive
        }"
        :style="{ '--depth': depth + 1 }"
        @click="onSymbolClick(symbol)"
        @dblclick="onSymbolDoubleClick(symbol)"
        @contextmenu.prevent.stop="emit('symbol-context-menu', node.path, symbol, $event)"
      >
        <FileIcon kind="symbol" />
        <input
          v-if="isRenamingSymbol(symbol)"
          v-focus
          class="tree-node-rename"
          :class="{ invalid: symbolRename?.invalid.value }"
          :value="symbolRename?.draft.value"
          @click.stop
          @dblclick.stop
          @input="symbolRename?.onInput(($event.target as HTMLInputElement).value)"
          @keydown.enter.stop.prevent="symbolRename?.commit()"
          @keydown.escape.stop.prevent="symbolRename?.cancel()"
          @blur="symbolRename?.cancel()"
        />
        <span v-else class="tree-node-label" :title="symbol">{{ symbol }}</span>
      </div>
      <div
        v-if="symbolNames.length === 0"
        class="tree-node symbol-leaf empty"
        :style="{ '--depth': depth + 1 }"
      >
        <span class="tree-node-label muted">…</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.symbol-leaf .tree-node-label.muted {
  color: var(--vscode-text-muted);
  font-style: italic;
}
</style>
