/**
 * What `bom.get` and `bom.update` share: the conditions a part is picked by.
 * One grammar for both, so the rows an agent read are exactly the parts its
 * write lands on.
 */
import { s } from '../schema'
import { refused } from '../errors'

const BOM_MATCHES = ['equals', 'notEquals', 'contains', 'matches', 'empty', 'notEmpty'] as const

export const bomFilters = s
  .array(
    s.object({
      field: s
        .string()
        .trim()
        .describe(
          'Column: Reference, Value, Footprint, Datasheet, MPN, Manufacturer, any other part field, Sheet, or DNP / EXCLUDE_FROM_BOM / EXCLUDE_FROM_BOARD ("yes"/"no").'
        ),
      match: s
        .enum(BOM_MATCHES)
        .describe(
          'equals / notEquals: exact text. contains: case-insensitive substring. matches: case-insensitive whole-value wildcard with * and ? ("C*"). empty / notEmpty: no value; "~" counts as empty.'
        ),
      value: s.string().describe('Text to compare; not for empty or notEmpty.').optional()
    })
  )
  .describe('Conditions that must all hold for a part.')

/** A condition that needs a value and has none, refused before anything is read. */
export const filterRefusal = (
  where: readonly { field: string; match: string; value?: string }[] | undefined
): ReturnType<typeof refused> | null => {
  const bad = (where ?? []).find(
    (filter) =>
      filter.match !== 'empty' && filter.match !== 'notEmpty' && filter.value === undefined
  )
  return bad
    ? refused(
        `The condition on ${bad.field} (${bad.match}) has no value.`,
        'Pass value; only empty and notEmpty take none.',
        { kind: 'filter-without-value' }
      )
    : null
}
