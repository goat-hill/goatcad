<script setup lang="ts">
/**
 * The KiCad version a design file was read at, when it is not the one we
 * write (lib/formatUpgrade.ts): a note at the top of the editor's Properties
 * panel, shown at the document level (nothing selected). An older file says
 * its next save upgrades it; a newer or pre-KiCad 6 one that it is read-only.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { formatUpgrader } from '../../lib/formatUpgrade'
import Icon from './Icon.vue'
import { tk, type MessageKey } from '../../lib/messageKey'
import type { KicadFormat } from '../../lib/kicad/migrate'

const props = defineProps<{ filePath: string | null | undefined }>()
const { t } = useI18n()

/** What the note calls the document: "KiCad 9 schematic format". */
const KIND: Record<KicadFormat, MessageKey> = {
  kicad_sch: tk('editorArea.formatNotice.kinds.schematic'),
  kicad_pcb: tk('editorArea.formatNotice.kinds.board'),
  kicad_symbol_lib: tk('editorArea.formatNotice.kinds.symbolLibrary'),
  footprint: tk('editorArea.formatNotice.kinds.footprint')
}

const notice = computed(
  (): { title: string; body: string; kind: 'upgrade' | 'read-only' } | null => {
    const state = props.filePath ? formatUpgrader.stateOf(props.filePath) : undefined
    if (!state) return null
    const release = state.release ?? 0
    const kind = t(KIND[state.format])
    if (state.status === 'older') {
      return {
        kind: 'upgrade',
        title: t('editorArea.formatNotice.older', { release, kind }),
        body: t('editorArea.formatNotice.olderBody', { kind })
      }
    }
    if (state.status === 'newer') {
      return {
        kind: 'read-only',
        title: state.release
          ? t('editorArea.formatNotice.newer', { release, kind })
          : t('editorArea.formatNotice.newerUnknown', { kind }),
        body: t('editorArea.formatNotice.newerBody', { kind })
      }
    }
    if (state.status === 'unsupported') {
      return {
        kind: 'read-only',
        title: t('editorArea.formatNotice.unsupported', { kind }),
        body: t('editorArea.formatNotice.unsupportedBody')
      }
    }
    return null
  }
)
</script>

<template>
  <div v-if="notice" class="format-notice" :class="notice.kind">
    <div class="format-notice-title">
      <Icon v-if="notice.kind === 'upgrade'" name="status-warning" class="format-notice-icon" />
      {{ notice.title }}
    </div>
    <div class="format-notice-body">{{ notice.body }}</div>
  </div>
</template>

<style scoped>
/* No fill: a tinted surface reads as a selection. */
.format-notice {
  margin: 10px 10px 4px;
}

.format-notice-title {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--vscode-text, #c5d3cd);
  font-size: var(--text-body-sm);
  font-weight: 600;
}

/* The glyph carries the warning, in the design-health pill's warning tint. */
.format-notice-icon {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  color: var(--vscode-warning);
  fill: var(--vscode-warning);
}

.format-notice-body {
  margin-top: 2px;
  color: var(--vscode-text-muted, #748780);
  font-size: var(--text-body-sm);
}
</style>
