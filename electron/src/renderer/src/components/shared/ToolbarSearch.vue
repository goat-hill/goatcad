<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from './Icon.vue'
import { hotkeyLabel } from '../../lib/hotkeys'
import {
  filterToolSearchOps,
  layoutToolSearch,
  toolSearchRowsFor,
  TOOL_SEARCH_COLUMN_ROWS,
  type ToolbarSearchOp
} from '../../lib/toolSearch'

/**
 * Inline tool search at the end of a canvas floating toolbar (the OnShape
 * pattern): type straight into the box, results drop down under it. Focused
 * while empty it lists every control on the editor's canvas toolbars, laid
 * out the same in every editor — Edit and View sections, each in titled
 * groups (lib/toolSearch.ts); typing filters; ↑/↓ move, ←/→ jump a group,
 * Enter picks, Esc closes. `/` on the canvas focuses it.
 * Editor-agnostic: each editor supplies its own ops with translated labels;
 * the field's own copy ("Tools…") and the headings are shared.
 * This is the seed of the future global command palette.
 * At rest it wears the current tool's icon and name where no chip on the bar
 * shows it (a tool the search alone offers, or one the bar folded away).
 */

const props = defineProps<{
  ops: ToolbarSearchOp[]
  disabled?: boolean
}>()

const emit = defineEmits<{
  (event: 'pick', id: string): void
}>()

const { t } = useI18n()

/** The key that focuses the field from the canvas, shown in it at rest. */
const focusHotkey = hotkeyLabel('editor.focusSearch')

const query = ref('')
const open = ref(false)
const activeIndex = ref(0)
const input = ref<HTMLInputElement | null>(null)

const root = ref<HTMLElement | null>(null)
const columnRows = ref(TOOL_SEARCH_COLUMN_ROWS)

const layout = computed(() =>
  layoutToolSearch(filterToolSearchOps(props.ops, query.value), columnRows.value)
)

/** Space kept between the dropdown and the canvas's bottom, or its status pills. */
const BOTTOM_GAP = 12
const PILL_GAP = 8

/** How tall the dropdown may be, in px: it scrolls past this. */
const maxHeight = ref<number | null>(null)

// The room below the dropdown's top (8px under the bar), down to the bottom
// status pills (ViewportStatusBar) or the canvas edge, sets how tall a column
// may run and where the dropdown starts to scroll: measured when it opens and
// again whenever the canvas resizes under it.
const measure = (): void => {
  const field = root.value
  const canvas = field?.closest('.viewport-host-area')
  if (!field || !canvas) return
  const top = field.getBoundingClientRect().bottom + 8
  let bottom = canvas.getBoundingClientRect().bottom - BOTTOM_GAP
  for (const corner of canvas.querySelectorAll('.viewport-status-corner')) {
    const rect = corner.getBoundingClientRect()
    if (rect.height > 0) bottom = Math.min(bottom, rect.top - PILL_GAP)
  }
  const room = Math.max(0, bottom - top)
  columnRows.value = toolSearchRowsFor(room)
  maxHeight.value = room
}

let canvasResize: ResizeObserver | null = null
const watchCanvas = (on: boolean): void => {
  canvasResize?.disconnect()
  canvasResize = null
  const canvas = root.value?.closest('.viewport-host-area')
  if (!on || !canvas) return
  canvasResize = new ResizeObserver(measure)
  canvasResize.observe(canvas)
}

const onFocus = (): void => {
  measure()
  open.value = true
  watchCanvas(true)
}

// A blur that comes from the whole window losing focus — the OS taking the
// pointer to resize the window, a switch to another app — leaves it open, and
// focus comes back to the field with the window. A click elsewhere in the app
// is the blur that closes it.
const onBlur = (): void => {
  if (document.hasFocus()) close()
}

watch(query, () => {
  activeIndex.value = 0
})

// Keep the keyboard's row in view when the dropdown scrolls.
const dropdown = ref<HTMLElement | null>(null)

watch(
  activeIndex,
  () => {
    dropdown.value
      ?.querySelector('.insert-op.active')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  },
  { flush: 'post' }
)

const close = (): void => {
  watchCanvas(false)
  open.value = false
  query.value = ''
  activeIndex.value = 0
}

