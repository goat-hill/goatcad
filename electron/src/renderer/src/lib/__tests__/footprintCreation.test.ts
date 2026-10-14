import { describe, expect, test } from 'vitest'
import { footprintTextRenamed } from '../footprintCreation'
import { parseKicadFootprint } from '../kicad/footprint'

const source = (name: string, value = name): string => `
(footprint "${name}"
  (layer "F.Cu")
  (property "Reference" "REF**" (at 0 -2 0) (layer "F.SilkS"))
  (property "Value" "${value}" (at 0 2 0) (layer "F.Fab"))
  (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu")))
`

const named = (text: string): { name: string; value: string | undefined } => {
  const fp = parseKicadFootprint(text)
  return { name: fp.name, value: fp.properties.find((p) => p.key === 'Value')?.value }
}

describe('footprintTextRenamed', () => {
  test('carries the new name into the file KiCad reads it from', () => {
    const renamed = footprintTextRenamed(source('SOT-23-6'), 'MyPart')
    expect(renamed).not.toBeNull()
    expect(named(renamed!).name).toBe('MyPart')
  })

  test('a Value that followed the old name follows the new one', () => {
    // It prints on the fab layer, so a copy renamed without it silks the
    // package it came from.
    expect(named(footprintTextRenamed(source('SOT-23-6'), 'MyPart')!).value).toBe('MyPart')
  })

  test('a Value someone edited is left alone', () => {
    const renamed = footprintTextRenamed(source('SOT-23-6', 'U1 regulator'), 'MyPart')
    expect(named(renamed!).value).toBe('U1 regulator')
  })

  test('answers null when the name is already right, so nothing is rewritten', () => {
    expect(footprintTextRenamed(source('SOT-23-6'), 'SOT-23-6')).toBeNull()
  })

  test('leaves the rest of the file alone', () => {
    const renamed = footprintTextRenamed(source('SOT-23-6'), 'MyPart')!
    expect(parseKicadFootprint(renamed).pads).toHaveLength(1)
    expect(renamed).toContain('REF**')
  })
})
