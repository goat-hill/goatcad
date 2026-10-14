/**
 * The library chooser's lists — every symbol, power symbol and footprint the
 * index holds, as chooser items sorted by name — built once per index load and
 * shared by every chooser, so opening one only groups a ready list
 * (docs/libraries-workstream.md §3). Warmed on idle after each load.
 */
import { addIndexWarmer, indexSnapshot, type IndexRecord } from './libraryIndex'
import { byName, type ChooserItem, type ChooserKind, type ChooserScope } from './libraryChooser'

const scopeOf = (scope: IndexRecord['scope']): ChooserScope =>
  scope === 'project' ? 'project' : scope === 'global' ? 'global' : 'system'

const build = (records: readonly IndexRecord[]): Record<ChooserKind, ChooserItem[]> => {
  const lists: Record<ChooserKind, ChooserItem[]> = { symbol: [], power: [], footprint: [] }
  for (const record of records) {
    if (record.type === 'footprint') {
      lists.footprint.push({
        id: record.id,
        name: record.name,
        library: record.library,
        description: record.description,
        keywords: record.tags,
        scope: scopeOf(record.scope),
        count: record.padNumbers,
        file: record.file
      })
    } else if (record.type === 'symbol') {
      const power = record.isPower || record.id.startsWith('power:')
      lists[power ? 'power' : 'symbol'].push({
        id: record.id,
        name: record.name,
        library: record.library,
        description: record.description,
        keywords: record.keywords,
        scope: scopeOf(record.scope),
        count: record.pins,
        file: record.file
      })
    }
  }
  for (const list of Object.values(lists)) list.sort(byName)
  return lists
}

let cache: { from: readonly IndexRecord[]; lists: Record<ChooserKind, ChooserItem[]> } | null = null

/** The index's items of one kind, sorted by name; built on first ask after a load if not warmed. */
export function chooserIndexItems(kind: ChooserKind): ChooserItem[] {
  const from = indexSnapshot()
  if (cache?.from !== from) cache = { from, lists: build(from) }
  return cache.lists[kind]
}

addIndexWarmer(() => void chooserIndexItems('symbol'))
