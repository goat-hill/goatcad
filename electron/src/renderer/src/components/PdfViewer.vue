<script setup lang="ts">
import { computed } from 'vue'
import { mediaUrlForPath } from '../lib/documentFiles'

/**
 * PDF tab: Chromium's built-in PDFium viewer in an iframe, fed by the
 * streaming goatcad-media:// protocol (src/main/mediaProtocol.ts). The
 * protocol answers Range requests, so PDFium fetches only the byte ranges of
 * the pages actually viewed — a huge datasheet never fully loads into memory,
 * and its page cache lives in the PDF plugin process, not the renderer heap.
 * The native viewer chrome (search, page nav, zoom, print) is kept
 * deliberately: rebuilding those controls is exactly the weight this tab
 * avoids. No sandbox attribute — sandboxed frames block plugins, and the
 * viewer itself is Chromium's own UI, not document-controlled content.
 */

const props = defineProps<{
  filePath: string
}>()

const src = computed(() => mediaUrlForPath(props.filePath))
</script>

<template>
  <div class="pdf-viewer">
    <!-- credentialless: an isolated page (appProtocol.ts) embeds it, and Chromium's PDF viewer inside, without their opting in. -->
    <iframe class="pdf-frame" :src="src" title="PDF" credentialless></iframe>
  </div>
</template>

<style scoped>
.pdf-viewer {
  width: 100%;
  height: 100%;
  background-color: var(--vscode-bg-editor);
}

.pdf-frame {
  display: block;
  width: 100%;
  height: 100%;
  border: none;
}
</style>
