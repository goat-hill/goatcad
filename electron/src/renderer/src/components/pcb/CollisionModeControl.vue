<script setup lang="ts">
/**
 * The router's mode: a pill in the board's corner, beside Grid and Filter,
 * whose popover is a menu of KiCad's three modes — a glyph and the name, with
 * what it does on hover where the name does not say it — so any mode is two
 * clicks away. It never pins: one choice is not a panel worth a place in the
 * right bar.
 *
 * In the corner rather than on the route toolbar because it governs more than
 * the route tool: a track drag (`D`, or a press-drag on a lone track) runs
 * through the same router, and a mode shown only while routing left drags
 * running in one nobody could see. Not on the view rail either — the rail
 * changes what is seen, and this changes what an edit does.
 *
 * Gold only in Highlight with *Allow DRC violations* on: the one setting that
 * can put a clearance error on the board (docs/router-behavior.md, collision
 * modes).
 *
 * The router's switches — KiCad's Interactive Router Settings — sit under the
 * mode they govern: Push's own under Push, Highlight's under Highlight (KiCad's
 * dialog greys them out in the other modes), the rest below the modes. Each
 * explains itself on hover where its name does not. The menu stays open while
 * they are flipped; a mode choice closes it.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import ViewportPopover from '../shared/ViewportPopover.vue'
import Icon from '../shared/Icon.vue'
import {
  commitsViolations,
  pcbRouterState,
  ROUTER_MODES,
  routerSettings,
  setPcbRouter,
  setRouterSetting,
  type PcbRouterMode,
  type PcbRouterSettings
} from '../../lib/pcbRouter'

const { t } = useI18n()

const router = pcbRouterState()

const modeName = (mode: PcbRouterMode): string => t(`pcbEditor.viewport.routeModes.${mode}`)

const surprising = computed(() => commitsViolations(router.value))

const settings = computed(() => routerSettings(router.value))

/** The switches only one mode reads, in KiCad's dialog order, listed under it. */
const MODE_SWITCHES: Partial<Record<PcbRouterMode, ReadonlyArray<keyof PcbRouterSettings>>> = {
  shove: ['shoveVias', 'jumpOverObstacles'],
  highlight: ['allowViolations', 'freeAngle']
}

/** The switches every mode reads, in KiCad's dialog order; start-diagonal only while the posture is not the mouse's. */
const switches = computed<Array<keyof PcbRouterSettings>>(() => [
  'removeLoops',
  'smartPads',
  'smoothDragged',
  'optimizeDragged',
  'autoPosture',
  ...(settings.value.autoPosture ? [] : (['startDiagonal'] as const)),
  'fixAllSegments'
])

/** What a mode does, on hover, for the mode whose name does not say it. */
const modeTitle = (mode: PcbRouterMode): string | undefined =>
  mode === 'highlight' ? t('pcbEditor.collision.explain.highlight') : undefined

/** What a switch does, on hover; Push vias says it in its name. */
const settingTitle = (key: keyof PcbRouterSettings): string | undefined =>
  key === 'shoveVias' ? undefined : t(`pcbEditor.collision.settings.${key}.note`)

const choose = (mode: PcbRouterMode, close: () => void): void => {
  setPcbRouter({ mode })
  close()
}
</script>

<template>
  <ViewportPopover
    :icon="surprising ? 'route-ignore' : `route-${router.mode}`"
    :label="modeName(router.mode)"
    :title="t('pcbEditor.collision.buttonTitle')"
    :panel-title="t('pcbEditor.collision.title')"
    :active="surprising"
  >
    <template #default="{ close }">
      <div class="router-modes" role="menu">
        <template v-for="mode in ROUTER_MODES" :key="mode">
          <button
            type="button"
            role="menuitemradio"
            class="router-mode"
            :class="{ current: mode === router.mode }"
            :aria-checked="mode === router.mode"
            :title="modeTitle(mode)"
            @click="choose(mode, close)"
          >
            <Icon :name="`route-${mode}`" class="mode-glyph" />
            <span class="mode-name">{{ modeName(mode) }}</span>
          </button>
          <div
            v-if="MODE_SWITCHES[mode]"
            class="mode-settings"
            role="group"
            :aria-label="modeName(mode)"
          >
            <label
              v-for="key in MODE_SWITCHES[mode]"
              :key="key"
              class="router-setting"
              :class="{ warn: key === 'allowViolations' && settings[key] }"
              :title="settingTitle(key)"
            >
              <input
                type="checkbox"
                :checked="settings[key]"
                @change="setRouterSetting(key, ($event.target as HTMLInputElement).checked)"
              />
              <span class="setting-name">{{ t(`pcbEditor.collision.settings.${key}.name`) }}</span>
            </label>
          </div>
        </template>
      </div>
      <div
        class="router-settings"
        role="group"
        :aria-label="t('pcbEditor.collision.settingsTitle')"
      >
        <div class="settings-title">{{ t('pcbEditor.collision.settingsTitle') }}</div>
        <label v-for="key in switches" :key="key" class="router-setting" :title="settingTitle(key)">
          <input
            type="checkbox"
            :checked="settings[key]"
            @change="setRouterSetting(key, ($event.target as HTMLInputElement).checked)"
          />
          <span class="setting-name">{{ t(`pcbEditor.collision.settings.${key}.name`) }}</span>
        </label>
      </div>
    </template>
  </ViewportPopover>
</template>

<style scoped>
.router-modes {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 240px;
}

.router-mode {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 8px;
  border: 1px solid transparent;
  border-radius: 4px;
  background: none;
  color: var(--vscode-text);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.router-mode:hover {
  background: var(--vscode-bg-hover);
}

.router-mode.current {
  background: var(--vscode-bg-active);
  border-color: var(--vscode-border);
}

.mode-glyph {
  flex: none;
  width: 20px;
  height: 20px;
  color: var(--vscode-text-muted);
}

.router-mode.current .mode-glyph {
  color: var(--vscode-accent, #cca250);
}

.mode-name {
  font-weight: 600;
}

/* Push's own switches, indented to its name: they belong to the row above. */
.mode-settings {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-left: 30px;
}

/* The one switch that commits violations names itself in the warning color while on. */
.router-setting.warn .setting-name {
  color: var(--vscode-warning);
}

.router-settings {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 240px;
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid var(--vscode-border);
}

.settings-title {
  padding: 2px 8px;
  color: var(--vscode-text-muted);
  font-size: var(--text-caption);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.router-setting {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 8px;
  border-radius: 4px;
  cursor: pointer;
}

.router-setting:hover {
  background: var(--vscode-bg-hover);
}

.router-setting input {
  flex: none;
  margin: 0;
}

.setting-name {
  color: var(--vscode-text);
}
</style>
