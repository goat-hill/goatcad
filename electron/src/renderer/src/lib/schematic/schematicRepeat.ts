/**
 * Repeat Last Item in the schematic — KiCad's Insert (`SCH_EDIT_TOOL::RepeatDrawItem`):
 * the item the last placement put down, again, one repeat step on, a label's
 * number counting up. Each repeat becomes the next one's source, so pressing
 * the key walks a row of labels down a bus.
 *
 * The step and the increment are KiCad's defaults (eeschema's
 * `drawing.default_repeat_offset_x/y` and `drawing.repeat_label_increment`):
 * application settings there, not project ones, and this app keeps none of
 * its own yet.
 */

import {
  cloneNodeDeep,
  findChild,
  findChildren,
  getAtomValues,
  getToken,
  type SExprList
} from '../kicad/sexpr'
import { setPositionalAtom } from '../kicad/footprint'
import { nm, type Nm } from '../kicad/coordinates'
import { tk, type MessageKey } from '../messageKey'
import { REPEAT_NUMBER_STEP, REPEAT_PITCH } from '../symbolRepeat'
import { unannotated, type SchematicClipboardContent } from './schematicClipboard'

/** KiCad's default repeat step: straight down one 100 mil pitch. */
export const SCHEMATIC_REPEAT_STEP: { x: Nm; y: Nm } = { x: nm(0), y: REPEAT_PITCH }

/** KiCad's default label increment. */
export const SCHEMATIC_REPEAT_LABEL_DELTA = REPEAT_NUMBER_STEP

/**
 * KiCad's `IncrementString`: the last run of digits steps by `delta`, keeping
 * its width (`D07` → `D08`, `D09` → `D10`) and whatever letters follow it
 * (`A1B` → `A2B`, `D0_N` → `D1_N`). Text with no digits comes back as it is.
 * Null when the number would go below zero, which KiCad refuses too.
 */
export function incrementString(text: string, delta: number): string | null {
  const match = /^(.*?)(\d+)(\D*)$/.exec(text)
  if (!match) return text
  const [, head, digits, tail] = match
  const next = Number(digits) + delta
  if (next < 0) return null
  return `${head}${String(next).padStart(digits.length, '0')}${tail}`
}

const LABEL_TOKENS = new Set(['label', 'global_label', 'hierarchical_label'])

/** A directive label counts up its net class and component class, as KiCad's does. */
const DIRECTIVE_FIELDS = new Set(['Netclass', 'Component Class'])

/**
 * The next repeat of `source`: labels counted on by `delta`, symbols
 * unannotated so the paste gives them the next free number (KiCad clears the
 * annotation and re-annotates the repeat). Nothing moves here; the step is the
 * placement's.
 */
export function repeatContent(
  source: SchematicClipboardContent,
  delta: number = SCHEMATIC_REPEAT_LABEL_DELTA
): SchematicClipboardContent {
  const items = source.items.map((item) => {
    const node = cloneNodeDeep(item) as SExprList
    const token = getToken(node)
    if (token && LABEL_TOKENS.has(token)) {
      const next = incrementString(getAtomValues(node)[0] ?? '', delta)
      if (next !== null) setPositionalAtom(node, 1, next, true)
    } else if (token === 'netclass_flag') {
      for (const property of findChildren(node, 'property')) {
        const [key, value] = getAtomValues(property)
        const next = key && DIRECTIVE_FIELDS.has(key) ? incrementString(value ?? '', delta) : null
        if (next !== null) setPositionalAtom(property, 2, next, true)
      }
    } else if (token === 'symbol') {
      for (const property of findChildren(node, 'property')) {
        const [key, value] = getAtomValues(property)
        if (key === 'Reference') setPositionalAtom(property, 2, unannotated(value ?? ''), true)
      }
      const instances = findChild(node, 'instances')
      if (instances) node.children = node.children.filter((child) => child !== instances)
    }
    return node
  })
  return { libSymbols: source.libSymbols, items }
}

/**
 * The placements a repeat can follow, by the undo label they record, and the
 * kinds of node each put down that the repeat copies — a wire's step also
 * drops junctions where it lands on others, and those are not what is repeated.
 */
export const REPEATABLE_PLACEMENTS: ReadonlyArray<[MessageKey, readonly string[]]> = [
  [tk('commandLabels.addWire'), ['wire']],
  [tk('commandLabels.addSymbol'), ['symbol']],
  [tk('commandLabels.addLabel'), ['label', 'global_label', 'hierarchical_label']],
  [tk('commandLabels.addJunction'), ['junction']],
  [tk('commandLabels.addNoConnect'), ['no_connect']],
  [tk('commandLabels.addText'), ['text']],
  [tk('commandLabels.addSheet'), ['sheet']]
]

/** Whether a repeat must float under the cursor: a symbol does, as in KiCad. */
export const repeatFloats = (content: SchematicClipboardContent): boolean =>
  content.items.some((item) => getToken(item) === 'symbol')
