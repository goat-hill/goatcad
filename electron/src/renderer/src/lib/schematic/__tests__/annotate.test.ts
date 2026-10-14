import { describe, expect, test } from 'vitest'
import { parseKicadSchematic } from '../../kicad/schematic'
import {
  instancesOf,
  pageOfSheetPath,
  parseReference,
  planAnnotation,
  type AnnotateOptions,
  type AnnotateSource
} from '../annotate'

const ROOT = '/root-uuid'
const CHILD = '/root-uuid/child-uuid'
const ROOT_FILE = '/p/root.kicad_sch'
const CHILD_FILE = '/p/child.kicad_sch'

/** A placed symbol whose reference lives in its instances block, as KiCad 6+ writes it. */
const sym = (
  reference: string,
  x: number,
  y: number,
  extra: { unit?: number; libId?: string; path?: string; uuid?: string } = {}
): string => {
  const unit = extra.unit ?? 1
  const libId = extra.libId ?? 'Device:R'
  const path = extra.path ?? ROOT
  return `(symbol (lib_id "${libId}") (at ${x} ${y} 0) (unit ${unit}) (uuid "${extra.uuid ?? `${reference}-${unit}-${x}-${y}`}")
    (property "Reference" "${reference}" (at ${x} ${y} 0))
    (instances (project "p" (path "${path}" (reference "${reference}") (unit ${unit})))))`
}

const doc = (uuid: string, body: string, extra = ''): ReturnType<typeof parseKicadSchematic> =>
  parseKicadSchematic(
    `(kicad_sch (version 20231120) (generator "test") (uuid "${uuid}") (lib_symbols) ${body} ${extra})`
  )

const rootDoc = (body: string): ReturnType<typeof parseKicadSchematic> =>
  doc('root-uuid', body, '(sheet_instances (path "/" (page "1")))')

const options = (over: Partial<AnnotateOptions> = {}): AnnotateOptions => ({
  order: 'xy',
  numbering: 'sequential',
  reset: false,
  ...over
})

const single = (schematic: ReturnType<typeof parseKicadSchematic>): AnnotateSource[] => [
  { schematic, sheetPath: ROOT, filePath: ROOT_FILE }
]

/** A one-sheet target: the whole design is the scope. */
const alone = (
  schematic: ReturnType<typeof parseKicadSchematic>,
  selection?: ReadonlySet<number>
): Parameters<typeof planAnnotation>[0] => {
  const sources = single(schematic)
  return { sources, scope: sources, selection }
}

const renames = (plan: ReturnType<typeof planAnnotation>): string[] =>
  plan.changes.map((change) => `${change.from}→${change.to}`)

describe('parseReference', () => {
  test('splits prefix and number, and reads ? as unannotated', () => {
    expect(parseReference('R12')).toEqual({ prefix: 'R', number: 12 })
    expect(parseReference('#PWR01')).toEqual({ prefix: '#PWR', number: 1 })
    expect(parseReference('R?')).toEqual({ prefix: 'R', number: null })
    expect(parseReference('U')).toEqual({ prefix: 'U', number: null })
  })
})

describe('instancesOf', () => {
  const sources: AnnotateSource[] = [
    { schematic: rootDoc(''), sheetPath: ROOT, filePath: ROOT_FILE },
    { schematic: doc('c', ''), sheetPath: CHILD, filePath: CHILD_FILE },
    { schematic: doc('g', ''), sheetPath: `${CHILD}/grand`, filePath: '/p/grand.kicad_sch' },
    { schematic: doc('c', ''), sheetPath: `${ROOT}/again`, filePath: CHILD_FILE }
  ]

  test('names every instance of a file, and beneath them when recursing', () => {
    expect(instancesOf(sources, [CHILD_FILE], false).map((s) => s.sheetPath)).toEqual([
      CHILD,
      `${ROOT}/again`
    ])
    expect(instancesOf(sources, [CHILD_FILE], true).map((s) => s.sheetPath)).toEqual([
      CHILD,
      `${CHILD}/grand`,
      `${ROOT}/again`
    ])
    expect(instancesOf(sources, [ROOT_FILE], true)).toEqual(sources)
  })
})

