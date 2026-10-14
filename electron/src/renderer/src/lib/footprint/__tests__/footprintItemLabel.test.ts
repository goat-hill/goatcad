import { describe, expect, test } from 'vitest'
import { parseKicadFootprint } from '../../kicad/footprint'
import { footprintItemLabel } from '../footprintItemLabel'

const FP = parseKicadFootprint(`(footprint "R_0603"
  (layer "F.Cu")
  (property "Reference" "REF**" (at 0 -1.4 0) (layer "F.SilkS"))
  (fp_line (start -1 0) (end 1 0) (stroke (width 0.12) (type solid)) (layer "F.SilkS"))
  (fp_text user "a very long assembly note that runs on" (at 0 1 0) (layer "F.Fab"))
  (pad "2" smd roundrect (at 0.8 0) (size 0.8 0.95) (layers "F.Cu" "F.Paste" "F.Mask"))
)`)

/** Keys come back as their last segment, so a row reads as its parts. */
const t = (key: string): string => key.split('.').pop() ?? key

describe('footprintItemLabel', () => {
  test('names the primitive, then what tells it apart', () => {
    expect(footprintItemLabel(FP, { type: 'pad', index: 0 }, t)).toBe('pad · 2')
    expect(footprintItemLabel(FP, { type: 'line', index: 0 }, t)).toBe('line · F.SilkS')
    expect(footprintItemLabel(FP, { type: 'property', index: 0 }, t)).toBe(
      'field · Reference · REF**'
    )
  })

  test('cuts a long text short', () => {
    expect(footprintItemLabel(FP, { type: 'text', index: 0 }, t)).toBe(
      'text · a very long assembly no… · F.Fab'
    )
  })

  test('an item that is gone keeps its kind', () => {
    expect(footprintItemLabel(FP, { type: 'arc', index: 5 }, t)).toBe('arc')
  })
})
