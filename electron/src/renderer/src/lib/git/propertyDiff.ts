/**
 * The visual diff's properties panel: an item's property table as each
 * version builds it, merged into one. Every row of the new version shows; a
 * row whose value differs carries the old one (`was`), a row only the new
 * version has is `added`, and a row only the old one had comes back
 * `removed`, under the row it followed. A group only one version has is
 * marked on the group, its rows left plain: the whole item came or went.
 *
 * Rows compare by what they show — a select by its option's label, since a
 * net's number can name another net in the other version.
 */
import { isMixed, type PropertyField, type PropertyGroup } from '../propertyTable'

const shown = (field: PropertyField): string => {
  const { value, editor } = field
  if (isMixed(value)) return '\u0000mixed'
  if (editor.options && typeof value === 'string') {
    const labels = (editor.kind === 'multiselect' ? value.split(',') : [value]).map(
      (part) => editor.options?.find((option) => option.value === part)?.label ?? part
    )
    return labels.join(',')
  }
  if (editor.options && typeof value === 'number') {
    const option = editor.options.find((o) => o.value === String(value))
    if (option) return option.label
  }
  return JSON.stringify(value)
}

const mergeFields = (before: PropertyField[], after: PropertyField[]): PropertyField[] => {
  const was = new Map(before.map((field) => [field.key, field]))
  const now = new Set(after.map((field) => field.key))
  // A removed row goes back under the row it followed; null is the top.
  const removedUnder = new Map<string | null, PropertyField[]>()
  let anchor: string | null = null
  for (const field of before) {
    if (now.has(field.key)) {
      anchor = field.key
      continue
    }
    const list = removedUnder.get(anchor) ?? []
    list.push({ ...field, change: 'removed' })
    removedUnder.set(anchor, list)
  }
  const fields: PropertyField[] = [...(removedUnder.get(null) ?? [])]
  for (const field of after) {
    const old = was.get(field.key)
    if (!old) fields.push({ ...field, change: 'added' })
    else if (shown(old) !== shown(field)) fields.push({ ...field, change: 'changed', was: old })
    else fields.push(field)
    fields.push(...(removedUnder.get(field.key) ?? []))
  }
  return fields
}

/** One table from the groups each version builds for the same item. Pure. */
export function diffPropertyGroups(
  before: readonly PropertyGroup[],
  after: readonly PropertyGroup[]
): PropertyGroup[] {
  const keyOf = (group: PropertyGroup): string => group.id ?? group.type
  const was = new Map(before.map((group) => [keyOf(group), group]))
  const now = new Set(after.map(keyOf))
  const groups = after.map((group): PropertyGroup => {
    const old = was.get(keyOf(group))
    return old
      ? { ...group, fields: mergeFields(old.fields, group.fields) }
      : { ...group, change: 'added' }
  })
  for (const group of before) {
    if (!now.has(keyOf(group))) groups.push({ ...group, change: 'removed' })
  }
  return groups
}
