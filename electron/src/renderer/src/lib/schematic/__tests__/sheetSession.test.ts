import { describe, expect, test } from 'vitest'
import { shallowRef } from 'vue'
import { createSheetSession, type SheetEdit } from '../sheetSession'
import type { HierarchyFs } from '../hierarchy'
import { mmToNm } from '../../kicad/coordinates'
import { dirnameOf } from '../../kicad/paths'
import {
  parseKicadSchematic,
  referenceForSheetPath,
  serializeKicadSchematic
} from '../../kicad/schematic'
import { DocumentStore, type DocumentHandle } from '../../document/documentStore'
import type { SymbolSources } from '../../symbol/symbolSources'
import { setSheetPage } from '../sheetPages'
import { screenSheetEdits } from '../schematicPropertySchema'

const LIB = `  (lib_symbols
    (symbol "Device:R"
      (property "Reference" "R" (at 0 0 0))
      (property "Value" "R" (at 0 0 0))
      (symbol "R_0_1"
        (rectangle (start -1.016 -2.54) (end 1.016 2.54)
          (stroke (width 0.254) (type default))
          (fill (type none))))
      (symbol "R_1_1"
        (pin passive line (at 0 3.81 270) (length 1.27)
          (name "~" (effects (font (size 1.27 1.27))))
          (number "1" (effects (font (size 1.27 1.27)))))
        (pin passive line (at 0 -3.81 90) (length 1.27)
          (name "~" (effects (font (size 1.27 1.27))))
          (number "2" (effects (font (size 1.27 1.27)))))))
  )`

/** The root: one resistor numbered R5, and a child sheet. */
const ROOT = `(kicad_sch
  (version 20231120)
  (generator "eeschema")
  (uuid "root-uuid")
  (paper "A4")
${LIB}
  (symbol
    (lib_id "Device:R")
    (at 50.8 54.61 0)
    (unit 1)
    (in_bom yes)
    (on_board yes)
    (dnp no)
    (uuid "root-r")
    (property "Reference" "R5" (at 52.07 53.34 0) (effects (font (size 1.27 1.27)) (justify left)))
    (property "Value" "10k" (at 52.07 55.88 0) (effects (font (size 1.27 1.27)) (justify left)))
    (pin "1" (uuid "p1"))
    (pin "2" (uuid "p2"))
    (instances (project "proj" (path "/root-uuid" (reference "R5") (unit 1)))))
  (sheet (at 100 100) (size 20 10)
    (stroke (width 0.1524) (type solid))
    (uuid "sheet-uuid")
    (property "Sheetname" "Child" (at 100 99 0) (effects (font (size 1.27 1.27))))
    (property "Sheetfile" "child.kicad_sch" (at 100 111 0) (effects (font (size 1.27 1.27))))
    (instances (project "proj" (path "/root-uuid" (page "2")))))
  (sheet_instances (path "/" (page "1")))
)`

const CHILD = `(kicad_sch
  (version 20231120)
  (generator "eeschema")
  (uuid "child-uuid")
  (paper "A4")
${LIB}
  (sheet_instances (path "/" (page "2")))
)`

const ROOT_PATH = '/proj/root.kicad_sch'
const CHILD_PATH = '/proj/child.kicad_sch'
const CHILD_SHEET_PATH = '/root-uuid/sheet-uuid'

const noLibraries: SymbolSources = {
  tableSymbols: shallowRef([]),
  standardSymbols: shallowRef([]),
  registeredLibraries: shallowRef(new Map()),
  ready: async () => {},
  reload: async () => {},
  ensureStandardLibrary: async () => {},
  lookup: () => undefined
}

