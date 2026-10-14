import { describe, expect, test, vi } from 'vitest'
import { ercLibraryContext } from '../ercLibraries'
import { buildLibraryView, type IndexLibrary, type IndexRecord } from '../../libraryIndex'
import { createLibraryFeed } from '../../libraryFeed'
import { libraryChecks } from '../libraryChecks'
import { parseKicadSchematic } from '../../kicad/schematic'
import type { SheetConnectivityInput } from '../connectivity'
import type { ErcContext } from '../ercContext'

const library = (
  type: IndexLibrary['type'],
  name: string,
  scope: IndexLibrary['scope'] = 'system',
  readable = true
): IndexLibrary => ({ type, name, file: `/lib/${name}`, scope, readable })
const record = (type: 'symbol' | 'footprint', id: string, file = '/lib/x'): IndexRecord =>
  ({
    type,
    id,
    name: id.split(':')[1],
    library: id.split(':')[0],
    scope: 'system',
    file
  }) as IndexRecord

describe('buildLibraryView', () => {
  test('holds each library the index found, by nickname, and its parts by name', () => {
    const view = buildLibraryView({
      libraries: [library('footprint', 'Capacitor_SMD'), library('footprint', 'Empty')],
      records: [record('footprint', 'Capacitor_SMD:C_0402')]
    })
    expect(view.footprints.get('Capacitor_SMD')?.items.get('C_0402')?.id).toBe(
      'Capacitor_SMD:C_0402'
    )
    // Found, and holding nothing: there, so a part it lacks is known absent.
    expect(view.footprints.get('Empty')?.items.size).toBe(0)
    expect(view.footprints.get('Gone')).toBeUndefined()
  })

  test("a project's library replaces the app's of the same nickname whole", () => {
    const system = buildLibraryView({
      libraries: [library('footprint', 'Parts'), library('footprint', 'Other')],
      records: [record('footprint', 'Parts:A'), record('footprint', 'Other:B')]
    })
    const view = buildLibraryView(
      {
        libraries: [library('footprint', 'Parts', 'project')],
        records: [{ ...record('footprint', 'Parts:C'), scope: 'project' } as IndexRecord]
      },
      system
    )
    expect([...(view.footprints.get('Parts')?.items.keys() ?? [])]).toEqual(['C'])
    expect(view.footprints.get('Other')?.items.has('B')).toBe(true)
    // The app's view is not touched by the project's.
    expect(system.footprints.get('Parts')?.items.has('A')).toBe(true)
  })

  test("a sheet's embedded copy of a symbol is not its library's", () => {
    const view = buildLibraryView({
      libraries: [library('symbol', 'Device')],
      records: [record('symbol', 'Device:R', '/p/root.kicad_sch')]
    })
    expect(view.symbols.get('Device')?.items.size).toBe(0)
  })
})

describe('ercLibraryContext', () => {
  test('answers from the libraries the index found and what each holds', () => {
    const context = ercLibraryContext(
      buildLibraryView({
        libraries: [
          library('symbol', 'Device'),
          library('footprint', 'Resistor_SMD'),
          library('footprint', 'Unread', 'global', false)
        ],
        records: [record('symbol', 'Device:R'), record('footprint', 'Resistor_SMD:R_0603')]
      })
    )
    expect(context.symbolLibrary?.('Device')).toBe('ok')
    expect(context.symbolLibrary?.('Gone')).toBe('missing')
    expect(context.hasSymbol?.('Device:R')).toBe(true)
    expect(context.hasSymbol?.('Device:C')).toBe(false)
    expect(context.hasSymbol?.('Gone:C')).toBeUndefined()
    expect(context.footprintLibrary?.('Resistor_SMD')).toBe('ok')
    expect(context.hasFootprint?.('Resistor_SMD', 'R_0603')).toBe(true)
    expect(context.hasFootprint?.('Resistor_SMD', 'R_0805')).toBe(false)
    // A library its table points at nothing for: unreadable, its parts unjudged.
    expect(context.footprintLibrary?.('Unread')).toBe('unreadable')
    expect(context.hasFootprint?.('Unread', 'X')).toBeUndefined()
  })
})

describe("ERC's library feed", () => {
  const ROOT = 'aaaaaaaa-0000-0000-0000-000000000000'
  const SHEET = `(kicad_sch (version 20231120) (generator "test") (uuid "${ROOT}")
    (lib_symbols (symbol "demo:U" (symbol "U_1_1")))
    (symbol (lib_id "demo:U") (at 50 50 0) (unit 1) (uuid "u1-uuid")
      (property "Reference" "U1" (at 50 50 0))
      (property "Footprint" "demo:U_QFN" (at 50 50 0))))`
  const sheets: SheetConnectivityInput[] = [
    { sheetPath: `/${ROOT}`, namePath: '/', schematic: parseKicadSchematic(SHEET) }
  ]
  const before = buildLibraryView({ libraries: [], records: [] })
  const after = buildLibraryView({
    libraries: [library('symbol', 'demo', 'project'), library('footprint', 'demo', 'project')],
    records: [record('symbol', 'demo:U'), record('footprint', 'demo:U_QFN')]
  })

  test('a library registered after open stops the warnings once announced', async () => {
    vi.useFakeTimers()
    try {
      let view = before
      let context: ErcContext | undefined
      const feed = createLibraryFeed(
        async () => ercLibraryContext(view),
        (next) => (context = next),
        150
      )
      const codes = (): string[] =>
        libraryChecks(sheets, () => undefined, context ?? {}).map((r) => r.code)
      feed.refresh()
      await feed.ready()
      expect(codes()).toEqual(['symbol-library-issue', 'footprint-link-issue'])

      // symbol_create / footprint_create write and register the library, then announce it.
      view = after
      feed.refreshSoon()
      feed.refreshSoon()
      // A check asked in the quiet spell waits for the read rather than answering stale.
      const ready = feed.ready()
      expect(codes()).toHaveLength(2)
      await vi.advanceTimersByTimeAsync(150)
      await ready
      expect(codes()).toEqual([])
      feed.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})
