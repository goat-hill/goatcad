/**
 * The `record` argument `items.create` and `items.update` share, described and
 * checked from the one table of what each document's items take
 * (`shared/itemRecords.ts`, `shared/recordRules.ts`), so a key the description
 * lists is a key the check accepts. A record is checked here, before it
 * crosses the bridge, so a refusal reads the same on every document and in
 * every batch's entries.
 */
import { s } from '../schema'
import { fail, type OpFailure } from '../errors'
import { DESIGN_CODE, DESIGN_REMEDY } from '../design'
import { checkRecord, ruleFor, type RecordFailure } from '../../../shared/recordRules'
import {
  KEY_GROUPS,
  RECORDS,
  type RecordDocument,
  type RecordMode
} from '../../../shared/itemRecords'

/** A record failure in the envelope the window's own failure of that kind takes. */
export const recordRefusal = (failure: RecordFailure): OpFailure => {
  const key = 'key' in failure ? failure.key : failure.keys[0]
  return fail({
    code: DESIGN_CODE[failure.error] ?? 'invalid-args',
    kind: failure.error,
    message: failure.detail,
    fix: DESIGN_REMEDY[failure.error] ?? DESIGN_REMEDY['invalid-record'],
    path: `/record/${key.replace(/\./g, '/')}`,
    data: { detail: failure.detail }
  })
}

/**
 * A record held to what its kind takes on its document, or a refusal. An
 * update passes no kind: its id resolves only in the window, which holds the
 * record to its kind again there.
 */
export const recordCheck = (
  document: RecordDocument,
  kind: string | undefined,
  record: Record<string, unknown>,
  mode: RecordMode
): OpFailure | null => {
  const failure = checkRecord(document, kind, record, mode)
  return failure ? recordRefusal(failure) : null
}

// --- The description -------------------------------------------------------------------

const GROUPS = Object.entries(KEY_GROUPS) as Array<[string, readonly string[]]>

/** A kind's keys, a whole group by its name. */
const keysOf = (keys: readonly string[]): string => {
  let words = [...keys]
  for (const [name, group] of GROUPS) {
    if (!group.every((key) => words.includes(key))) continue
    const at = words.indexOf(group[0])
    words = words.filter((key) => !group.includes(key))
    words.splice(at, 0, name)
  }
  return words.join(', ')
}

const kindsText = (table: Readonly<Record<string, readonly string[]>>): string =>
  Object.entries(table)
    .filter(([, keys]) => keys.length)
    .map(([kind, keys]) => `${kind}: ${keysOf(keys)}`)
    .join('; ')

/** The kinds whose create takes other keys than their update writes (a lock aside). */
const createsOtherwise = (document: RecordDocument): Record<string, readonly string[]> => {
  const { create, update } = RECORDS[document]
  const sameAs = (a: readonly string[], b: readonly string[]): boolean =>
    a.length === b.length && a.every((key) => b.includes(key))
  return Object.fromEntries(
    Object.entries(create).filter(
      ([kind, keys]) =>
        !sameAs(
          keys,
          update[kind].filter((key) => key !== 'locked')
        )
    )
  )
}

/** What a sheet item's create takes, by kind: the remedy when a create lacks a key. */
export const SHEET_CREATE_KEYS_TEXT = kindsText(RECORDS.sheet.create)

const documentText = (document: RecordDocument, frame: string): string => {
  const created = createsOtherwise(document)
  const updateOnly = RECORDS[document].kinds.filter(
    (kind) => RECORDS[document].update[kind]?.length && !RECORDS[document].create[kind]
  )
  return [
    `${frame}. Update: ${kindsText(RECORDS[document].update)}.`,
    Object.keys(created).length ? ` Create: ${kindsText(created)}.` : '',
    updateOnly.length ? ` Update only: ${updateOnly.join(', ')}.` : ''
  ].join('')
}

/** The nested objects, each by the shape its rule names. */
const SHAPES = (
  [
    ['footprint', 'footprint', 'attributes'],
    ['footprint', 'footprint', 'overrides'],
    ['footprint', 'pad', 'drill'],
    ['footprint', 'pad', 'chamfer'],
    ['footprint', 'pad', 'thermal'],
    ['symbol', 'text_box', 'margins'],
    ['board', 'zone', 'rules'],
    ['symbol', 'pin', 'alternates']
  ] as const
)
  .map(([document, kind, key]) => `${key} ${ruleFor(document, kind, key, 'update')?.expects}`)
  .join('; ')

export const recordArg = s
  .json()
  .describe(
    [
      'The record as items_get answers it; on update, only the keys that change. Colors are "#rrggbb" or "#rrggbbaa", null for the default.',
      `Groups: ${GROUPS.map(([name, keys]) => `${name} (${keys.join(', ')})`).join('; ')}.`,
      `Shapes: ${SHAPES}.`,
      documentText('sheet', 'Sheet, in sheet millimeters, y down; fields is values by name'),
      documentText(
        'symbol',
        'Symbol, in millimeters of the symbol frame, y down; thickness null is auto; unit and style 0 are every unit and style'
      ),
      documentText(
        'footprint',
        "Footprint, in millimeters of the footprint's frame; null returns an override to inherit"
      ),
      documentText(
        'board',
        "Board, in board millimeters, y down; nets and layers by name; width, size and net default to the net class. A track created takes points that may be pad or via ids, as a via takes at. A via's layers are its two end layers, required unless through. keepout: true makes a zone a rule area, with rules. reference and value are written only on a footprint no schematic symbol owns. A pad is read and deleted, not written. A tuning pattern's update lays its meanders again with its new settings and ends, answering tuned (length or skew, target, status)"
      )
    ].join(' ')
  )
  .optional()