/** A two-file project on a fake disk, the child open as a background tab. */
const project = (
  ercLibrariesReady?: () => Promise<void>
): {
  sheet: ReturnType<typeof createSheetSession>
  document: DocumentHandle
  commits: SheetEdit[][]
  disk: Map<string, string>
} => {
  const disk = new Map([
    [ROOT_PATH, ROOT],
    [CHILD_PATH, CHILD]
  ])
  const fs: HierarchyFs = {
    readFile: async (path) => disk.get(path) ?? null,
    listSchematics: async (dir) => [...disk.keys()].filter((path) => dirnameOf(path) === dir)
  }
  const document = new DocumentStore(async () => null).open(CHILD_PATH, CHILD)
  const commits: SheetEdit[][] = []
  const sheet = createSheetSession({
    filePath: CHILD_PATH,
    name: 'child.kicad_sch',
    document,
    commit: (edits) => {
      commits.push(edits)
      for (const edit of edits) if (edit.path === CHILD_PATH) document.setText(edit.after)
    },
    openSheet: () => null,
    fs,
    libraries: noLibraries,
    gridStep: () => mmToNm(1.27),
    label: (key, count) => (count === undefined ? key : `${key}×${count}`),
    createFile: async () => ({ success: true }),
    fileCreated: () => {},
    siblingsVersion: () => 0,
    ...(ercLibrariesReady ? { ercLibrariesReady } : {})
  })
  return { sheet, document, commits, disk }
}

const asRecord = (value: unknown): Record<string, unknown> => value as Record<string, unknown>

