<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import BrandWordmark from './shared/BrandWordmark.vue'
import HillScene from './shared/HillScene.vue'
import Icon from './shared/Icon.vue'
import { hotkeyLabel } from '../lib/hotkeys'
import { abbreviateHome } from '../lib/displayPath'
import { splitRecents } from '../lib/recents'
import type { RecentEntry } from '../../../preload/recentTypes'

const { t } = useI18n()

const props = defineProps<{
  /** Mirrors config.showWelcomeOnStartup; owned by App so the menu and tab agree. */
  showOnStartup: boolean
  /** Most-recent-first; owned by App for the same reason. */
  recents: RecentEntry[]
}>()

const emit = defineEmits<{
  (e: 'open-folder'): void
  (e: 'open-project'): void
  (e: 'open-recent', entry: RecentEntry): void
  /** Open File… — App owns the dialog, since the File menu offers it too. */
  (e: 'open-file-dialog'): void
  (e: 'new-project'): void
  (e: 'open-sample'): void
  (e: 'update:showOnStartup', value: boolean): void
}>()

// The row's `title` keeps the real path; only what is printed is abbreviated.
const homeDir = window.api.homeDir

const recentProjects = computed(() => splitRecents(props.recents).projects)
const recentFiles = computed(() => splitRecents(props.recents).files)

/** What an entry is called: its filename, or the folder's own name. */
const entryName = (entry: RecentEntry): string =>
  (entry.path.split(/[/\\]/).filter(Boolean).pop() ?? entry.path).replace(/\.kicad_pro$/i, '')

// Recents come from App, not a local fetch: File ▸ Open Recent lists the same
// data, and main broadcasts every change, so one owner keeps the two surfaces
// from disagreeing after a remove, a clear, or another window opening a project.
const removeRecent = async (path: string): Promise<void> => {
  await window.api.removeRecent(path)
}

const clearRecents = async (): Promise<void> => {
  await window.api.clearRecents()
}

// Night sky over the whole tab, for when the hill scene's pot turns the sunset
// down (a port of the site's HeroSky.astro). Stars sit behind the content and
// are placed by a fixed-seed hash, in percent so they spread over any size;
// the field turns with the scene's sky, and DRIFT is how far that carries a
// star (% of the tab), so each is drawn up and left of where it lands.
const DRIFT = { x: 2, y: 10 }
const skyHash = (n: number): number => {
  const v = Math.sin(n * 12.9898 + 78.233) * 43758.5453
  return v - Math.floor(v)
}
const r1 = (n: number): number => Math.round(n * 10) / 10
const skyStars = Array.from({ length: 80 }, (_, i) => ({
  style:
    `left: ${r1(-DRIFT.x + skyHash(i * 5 + 101) * 100)}%; ` +
    `top: ${r1(-DRIFT.y + 4 + skyHash(i * 5 + 102) * 80)}%; ` +
    `--size: ${r1(1 + skyHash(i * 5 + 103) ** 3 * 2)}px; ` +
    `--tw: ${r1(1.6 + skyHash(i * 5 + 104) * 2.2)}s; --td: ${r1(-skyHash(i * 5 + 105) * 3)}s`
}))
</script>

