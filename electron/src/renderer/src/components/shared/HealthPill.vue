<script setup lang="ts">
/**
 * The design-health pill: the last control in a viewport's bottom-right corner,
 * counting what the editor's checks found. Clicking it opens the findings
 * drawer (`FindingsDrawer.vue`); design in `docs/design-health-workstream.md`.
 *
 * Before the first check finishes it shows the checklist glyph; once a check
 * has found nothing, the check mark instead, so a pass is told from not yet
 * checked.
 *
 * An editor with no checker shows the unchecked pill, so the corner reads the same
 * in all four editors; clicking it says in a note above it that the checks are
 * not built yet, instead of opening an empty drawer.
 *
 * While a check runs past the loading threshold (DESIGN.md §Loading feedback),
 * its progress fills the pill's border clockwise from the top, or, from an
 * editor that cannot measure it, a faint light travels round the border until
 * it finishes; the counts are the last finished check's meanwhile. A check
 * quicker than the threshold shows nothing.
 *
 * Pinned (the drawer's pin), the findings live in the right bar instead and
 * this pill is gone.
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from './Icon.vue'
import { healthCounts, type HealthReport } from '../../lib/designHealth'
import { delayedVisible } from '../../lib/delayedVisible'
import type { MessageKey } from '../../lib/messageKey'
import { panelPinned, type PanelLayoutEditor } from '../../lib/panelLayout'

const { t } = useI18n()

const props = defineProps<{
  editor: PanelLayoutEditor
  report: HealthReport
  /** The drawer is open: the pill reads as pressed. */
  open: boolean
  /** What to say when the editor has no checker: a message key of the caller's. */
  unavailableNote?: MessageKey
  /** A check is running; shown only once it outlasts the loading threshold. */
  checking?: boolean
  /** How far the running check has got, 0–1, where the editor can tell. */
  progress?: number
}>()

const emit = defineEmits<{ (e: 'toggle'): void }>()

const pinned = panelPinned(props.editor, 'health')

const busy = delayedVisible(() => !!props.checking)
const measured = computed(() => busy.value && props.progress !== undefined)
const progressStyle = computed(() =>
  measured.value ? { '--health-progress': `${Math.round((props.progress ?? 0) * 360)}deg` } : {}
)

const counts = computed(() =>
  props.report.status === 'checked' ? healthCounts(props.report.findings) : null
)

// The note for an editor with no checker: open on click, closed by the next
// click anywhere or Escape — the popover behavior, without a panel to pin.
const noteOpen = ref(false)
const root = ref<HTMLElement | null>(null)
const onOutside = (event: Event): void => {
  if (event.target instanceof Node && root.value?.contains(event.target)) return
  noteOpen.value = false
}
const onEscape = (event: KeyboardEvent): void => {
  if (event.key === 'Escape') noteOpen.value = false
}
const listen = (on: boolean): void => {
  const fn = on ? window.addEventListener : window.removeEventListener
  fn('mousedown', onOutside, true)
  fn('wheel', onOutside, true)
  fn('keydown', onEscape, true)
}
watch(noteOpen, listen)
onBeforeUnmount(() => listen(false))

const onClick = (): void => {
  if (props.report.status === 'unavailable') noteOpen.value = !noteOpen.value
  else emit('toggle')
}
</script>

<template>
  <div v-if="!pinned" ref="root" class="health-pill-control">
    <button
      type="button"
      class="viewport-pill steady-width health-pill"
      :class="{ open: open || noteOpen, checking: busy, measured }"
      :style="progressStyle"
      :aria-pressed="report.status !== 'unavailable' ? open : undefined"
      :aria-busy="busy || undefined"
      :title="t('designHealth.pill.title')"
      @click="onClick"
    >
      <template v-if="counts === null || (counts.errors === 0 && counts.warnings === 0)">
        <Icon :name="counts === null ? 'checklist' : 'status-ok'" class="glyph" />
        {{ t('designHealth.pill.clean') }}
      </template>
      <template v-else>
        <span
          v-if="counts.errors"
          class="segment error"
          :aria-label="t('designHealth.pill.errors', counts.errors)"
        >
          <Icon name="status-error" class="glyph" />
          <span class="viewport-pill-value">{{ counts.errors }}</span>
        </span>
        <span
          v-if="counts.warnings"
          class="segment warning"
          :aria-label="t('designHealth.pill.warnings', counts.warnings)"
        >
          <Icon name="status-warning" class="glyph" />
          <span class="viewport-pill-value">{{ counts.warnings }}</span>
        </span>
      </template>
    </button>

    <div v-if="noteOpen && unavailableNote" class="health-note" role="status">
      {{ t(unavailableNote) }}
    </div>
  </div>
