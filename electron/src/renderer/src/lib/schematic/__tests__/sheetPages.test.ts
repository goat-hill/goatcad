import { describe, expect, test } from 'vitest'
import { parseKicadSchematic, serializeKicadSchematic } from '../../kicad/schematic'
import {
  comparePages,
  inPageOrder,
  nextFreePage,
  pageAllocator,
  pageOfInstance,
  pagesOf,
  setRootPage,
  setSheetPage,
  sheetPageOf,
  type PagedSource
} from '../sheetPages'

/** A sheet with a root page (when given) and (uuid, page) child sheets filed under `parentPath`. */
const sheetDoc = (
  uuid: string,
  parentPath: string,
  children: Array<{ uuid: string; page: string; x?: number }>,
  rootPage?: string
): string => `(kicad_sch
  (version 20231120)
  (uuid "${uuid}")
${children
  .map(
    (child) => `  (sheet (at ${child.x ?? 0} 0) (size 10 10) (uuid "${child.uuid}")
    (property "Sheetname" "${child.uuid}" (at 0 0 0))
    (property "Sheetfile" "${child.uuid}.kicad_sch" (at 0 0 0))
    (instances (project "demo" (path "${parentPath}" (page "${child.page}")))))`
  )
  .join('\n')}
${rootPage ? `  (sheet_instances (path "/" (page "${rootPage}")))` : ''}
)`

describe('comparePages', () => {
  test('numbers compare numerically', () => {
    expect(['10', '2', '1'].sort(comparePages)).toEqual(['1', '2', '10'])
  })

  test('text pages compare as text, after every number', () => {
    expect(['B', 'A10', '3', 'A2', '12'].sort(comparePages)).toEqual(['3', '12', 'A2', 'A10', 'B'])
  })

  test('a page the file does not give sorts as empty text', () => {
    expect(comparePages(undefined, '2')).toBeGreaterThan(0)
    expect(comparePages(undefined, 'A')).toBeLessThan(0)
    expect(comparePages(undefined, undefined)).toBe(0)
  })
})

describe('nextFreePage', () => {
  test('is the lowest positive number no page uses', () => {
    expect(nextFreePage([])).toBe('1')
    expect(nextFreePage(['1', '2', '3'])).toBe('4')
    expect(nextFreePage(['1', '2', '5', '6'])).toBe('3')
    expect(nextFreePage(['2', '3'])).toBe('1')
  })

  test('text and non-positive pages take nothing', () => {
    expect(nextFreePage(['1', 'A', '0', '-2', undefined, '2'])).toBe('3')
  })

  test('an allocator takes each page before finding the next', () => {
    const next = pageAllocator(['1', '3'])
    expect([next(), next(), next()]).toEqual(['2', '4', '5'])
  })
})

describe('reading pages', () => {
  // Root (page 1) holds A (page 2) and B (page 4); A holds C (page 3).
  const root = parseKicadSchematic(
    sheetDoc(
      'root',
      '/root',
      [
        { uuid: 'a', page: '2' },
        { uuid: 'b', page: '4' }
      ],
      '1'
    )
  )
  const a = parseKicadSchematic(sheetDoc('a-file', '/root/a', [{ uuid: 'c', page: '3' }]))
  const leaf = parseKicadSchematic(sheetDoc('leaf', '', []))
  const sources: PagedSource[] = [
    { schematic: root, sheetPath: '/root' },
    { schematic: a, sheetPath: '/root/a' },
    { schematic: leaf, sheetPath: '/root/a/c' },
    { schematic: leaf, sheetPath: '/root/b' }
  ]

  test('an instance reads its page off the root or its parent', () => {
    expect(sources.map((source) => pageOfInstance(sources, source.sheetPath))).toEqual([
      '1',
      '2',
      '3',
      '4'
    ])
  })

  test('the design sorts by page, not by hierarchy', () => {
    expect(inPageOrder(sources).map((source) => source.sheetPath)).toEqual([
      '/root',
      '/root/a',
      '/root/a/c',
      '/root/b'
    ])
    const flipped = [sources[0], sources[3], sources[1], sources[2]]
    expect(inPageOrder(flipped).map((source) => source.sheetPath)).toEqual([
      '/root',
      '/root/a',
      '/root/a/c',
      '/root/b'
    ])
  })

  test('a sheet made in a subsheet takes a page the design leaves free', () => {
    // The old rule, sheets on this sheet + 2, gave C's sheet page 2 — A's.
    expect(pagesOf(sources).sort(comparePages)).toEqual(['1', '2', '3', '4'])
    expect(nextFreePage(pagesOf(sources))).toBe('5')
  })

  test('a child whose file is missing still holds its page', () => {
    expect(nextFreePage(pagesOf([{ schematic: root, sheetPath: '/root' }]))).toBe('3')
  })
})

