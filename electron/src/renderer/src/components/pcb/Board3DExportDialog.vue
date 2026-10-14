<script setup lang="ts">
/**
 * Export image — the board's 3D view as a PNG at a chosen size. The camera,
 * what is shown and its presentation are the pane's as it stands, so the dialog
 * asks only for the size and shows the picture it will make. Choices hold for
 * the session (`lib/board3dExport.ts`); the host draws and writes the picture.
 */
import Modal from '../shared/Modal.vue'
import { computed, ref, watch } from 'vue'
import { useModalKeys } from '../../lib/modalKeys'
import { useI18n } from 'vue-i18n'
import Icon from '../shared/Icon.vue'
import { board3dPresentation } from '../../lib/board3dView'
import {
  BOARD3D_EXPORT_MAX_PIXELS,
  BOARD3D_EXPORT_MIN_PIXELS,
  BOARD3D_EXPORT_PRESETS,
  board3dExportChoice,
  clampExportPixels,
  fitExportSize,
  fitWithin,
  resolveExportSize,
  sizeAtAspect,
  type Board3DExportSizeId,
  type PixelSize
} from '../../lib/board3dExport'

const props = defineProps<{
  /** The 3D pane in device pixels: what "Current view" exports. */
  viewSize: PixelSize
  /** The view drawn at a size, as a PNG data URL; null when it cannot be. */
  preview: (size: PixelSize) => string | null
  /** What the last Copy came to, said beside the buttons; empty for nothing. */
  status: string
}>()

const emit = defineEmits<{
  (e: 'save', size: PixelSize): void
  (e: 'copy', size: PixelSize): void
  (e: 'close'): void
}>()

const { t } = useI18n()

const choice = board3dExportChoice
const presentation = board3dPresentation()
const view = computed(() => fitExportSize(props.viewSize))
const size = computed(() => resolveExportSize(choice.size, props.viewSize, choice.custom))

/** Width over height, as the lock holds it: taken when a size is chosen or
 *  typed unlocked, never re-read from pixels a locked edit rounded. */
const aspect = ref(size.value.width / size.value.height)
const holdAspect = (): void => {
  aspect.value = size.value.width / size.value.height
}

const onSize = (event: Event): void => {
  const next = (event.target as HTMLSelectElement).value as Board3DExportSizeId
  // Custom starts from the size it replaces, so the fields never jump.
  if (next === 'custom') choice.custom = { ...size.value }
  choice.size = next
  holdAspect()
}

/** Typing a side makes the size custom; locked, the other side follows. */
const onSide = (side: keyof PixelSize, event: Event): void => {
  const input = event.target as HTMLInputElement
  const typed = Number(input.value)
  choice.custom = choice.locked
    ? sizeAtAspect(side, typed, aspect.value)
    : { ...size.value, [side]: clampExportPixels(typed) }
  choice.size = 'custom'
  if (!choice.locked) holdAspect()
  input.value = String(choice.custom[side])
}

const toggleLock = (): void => {
  choice.locked = !choice.locked
  if (choice.locked) holdAspect()
}

/** The preview's box, CSS px: the dialog's inner width by a height that keeps it compact. */
const PREVIEW_WIDTH = 472
const PREVIEW_HEIGHT = 280
const previewSize = computed(() => fitWithin(size.value, PREVIEW_WIDTH, PREVIEW_HEIGHT))
const previewUrl = ref<string | null>(null)
watch(
  previewSize,
  (shown) => {
    const ratio = window.devicePixelRatio || 1
    previewUrl.value = props.preview({
      width: Math.round(shown.width * ratio),
      height: Math.round(shown.height * ratio)
    })
  },
  { immediate: true }
)

/** Enter saves (DESIGN.md §Modals); on `window`, as it opens without taking focus. */
useModalKeys({ confirm: () => emit('save', size.value) })
</script>

