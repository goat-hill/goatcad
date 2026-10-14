<script setup lang="ts">
/**
 * The repo's state at the foot of the sidebar's explorer, under Project: the
 * branch (`branch*` when dirty) with ahead / behind when it tracks an
 * upstream, and a push or pull in flight or the reason it failed. Always there
 * while the window's folder is a repo, and absent otherwise (quiet
 * degradation, as `gitStatus.ts` has it).
 */
import { computed, inject } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '../shared/Icon.vue'
import { GIT_KEY } from '../../lib/git/gitOps'
import { gitRemoteErrorKey } from '../../lib/git/gitCopy'
import type { GitStatusResult } from '../../../../preload/gitTypes'

const props = defineProps<{ gitStatus: GitStatusResult | null }>()

const emit = defineEmits<{
  (e: 'open-branch-picker'): void
  (e: 'open-git-pane'): void
}>()

const { t } = useI18n()
const git = inject(GIT_KEY, null)

const branch = computed((): string | null => {
  const status = props.gitStatus
  if (status?.state !== 'ok' || !status.branch) return null
  return `${status.branch}${status.files.length > 0 ? '*' : ''}`
})

/** Commits ahead of / behind the upstream, when the branch tracks one. */
const upstream = computed((): { ahead: number; behind: number } | null => {
  const status = props.gitStatus
  if (status?.state !== 'ok' || status.ahead === undefined) return null
  return { ahead: status.ahead, behind: status.behind ?? 0 }
})

/** A remote op in flight, or why the last one failed. */
const remote = computed((): { text: string; error: boolean; title: string } | null => {
  if (!git) return null
  if (git.remote.value) {
    const text = git.remote.value === 'push' ? t('git.pane.pushing') : t('git.pane.pulling')
    return { text, error: false, title: text }
  }
  const err = git.error.value
  if (!err?.op) return null
  const key = gitRemoteErrorKey(err)
  return { text: key ? t(key) : err.message, error: true, title: err.message }
})
</script>

<template>
  <div v-if="branch" class="git-status-footer">
    <button
      type="button"
      class="git-status-item"
      :title="t('sidebar.gitStatus.branchTitle')"
      @click="emit('open-branch-picker')"
    >
      <Icon name="git-branch" />
      <span class="git-status-branch">{{ branch }}</span>
      <span v-if="upstream" class="git-status-upstream">
        <Icon name="arrow-up" />{{ upstream.ahead }} <Icon name="arrow-down" />{{ upstream.behind }}
      </span>
    </button>
    <button
      v-if="remote"
      type="button"
      class="git-status-item git-status-remote"
      :class="{ error: remote.error }"
      :title="remote.title"
      @click="emit('open-git-pane')"
    >
      {{ remote.text }}
    </button>
  </div>
</template>

<style scoped>
/* Pinned under the explorer's sections; the top rule is the separator. */
.git-status-footer {
  flex: none;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px 8px;
  padding: 2px 6px;
  border-top: 1px solid var(--vscode-border);
  font-size: var(--text-body-sm);
  color: var(--vscode-text-muted);
}

.git-status-item {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  min-height: 24px;
  padding: 0 6px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}

.git-status-item:hover {
  background-color: var(--vscode-bg-hover);
  color: var(--vscode-text);
}

.git-status-branch {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.git-status-item :deep(svg) {
  flex: none;
  width: 12px;
  height: 12px;
  fill: currentColor;
}

.git-status-upstream {
  display: inline-flex;
  align-items: center;
  gap: 1px;
  white-space: nowrap;
}

/* A failed push or pull, until the next git op clears it. */
.git-status-remote.error {
  color: var(--vscode-error);
}
</style>
