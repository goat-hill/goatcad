<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from './shared/Icon.vue'
import type { GitBranch } from '../../../preload/gitTypes'
import { matchesHotkey } from '../lib/hotkeys'

const { t } = useI18n()

const props = defineProps<{
  branches: GitBranch[]
  loading: boolean
  /** Checkout/list failure surfaced inline; the picker stays open. */
  error: string | null
}>()

const emit = defineEmits<{
  (e: 'checkout', name: string, create: boolean): void
  (e: 'close'): void
}>()

const query = ref('')
const inputEl = ref<HTMLInputElement | null>(null)

// Escape on the window, not the input: a click inside the list moves focus off
// it, and the picker must still close (DESIGN.md §Modals).
const onWindowKeydown = (e: KeyboardEvent): void => {
  if (matchesHotkey(e, 'app.dismiss')) {
    e.preventDefault()
    emit('close')
  }
}
onMounted(() => {
  inputEl.value?.focus()
  window.addEventListener('keydown', onWindowKeydown)
})
onUnmounted(() => window.removeEventListener('keydown', onWindowKeydown))

const filtered = computed((): GitBranch[] => {
  const q = query.value.trim().toLowerCase()
  return q ? props.branches.filter((b) => b.name.toLowerCase().includes(q)) : props.branches
})

// The create row appears once the query names something that doesn't exist.
const showCreate = computed((): boolean => {
  const q = query.value.trim()
  return q.length > 0 && !props.branches.some((b) => b.name === q)
})

const pick = (branch: GitBranch): void => {
  if (branch.current) {
    emit('close')
    return
  }
  emit('checkout', branch.name, false)
}

/** The row Enter takes, moved with the arrows; the create row is the last one. */
const highlighted = ref(0)
const rowCount = computed(() => filtered.value.length + (showCreate.value ? 1 : 0))
watch(query, () => {
  highlighted.value = 0
})

const moveHighlight = (step: number): void => {
  if (rowCount.value === 0) return
  highlighted.value = (highlighted.value + step + rowCount.value) % rowCount.value
}

// Enter: the highlighted branch, else create what was typed.
const submit = (): void => {
  const branch = filtered.value[highlighted.value]
  if (branch) {
    pick(branch)
  } else if (showCreate.value) {
    emit('checkout', query.value.trim(), true)
  }
}
</script>

<template>
  <div class="branch-picker-overlay" @click="emit('close')"></div>
  <div class="branch-picker">
    <input
      ref="inputEl"
      v-model="query"
      class="field-sm branch-picker-input"
      :placeholder="t('app.branchPicker.placeholder')"
      spellcheck="false"
      @keydown.enter.prevent="submit"
      @keydown.down.prevent="moveHighlight(1)"
      @keydown.up.prevent="moveHighlight(-1)"
    />
    <div v-if="error" class="branch-picker-error">{{ error }}</div>
    <div class="branch-picker-list">
      <div v-if="loading" class="branch-picker-empty">{{ t('app.branchPicker.loading') }}</div>
      <template v-else>
        <button
          v-for="(branch, i) in filtered"
          :key="branch.name"
          class="branch-picker-row"
          :class="{ current: branch.current, highlighted: i === highlighted }"
          tabindex="-1"
          @click="pick(branch)"
          @mousemove="highlighted = i"
        >
          <!-- Same branch glyph as the activity bar -->
          <Icon name="git-branch" />
          <span class="branch-picker-name">{{ branch.name }}</span>
          <Icon v-if="branch.current" name="check" class="branch-picker-check" />
        </button>
        <button
          v-if="showCreate"
          class="branch-picker-row create"
          :class="{ highlighted: highlighted === filtered.length }"
          tabindex="-1"
          @click="emit('checkout', query.trim(), true)"
          @mousemove="highlighted = filtered.length"
        >
          <Icon name="plus" />
          <span class="branch-picker-name">{{
            t('app.branchPicker.create', { name: query.trim() })
          }}</span>
        </button>
        <div v-if="filtered.length === 0 && !showCreate" class="branch-picker-empty">
          {{ t('app.branchPicker.noBranches') }}
        </div>
      </template>
    </div>
  </div>
</template>