<template>
  <div class="welcome-tab">
    <!-- Night behind the whole page: hidden by day, it falls with the hill
         scene's (see skyStars). -->
    <div class="welcome-sky" aria-hidden="true">
      <div class="sky-tint" />
      <div class="sky-field">
        <span v-for="(star, i) in skyStars" :key="i" class="star" :style="star.style" />
      </div>
    </div>

    <div class="welcome-body">
      <div class="welcome-content">
        <header class="welcome-hero">
          <h1 class="hero-logo"><BrandWordmark size="hero" /></h1>
          <p class="hero-tagline">{{ t('welcome.hero.tagline') }}</p>
        </header>

        <div class="welcome-columns">
          <div class="welcome-column">
            <section class="welcome-section">
              <h2 class="welcome-section-title">{{ t('welcome.start.title') }}</h2>
              <div class="welcome-actions">
                <!-- Ordered by what a first-time user should reach for, and
                   weighted so Open Folder reads as the browsing verb rather
                   than a second way to open a design. -->
                <button class="action-row primary" @click="emit('new-project')">
                  <span class="action-icon"><Icon name="new-project" /></span>
                  <span class="action-text">
                    <span class="action-title">{{ t('welcome.start.newProject') }}</span>
                    <span class="action-desc">{{ t('welcome.start.newProjectDesc') }}</span>
                  </span>
                </button>

                <button class="action-row" @click="emit('open-project')">
                  <span class="action-icon"><Icon name="project" /></span>
                  <span class="action-text">
                    <span class="action-title">{{ t('welcome.start.openProject') }}</span>
                    <span class="action-desc">{{ t('welcome.start.openProjectDesc') }}</span>
                  </span>
                  <kbd class="kbd"
                    ><span>{{ hotkeyLabel('app.openProject') }}</span></kbd
                  >
                </button>

                <button class="action-row" @click="emit('open-folder')">
                  <span class="action-icon"><Icon name="folder" /></span>
                  <span class="action-text">
                    <span class="action-title">{{ t('welcome.start.openFolder') }}</span>
                  </span>
                  <kbd class="kbd"
                    ><span>{{ hotkeyLabel('app.openFolder') }}</span></kbd
                  >
                </button>

                <button class="action-row" @click="emit('open-file-dialog')">
                  <span class="action-icon"><Icon name="file-doc" /></span>
                  <span class="action-text">
                    <span class="action-title">{{ t('welcome.start.openFile') }}</span>
                  </span>
                </button>
              </div>
            </section>

            <section class="welcome-section">
              <h2 class="welcome-section-title">{{ t('welcome.explore.title') }}</h2>
              <div class="welcome-actions">
                <button class="action-row" @click="emit('open-sample')">
                  <span class="action-icon"><Icon name="sample-project" /></span>
                  <span class="action-text">
                    <span class="action-title">{{ t('welcome.start.openSample') }}</span>
                    <span class="action-desc">{{ t('welcome.start.openSampleDesc') }}</span>
                  </span>
                </button>
              </div>
            </section>
          </div>

          <section v-if="props.recents.length > 0" class="welcome-section">
            <div class="welcome-section-head">
              <h2 class="welcome-section-title">{{ t('welcome.recent.title') }}</h2>
              <button class="btn-subtle btn-sm" @click="clearRecents">
                {{ t('welcome.recent.clear') }}
              </button>
            </div>
            <!-- Projects lead: opening one is the context every other feature
                 needs, so it is what this page should make easiest to reach. -->
            <div class="recent-list">
              <div
                v-for="item in recentProjects"
                :key="`p:${item.path}`"
                class="recent-item"
                :title="item.path"
                @click="emit('open-recent', item)"
              >
                <div class="recent-meta">
                  <div class="recent-name">{{ entryName(item) }}</div>
                  <!-- The entry's own path, not its workspace root: two copies
                       of one design can sit in the same folder (KiCad's demos
                       ship exactly that), so the folder alone won't separate them. -->
                  <div class="recent-path">{{ abbreviateHome(item.path, homeDir) }}</div>
                </div>
                <button
                  class="recent-remove-btn btn-subtle btn-icon-sm"
                  :title="t('welcome.recent.remove')"
                  @click.stop="removeRecent(item.path)"
                >
                  <Icon name="close" />
                </button>
              </div>
            </div>

            <!-- Files, and folders that held no project. A file names the
                 project it was used in, and reopening it restores that. -->
            <template v-if="recentFiles.length > 0">
              <h3 class="welcome-section-title recent-group-title">
                {{ t('welcome.recent.filesTitle') }}
              </h3>
              <div class="recent-list">
                <div
                  v-for="item in recentFiles"
                  :key="`f:${item.path}`"
                  class="recent-item"
                  :title="item.path"
                  @click="emit('open-recent', item)"
                >
                  <div class="recent-meta">
                    <div class="recent-name">{{ entryName(item) }}</div>
                    <div class="recent-path">
                      {{
                        item.projectPath
                          ? entryName({ ...item, path: item.projectPath })
                          : abbreviateHome(item.workspaceRoot, homeDir)
                      }}
                    </div>
                  </div>
                  <button
                    class="recent-remove-btn btn-subtle btn-icon-sm"
                    :title="t('welcome.recent.remove')"
                    @click.stop="removeRecent(item.path)"
                  >
                    <Icon name="close" />
                  </button>
                </div>
              </div>
            </template>
          </section>
        </div>
      </div>

      <!-- The page's ground: full width, after the content. -->
      <div class="welcome-ground"><HillScene /></div>
    </div>

    <footer class="welcome-footer">
      <label class="welcome-startup-toggle">
        <input
          type="checkbox"
          :checked="showOnStartup"
          @change="emit('update:showOnStartup', ($event.target as HTMLInputElement).checked)"
        />
        {{ t('welcome.footer.showOnStartup') }}
      </label>
    </footer>
  </div>
