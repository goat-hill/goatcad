<script setup lang="ts">
import Modal from './shared/Modal.vue'
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from './shared/Icon.vue'
import { useModalKeys } from '../lib/modalKeys'
import {
  feedbackIssueLink,
  formatSystemInfo,
  webglRenderer,
  type FeedbackKind
} from '../lib/feedback'

/**
 * Share app feedback: a draft that becomes a prefilled GitHub issue
 * (lib/feedback.ts). Nothing is sent from here — the user reviews and posts
 * the issue in their browser. The screenshot was taken before this opened
 * (App.vue), so it shows the window and not the dialog.
 */
const props = defineProps<{
  /** A thumbnail of the window as it was, or null when it could not be captured. */
  screenshot: string | null
}>()

const emit = defineEmits<{ (event: 'close'): void }>()

const { t, locale } = useI18n()

const kind = ref<FeedbackKind>('bug')
const title = ref('')
const description = ref('')
const includeSystemInfo = ref(true)
const showSystemInfo = ref(false)
const systemInfo = ref<string | null>(null)

const screenshotCopied = ref<boolean | null>(null)
/** The link, once the browser would not open it, for the user to copy. */
const unopenedUrl = ref<string | null>(null)
const linkCopied = ref(false)

const link = computed(() =>
  feedbackIssueLink({
    kind: kind.value,
    title: title.value,
    description: description.value,
    systemInfo: includeSystemInfo.value ? systemInfo.value : null
  })
)

const copyScreenshot = async (): Promise<void> => {
  screenshotCopied.value = await window.api.copyFeedbackScreenshot().catch(() => false)
}

const submit = async (): Promise<void> => {
  const { url } = link.value
  const opened = await window.api.openFeedbackIssue(url).catch(() => false)
  if (opened) emit('close')
  else unopenedUrl.value = url
}

const copyLink = async (): Promise<void> => {
  if (!unopenedUrl.value) return
  await navigator.clipboard.writeText(unopenedUrl.value)
  linkCopied.value = true
}

useModalKeys({ confirm: () => void submit() })

onMounted(async () => {
  try {
    const info = await window.api.getFeedbackSystemInfo()
    systemInfo.value = formatSystemInfo(info, { uiLocale: locale.value, gpu: webglRenderer() })
  } catch (err) {
    console.error('Failed to read system info for feedback', err)
  }
})

onUnmounted(() => {
  void window.api.discardFeedbackScreenshot()
})
</script>

