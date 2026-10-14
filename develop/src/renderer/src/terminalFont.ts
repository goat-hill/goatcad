// Terminal font size is app-wide state: every embedded terminal (Claude, shells,
// dev servers) renders at the same size, and the size survives restarts. Kept in
// one reactive ref here so the zoom hotkeys, the View menu, and every TerminalPane
// read and write the same value.

import { ref } from 'vue'

export const DEFAULT_FONT_SIZE = 13
const MIN_FONT_SIZE = 8
const MAX_FONT_SIZE = 32
const STEP = 1
const STORAGE_KEY = 'goatherd.terminalFontSize'

function load(): number {
  const stored = Number(localStorage.getItem(STORAGE_KEY))
  if (!Number.isFinite(stored) || stored < MIN_FONT_SIZE || stored > MAX_FONT_SIZE) {
    return DEFAULT_FONT_SIZE
  }
  return stored
}

export const fontSize = ref(load())

function set(size: number): void {
  const clamped = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(size)))
  fontSize.value = clamped
  localStorage.setItem(STORAGE_KEY, String(clamped))
}

export function zoomIn(): void {
  set(fontSize.value + STEP)
}

export function zoomOut(): void {
  set(fontSize.value - STEP)
}

export function zoomReset(): void {
  set(DEFAULT_FONT_SIZE)
}
