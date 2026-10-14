import { describe, expect, test } from 'vitest'
import { parseKicadSchematic } from '../../kicad/schematic'
import { schematicItemLabel } from '../schematicItemLabel'

/** Names each key by its last segment, so a row reads as the kind it chose. */
const t = (key: string): string => key.slice(key.lastIndexOf('.') + 1)

const doc = parseKicadSchematic(`(kicad_sch (version 20231120) (uuid "s") (paper "A4") (lib_symbols)
  (wire (pts (xy 0 0) (xy 10 0)) (stroke (width 0) (type default)) (uuid "w1"))
  (label "SDA" (at 40 60 0) (effects (font (size 1.27 1.27))) (uuid "l1"))
  (global_label "VBUS" (shape input) (at 40 70 0) (effects (font (size 1.27 1.27))) (uuid "g1"))
  (text "a note that runs well past the length a row can hold" (at 30 20 0)
    (effects (font (size 1.27 1.27))) (uuid "t1"))
)`)

describe('schematicItemLabel', () => {
  test('names the primitive, then what tells it apart', () => {
    expect(schematicItemLabel(doc, { type: 'wire', index: 0 }, t)).toBe('wire')
    expect(schematicItemLabel(doc, { type: 'label', index: 0 }, t)).toBe('label · SDA')
  })

  test('a global label is named by its kind', () => {
    const global = doc.labels.findIndex((label) => label.type === 'global_label')
    expect(schematicItemLabel(doc, { type: 'label', index: global }, t)).toBe('globalLabel · VBUS')
  })

  test('long text is cut short', () => {
    expect(schematicItemLabel(doc, { type: 'text', index: 0 }, t)).toBe(
      'text · a note that runs well p…'
    )
  })
})
