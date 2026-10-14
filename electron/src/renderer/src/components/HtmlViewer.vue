<script setup lang="ts">
import { computed } from 'vue'
import { mediaUrlForPath } from '../lib/documentFiles'

/**
 * Rendered-HTML tab: the document in a fully sandboxed iframe (no scripts, no
 * same-origin, no forms/popups — the bare `sandbox` attribute) over the
 * goatcad-media:// protocol. Static subresources next to the file (images,
 * stylesheets, fonts) resolve and load through the protocol's extension
 * allowlist; scripts are doubly fenced — the sandbox refuses to run them and
 * the protocol refuses to serve them. Web links are intercepted in main
 * (will-frame-navigate) and opened in the system browser. The tab-bar source
 * toggle switches to the plain text editor (EditorArea routes it), which is
 * where editing happens.
 */

const props = defineProps<{
  filePath: string
}>()

const src = computed(() => mediaUrlForPath(props.filePath))
</script>

<template>
  <div class="html-viewer">
    <!-- credentialless: see PdfViewer.vue. -->
    <iframe class="html-frame" :src="src" sandbox="" title="HTML" credentialless></iframe>
  </div>
</template>

<style scoped>
.html-viewer {
  width: 100%;
  height: 100%;
}

.html-frame {
  display: block;
  width: 100%;
  height: 100%;
  border: none;
  /* Documents default to a transparent canvas; unstyled datasheet HTML
     (black text) must sit on the white it was written for, not the app's
     dark background. Pages that set their own background still win. */
  background-color: #ffffff;
}
</style>