describe('planAnnotation', () => {
  test('keeps annotated parts and numbers the unannotated after the highest free', () => {
    const schematic = rootDoc([sym('R1', 10, 10), sym('R?', 20, 10), sym('C?', 30, 10)].join(' '))
    const plan = planAnnotation(alone(schematic), options())
    expect(renames(plan)).toEqual(['R?→R2', 'C?→C1'])
    expect(plan.considered).toBe(3)
    expect(plan.changes[0].filePath).toBe(ROOT_FILE)
  })

  test('a duplicate keeps its number on the first part in reading order and moves the other', () => {
    const schematic = rootDoc([sym('R3', 50, 10), sym('R3', 10, 10)].join(' '))
    const plan = planAnnotation(alone(schematic), options())
    // The one at x=10 reads first and keeps R3; the one at x=50 becomes R1.
    expect(plan.changes.map((c) => [c.symbolIndex, c.from, c.to])).toEqual([[0, 'R3', 'R1']])
  })

  test('reset renumbers everything in reading order, and the order option changes it', () => {
    const body = [sym('R7', 30, 10), sym('R2', 10, 30), sym('R9', 10, 10)].join(' ')
    const schematic = rootDoc(body)
    // x then y: (10,10) R9→R1, (10,30) R2→R2 (unchanged), (30,10) R7→R3.
    expect(renames(planAnnotation(alone(schematic), options({ reset: true })))).toEqual([
      'R9→R1',
      'R7→R3'
    ])
    // y then x: (10,10) R9→R1, (30,10) R7→R2, (10,30) R2→R3.
    expect(
      renames(planAnnotation(alone(schematic), options({ reset: true, order: 'yx' })))
    ).toEqual(['R9→R1', 'R7→R2', 'R2→R3'])
  })

  test('a start number puts every new designator above it', () => {
    const schematic = rootDoc([sym('R?', 10, 10), sym('R1', 20, 10)].join(' '))
    expect(renames(planAnnotation(alone(schematic), options({ start: 100 })))).toEqual(['R?→R101'])
  })

  test('numbers used on a sheet outside the scope are never handed out', () => {
    const root = rootDoc(sym('R1', 10, 10))
    const child = doc(
      'child-uuid',
      [sym('R?', 10, 10, { path: CHILD }), sym('R2', 20, 10, { path: CHILD })].join(' ')
    )
    const sources: AnnotateSource[] = [
      ...single(root),
      { schematic: child, sheetPath: CHILD, filePath: CHILD_FILE }
    ]
    const plan = planAnnotation({ sources, scope: [sources[1]] }, options())
    // R1 is on the root, R2 is on this sheet: the first free is R3.
    expect(renames(plan)).toEqual(['R?→R3'])
  })

  test('the whole design is numbered in hierarchy order, and a reset frees every scoped number', () => {
    const root = rootDoc([sym('R5', 10, 10), sym('R?', 20, 10)].join(' '))
    const child = doc(
      'child-uuid',
      [sym('R5', 10, 10, { path: CHILD }), sym('R1', 20, 10, { path: CHILD })].join(' ')
    )
    const sources: AnnotateSource[] = [
      ...single(root),
      { schematic: child, sheetPath: CHILD, filePath: CHILD_FILE }
    ]
    // Keep: the root's R5 stays, its R? takes R2 (R1 is on the child); the
    // child's R5 collides with the root's and becomes R3, its R1 stays.
    const kept = planAnnotation({ sources, scope: sources }, options())
    expect(kept.changes.map((c) => [c.filePath, c.from, c.to])).toEqual([
      [ROOT_FILE, 'R?', 'R2'],
      [CHILD_FILE, 'R5', 'R3']
    ])
    // Reset: the root reads first and takes R1, R2; the child R3, R4 — nothing
    // on the child holds a number back, since its own are being reset too.
    const reset = planAnnotation({ sources, scope: sources }, options({ reset: true }))
    expect(reset.changes.map((c) => [c.filePath, c.to])).toEqual([
      [ROOT_FILE, 'R1'],
      [ROOT_FILE, 'R2'],
      [CHILD_FILE, 'R3'],
      [CHILD_FILE, 'R4']
    ])
  })

  test('per-sheet numbering starts at the page × 100, read from the parent sheet node', () => {
    const root = rootDoc(`(sheet (at 100 100) (size 40 30) (uuid "child-uuid")
      (property "Sheetname" "Power" (at 100 99 0))
      (property "Sheetfile" "child.kicad_sch" (at 100 131 0))
      (instances (project "p" (path "${ROOT}" (page "2")))))`)
    const child = doc(
      'child-uuid',
      [sym('R?', 10, 10, { path: CHILD }), sym('C?', 20, 10, { path: CHILD })].join(' ')
    )
    const sources: AnnotateSource[] = [
      ...single(root),
      { schematic: child, sheetPath: CHILD, filePath: CHILD_FILE }
    ]
    expect(pageOfSheetPath(sources, CHILD)).toBe(2)
    expect(pageOfSheetPath(sources, ROOT)).toBe(1)
    const plan = planAnnotation(
      { sources, scope: [sources[1]] },
      options({ numbering: 'sheet100' })
    )
    expect(renames(plan)).toEqual(['R?→R201', 'C?→C201'])
  })

  test('units of one part move together on a reset', () => {
    const body = [
      sym('U5', 10, 10, { unit: 1, libId: 'Amp:Quad' }),
      sym('U5', 40, 10, { unit: 2, libId: 'Amp:Quad' }),
      sym('U3', 20, 10, { unit: 1, libId: 'Amp:Quad' })
    ].join(' ')
    const plan = planAnnotation(alone(rootDoc(body)), options({ reset: true }))
    expect(plan.changes.map((c) => [c.symbolIndex, c.to])).toEqual([
      [0, 'U1'],
      [1, 'U1'],
      [2, 'U2']
    ])
  })

  test('a selection confines the run and the rest of the sheet stays in the pool', () => {
    const schematic = rootDoc([sym('R?', 10, 10), sym('R?', 20, 10), sym('R4', 30, 10)].join(' '))
    const plan = planAnnotation(alone(schematic, new Set([1])), options())
    // First free fills the gap below R4, as KiCad's "first free number" does;
    // the unselected R? is not a number and takes nothing.
    expect(plan.changes.map((c) => [c.symbolIndex, c.from, c.to])).toEqual([[1, 'R?', 'R1']])
    expect(plan.considered).toBe(1)
  })

  test('a repeated sheet is numbered once per instance path', () => {
    const root = rootDoc(sym('R1', 10, 10))
    const child = doc(
      'child-uuid',
      `(symbol (lib_id "Device:R") (at 10 10 0) (unit 1) (uuid "r")
        (property "Reference" "R?" (at 10 10 0))
        (instances (project "p"
          (path "${ROOT}/a" (reference "R?") (unit 1))
          (path "${ROOT}/b" (reference "R?") (unit 1)))))`
    )
    const sources: AnnotateSource[] = [
      ...single(root),
      { schematic: child, sheetPath: `${ROOT}/a`, filePath: CHILD_FILE },
      { schematic: child, sheetPath: `${ROOT}/b`, filePath: CHILD_FILE }
    ]
    const plan = planAnnotation({ sources, scope: sources.slice(1) }, options())
    expect(plan.changes.map((c) => [c.sheetPath, c.to])).toEqual([
      [`${ROOT}/a`, 'R2'],
      [`${ROOT}/b`, 'R3']
    ])
  })
})
