import { describe, expect, it } from 'vitest'
import { registry } from '../index'

const requestFor = (name: string, args: Record<string, unknown>): unknown =>
  registry.get(name)!.designRequest!(args)

describe('the export ops', () => {
  it('take a BOM column by field or by part number, never both or neither', () => {
    expect(requestFor('export.bom', { columns: [{ label: 'X' }] })).toMatchObject({
      ok: false,
      error: { code: 'invalid-args' }
    })
    expect(
      requestFor('export.bom', { columns: [{ label: 'X', field: 'Value', partNumber: 'MPN' }] })
    ).toMatchObject({ ok: false })
    expect(requestFor('export.bom', { columns: [{ label: 'Part', partNumber: 'LCSC' }] })).toEqual({
      ok: true,
      request: {
        kind: 'export-board',
        output: 'bom',
        bom: { columns: [{ label: 'Part', partNumber: 'LCSC' }] }
      }
    })
  })

  it("carry a package's profile and the formats that replace its own", () => {
    expect(
      requestFor('export.package', {
        profile: 'jlcpcb',
        gerber: { precision: 5 },
        archive: [],
        dryRun: true
      })
    ).toEqual({
      ok: true,
      request: {
        kind: 'export-board',
        output: 'package',
        profile: 'jlcpcb',
        gerber: { precision: 5 },
        archive: [],
        dryRun: true
      }
    })
  })

  it('bound the Gerber precision to the formats the writer has', () => {
    expect(requestFor('export.gerbers', { precision: 4 })).toMatchObject({ ok: false })
  })
})
