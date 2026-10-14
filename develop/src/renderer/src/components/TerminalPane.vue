<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { fontSize } from '../terminalFont'
import type { TerminalClipboardAction } from '../hotkeys'
import { registerTerminal } from '../terminalClipboard'

const props = defineProps<{
  sessionId: string
  visible: boolean
  /** Bumped by the app to hand keyboard focus to the pane whose id matches. */
  focusSignal?: { id: string; seq: number }
}>()

const host = ref<HTMLDivElement>()

// Wheel scroll speed, in xterm's "times the default" units. The option below covers
// normal-buffer scrollback; the custom wheel handler covers alt-screen TUIs (Claude
// Code, less, …), which consume the wheel themselves one event at a time.
const SCROLL_SPEED = 3

let terminal: Terminal | undefined
let fit: FitAddon | undefined
const cleanups: (() => void)[] = []

/** This terminal's half of the clipboard, reached through terminalClipboard.ts. */
async function runClipboardAction(action: TerminalClipboardAction): Promise<void> {
  if (!terminal) return
  switch (action) {
    case 'copy': {
      const text = terminal.getSelection()
      if (text) window.api.writeClipboard(text)
      break
    }
    case 'paste': {
      // terminal.paste, never a raw write to the pty: it honors bracketed-paste
      // mode, so multi-line text lands in the app's input (Claude's prompt, an
      // editor) instead of the shell running it line by line as it arrives.
      const text = await window.api.readClipboard()
      if (text) terminal.paste(text)
      break
    }
    case 'selectAll':
      terminal.selectAll()
      break
  }
}

onMounted(async () => {
  if (!host.value) return

  terminal = new Terminal({
    fontFamily: '"JetBrainsMono Nerd Font", "JetBrains Mono", "Fira Code", monospace',
    fontSize: fontSize.value,
    scrollback: 10000,
    scrollSensitivity: SCROLL_SPEED,
    theme: {
      background: '#10141a',
      foreground: '#d5dde2',
      cursor: '#6fb7a0',
      selectionBackground: '#242b38'
    }
  })
  fit = new FitAddon()
  terminal.loadAddon(fit)
  terminal.open(host.value)

  // scrollSensitivity only speeds up normal-buffer viewport scrolling. On the
  // alternate screen (Claude Code, less, vim) xterm forwards exactly one mouse
  // report or arrow key per physical wheel event, so replay each real event
  // SCROLL_SPEED-1 extra times; the synthetic copies (isTrusted false) pass through.
  terminal.attachCustomWheelEventHandler((event) => {
    if (!event.isTrusted || terminal?.buffer.active.type !== 'alternate') return true
    for (let i = 1; i < SCROLL_SPEED; i++) {
      event.target?.dispatchEvent(
        new WheelEvent('wheel', {
          deltaX: event.deltaX,
          deltaY: event.deltaY,
          deltaMode: event.deltaMode,
          clientX: event.clientX,
          clientY: event.clientY,
          ctrlKey: event.ctrlKey,
          altKey: event.altKey,
          shiftKey: event.shiftKey,
          metaKey: event.metaKey,
          bubbles: true,
          cancelable: true
        })
      )
    }
    return true
  })

  cleanups.push(registerTerminal({ element: host.value, run: runClipboardAction }))

  const onContextMenu = async (event: MouseEvent): Promise<void> => {
    event.preventDefault()
    const action = await window.api.showTerminalMenu(terminal?.hasSelection() ?? false)
    if (action) void runClipboardAction(action)
    terminal?.focus()
  }
  // Dragging out a selection in a system terminal makes it middle-click-pastable
  // everywhere else on Linux, so ours does the same. On mouseup rather than
  // onSelectionChange: a drag fires one of those per cell crossed.
  const onMouseUp = (): void => {
    const text = terminal?.getSelection()
    if (text) window.api.writePrimarySelection(text)
  }
  host.value.addEventListener('contextmenu', onContextMenu)
  host.value.addEventListener('mouseup', onMouseUp)
  cleanups.push(() => {
    host.value?.removeEventListener('contextmenu', onContextMenu)
    host.value?.removeEventListener('mouseup', onMouseUp)
  })

  // Live data is queued until the scrollback snapshot has been replayed; the stream
  // offset that accompanies each chunk dedupes anything the snapshot already contains.
  let replayed = false
  const queued: { data: string; offset: number }[] = []
  cleanups.push(
    window.api.onPtyData((id, data, offset) => {
      if (id !== props.sessionId) return
      if (replayed) terminal?.write(data)
      else queued.push({ data, offset })
    })
  )
  cleanups.push(
    window.api.onPtyExit((id, exitCode) => {
      if (id !== props.sessionId) return
      terminal?.write(`\r\n\x1b[90m[process exited with code ${exitCode}]\x1b[0m\r\n`)
    })
  )

  const snapshot = await window.api.ptySnapshot(props.sessionId)
  if (snapshot.data) terminal.write(snapshot.data)
  for (const chunk of queued) {
    if (chunk.offset > snapshot.offset) terminal.write(chunk.data)
  }
  replayed = true

  terminal.onData((data) => window.api.ptyInput(props.sessionId, data))
  terminal.onResize(({ cols, rows }) => window.api.ptyResize(props.sessionId, cols, rows))
  fit.fit()
  terminal.focus()

  const doFit = (): void => {
    if (props.visible) fit?.fit()
  }

  // Fit off the ResizeObserver callback: fitting inside it measures mid-layout.
  // A rAF fit tracks the size responsively during a drag, and a trailing timer
  // guarantees one more fit after the resize settles, in case a live window-edge
  // drag starves rAF and the last frame-based fit ran against a stale size.
  // (The row-clipping itself is fixed in CSS — see .terminal-host's inset.)
  let fitScheduled = false
  let settleTimer: ReturnType<typeof setTimeout> | undefined
  const scheduleFit = (): void => {
    if (settleTimer) clearTimeout(settleTimer)
    settleTimer = setTimeout(doFit, 120)
    if (fitScheduled) return
    fitScheduled = true
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        fitScheduled = false
        doFit()
      })
    )
  }
  const observer = new ResizeObserver(scheduleFit)
  observer.observe(host.value)
  cleanups.push(() => {
    observer.disconnect()
    if (settleTimer) clearTimeout(settleTimer)
  })
})