</template>

<style scoped>
.health-pill-control {
  position: relative;
  display: flex;
  align-items: center;
  /* The corner is inert so its text cannot eat canvas clicks. */
  pointer-events: auto;
}

/* `.viewport-pill` carries the corner's chrome; a control adds a button's
   weight and a pointer (DESIGN.md §3, as ViewportPopover's trigger does). */
.health-pill {
  gap: 8px;
  padding-left: 10px;
  font-family: inherit;
  font-weight: 600;
  cursor: pointer;
}

/* Open: the pill is shaded, its border left alone, since a running check's
   progress is drawn on the border. */
.health-pill.open {
  background: var(--vscode-bg-active);
  color: var(--vscode-text);
}

/* A check running: a faint light travels round the border (the ring is the
   pill's own border box, masked to the 1 px line). Without motion, the border
   holds a quiet lighter color instead. The line is a transparent border of the
   overlay's, not padding: a border width is rounded to device pixels as the
   pill's own is, so the two coincide at any display scale. */
.health-pill.checking {
  position: relative;
}

.health-pill.checking::before {
  content: '';
  position: absolute;
  inset: -1px;
  border: 1px solid transparent;
  border-radius: inherit;
  background: var(--vscode-text-muted) border-box;
  opacity: 0.6;
  mask:
    linear-gradient(#000 0 0) padding-box exclude,
    linear-gradient(#000 0 0) border-box;
  pointer-events: none;
}

@property --health-sweep {
  syntax: '<angle>';
  inherits: false;
  initial-value: 0deg;
}

@media (prefers-reduced-motion: no-preference) {
  .health-pill.checking::before {
    opacity: 1;
    background: conic-gradient(
        from var(--health-sweep),
        transparent 0deg 250deg,
        color-mix(in srgb, var(--vscode-text) 70%, transparent) 330deg,
        transparent 360deg
      )
      border-box;
    animation: health-sweep 1.6s linear infinite;
  }
}

/* A measured check: the border fills to its progress, over the faint ring.
   Each step eases into the next so the fill moves rather than ticks. */
@property --health-progress {
  syntax: '<angle>';
  inherits: true;
  initial-value: 0deg;
}

.health-pill.checking.measured::before {
  opacity: 1;
  background: conic-gradient(
      color-mix(in srgb, var(--vscode-text) 85%, transparent) 0deg var(--health-progress),
      color-mix(in srgb, var(--vscode-text-muted) 40%, transparent) var(--health-progress) 360deg
    )
    border-box;
  animation: none;
}

@media (prefers-reduced-motion: no-preference) {
  .health-pill.checking.measured {
    transition: --health-progress 150ms linear;
  }
}

@keyframes health-sweep {
  to {
    --health-sweep: 360deg;
  }
}

.health-pill:hover {
  color: var(--vscode-text);
}

.segment {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.segment.error {
  color: var(--vscode-error);
}

.segment.warning {
  color: var(--vscode-warning);
}

.glyph {
  width: 14px;
  height: 14px;
}

.health-note {
  position: absolute;
  right: 0;
  bottom: calc(100% + 6px);
  width: max-content;
  max-width: 260px;
  padding: 8px 10px;
  border: 1px solid var(--vscode-border);
  border-radius: 6px;
  background: var(--vscode-overlay);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  box-shadow: 0 4px 20px var(--vscode-shadow-float);
  color: var(--vscode-text-muted);
  font-size: var(--text-body-sm);
  white-space: normal;
}

@media (prefers-reduced-motion: no-preference) {
  .health-pill {
    transition:
      color 0.12s ease,
      background-color 0.12s ease;
  }
}
</style>
