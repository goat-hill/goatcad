/**
 * The schematic find widget's query, held once for every schematic tab: a
 * search across the hierarchy steps from one sheet's tab to the next, and the
 * editor that opens there picks the search up where the last one left it.
 */
import { reactive, ref } from 'vue'
import { FIND_DEFAULTS, type FindOptions } from './schematicFind'

export type FindScope = 'sheet' | 'design'

export const findState = reactive({
  query: '',
  replacement: '',
  options: { ...FIND_DEFAULTS } as FindOptions,
  scope: 'sheet' as FindScope,
  /** The hit on screen (`FindMatch.key`), so next and previous step from it. */
  currentKey: null as string | null,
  /** Whether the replace row is showing. */
  replaceOpen: false
})

/** The sheet file whose editor should open the widget: a step onto another sheet. */
export const findHandoff = ref<string | null>(null)
