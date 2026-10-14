import { describe, expect, it } from 'vitest'
import { parseKicadFootprint } from '../kicad/footprint'
import { withPreviewFields } from '../libraryLoad'

const LED = parseKicadFootprint(`(footprint "LED_0603_1608Metric"
  (layer "F.Cu")
  (property "Reference" "REF**" (at 0 -1.43 0) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15))))
  (property "Value" "LED_0603_1608Metric" (at 0 1.43 0) (layer "F.Fab") (effects (font (size 1 1) (thickness 0.15))))
  (fp_text user "\${REFERENCE}" (at 0 0 0) (layer "F.Fab") (effects (font (size 0.4 0.4) (thickness 0.06))))
)`)
const OLD = parseKicadFootprint(`(footprint "R_0402"
  (layer "F.Cu")
  (fp_text reference "REF**" (at 0 -1 0) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15))))
  (fp_text value "R_0402" (at 0 1 0) (layer "F.Fab") (effects (font (size 1 1) (thickness 0.15))))
)`)

describe('withPreviewFields', () => {
  it('shows the part’s reference and value where the library says REF** and its own name', () => {
    const shown = withPreviewFields(LED, { reference: 'D1', value: 'LED' })
    const field = (key: string): string | undefined =>
      shown.properties.find((property) => property.key === key)?.value
    expect(field('Reference')).toBe('D1')
    expect(field('Value')).toBe('LED')
    // A user text is the footprint's own; `${REFERENCE}` resolves from the field.
    expect(shown.fpTexts[0].text).toBe('${REFERENCE}')
  })

  it('reads the older fp_text reference and value too, and leaves the library parse alone', () => {
    const shown = withPreviewFields(OLD, { reference: 'R7' })
    expect(shown.fpTexts.map((text) => text.text)).toEqual(['R7', 'R_0402'])
    expect(OLD.fpTexts[0].text).toBe('REF**')
  })
})
