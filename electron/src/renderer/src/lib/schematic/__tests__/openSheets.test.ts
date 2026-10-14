import { describe, expect, test } from 'vitest'
import { openSheetAt, setOpenSheetSource } from '../openSheets'

const doc = (uuid: string): string =>
  `(kicad_sch (version 20231120) (uuid "${uuid}") (paper "A4") (lib_symbols))`

describe('the open-sheet registry', () => {
  test('answers from the tab store, and follows it as the text changes', () => {
    const tabs = new Map([['/p/main.kicad_sch', doc('first')]])
    const stop = setOpenSheetSource((path) => tabs.get(path) ?? null)
    expect(openSheetAt('/p/main.kicad_sch')?.uuid).toBe('first')
    // The whole point: an edit in a tab nobody is looking at has to be visible
    // to a cross-sheet check, or the check cannot be cleared.
    tabs.set('/p/main.kicad_sch', doc('second'))
    expect(openSheetAt('/p/main.kicad_sch')?.uuid).toBe('second')
    stop()
    expect(openSheetAt('/p/main.kicad_sch')).toBeNull()
  })

  test('a path no tab holds is null, so the caller can fall back to disk', () => {
    const stop = setOpenSheetSource(() => null)
    expect(openSheetAt('/p/absent.kicad_sch')).toBeNull()
    stop()
  })

  // Text that is not a schematic at all reads as absent rather than throwing,
  // so a cross-sheet reader falls back to disk instead of failing the check it
  // was in the middle of. (A truncated `(kicad_sch ...` still parses: the
  // reader is deliberately lenient and only rejects a wrong root token.)
  test('text that is not a schematic reads as absent', () => {
    const stop = setOpenSheetSource(() => 'nothing to see here')
    expect(openSheetAt('/p/broken.kicad_sch')).toBeNull()
    stop()
  })

  test('the parse is reused while the text is unchanged', () => {
    let reads = 0
    const stop = setOpenSheetSource(() => {
      reads += 1
      return doc('stable')
    })
    const first = openSheetAt('/p/main.kicad_sch')
    const second = openSheetAt('/p/main.kicad_sch')
    expect(first).toBe(second)
    expect(reads).toBe(2)
    stop()
  })
})
