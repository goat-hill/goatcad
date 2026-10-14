import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { resolveForest, resolveHierarchy, sheetStructureKey, type HierarchyFs } from '../hierarchy'
import { parseKicadSchematic, serializeKicadSchematic } from '../../kicad/schematic'
import { setSheetPage } from '../sheetPages'
import { buildProjectComponentRecords, type SheetSource } from '../../componentsTable'
import { CANARY_SCHEMATIC } from '../../__tests__/canaryFixture'

/** A .kicad_sch with the given root uuid and (uuid, sheetname, file) children. */
const sheetDoc = (
  uuid: string,
  sheets: Array<{ uuid: string; name: string; file: string }>
): string => `(kicad_sch
  (version 20231120)
  (uuid "${uuid}")
${sheets
  .map(
    (sheet) => `  (sheet (at 0 0) (size 10 10) (uuid "${sheet.uuid}")
    (property "Sheetname" "${sheet.name}" (at 0 0 0))
    (property "Sheetfile" "${sheet.file}" (at 0 0 0)))`
  )
  .join('\n')}
)`

const makeFs = (files: Record<string, string>): HierarchyFs => ({
  async readFile(path) {
    return files[path] ?? null
  },
  async listSchematics(dir) {
    return Object.keys(files).filter(
      (path) => path.slice(0, path.lastIndexOf('/')) === dir && path.endsWith('.kicad_sch')
    )
  }
})

describe('resolveHierarchy', () => {
  test('walks the tree and appends sheet-node uuids to the path', async () => {
    const fs = makeFs({
      '/p/canary.kicad_sch': sheetDoc('root-uuid', [
        { uuid: 'sheet-usb', name: 'USB', file: 'usb.kicad_sch' }
      ]),
      '/p/usb.kicad_sch': sheetDoc('usb-uuid', [])
    })

    const tree = await resolveHierarchy(fs, '/p/canary.kicad_sch')
    expect(tree.rootFilePath).toBe('/p/canary.kicad_sch')
    expect(tree.instances).toEqual([
      {
        sheetPath: '/root-uuid',
        namePath: '/',
        sheetName: 'canary',
        filePath: '/p/canary.kicad_sch',
        depth: 0
      },
      {
        sheetPath: '/root-uuid/sheet-usb',
        namePath: '/USB',
        sheetName: 'USB',
        filePath: '/p/usb.kicad_sch',
        depth: 1
      }
    ])
  })

  test('discovers the root when opening a child sheet', async () => {
    const fs = makeFs({
      '/p/canary.kicad_sch': sheetDoc('root-uuid', [
        { uuid: 'sheet-usb', name: 'USB', file: 'usb.kicad_sch' }
      ]),
      '/p/usb.kicad_sch': sheetDoc('usb-uuid', [])
    })

    const tree = await resolveHierarchy(fs, '/p/usb.kicad_sch')
    expect(tree.rootFilePath).toBe('/p/canary.kicad_sch')
    expect(tree.instances.map((i) => i.sheetPath)).toEqual(['/root-uuid', '/root-uuid/sheet-usb'])
  })

  test('a repeated child yields distinct instances but one file', async () => {
    const fs = makeFs({
      '/p/root.kicad_sch': sheetDoc('root-uuid', [
        { uuid: 'sheet-a', name: 'ChA', file: 'channel.kicad_sch' },
        { uuid: 'sheet-b', name: 'ChB', file: 'channel.kicad_sch' }
      ]),
      '/p/channel.kicad_sch': sheetDoc('chan-uuid', [])
    })

    const tree = await resolveHierarchy(fs, '/p/channel.kicad_sch')
    expect(tree.instances.map((i) => i.sheetPath)).toEqual([
      '/root-uuid',
      '/root-uuid/sheet-a',
      '/root-uuid/sheet-b'
    ])
    expect(tree.files).toEqual(['/p/root.kicad_sch', '/p/channel.kicad_sch'])
  })

  test('breaks file cycles instead of recursing forever', async () => {
    const fs = makeFs({
      '/p/a.kicad_sch': sheetDoc('a-uuid', [{ uuid: 's-b', name: 'B', file: 'b.kicad_sch' }]),
      '/p/b.kicad_sch': sheetDoc('b-uuid', [{ uuid: 's-a', name: 'A', file: 'a.kicad_sch' }])
    })

    const tree = await resolveHierarchy(fs, '/p/a.kicad_sch')
    // a → b, and b's back-reference to a is pruned.
    expect(tree.instances.map((i) => i.filePath)).toEqual(['/p/a.kicad_sch', '/p/b.kicad_sch'])
  })

  test('an unrelated standalone schematic is its own root', async () => {
    const fs = makeFs({
      '/p/canary.kicad_sch': sheetDoc('root-uuid', [
        { uuid: 'sheet-usb', name: 'USB', file: 'usb.kicad_sch' }
      ]),
      '/p/usb.kicad_sch': sheetDoc('usb-uuid', []),
      '/p/scratch.kicad_sch': sheetDoc('scratch-uuid', [])
    })

    const tree = await resolveHierarchy(fs, '/p/scratch.kicad_sch')
    expect(tree.rootFilePath).toBe('/p/scratch.kicad_sch')
    expect(tree.instances).toHaveLength(1)
  })
})

