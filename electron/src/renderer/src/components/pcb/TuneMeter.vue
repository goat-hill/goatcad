<script setup lang="ts">
/**
 * The tuner's status at the cursor (router-behavior.md T4), KiCad's tuning
 * status popup made a meter: the length (skew) over a bar whose band is the
 * min to the max, the opt ticked and the value a needle. With no target it is
 * the length alone. A time-domain tune (T2) reads in ps throughout.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { LengthUnit } from '../../lib/kicad/coordinates'
import { mmToSpacing } from '../../lib/kicad/coordinates'
import {
  delayAt,
  type TuneMode,
  type TuneStatus,
  type TuneTarget,
  type TuneTimeScale
} from '../../lib/board/router/tuning'
import { tuneMeterScale } from '../../lib/board/tuneMeter'

const props = defineProps<{
  mode: TuneMode
  net: string
  /** The length, or the skew for a skew tune, mm. */
  value: number
  target: TuneTarget
  status: TuneStatus
  unit: LengthUnit
  /** Where the tune holds a delay: how it follows the length. */
  time?: TuneTimeScale | null
}>()

const { t } = useI18n()

/** Fixed decimals so the digits hold still as the cursor moves. */
const DECIMALS: Record<LengthUnit, number> = { mm: 3, mil: 1, in: 4 }
const fmt = (mm: number): string =>
  props.time
    ? delayAt(props.time, mm).toFixed(2)
    : mmToSpacing(mm, props.unit).toFixed(DECIMALS[props.unit])
const unitLabel = computed(() => (props.time ? 'ps' : props.unit))

const title = computed(() =>
  props.mode === 'skew'
    ? t('pcbEditor.tune.skew')
    : props.mode === 'pair'
      ? props.time
        ? t('pcbEditor.tune.meter.pairDelay')
        : t('pcbEditor.tune.meter.pairLength')
      : props.time
        ? t('pcbEditor.tune.meter.delay')
        : t('pcbEditor.tune.length')
)
const scale = computed(() => tuneMeterScale(props.value, props.target))
const pct = (f: number): string => `${(f * 100).toFixed(2)}%`
</script>

<template>
  <div class="tune-meter" :class="{ off: scale && status !== 'tuned' }" data-testid="tune-meter">
    <div class="tune-meter-head">
      <span class="tune-meter-title">{{ title }}</span>
      <span class="tune-meter-net">{{ net }}</span>
    </div>
    <div class="tune-meter-reading">
      <span class="tune-meter-value">{{ fmt(value) }}</span>
      <span class="tune-meter-unit">{{ unitLabel }}</span>
    </div>
    <template v-if="scale">
      <div class="tune-meter-bar">
        <div
          class="tune-meter-band"
          :style="{ left: pct(scale.band[0]), width: pct(scale.band[1] - scale.band[0]) }"
        ></div>
        <div class="tune-meter-opt" :style="{ left: pct(scale.opt) }"></div>
        <div class="tune-meter-needle" :style="{ left: pct(scale.needle) }"></div>
      </div>
      <div class="tune-meter-bounds">
        <span>{{ t('pcbEditor.tune.min') }} {{ fmt(target.min) }}</span>
        <span>{{ t('pcbEditor.tune.max') }} {{ fmt(target.max) }}</span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.tune-meter {
  width: 208px;
  padding: 8px 10px;
  border: 1px solid var(--vscode-border);
  border-radius: 6px;
  background: var(--vscode-overlay-strong);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  color: var(--vscode-text-muted);
  font-size: var(--text-caption);
  pointer-events: none;
  --meter-state: var(--vscode-success);
}

.tune-meter.off {
  --meter-state: var(--vscode-warning);
}

.tune-meter-head {
  display: flex;
  gap: 6px;
  align-items: baseline;
  min-width: 0;
}

.tune-meter-title {
  color: var(--vscode-text);
  font-weight: 600;
}

.tune-meter-net {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tune-meter-reading {
  display: flex;
  gap: 4px;
  align-items: baseline;
  margin-top: 2px;
}

.tune-meter-value {
  color: var(--vscode-text-light);
  font-family: var(--font-mono);
  font-size: var(--text-heading);
}

.tune-meter-bar {
  position: relative;
  height: 8px;
  margin: 8px 0 4px;
  border-radius: 4px;
  background: var(--vscode-overlay-control-hover);
}

.tune-meter-band {
  position: absolute;
  top: 0;
  bottom: 0;
  min-width: 3px;
  border-radius: 4px;
  background: var(--vscode-success-subtle);
  box-shadow: inset 0 0 0 1px var(--vscode-success);
}

.tune-meter-opt {
  position: absolute;
  top: 1px;
  bottom: 1px;
  width: 1px;
  background: var(--vscode-success);
}

.tune-meter-needle {
  position: absolute;
  top: -3px;
  bottom: -3px;
  width: 3px;
  margin-left: -1.5px;
  border-radius: 2px;
  background: var(--meter-state);
  box-shadow: 0 0 0 1px var(--vscode-overlay-strong);
}

@media (prefers-reduced-motion: no-preference) {
  .tune-meter-needle,
  .tune-meter-band,
  .tune-meter-opt {
    transition:
      left 80ms ease-out,
      width 80ms ease-out;
  }
}

.tune-meter-bounds {
  display: flex;
  justify-content: space-between;
  font-family: var(--font-mono);
}
</style>
