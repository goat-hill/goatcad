/**
 * A design's own copy of a part (`designCopy.ts`): a sheet's embedded symbol
 * as a one-symbol library, written back in place, and the session that runs
 * the symbol editor over it with the sheet's undo.
 */
import { describe, expect, test } from 'vitest'
import {
  parseKicadSchematic,
  serializeKicadSchematic,
  type SchematicProperty
} from '../kicad/schematic'
import {
  parseKicadSymbolLibrary,
  serializeKicadSymbolLibrary,
  type KicadSymbolLibrary
} from '../kicad/symbolLibrary'
import { findChild, getAtomValues } from '../kicad/sexpr'
import {
  createDesignCopySession,
  designCopyPath,
  parseDesignCopyPath,
  projectSymbolCopy,
  sameDesignCopy,
  writeSymbolCopy,
  type DesignCopyHost
} from '../designCopy'

const SHEET = `(kicad_sch (version 20250114) (generator "eeschema") (uuid "00000000-0000-0000-0000-000000000001") (paper "A4")
  (lib_symbols
    (symbol "Device:R" (pin_numbers (hide yes)) (exclude_from_sim no) (in_bom yes) (on_board yes)
      (property "Reference" "R" (at 2 0 90) (effects (font (size 1.27 1.27))))
      (property "Value" "R" (at 0 0 90) (effects (font (size 1.27 1.27))))
      (symbol "R_0_1" (rectangle (start -1 -2.5) (end 1 2.5) (stroke (width 0.25) (type default)) (fill (type none))))
      (symbol "R_1_1"
        (pin passive line (at 0 3.81 270) (length 1.27) (name "~" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))
        (pin passive line (at 0 -3.81 90) (length 1.27) (name "~" (effects (font (size 1.27 1.27)))) (number "2" (effects (font (size 1.27 1.27))))))))
  (symbol (lib_id "Device:R") (at 100 50 90) (unit 1) (in_bom yes) (on_board yes) (dnp no) (uuid "s1")
    (property "Reference" "R1" (at 102 50 90) (effects (font (size 1.27 1.27))))
    (property "Value" "10k" (at 98 50 90) (effects (font (size 1.27 1.27))))
    (property "MPN" "RC0603" (at 100 50 0) (hide yes) (effects (font (size 1.27 1.27))))
    (pin "1" (uuid "p1")) (pin "2" (uuid "p2"))
    (instances (project "p" (path "/00000000-0000-0000-0000-000000000001" (reference "R7") (unit 1)))))
  (sheet_instances (path "/" (page "1"))))`

const PLACEMENT = { uuid: 's1', sheetPath: '/00000000-0000-0000-0000-000000000001' }

const symbolValue = (library: KicadSymbolLibrary): string | undefined => {
  const node = library.symbols.get('Device:R')?._node
  const value = node?.children.find(
    (child) => child.type === 'list' && getAtomValues(child)[0] === 'Value'
  )
  return value?.type === 'list' ? getAtomValues(value)[1] : undefined
}

describe('design copy paths', () => {
  test('round-trip the kind, the design file and the id', () => {
    const path = designCopyPath('symbol', '/p/usb sheet.kicad_sch', 'Device:R')
    expect(parseDesignCopyPath(path)).toEqual({
      kind: 'symbol',
      parent: '/p/usb sheet.kicad_sch',
      id: 'Device:R'
    })
    expect(parseDesignCopyPath('/p/usb.kicad_sch')).toBeNull()
  })

  test('name one copy whichever placement opened it', () => {
    const one = designCopyPath('symbol', '/p/a.kicad_sch', 'Device:R', PLACEMENT)
    const other = designCopyPath('symbol', '/p/a.kicad_sch', 'Device:R', {
      ...PLACEMENT,
      uuid: 's2'
    })
    expect(sameDesignCopy(one, other)).toBe(true)
    expect(sameDesignCopy(one, designCopyPath('symbol', '/p/a.kicad_sch', 'Device:C'))).toBe(false)
    expect(sameDesignCopy(one, designCopyPath('symbol', '/p/b.kicad_sch', 'Device:R'))).toBe(false)
    expect(sameDesignCopy(one, '/p/a.kicad_sch')).toBe(false)
  })
})

