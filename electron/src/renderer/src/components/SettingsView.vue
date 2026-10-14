<script setup lang="ts">
/**
 * Settings editor (`goatcad://settings`) — app preferences as a full tab.
 *
 * Preferences persist through the main-process config store: `config:update`
 * writes and broadcasts `config:changed` to every window, so a change made here
 * lands in other windows too. That makes main the single source of truth; this
 * view only records choices and mirrors the live value back.
 *
 * Categories are a plain list rather than a router — there is one window and a
 * handful of settings, so a `ref` naming the visible section is the whole
 * mechanism. The filter narrows both the category list and the rows.
 */
import { rememberedRef, takeRequest } from '../lib/paneMemory'
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { LOCALE_NAMES } from '../i18n'
import { DEFAULT_APP_THEME, useAppTheme, type AppTheme } from '../lib/theme'
import { agentPreference, setAgentPreference, type AgentKind } from '../lib/agentPreference'
import {
  DEFAULT_GPU_POWER_PREFERENCE,
  GPU_POWER_PREFERENCES,
  gpuPreference,
  setGpuPreference,
  type GpuPowerPreference
} from '../lib/gpuPreference'
import {
  defaultPcbViewState,
  pcbViewState,
  setPcbView,
  TRACK_CLEARANCE_DISPLAYS,
  type TrackClearanceDisplay
} from '../lib/pcbView'
import BrandWordmark from './shared/BrandWordmark.vue'
import Icon from './shared/Icon.vue'
import PartsSettings from './settings/PartsSettings.vue'
import McpSettings from './settings/McpSettings.vue'
import GplLicense from './settings/GplLicense.vue'
import ThirdPartyLicenses from './settings/ThirdPartyLicenses.vue'

const { t, locale } = useI18n()

/**
 * A caller can ask for a specific category — the Part Search panel's setup card
 * sends people straight to the distributor keys, and landing them on Appearance
 * instead is a dead end. Nonced, because the tab is usually already open.
 */
const props = defineProps<{ pendingCategory?: { category: string; nonce: number } | null }>()
const emit = defineEmits<{
  /** About's Share feedback: App opens FeedbackDialog, as the activity bar does. */
  (e: 'share-feedback'): void
}>()

type Category = 'appearance' | 'boardEditor' | 'libraries' | 'parts' | 'integrations' | 'about'
const CATEGORIES: Category[] = [
  'appearance',
  'boardEditor',
  'libraries',
  'parts',
  'integrations',
  'about'
]

const isCategory = (value: string): value is Category => (CATEGORIES as string[]).includes(value)

const activeCategory = rememberedRef<Category>('settings', 'appearance')
const filter = ref('')

watch(
  () => props.pendingCategory,
  (request) => {
    if (!request || !isCategory(request.category)) return
    if (!takeRequest('settings', request.nonce)) return
    // A live filter would hide the category we were just asked to show.
    filter.value = ''
    activeCategory.value = request.category
  },
  { immediate: true }
)

// ---------------------------------------------------------------- appearance

type UiLocale = keyof typeof LOCALE_NAMES

const selectedLocale = ref<UiLocale>(locale.value as UiLocale)
const appTheme = useAppTheme()
const selectedTheme = ref<AppTheme>(appTheme.value)

// Follow the live locale, so a change made in another window shows up here.
watch(locale, (next) => {
  selectedLocale.value = next as UiLocale
})
watch(appTheme, (next) => {
  selectedTheme.value = next
})

const applyLocale = async (next: UiLocale): Promise<void> => {
  try {
    await window.api.updateConfig({ locale: next })
  } catch (err) {
    console.error('Failed to save language', err)
    selectedLocale.value = locale.value as UiLocale // snap back to the real value
  }
}

const applyTheme = async (next: AppTheme): Promise<void> => {
  try {
    await window.api.updateConfig({ theme: next })
  } catch (err) {
    console.error('Failed to save theme', err)
    selectedTheme.value = appTheme.value
  }
}

const gpu = gpuPreference()
// A WebGL context keeps the GPU it was created with, so say when a change lands.
const gpuChanged = ref(false)

