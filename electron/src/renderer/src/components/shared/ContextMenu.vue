<script setup lang="ts">
/**
 * The app's only menu surface: title-bar dropdowns, the file explorer's
 * right-click menu, and any `New ▸` popup all render this from a `MenuNode[]`
 * (see lib/menu.ts). Positioned `fixed` at a viewport point so it is never
 * clipped by a scrolling or overflow-hidden ancestor, and flipped back inside
 * the viewport after measuring.
 *
 * Keyboard ownership: every level listens, but only the deepest open one acts
 * (`openIndex === null`), so exactly one menu in the chain responds to a key.
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import {
  firstFocusableIndex,
  hasChildren,
  isDivider,
  isHeader,
  isMenuItem,
  keyedItemIndex,
  labelSegments,
  lastFocusableIndex,
  nextFocusableIndex,
  resolveMenuPosition,
  type MenuHeader,
  type MenuItem,
  type MenuNode
} from '../../lib/menu'
import Icon from './Icon.vue'

const props = withDefaults(
  defineProps<{
    items: MenuNode[]
    /** Preferred top-left corner in viewport coordinates. */
    x: number
    y: number
    /**
     * Right edge of the row that opened this menu. A submenu that would
     * overflow flips to the left of it instead of covering it.
     */
    flipAnchorX?: number
    /** Submenus skip the outside-click watch; the root owns dismissal. */
    isRoot?: boolean
    /**
     * The control that opened the menu. A press on it is not an outside click:
     * the control's own click shuts the menu, as a menu button does on every
     * platform, rather than the press shutting it and the click opening it again.
     */
    anchor?: Element | null
    /**
     * A title-bar menu: window chrome, set a step larger than the canvas and
     * panel menus, as the OS menus beside it are. Submenus inherit it.
     */
    chrome?: boolean
  }>(),
  { isRoot: true }
)

const emit = defineEmits<{
  (e: 'select', id: string): void
  /**
   * The row the pointer or the arrow keys are on changed: its id, or null when
   * none is (Select Other previews the item it names).
   */
  (e: 'focus', id: string | null): void
  /** Close the whole menu chain (outside click, Escape at the root, a pick). */
  (e: 'close'): void
  /** Close just this level and return focus to the parent row (Escape, Left). */
  (e: 'dismiss'): void
}>()

const root = ref<HTMLElement | null>(null)
const focusedIndex = ref(-1)
const openIndex = ref<number | null>(null)
const position = ref({ x: props.x, y: props.y })
/** Submenu anchor, measured from the parent row so it opens beside it. */
const submenuOrigin = ref({ x: 0, y: 0, anchorX: 0 })

const itemOf = (node: MenuNode): MenuItem => node as MenuItem
const headerOf = (node: MenuNode): string => (node as MenuHeader).header

const openSubmenuItems = computed<MenuNode[]>(() => {
  if (openIndex.value === null) return []
  const node = props.items[openIndex.value]
  return node && isMenuItem(node) ? (node.children ?? []) : []
})

/** Measure, then flip/clamp into the viewport (lib/menu.ts owns the rules). */
const place = async (): Promise<void> => {
  await nextTick()
  const el = root.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  position.value = resolveMenuPosition({
    x: props.x,
    y: props.y,
    width: rect.width,
    height: rect.height,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    flipAnchorX: props.flipAnchorX
  })
}

watch(() => [props.x, props.y, props.items], place)

watch(focusedIndex, (index) => {
  const node = props.items[index]
  emit('focus', node && isMenuItem(node) ? node.id : null)
})

const openSubmenu = (index: number, rowEl: HTMLElement): void => {
  const rect = rowEl.getBoundingClientRect()
  const menuRect = root.value?.getBoundingClientRect()
  submenuOrigin.value = {
    // Overlap the parent's border so the pointer can cross without a gap.
    x: rect.right - 2,
    y: rect.top - 4,
    anchorX: menuRect ? menuRect.left + 2 : rect.left
  }
  openIndex.value = index
}

const onRowEnter = (index: number, event: MouseEvent): void => {
  const node = props.items[index]
  if (!isMenuItem(node)) return
  focusedIndex.value = node.disabled ? -1 : index
  if (hasChildren(node) && !node.disabled) {
    openSubmenu(index, event.currentTarget as HTMLElement)
  } else {
    // Moving onto a sibling closes the previously open submenu, as in native menus.
    openIndex.value = null
  }
}

