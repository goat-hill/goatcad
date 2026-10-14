<script setup lang="ts">
/**
 * The width a current needs on each copper layer (lib/board/traceCurrent.ts),
 * at the foot of Board Setup's Net classes. A readout: it writes nothing, so
 * what to do with a width (a class's, a custom size) stays the person's call.
 * The copper comes from the stackup, so only the current and the rise are typed.
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import PropertyValueEditor from '../shared/PropertyValueEditor.vue'
import { traceWidthForCurrent } from '../../lib/board/traceCurrent'
import type { PropertyEditValue, PropertyField } from '../../lib/propertyTable'

const props = defineProps<{
  /** The board's copper top to bottom: its thickness, mm, and its display color. */
  copper: ReadonlyArray<{ name: string; thicknessMm: number; color: string }>
}>()

const { t } = useI18n()

const amps = ref<number | null>(1)
const rise = ref<number | null>(10)

const ampsField = computed<PropertyField>(() => ({
  key: 'current',
  label: t('boardSetup.currentWidth.current'),
  editor: { kind: 'number', unit: 'A', step: 0.1, min: 0, optional: true },
  value: amps.value
}))
const riseField = computed<PropertyField>(() => ({
  key: 'rise',
  label: t('boardSetup.currentWidth.rise'),
  editor: { kind: 'number', unit: '°C', step: 1, min: 0, optional: true },
  value: rise.value
}))
/** Held as typed, cleared included: a width shows only while both are positive. */
const asInput = (value: PropertyEditValue): number | null =>
  typeof value === 'number' ? value : null
const onAmps = (value: PropertyEditValue): void => {
  amps.value = asInput(value)
}
const onRise = (value: PropertyEditValue): void => {
  rise.value = asInput(value)
}

const rows = computed(() => {
  const widths = props.copper.map((layer, i) => {
    const width = traceWidthForCurrent(
      amps.value ?? 0,
      rise.value ?? 0,
      layer.thicknessMm,
      i === 0 || i === props.copper.length - 1
    )
    return { ...layer, ...width, bad: width.widthMm !== null && !width.inRange }
  })
  // Out-of-range cells in a run share their gridlines, so each draws no top edge under another.
  return widths.map((row, i) => ({ ...row, badAbove: row.bad && !!widths[i - 1]?.bad }))
})

const mm = (value: number, digits: number): string =>
  `${Math.round(value * 10 ** digits) / 10 ** digits}`
</script>

<template>
  <div class="current-width">
    <div class="layer-table-wrap">
      <table class="layer-table sheet current-inputs">
        <thead>
          <tr>
            <th>{{ t('boardSetup.currentWidth.current') }}</th>
            <th>{{ t('boardSetup.currentWidth.rise') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td class="num">
              <PropertyValueEditor :field="ampsField" @commit="onAmps" />
            </td>
            <td class="num">
              <PropertyValueEditor :field="riseField" @commit="onRise" />
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="current-results">
      <div class="layer-table-wrap">
        <table class="layer-table sheet current-layers">
          <thead>
            <tr>
              <th>{{ t('boardSetup.currentWidth.layer') }}</th>
              <th>{{ t('boardSetup.currentWidth.copper') }}</th>
              <th>{{ t('boardSetup.currentWidth.width') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in rows" :key="row.name">
              <th scope="row">
                <span class="layer-name">
                  <span class="layer-swatch" :style="{ backgroundColor: row.color }"></span>
                  {{ row.name }}
                </span>
              </th>
              <td class="sheet-text readout">{{ mm(row.thicknessMm, 4) }} mm</td>
              <td
                class="sheet-text readout"
                :class="{ bad: row.bad, 'bad-above': row.badAbove }"
                :title="row.bad ? t('boardSetup.currentWidth.outOfRange') : undefined"
              >
                {{ row.widthMm === null ? '' : `${mm(row.widthMm, 3)} mm` }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="current-source">{{ t('boardSetup.currentWidth.source') }}</p>
    </div>
  </div>
</template>

<style scoped>
.current-width {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 20px 32px;
}

.current-inputs th,
.current-inputs td {
  width: 120px;
}

.current-layers th {
  width: 120px;
}

.current-layers td {
  width: 100px;
}

/* A computed cell: plain sheet text, mono and right-aligned as a number is. */
.readout {
  font-family: var(--font-mono);
  text-align: right;
}

/* Past the range IPC-2221 was fitted over: its gridlines in the error color, as a bad
   value's. Drawn over the grid rather than as an outline, so a run reads as one box. */
.readout.bad {
  position: relative;
}

.readout.bad::after {
  content: '';
  position: absolute;
  inset: -1px;
  border: 1px solid var(--vscode-error);
  pointer-events: none;
}

.readout.bad-above::after {
  top: 0;
  border-top: none;
}

.layer-name {
  display: flex;
  align-items: center;
  gap: 8px;
  font-family: var(--font-mono);
}

.layer-swatch {
  width: 12px;
  height: 8px;
  border-radius: 2px;
  flex: 0 0 auto;
}

.current-source {
  margin: 6px 0 0;
  color: var(--vscode-text-muted);
  font-size: var(--text-caption);
}
</style>
