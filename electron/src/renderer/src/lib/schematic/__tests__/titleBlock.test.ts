import { describe, expect, test } from 'vitest'
import { parseKicadSchematic, serializeKicadSchematic } from '../../kicad/schematic'
import { readTitleBlock, setTitleBlockEntry, type TitleBlockKey } from '../titleBlock'

const SHEET = `(kicad_sch
  (version 20250114)
  (generator "eeschema")
  (uuid "u")
  (paper "A4")
  (title_block
    (title "Board")
    (company "Goats")
    (comment 3 "third")
    (future "kept"))
  (lib_symbols))`

const BARE = `(kicad_sch
  (version 20250114)
  (generator "eeschema")
  (uuid "u")
  (paper "A4")
  (lib_symbols))`

const edited = (source: string, key: TitleBlockKey, text: string): string => {
  const schematic = parseKicadSchematic(source)
  setTitleBlockEntry(schematic, key, text)
  return serializeKicadSchematic(schematic)
}
const canonical = (text: string): string => serializeKicadSchematic(parseKicadSchematic(text))

describe('the title block', () => {
  test('reads each entry, empty for one the file does not give', () => {
    const block = readTitleBlock(parseKicadSchematic(SHEET))
    expect(block).toMatchObject({ title: 'Board', company: 'Goats', comment3: 'third', date: '' })
    expect(readTitleBlock(parseKicadSchematic(BARE)).title).toBe('')
  })

  test('rewrites an entry in place, touching nothing else', () => {
    expect(edited(SHEET, 'title', 'Main')).toBe(canonical(SHEET.replace('"Board"', '"Main"')))
    expect(edited(SHEET, 'comment3', 'x')).toBe(canonical(SHEET.replace('"third"', '"x"')))
  })

  test("adds an entry in KiCad's order among those there", () => {
    expect(edited(SHEET, 'rev', 'C')).toBe(
      canonical(SHEET.replace('(company "Goats")', '(rev "C") (company "Goats")'))
    )
    expect(edited(SHEET, 'comment1', 'first')).toBe(
      canonical(SHEET.replace('(comment 3', '(comment 1 "first") (comment 3'))
    )
    expect(edited(SHEET, 'comment9', 'last')).toBe(
      canonical(SHEET.replace('(comment 3 "third")', '(comment 3 "third") (comment 9 "last")'))
    )
  })

  test('creates the block after the paper when the file has none', () => {
    expect(edited(BARE, 'date', '2026-09-24')).toBe(
      canonical(BARE.replace('(paper "A4")', '(paper "A4") (title_block (date "2026-09-24"))'))
    )
  })

  test("drops an emptied entry, and the block once it holds nothing, as KiCad's writer does", () => {
    expect(edited(SHEET, 'company', '')).toBe(canonical(SHEET.replace('(company "Goats")', '')))
    const one = BARE.replace('(paper "A4")', '(paper "A4") (title_block (rev "A"))')
    expect(edited(one, 'rev', '')).toBe(canonical(BARE))
    // Clearing what is not there changes nothing.
    expect(edited(BARE, 'title', '')).toBe(canonical(BARE))
  })
})
