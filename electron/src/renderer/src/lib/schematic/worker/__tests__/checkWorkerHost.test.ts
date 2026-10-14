import { describe, expect, test } from 'vitest'
import { CheckWorkerHost } from '../checkWorkerHost'
import type { CheckRequest } from '../protocol'
import { mmToNm } from '../../../kicad/coordinates'
import { KICAD10_PIN_MAP } from '../../../kicad/projectDefaults'

/** A sheet with one wire left hanging: one finding at each open end. */
const sheet = (uuid: string, x: number): string => `(kicad_sch
  (version 20231120)
  (generator "eeschema")
  (uuid "${uuid}")
  (paper "A4")
  (wire (pts (xy ${x} 50.8) (xy ${x + 12.7} 50.8)) (uuid "${uuid}-w"))
)`

const request = (file: string, uuid: string): CheckRequest => ({
  instances: [{ file, sheetPath: `/${uuid}`, namePath: '/' }],
  naming: {},
  grid: mmToNm(1.27),
  pinMap: KICAD10_PIN_MAP
})

describe('CheckWorkerHost', () => {
  test("a newer request replaces the asker's waiting one, never another asker's", async () => {
    const host = new CheckWorkerHost(true)
    const a = '/a.kicad_sch'
    const b = '/b.kicad_sch'
    const first = host.run('a', request(a, 'ua'), new Map([[a, sheet('ua', 25.4)]]))
    const waitingA = host.run('a', request(a, 'ua'), new Map([[a, sheet('ua', 25.4)]]))
    const waitingB = host.run('b', request(b, 'ub'), new Map([[b, sheet('ub', 50.8)]]))
    const newerA = host.run('a', request(a, 'ua'), new Map([[a, sheet('ua', 76.2)]]))
    // The first was already running; the replaced one answers null.
    expect((await first)?.length).toBeGreaterThan(0)
    expect(await waitingA).toBeNull()
    expect((await waitingB)?.every((result) => result.sheetPath === '/ub')).toBe(true)
    const newer = await newerA
    expect(newer?.some((result) => result.position?.x === 76.2)).toBe(true)
  })
})