const applyGpu = (next: GpuPowerPreference): void => {
  setGpuPreference(next)
  gpuChanged.value = true
}
const gpuLabel = (pref: GpuPowerPreference): string =>
  pref === 'low-power'
    ? t('settings.appearance.gpuLowPower')
    : pref === 'high-performance'
      ? t('settings.appearance.gpuHighPerformance')
      : t('settings.appearance.gpuDefault')

// Linux only (main/index.ts); read once at launch, so a change waits for a restart.
const offersVulkan = window.api.platform === 'linux'
const useVulkan = ref(false)
const vulkanChanged = ref(false)

const applyVulkan = async (next: boolean): Promise<void> => {
  useVulkan.value = next
  vulkanChanged.value = true
  try {
    await window.api.updateConfig({ useVulkan: next })
  } catch (err) {
    console.error('Failed to save the Vulkan setting', err)
  }
}

/** Theme and GPU; the language stays, since a reset should not strand anyone in English. */
const appearanceIsDefault = computed(
  () =>
    selectedTheme.value === DEFAULT_APP_THEME &&
    gpu.value === DEFAULT_GPU_POWER_PREFERENCE &&
    !useVulkan.value
)
const restoreAppearance = (): void => {
  if (selectedTheme.value !== DEFAULT_APP_THEME) {
    selectedTheme.value = DEFAULT_APP_THEME
    void applyTheme(DEFAULT_APP_THEME)
  }
  if (gpu.value !== DEFAULT_GPU_POWER_PREFERENCE) applyGpu(DEFAULT_GPU_POWER_PREFERENCE)
  if (useVulkan.value) void applyVulkan(false)
}

// -------------------------------------------------------------- board editor

const pcbView = pcbViewState()

const boardEditorIsDefault = computed(() => {
  const defaults = defaultPcbViewState()
  return (
    pcbView.value.padClearance === defaults.padClearance &&
    pcbView.value.trackClearance === defaults.trackClearance
  )
})
const restoreBoardEditor = (): void => {
  const { padClearance, trackClearance } = defaultPcbViewState()
  setPcbView({ padClearance, trackClearance })
}

const trackClearanceLabel = (mode: TrackClearanceDisplay): string =>
  mode === 'never'
    ? t('settings.boardEditor.never')
    : mode === 'routing'
      ? t('settings.boardEditor.whileRouting')
      : mode === 'routingAndDragging'
        ? t('settings.boardEditor.whileRoutingAndDragging')
        : t('settings.boardEditor.always')

// -------------------------------------------------------------- integrations

const AGENTS: AgentKind[] = ['claude', 'codex']
const agent = agentPreference()

// ----------------------------------------------------------------- libraries

/**
 * The KiCad path variable this setting stands in for, shown in the description.
 * Interpolated as a value because braces are vue-i18n placeholder syntax and a
 * literal `${…}` in a message fails to compile.
 * Duplicated constant: `KICAD_LIB_MAJOR` in `main/kicadLibraries.ts` — bump both.
 */
const MODEL_DIR_VARIABLE = '${KICAD10_3DMODEL_DIR}'

/** The user's explicit override, or '' when the detected install is in use. */
const modelDir = ref('')
/** The install GoatCAD detected on its own — shown as the placeholder. */
const detectedModelDir = ref<string | null>(null)

/** What `model:resolve` will actually use, mirroring main's precedence. */
const effectiveModelDir = computed(() => modelDir.value || detectedModelDir.value || null)

const loadLibrarySettings = async (): Promise<void> => {
  try {
    const [config, detected] = await Promise.all([
      window.api.getConfig(),
      window.api.detectSystemLibraries()
    ])
    modelDir.value = config.kicad3dModelDir ?? ''
    detectedModelDir.value = detected?.models3d ?? null
  } catch (err) {
    console.error('Failed to load library settings', err)
  }
}

/**
 * An empty string clears the override rather than persisting `''` — main treats
 * a falsy value as "fall back to detection" (see `normalizeConfig`).
 */
const applyModelDir = async (next: string): Promise<void> => {
  const trimmed = next.trim()
  try {
    await window.api.updateConfig({ kicad3dModelDir: trimmed || undefined })
    modelDir.value = trimmed
  } catch (err) {
    console.error('Failed to save the 3D model directory', err)
  }
}

