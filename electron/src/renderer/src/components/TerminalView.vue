<script setup lang="ts">
/**
 * One terminal tab's view: an xterm bound to a main-process pty session.
 *
 * The session outlives this component on purpose — it is created before the view
 * mounts and killed only when the user closes the tab — so mounting is always a
 * re-attach: claim the session for this window, replay its scrollback, then
 * stream. Live chunks carry the sender's running byte offset, which is what lets
 * the replay and the stream overlap safely: anything at or below the snapshot's
 * offset is already on screen.
 *
 * EditorArea keeps every open terminal mounted and toggles `visible`, rather
 * than letting the editor switch unmount it, because a remount would repaint up
 * to 512 KB of scrollback and throw away the scroll position.
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import ContextMenu from './shared/ContextMenu.vue'
import type { MenuNode } from '../lib/menu'
import { hotkeyLabel, matchesHotkey } from '../lib/hotkeys'
import { terminalTheme } from '../lib/terminalTheme'
import { useAppTheme } from '../lib/theme'

const props = defineProps<{
  sessionId: string
  /** False while another tab is in front; the pane stays mounted and running. */
  visible: boolean
  /** Changes when this pane's group is handed the keyboard by hotkey. */
  focusNonce?: number
}>()

const { t } = useI18n()
const theme = useAppTheme()
const host = ref<HTMLDivElement>()
const menuPosition = ref<{ x: number; y: number } | null>(null)

/**
 * Full-pane surface, so 13px rather than the 11px floor — DESIGN.md's "size to
 * the space" rule, and this is the one surface whose whole content is text.
 */
const FONT_SIZE = 13

/**
 * Wheel speed in xterm's "times the default" units. The option covers
 * normal-buffer scrollback; the handler below covers alt-screen programs
 * (an agent CLI, `less`, `vim`), which consume the wheel one event at a time.
 */
const SCROLL_SPEED = 3

let terminal: Terminal | undefined
let fit: FitAddon | undefined
const cleanups: (() => void)[] = []

const copySelection = (): void => {
  const text = terminal?.getSelection()
  if (text) window.api.writeClipboardText(text)
}

const paste = async (): Promise<void> => {
  const text = await window.api.readClipboardText()
  // `terminal.paste`, never a raw write: it honors bracketed-paste mode, so
  // multi-line text lands in the running program's input rather than being run
  // line by line by the shell as it arrives.
  if (text) terminal?.paste(text)
}

const menuItems = (): MenuNode[] => [
  {
    id: 'copy',
    label: t('terminal.menu.copy'),
    shortcut: hotkeyLabel('terminal.copy'),
    disabled: !terminal?.hasSelection()
  },
  { id: 'paste', label: t('terminal.menu.paste'), shortcut: hotkeyLabel('terminal.paste') },
  { id: 'selectAll', label: t('terminal.menu.selectAll') },
  { divider: true },
  { id: 'clear', label: t('terminal.menu.clear') }
]

const items = ref<MenuNode[]>([])

const onMenuSelect = (id: string): void => {
  menuPosition.value = null
  if (id === 'copy') copySelection()
  else if (id === 'paste') void paste()
  else if (id === 'selectAll') terminal?.selectAll()
  else if (id === 'clear') terminal?.clear()
  terminal?.focus()
}

/** Refit only when this pane is the one on screen; a hidden host measures as 0. */
const doFit = (): void => {
  if (props.visible) fit?.fit()
}

