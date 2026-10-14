import { describe, expect, test } from 'vitest'
import {
  chooseActiveProject,
  depthBelow,
  ownsRootSheet,
  projectCandidates,
  rootSheetUuid
} from '../projectDetect'

const ROOT = '/home/u/hw'

describe('depthBelow', () => {
  test('counts segments below the root', () => {
    expect(depthBelow(ROOT, ROOT)).toBe(0)
    expect(depthBelow(`${ROOT}/psu`, ROOT)).toBe(1)
    expect(depthBelow(`${ROOT}/psu/rev-c`, ROOT)).toBe(2)
  })

  test('ignores a trailing separator on either side', () => {
    expect(depthBelow(`${ROOT}/psu/`, `${ROOT}/`)).toBe(1)
  })

  test('rejects a sibling whose name merely shares a prefix', () => {
    // /home/u/hw-other is not inside /home/u/hw, though it starts with it.
    expect(depthBelow('/home/u/hw-other/psu', ROOT)).toBe(-1)
  })

  test('compares case-insensitively, since macOS and Windows do', () => {
    expect(depthBelow('/home/u/HW/psu', ROOT)).toBe(1)
  })

  test('handles Windows separators', () => {
    expect(depthBelow('C:\\work\\hw\\psu', 'C:\\work\\hw')).toBe(1)
  })
})

describe('chooseActiveProject', () => {
  const choose = (paths: string[]): string | null =>
    chooseActiveProject(projectCandidates(paths, ROOT))?.name ?? null

  test('no project → none active', () => {
    expect(choose([])).toBeNull()
  })

  test('a single project is active wherever it sits', () => {
    expect(choose([`${ROOT}/psu.kicad_pro`])).toBe('psu')
    expect(choose([`${ROOT}/boards/psu/psu.kicad_pro`])).toBe('psu')
  })

  test('a root-level project wins over nested ones', () => {
    // demos/royalblue54L_feather: a main board with a sub-board inside it.
    expect(
      choose([
        `${ROOT}/RoyalBlue54L-Feather.kicad_pro`,
        `${ROOT}/nfc_antenna/RoyalBlue54L-NFC-Antenna/RoyalBlue54L-NFC-Antenna.kicad_pro`
      ])
    ).toBe('RoyalBlue54L-Feather')
  })

  test('two projects sharing the root are ambiguous → none active', () => {
    // demos/ecc83: two design variants side by side. Guessing would silently
    // apply the wrong design's libraries.
    expect(choose([`${ROOT}/ecc83-pp.kicad_pro`, `${ROOT}/ecc83-pp_v2.kicad_pro`])).toBeNull()
  })

  test('several nested with none at the root is ambiguous → none active', () => {
    expect(choose([`${ROOT}/psu/psu.kicad_pro`, `${ROOT}/mcu/mcu.kicad_pro`])).toBeNull()
  })

  test('candidates outside the workspace are not candidates at all', () => {
    expect(projectCandidates(['/elsewhere/x.kicad_pro'], ROOT)).toEqual([])
  })

  test('carries both the filename to show and the stem that matches a board', () => {
    // A `.kicad_pro` has no name field, so the UI shows the filename; the stem
    // is still what associates `psu.kicad_pro` with `psu.kicad_pcb`.
    const [c] = projectCandidates([`${ROOT}/psu.kicad_pro`], ROOT)
    expect(c.fileName).toBe('psu.kicad_pro')
    expect(c.name).toBe('psu')
  })
})

describe('rootSheetUuid', () => {
  const uuid = '28f865a0-4433-4a53-bbd7-b62f276848e4'

  test('reads the first sheets entry of a KiCad v3 project', () => {
    expect(rootSheetUuid({ sheets: [[uuid, 'Root']] })).toBe(uuid)
  })

  test('rejects the legacy filename-in-slot-0 shape', () => {
    // GoatCAD wrote `sheets: [['main.kicad_sch', 'Root']]` before P0.8. Returning
    // that string would let it compare equal to nothing and true to nothing —
    // but it would also mask the fact that we have no uuid.
    expect(rootSheetUuid({ sheets: [['main.kicad_sch', 'Root']] })).toBeNull()
  })

  test('tolerates missing, empty, and non-object input', () => {
    expect(rootSheetUuid({})).toBeNull()
    expect(rootSheetUuid({ sheets: [] })).toBeNull()
    expect(rootSheetUuid(null)).toBeNull()
    expect(rootSheetUuid('nonsense')).toBeNull()
  })
})

describe('ownsRootSheet', () => {
  const uuid = '28f865a0-4433-4a53-bbd7-b62f276848e4'

  test('matches its own root sheet and not a sibling variant', () => {
    expect(ownsRootSheet(uuid, uuid)).toBe(true)
    expect(ownsRootSheet(uuid, 'e63e39d7-6ac0-4ffd-8aa3-1841a4541b55')).toBe(false)
  })

  test('is case-insensitive, as uuids are', () => {
    expect(ownsRootSheet(uuid.toUpperCase(), uuid)).toBe(true)
  })

  test('a project with no recorded root owns nothing', () => {
    expect(ownsRootSheet(null, uuid)).toBe(false)
  })
})