const browseModelDir = async (): Promise<void> => {
  const picked = await window.api.pickDirectory(
    t('settings.libraries.model3dDir'),
    modelDir.value || detectedModelDir.value || undefined
  )
  if (picked) await applyModelDir(picked)
}

/**
 * Re-run what GoatCAD probes about the machine (main/launchChecks.ts). Its
 * reason to exist is the user who installs KiCad *after* GoatCAD, or who adds a
 * library to KiCad and wonders why it isn't here: the import is a one-time seed,
 * so without this the answer would be "restart, and it still won't".
 */
const checking = ref(false)
const checkResult = ref<string | null>(null)

const rerunSystemChecks = async (): Promise<void> => {
  checking.value = true
  checkResult.value = null
  try {
    const results = await window.api.runSystemChecks()
    const seed = results.find((r) => r.id === 'kicad-global-tables')
    const added = seed?.added ?? 0
    checkResult.value = seed?.error
      ? t('settings.libraries.kicadImportFailed', { error: seed.error })
      : !seed?.detail
        ? t('settings.libraries.kicadImportNone')
        : added === 0
          ? t('settings.libraries.kicadImportUpToDate')
          : t('settings.libraries.kicadImportDone', { count: added }, added)
    await loadLibrarySettings()
  } catch (err) {
    checkResult.value = t('settings.libraries.kicadImportFailed', {
      error: err instanceof Error ? err.message : String(err)
    })
  } finally {
    checking.value = false
  }
}

// --------------------------------------------------------------------- about

/** Read from the packaged app, so a build shows the version it actually is. */
const appVersion = ref('')
const checkForUpdates = ref(true)

type UpdateCheckOutcome = Awaited<ReturnType<typeof window.api.checkForUpdatesNow>>
const updateCheck = ref<UpdateCheckOutcome | 'checking' | null>(null)
/** An install that does not update itself (main/updater.ts) disables Check now and says so. */
const canCheckForUpdates = ref(true)

// The outcome is written beside the button and stays until the next check.
const checkForUpdatesNow = async (): Promise<void> => {
  updateCheck.value = 'checking'
  updateCheck.value = await window.api.checkForUpdatesNow().catch(() => 'failed' as const)
}

const openSourceCode = (): void => void window.api.openSourceCode()
/** Set when no app could open the notices file; cleared by the next try. */
const noticesFailed = ref(false)
const openThirdPartyNotices = async (): Promise<void> => {
  noticesFailed.value = !(await window.api.openThirdPartyNotices().catch(() => false))
}

const applyCheckForUpdates = async (next: boolean): Promise<void> => {
  checkForUpdates.value = next
  try {
    await window.api.updateConfig({ checkForUpdates: next })
  } catch (err) {
    console.error('Failed to save the update setting', err)
  }
}

// ------------------------------------------------------------------ filtering

/** Rows are matched on their rendered label + description, not on key names. */
const rowMatches = (...parts: string[]): boolean => {
  const needle = filter.value.trim().toLowerCase()
  if (!needle) return true
  return parts.some((part) => part.toLowerCase().includes(needle))
}

const showLanguage = computed(() => rowMatches(t('settings.appearance.language')))
const showAgent = computed(() =>
  rowMatches(
    t('settings.agent.label'),
    t('settings.agent.description'),
    ...AGENTS.map((kind) => t(`settings.agent.${kind}`))
  )
)
const showTheme = computed(() =>
  rowMatches(
    t('settings.appearance.theme'),
    t('settings.appearance.themeDark'),
    t('settings.appearance.themeLight')
  )
)
const showGpu = computed(() =>
  rowMatches(t('settings.appearance.gpu'), ...GPU_POWER_PREFERENCES.map(gpuLabel))
)
const showVulkan = computed(
  () =>
    offersVulkan &&
    rowMatches(t('settings.appearance.vulkan'), t('settings.appearance.vulkanDescription'))
)
const showPadClearance = computed(() =>
  rowMatches(
    t('settings.boardEditor.clearanceHeading'),
    t('settings.boardEditor.pads'),
    t('settings.boardEditor.never'),
    t('settings.boardEditor.always')
  )
)
const showTrackClearance = computed(() =>
  rowMatches(
    t('settings.boardEditor.clearanceHeading'),
    t('settings.boardEditor.tracksAndVias'),
    ...TRACK_CLEARANCE_DISPLAYS.map(trackClearanceLabel)
  )
)
const modelDirDescription = computed(() =>
  t('settings.libraries.model3dDirDescription', { variableName: MODEL_DIR_VARIABLE })
)
const showModelDir = computed(() =>
  rowMatches(t('settings.libraries.model3dDir'), modelDirDescription.value)
)
const showKicadImport = computed(() =>
  rowMatches(
    t('settings.libraries.kicadImport'),
    t('settings.libraries.kicadImportDescription'),
    t('settings.libraries.kicadImportAction')
  )
)

