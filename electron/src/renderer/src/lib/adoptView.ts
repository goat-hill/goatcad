/**
 * Take a view store to `next`, writing only the keys whose value changed.
 *
 * Every config change is broadcast whole (`config:changed`), so a view store
 * adopts its slice on every unrelated change too: a selection filter toggle,
 * a recent file. Assigning defaults and then the saved values flips any
 * non-default key out and back, and a deep watcher reads that as a change of
 * view: the board rebuilt its whole scene on each such toggle. A value is the
 * same when it is identical, or for plain data (a layer-visibility map) when it
 * serializes the same.
 */
export function adoptView<T extends object>(store: T, next: T): void {
  for (const key of Object.keys(next) as Array<keyof T>) {
    if (!sameValue(store[key], next[key])) store[key] = next[key]
  }
}

const sameValue = (a: unknown, b: unknown): boolean =>
  Object.is(a, b) ||
  (typeof a === 'object' &&
    typeof b === 'object' &&
    a !== null &&
    b !== null &&
    JSON.stringify(a) === JSON.stringify(b))