// App-wide zoom: apply the new size to every terminal and re-fit the visible
// ones (a re-fit recomputes cols/rows and reports them to the pty). Hidden panes
// pick up the size when they're next shown by the `visible` watcher's fit.
watch(fontSize, (size) => {
  if (!terminal) return
  terminal.options.fontSize = size
  if (props.visible) fit?.fit()
})

watch(
  () => props.focusSignal,
  (signal) => {
    if (signal && signal.id === props.sessionId) {
      // Next frame: the pane may be un-hidden in this same flush.
      requestAnimationFrame(() => terminal?.focus())
    }
  }
)

watch(
  () => props.visible,
  (visible) => {
    if (visible) {
      // Double frame for the same reason as scheduleFit: a pane un-hidden right
      // after a resize can otherwise fit to a height that hasn't settled yet.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          fit?.fit()
          terminal?.focus()
        })
      )
    }
  }
)

onBeforeUnmount(() => {
  cleanups.forEach((cleanup) => cleanup())
  terminal?.dispose()
})
</script>

<template>
  <div ref="host" class="terminal-host"></div>
</template>

<style scoped>
.terminal-host {
  position: absolute;
  /* Inset the host rather than padding it. FitAddon derives the row count from
     getComputedStyle(host).height, which under box-sizing:border-box is the
     border-box height — CSS padding is counted as usable space, so the fit
     computed one row too many and overflow:hidden clipped the last row (visible
     at heights where the extra row tips over a cell boundary). Insetting keeps
     the identical visual gap — the .pane behind is the same colour — while
     giving the fit an honest measurement, so no row is ever clipped. */
  inset: 8px 4px 4px 10px;
  background: #10141a;
  overflow: hidden;
}
</style>
