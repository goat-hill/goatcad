<script setup lang="ts">
/**
 * DigiKey category browse — Miller columns.
 *
 * The whole tree arrives in **one** API call (`GET /search/categories`, nested
 * `Children` with a `ProductCount` per node) and main memoizes it for the
 * session, so every click below is local. That is what makes browse affordable
 * against a ~1000-call day: one request buys the entire taxonomy, and only
 * asking for *parts* costs anything after that.
 *
 * Columns rather than a nested tree because the hierarchy is wide and shallow —
 * a tree would push the useful level off the bottom of the screen, while columns
 * keep each level's full sibling list visible and make the path you took
 * readable across the top.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '../shared/Icon.vue'
import type { PartCategory } from '../../../../preload/partsTypes'

const props = defineProps<{
  categories: PartCategory[]
  /** The open path, root-first. Empty shows only the top level. */
  path: PartCategory[]
  loading: boolean
}>()

const emit = defineEmits<{
  (e: 'update:path', path: PartCategory[]): void
  (e: 'search', category: PartCategory): void
}>()

const { t, n } = useI18n()

/**
 * One column per level: the roots, then each opened node's children. A node
 * with no children ends the chain — there is nothing further to show.
 */
const columns = computed<PartCategory[][]>(() => {
  const result: PartCategory[][] = [props.categories]
  for (const node of props.path) {
    if (node.children.length === 0) break
    result.push(node.children)
  }
  return result
})

const isSelected = (depth: number, node: PartCategory): boolean => props.path[depth]?.id === node.id

/**
 * Selecting a node opens it. A leaf has nothing to open, so selecting one is the
 * search — which keeps the common case to a single click while still letting a
 * parent category be searched from the breadcrumb.
 */
const select = (depth: number, node: PartCategory): void => {
  emit('update:path', [...props.path.slice(0, depth), node])
  if (node.children.length === 0) emit('search', node)
}

const current = computed<PartCategory | null>(() => props.path[props.path.length - 1] ?? null)
</script>

<template>
  <div class="browser">
    <div v-if="path.length" class="crumbs">
      <button class="btn-subtle btn-sm" @click="emit('update:path', [])">
        {{ t('parts.browse.all') }}
      </button>
      <template v-for="(node, depth) in path" :key="node.id">
        <Icon name="chevron-right" class="breadcrumb-sep" />
        <button class="btn-subtle btn-sm" @click="emit('update:path', path.slice(0, depth + 1))">
          {{ node.name }}
        </button>
      </template>

      <!-- Searching a *parent* category, which selecting it does not do on its
           own: opening a branch and asking for its parts are different intents. -->
      <button
        v-if="current"
        class="btn-outline btn-sm crumb-search"
        @click="emit('search', current)"
      >
        {{ t('parts.browse.searchCategory', { count: n(current.productCount) }) }}
      </button>
    </div>

    <!-- No text while loading: the query row's bar already reports the wait, and
         one wait should not have two indicators (DESIGN.md §Loading feedback). -->
    <p v-if="!loading && !categories.length" class="browser-status">
      {{ t('parts.browse.empty') }}
    </p>

    <div v-if="categories.length" class="columns">
      <div v-for="(column, depth) in columns" :key="depth" class="column">
        <button
          v-for="node in column"
          :key="node.id"
          class="node"
          :class="{ selected: isSelected(depth, node) }"
          @click="select(depth, node)"
        >
          <span class="node-name">{{ node.name }}</span>
          <span class="node-count">{{ n(node.productCount) }}</span>
          <Icon v-if="node.children.length" name="chevron-right" class="node-more" />
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.browser {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

.crumbs {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 2px;
  padding: 8px 24px;
  border-bottom: 1px solid var(--vscode-border);
}

.crumb-search {
  margin-left: 10px;
}

.browser-status {
  margin: 0;
  padding: 16px 24px;
  font-size: var(--text-body-sm);
  color: var(--vscode-text-muted);
}

/* Columns scroll horizontally as the path deepens; each scrolls vertically on
   its own so a long sibling list never pushes the others off. */
.columns {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow-x: auto;
}

.column {
  display: flex;
  flex-direction: column;
  flex: none;
  width: 260px;
  min-height: 0;
  overflow-y: auto;
  border-right: 1px solid var(--vscode-border);
}

.node {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 5px 10px;
  border: none;
  background: none;
  text-align: left;
  color: var(--vscode-text);
  font-size: var(--text-body-sm);
  cursor: pointer;
}

.node:hover {
  background: var(--vscode-overlay-control);
}

.node.selected {
  background: var(--vscode-accent-subtle-strong);
  color: var(--vscode-accent);
}

.node-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.node-count {
  flex: none;
  color: var(--vscode-text-muted);
  font-variant-numeric: tabular-nums;
}

.node.selected .node-count {
  color: inherit;
}

.node-more {
  flex: none;
  width: 14px;
  height: 14px;
  color: var(--vscode-text-muted);
}
</style>