describe('setSheetPage', () => {
  /** A root file, as KiCad 10 writes it, holding one sheet with the given instances block. */
  const fileWith = (instances: string): string => `(kicad_sch
\t(version 20250114)
\t(generator "eeschema")
\t(uuid "root")
\t(paper "A4")
\t(lib_symbols)
\t(sheet
\t\t(at 10 10)
\t\t(size 20 10)
\t\t(uuid "s1")
\t\t(property "Sheetname" "Power"
\t\t\t(at 10 9 0)
\t\t)
\t\t(property "Sheetfile" "power.kicad_sch"
\t\t\t(at 10 21 0)
\t\t)${instances}
\t)
\t(sheet_instances
\t\t(path "/"
\t\t\t(page "1")
\t\t)
\t)
)
`
  const edit = (instances: string, parentPath: string, page: string): string => {
    const doc = parseKicadSchematic(fileWith(instances))
    setSheetPage(doc.sheets[0], parentPath, page, 'demo')
    return serializeKicadSchematic(doc)
  }
  const both = `
\t\t(instances
\t\t\t(project "other"
\t\t\t\t(path "/elsewhere"
\t\t\t\t\t(page "7")
\t\t\t\t)
\t\t\t)
\t\t\t(project "demo"
\t\t\t\t(path "/root"
\t\t\t\t\t(page "2")
\t\t\t\t)
\t\t\t)
\t\t)`

  test('the file round-trips unedited', () => {
    expect(serializeKicadSchematic(parseKicadSchematic(fileWith(both)))).toBe(fileWith(both))
  })

  test("an existing path's page is the only atom that changes", () => {
    expect(edit(both, '/root', 'A 1')).toBe(fileWith(both.replace('(page "2")', '(page "A 1")')))
  })

  test('an empty page is written as KiCad writes it', () => {
    const out = parseKicadSchematic(edit(both, '/root', ''))
    expect(sheetPageOf(out.sheets[0], '/root')).toBe('')
    expect(sheetPageOf(out.sheets[0], '/elsewhere')).toBe('7')
  })

  test('a path without a page gains one, after the path', () => {
    const bare = both.replace(
      `(path "/root"
\t\t\t\t\t(page "2")
\t\t\t\t)`,
      '(path "/root")'
    )
    expect(edit(bare, '/root', '5')).toBe(fileWith(both.replace('(page "2")', '(page "5")')))
  })

  test("a missing path is filed under the design's project; the other project is untouched", () => {
    const out = edit(both, '/root/p', '9')
    const doc = parseKicadSchematic(out)
    expect(sheetPageOf(doc.sheets[0], '/root/p')).toBe('9')
    expect(sheetPageOf(doc.sheets[0], '/root')).toBe('2')
    expect(sheetPageOf(doc.sheets[0], '/elsewhere')).toBe('7')
    expect(out).toContain(`(project "other"
\t\t\t\t(path "/elsewhere"
\t\t\t\t\t(page "7")
\t\t\t\t)
\t\t\t)
\t\t\t(project "demo"
\t\t\t\t(path "/root"
\t\t\t\t\t(page "2")
\t\t\t\t)
\t\t\t\t(path "/root/p"
\t\t\t\t\t(page "9")
\t\t\t\t)
\t\t\t)`)
  })

  test('a design with no entry yet gets its own project block', () => {
    const only = both.replace(
      `
\t\t\t(project "demo"
\t\t\t\t(path "/root"
\t\t\t\t\t(page "2")
\t\t\t\t)
\t\t\t)`,
      ''
    )
    const out = edit(only, '/root', '3')
    expect(out).toBe(fileWith(both.replace('(page "2")', '(page "3")')))
  })

  test('a sheet with no instances gets them last, as KiCad writes them', () => {
    const out = edit('', '/root', '2')
    expect(out).toBe(
      fileWith(`
\t\t(instances
\t\t\t(project "demo"
\t\t\t\t(path "/root"
\t\t\t\t\t(page "2")
\t\t\t\t)
\t\t\t)
\t\t)`)
    )
  })
})

describe('setRootPage', () => {
  const canonical = (text: string): string => serializeKicadSchematic(parseKicadSchematic(text))
  const written = (source: string, page: string): string => {
    const schematic = parseKicadSchematic(source)
    setRootPage(schematic, page)
    return serializeKicadSchematic(schematic)
  }

  test('rewrites the page of the root path only', () => {
    const source = sheetDoc('root', '/root', [{ uuid: 'a', page: '2' }], '1')
    expect(written(source, '7')).toBe(
      canonical(source.replace('(path "/" (page "1"))', '(path "/" (page "7"))'))
    )
  })

  test('adds the root path, or sheet_instances before embedded_fonts, when missing', () => {
    const bare = sheetDoc('root', '/root', [])
    expect(written(bare, '1')).toBe(
      canonical(bare.replace(/\)$/, '(sheet_instances (path "/" (page "1"))))'))
    )
    const fonts = bare.replace(/\)$/, '(embedded_fonts no))')
    expect(written(fonts, '1')).toBe(
      canonical(bare.replace(/\)$/, '(sheet_instances (path "/" (page "1"))) (embedded_fonts no))'))
    )
    const pageless = `${bare.slice(0, -1)}(sheet_instances (path "/")))`
    expect(written(pageless, '3')).toBe(
      canonical(bare.replace(/\)$/, '(sheet_instances (path "/" (page "3"))))'))
    )
  })
})