describe('createSheetSession', () => {
  test('is ready only once the libraries ERC reads have been read too', async () => {
    let read = (): void => {}
    const { sheet } = project(() => new Promise((resolve) => (read = resolve)))
    let ready = false
    void sheet.ready().then(() => (ready = true))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(ready).toBe(false)
    read()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(ready).toBe(true)
  })

  test('a place lands in the buffer, numbered against the whole tree, under the instance path', async () => {
    const { sheet, document, commits } = project()
    const answer = asRecord(
      await sheet.agent.dispatch({
        kind: 'place-symbol',
        libId: 'Device:R',
        at: { x: 76.2, y: 54.61 }
      })
    )
    // R5 on the root is in the pool, so the next number is past it.
    expect(asRecord(answer.placed).reference).toBe('R6')
    expect(commits).toHaveLength(1)
    expect(commits[0].map((edit) => edit.path)).toEqual([CHILD_PATH])
    const written = parseKicadSchematic(document.text())
    expect(written.symbols).toHaveLength(1)
    expect(referenceForSheetPath(written.symbols[0], CHILD_SHEET_PATH)).toBe('R6')
    expect(written.symbols[0].instances[0]?.path).toBe(CHILD_SHEET_PATH)
    // Undo is waiting for whoever brings the tab forward.
    expect(document.openHistory(document.text()).undoLabel).toBe('commandLabels.addSymbol')
  })

  test('the reference pool and the nets span the root the child hangs from', async () => {
    const { sheet } = project()
    await sheet.agent.dispatch({
      kind: 'place-symbol',
      libId: 'Device:R',
      at: { x: 76.2, y: 54.61 }
    })
    const taken = asRecord(
      await sheet.agent.dispatch({
        kind: 'place-symbol',
        libId: 'Device:R',
        at: { x: 88.9, y: 54.61 },
        reference: 'R5'
      })
    )
    expect(taken.error).toBe('reference-taken')
    const described = asRecord(await sheet.agent.dispatch({ kind: 'describe-schematic' }))
    expect((described.sheets as Array<{ path: string }>).map((entry) => entry.path)).toEqual([
      ROOT_PATH,
      CHILD_PATH
    ])
  })

  test('checks read before the tree resolves are redone over the whole design once it does', async () => {
    const { sheet } = project()
    const resolved = new Promise<void>((resolve) => sheet.subscribe(resolve))
    expect(sheet.checks()).toEqual([])
    await resolved
    expect(sheet.checks().map((result) => result.items)).toEqual([['R5.1'], ['R5.2']])
  })

  test("the view's checks, run off the page, answer as the agent's do over the whole design", async () => {
    const { sheet } = project()
    await sheet.ready()
    await sheet.agent.dispatch({
      kind: 'place-symbol',
      libId: 'Device:R',
      at: { x: 76.2, y: 54.61 }
    })
    const background = await sheet.backgroundChecks()
    expect(background).toEqual(sheet.checks())
    // The root's R5 is on another file: the worker was given the whole design.
    expect(background?.map((result) => result.items)).toContainEqual(['R5.1'])
    // Asked again with nothing changed, the same answer.
    expect(sheet.backgroundChecks()).toBe(sheet.backgroundChecks())
  })

  test('a batch that fails commits nothing', async () => {
    const { sheet, document, commits } = project()
    const answer = asRecord(
      await sheet.agent.batch({
        kind: 'batch',
        ops: [
          { kind: 'place-symbol', libId: 'Device:R', at: { x: 76.2, y: 54.61 } },
          { kind: 'place-symbol', libId: 'Device:R', at: { x: 88.9, y: 54.61 }, reference: 'R5' }
        ]
      })
    )
    expect(answer.error).toBe('reference-taken')
    expect(answer.detail).toContain('Operation 1')
    expect(commits).toEqual([])
    expect(document.text()).toBe(CHILD)
    expect(document.openHistory(CHILD).canUndo).toBe(false)
  })

  test('a batch that succeeds is one commit and one undo step', async () => {
    const { sheet, document, commits } = project()
    await sheet.agent.batch({
      kind: 'batch',
      ops: [
        { kind: 'place-symbol', libId: 'Device:R', at: { x: 76.2, y: 54.61 } },
        { kind: 'place-symbol', libId: 'Device:R', at: { x: 88.9, y: 54.61 } }
      ]
    })
    expect(commits).toHaveLength(1)
    expect(parseKicadSchematic(document.text()).symbols).toHaveLength(2)
    expect(document.openHistory(document.text()).undoLabel).toBe('commandLabels.agentBatch×2')
  })

  test('annotating the design rewrites the root as a sibling, with its disk text as baseline', async () => {
    const { sheet, document, commits } = project()
    await sheet.agent.dispatch({
      kind: 'place-symbol',
      libId: 'Device:R',
      at: { x: 76.2, y: 54.61 }
    })
    const answer = asRecord(
      await sheet.agent.dispatch({
        kind: 'annotate-schematic',
        scope: 'design',
        recurse: true,
        order: 'xy',
        numbering: 'sequential',
        start: 0,
        reset: true,
        dryRun: false
      })
    )
    expect(asRecord(answer.counts).renamed).toBe(2)
    const last = commits[commits.length - 1]
    const root = last.find((edit) => edit.path === ROOT_PATH)
    expect(root).toBeDefined()
    // The baseline is the disk copy as the command read it: parsed, then
    // written back — what an undo restores and what a save compares against.
    expect(root?.loaded).toBe(serializeKicadSchematic(parseKicadSchematic(ROOT)))
    expect(root?.after).toContain('(reference "R1")')
    expect(document.openHistory(last.find((e) => e.path === CHILD_PATH)!.after).canUndo).toBe(true)
  })

  test('a buffer rewritten behind the session is read on the next request, its history gone', async () => {
    const { sheet, document } = project()
    await sheet.agent.dispatch({
      kind: 'place-symbol',
      libId: 'Device:R',
      at: { x: 76.2, y: 54.61 }
    })
    document.setText(CHILD)
    const described = asRecord(await sheet.agent.dispatch({ kind: 'describe-schematic' }))
    expect((described.symbols as unknown[]).length).toBe(0)
    expect(document.openHistory(CHILD).canUndo).toBe(false)
  })

  test('the design read catches up with a buffer rewritten behind the session', async () => {
    const { sheet, document } = project()
    await sheet.agent.dispatch({
      kind: 'place-symbol',
      libId: 'Device:R',
      at: { x: 76.2, y: 54.61 }
    })
    document.setText(CHILD)
    const design = await sheet.agent.designInputs()
    const child = design?.sheets.find((source) => source.filePath === CHILD_PATH)
    expect(child?.schematic.symbols).toHaveLength(0)
  })

  test('answers carry the document revision, whoever wrote last', async () => {
    const { sheet, document } = project()
    await sheet.agent.dispatch({
      kind: 'place-symbol',
      libId: 'Device:R',
      at: { x: 76.2, y: 54.61 }
    })
    const before = document.revision()
    document.setText(CHILD)
    const described = asRecord(await sheet.agent.dispatch({ kind: 'describe-schematic' }))
    expect(document.revision()).toBeGreaterThan(before)
    expect(described.revision).toBe(document.revision())
  })

  test('a describe inside a batch is not remembered as a committed revision', async () => {
    const { sheet } = project()
    await sheet.agent.dispatch({
      kind: 'place-symbol',
      libId: 'Device:R',
      at: { x: 76.2, y: 54.61 }
    })
    const start = asRecord(await sheet.agent.dispatch({ kind: 'describe-schematic' }))
    await sheet.agent.batch({
      kind: 'batch',
      ops: [
        { kind: 'place-symbol', libId: 'Device:R', at: { x: 88.9, y: 54.61 } },
        { kind: 'describe-schematic', since: start.revision as number }
      ]
    })
    // The state inside the batch was never a revision, so asking about the
    // revision before it still diffs against what that revision was.
    const since = asRecord(
      await sheet.agent.dispatch({ kind: 'describe-schematic', since: start.revision as number })
    )
    expect(since.sinceUnavailable).toBeUndefined()
    expect(JSON.stringify(since)).toContain('R7')
  })
})