/** A category disappears from the list when the filter excludes all its rows. */
const categoryHasMatch = (category: Category): boolean => {
  if (!filter.value.trim()) return true
  if (category === 'appearance') {
    return showTheme.value || showLanguage.value || showGpu.value || showVulkan.value
  }
  if (category === 'boardEditor') {
    return showPadClearance.value || showTrackClearance.value
  }
  if (category === 'libraries') return showModelDir.value || showKicadImport.value
  if (category === 'parts') {
    // The section has no prose of its own to match on — its content is provider
    // cards built from main's registry. So the filter matches the category label
    // ("Distributor APIs") plus the one heading inside it, which is what makes
    // searching "key" find this rather than nothing.
    return rowMatches(t('settings.categories.parts'), t('settings.parts.stepsHeading'))
  }
  if (category === 'integrations') {
    return (
      showAgent.value ||
      rowMatches(t('settings.categories.integrations'), t('settings.mcp.serverHeading'))
    )
  }
  return rowMatches(
    t('settings.about.version', { version: appVersion.value }),
    t('settings.about.checkForUpdates'),
    t('settings.about.checkNow'),
    t('settings.about.licenseHeading'),
    t('settings.about.acknowledgementsHeading'),
    t('settings.about.viewSource'),
    t('settings.about.shareFeedback'),
    t('settings.about.thirdPartyLicenses'),
    t('settings.about.noticesFile')
  )
}

const visibleCategories = computed(() => CATEGORIES.filter(categoryHasMatch))

// Keep the selection valid as the filter narrows the list.
watch(visibleCategories, (categories) => {
  if (categories.length && !categories.includes(activeCategory.value)) {
    activeCategory.value = categories[0]
  }
})

// ----------------------------------------------------------------- lifecycle

// Another window may change a setting while this tab is open. The broadcast
// carries the new config, so the override needs no round-trip; detection is
// independent of it and stays as loaded.
let stopConfigListener: (() => void) | null = null

onMounted(() => {
  void loadLibrarySettings()
  void window.api
    .getConfig()
    .then((config) => {
      checkForUpdates.value = config.checkForUpdates
      useVulkan.value = config.useVulkan
    })
    .catch((err) => console.error('Failed to load the update setting', err))
  void window.api
    .canCheckForUpdates()
    .then((can) => {
      canCheckForUpdates.value = can
      if (!can) updateCheck.value = 'unavailable'
    })
    .catch(() => {})
  void window.api
    .getAppVersion()
    .then((version) => {
      appVersion.value = version
    })
    .catch(() => {
      appVersion.value = '?'
    })
  stopConfigListener = window.api.onConfigChanged((config) => {
    modelDir.value = config.kicad3dModelDir ?? ''
    checkForUpdates.value = config.checkForUpdates
    useVulkan.value = config.useVulkan
  })
})

onBeforeUnmount(() => {
  stopConfigListener?.()
})
</script>