</template>

<style scoped>
.welcome-tab {
  position: relative;
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background-color: var(--vscode-bg-editor);
}

.welcome-body {
  position: relative;
  z-index: 1;
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  overflow-x: hidden;
}

.welcome-content {
  flex: none;
  width: 100%;
  max-width: 880px;
  margin: 0 auto;
  padding: clamp(24px, 8vh, 72px) 32px 24px;
}

/* ---- Hero --------------------------------------------------------------- */

.welcome-hero {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  margin-bottom: 48px;
  text-align: center;
}

/* The logo is sized off the display step; its type treatment lives in
   shared/BrandWordmark.vue. */
.hero-logo {
  font-size: calc(var(--text-display) * 2);
  line-height: 1.1;
  margin-bottom: 4px;
}

.hero-tagline {
  font-size: var(--text-heading);
  line-height: 1.35;
  color: var(--vscode-text);
  max-width: 34ch;
}

/* ---- Columns ------------------------------------------------------------ */

.welcome-columns {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 48px;
  align-items: start;
}

@media (max-width: 720px) {
  .welcome-columns {
    grid-template-columns: minmax(0, 1fr);
    gap: 32px;
  }
}

.welcome-section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.welcome-section-head .welcome-section-title {
  margin-bottom: 0;
}

/* Section eyebrow (DESIGN.md §Section eyebrows). */
.welcome-section-title {
  font-size: var(--text-caption);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--vscode-text-muted);
  margin-bottom: 12px;
}

/* Start, then Explore, stacked in the left column. */
.welcome-column {
  display: flex;
  flex-direction: column;
  gap: 32px;
  min-width: 0;
}

/* ---- Start actions ------------------------------------------------------ */

.welcome-actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.action-row {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 12px;
  background-color: transparent;
  border: 1px solid var(--vscode-border);
  border-radius: 6px;
  color: inherit;
  cursor: pointer;
  text-align: left;
  transition:
    background-color 70ms,
    border-color 70ms;
}

.action-row:hover {
  background-color: var(--vscode-bg-hover);
  border-color: var(--vscode-accent-border);
}

.action-row:focus-visible {
  outline: none;
  border-color: var(--vscode-input-focus);
}

.action-row.primary {
  border-color: var(--vscode-accent-border);
}

.action-icon {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 6px;
  background-color: var(--vscode-accent-subtle-strong);
  color: var(--vscode-accent);
}

.action-icon svg {
  width: 16px;
  height: 16px;
}

