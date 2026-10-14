// Adding a row to a sheet puts the cursor in it (DESIGN.md §Sheets): once the
// row renders, its first editable cell takes focus, a text cell with its text
// selected so typing replaces it.
//
// The add belongs to the host and may land a tick or an await later, so the
// button arms this (`expect`) and the next row to appear is the one focused.
// Rows are found by a `data-row` attribute holding the key `keys` lists. A
// list keyed by index can only be told apart by position, so an insertion
// names its row outright: `expect(key)`.

import { onBeforeUnmount, watch, type Ref } from 'vue'

type RowKey = string | number

/** How long an add may take to show before the arming lapses, so a later reload is not mistaken for it. */
const ARMED_MS = 2000

const EDITABLE = [
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[role="combobox"]:not([disabled])'
].join(', ')

/** The first key in `now` that `before` did not have. */
export function addedRowKey(before: ReadonlySet<string>, now: readonly string[]): string | null {
  return now.find((key) => !before.has(key)) ?? null
}

export function useFocusAddedRow(
  container: Ref<HTMLElement | null>,
  keys: () => readonly RowKey[]
): { expect: (key?: RowKey) => void } {
  let armed: { before: Set<string>; key: string | null } | null = null
  let timer: ReturnType<typeof setTimeout> | undefined

  const expect = (key?: RowKey): void => {
    armed = { before: new Set(keys().map(String)), key: key === undefined ? null : String(key) }
    clearTimeout(timer)
    timer = setTimeout(() => (armed = null), ARMED_MS)
  }

  watch(
    () => keys().map(String),
    (now) => {
      if (!armed) return
      const { before } = armed
      // The same rows re-listed (a rebuild) is not the add landing.
      if (now.length === before.size && now.every((k) => before.has(k))) return
      const key = armed.key ?? addedRowKey(before, now)
      if (key === null || !now.includes(key)) return
      armed = null
      clearTimeout(timer)
      const row = container.value?.querySelector(`[data-row="${CSS.escape(key)}"]`)
      const cell = row?.querySelector<HTMLElement>(EDITABLE)
      if (!cell) return
      cell.focus()
      if (cell instanceof HTMLInputElement && cell.type === 'text') cell.select()
    },
    { flush: 'post' }
  )

  onBeforeUnmount(() => clearTimeout(timer))
  return { expect }
}