<template>
  <div class="settings-view">
    <div class="settings-header">
      <span class="settings-title">{{ t('settings.title') }}</span>
      <input
        v-model="filter"
        class="settings-search"
        type="search"
        :placeholder="t('settings.searchPlaceholder')"
      />
    </div>

    <div class="settings-body">
      <nav class="nav-list">
        <button
          v-for="category in visibleCategories"
          :key="category"
          class="nav-item"
          :class="{ active: activeCategory === category }"
          @click="activeCategory = category"
        >
          {{ t(`settings.categories.${category}`) }}
        </button>
      </nav>

      <div class="settings-panel">
        <!-- Appearance -->
        <section v-if="activeCategory === 'appearance'">
          <div v-if="showTheme" class="setting-row">
            <label class="setting-label" for="settings-theme">
              {{ t('settings.appearance.theme') }}
            </label>
            <select
              id="settings-theme"
              v-model="selectedTheme"
              class="field-md setting-select"
              @change="applyTheme(selectedTheme)"
            >
              <option value="dark">{{ t('settings.appearance.themeDark') }}</option>
              <option value="light">{{ t('settings.appearance.themeLight') }}</option>
            </select>
          </div>
          <div v-if="showLanguage" class="setting-row">
            <label class="setting-label" for="settings-language">
              {{ t('settings.appearance.language') }}
            </label>
            <select
              id="settings-language"
              v-model="selectedLocale"
              class="field-md setting-select"
              @change="applyLocale(selectedLocale)"
            >
              <!-- Endonyms, deliberately not run through t() -->
              <option v-for="(name, code) in LOCALE_NAMES" :key="code" :value="code">
                {{ name }}
              </option>
            </select>
          </div>
          <div v-if="showGpu" class="setting-row">
            <label class="setting-label" for="settings-gpu">
              {{ t('settings.appearance.gpu') }}
            </label>
            <div class="setting-path-row">
              <select
                id="settings-gpu"
                :value="gpu"
                class="field-md setting-select"
                @change="applyGpu(($event.target as HTMLSelectElement).value as GpuPowerPreference)"
              >
                <option v-for="pref in GPU_POWER_PREFERENCES" :key="pref" :value="pref">
                  {{ gpuLabel(pref) }}
                </option>
              </select>
              <span v-if="gpuChanged" class="setting-status setting-status-inline">
                {{ t('settings.appearance.gpuAppliesToNewTabs') }}
              </span>
            </div>
          </div>
          <div v-if="showVulkan" class="setting-row">
            <label class="setting-toggle">
              <input
                type="checkbox"
                :checked="useVulkan"
                @change="applyVulkan(($event.target as HTMLInputElement).checked)"
              />
              {{ t('settings.appearance.vulkan') }}
            </label>
            <p class="setting-description">{{ t('settings.appearance.vulkanDescription') }}</p>
            <p v-if="vulkanChanged" class="setting-status">
              {{ t('settings.appearance.vulkanAppliesAfterRestart') }}
            </p>
          </div>
          <button
            v-if="!filter.trim()"
            class="btn-outline btn-md"
            :disabled="appearanceIsDefault"
            @click="restoreAppearance"
          >
            {{ t('settings.restoreDefaults') }}
          </button>
        </section>

        <!-- Board editor — lib/pcbView.ts -->
        <section v-else-if="activeCategory === 'boardEditor'">
          <h3 v-if="showPadClearance || showTrackClearance" class="setting-heading">
            {{ t('settings.boardEditor.clearanceHeading') }}
          </h3>
          <div v-if="showPadClearance" class="setting-row">
            <label class="setting-label" for="settings-pad-clearance">
              {{ t('settings.boardEditor.pads') }}
            </label>
            <select
              id="settings-pad-clearance"
              :value="pcbView.padClearance ? 'always' : 'never'"
              class="field-md setting-select"
              @change="
                setPcbView({
                  padClearance: ($event.target as HTMLSelectElement).value === 'always'
                })
              "
            >
              <option value="never">{{ t('settings.boardEditor.never') }}</option>
              <option value="always">{{ t('settings.boardEditor.always') }}</option>
            </select>
          </div>
          <div v-if="showTrackClearance" class="setting-row">
            <label class="setting-label" for="settings-track-clearance">
              {{ t('settings.boardEditor.tracksAndVias') }}
            </label>
            <select
              id="settings-track-clearance"
              :value="pcbView.trackClearance"
              class="field-md setting-select"
              @change="
                setPcbView({
                  trackClearance: ($event.target as HTMLSelectElement)
                    .value as TrackClearanceDisplay
                })
              "
            >
              <option v-for="mode in TRACK_CLEARANCE_DISPLAYS" :key="mode" :value="mode">
                {{ trackClearanceLabel(mode) }}
              </option>
            </select>
          </div>
          <button
            v-if="!filter.trim()"
            class="btn-outline btn-md"
            :disabled="boardEditorIsDefault"
            @click="restoreBoardEditor"
          >
            {{ t('settings.restoreDefaults') }}
          </button>
        </section>

        <!-- Libraries -->
        <section v-else-if="activeCategory === 'libraries'">
          <div v-if="showModelDir" class="setting-row">
            <label class="setting-label" for="settings-model-dir">
              {{ t('settings.libraries.model3dDir') }}
            </label>
            <p class="setting-description">{{ modelDirDescription }}</p>
            <div class="setting-path-row">
              <input
                id="settings-model-dir"
                v-model="modelDir"
                class="field-md setting-input"
                type="text"
                spellcheck="false"
                :placeholder="detectedModelDir ?? ''"
                @change="applyModelDir(modelDir)"
              />
              <button class="btn-outline btn-md" @click="browseModelDir">
                {{ t('settings.libraries.browse') }}
              </button>
              <button v-if="modelDir" class="btn-outline btn-md" @click="applyModelDir('')">
                {{ t('settings.libraries.clear') }}
              </button>
            </div>
            <p class="setting-status">
              <template v-if="modelDir">{{ t('settings.libraries.overridden') }}</template>
              <template v-else-if="detectedModelDir">
                <Icon name="check" class="status-ok" /> {{ t('settings.libraries.detected') }}
              </template>
              <template v-else>{{ t('settings.libraries.detectedNone') }}</template>
            </p>
            <p v-if="effectiveModelDir" class="setting-effective">
              {{ t('settings.libraries.usingPath', { path: effectiveModelDir }) }}
            </p>
          </div>

          <div v-if="showKicadImport" class="setting-row">
            <span class="setting-label">{{ t('settings.libraries.kicadImport') }}</span>
            <p class="setting-description">{{ t('settings.libraries.kicadImportDescription') }}</p>
            <button class="btn-outline btn-md" :disabled="checking" @click="rerunSystemChecks">
              {{
                checking
                  ? t('settings.libraries.kicadImportBusy')
                  : t('settings.libraries.kicadImportAction')
              }}
            </button>
            <p v-if="checkResult" class="setting-status">{{ checkResult }}</p>
          </div>
        </section>

        <!-- Parts — distributor API keys -->
        <section v-else-if="activeCategory === 'parts'">
          <PartsSettings />
        </section>

        <!-- Integrations — MCP clients -->
        <section v-else-if="activeCategory === 'integrations'">
          <div v-if="showAgent" class="setting-row">
            <label class="setting-label" for="settings-agent">
              {{ t('settings.agent.label') }}
            </label>
            <p class="setting-description">{{ t('settings.agent.description') }}</p>
            <select
              id="settings-agent"
              :value="agent"
              class="field-md setting-select"
              @change="setAgentPreference(($event.target as HTMLSelectElement).value as AgentKind)"
            >
              <option v-for="kind in AGENTS" :key="kind" :value="kind">
                {{ t(`settings.agent.${kind}`) }}
              </option>
            </select>
          </div>
          <McpSettings />
        </section>

        <!-- About -->
        <section v-else>
          <div class="setting-row about-row">
            <h2 class="about-logo"><BrandWordmark size="hero" /></h2>
            <p class="about-version">{{ t('settings.about.version', { version: appVersion }) }}</p>
            <div class="setting-path-row about-actions">
              <button class="btn-outline btn-md" @click="openSourceCode">
                <Icon name="open-external" />
                {{ t('settings.about.viewSource') }}
              </button>
              <button class="btn-outline btn-md" @click="emit('share-feedback')">
                <Icon name="feedback" />
                {{ t('settings.about.shareFeedback') }}
              </button>
            </div>
          </div>
          <div class="setting-row">
            <label class="setting-toggle">
              <input
                type="checkbox"
                :checked="checkForUpdates"
                @change="applyCheckForUpdates(($event.target as HTMLInputElement).checked)"
              />
              {{ t('settings.about.checkForUpdates') }}
            </label>
            <div class="setting-path-row check-now">
              <button
                class="btn-outline btn-md"
                :disabled="!canCheckForUpdates || updateCheck === 'checking'"
                @click="checkForUpdatesNow"
              >
                {{ t('settings.about.checkNow') }}
              </button>
              <span v-if="updateCheck" class="setting-status setting-status-inline">
                {{ t(`settings.about.checkResult.${updateCheck}`) }}
              </span>
            </div>
          </div>
          <div class="setting-row">
            <span class="setting-label">{{ t('settings.about.licenseHeading') }}</span>
            <p class="setting-description">{{ t('settings.about.license') }}</p>
            <GplLicense />
          </div>
          <div class="setting-row">
            <span class="setting-label">{{ t('settings.about.acknowledgementsHeading') }}</span>
            <p class="setting-description">{{ t('settings.about.acknowledgementsKicad') }}</p>
            <p class="setting-description">{{ t('settings.about.acknowledgementsClaude') }}</p>
          </div>
          <div class="setting-row">
            <h3 class="setting-heading">{{ t('settings.about.thirdPartyLicenses') }}</h3>
            <ThirdPartyLicenses />
            <div class="setting-path-row notices-file">
              <button class="btn-outline btn-md" @click="openThirdPartyNotices">
                {{ t('settings.about.noticesFile') }}
              </button>
              <span v-if="noticesFailed" class="setting-status setting-status-inline">
                {{ t('settings.about.noticesFailed') }}
              </span>
            </div>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.settings-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--vscode-bg-editor);
  color: var(--vscode-text);
  overflow: hidden;
}