const pick = (op: ToolbarSearchOp): void => {
  if (op.disabled) return
  close()
  input.value?.blur()
  emit('pick', op.id)
}

const onKeydown = (event: KeyboardEvent): void => {
  const { ops, groupStarts } = layout.value
  if (event.key === 'Escape') {
    event.preventDefault()
    close()
    input.value?.blur()
  } else if (event.key === 'Enter') {
    event.preventDefault()
    const op = ops[activeIndex.value] ?? ops[0]
    if (op) pick(op)
  } else if (event.key === 'ArrowDown') {
    event.preventDefault()
    activeIndex.value = Math.min(activeIndex.value + 1, ops.length - 1)
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    activeIndex.value = Math.max(activeIndex.value - 1, 0)
  } else if ((event.key === 'ArrowRight' || event.key === 'ArrowLeft') && !query.value) {
    // Group to group — only while nothing is typed, when there is no caret to move.
    event.preventDefault()
    const current = groupStarts.findLastIndex((start) => start <= activeIndex.value)
    const next = groupStarts[current + (event.key === 'ArrowRight' ? 1 : -1)]
    if (next !== undefined) activeIndex.value = next
  }
}

// The toolbar chip for the active row wears .search-hint (assets/canvasToolbar.css),
// found by its data-tool-op — the op's id, or several where one chip stands
// for a family (the schematic's label chip) — among the canvas's toolbars. A row
// with no chip (a search-only op, a route option while the route tool is not
// armed) lights nothing.
let hinted: Element | null = null
const clearHint = (): void => {
  hinted?.classList.remove('search-hint')
  hinted = null
}
watch(
  () => (open.value ? layout.value.ops[activeIndex.value]?.id : undefined),
  (id) => {
    clearHint()
    const canvas = root.value?.closest('.viewport-host-area')
    if (!id || !canvas) return
    hinted = canvas.querySelector(`.canvas-floating-toolbar [data-tool-op~="${CSS.escape(id)}"]`)
    hinted?.classList.add('search-hint')
  },
  { flush: 'post' }
)
onBeforeUnmount(() => {
  clearHint()
  watchCanvas(false)
})

/** The current tool, while no chip on the canvas's toolbars shows it. */
const unseen = ref<ToolbarSearchOp | null>(null)
const currentOp = computed(() => props.ops.find((op) => op.state === 'current') ?? null)
const checkUnseen = (): void => {
  const op = currentOp.value
  const canvas = root.value?.closest('.viewport-host-area')
  const chip = op
    ? canvas?.querySelector<HTMLElement>(
        `.canvas-floating-toolbar [data-tool-op~="${CSS.escape(op.id)}"]`
      )
    : null
  unseen.value = op && (!chip || chip.offsetParent === null) ? op : null
}
watch(currentOp, () => void nextTick(checkUnseen), { immediate: true })
// The bar folds chips away as the canvas narrows (lib/canvasToolbar.ts).
let barWatch: MutationObserver | null = null
watch(
  root,
  (el) => {
    barWatch?.disconnect()
    const bar = el?.closest('.canvas-floating-toolbar')
    if (!bar) return
    barWatch = new MutationObserver(checkUnseen)
    barWatch.observe(bar, { subtree: true, attributeFilter: ['data-toolbar-hidden'] })
  },
  { flush: 'post' }
)
onBeforeUnmount(() => barWatch?.disconnect())

const focus = (): void => {
  if (!props.disabled) input.value?.focus()
}

defineExpose({ focus })
</script>

