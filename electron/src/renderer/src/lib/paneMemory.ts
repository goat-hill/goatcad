/**
 * Where a settings-style pane was left (Board Setup's section, Settings'
 * category), kept for the window's life: its tab unmounts when another is in
 * front, and coming back lands where the person left it, not on the first
 * section. Not persisted across restarts; a handful of short strings by key.
 */
import { ref, watch, type Ref } from 'vue'

const remembered = new Map<string, unknown>()

/**
 * A ref that starts from what `key` last held, and keeps it as it changes.
 * No key (an embedded pane) is a plain ref. Call during a component's setup.
 */
export function rememberedRef<T>(key: string | null | undefined, initial: T): Ref<T> {
  const value = ref(key && remembered.has(key) ? (remembered.get(key) as T) : initial) as Ref<T>
  if (key) watch(value, (next) => remembered.set(key, next))
  return value
}

/**
 * Whether a request numbered `seq` is new to the pane at `key`: a request
 * already shown is not shown again when the pane remounts, or it would undo
 * where the person went since.
 */
export function takeRequest(key: string | null | undefined, seq: number): boolean {
  if (!key) return true
  const seen = `${key}\u0000request`
  if ((remembered.get(seen) as number | undefined) === seq) return false
  remembered.set(seen, seq)
  return true
}