const activate = (index: number, event: MouseEvent): void => {
  const node = props.items[index]
  if (!isMenuItem(node) || node.disabled) return
  if (hasChildren(node)) {
    openSubmenu(index, event.currentTarget as HTMLElement)
    return
  }
  emit('select', node.id)
  emit('close')
}

/** Open the focused row's submenu from the keyboard and focus its first row. */
const openFocusedSubmenu = (): boolean => {
  const index = focusedIndex.value
  if (index < 0) return false
  const node = props.items[index]
  if (!isMenuItem(node) || node.disabled || !hasChildren(node)) return false
  const rowEl = root.value?.querySelector<HTMLElement>(`[data-index="${index}"]`)
  if (!rowEl) return false
  openSubmenu(index, rowEl)
  return true
}

const onKeydown = (event: KeyboardEvent): void => {
  // Only the deepest open menu handles keys; ancestors defer to their child.
  if (openIndex.value !== null) return

  switch (event.key) {
    case 'ArrowDown':
      focusedIndex.value = nextFocusableIndex(props.items, focusedIndex.value, 1)
      break
    case 'ArrowUp':
      focusedIndex.value = nextFocusableIndex(props.items, focusedIndex.value, -1)
      break
    case 'Home':
      focusedIndex.value = firstFocusableIndex(props.items)
      break
    case 'End':
      focusedIndex.value = lastFocusableIndex(props.items)
      break
    case 'ArrowRight':
      if (!openFocusedSubmenu()) return
      break
    case 'ArrowLeft':
      if (props.isRoot) return
      emit('dismiss')
      break
    case 'Enter':
    case ' ': {
      const index = focusedIndex.value
      if (index < 0) return
      const node = props.items[index]
      if (!isMenuItem(node) || node.disabled) return
      if (hasChildren(node)) {
        if (!openFocusedSubmenu()) return
      } else {
        emit('select', node.id)
        emit('close')
      }
      break
    }
    case 'Escape':
      if (props.isRoot) emit('close')
      else emit('dismiss')
      break
    default: {
      const index = keyedItemIndex(props.items, event)
      if (index < 0) return
      emit('select', itemOf(props.items[index]).id)
      emit('close')
    }
  }
  event.preventDefault()
  event.stopPropagation()
}

const onPointerDownOutside = (event: MouseEvent): void => {
  if (!props.isRoot) return
  const target = event.target as Node
  if (props.anchor?.contains(target)) return
  if (!root.value?.contains(target)) emit('close')
}

onMounted(() => {
  void place()
  window.addEventListener('keydown', onKeydown, true)
  if (props.isRoot) window.addEventListener('mousedown', onPointerDownOutside, true)
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown, true)
  if (props.isRoot) window.removeEventListener('mousedown', onPointerDownOutside, true)
})

/** A child level closed itself — take focus back without closing the chain. */
const onSubmenuDismiss = (): void => {
  focusedIndex.value = openIndex.value ?? -1
  openIndex.value = null
}
</script>

<template>
  <div
    ref="root"
    class="context-menu"
    :class="{ chrome }"
    role="menu"
    :style="{ left: `${position.x}px`, top: `${position.y}px` }"
    @mouseleave="openIndex === null && (focusedIndex = -1)"
  >
    <template v-for="(node, index) in items" :key="index">
      <div v-if="isDivider(node)" class="context-menu-divider" role="separator"></div>
      <div v-else-if="isHeader(node)" class="context-menu-header" role="presentation">
        {{ headerOf(node) }}
      </div>
      <div
        v-else
        class="context-menu-item"
        :class="{
          disabled: itemOf(node).disabled,
          focused: focusedIndex === index,
          'has-submenu': hasChildren(node)
        }"
        :data-index="index"
        :role="itemOf(node).checked === undefined ? 'menuitem' : 'menuitemradio'"
        :aria-checked="itemOf(node).checked"
        :aria-disabled="itemOf(node).disabled ? 'true' : undefined"
        :title="itemOf(node).disabled ? itemOf(node).disabledReason : undefined"
        @mouseenter="onRowEnter(index, $event)"
        @click.stop="activate(index, $event)"
      >
        <span class="context-menu-label">
          <span
            v-for="(color, i) in itemOf(node).swatches ?? []"
            :key="`swatch-${i}`"
            class="context-menu-swatch"
            :style="{ backgroundColor: color }"
          /><template v-for="(seg, i) in labelSegments(itemOf(node).label)" :key="i"
            ><code v-if="seg.code" class="context-menu-code">{{ seg.text }}</code
            ><template v-else>{{ seg.text }}</template></template
          >
        </span>
        <span
          v-if="itemOf(node).shortcut || itemOf(node).key"
          class="context-menu-shortcut"
          :class="{ 'has-swatch': itemOf(node).shortcutSwatch }"
        >
          <span
            v-if="itemOf(node).shortcutSwatch"
            class="context-menu-swatch"
            :style="{ backgroundColor: itemOf(node).shortcutSwatch }"
          />{{ itemOf(node).shortcut ?? itemOf(node).key?.toUpperCase() }}
        </span>
        <Icon
          v-else-if="itemOf(node).checked"
          name="check"
          class="context-menu-check"
          aria-hidden="true"
        />
        <!-- A submenu always shows its caret, beside a shortcut naming its current choice too. -->
        <Icon
          v-if="hasChildren(node)"
          name="chevron-right"
          class="context-menu-caret"
          aria-hidden="true"
        />
      </div>
    </template>

    <ContextMenu
      v-if="openIndex !== null && openSubmenuItems.length > 0"
      :items="openSubmenuItems"
      :x="submenuOrigin.x"
      :y="submenuOrigin.y"
      :flip-anchor-x="submenuOrigin.anchorX"
      :is-root="false"
      @select="emit('select', $event)"
      @focus="emit('focus', $event)"
      @close="emit('close')"
      @dismiss="onSubmenuDismiss"
    />
  </div>