<template>
  <div ref="root" class="insert-search" :class="{ open, current: unseen && !open }">
    <div class="search-field">
      <Icon :name="unseen && !open ? unseen.icon : 'tool-search'" class="search-glyph" />
      <input
        ref="input"
        v-model="query"
        class="search-input"
        :disabled="disabled"
        :title="`${t('shared.insertSearch.label')} (${focusHotkey})`"
        :aria-label="t('shared.insertSearch.label')"
        spellcheck="false"
        @focus="onFocus"
        @blur="onBlur"
        @keydown.stop="onKeydown"
      />
      <!-- Drawn rather than a native placeholder so the hotkey can sit in it as
         a key cap, styled like the results' hotkeys. -->
      <span v-if="!query" class="search-placeholder" aria-hidden="true">
        {{ unseen && !open ? unseen.label : t('shared.insertSearch.placeholder') }}
        <kbd v-if="!open" class="kbd"
          ><span>{{ focusHotkey }}</span></kbd
        >
      </span>
    </div>
    <div
      v-if="open"
      ref="dropdown"
      class="search-dropdown"
      :style="maxHeight !== null ? { maxHeight: `${maxHeight}px` } : undefined"
    >
      <section v-for="section in layout.sections" :key="section.section" class="search-section">
        <h3 class="section-heading">{{ t(`shared.insertSearch.sections.${section.section}`) }}</h3>
        <div class="section-columns">
          <div v-for="(column, c) in section.columns" :key="c" class="section-column">
            <div v-for="group in column" :key="group.group" class="search-group">
              <h4 class="group-heading">{{ t(`shared.insertSearch.groups.${group.group}`) }}</h4>
              <!-- mousedown.prevent keeps the input focused so blur can't close
                   the dropdown before the pick lands -->
              <button
                v-for="{ op, index } in group.ops"
                :key="op.id"
                class="insert-op"
                :class="{ active: index === activeIndex }"
                :disabled="op.disabled"
                @mousedown.prevent="pick(op)"
                @mousemove="activeIndex = index"
              >
                <span class="op-icon" :class="op.state"
                  ><Icon :name="op.icon" class="op-glyph"
                /></span>
                <span class="op-name">{{ op.label }}</span>
                <kbd v-if="op.hotkey" class="kbd"
                  ><span>{{ op.hotkey }}</span></kbd
                >
              </button>
            </div>
          </div>
        </div>
      </section>
      <div v-if="!layout.ops.length" class="insert-empty">
        {{ t('shared.insertSearch.noMatches') }}
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Not positioned itself, so the dropdown's containing block is the toolbar
   (.canvas-floating-toolbar) and it hangs from the bar's left edge, not the
   field's. The field is the positioned box its input overlays. */
.insert-search {
  display: flex;
  /* The toolbar's last section, flush to its top, bottom and right edges:
     the negative margins take back the bar's 3px padding, and the field's
     left border is a full-height separator (no .toolbar-divider before it). */
  align-self: stretch;
  margin: -3px -3px -3px 0;
  /* A chip's 32px plus the 6px of padding the margins take back, so a bar
     folded down to the search alone stays as tall as a full one. */
  min-height: 38px;
  /* At rest the section hugs its copy ("Tools…" and the hotkey cap, whatever
     their length in the locale); focused it widens for typing. The input is
     laid over the whole section, so its width follows. interpolate-size lets
     the width animate from auto. */
  interpolate-size: allow-keywords;
  transition: width 100ms ease-out;
  /* A fitted bar (lib/canvasToolbar.ts) rests it at its copy's width plus the
     snug extra (--search-width), and budgets for the focused width — unless
     the bar is hiding chips, when it keeps the resting width focused too
     (--search-focus-width). */
  width: var(--search-width, auto);
  --search-open-width: 210px;
  --search-snug-extra: 40px;
}

.search-field {
  position: relative;
  flex: 1;
  display: flex;
  align-items: center;
}

/* Open, not just focused: the window losing focus mid-resize keeps the field
   wide and lit while its dropdown stays up (onBlur). */
.insert-search:focus-within,
.insert-search.open {
  width: var(--search-focus-width, var(--search-open-width));
}

