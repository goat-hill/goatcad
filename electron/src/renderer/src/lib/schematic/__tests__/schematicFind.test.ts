import { describe, expect, test } from 'vitest'
import {
  getSymbolProperty,
  parseKicadSchematic,
  referenceForSheetPath,
  serializeKicadSchematic,
  type KicadSchematic
} from '../../kicad/schematic'
import { compileQuery } from '../../canvasFind'
import {
  applyReplaceEdit,
  duplicateReferences,
  FIND_DEFAULTS,
  findMatches,
  replaceEdits,
  type FindSource
} from '../schematicFind'

const symbol = (
  uuid: string,
  x: number,
  y: number,
  refs: Record<string, string>,
  value: string
): string => `
  (symbol (lib_id "Device:R") (at ${x} ${y} 0) (unit 1) (uuid "${uuid}")
    (property "Reference" "${Object.values(refs)[0]}" (at ${x} ${y - 2} 0) (effects (font (size 1.27 1.27))))
    (property "Value" "${value}" (at ${x} ${y + 2} 0) (effects (font (size 1.27 1.27))))
    (property "ki_keywords" "10k resistor" (at ${x} ${y} 0) (effects (font (size 1.27 1.27)) hide))
    (instances (project "p" ${Object.entries(refs)
      .map(([path, ref]) => `(path "${path}" (reference "${ref}") (unit 1))`)
      .join(' ')})))`

/** An amplifier sheet, used twice: /root/a1 and /root/a2. */
const amp = (): KicadSchematic =>
  parseKicadSchematic(`(kicad_sch (version 20231120) (uuid "amp") (paper "A4") (lib_symbols)
  ${symbol('r-in', 50, 60, { '/root/a1': 'R1', '/root/a2': 'R11' }, '10k')}
  ${symbol('r-fb', 80, 40, { '/root/a1': 'R2', '/root/a2': 'R12' }, '10K')}
  (label "IN_10k" (at 40 60 0) (effects (font (size 1.27 1.27))) (uuid "l1"))
  (text "gain = R2 / R1" (at 30 20 0) (effects (font (size 1.27 1.27))) (uuid "t1"))
  (text_box "use 10k 1%" (exclude_from_sim no) (at 100 100 0) (size 20 10)
    (stroke (width 0) (type solid)) (fill (type none))
    (effects (font (size 1.27 1.27))) (uuid "tb1"))
)`)

const sources = (doc: KicadSchematic = amp()): FindSource[] => [
  { filePath: '/p/amp.kicad_sch', sheetPath: '/root/a1', schematic: doc },
  { filePath: '/p/amp.kicad_sch', sheetPath: '/root/a2', schematic: doc }
]

describe('matching', () => {
  test('case folds unless asked, and whole words stand alone', () => {
    const texts = (options = FIND_DEFAULTS, query = '10k'): string[] =>
      findMatches(sources().slice(0, 1), query, options).map((match) => match.text)
    expect(texts()).toEqual(['10K', 'IN_10k', '10k', 'use 10k 1%'])
    expect(texts({ ...FIND_DEFAULTS, matchCase: true })).toEqual(['IN_10k', '10k', 'use 10k 1%'])
    // `IN_10k` has the digits inside a word: a whole-word search skips it.
    expect(texts({ ...FIND_DEFAULTS, wholeWord: true })).toEqual(['10K', '10k', 'use 10k 1%'])
  })

  test('lib-only ki_ fields are not text on the sheet', () => {
    expect(findMatches(sources(), 'resistor', FIND_DEFAULTS)).toEqual([])
  })

  test('hits run top to bottom, then left to right', () => {
    const order = findMatches(sources().slice(0, 1), 'R', {
      ...FIND_DEFAULTS,
      matchCase: true
    }).map((match) => `${match.target.kind}:${match.text}@${match.start}`)
    expect(order).toEqual([
      'text:gain = R2 / R1@7',
      'text:gain = R2 / R1@12',
      'field:R2@0',
      'field:R1@0'
    ])
  })

  test('a reused sheet is searched once for its text and per path for references', () => {
    const matches = findMatches(sources(), 'R1', FIND_DEFAULTS)
    expect(matches.map((match) => [match.sheetPath, match.target.kind, match.text])).toEqual([
      ['/root/a1', 'text', 'gain = R2 / R1'],
      ['/root/a1', 'field', 'R1'],
      ['/root/a2', 'field', 'R12'],
      ['/root/a2', 'field', 'R11']
    ])
    // Every key is distinct, so next and previous can step through them.
    expect(new Set(matches.map((match) => match.key)).size).toBe(matches.length)
  })

  test('a regex that does not compile finds nothing', () => {
    expect(compileQuery('(', { ...FIND_DEFAULTS, regex: true })).toBeNull()
    expect(findMatches(sources(), '(', { ...FIND_DEFAULTS, regex: true })).toEqual([])
    expect(findMatches(sources(), 'R\\d+$', { ...FIND_DEFAULTS, regex: true })).toHaveLength(5)
  })

  test('a match carries where to look and what to select', () => {
    const [label] = findMatches(sources(), 'IN_', FIND_DEFAULTS)
    expect(label.target).toEqual({ kind: 'label', index: 0 })
    expect(label.uuid).toBe('l1')
    const [box] = findMatches(sources(), '1%', FIND_DEFAULTS)
    expect(box.target.kind).toBe('text_box')
    expect(box.position.x).toBe(110_000_000)
  })
})