describe('the sheet tree after a page edit', () => {
  test('re-resolves from the buffer on the edit and on its undo', async () => {
    const disk = new Map([
      [ROOT_PATH, ROOT],
      [CHILD_PATH, CHILD]
    ])
    const document = new DocumentStore(async () => null).open(ROOT_PATH, ROOT)
    // Live-first, as the editor's tree reads an open tab.
    const fs: HierarchyFs = {
      readFile: async (path) => (path === ROOT_PATH ? document.text() : (disk.get(path) ?? null)),
      listSchematics: async (dir) => [...disk.keys()].filter((path) => dirnameOf(path) === dir)
    }
    const sheet = createSheetSession({
      filePath: ROOT_PATH,
      name: 'root.kicad_sch',
      document,
      commit: (edits) => {
        for (const edit of edits) if (edit.path === ROOT_PATH) document.setText(edit.after)
      },
      openSheet: () => null,
      fs,
      libraries: noLibraries,
      gridStep: () => mmToNm(1.27),
      label: (key) => key,
      createFile: async () => ({ success: true }),
      fileCreated: () => {},
      siblingsVersion: () => 0
    })
    await sheet.ready()
    const childPage = (): string | undefined =>
      sheet.hierarchy()?.instances.find((i) => i.sheetPath === CHILD_SHEET_PATH)?.page
    expect(childPage()).toBe('2')
    sheet.runCommand('edit', () => {
      const doc = sheet.document()
      if (doc) setSheetPage(doc.sheets[0], '/root-uuid', '7', 'proj')
    })
    await sheet.ready()
    expect(childPage()).toBe('7')
    sheet.undo()
    await sheet.ready()
    expect(childPage()).toBe('2')
  })
})

describe('the sheet on screen, edited from a subsheet', () => {
  test("its page lands in the parent's file and the paper in its own, as one undo step, and the tree follows", async () => {
    const { sheet, commits, disk } = project()
    await sheet.ready()
    const parent = sheet.sheetSources().find((source) => source.sheetPath === '/root-uuid')!
    const screen = {
      filePath: CHILD_PATH,
      document: sheet.document()!,
      root: false,
      parent: { filePath: ROOT_PATH, sheetPath: '/root-uuid', sheet: parent.schematic.sheets[0] },
      designPages: ['1', '2'],
      project: 'proj'
    }
    const childPage = (): string | undefined =>
      sheet.hierarchy()?.instances.find((i) => i.sheetPath === CHILD_SHEET_PATH)?.page
    expect(childPage()).toBe('2')
    // A sibling written by the command reaches the disk the tree reads.
    const land = (): void => {
      for (const edit of commits[commits.length - 1] ?? [])
        if (edit.path === ROOT_PATH) disk.set(ROOT_PATH, edit.after)
    }

    sheet.applyDocumentEdits('edit', [
      ...screenSheetEdits(screen, 'page', '7'),
      ...screenSheetEdits(screen, 'paperSize', 'A3')
    ])
    land()
    expect(commits).toHaveLength(1)
    expect(commits[0].map((edit) => edit.path).sort()).toEqual([CHILD_PATH, ROOT_PATH].sort())
    expect(commits[0].find((edit) => edit.path === ROOT_PATH)?.after).toContain('(page "7")')
    expect(sheet.document()?.paper?.size).toBe('A3')
    await sheet.ready()
    expect(childPage()).toBe('7')

    sheet.undo()
    land()
    expect(sheet.canUndo()).toBe(false)
    expect(sheet.document()?.paper?.size).toBe('A4')
    expect(disk.get(ROOT_PATH)).toBe(serializeKicadSchematic(parseKicadSchematic(ROOT)))
    await sheet.ready()
    expect(childPage()).toBe('2')
  })
})
