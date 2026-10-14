/**
 * The Update / Change sheet's ticks as last left, per part kind and verb —
 * shared by every window through the main-process config store (RULES.md §8),
 * as `libraryRecents.ts` keeps the chooser's picks. The persisted shape is
 * `src/preload/partUpdateTypes.d.ts`.
 */
import type {
  PartUpdateChoices,
  PartUpdateKind,
  PartUpdatePreferences,
  PartUpdateVerb
} from '../../../preload/partUpdateTypes'

let store: PartUpdatePreferences = {}
let loading: Promise<void> | null = null

const api = (): typeof window.api | null =>
  typeof window !== 'undefined' && window.api ? window.api : null

/** Load once per window and keep in step with other windows. Idempotent. */
export function loadPartUpdatePreferences(): Promise<void> {
  if (loading) return loading
  const bridge = api()
  if (!bridge) return (loading = Promise.resolve())
  loading = bridge
    .getConfig()
    .then((config) => {
      store = config.partUpdatePreferences ?? {}
    })
    .catch(() => {
      // No memory is a sheet that opens on KiCad's defaults.
    })
  bridge.onConfigChanged((config) => {
    store = config.partUpdatePreferences ?? {}
  })
  return loading
}

/** What the sheet was last left with for this kind and verb, if anything. */
export function partUpdateChoices(
  kind: PartUpdateKind,
  verb: PartUpdateVerb
): PartUpdateChoices | undefined {
  return store[kind]?.[verb]
}

/** Keep what the sheet was left with, for the next time it opens. */
export function rememberPartUpdateChoices(
  kind: PartUpdateKind,
  verb: PartUpdateVerb,
  choices: PartUpdateChoices
): void {
  store = {
    ...store,
    [kind]: {
      ...store[kind],
      [verb]: { options: { ...choices.options }, fieldsOn: [...choices.fieldsOn] }
    }
  }
  void api()?.updateConfig({ partUpdatePreferences: JSON.parse(JSON.stringify(store)) })
}