describe('resolveForest', () => {
  test('returns one tree per independent root, sorted by name', async () => {
    const fs = makeFs({
      // Board A: alpha → child_a
      '/p/alpha.kicad_sch': sheetDoc('alpha-uuid', [
        { uuid: 's-a', name: 'ChildA', file: 'child_a.kicad_sch' }
      ]),
      '/p/child_a.kicad_sch': sheetDoc('childa-uuid', []),
      // Board B: standalone, no children
      '/p/beta.kicad_sch': sheetDoc('beta-uuid', [])
    })

    const forest = await resolveForest(fs, [
      '/p/alpha.kicad_sch',
      '/p/child_a.kicad_sch',
      '/p/beta.kicad_sch'
    ])
    // Two roots (alpha, beta); child_a is referenced so it is not a root.
    expect(forest.map((tree) => tree.rootFilePath)).toEqual([
      '/p/alpha.kicad_sch',
      '/p/beta.kicad_sch'
    ])
    expect(forest[0].instances.map((i) => i.filePath)).toEqual([
      '/p/alpha.kicad_sch',
      '/p/child_a.kicad_sch'
    ])
    expect(forest[1].instances).toHaveLength(1)
  })
})

// Behaviors originally verified against a real multi-sheet KiCad project:
// title-block root naming, and the comprehensive components table resolving
// per-path instance references (including a repeated sheet). Captured here as
// a synthetic in-memory project so the suite is self-contained.
describe('project component records across a hierarchy', () => {
  const rootDoc = `(kicad_sch
    (version 20231120)
    (uuid "root-uuid")
    (title_block (title "Canary"))
    (sheet (at 0 0) (size 10 10) (uuid "sheet-usb")
      (property "Sheetname" "USB" (at 0 0 0))
      (property "Sheetfile" "usb.kicad_sch" (at 0 0 0)))
    (sheet (at 20 0) (size 10 10) (uuid "sheet-cha")
      (property "Sheetname" "ChA" (at 0 0 0))
      (property "Sheetfile" "channel.kicad_sch" (at 0 0 0)))
    (sheet (at 40 0) (size 10 10) (uuid "sheet-chb")
      (property "Sheetname" "ChB" (at 0 0 0))
      (property "Sheetfile" "channel.kicad_sch" (at 0 0 0)))
  )`

  const usbDoc = `(kicad_sch
    (version 20231120)
    (uuid "usb-uuid")
    (symbol (lib_id "Device:R") (at 10 10 0) (unit 1) (uuid "r8-uuid")
      (property "Reference" "R8" (at 10 10 0))
      (property "Value" "22" (at 10 12 0))
      (instances (project "canary"
        (path "/root-uuid/sheet-usb" (reference "R8") (unit 1)))))
  )`

  // One drawn resistor, referenced differently per channel instance.
  const channelDoc = `(kicad_sch
    (version 20231120)
    (uuid "chan-uuid")
    (symbol (lib_id "Device:R") (at 10 10 0) (unit 1) (uuid "rch-uuid")
      (property "Reference" "R5" (at 10 10 0))
      (property "Value" "1k" (at 10 12 0))
      (instances (project "canary"
        (path "/root-uuid/sheet-cha" (reference "R5") (unit 1))
        (path "/root-uuid/sheet-chb" (reference "R9") (unit 1)))))
  )`

  const files: Record<string, string> = {
    '/p/canary.kicad_sch': rootDoc,
    '/p/usb.kicad_sch': usbDoc,
    '/p/channel.kicad_sch': channelDoc
  }
  const fs = makeFs(files)

  const sourcesFor = async (openFile: string): Promise<SheetSource[]> => {
    const tree = await resolveHierarchy(fs, openFile)
    return tree.instances.map((instance) => ({
      schematic: parseKicadSchematic(files[instance.filePath]),
      sheetPath: instance.sheetPath,
      sheetName: instance.namePath,
      filePath: instance.filePath
    }))
  }

  test('the root shows its title-block title, not the file stem', async () => {
    const tree = await resolveHierarchy(fs, '/p/usb.kicad_sch')
    expect(tree.rootFilePath).toBe('/p/canary.kicad_sch')
    expect(tree.instances[0]).toMatchObject({ depth: 0, sheetName: 'Canary' })
  })

  test('builds a comprehensive table with per-sheet references', async () => {
    const fromRoot = buildProjectComponentRecords(await sourcesFor('/p/canary.kicad_sch'))
    const fromChild = buildProjectComponentRecords(await sourcesFor('/p/usb.kicad_sch'))

    // Same comprehensive set whether you open the parent or a child.
    expect(fromChild.length).toBe(fromRoot.length)

    // R8 lives on the USB sub-sheet and resolves its per-path reference there.
    const r8 = fromRoot.find((record) => record.reference === 'R8')
    expect(r8).toBeDefined()
    expect(r8!.sheetName).toBe('/USB')
    expect(r8!.filePath).toBe('/p/usb.kicad_sch')

    // The repeated channel sheet yields one record per instance, with the
    // per-path reference resolved for each (draw once, stamp twice).
    const channelRefs = fromRoot
      .filter((record) => record.filePath === '/p/channel.kicad_sch')
      .map((record) => `${record.reference}@${record.sheetName}`)
      .sort()
    expect(channelRefs).toEqual(['R5@/ChA', 'R9@/ChB'])
  })
})