<template>
  <Modal @dismiss="emit('close')">
    <div class="dialog">
      <h2 class="dialog-title">
        <Icon name="feedback" class="title-icon" />
        {{ t('feedback.title') }}
      </h2>

      <div class="segmented kind" role="radiogroup">
        <button
          class="segmented-btn"
          :class="{ active: kind === 'bug' }"
          role="radio"
          :aria-checked="kind === 'bug'"
          @click="kind = 'bug'"
        >
          {{ t('feedback.kind.bug') }}
        </button>
        <button
          class="segmented-btn"
          :class="{ active: kind === 'idea' }"
          role="radio"
          :aria-checked="kind === 'idea'"
          @click="kind = 'idea'"
        >
          {{ t('feedback.kind.idea') }}
        </button>
      </div>

      <label class="form-row">
        <span class="form-label">{{ t('feedback.summary') }}</span>
        <input
          v-model="title"
          class="field-md"
          type="text"
          spellcheck="true"
          :placeholder="t('feedback.summaryPlaceholder')"
        />
      </label>

      <label class="form-row">
        <span class="form-label">{{ t('feedback.details') }}</span>
        <textarea
          v-model="description"
          class="field-md details"
          rows="6"
          spellcheck="true"
          :placeholder="
            kind === 'bug'
              ? t('feedback.detailsBugPlaceholder')
              : t('feedback.detailsIdeaPlaceholder')
          "
        />
      </label>
      <p v-if="link.truncated" class="hint warning">{{ t('feedback.truncated') }}</p>

      <div class="form-row">
        <span class="form-label">{{ t('feedback.screenshot') }}</span>
        <div v-if="props.screenshot" class="screenshot">
          <img :src="props.screenshot" alt="" class="thumbnail" />
          <div class="screenshot-side">
            <button class="btn-outline btn-sm" @click="copyScreenshot">
              {{ t('feedback.copyScreenshot') }}
            </button>
            <p class="hint">
              {{
                screenshotCopied === true
                  ? t('feedback.screenshotCopied')
                  : screenshotCopied === false
                    ? t('feedback.screenshotCopyFailed')
                    : t('feedback.screenshotHint')
              }}
            </p>
          </div>
        </div>
        <p v-else class="hint">{{ t('feedback.noScreenshot') }}</p>
      </div>

      <div class="form-row">
        <div class="system-head">
          <label class="checkbox">
            <input v-model="includeSystemInfo" type="checkbox" />
            {{ t('feedback.includeSystemInfo') }}
          </label>
          <button
            v-if="systemInfo"
            class="btn-subtle btn-sm"
            :aria-expanded="showSystemInfo"
            @click="showSystemInfo = !showSystemInfo"
          >
            {{ showSystemInfo ? t('feedback.hideSystemInfo') : t('feedback.showSystemInfo') }}
          </button>
        </div>
        <pre v-if="showSystemInfo && systemInfo" class="system-info">{{ systemInfo }}</pre>
      </div>

      <p class="hint">{{ t('feedback.note') }}</p>

      <div v-if="unopenedUrl" class="open-failed">
        <p class="dialog-error">{{ t('feedback.openFailed') }}</p>
        <button class="btn-outline btn-sm" @click="copyLink">
          {{ linkCopied ? t('feedback.linkCopied') : t('feedback.copyLink') }}
        </button>
      </div>

      <div class="dialog-actions">
        <button class="btn-outline btn-md" @click="emit('close')">
          {{ t('feedback.cancel') }}
        </button>
        <button class="btn-cta btn-md" @click="submit">
          <Icon name="open-external" />
          {{ t('feedback.continue') }}
        </button>
      </div>
    </div>
  </Modal>
</template>

<style scoped>
.dialog {
  display: flex;
  flex-direction: column;
  gap: 14px;
  width: 90%;
  max-width: 560px;
  max-height: 90vh;
  padding: 24px;
  overflow-y: auto;
  border: 1px solid var(--vscode-border);
  border-radius: 8px;
  background-color: var(--vscode-bg-sidebar);
  box-shadow: 0 10px 30px var(--vscode-shadow-modal);
}

/* The command's glyph before its name (DESIGN.md §Modals). */
.dialog-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  color: var(--vscode-text-light);
  font-size: var(--text-heading);
  font-weight: 700;
}

.title-icon {
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  color: var(--vscode-text-light);
}

.kind {
  align-self: flex-start;
}

.form-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.form-label {
  color: var(--vscode-text);
  font-size: var(--text-body-sm);
  font-weight: 600;
}

.details {
  min-height: 96px;
  resize: vertical;
  line-height: 1.4;
}

.hint {
  margin: 0;
  color: var(--vscode-text-muted);
  font-size: var(--text-body-sm);
  line-height: 1.4;
}

.hint.warning {
  color: var(--vscode-warning);
}

.screenshot {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

.thumbnail {
  flex: none;
  width: 200px;
  max-height: 140px;
  object-fit: contain;
  object-position: left top;
  border: 1px solid var(--vscode-border);
  border-radius: 4px;
}

.screenshot-side {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
}

.system-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.checkbox {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--vscode-text);
  font-size: var(--text-body);
  cursor: pointer;
}

.checkbox input {
  margin: 0;
  accent-color: var(--vscode-accent);
}

.system-info {
  margin: 0;
  padding: 8px 10px;
  overflow-x: auto;
  border: 1px solid var(--vscode-border);
  border-radius: 4px;
  background: var(--vscode-input-bg);
  color: var(--vscode-text-muted);
  font-family: var(--font-mono);
  font-size: var(--text-caption);
  line-height: 1.5;
  white-space: pre;
}

.open-failed {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.dialog-error {
  margin: 0;
  color: var(--vscode-error);
  font-size: var(--text-body-sm);
}

.dialog-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 8px;
}
</style>