onMounted(async () => {
  if (!host.value) return

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  terminal = new Terminal({
    fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim(),
    fontSize: FONT_SIZE,
    scrollback: 10000,
    scrollSensitivity: SCROLL_SPEED,
    // A blinking cursor is an animation like any other (RULES.md §6).
    cursorBlink: !reduceMotion,
    theme: terminalTheme()
  })
  fit = new FitAddon()
  terminal.loadAddon(fit)
  terminal.open(host.value)

  // Copy and paste before xterm sees the key: the terminal would otherwise send
  // Ctrl+Shift+C to the program. Everything else — Ctrl+C included — falls
  // through, which is what keeps SIGINT working. Returning false only keeps the
  // key from xterm; the browser's own default still runs unless cancelled, and
  // Chromium's for Ctrl+Shift+V is a paste into xterm's textarea — a second copy.
  terminal.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown') return true
    if (matchesHotkey(event, 'terminal.copy') && terminal?.hasSelection()) {
      event.preventDefault()
      copySelection()
      return false
    }
    if (matchesHotkey(event, 'terminal.paste')) {
      event.preventDefault()
      void paste()
      return false
    }
    return true
  })

  // `scrollSensitivity` only speeds up normal-buffer scrolling. On the alternate
  // screen xterm forwards exactly one mouse report per physical wheel event, so
  // replay each real event SCROLL_SPEED-1 more times; the synthetic copies
  // (`isTrusted` false) pass straight through this handler.
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
          bubbles: true,
          cancelable: true
        })
      )
    }
    return true
  })

  const onContextMenu = (event: MouseEvent): void => {
    event.preventDefault()
    items.value = menuItems()
    menuPosition.value = { x: event.clientX, y: event.clientY }
  }
  // A drag-selection in a Linux terminal is middle-click-pastable everywhere
  // else, so ours fills PRIMARY too. On mouseup rather than the selection event,
  // which fires once per cell the drag crosses.
  // A program tracking the mouse (Claude Code does) gets the middle click as a
  // report and pastes for itself, so Chromium's own PRIMARY paste would be a
  // second copy: it is cancelled then, as other terminals skip theirs. Shift
  // keeps it, the usual override of a program's mouse mode.
  const onMouseUp = (event: MouseEvent): void => {
    if (event.button === 1 && !event.shiftKey && terminal?.modes.mouseTrackingMode !== 'none')
      event.preventDefault()
    const text = terminal?.getSelection()
    if (text) window.api.writeClipboardText(text, true)
  }
  host.value.addEventListener('contextmenu', onContextMenu)
  host.value.addEventListener('mouseup', onMouseUp)
  cleanups.push(() => {
    host.value?.removeEventListener('contextmenu', onContextMenu)
    host.value?.removeEventListener('mouseup', onMouseUp)
  })

  // Live data is queued until the snapshot has been replayed; the offset that
  // accompanies each chunk drops whatever the snapshot already covered.
  let replayed = false
  const queued: { data: string; offset: number }[] = []
  cleanups.push(
    window.api.onTerminalData((id, data, offset) => {
      if (id !== props.sessionId) return
      if (replayed) terminal?.write(data)
      else queued.push({ data, offset })
    })
  )
  const writeExitNotice = (exitCode: number): void => {
    terminal?.write(`\r\n\x1b[90m${t('terminal.exitNotice', { code: exitCode })}\x1b[0m\r\n`)
  }
  cleanups.push(
    window.api.onTerminalExit((id, exitCode) => {
      if (id === props.sessionId) writeExitNotice(exitCode)
    })
  )

  // Claim the session for this window before reading it: a tab dragged in from
  // another window is still pointed at the window it left.
  const session = await window.api.attachTerminal(props.sessionId)
  // An agent tab whose CLI the shell could not find holds a plain shell
  // instead; say so at the top, every mount, since the notice is the view's
  // and never part of the scrollback it replays below.
  if (session?.missingCli) {
    const { cli, docs } = session.missingCli
    terminal.write(`\x1b[90m${t('terminal.missingCli', { cli, docs })}\x1b[0m\r\n\r\n`)
  }
  const snapshot = await window.api.terminalSnapshot(props.sessionId)
  if (snapshot.data) terminal.write(snapshot.data)
  for (const chunk of queued) if (chunk.offset > snapshot.offset) terminal.write(chunk.data)
  replayed = true
  // A session that ended while nothing was attached still owes its notice.
  if (snapshot.exitCode !== null) writeExitNotice(snapshot.exitCode)

  terminal.onData((data) => window.api.terminalInput(props.sessionId, data))
  terminal.onResize(({ cols, rows }) => window.api.terminalResize(props.sessionId, cols, rows))
  fit.fit()
  if (props.visible) terminal.focus()

  // Fitting inside the ResizeObserver callback measures mid-layout. A rAF fit
  // tracks the size responsively during a drag; the trailing timer guarantees
  // one more once the resize settles, in case a live window-edge drag starves
  // rAF and the last frame-based fit ran against a stale size.
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

watch(theme, () => {
  if (terminal) terminal.options.theme = terminalTheme()
})

watch(
  () => props.visible,
  (visible) => {
    if (!visible) return
    // Double frame: a pane un-hidden in the same flush as a resize would
    // otherwise fit against a height that has not settled.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        fit?.fit()
        terminal?.focus()
      })
    )
  }
)

watch(
  () => props.focusNonce,
  () => {
    if (props.visible) terminal?.focus()
  }
)

onBeforeUnmount(() => {
  cleanups.forEach((cleanup) => cleanup())
  terminal?.dispose()
})
</script>

<template>
  <div class="terminal-view" :class="{ hidden: !visible }">
    <div ref="host" class="terminal-host"></div>
    <ContextMenu
      v-if="menuPosition"
      :items="items"
      :x="menuPosition.x"
      :y="menuPosition.y"
      @select="onMenuSelect"
      @close="menuPosition = null"
    />
  </div>
</template>

<style scoped>
.terminal-view {
  position: absolute;
  inset: 0;
  background: var(--vscode-source-bg);
}

/* Hidden rather than unmounted: the shell keeps running, and coming back is a
   repaint instead of a 512 KB scrollback replay. `visibility` rather than
   `display: none` so the host keeps a measurable box for the fit on the way in. */
.terminal-view.hidden {
  visibility: hidden;
  pointer-events: none;
}

.terminal-host {
  position: absolute;
  /* Inset rather than padded. FitAddon derives the row count from the host's
     computed height, which under border-box counts padding as usable space —
     so a padded host fits one row too many and overflow hides it. */
  inset: 8px 4px 4px 10px;
  overflow: hidden;
}
</style>
