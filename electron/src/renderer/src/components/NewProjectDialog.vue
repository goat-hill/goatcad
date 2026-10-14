<script setup lang="ts">
import Modal from './shared/Modal.vue'
import { computed, nextTick, onMounted, ref } from 'vue'
import { useModalKeys } from '../lib/modalKeys'
import { useI18n } from 'vue-i18n'
import { scanForAdoption, type FolderEntry } from '../lib/project/adoptProject'
import { validateFileName } from '../lib/fileMenu'

/**
 * Create Project, in both shapes it takes: scaffold a blank design into an empty
 * folder, or adopt the loose `.kicad_sch` / `.kicad_pcb` already sitting in one.
 * One dialog rather than two, because which applies is a property of the target
 * folder (adoptProject.ts) — so the two entry points, the folder picker and the
 * no-project pane, cannot drift apart.
 *
 * A folder that already holds a `.kicad_pro` is neither: it offers to open that
 * instead of doing so silently.
 */
const props = defineProps<{
  /** Absolute path of the folder the project lands in. */
  folderPath: string
  /** Its own name — the default project name, and the root-sheet tiebreak. */
  folderName: string
  /** The folder's top-level listing. */
  entries: FolderEntry[]
}>()

const emit = defineEmits<{
  /** `rootSheet` is a file name in the folder, or null to scaffold a blank one. */
  (event: 'confirm', name: string, rootSheet: string | null): void
  (event: 'open-existing', fileName: string): void
  (event: 'cancel'): void
}>()

const { t } = useI18n()

const scan = computed(() => scanForAdoption(props.entries, props.folderName))

const name = ref('')
const rootSheet = ref<string | null>(null)
const nameInput = ref<HTMLInputElement | null>(null)

const siblings = computed(() => props.entries.map((entry) => entry.name))
const projectFileName = computed(() => `${name.value.trim()}.kicad_pro`)

const nameError = computed(() =>
  name.value.trim().length === 0 ? 'empty' : validateFileName(projectFileName.value, siblings.value)
)
const canCreate = computed(() => nameError.value === null)

const boardNames = computed(() => scan.value.boards.map((board) => board.name).join(', '))

const confirm = (): void => {
  if (canCreate.value) emit('confirm', name.value.trim(), rootSheet.value)
}

onMounted(() => {
  name.value = scan.value.suggestedName
  rootSheet.value = scan.value.suggestedRootSheet
  void nextTick(() => {
    nameInput.value?.focus()
    nameInput.value?.select()
  })
})

/**
 * Escape abandons, Enter runs the branch's call to action (DESIGN.md
 * §Modals): open the project already here, or create one — the name field
 * confirms on Enter itself. On `window`, because the already-a-project branch
 * renders no input to focus.
 */
useModalKeys({
  confirm: () => {
    if (scan.value.existingProject) emit('open-existing', scan.value.existingProject)
    else confirm()
  }
})
</script>

<template>
  <!-- Escape is handled on `window` above, so neither this nor the name field
       carries a `@keydown.esc` that works in only one branch. -->
  <Modal @dismiss="emit('cancel')">
    <div class="dialog">
      <!-- A. The folder is already a project: offer the open the user probably meant. -->
      <template v-if="scan.existingProject">
        <h2 class="dialog-title">{{ t('newProject.existsTitle') }}</h2>
        <p class="dialog-path">{{ folderPath }}</p>
        <p class="dialog-body">
          {{ t('newProject.existsBody', { name: scan.existingProject }) }}
        </p>
        <div class="dialog-actions">
          <button class="dialog-btn" @click="emit('cancel')">{{ t('newProject.cancel') }}</button>
          <button
            class="dialog-btn primary"
            @click="emit('open-existing', scan.existingProject as string)"
          >
            {{ t('newProject.open') }}
          </button>
        </div>
      </template>

      <template v-else>
        <h2 class="dialog-title">{{ t('newProject.title') }}</h2>
        <p class="dialog-path">{{ t('newProject.inFolder') }} {{ folderPath }}</p>

        <label class="field">
          <span class="field-label">{{ t('newProject.name') }}</span>
          <span class="field-row" :class="{ invalid: nameError }">
            <input
              ref="nameInput"
              v-model="name"
              class="field-input"
              type="text"
              spellcheck="false"
              @keydown.enter="confirm"
            />
            <span class="field-suffix">.kicad_pro</span>
          </span>
        </label>
        <p v-if="nameError" class="field-error">{{ t(`newProject.errors.${nameError}`) }}</p>

        <!-- B. Loose design files: adopt them rather than scaffolding blanks
             beside them. The root sheet is the only real choice here — boards
             are members by location, so there is nothing to decide. -->
        <template v-if="scan.schematics.length > 0">
          <h3 class="section-title">{{ t('newProject.foundTitle') }}</h3>
          <p class="section-hint">{{ t('newProject.rootSheetLabel') }}</p>
          <div class="choice-list">
            <label v-for="sheet in scan.schematics" :key="sheet.name" class="choice">
              <input v-model="rootSheet" type="radio" :value="sheet.name" />
              <span class="choice-name">{{ sheet.name }}</span>
            </label>
            <label class="choice">
              <input v-model="rootSheet" type="radio" :value="null" />
              <span class="choice-name muted">{{ t('newProject.blankSheet') }}</span>
            </label>
          </div>
          <p v-if="scan.boards.length > 0" class="section-hint">
            {{ t('newProject.boardsIncluded', { names: boardNames }) }}
          </p>
        </template>

        <!-- C. Nothing to adopt. -->
        <p v-else class="section-hint">{{ t('newProject.emptyNote') }}</p>

        <div class="dialog-actions">
          <button class="dialog-btn" @click="emit('cancel')">{{ t('newProject.cancel') }}</button>
          <button class="dialog-btn primary" :disabled="!canCreate" @click="confirm">
            {{ t('newProject.create') }}
          </button>
        </div>
      </template>
    </div>
  </Modal>