/** A root whose children sit at the given x and list the given page (none when omitted). */
const pagedRoot = (
  children: Array<{ uuid: string; x: number; page?: string }>
): string => `(kicad_sch
  (version 20231120)
  (uuid "root-uuid")
${children
  .map(
    (child) => `  (sheet (at ${child.x} 0) (size 10 10) (uuid "${child.uuid}")
    (property "Sheetname" "${child.uuid.toUpperCase()}" (at 0 0 0))
    (property "Sheetfile" "${child.uuid}.kicad_sch" (at 0 0 0))
    ${child.page ? `(instances (project "demo" (path "/root-uuid" (page "${child.page}"))))` : ''})`
  )
  .join('\n')}
  (sheet_instances (path "/" (page "1")))
)`

describe('sheet order', () => {
  const leaves = (names: string[]): Record<string, string> =>
    Object.fromEntries(names.map((name) => [`/p/${name}.kicad_sch`, sheetDoc(`${name}-file`, [])]))

  test('siblings follow their pages, and each instance carries its page', async () => {
    const fs = makeFs({
      '/p/root.kicad_sch': pagedRoot([
        { uuid: 'c', x: 0, page: '4' },
        { uuid: 'a', x: 20, page: '2' },
        { uuid: 'b', x: 10, page: '3' }
      ]),
      ...leaves(['a', 'b', 'c'])
    })
    const tree = await resolveHierarchy(fs, '/p/root.kicad_sch')
    expect(tree.instances.map((i) => [i.sheetName, i.page])).toEqual([
      ['root', '1'],
      ['A', '2'],
      ['B', '3'],
      ['C', '4']
    ])
  })

  test('page ties fall back to position, x before y', async () => {
    const fs = makeFs({
      '/p/root.kicad_sch': pagedRoot([
        { uuid: 'late', x: 30, page: '2' },
        { uuid: 'early', x: 10, page: '2' },
        { uuid: 'unpaged', x: 0 }
      ]),
      ...leaves(['late', 'early', 'unpaged'])
    })
    const tree = await resolveHierarchy(fs, '/p/root.kicad_sch')
    // A sheet with no page reads as empty text: after every number.
    expect(tree.instances.map((i) => i.sheetName)).toEqual(['root', 'EARLY', 'LATE', 'UNPAGED'])
  })

  test('text pages sort as text, after numbers', async () => {
    const fs = makeFs({
      '/p/root.kicad_sch': pagedRoot([
        { uuid: 'b', x: 0, page: 'B' },
        { uuid: 'a', x: 10, page: 'A' },
        { uuid: 'n', x: 20, page: '7' }
      ]),
      ...leaves(['a', 'b', 'n'])
    })
    const tree = await resolveHierarchy(fs, '/p/root.kicad_sch')
    expect(tree.instances.map((i) => i.page)).toEqual(['1', '7', 'A', 'B'])
  })

  const SAMPLE = CANARY_SCHEMATIC

  test('the sample lists its sheets by page, not by file order', async () => {
    const tree = await resolveHierarchy(
      {
        readFile: async (path) => (existsSync(path) ? readFileSync(path, 'utf8') : null),
        listSchematics: async (dir) =>
          readdirSync(dir)
            .filter((name) => name.endsWith('.kicad_sch'))
            .map((name) => join(dir, name))
      },
      SAMPLE
    )
    // The file holds USB, Display Port, Sensors; their pages are 4, 2, 3.
    expect(tree.instances.map((i) => [i.sheetName, i.page])).toEqual([
      [tree.instances[0].sheetName, '1'],
      ['Display Port', '2'],
      ['Sensors', '3'],
      ['USB', '4']
    ])
  })
})

