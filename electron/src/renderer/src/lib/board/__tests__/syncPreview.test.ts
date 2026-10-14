import { describe, expect, test } from 'vitest'
import type { KicadBoardFootprint } from '../../kicad/board'
import type { KicadFootprint } from '../../kicad/footprint'
import type { Nm } from '../../kicad/coordinates'
import {
  scopePlan,
  type SyncAddition,
  type SyncChange,
  type SyncOrphan,
  type SyncPart,
  type SyncPlan,
  type SyncUpdate
} from '../boardSync'
import { syncPreviewRows, syncWouldChange } from '../syncPreview'

const part = (reference: string, value = '10k', libId = 'Lib:FP'): SyncPart =>
  ({ reference, value, libId }) as SyncPart

const placed = (reference: string, value = '10k', libId = 'Lib:FP'): KicadBoardFootprint =>
  ({ reference, value, libId }) as KicadBoardFootprint

const addition = (reference: string, libId?: string): SyncAddition => ({
  part: part(reference, '10k', libId),
  footprint: {} as KicadFootprint,
  at: { x: 0 as Nm, y: 0 as Nm }
})

const orphan = (reference: string): SyncOrphan => ({
  reference,
  libId: 'Conn:X',
  path: '/x',
  footprint: placed(reference, 'HDR', 'Conn:X')
})

const update = (
  wanted: SyncPart,
  footprint: KicadBoardFootprint,
  changes: SyncChange[]
): SyncUpdate => ({ part: wanted, footprint, changes, relinked: false })

const plan = (overrides: Partial<SyncPlan> = {}): SyncPlan => ({
  add: [],
  update: [],
  unchanged: 0,
  orphans: [],
  skipped: [],
  footprintChanged: [],
  nets: { added: [], removed: [] },
  ...overrides
})

describe('syncPreviewRows', () => {
  test('lists additions, parts that cannot be added and orphans, by kind then reference', () => {
    const rows = syncPreviewRows(
      plan({
        add: [addition('R10'), addition('R2', 'Resistor_SMD:R_0402')],
        skipped: [{ reference: 'U3', reason: 'footprint-not-found', libId: 'Nowhere:X' }],
        orphans: [orphan('J9')]
      })
    )
    expect(rows).toEqual([
      { kind: 'add', reference: 'R2', value: '10k', libId: 'Resistor_SMD:R_0402', changes: [] },
      { kind: 'add', reference: 'R10', value: '10k', libId: 'Lib:FP', changes: [] },
      {
        kind: 'add',
        reference: 'U3',
        value: '',
        libId: 'Nowhere:X',
        changes: [],
        problem: 'footprint-not-found'
      },
      { kind: 'remove', reference: 'J9', value: 'HDR', libId: 'Conn:X', changes: [] }
    ])
  })

  test('an update names what changes, from what, its swap merged; bookkeeping is not a row', () => {
    const c1 = placed('C1', '22pF', 'Lib:C_0402')
    const rows = syncPreviewRows(
      plan({
        update: [
          update(part('C1', '33pF', 'Lib:C_0603'), c1, ['value', 'nets', 'sheet']),
          update(part('C2'), placed('C2'), ['sheet', 'path', 'pins'])
        ],
        footprintChanged: [
          {
            reference: 'C1',
            board: 'Lib:C_0402',
            schematic: 'Lib:C_0603',
            footprint: c1,
            library: {} as KicadFootprint
          }
        ]
      })
    )
    expect(rows).toEqual([
      {
        kind: 'update',
        reference: 'C1',
        value: '33pF',
        libId: 'Lib:C_0603',
        valueFrom: '22pF',
        libIdFrom: 'Lib:C_0402',
        changes: ['value', 'footprint', 'nets']
      }
    ])
  })
})

describe('scopePlan', () => {
  const swapped = placed('U1', 'MCU', 'Lib:A')
  const full = plan({
    update: [
      update(part('R1'), placed('R1'), ['fields', 'attributes']),
      update(part('R2', '1k'), placed('R2'), ['value', 'fields'])
    ],
    footprintChanged: [
      {
        reference: 'U1',
        board: 'Lib:A',
        schematic: 'Lib:B',
        footprint: swapped,
        library: {} as KicadFootprint
      }
    ]
  })

  test('is the plan itself with both options on', () => {
    const scoped = scopePlan(full, {})
    expect(scoped.update).toEqual(full.update)
    expect(scoped.footprintChanged).toEqual(full.footprintChanged)
  })

  test('without fields, leaves fields and attributes alone and a footprint changed only there', () => {
    const scoped = scopePlan(full, { updateFields: false })
    expect(scoped.update.map((entry) => [entry.part.reference, entry.changes])).toEqual([
      ['R2', ['value']]
    ])
    expect(scoped.unchanged).toBe(1)
  })

  test('without replacing, rebuilds no footprint', () => {
    expect(scopePlan(full, { replaceFootprints: false }).footprintChanged).toEqual([])
  })
})

describe('syncWouldChange', () => {
  test('additions and updates write; orphans write only when pruned', () => {
    expect(syncWouldChange(plan(), true)).toBe(false)
    expect(syncWouldChange(plan({ add: [addition('R1')] }), false)).toBe(true)
    const orphaned = plan({ orphans: [orphan('J9')] })
    expect(syncWouldChange(orphaned, false)).toBe(false)
    expect(syncWouldChange(orphaned, true)).toBe(true)
  })
})
