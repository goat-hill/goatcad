<script setup lang="ts">
/**
 * A status-strip pill that opens a panel above itself — the shell behind the
 * viewport's Grid and Filter controls.
 *
 * It exists because both controls answer the same problem. Each used to be a
 * `CollapsiblePanel` in the right rail, behind a rail that can itself be hidden,
 * so a setting you had changed was routinely off screen while it went on
 * affecting every click. Putting the control in the viewport, beside the readout
 * it governs, makes the setting visible where its effect is.
 *
 * The behavior is shared rather than copied, because it is the part with edges:
 * dismissal, pinning, Escape, and not eating the click that dismisses it.
 *
 * Pinning moves the panel into the editor's right bar (`RailPinnedPanels`) and
 * takes the pill away; the bar's header unpins it back here. Where it is, is a
 * layout preference kept in `panelLayout.ts`, so it survives tab switches and
 * restarts as panel sizes do.
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from './Icon.vue'
import type { IconName } from '../../lib/icons'
import {
  panelPinned,
  setPanelPinned,
  type PanelLayoutEditor,
  type PinnablePanel
} from '../../lib/panelLayout'

const { t } = useI18n()

const props = withDefaults(
  defineProps<{
    /** Text on the pill. */
    label: string
    title: string
    /** Heading inside the popover. */
    panelTitle: string
    /** Gold pill — a state report about the SETTING, never "the popover is open". */
    active?: boolean
    /** Registry glyph left of the label, naming what the pill governs. */
    icon?: IconName
    /** A color chip in place of the glyph (the active layer's). */
    swatch?: string
    /** Which editor's right bar a pin moves this panel into; omit both for a pill that never pins. */
    editor?: PanelLayoutEditor
    panel?: PinnablePanel
    /** Bumped to flash the pill for a moment — only while the popover is shut. */
    flash?: number
    /** Hold the pill to the corner's standard minimum width (`.steady-width`). */
    steady?: boolean
  }>(),
  {
    active: false,
    icon: undefined,
    swatch: undefined,
    editor: undefined,
    panel: undefined,
    flash: 0,
    steady: false
  }
)

const open = ref(false)
const root = ref<HTMLElement | null>(null)
const pinnable = props.editor !== undefined && props.panel !== undefined
const pinned = computed(() =>
  props.editor && props.panel ? panelPinned(props.editor, props.panel).value : false
)

const FLASH_MS = 700
const flashing = ref(false)
let flashTimer: ReturnType<typeof setTimeout> | null = null
watch(
  () => props.flash,
  () => {
    if (open.value) return
    // Off then on, so a second flash inside the first restarts the animation.
    flashing.value = false
    if (flashTimer) clearTimeout(flashTimer)
    requestAnimationFrame(() => {
      flashing.value = true
      flashTimer = setTimeout(() => (flashing.value = false), FLASH_MS)
    })
  }
)
onBeforeUnmount(() => {
  if (flashTimer) clearTimeout(flashTimer)
})

const pin = (): void => {
  open.value = false
  if (props.editor && props.panel) setPanelPinned(props.editor, props.panel, true)
}

/** For the content: a menu closes on its pick. */
const close = (): void => {
  open.value = false
}

/**
 * Dismiss on the next interaction with the drawing, which is what a popover over
 * a canvas owes you: you opened it to change a setting, and the next thing you
 * do is look at the result. `mousedown` covers a click and the start of a pan,
 * `wheel` covers zoom.
 *
 * Capture phase on `window`, because the canvas swallows its own pointer events
 * — a bubble-phase listener would never see the pan that should dismiss this.
 * Events inside the control are exempt, so changing a setting does not close the
 * panel holding it.
 */
const onOutsideInteraction = (event: Event): void => {
  const target = event.target
  if (target instanceof Node && root.value?.contains(target)) return
  open.value = false
}

const listen = (on: boolean): void => {
  const fn = on ? window.addEventListener : window.removeEventListener
  fn('mousedown', onOutsideInteraction, true)
  fn('wheel', onOutsideInteraction, true)
}

watch(open, listen)
onBeforeUnmount(() => listen(false))

const onKeydown = (event: KeyboardEvent): void => {
  if (event.key !== 'Escape' || !open.value) return
  open.value = false
}
</script>

