/**
 * A schematic item named for a list row — Select Other's
 * (shared/SelectOtherMenu.vue), as `boardItemLabel` names a board's: the
 * primitive's shared name, then what tells it from its neighbours under the
 * pointer — a symbol's reference and value, a label's or text's words, a
 * field's name and value, a sheet's name, a sheet pin's. Parts joined by a
 * middle dot: "Symbol · R1 · 10k".
 */
import {
  referenceForSheetPath,
  type KicadSchematic,
  type SchematicProperty
} from '../kicad/schematic'
import type { SchematicItemRef } from '../engine/SchematicScene'
import { labelExcerpt, primitiveLabel } from '../primitiveLabel'

export type Translate = (key: string) => string

const property = (
  properties: readonly SchematicProperty[] | undefined,
  key: string
): string | undefined => labelExcerpt(properties?.find((p) => p.key === key)?.value)

export function schematicItemLabel(
  schematic: KicadSchematic,
  ref: SchematicItemRef,
  t: Translate,
  /** The sheet instance on screen: a repeated sheet's symbols go by its references. */
  sheetPath = '/'
): string {
  const reference = (index: number): string | undefined => {
    const symbol = schematic.symbols[index]
    return symbol ? labelExcerpt(referenceForSheetPath(symbol, sheetPath)) : undefined
  }

  switch (ref.type) {
    case 'symbol': {
      const props = schematic.symbols[ref.index]?.properties
      return primitiveLabel(
        t('shared.primitives.symbol'),
        reference(ref.index),
        property(props, 'Value')
      )
    }
    case 'field': {
      const props = schematic.symbols[ref.index]?.properties
      // A Reference field is the symbol's name already; any other names its symbol.
      if (ref.field === 'Reference')
        return primitiveLabel(t('shared.primitives.field'), ref.field, reference(ref.index))
      return primitiveLabel(
        t('shared.primitives.field'),
        ref.field,
        ref.field === undefined ? undefined : property(props, ref.field),
        reference(ref.index)
      )
    }
    case 'sheet':
      return primitiveLabel(
        t('shared.primitives.sheet'),
        property(schematic.sheets[ref.index]?.properties, 'Sheetname')
      )
    case 'sheet_field': {
      const props = schematic.sheets[ref.index]?.properties
      return primitiveLabel(
        t('shared.primitives.field'),
        ref.field,
        ref.field === undefined ? undefined : property(props, ref.field)
      )
    }
    case 'sheet_pin': {
      const pin = ref.pin === undefined ? undefined : schematic.sheets[ref.index]?.pins[ref.pin]
      return primitiveLabel(t('shared.primitives.sheetPin'), labelExcerpt(pin?.name))
    }
    case 'label': {
      const label = schematic.labels[ref.index]
      const title =
        label?.type === 'global_label'
          ? t('schematicEditor.labelKinds.globalLabel')
          : label?.type === 'hierarchical_label'
            ? t('schematicEditor.labelKinds.hierarchicalLabel')
            : t('shared.primitives.label')
      return primitiveLabel(title, labelExcerpt(label?.text))
    }
    case 'netclass_flag':
      return primitiveLabel(
        t('shared.primitives.directiveLabel'),
        labelExcerpt(schematic.directiveLabels[ref.index]?.text)
      )
    case 'wire':
      return t('shared.primitives.wire')
    case 'bus':
      return t('shared.primitives.bus')
    case 'bus_entry':
      return t('shared.primitives.busEntry')
    case 'junction':
      return t('shared.primitives.junction')
    case 'no_connect':
      return t('shared.primitives.noConnect')
    case 'text':
      return primitiveLabel(
        t('shared.primitives.text'),
        labelExcerpt(schematic.texts[ref.index]?.text)
      )
    case 'text_box':
      return primitiveLabel(
        t('shared.primitives.textBox'),
        labelExcerpt(schematic.textBoxes[ref.index]?.graphic.text)
      )
    case 'shape':
      return t('shared.primitives.rectangle')
    case 'polyline':
      return t('shared.primitives.line')
    case 'circle':
      return t('shared.primitives.circle')
    case 'arc':
      return t('shared.primitives.arc')
    case 'bezier':
      return t('shared.primitives.curve')
    case 'image':
      return t('shared.primitives.image')
    case 'table':
      return t('shared.primitives.table')
    case 'rule_area':
      return t('shared.primitives.ruleArea')
  }
}
