import { describe, expect, test } from 'vitest'
import {
  applyReferenceRewrites,
  enumerateReferences,
  kindsForFile,
  SHEET_FILE_KIND,
  type ReferenceRewrite
} from '../references'

/** A .kicad_sch whose sheets each name a child file via Sheetfile. */
const sheetDoc = (uuid: string, sheets: Array<{ name: string; file: string }>): string =>
  `(kicad_sch
  (version 20231120)
  (uuid "${uuid}")
${sheets
  .map(
    (sheet, i) => `  (sheet (at 0 0) (size 10 10) (uuid "sheet-${i}")
    (property "Sheetname" "${sheet.name}" (at 0 0 0))
    (property "Sheetfile" "${sheet.file}" (at 0 0 0)))`
  )
  .join('\n')}
)
`

describe('kindsForFile', () => {
  test('matches sheet.file to .kicad_sch, case-insensitively', () => {
    expect(kindsForFile('/p/main.kicad_sch')).toEqual([SHEET_FILE_KIND])
    expect(kindsForFile('/p/MAIN.KICAD_SCH')).toEqual([SHEET_FILE_KIND])
  })

  test('no kinds for unrelated files', () => {
    expect(kindsForFile('/p/board.kicad_pcb')).toEqual([])
    expect(kindsForFile('/p/notes.md')).toEqual([])
    expect(kindsForFile('/p/noext')).toEqual([])
  })
})

describe('enumerateReferences: sheet.file', () => {
  test('finds each Sheetfile and resolves it against the source dir', () => {
    const text = sheetDoc('root', [
      { name: 'USB', file: 'usb.kicad_sch' },
      { name: 'Power', file: '../shared/power.kicad_sch' }
    ])
    const refs = enumerateReferences('/proj/board/main.kicad_sch', text)
    expect(refs.map((r) => ({ raw: r.rawValue, resolved: r.resolved, kind: r.kind }))).toEqual([
      { raw: 'usb.kicad_sch', resolved: '/proj/board/usb.kicad_sch', kind: 'sheet.file' },
      {
        raw: '../shared/power.kicad_sch',
        resolved: '/proj/shared/power.kicad_sch',
        kind: 'sheet.file'
      }
    ])
  })

  test('span covers the value token including its quotes', () => {
    const text = sheetDoc('root', [{ name: 'USB', file: 'usb.kicad_sch' }])
    const [ref] = enumerateReferences('/proj/main.kicad_sch', text)
    expect(text.slice(ref.span.start, ref.span.end)).toBe('"usb.kicad_sch"')
    expect(ref.quoted).toBe(true)
  })

  test('a sheet without a Sheetfile contributes no reference', () => {
    const text = `(kicad_sch
  (uuid "root")
  (sheet (uuid "s0") (property "Sheetname" "Note" (at 0 0 0))))
`
    expect(enumerateReferences('/p/main.kicad_sch', text)).toEqual([])
  })

  test('malformed input yields no references instead of throwing', () => {
    expect(enumerateReferences('/p/main.kicad_sch', '(kicad_sch (sheet')).toEqual([])
    expect(enumerateReferences('/p/main.kicad_sch', '')).toEqual([])
  })
})

describe('applyReferenceRewrites', () => {
  test('splices only the value token; every other byte is preserved', () => {
    const text = sheetDoc('root', [{ name: 'USB', file: 'usb.kicad_sch' }])
    const [ref] = enumerateReferences('/p/main.kicad_sch', text)
    const rewrite: ReferenceRewrite = {
      span: ref.span,
      quoted: ref.quoted,
      newValue: 'usb-v2.kicad_sch'
    }
    const out = applyReferenceRewrites(text, [rewrite])
    expect(out).toBe(text.replace('"usb.kicad_sch"', '"usb-v2.kicad_sch"'))
    // Byte-identical elsewhere: the only diff is inside the one token.
    expect(out.length).toBe(text.length + '-v2'.length)
  })

  test('multiple rewrites in one file apply without offset drift', () => {
    const text = sheetDoc('root', [
      { name: 'A', file: 'a.kicad_sch' },
      { name: 'B', file: 'b.kicad_sch' }
    ])
    const refs = enumerateReferences('/p/main.kicad_sch', text)
    const out = applyReferenceRewrites(
      text,
      refs.map((r) => ({ span: r.span, quoted: r.quoted, newValue: `x-${r.rawValue}` }))
    )
    const roundTrip = enumerateReferences('/p/main.kicad_sch', out)
    expect(roundTrip.map((r) => r.rawValue)).toEqual(['x-a.kicad_sch', 'x-b.kicad_sch'])
  })

  test('escapes a quoted value the way the serializer does', () => {
    const text = sheetDoc('root', [{ name: 'USB', file: 'usb.kicad_sch' }])
    const [ref] = enumerateReferences('/p/main.kicad_sch', text)
    const out = applyReferenceRewrites(text, [
      { span: ref.span, quoted: true, newValue: 'weird "name".kicad_sch' }
    ])
    expect(out).toContain('"weird \\"name\\".kicad_sch"')
  })
})