<template>
  <Modal @dismiss="emit('close')">
    <div class="dialog">
      <h2 class="dialog-title">
        <Icon name="tool-export" class="title-icon" />
        {{ t('pcbEditor.viewport3d.exportImage.title') }}
      </h2>

      <div class="preview">
        <img
          v-if="previewUrl"
          class="preview-image"
          :class="{ 'transparent-ground': presentation.background === 'transparent' }"
          :src="previewUrl"
          :width="previewSize.width"
          :height="previewSize.height"
          :alt="t('pcbEditor.viewport3d.exportImage.preview')"
        />
      </div>

      <label class="group">
        <span class="eyebrow">{{ t('pcbEditor.viewport3d.exportImage.size') }}</span>
        <select class="field-md" :value="choice.size" @change="onSize">
          <option value="view">
            {{ t('pcbEditor.viewport3d.exportImage.sizeView', { ...view }) }}
          </option>
          <option v-for="preset in BOARD3D_EXPORT_PRESETS" :key="preset.id" :value="preset.id">
            {{ t('pcbEditor.viewport3d.exportImage.sizePreset', { ...preset }) }}
          </option>
          <option value="custom">{{ t('pcbEditor.viewport3d.exportImage.sizeCustom') }}</option>
        </select>
      </label>

      <div class="sides">
        <label class="side">
          <span>{{ t('pcbEditor.viewport3d.exportImage.width') }}</span>
          <input
            class="field-md pixels"
            type="number"
            step="1"
            :min="BOARD3D_EXPORT_MIN_PIXELS"
            :max="BOARD3D_EXPORT_MAX_PIXELS"
            :value="size.width"
            @change="onSide('width', $event)"
          />
        </label>
        <button
          type="button"
          class="btn-outline btn-icon-md lock"
          :title="t('pcbEditor.viewport3d.exportImage.lockAspect')"
          :aria-pressed="choice.locked"
          @click="toggleLock"
        >
          <Icon :name="choice.locked ? 'tool-lock' : 'tool-unlock'" />
        </button>
        <label class="side">
          <span>{{ t('pcbEditor.viewport3d.exportImage.height') }}</span>
          <input
            class="field-md pixels"
            type="number"
            step="1"
            :min="BOARD3D_EXPORT_MIN_PIXELS"
            :max="BOARD3D_EXPORT_MAX_PIXELS"
            :value="size.height"
            @change="onSide('height', $event)"
          />
        </label>
      </div>

      <div class="actions">
        <span class="status" role="status">{{ status }}</span>
        <button class="btn-outline btn-md" type="button" @click="emit('close')">
          {{ t('common.cancel') }}
        </button>
        <button class="btn-outline btn-md" type="button" @click="emit('copy', size)">
          {{ t('pcbEditor.viewport3d.exportImage.copy') }}
        </button>
        <button class="btn-cta btn-md" type="button" @click="emit('save', size)">
          {{ t('pcbEditor.viewport3d.exportImage.save') }}
        </button>
      </div>
    </div>
  </Modal>
</template>

<style scoped>
.dialog {
  display: flex;
  flex-direction: column;
  gap: 16px;
  width: 90%;
  max-width: 522px;
  padding: 24px;
  border: 1px solid var(--vscode-border);
  border-radius: 8px;
  background-color: var(--vscode-bg-sidebar);
  box-shadow: 0 10px 30px var(--vscode-shadow-modal);
}

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

/* Holds its height whatever the picture's shape, so the fields below never
   move as a size is typed. */
.preview {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 280px;
}

.preview-image {
  max-width: 100%;
  border: 1px solid var(--vscode-border);
  border-radius: 6px;
  object-fit: contain;
}

.group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* Section eyebrow per DESIGN.md §3. */
.eyebrow {
  color: var(--vscode-text-muted);
  font-size: var(--text-caption);
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.sides {
  display: flex;
  align-items: center;
  gap: 8px;
}

.side {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 8px;
  min-width: 0;
  color: var(--vscode-text);
  font-size: var(--text-body);
}

.pixels {
  flex: 1;
  min-width: 0;
  font-family: var(--font-mono);
}

/* The palette glyph on its own 20px grid (DESIGN.md §Icons). */
.lock > svg {
  width: 20px;
  height: 20px;
}

/* Hint per DESIGN.md §3: caption size, muted. */
.status {
  margin-right: auto;
  color: var(--vscode-text-muted);
  font-size: var(--text-caption);
}

.actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}
</style>
