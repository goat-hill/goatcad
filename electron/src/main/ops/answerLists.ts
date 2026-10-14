/**
 * One rule for large answers (docs/MCP-STYLE.md, "A capped list"): a list in
 * an MCP answer that grows with the design holds at most `ANSWER_LIST_MAX`
 * entries. The object holding a capped list says `truncated: true` and gives
 * its full length in its `counts`, under the list's name; the guidance says
 * how to get the rest.
 *
 * The lists are a write's `changed` ids (on the answer, and on each batch
 * entry in `results`) and the per-item rows an op declares (`OpSpec.lists`).
 * The doors answer whole; this caps only on the way to the model
 * (`partsMcp.ts`), so a viewport still frames everything a write changed and
 * the `/v1` surface — the Python client, whose answers stay in the
 * interpreter — gets every entry.
 */

/** Entries per capped list: `items_query`'s default page (`QUERY_DEFAULT_LIMIT`, renderer `lib/queryPage.ts`). */
export const ANSWER_LIST_MAX = 100

const CHANGED_LISTS = ['created', 'updated', 'deleted'] as const

const CAPPED_GUIDANCE = `A list marked truncated holds its first ${ANSWER_LIST_MAX} entries; counts beside it has every length. The same call through the Python client (app_scripting) answers every entry, and items_query reads what exists.`

type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The object a dotted path's list sits in, and the list's key. */
const holderOf = (root: Json, path: string): { holder: Json; key: string } | null => {
  const keys = path.split('.')
  let holder: unknown = root
  for (const key of keys.slice(0, -1)) holder = isObject(holder) ? holder[key] : undefined
  return isObject(holder) ? { holder, key: keys[keys.length - 1] } : null
}

/** Cap one list in place; whether it was. */
const capList = (holder: Json, key: string): boolean => {
  const list = holder[key]
  if (!Array.isArray(list) || list.length <= ANSWER_LIST_MAX) return false
  holder[key] = list.slice(0, ANSWER_LIST_MAX)
  holder.counts = { ...(isObject(holder.counts) ? holder.counts : {}), [key]: list.length }
  holder.truncated = true
  return true
}

/** A `changed` block capped in place: when one list is, `counts` has all three lengths. */
const capChanged = (changed: unknown): boolean => {
  if (!isObject(changed)) return false
  const long = CHANGED_LISTS.some(
    (key) => Array.isArray(changed[key]) && (changed[key] as unknown[]).length > ANSWER_LIST_MAX
  )
  if (!long) return false
  changed.counts = Object.fromEntries(
    CHANGED_LISTS.map((key) => [key, Array.isArray(changed[key]) ? changed[key].length : 0])
  )
  for (const key of CHANGED_LISTS) {
    if (Array.isArray(changed[key]))
      changed[key] = (changed[key] as unknown[]).slice(0, ANSWER_LIST_MAX)
  }
  changed.truncated = true
  return true
}

const tooLong = (value: unknown): boolean =>
  Array.isArray(value)
    ? value.length > ANSWER_LIST_MAX || value.some(tooLong)
    : isObject(value) && Object.values(value).some(tooLong)

/**
 * An answer as the model reads it: `changed` and the op's declared `lists`
 * capped, the rest untouched. A value with no long list is returned as is.
 */
export const capAnswerLists = (value: unknown, lists: readonly string[] = []): unknown => {
  if (!isObject(value) || !tooLong(value)) return value
  const answer = JSON.parse(JSON.stringify(value)) as Json
  let capped = capChanged(answer.changed)
  if (Array.isArray(answer.results))
    for (const entry of answer.results)
      if (isObject(entry) && capChanged(entry.changed)) capped = true
  for (const path of lists) {
    const found = holderOf(answer, path)
    if (found && capList(found.holder, found.key)) capped = true
  }
  if (!capped) return value
  answer.guidance =
    typeof answer.guidance === 'string' && answer.guidance
      ? `${answer.guidance} ${CAPPED_GUIDANCE}`
      : CAPPED_GUIDANCE
  return answer
}
