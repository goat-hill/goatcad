/**
 * How a Select Other row names a primitive (shared/SelectOtherMenu.vue), the
 * same in every editor: the primitive's shared name (`shared.primitives`),
 * then what tells it from its neighbours under the pointer, joined by a middle
 * dot — "Track · F.Cu · GND". Each editor's `*ItemLabel` picks the parts.
 */

/** The parts that are present, as one row. */
export const primitiveLabel = (...parts: Array<string | undefined>): string =>
  parts.filter((part): part is string => !!part).join(' · ')

/** A text's first line, cut short for a row; undefined when it is blank. */
export const labelExcerpt = (text: string | undefined): string | undefined => {
  const line = text?.split('\n')[0]?.trim()
  if (!line) return undefined
  return line.length > 24 ? `${line.slice(0, 23).trimEnd()}…` : line
}