.action-text {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.action-title {
  font-size: var(--text-body);
  font-weight: 600;
  color: var(--vscode-text-light);
}

.action-desc {
  font-size: var(--text-body-sm);
  color: var(--vscode-text-muted);
}

/* ---- Recents ------------------------------------------------------------ */

.recent-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

/* A second eyebrow under the projects, separated by a rule so it reads as a
   new group rather than another row. */
.recent-group-title {
  margin: 16px 0 8px;
  padding-top: 16px;
  border-top: 1px solid var(--vscode-border);
}

.recent-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 4px 4px 8px;
  border-radius: 4px;
  cursor: pointer;
  transition: background-color 70ms;
}

.recent-item:hover {
  background-color: var(--vscode-bg-hover);
}

.recent-meta {
  flex: 1;
  min-width: 0;
}

.recent-name {
  font-size: var(--text-body);
  font-weight: 600;
  color: var(--vscode-accent);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.recent-item:hover .recent-name {
  color: var(--vscode-accent-hover);
}

.recent-path {
  font-size: var(--text-caption);
  color: var(--vscode-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Shown with its row, and whenever it holds focus so a keyboard user can
   still find it. */
.recent-remove-btn {
  flex: none;
  opacity: 0;
}

.recent-item:hover .recent-remove-btn,
.recent-remove-btn:focus-visible {
  opacity: 1;
}

/* ---- Ground ------------------------------------------------------------- */

/* Pushed to the bottom when the content is short; after it when it is long.
   Opaque, so the page's night doesn't show through the scene's sky on top of
   the scene's own. */
.welcome-ground {
  flex: none;
  margin-top: auto;
  background-color: var(--vscode-bg-editor);
}

/* ---- Night -------------------------------------------------------------- */

/* The page's night, behind the content: the same tint, strength and timing as
   the scene's own night layer, so the two meet without a seam, with stars
   that turn in on the scene's arc. */
.welcome-sky {
  position: absolute;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
}

.sky-tint {
  position: absolute;
  inset: 0;
  background: var(--scene-night);
  opacity: 0;
  transition: opacity var(--scene-night-fall) ease-in-out;
}

.welcome-tab:has(.spot-pot:hover) .sky-tint {
  opacity: var(--scene-night-opacity);
}

.sky-field {
  position: absolute;
  inset: 0;
  transform-origin: 177% -8%;
  transition: transform 1600ms ease-in-out;
}

.welcome-tab:has(.spot-pot:hover) .sky-field {
  transform: rotate(-3deg);
}

.star {
  position: absolute;
  width: var(--size);
  height: var(--size);
  border-radius: 50%;
  background: var(--scene-starlight);
  opacity: 0;
  transition: opacity 600ms ease-out;
}

.welcome-tab:has(.spot-pot:hover) .star {
  opacity: 0.85;
  transition-delay: 700ms;
  animation: sky-twinkle var(--tw) ease-in-out infinite var(--td);
}

@keyframes sky-twinkle {
  0%,
  100% {
    opacity: 0.85;
    transform: scale(1);
  }
  45% {
    opacity: 0.2;
    transform: scale(0.6);
  }
  60% {
    opacity: 0.8;
    transform: scale(1.15);
  }
}

@media (prefers-reduced-motion: reduce) {
  .welcome-tab:has(.spot-pot:hover) .star {
    animation: none;
  }
}

/* ---- Footer ------------------------------------------------------------- */

/* No rule or fill: the footer stands on the ground the hills end on. */
.welcome-footer {
  position: relative;
  z-index: 1;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 8px 32px 12px;
}

.welcome-startup-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 24px;
  font-size: var(--text-body-sm);
  color: var(--vscode-text-muted);
  cursor: pointer;
  user-select: none;
}

.welcome-startup-toggle:hover {
  color: var(--vscode-text-light);
}

.welcome-startup-toggle input {
  accent-color: var(--vscode-accent);
  cursor: pointer;
  margin: 0;
}
</style>