describe('replacing', () => {
  test('replace all writes each item once, every hit in it', () => {
    const doc = amp()
    const matches = findMatches(sources(doc), '10k', FIND_DEFAULTS)
    const edits = replaceEdits(matches, '10k', '22k', FIND_DEFAULTS)
    expect(edits.map((edit) => edit.after)).toEqual(['22k', 'IN_22k', '22k', 'use 22k 1%'])
    for (const edit of edits) applyReplaceEdit(doc, edit)
    const after = parseKicadSchematic(serializeKicadSchematic(doc))
    expect(after.symbols.map((s) => getSymbolProperty(s, 'Value'))).toEqual(['22k', '22k'])
    expect(after.labels[0].text).toBe('IN_22k')
    expect(after.textBoxes[0].graphic.text).toBe('use 22k 1%')
  })

  test('replace one writes that hit alone, with regex groups', () => {
    const options = { ...FIND_DEFAULTS, regex: true }
    const matches = findMatches(sources().slice(0, 1), 'R(\\d)', options)
    const text = matches.find((match) => match.target.kind === 'text' && match.start === 12)!
    const [edit] = replaceEdits(matches, 'R(\\d)', 'RF$1', options, text)
    expect(edit.after).toBe('gain = R2 / RF1')
  })

  test('references are found but renamed only when asked', () => {
    const matches = findMatches(sources(), 'R1', FIND_DEFAULTS)
    expect(
      replaceEdits(matches, 'R1', 'R9', FIND_DEFAULTS).map((edit) => edit.target.kind)
    ).toEqual(['text'])
    const edits = replaceEdits(matches, 'R1', 'R9', { ...FIND_DEFAULTS, replaceReferences: true })
    expect(edits.filter((edit) => edit.target.kind === 'field').map((edit) => edit.after)).toEqual([
      'R9',
      'R92',
      'R91'
    ])
  })

  test('a reference is renamed on its own path only', () => {
    const doc = amp()
    const options = { ...FIND_DEFAULTS, replaceReferences: true, wholeWord: true }
    const matches = findMatches(sources(doc), 'R11', options)
    for (const edit of replaceEdits(matches, 'R11', 'R21', options)) applyReplaceEdit(doc, edit)
    const after = parseKicadSchematic(serializeKicadSchematic(doc))
    expect(referenceForSheetPath(after.symbols[0], '/root/a1')).toBe('R1')
    expect(referenceForSheetPath(after.symbols[0], '/root/a2')).toBe('R21')
  })

  test('a rename onto another part is a duplicate; units of one part are not', () => {
    const options = { ...FIND_DEFAULTS, replaceReferences: true, wholeWord: true }
    const all = sources()
    const onto = replaceEdits(findMatches(all, 'R2', options), 'R2', 'R1', options)
    expect(duplicateReferences(all, onto)).toEqual(['R1'])
    const fresh = replaceEdits(findMatches(all, 'R2', options), 'R2', 'R5', options)
    expect(duplicateReferences(all, fresh)).toEqual([])
    // Swapping two names in one run clashes with nothing.
    const unannotated = replaceEdits(findMatches(all, 'R2', options), 'R2', 'R?', options)
    expect(duplicateReferences(all, unannotated)).toEqual([])
  })
})
