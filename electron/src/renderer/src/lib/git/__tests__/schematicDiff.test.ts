import { describe, expect, test } from 'vitest'
import { parseKicadSchematic } from '../../kicad/schematic'
import { diffSchematics, withRemovedItems } from '../schematicDiff'

const sym = (uuid: string, reference: string, x: number, value = '10k'): string =>
  `(symbol (lib_id "Device:R") (at ${x} 50 0) (unit 1) (uuid "${uuid}")
    (property "Reference" "${reference}" (at ${x} 48 0))
    (property "Value" "${value}" (at ${x} 52 0))
    (instances (project "p" (path "/root" (reference "${reference}") (unit 1)))))`

const wire = (uuid: string, x1: number, x2: number): string =>
  `(wire (pts (xy ${x1} 60) (xy ${x2} 60)) (stroke (width 0) (type default)) (uuid "${uuid}"))`

const doc = (body: string): ReturnType<typeof parseKicadSchematic> =>
  parseKicadSchematic(
    `(kicad_sch (version 20231120) (generator "test") (uuid "root") (lib_symbols) ${body})`
  )

const summary = (diff: ReturnType<typeof diffSchematics>): string[] =>
  diff.changes.map((c) => `${c.kind} ${c.item} ${c.label}`)

describe('diffSchematics', () => {
  test('an unchanged sheet has no changes', () => {
    const text = `${sym('a', 'R1', 10)} ${wire('w', 0, 10)}`
    expect(diffSchematics(doc(text), doc(text)).changes).toEqual([])
  })

  test('matches by uuid: a move is a move, not a delete and an add', () => {
    const diff = diffSchematics(doc(sym('a', 'R1', 10)), doc(sym('a', 'R1', 20)))
    expect(summary(diff)).toEqual(['moved symbol R1'])
    // Fields moving with their symbol are geometry too.
    expect(diff.changes[0].fields).toEqual([])
  })

  test('a value edit is a modification that names the field', () => {
    const diff = diffSchematics(doc(sym('a', 'R1', 10)), doc(sym('a', 'R1', 10, '4k7')))
    expect(summary(diff)).toEqual(['modified symbol R1'])
    expect(diff.changes[0].fields).toEqual([{ name: 'Value', before: '10k', after: '4k7' }])
  })

  test('additions and removals, symbols listed before wires', () => {
    const diff = diffSchematics(
      doc(`${sym('a', 'R1', 10)} ${wire('w1', 0, 10)}`),
      doc(`${sym('b', 'R2', 30)} ${wire('w1', 0, 10)} ${wire('w2', 10, 20)}`)
    )
    expect(summary(diff)).toEqual(['removed symbol R1', 'added symbol R2', 'added wire wire'])
    expect(diff.counts).toEqual({ added: 2, removed: 1, modified: 0, moved: 0 })
  })

  test('uuid-less junctions match by position', () => {
    const before = doc('(junction (at 10 60) (diameter 0) (color 0 0 0 0))')
    const after = doc('(junction (at 20 60) (diameter 0) (color 0 0 0 0))')
    expect(summary(diffSchematics(before, after))).toEqual([
      'added junction junction',
      'removed junction junction'
    ])
  })

  test('each change names its render key on the sides that have it', () => {
    const diff = diffSchematics(
      doc(`${wire('w0', 0, 5)} ${sym('a', 'R1', 10)}`),
      doc(`${sym('b', 'R2', 30)} ${sym('a', 'R1', 20)}`)
    )
    const byLabel = Object.fromEntries(diff.changes.map((c) => [`${c.kind} ${c.label}`, c]))
    expect(byLabel['moved R1']).toMatchObject({ beforeKey: 'symbol:0', afterKey: 'symbol:1' })
    expect(byLabel['added R2']).toMatchObject({ afterKey: 'symbol:0' })
    expect(byLabel['added R2'].beforeKey).toBeUndefined()
    expect(byLabel['removed wire']).toMatchObject({ beforeKey: 'wire:0' })
  })

  test('a missing side makes everything added or removed', () => {
    const one = doc(sym('a', 'R1', 10))
    expect(summary(diffSchematics(null, one))).toEqual(['added symbol R1'])
    expect(summary(diffSchematics(one, null))).toEqual(['removed symbol R1'])
  })

  test('label text edits are named', () => {
    const label = (text: string): string =>
      `(label "${text}" (at 10 60 0) (effects (font (size 1.27 1.27))) (uuid "l"))`
    const diff = diffSchematics(doc(label('SDA')), doc(label('SCL')))
    expect(diff.changes[0]).toMatchObject({
      kind: 'modified',
      item: 'label',
      label: 'SCL',
      fields: [{ name: 'text', before: 'SDA', after: 'SCL' }]
    })
  })
})

describe('withRemovedItems', () => {
  test('draws removed items back into the after sheet, keyed past its own', () => {
    const before = doc(`${sym('a', 'R1', 10)} ${sym('gone', 'R9', 40)} ${wire('w', 0, 5)}`)
    const after = doc(`${sym('a', 'R1', 10)} ${sym('new', 'R2', 30)}`)
    const diff = diffSchematics(before, after)
    const { doc: combined, removedKeys } = withRemovedItems(after, before, diff.changes)
    expect(combined?.symbols.map((s) => s.uuid)).toEqual(['a', 'new', 'gone'])
    expect(combined?.wires).toHaveLength(1)
    expect([...removedKeys.values()].sort()).toEqual(['symbol:2', 'wire:0'])
    // The inputs are untouched: this is a render-only copy.
    expect(after.symbols).toHaveLength(2)
  })

  test('a deleted file is its old sheet, all removed', () => {
    const before = doc(sym('a', 'R1', 10))
    const { doc: combined, removedKeys } = withRemovedItems(
      null,
      before,
      diffSchematics(before, null).changes
    )
    expect(combined?.symbols).toHaveLength(1)
    expect([...removedKeys.values()]).toEqual(['symbol:0'])
  })
})