.settings-header {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 16px 24px;
  border-bottom: 1px solid var(--vscode-border);
}

.settings-title {
  font-size: var(--text-heading);
  font-weight: 600;
  color: var(--vscode-text-light);
}

.settings-search {
  flex: 1;
  max-width: 420px;
  padding: 5px 8px;
  background: var(--vscode-input-bg);
  border: 1px solid var(--vscode-input-border);
  border-radius: 3px;
  color: var(--vscode-text);
  font-size: var(--text-body-sm);
}

.settings-search:focus {
  outline: none;
  border-color: var(--vscode-input-focus);
}

.settings-body {
  display: flex;
  flex: 1;
  min-height: 0;
}

/* Left nav is the shared `.nav-list` / `.nav-item` (DESIGN.md §3, main.css). */

.settings-panel {
  flex: 1;
  min-width: 0;
  padding: 24px 32px;
  overflow-y: auto;
}

.setting-row {
  max-width: 640px;
  margin-bottom: 28px;
}

.setting-label {
  display: block;
  font-size: var(--text-body);
  font-weight: 600;
  color: var(--vscode-text-light);
  margin-bottom: 4px;
}

.setting-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
  font-size: var(--text-body);
  font-weight: 600;
  color: var(--vscode-text-light);
  cursor: pointer;
}

