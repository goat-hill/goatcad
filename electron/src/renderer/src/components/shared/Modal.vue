<script setup lang="ts">
/**
 * The modal frame (DESIGN.md §Modals): the platform's own modal dialog, so its
 * behavior is the platform's rather than ours to keep in step.
 *
 * `showModal()` puts the panel in the top layer above every editor, makes the
 * rest of the window inert and keeps focus inside. `closedby="any"` gives the
 * platform's light dismiss: Escape, or a press that both begins and ends
 * outside the panel (a drag out of a field is not one). Both arrive as one
 * `cancel`, which this turns into `dismiss` for the owner to close it by
 * unmounting; the dialog never closes itself out from under its state.
 *
 * Mounting opens it. `hidden` sets it aside without dismissing it, while a
 * modal it opened (a chooser) is in front.
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = defineProps<{ hidden?: boolean }>()
const emit = defineEmits<{ (e: 'dismiss'): void }>()

const dialog = ref<HTMLDialogElement | null>(null)
/** Closes asked for by `hidden`, whose `close` events (they arrive later) are not dismissals. */
let setAside = 0
let unmounted = false

const show = (): void => {
  const el = dialog.value
  if (!el || el.open) return
  el.showModal()
}
const setAsideNow = (): void => {
  const el = dialog.value
  if (!el?.open) return
  setAside++
  el.close()
}

onMounted(() => {
  // Set as an attribute: the IDL property is newer than the DOM typings.
  dialog.value?.setAttribute('closedby', 'any')
  if (!props.hidden) show()
})
watch(
  () => props.hidden,
  (hidden) => (hidden ? setAsideNow() : show())
)
onBeforeUnmount(() => {
  unmounted = true
  dialog.value?.close()
})

const onCancel = (event: Event): void => {
  // A cancel the platform does not let us hold (repeated without the person
  // acting in between) closes it anyway: the `close` that follows says so.
  if (!event.cancelable) return
  // The owner closes it, by unmounting; until then it stays as it is.
  event.preventDefault()
  emit('dismiss')
}
const onClose = (): void => {
  if (setAside > 0) {
    setAside--
    return
  }
  if (!unmounted) emit('dismiss')
}
</script>

<template>
  <dialog ref="dialog" class="modal" aria-modal="true" @cancel="onCancel" @close="onClose">
    <slot />
  </dialog>
</template>

<style scoped>
/* The dialog is only the frame: the panel inside sizes and styles itself.
   It states its own placement, the platform's for a modal dialog, so no rule
   for where it is mounted (`.canvas-top-right > *` sets every child relative)
   can move it off the center. */
.modal {
  position: fixed;
  inset: 0;
  width: fit-content;
  height: fit-content;
  max-width: none;
  max-height: none;
  margin: auto;
  padding: 0;
  overflow: visible;
  border: none;
  background: transparent;
  color: inherit;
}

.modal:focus-visible {
  outline: none;
}

.modal::backdrop {
  background-color: var(--vscode-scrim);
  backdrop-filter: blur(4px);
}
</style>