.search-glyph {
  position: absolute;
  left: 8px;
  z-index: 1;
  width: 20px;
  height: 20px;
  color: var(--vscode-text-muted, #748780);
  pointer-events: none;
}

.search-input {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  padding: 0 8px 0 31px;
  border: none;
  border-left: 1px solid var(--vscode-border, #24302b);
  /* The bar's 8px radius, less its 1px border. */
  border-radius: 0 7px 7px 0;
  /* The editable-field shade, the property table's value cells: darker than
     the bar, so it reads as somewhere to type. */
  background: var(--vscode-property-value-bg);
  color: var(--vscode-text, #d8e0dc);
  font-size: var(--text-body-sm);
  outline: none;
  transition: box-shadow 70ms ease-out;
}

.search-input:hover {
  box-shadow: inset 0 0 0 1px var(--vscode-input-border);
}

.search-input:focus,
.insert-search.open .search-input {
  box-shadow: inset 0 0 0 1px var(--vscode-accent, #cca250);
}

/* In flow, so it is what gives the section its resting width: the input's
   padding on the left (past the magnifier), 8px on the right. */
.search-placeholder {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 8px 0 32px;
  /* Across the whole field, so the hotkey cap sits at its right end
     whenever the field is wider than its copy. */
  flex: 1;
  color: var(--vscode-text-muted, #748780);
  font-size: var(--text-body-sm);
  white-space: nowrap;
  pointer-events: none;
}

.search-placeholder .kbd {
  margin-left: auto;
}

/* The current tool, worn at rest where no chip shows it: lit as an active chip. */
.insert-search.current .search-glyph {
  color: var(--vscode-accent, #cca250);
}

.insert-search.current .search-placeholder {
  color: var(--vscode-text, #d8e0dc);
}

.search-input:disabled {
  opacity: 0.35;
}

.search-dropdown {
  position: absolute;
  /* Under the toolbar, flush with its outer left edge (-1px: the offsets
     measure from inside the bar's border), or past the left view rail where
     the canvas has one (assets/canvasToolbar.css). Left, not right: the field
     widens rightward on focus, so the bar's right edge moves mid-transition. */
  top: calc(100% + 8px);
  left: calc(var(--canvas-rail-clearance, 0px) - 1px);
  /* Shrink-to-fit would cap it at the bar's width and squeeze the columns.
     Capped instead at the canvas right of the rail (the container in
     assets/canvasToolbar.css, less the bar's 12px inset each side), past which
     the canvas clips it: the columns wrap rather than run under the side panel. */
  width: max-content;
  max-width: calc(100cqi - 24px - var(--canvas-rail-clearance, 0px));
  display: flex;
  flex-wrap: wrap;
  /* Its max-height is the room above the bottom pills (measure()); past that,
     a short canvas scrolls the dropdown rather than clipping it. */
  overflow-y: auto;
  overscroll-behavior: contain;
  background: var(--vscode-overlay-strong);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border: 1px solid var(--vscode-border, #24302b);
  border-radius: 6px;
  box-shadow: 0 8px 32px var(--vscode-shadow-float);
}

/* Edit | View, side by side with a rule between. */
.search-section {
  padding: 8px 4px 4px;
}

.search-section + .search-section {
  border-left: 1px solid var(--vscode-border, #24302b);
}

.section-heading {
  margin: 0 8px 4px;
  color: var(--vscode-text, #d8e0dc);
  font-size: var(--text-body-sm);
  font-weight: 600;
}

.section-columns {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 4px;
}

.section-column {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 190px;
}

.search-group {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

/* The section eyebrow (DESIGN.md). */
.group-heading {
  margin: 4px 8px 2px;
  color: var(--vscode-text-muted, #748780);
  font-size: var(--text-caption);
  font-weight: 400;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.insert-op {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px 4px 4px;
  background: transparent;
  border: none;
  border-radius: 4px;
  color: var(--vscode-text, #d8e0dc);
  font-size: var(--text-body);
  text-align: left;
  white-space: nowrap;
  cursor: pointer;
}

.insert-op.active:not(:disabled) {
  background-color: var(--vscode-bg-active, #32473f);
}

.insert-op:disabled {
  opacity: 0.35;
  cursor: default;
}

/* The toolbar chip in miniature, so a row reads its state the way the chip
   does (assets/canvasToolbar.css): the armed tool copper-outlined, an on
   toggle lit on a quiet fill. */
.op-icon {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  width: 26px;
  height: 26px;
  border: 1px solid transparent;
  border-radius: 4px;
  color: var(--vscode-accent, #cca250);
}

.op-glyph {
  width: 20px;
  height: 20px;
}

.op-icon.current {
  border-color: var(--vscode-accent, #cca250);
}

.op-icon.on {
  background-color: var(--vscode-bg-active, #32473f);
  color: var(--vscode-text-light, #ffffff);
}

.insert-op.active .op-icon.on {
  background-color: var(--vscode-overlay-control-hover);
}

.op-name {
  flex: 1;
}

.insert-empty {
  padding: 8px;
  color: var(--vscode-text-muted, #748780);
  font-size: var(--text-body);
}
</style>