</template>

<style scoped>
.dialog {
  display: flex;
  flex-direction: column;
  width: 90%;
  max-width: 440px;
  padding: 22px;
  border: 1px solid var(--vscode-border);
  border-radius: 8px;
  background-color: var(--vscode-bg-sidebar);
  box-shadow: 0 10px 30px var(--vscode-shadow-modal);
}

.dialog-title {
  margin: 0;
  color: var(--vscode-text-light);
  font-size: 16px;
  font-weight: 700;
}

.dialog-path {
  margin: 4px 0 0;
  overflow: hidden;
  color: var(--vscode-text-muted);
  font: 11px var(--font-mono);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dialog-body {
  margin: 14px 0 0;
  color: var(--vscode-text);
  font-size: 12px;
  line-height: 1.45;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 18px;
}

.field-label {
  color: var(--vscode-text-muted);
  font-size: var(--text-body-sm);
  font-weight: 600;
}

.field-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  border: 1px solid var(--vscode-input-border);
  border-radius: 3px;
  background: var(--vscode-input-bg);
}

.field-row:focus-within {
  border-color: var(--vscode-accent);
}

.field-row.invalid {
  border-color: var(--vscode-error, #d9534f);
}

.field-input {
  flex: 1;
  min-width: 0;
  border: none;
  background: none;
  color: var(--vscode-text);
  font: 12px var(--font-mono);
  outline: none;
}

.field-suffix {
  color: var(--vscode-text-muted);
  font: 12px var(--font-mono);
}

.field-error {
  margin: 5px 0 0;
  color: var(--vscode-error, #d9534f);
  font-size: var(--text-body-sm);
}

.section-title {
  margin: 18px 0 0;
  color: var(--vscode-text-light);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.section-hint {
  margin: 6px 0 0;
  color: var(--vscode-text-muted);
  font-size: 11px;
  line-height: 1.4;
}

.choice-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 6px;
}

.choice {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 4px 6px;
  border-radius: 3px;
  cursor: pointer;
}

.choice:hover {
  background: var(--vscode-overlay-control);
}

.choice-name {
  color: var(--vscode-text);
  font: 12px var(--font-mono);
}

.choice-name.muted {
  color: var(--vscode-text-muted);
  font: 12px inherit;
}

.dialog-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 22px;
}

.dialog-btn {
  padding: 6px 14px;
  border: 1px solid var(--vscode-border);
  border-radius: 3px;
  background: none;
  color: var(--vscode-text);
  font-size: 12px;
  cursor: pointer;
}

.dialog-btn:hover:not(:disabled) {
  border-color: var(--vscode-accent);
  color: var(--vscode-accent);
}

.dialog-btn.primary {
  border-color: var(--vscode-accent);
  background: var(--vscode-accent);
  color: var(--vscode-on-accent);
  font-weight: 600;
}

.dialog-btn.primary:hover:not(:disabled) {
  filter: brightness(1.08);
  color: var(--vscode-on-accent);
}

.dialog-btn:disabled {
  opacity: 0.45;
  cursor: default;
}
</style>