describe('a sheet’s symbol copy', () => {
  test('opens as a one-symbol library and writes back in place, keeping its name', () => {
    const sheet = parseKicadSchematic(SHEET)
    const text = projectSymbolCopy(sheet, 'Device:R')!
    const library = parseKicadSymbolLibrary(text)
    expect(library.names).toEqual(['Device:R'])
    expect(projectSymbolCopy(sheet, 'Device:C')).toBeNull()

    const edited = serializeKicadSymbolLibrary(library)
      .replace('(property "Value" "R"', '(property "Value" "R_edited"')
      .replace('(symbol "Device:R"', '(symbol "Renamed"')
    expect(writeSymbolCopy(sheet, 'Device:R', edited)).toBe(true)
    const after = parseKicadSchematic(serializeKicadSchematic(sheet))
    const copy = after.libSymbols.get('Device:R')
    expect(copy).toBeDefined()
    expect(after.libSymbols.has('Renamed')).toBe(false)
    expect(symbolValue(parseKicadSymbolLibrary(projectSymbolCopy(after, 'Device:R')!))).toBe(
      'R_edited'
    )
    expect(findChild(copy!._node, 'pin_numbers')).not.toBeNull()
  })
})

describe('the design copy session', () => {
  /** A host over one sheet held as text, with a text-snapshot undo like a sheet session's. */
  const hostOver = (initial: string): DesignCopyHost & { text: () => string; writes: string[] } => {
    let text = initial
    const past: string[] = []
    const future: string[] = []
    const listeners = new Set<() => void>()
    const notify = (): void => listeners.forEach((listener) => listener())
    const writes: string[] = []
    return {
      text: () => text,
      writes,
      read: () => projectSymbolCopy(parseKicadSchematic(text), 'Device:R'),
      write: (label, copy) => {
        const sheet = parseKicadSchematic(text)
        if (!writeSymbolCopy(sheet, 'Device:R', copy)) return false
        past.push(text)
        future.length = 0
        text = serializeKicadSchematic(sheet)
        writes.push(label)
        notify()
        return true
      },
      undo: () => {
        const before = past.pop()
        if (before === undefined) return false
        future.push(text)
        text = before
        notify()
        return true
      },
      redo: () => {
        const after = future.pop()
        if (after === undefined) return false
        past.push(text)
        text = after
        notify()
        return true
      },
      mark: () => past.length,
      rollback: (mark) => {
        if (past.length <= mark) return
        text = past[mark]
        past.length = mark
        future.length = 0
        notify()
      },
      canUndo: () => past.length > 0,
      canRedo: () => future.length > 0,
      undoLabel: () => null,
      redoLabel: () => null,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      readOnly: () => false
    }
  }

  test('a command lands in the sheet as one step, and undo is the sheet’s', () => {
    const host = hostOver(SHEET)
    const texts: string[] = []
    const session = createDesignCopySession<KicadSymbolLibrary, never>({
      host,
      parse: parseKicadSymbolLibrary,
      serialize: serializeKicadSymbolLibrary,
      onText: (text) => texts.push(text)
    })
    expect(session.model()?.names).toEqual(['Device:R'])
    const revision = session.revision()
    const ran = session.runCommand('Edit value', (library) => {
      const node = library.symbols.get('Device:R')!._node
      const value = node.children.find(
        (child) => child.type === 'list' && getAtomValues(child)[0] === 'Value'
      )
      if (value?.type === 'list' && value.children[2]?.type === 'atom')
        value.children[2].value = '10k'
    })
    expect(ran).toBe(true)
    expect(host.writes).toEqual(['Edit value'])
    expect(session.revision()).toBeGreaterThan(revision)
    expect(symbolValue(session.model()!)).toBe('10k')
    expect(host.text()).toContain('"10k"')
    expect(texts.at(-1)).toContain('"10k"')

    expect(session.canUndo()).toBe(true)
    expect(session.undo()).not.toBeNull()
    expect(symbolValue(session.model()!)).toBe('R')
    expect(session.redo()).not.toBeNull()
    expect(symbolValue(session.model()!)).toBe('10k')
    // A command that changes nothing writes nothing.
    expect(session.runCommand('Nothing', () => {})).toBe(false)
    expect(host.writes).toHaveLength(1)
    session.dispose()
  })

  test('the design dropping the part is heard once, for the tab to close', () => {
    const host = hostOver(SHEET)
    let missing = 0
    let dropped = false
    const session = createDesignCopySession<KicadSymbolLibrary, never>({
      host: { ...host, read: () => (dropped ? null : host.read()) },
      parse: parseKicadSymbolLibrary,
      serialize: serializeKicadSymbolLibrary,
      onMissing: () => missing++
    })
    session.sync()
    expect(missing).toBe(0)
    dropped = true
    session.sync()
    session.sync()
    expect(missing).toBe(1)
    expect(session.parseError()).toBe('missing')
    session.dispose()
  })
})