<template>
  <div v-if="!pinned" ref="root" class="viewport-popover-control" @keydown="onKeydown">
    <button
      type="button"
      class="viewport-pill popover-trigger"
      :class="{ active, open, flashing, 'steady-width': steady }"
      :aria-expanded="open"
      :title="title"
      @click="open = !open"
    >
      <span v-if="swatch" class="trigger-swatch" :style="{ background: swatch }" />
      <Icon v-else-if="icon" :name="icon" class="trigger-glyph" />
      {{ label }}
    </button>

    <div v-if="open" class="viewport-popover">
      <div class="popover-header">
        <span class="popover-title">{{ panelTitle }}</span>
        <button
          v-if="pinnable"
          type="button"
          class="popover-pin"
          :title="t('shared.viewportPopover.pin')"
          @click="pin"
        >
          <Icon name="pin" class="pin-glyph" />
        </button>
      </div>
      <slot :close="close" />
    </div>
  </div>
</template>

<style scoped>
.viewport-popover-control {
  position: relative;
  display: flex;
  align-items: center;
  /* The corner is inert so its text cannot eat canvas clicks. */
  pointer-events: auto;
}

/* `.viewport-pill` (assets/main.css) carries the shared chrome, so this pill and
   the readout beside it cannot drift in height. What a CONTROL adds on top: a
   button's weight (DESIGN.md §3), a pointer, and a touch less left padding to
   seat the glyph. */
.popover-trigger {
  padding-left: 10px;
  font-family: inherit;
  font-weight: 600;
  cursor: pointer;
}

.popover-trigger:hover,
.popover-trigger.open {
  color: var(--vscode-text);
  border-color: var(--vscode-text-muted);
}

/* Gold reports the SETTING's state, not the popover's. */
.popover-trigger.active {
  background: var(--vscode-accent, #cca250);
  border-color: var(--vscode-accent, #cca250);
  color: var(--vscode-on-accent);
}

.popover-trigger.active:hover {
  filter: brightness(1.12);
}

.trigger-glyph {
  width: 14px;
  height: 14px;
}

.trigger-swatch {
  width: 10px;
  height: 10px;
  border-radius: 2px;
  flex: none;
}

/* A click the setting turned away: the pill lights for a moment. */
.popover-trigger.flashing {
  color: var(--vscode-text);
  border-color: var(--vscode-accent, #cca250);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--vscode-accent, #cca250) 45%, transparent);
}

@media (prefers-reduced-motion: no-preference) {
  .popover-trigger.flashing {
    animation: popover-trigger-flash 0.7s ease-out;
  }
}

@keyframes popover-trigger-flash {
  0%,
  40% {
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--vscode-accent, #cca250) 60%, transparent);
  }
  100% {
    box-shadow: 0 0 0 0 transparent;
  }
}

/* Above the pill and right-aligned to it, since the corner hugs the edge. */
.viewport-popover {
  position: absolute;
  right: 0;
  bottom: calc(100% + 6px);
  min-width: 230px;
  padding: 8px 10px 10px;
  border: 1px solid var(--vscode-border, #24302b);
  border-radius: 6px;
  background: var(--vscode-overlay);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  box-shadow: 0 4px 20px var(--vscode-shadow-float);
  font-family: var(--font-ui, inherit);
  /* Set here, not left to the app default: the panels inside style their own
     rows but not every element, and an uncovered one would render at 13px
     beside 12px neighbours. One size for the whole corner, the pills' own. */
  font-size: var(--text-body-sm);
  cursor: default;
}

.popover-header {
  display: flex;
  /* The pin's height, so a pill that never pins heads its panel the same. */
  min-height: 24px;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}

.popover-title {
  color: var(--vscode-text-muted);
  font-size: var(--text-caption);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.popover-pin {
  display: flex;
  align-items: center;
  justify-content: center;
  /* DESIGN.md's 24px minimum target. */
  width: 24px;
  height: 24px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 3px;
  background: none;
  color: var(--vscode-text-muted);
  cursor: pointer;
}

.popover-pin .pin-glyph {
  width: 12px;
  height: 12px;
}

.popover-pin:hover {
  color: var(--vscode-text);
  border-color: var(--vscode-border, #24302b);
}

@media (prefers-reduced-motion: no-preference) {
  .popover-trigger,
  .popover-pin {
    transition:
      color 0.12s ease,
      filter 0.12s ease;
  }
}
</style>