describe('a renumbered sheet', () => {
  const root = pagedRoot([
    { uuid: 'a', x: 0, page: '2' },
    { uuid: 'b', x: 10, page: '3' }
  ])
  const files = (rootText: string): Record<string, string> => ({
    '/p/root.kicad_sch': rootText,
    '/p/a.kicad_sch': sheetDoc('a-file', []),
    '/p/b.kicad_sch': sheetDoc('b-file', [])
  })
  const renumbered = (): string => {
    const doc = parseKicadSchematic(root)
    setSheetPage(doc.sheets[0], '/root-uuid', '4', 'demo')
    return serializeKicadSchematic(doc)
  }

  test('moves in the tree once its page is edited', async () => {
    const before = await resolveHierarchy(makeFs(files(root)), '/p/root.kicad_sch')
    expect(before.instances.map((i) => i.sheetName)).toEqual(['root', 'A', 'B'])
    const after = await resolveHierarchy(makeFs(files(renumbered())), '/p/root.kicad_sch')
    expect(after.instances.map((i) => [i.sheetName, i.page])).toEqual([
      ['root', '1'],
      ['B', '3'],
      ['A', '4']
    ])
  })

  test('changes the structure key a view re-resolves on; other edits do not', () => {
    const key = sheetStructureKey(serializeKicadSchematic(parseKicadSchematic(root)))
    expect(sheetStructureKey(renumbered())).not.toBe(key)
    expect(sheetStructureKey(root.replace('(at 10 0)', '(at 12 0)'))).toBe(sheetStructureKey(root))
    expect(sheetStructureKey(root.replace('"A"', '"Alpha"'))).not.toBe(sheetStructureKey(root))
  })
})