describe('a symbol copy opened from a placement', () => {
  const fieldOf = (library: KicadSymbolLibrary, key: string): string | undefined => {
    const node = library.symbols.get('Device:R')?._node
    const field = node?.children.find(
      (child) => child.type === 'list' && getAtomValues(child)[0] === key
    )
    return field?.type === 'list' ? getAtomValues(field)[1] : undefined
  }
  const placedField = (text: string, key: string): SchematicProperty =>
    parseKicadSchematic(text).symbols[0].properties.find((p) => p.key === key)!

  test('shows the placement’s fields, its own reference included', () => {
    const library = parseKicadSymbolLibrary(
      projectSymbolCopy(parseKicadSchematic(SHEET), 'Device:R', PLACEMENT)!
    )
    expect(fieldOf(library, 'Reference')).toBe('R7')
    expect(fieldOf(library, 'Value')).toBe('10k')
    expect(fieldOf(library, 'MPN')).toBe('RC0603')
  })

  test('an unedited write changes neither the placement nor the copy', () => {
    const sheet = parseKicadSchematic(SHEET)
    const before = serializeKicadSchematic(sheet)
    const text = projectSymbolCopy(sheet, 'Device:R', PLACEMENT)!
    expect(writeSymbolCopy(sheet, 'Device:R', text, PLACEMENT)).toBe(true)
    const after = serializeKicadSchematic(sheet)
    expect(placedField(after, 'Value').position).toEqual(placedField(before, 'Value').position)
    expect(placedField(after, 'Reference').position).toEqual(
      placedField(before, 'Reference').position
    )
    // The copy keeps its own default value.
    expect(
      getAtomValues(
        parseKicadSchematic(after)
          .libSymbols.get('Device:R')!
          ._node.children.find((c) => c.type === 'list' && getAtomValues(c)[0] === 'Value') as never
      )[1]
    ).toBe('R')
  })

  test('a field moved in the copy moves on the sheet, turned as the placement is', () => {
    const sheet = parseKicadSchematic(SHEET)
    const before = placedField(serializeKicadSchematic(sheet), 'Value').position
    const text = projectSymbolCopy(sheet, 'Device:R', PLACEMENT)!
    const library = parseKicadSymbolLibrary(text)
    const value = library.symbols.get('Device:R')!.properties.find((p) => p.key === 'Value')!
    // One millimetre along the symbol's own x: the placement is turned 90°, so up the sheet.
    const at = value._node.children.find(
      (c) =>
        c.type === 'list' &&
        getAtomValues(c).length >= 2 &&
        c.children[0]?.type === 'atom' &&
        c.children[0].value === 'at'
    )
    if (at?.type === 'list' && at.children[1]?.type === 'atom')
      at.children[1].value = String(Number(at.children[1].value) + 1)
    if (at?.type === 'list') {
      const vAtom = value._node.children[2]
      if (vAtom?.type === 'atom') vAtom.value = '22k'
    }
    expect(
      writeSymbolCopy(sheet, 'Device:R', serializeKicadSymbolLibrary(library), PLACEMENT)
    ).toBe(true)
    const after = placedField(serializeKicadSchematic(sheet), 'Value')
    expect(after.value).toBe('22k')
    expect(after.position.x).toBe(before.x)
    expect(after.position.y).toBe(before.y - 1_000_000)
  })
})