/* DESIGN.md's section eyebrow. */
.setting-heading {
  margin: 0 0 12px;
  font-size: var(--text-caption);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--vscode-text-muted);
}

.setting-description {
  margin: 0 0 10px;
  font-size: var(--text-body-sm);
  line-height: 1.5;
  color: var(--vscode-text-muted);
}

/* Controls are framework .field-md (DESIGN.md §3); these set layout only. */
.setting-select {
  min-width: 220px;
}

.setting-path-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.setting-input {
  flex: 1;
  min-width: 0;
  font-family: var(--font-mono, monospace);
}

.setting-status {
  margin: 8px 0 0;
  font-size: var(--text-caption);
  color: var(--vscode-text-muted);
}

.setting-status-inline {
  margin: 0;
}

.status-ok {
  width: 12px;
  height: 12px;
  vertical-align: -1px;
  color: var(--vscode-success);
}

.setting-effective {
  margin: 2px 0 0;
  font-size: var(--text-caption);
  font-family: var(--font-mono, monospace);
  color: var(--vscode-text-muted);
  word-break: break-all;
}

.about-actions {
  margin-top: 12px;
}

.notices-file {
  margin-top: 12px;
}

.check-now {
  margin-top: 8px;
}

.about-logo {
  margin: 0 0 8px;
  font-size: calc(var(--text-display) * 1.4);
  line-height: 1.1;
}

.about-version {
  margin: 0;
  font-size: var(--text-body);
  color: var(--vscode-text);
}
</style>
