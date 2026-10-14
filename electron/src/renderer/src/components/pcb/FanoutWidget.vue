<script setup lang="ts">
/**
 * Fan out, as a canvas overlay in the top-right slot beside Find: the
 * settings, what they would place on the selected footprint right now (the
 * planner is pure, so the preview is the plan itself), and every pad that
 * cannot take a via, with why. The editor owns the plan and the write
 * (`lib/board/fanout.ts`); this draws them. Escape closes.
 */
import { computed, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '../shared/Icon.vue'
import { matchesHotkey } from '../../lib/hotkeys'
import {
  FANOUT_DIRECTIONS,
  FANOUT_STYLES,
  type FanoutDirection,
  type FanoutOutcome,
  type FanoutPlan,
  type FanoutStyle
} from '../../lib/board/fanout'

export interface FanoutSettings {
  style: FanoutStyle
  direction: FanoutDirection
  surfaceRows: number
}

const settings = defineModel<FanoutSettings>('settings', { required: true })

const props = defineProps<{
  /** The footprint's reference. */
  reference: string | null
  /** The plan for the settings as they stand; null with nothing to plan. */
  preview: FanoutOutcome | null
  /** The plan last written, until the settings or the footprint change. */
  applied: FanoutPlan | null
  readOnly?: boolean
}>()

const emit = defineEmits<{
  (e: 'apply'): void
  (e: 'close'): void
}>()

const { t } = useI18n()

/** What the rows describe: the written plan once there is one, else the preview. */
const plan = computed(
  (): FanoutPlan | null => props.applied ?? (props.preview?.ok ? props.preview.plan : null)
)
const error = computed(() => (props.preview && !props.preview.ok ? props.preview.detail : null))

/** A pad of this footprint named by its number: the overlay already says which part. */
const local = (text: string): string =>
  props.reference ? text.replaceAll(`${props.reference}.`, '') : text

const SKIP_REASONS = ['no net', 'no-connect', 'through-hole', 'joined', 'via'] as const
const skippedByReason = computed(() => {
  const counts = new Map<string, number>()
  // A no-connect is left open on purpose: nothing to say about it.
  for (const row of plan.value?.skipped ?? []) {
    if (row.reason === 'no-connect') continue
    counts.set(row.reason, (counts.get(row.reason) ?? 0) + 1)
  }
  return [...counts].map(([reason, count]) => ({
    count,
    label: (SKIP_REASONS as readonly string[]).includes(reason)
      ? t(`pcbEditor.fanout.skip.${reason.replace(' ', '-')}`)
      : reason
  }))
})

const summary = computed(() => {
  const p = plan.value
  if (!p) return ''
  return props.applied
    ? t('pcbEditor.fanout.placed', p.escapes.length)
    : t('pcbEditor.fanout.willPlace', p.escapes.length)
})

const canApply = computed(
  () => !props.readOnly && !props.applied && !!plan.value && plan.value.escapes.length > 0
)

const set = <K extends keyof FanoutSettings>(key: K, value: FanoutSettings[K]): void => {
  settings.value = { ...settings.value, [key]: value }
}
const onRows = (event: Event): void => {
  const value = Math.round(Number((event.target as HTMLInputElement).value))
  set('surfaceRows', Number.isFinite(value) ? Math.min(8, Math.max(0, value)) : 0)
}

// Keys from inside it: Enter runs it — a surface-rows value typed and not yet
// committed is committed first — and Escape closes it. Neither reaches the
// editor, whose Escape would drop the selection the overlay is working on.
const onKeydown = (event: KeyboardEvent): void => {
  if (matchesHotkey(event, 'pcb.finish')) {
    event.stopPropagation()
    event.preventDefault()
    const target = event.target as HTMLElement
    if (target instanceof HTMLInputElement && target.type === 'number') onRows(event)
    // After the settings land, so the plan run is the one for them.
    void nextTick(() => emit('apply'))
  } else if (matchesHotkey(event, 'editor.cancel')) {
    event.stopPropagation()
    event.preventDefault()
    emit('close')
  }
}
</script>

<template>
  <div class="fanout" tabindex="-1" @mousedown.stop @keydown="onKeydown">
    <div class="fanout-head">
      <span class="fanout-title">
        {{ t('pcbEditor.fanout.title') }}
        <span v-if="reference" class="fanout-ref">{{ reference }}</span>
      </span>
      <button
        type="button"
        class="fanout-close"
        :title="t('editorArea.find.close')"
        @click="emit('close')"
      >
        <Icon name="close-sm" />
      </button>
    </div>

    <div class="fanout-settings">
      <label class="fanout-setting">
        <span>{{ t('pcbEditor.fanout.style') }}</span>
        <select
          class="field-sm"
          :value="settings.style"
          @change="set('style', ($event.target as HTMLSelectElement).value as FanoutStyle)"
        >
          <option v-for="style in FANOUT_STYLES" :key="style" :value="style">
            {{ t(`pcbEditor.fanout.styles.${style}`) }}
          </option>
        </select>
      </label>
      <label class="fanout-setting">
        <span>{{ t('pcbEditor.fanout.direction') }}</span>
        <select
          class="field-sm"
          :value="settings.direction"
          @change="set('direction', ($event.target as HTMLSelectElement).value as FanoutDirection)"
        >
          <option v-for="direction in FANOUT_DIRECTIONS" :key="direction" :value="direction">
            {{ t(`pcbEditor.fanout.directions.${direction}`) }}
          </option>
        </select>
      </label>
      <label class="fanout-setting" :title="t('pcbEditor.fanout.surfaceRowsHint')">
        <span>{{ t('pcbEditor.fanout.surfaceRows') }}</span>
        <input
          class="field-sm"
          type="number"
          min="0"
          max="8"
          step="1"
          :value="settings.surfaceRows"
          @change="onRows"
        />
      </label>
    </div>

    <p v-if="error" class="fanout-note fanout-error">{{ local(error) }}</p>
    <template v-else-if="plan">
      <div class="fanout-summary">
        <span>{{ summary }}</span>
        <span v-for="row in skippedByReason" :key="row.label" class="fanout-muted">
          · {{ t('pcbEditor.fanout.skipped', { count: row.count, reason: row.label }) }}
        </span>
        <span v-if="plan.surface.length" class="fanout-muted">
          · {{ t('pcbEditor.fanout.surface', plan.surface.length) }}
        </span>
      </div>
      <template v-if="plan.refused.length">
        <div class="fanout-warning">
          <Icon name="status-warning" />
          {{ t('pcbEditor.fanout.refused', plan.refused.length) }}
        </div>
        <ul class="fanout-refused">
          <li v-for="row in plan.refused" :key="row.pad">
            <span class="fanout-pad">{{ local(row.pad) }}</span>
            <span class="fanout-reason">{{ local(row.reason) }}</span>
          </li>
        </ul>
      </template>
    </template>

    <div class="fanout-actions">
      <button type="button" class="btn-cta btn-sm" :disabled="!canApply" @click="emit('apply')">
        {{ t('pcbEditor.fanout.apply') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
/* The Find widget's chrome (CanvasFindWidget.vue), grown down: the canvas's
   top-right slot, 8px radius, the overlay ground. Its height is the canvas's
   at most; the failures scroll inside it. */
.fanout {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 380px;
  max-height: calc(100vh - 220px);
  padding: 4px 12px 12px;
  border: 1px solid var(--vscode-border);
  border-radius: 8px;
  background: var(--vscode-overlay);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  box-shadow: 0 4px 20px var(--vscode-shadow-float);
  font-size: var(--text-body-sm);
  color: var(--vscode-text);
  outline: none;
}

.fanout-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 32px;
}

.fanout-title {
  font-size: var(--text-body);
  font-weight: 600;
}

.fanout-ref {
  margin-left: 4px;
  font-family: var(--font-mono);
  font-weight: 400;
  color: var(--vscode-text-muted);
}

/* The Find widget's close: a 28px square target. */
.fanout-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  margin-right: -8px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 4px;
  background: transparent;
  color: var(--vscode-text-muted);
  cursor: pointer;
}

.fanout-close:hover {
  background-color: var(--vscode-bg-hover);
  color: var(--vscode-text);
}

.fanout-close :deep(svg) {
  width: 14px;
  height: 14px;
}

.fanout-settings {
  display: grid;
  grid-template-columns: 1fr 1fr 88px;
  gap: 8px;
}

.fanout-setting {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  color: var(--vscode-text-muted);
}

.fanout-setting .field-sm {
  width: 100%;
  min-width: 0;
}

.fanout-note {
  margin: 0;
  color: var(--vscode-text-muted);
}

.fanout-error {
  color: var(--vscode-warning);
}

.fanout-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 0 4px;
}

.fanout-muted {
  color: var(--vscode-text-muted);
}

/* A warning, as Find's notice row draws one: the glyph and the tint, so it
   reads without the hue. */
.fanout-warning {
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--vscode-warning);
}

.fanout-warning :deep(svg) {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
}

.fanout-refused {
  flex: 1 1 auto;
  min-height: 48px;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;
  border-top: 1px solid var(--vscode-border);
}

.fanout-refused li {
  display: flex;
  gap: 8px;
  padding: 4px 0;
  border-bottom: 1px solid var(--vscode-border);
}

.fanout-pad {
  flex: none;
  min-width: 32px;
  font-family: var(--font-mono);
}

.fanout-reason {
  color: var(--vscode-text-muted);
}

.fanout-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}
</style>
