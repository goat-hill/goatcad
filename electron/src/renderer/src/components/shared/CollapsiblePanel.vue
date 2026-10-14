<script setup lang="ts">
/**
 * A stackable right-bar panel: a click-to-collapse header + a scrollable body,
 * with a drag-to-resize handle at the bottom. Meant to be stacked in a flex
 * column (like the left sidebar's explorer sections) and reused across editors
 * (footprint / PCB): wrap the Properties table, LayersPanel, GridSettingsPanel.
 *
 * Sizing: pass `flex` to make a panel fill the remaining space (no resize
 * handle — it's the absorber when its fixed-height siblings are dragged). All
 * other panels keep a fixed, drag-resizable height and scroll internally. The
 * resize handle sits at the panel's TOP (the divider with the panel above), so
 * dragging the top of Layers resizes Layers, the top of Grid resizes Grid.
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from './Icon.vue'
import ResizeHandle from './ResizeHandle.vue'
import { sectionState, setSectionCollapsed, setSectionHeight } from '../../lib/panelLayout'

const props = withDefaults(
  defineProps<{
    title: string
    /**
     * Stable id under which this panel's height and collapsed state persist.
     *
     * Omit it and the panel keeps both in local refs, which is right for a
     * `flex` absorber (no height of its own) and for anything transient. Give
     * it one and the panel survives what the component does not: `EditorArea`
     * rebuilds an editor on every tab switch, so a local ref here is lost on
     * the next tab click, not on restart. Ids are namespaced by owner
     * (`symbol.pins`, `pcb.layers`) and must not change once shipped — a
     * renamed id reads as a reset.
     */
    id?: string
    /** Fill remaining space instead of a fixed, resizable height. */
    flex?: boolean
    /** As tall as its content and no handle: a stack of these reads top to bottom. */
    fit?: boolean
    initialHeight?: number
    minHeight?: number
    defaultCollapsed?: boolean
    /** A panel pinned here from a viewport pill: its header offers to unpin it. */
    unpinnable?: boolean
  }>(),
  {
    id: undefined,
    flex: false,
    fit: false,
    initialHeight: 220,
    minHeight: 60,
    defaultCollapsed: false,
    unpinnable: false
  }
)

const emit = defineEmits<{ (e: 'unpin'): void }>()

const { t } = useI18n()

/**
 * Stored state for this id, or an empty object — including when there is no id
 * at all, which is what makes the two modes one code path rather than a branch
 * in every accessor.
 */
const stored = computed(() => (props.id ? sectionState(props.id).value : {}))

// The local halves, used when there is no id and as the pre-load value when
// there is: the config arrives asynchronously, so the panel has to draw
// something first, and the component's own default is the right something.
const localCollapsed = ref(props.defaultCollapsed)
const localHeight = ref(props.initialHeight)

const collapsed = computed(() => stored.value.collapsed ?? localCollapsed.value)
const height = computed(() => stored.value.height ?? localHeight.value)

const toggle = (): void => {
  const next = !collapsed.value
  localCollapsed.value = next
  if (props.id) setSectionCollapsed(props.id, next)
}

const root = ref<HTMLElement | null>(null)

/**
 * How much taller this panel can get before the stack overflows: the column's
 * empty space plus what each open absorber has above its floor. Past it the
 * flex column would shrink every panel at once, the handle would drift off the
 * pointer, and the stored height would run ahead of the drawn one.
 */
const roomToGrow = (): number => {
  const el = root.value
  const column = el?.parentElement
  if (!el || !column) return Infinity
  let used = 0
  let spare = 0
  for (const child of Array.from(column.children) as HTMLElement[]) {
    const h = child.getBoundingClientRect().height
    used += h
    if (child !== el && child.matches('.collapsible-panel.flex:not(.collapsed)')) {
      spare += Math.max(0, h - parseFloat(getComputedStyle(child).minHeight || '0'))
    }
  }
  return Math.max(0, column.clientHeight - used) + spare
}

// The top handle (divider with the panel above) resizes this panel; the shared
// ResizeHandle normalizes "positive = grow". The drag starts from the height as
// drawn, which a short window may have squeezed below the stored one.
let startH = 0
let maxH = Infinity
const onResizeStart = (): void => {
  startH = Math.round(root.value?.getBoundingClientRect().height ?? height.value)
  maxH = startH + Math.floor(roomToGrow())
}
const onResize = (grow: number): void => {
  const next = Math.round(Math.max(props.minHeight, Math.min(maxH, startH + grow)))
  localHeight.value = next
  // Live, uncommitted: the drag reads from the store, so it must land there on
  // every frame — but writing through to the config on each one would be a
  // config write and a cross-window broadcast per pixel.
  if (props.id) setSectionHeight(props.id, next)
}
/** Commit once, at the end of the drag. */
const onResizeEnd = (): void => {
  if (props.id) setSectionHeight(props.id, height.value, true)
}
</script>

<template>
  <section
    ref="root"
    class="collapsible-panel"
    :class="{ collapsed, flex, fit }"
    :style="!flex && !fit && !collapsed ? { height: height + 'px' } : undefined"
  >
    <ResizeHandle
      v-if="!flex && !fit && !collapsed"
      edge="top"
      @resize-start="onResizeStart"
      @resize="onResize"
      @resize-end="onResizeEnd"
    />
    <header class="panel-header" @click="toggle">
      <Icon name="chevron-right" class="disclosure" :class="{ open: !collapsed }" />
      <span class="panel-title">{{ title }}</span>
      <slot name="header" />
      <button
        v-if="unpinnable"
        type="button"
        class="panel-unpin"
        :title="t('shared.viewportPopover.unpin')"
        @click.stop="emit('unpin')"
      >
        <Icon name="pin" class="pin-glyph" />
      </button>
    </header>
    <div v-show="!collapsed" class="panel-body"><slot /></div>
  </section>
</template>

<style scoped>
.collapsible-panel {
  position: relative;
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-bottom: 1px solid var(--vscode-border, #24302b);
}

/* The absorber: fills remaining height when siblings are resized/collapsed. */
.collapsible-panel.flex {
  flex: 1;
  min-height: 60px;
}

.collapsible-panel.collapsed,
.collapsible-panel.fit {
  flex: none;
}

.panel-header {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 10px;
  cursor: pointer;
  user-select: none;
  color: var(--vscode-text-muted, #748780);
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  background: var(--vscode-bg-editor);
}

.panel-header:hover {
  color: var(--vscode-text, #c5d3cd);
}

.panel-unpin {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  margin-left: auto;
  padding: 0;
  border: none;
  border-radius: 3px;
  background: none;
  color: var(--vscode-text-muted);
  cursor: pointer;
}

.panel-unpin:hover {
  color: var(--vscode-text);
  background: var(--vscode-bg-hover);
}

.pin-glyph {
  width: 12px;
  height: 12px;
}

.panel-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
</style>
