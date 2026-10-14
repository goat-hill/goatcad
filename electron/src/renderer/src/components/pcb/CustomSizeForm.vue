<script setup lang="ts">
/**
 * Sizes typed in, at the point it opened from: the route's custom track and
 * via size (docs/router-behavior.md S6, KiCad's Custom Track/Via Size) and a
 * differential pair's dimensions (PR6, KiCad's Differential Pair
 * Dimensions). Enter or Apply takes the numbers when each is a positive
 * size; Escape or a click away leaves them. Millimeters, as every size the
 * router shows.
 */
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

export interface SizeField {
  key: string
  label: string
  value: number
  /** Zero is a value here (a target of none, square corners). */
  zero?: boolean
  /** Shown after the number; millimeters when unset. */
  unit?: string
  /** A yes or no, as 1 or 0: drawn as a checkbox. */
  toggle?: boolean
}

const props = defineProps<{
  x: number
  y: number
  title: string
  fields: SizeField[]
  /** A further check on the numbers, all positive: a via's drill under its diameter. */
  valid?: (values: Record<string, number>) => boolean
}>()

const emit = defineEmits<{
  (e: 'apply', values: Record<string, number>): void
  (e: 'close'): void
}>()

const { t } = useI18n()

const texts = ref<Record<string, string>>(
  Object.fromEntries(props.fields.map((f) => [f.key, String(f.value)]))
)
const first = ref<HTMLInputElement[] | null>(null)

onMounted(() => {
  const input = first.value?.[0]
  input?.focus()
  input?.select()
})

const parsed = (text: string, zero: boolean): number | null => {
  const value = Number(text.trim().replace(',', '.'))
  return Number.isFinite(value) && (value > 0 || (zero && value === 0)) ? value : null
}

const toggles = ref<Record<string, boolean>>(
  Object.fromEntries(props.fields.filter((f) => f.toggle).map((f) => [f.key, f.value > 0]))
)

const apply = (): void => {
  const values: Record<string, number> = {}
  for (const f of props.fields) {
    if (f.toggle) {
      values[f.key] = toggles.value[f.key] ? 1 : 0
      continue
    }
    const v = parsed(texts.value[f.key] ?? '', f.zero ?? false)
    if (v === null) return
    values[f.key] = v
  }
  if (props.valid && !props.valid(values)) return
  emit('apply', values)
}
</script>

<template>
  <div class="custom-size-backdrop" @mousedown.self="emit('close')">
    <form
      class="custom-size"
      :style="{ left: `${x}px`, top: `${y}px` }"
      @submit.prevent="apply"
      @keydown.esc.stop.prevent="emit('close')"
    >
      <div class="custom-size-title">{{ title }}</div>
      <template v-for="f in fields" :key="f.key">
        <label v-if="f.toggle" class="custom-size-toggle">
          <input v-model="toggles[f.key]" type="checkbox" />
          <span>{{ f.label }}</span>
        </label>
        <label v-else class="custom-size-row">
          <span>{{ f.label }}</span>
          <input ref="first" v-model="texts[f.key]" class="field-sm" inputmode="decimal" />
          <span class="unit">{{ f.unit ?? 'mm' }}</span>
        </label>
      </template>
      <div class="custom-size-actions">
        <button type="button" class="btn-subtle btn-md" @click="emit('close')">
          {{ t('common.cancel') }}
        </button>
        <button type="submit" class="btn-outline btn-md">
          {{ t('pcbEditor.viewport.sizes.customApply') }}
        </button>
      </div>
    </form>
  </div>
</template>

<style scoped>
.custom-size-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1000;
}

.custom-size {
  position: fixed;
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 240px;
  padding: 10px;
  border: 1px solid var(--vscode-border);
  border-radius: 4px;
  background: var(--vscode-bg-dropdown);
  box-shadow: 0 4px 8px var(--vscode-shadow-float);
}

.custom-size-title {
  color: var(--vscode-text-muted);
  font-size: var(--text-caption);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.custom-size-row {
  display: grid;
  grid-template-columns: 1fr 72px auto;
  align-items: center;
  gap: 6px;
  color: var(--vscode-text);
}

.custom-size-row input {
  min-width: 0;
  font-family: var(--font-mono);
  text-align: right;
}

.custom-size-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--vscode-text);
}

.unit {
  color: var(--vscode-text-muted);
}

.custom-size-actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
  margin-top: 4px;
}
</style>