</template>

<style scoped>
.context-menu {
  position: fixed;
  background-color: var(--vscode-bg-dropdown);
  border: 1px solid var(--vscode-border);
  box-shadow: 0 4px 8px var(--vscode-shadow-float);
  border-radius: 4px;
  min-width: 180px;
  display: flex;
  flex-direction: column;
  padding: 4px 0;
  z-index: 200;
  -webkit-app-region: no-drag;
}

.context-menu-item {
  padding: 6px 12px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 24px;
  cursor: pointer;
  font-size: var(--text-body-sm);
  white-space: nowrap;
  color: var(--vscode-text);
}

/* The label takes the slack, so whatever trails it (a shortcut, a caret, both)
   packs against the right edge: with three items, space-between alone would
   float a shortcut midway, at a spot set by its label's length. */
.context-menu-label {
  flex: 1 1 auto;
}

/* The select's swatch (PropertyValueEditor), inline before the words. */
.context-menu-swatch {
  display: inline-block;
  width: 12px;
  height: 12px;
  margin-right: 6px;
  vertical-align: -2px;
  border: 1px solid var(--vscode-border, #24302b);
  border-radius: 3px;
}

/* A pair's two chips overlap like a deck, as a multiselect's do. */
.context-menu-swatch + .context-menu-swatch {
  margin-left: -11px;
}

.context-menu.chrome .context-menu-item {
  font-size: var(--text-body);
}

.context-menu.chrome .context-menu-shortcut {
  font-size: var(--text-body-sm);
}

.context-menu-item.focused:not(.disabled) {
  background-color: var(--vscode-bg-active);
  color: var(--vscode-text-light);
}

.context-menu-item.disabled {
  color: var(--vscode-text-muted);
  opacity: 0.55;
  cursor: default;
}

/* A literal filename inside a label (`.kicad_sym`, `.pretty/`). Monospace is the
   cue that it names a thing on disk; inheriting color keeps it from competing
   with the focused/disabled row states. */
.context-menu-code {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 0.92em;
  color: inherit;
}

.context-menu-divider {
  height: 1px;
  background-color: var(--vscode-border);
  margin: 4px 0;
}

/* A section title, deliberately unlike a disabled item: uppercase and tracked
   out so it reads as a label rather than a command that happens to be off. */
.context-menu-header {
  padding: 6px 12px 3px;
  color: var(--vscode-text-muted);
  font-size: var(--text-caption);
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.context-menu-shortcut {
  color: var(--vscode-text-muted);
  font-size: var(--text-caption);
}

.context-menu-caret,
.context-menu-check {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  color: var(--vscode-text-muted);
}

/* A swatched shortcut names a layer: data, so mono, and left in a column wide
   enough for In30.Cu, so rows' chips line up whatever the names' lengths. */
.context-menu-shortcut.has-swatch {
  min-width: calc(18px + 7ch);
  font-family: var(--font-mono, monospace);
  text-align: left;
}

/* Beside the choice it opens on, closer than the label's gap: one trailing group. */
.context-menu-shortcut + .context-menu-caret {
  margin-left: -18px;
}

.context-menu-check {
  color: var(--vscode-accent);
}
</style>
