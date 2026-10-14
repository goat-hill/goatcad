<script setup lang="ts">
import { ref, watch } from 'vue'
import SchematicViewport2D from './schematic/SchematicViewport2D.vue'
import { namespaceSymbolLibrary } from '../lib/kicad/symbolLibrary'
import { libSymbolChain, type KicadLibSymbol, type KicadSchematic } from '../lib/kicad/schematic'
import { symbolPreviewSheet } from '../lib/libraryLoad'
import type { GridSettings } from '../lib/engine/ViewportEngine'

/**
 * Read-only symbol renderer for the Component view and the library chooser:
 * the definition placed alone on a sheet (`symbolPreviewSheet`), drawn by the
 * real `SchematicViewport2D`. Given a parsed `chain` it draws that; otherwise
 * it reads `symbol` from `library` in `file`. Pan/zoom view only.
 */
const props = defineProps<{
  file?: string
  library?: string
  symbol?: string
  chain?: KicadLibSymbol[] | null
  /** Drop the canvas's status pills (`SchematicViewport2D.bare`). */
  bare?: boolean
}>()
const schematic = ref<KicadSchematic | null>(null)
const revision = ref(0)

const grid: GridSettings = { spacing: 1.27, unit: 'mm', visible: true, snap: true }

const readChain = async (): Promise<KicadLibSymbol[] | null> => {
  if (props.chain) return props.chain
  if (!props.file || !props.library || !props.symbol) return null
  const res = await window.api.readSymbolLibrary(props.file)
  if (!res.success || !res.content) return null
  const parsed = namespaceSymbolLibrary(res.content, props.library)
  const def = parsed.doc.libSymbols.get(`${props.library}:${props.symbol}`)
  return def ? libSymbolChain(def, (name) => parsed.doc.libSymbols.get(name)) : null
}

watch(
  () => [props.file, props.library, props.symbol, props.chain],
  async () => {
    schematic.value = null
    const token = ++revision.value
    try {
      const chain = await readChain()
      if (!chain || token !== revision.value) return
      schematic.value = symbolPreviewSheet(chain)
      revision.value++
    } catch (err) {
      console.error('Failed to build symbol preview', err)
    }
  },
  { immediate: true }
)
</script>

<template>
  <div class="csv">
    <SchematicViewport2D
      v-if="schematic"
      :schematic="schematic"
      :revision="revision"
      :selected-items="[]"
      :grid-settings="grid"
      :connectivity="null"
      sheet-path="/"
      active-tool="select"
      :wire-draft="[]"
      wire-posture="hv"
      :placement="null"
      preview
      :bare="bare"
    />
  </div>
</template>

<style scoped>
.csv {
  width: 100%;
  height: 100%;
  position: relative;
}
</style>
