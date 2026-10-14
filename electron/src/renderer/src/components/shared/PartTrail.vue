<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import Icon from './Icon.vue'

/**
 * Where a library part lives, as every surface names it: scope › library ›
 * **name** (the chooser's and Component view's slot heads, a placed part's
 * library section). The scope is left out where it is not known — a lib id
 * no library holds is still its library › name.
 */
defineProps<{
  library: string
  name: string
  /** The index record's scope: project, global or system. */
  scope?: string
}>()
const { t } = useI18n()

const scopeLabel = (scope: string): string =>
  scope === 'project'
    ? t('componentView.scope.project')
    : scope === 'global'
      ? t('componentView.scope.global')
      : t('componentView.scope.system')
</script>

<template>
  <span class="part-trail">
    <template v-if="scope">
      {{ scopeLabel(scope) }} <Icon name="chevron-right" class="breadcrumb-sep" />
    </template>
    <template v-if="library">
      {{ library }} <Icon name="chevron-right" class="breadcrumb-sep" />
    </template>
    <b>{{ name }}</b>
    <slot />
  </span>
</template>

<style scoped>
.part-trail {
  min-width: 0;
  overflow: hidden;
  color: var(--vscode-text-muted, #a9b6b0);
  font-size: var(--text-body-sm);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.part-trail b {
  color: var(--vscode-text-light, #f0f0f2);
  font-weight: 600;
}
</style>
