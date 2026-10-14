import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  parseKicadSchematic,
  referenceForSheetPath,
  serializeKicadSchematic,
  setSymbolInstanceReference,
  getSymbolProperty,
  type KicadLibSymbol,
  type KicadSchematic,
  type KicadSchematicSymbol
} from '../../kicad/schematic'
import type {
  McpPlaceRequest,
  McpUpdateSymbolsSchematicRequest
} from '../../../../../preload/mcpTypes'
import { buildProjectComponentRecords } from '../../componentsTable'
import { cleanupChanged, cleanupSchematic } from '../wireCleanup'
import { buildConnectivity, type SheetConnectivityInput } from '../connectivity'
import { mmToNm, nmToMm } from '../../kicad/coordinates'
import { KICAD10_PIN_MAP } from '../../kicad/projectDefaults'
import type { AnnotationPlan } from '../annotate'
import type { DocumentEdit, SymbolEdit } from '../symbolEdits'
import { createSheetAgent, type SheetAgentContext } from '../sheetAgent'
import { CONNECTION_GRID } from '../schematicAgent'
import { KICAD_SUBPART } from '../symbolUnits'

/** A resistor on a small sheet, one wire and label on pin 1, a no-connect on pin 2. */
const SOURCE = `(kicad_sch
  (version 20231120)
  (generator "eeschema")
  (uuid "root-uuid")
  (paper "A4")
  (lib_symbols
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
  )
  (no_connect (at 50.8 59.69) (uuid "nc-uuid"))
  (wire (pts (xy 50.8 52.07) (xy 63.5 52.07))
    (stroke (width 0) (type default))
    (uuid "wire-uuid"))
  (label "VBUS" (at 63.5 52.07 0)
    (effects (font (size 1.27 1.27)) (justify left bottom))
    (uuid "label-uuid"))
  (symbol
    (lib_id "Device:R")
    (at 50.8 55.88 0)
    (unit 1)
    (in_bom yes)
    (on_board yes)
    (dnp no)
    (uuid "symbol-uuid")
    (property "Reference" "R1" (at 52.07 54.61 0) (effects (font (size 1.27 1.27)) (justify left)))
    (property "Value" "10k" (at 52.07 57.15 0) (effects (font (size 1.27 1.27)) (justify left)))
    (pin "1" (uuid "pin-1"))
    (pin "2" (uuid "pin-2")))
  (sheet_instances (path "/" (page "1")))
)`

const FILE = '/proj/root.kicad_sch'

/**
 * A sheet with no editor: the document, its text, and a command layer that is
 * serialize → re-parse, which is what the editor's `runCommand` does too.
 */
const fakeSheet = (
  source = SOURCE
): {
  ctx: SheetAgentContext
  document: () => KicadSchematic
  text: () => string
  commands: string[]
} => {
  let doc = parseKicadSchematic(source)
  let text = source
  let revision = 0
  const commands: string[] = []
  let inBatch = false
  const sheetPath = (): string => `/${doc.uuid ?? ''}`
  const inputs = (): SheetConnectivityInput[] => [
    { sheetPath: sheetPath(), namePath: '/', schematic: doc }
  ]
  const commit = (mutate: () => void): void => {
    mutate()
    text = serializeKicadSchematic(doc)
    doc = parseKicadSchematic(text)
    revision += 1
  }
  // The undo list, as the session's: one entry per command, whole texts.
  type Step = { label: string; before: string; after: string }
  const undoList: Step[] = []
  let redoList: Step[] = []
  const record = (label: string, run: () => void): void => {
    const before = text
    run()
    if (inBatch || text === before) return
    undoList.push({ label, before, after: text })
    redoList = []
  }
  const land = (next: string): void => {
    text = next
    doc = parseKicadSchematic(next)
    revision += 1
  }
  const ctx: SheetAgentContext = {
    filePath: () => FILE,
    name: () => 'root.kicad_sch',
    readOnly: () => false,
    document: () => doc,
    setDocument: (next) => {
      doc = next
    },
    revision: () => revision,
    sheetPath,
    instancePaths: () => [sheetPath()],
    instanceProjectName: () => 'proj',
    sheetSources: () => [{ schematic: doc, sheetPath: sheetPath(), sheetName: '', filePath: FILE }],
    hierarchy: () => null,
    connectivity: () => buildConnectivity(inputs()),
    connectivityInputs: inputs,
    existingReferences: () =>
      doc.symbols
        .map((symbol) => referenceForSheetPath(symbol, sheetPath()))
        .filter((reference): reference is string => !!reference),
    availableSymbols: () => [{ libId: 'Device:R', sheet: doc }],
    ensureStandardLibrary: async () => {},
    librarySymbolLookup: () => undefined,
    connectionGrid: () => CONNECTION_GRID,
    pinMap: () => KICAD10_PIN_MAP,
    netclasses: () => null,
    subpart: () => KICAD_SUBPART,
    textVariables: () => null,
    ercLibraries: () => undefined,
    ercSeverities: () => ({}),
    ercExclusions: () => [],
    gridStep: () => mmToNm(1.27),
    label: (key, count) => (count === undefined ? key : `${key}×${count}`),
    // As the editor's: a command inside a batch writes no entry of its own.
    runCommand: (label, mutate, options) => {
      if (!inBatch) commands.push(label)
      let report: ReturnType<typeof cleanupSchematic> | null = null
      record(label, () => {
        commit(mutate)
        if (!options?.cleanup) return
        report = cleanupSchematic(doc)
        if (cleanupChanged(report)) commit(() => {})
      })
      return report
    },
    undo: () => {
      const step = undoList.pop()
      if (!step) return null
      land(step.before)
      redoList.push(step)
      return step
    },
    redo: () => {
      const step = redoList.pop()
      if (!step) return null
      land(step.after)
      undoList.push(step)
      return step
    },
    undoLabel: () => undoList[undoList.length - 1]?.label ?? null,
    redoLabel: () => redoList[redoList.length - 1]?.label ?? null,
    batch: async <T>(label: string, body: () => Promise<{ result: T; keep: boolean }>) => {
      const snapshot = text
      inBatch = true
      let outcome: { result: T; keep: boolean }
      try {
        outcome = await body()
      } finally {
        inBatch = false
      }
      const { result, keep } = outcome
      const changed = text !== snapshot
      if (!keep || !changed) {
        if (changed) {
          text = snapshot
          doc = parseKicadSchematic(snapshot)
          revision += 1
        }
        return { result, changed }
      }
      commands.push(label)
      undoList.push({ label, before: snapshot, after: text })
      redoList = []
      return { result, changed }
    },
    applyAnnotationPlan: (plan: AnnotationPlan) => {
      commands.push('annotate')
      commit(() => {
        for (const change of plan.changes) {
          const symbol = doc.symbols[change.symbolIndex]
          if (symbol) setSymbolInstanceReference(symbol, change.sheetPath, change.to)
        }
      })
    },
    applySymbolEdits: (label: string, edits: SymbolEdit[]) => {
      commands.push(label)
      commit(() => {
        for (const edit of edits) {
          const symbol = doc.symbols[edit.symbolIndex]
          if (symbol) edit.apply(symbol)
        }
      })
    },
    applyDocumentEdits: (label: string, edits: DocumentEdit[], options) => {
      commands.push(label)
      commit(() => {
        for (const edit of edits) edit.apply(doc)
      })
      if (options?.cleanup) {
        const report = cleanupSchematic(doc)
        if (cleanupChanged(report)) commit(() => {})
      }
    },
    annotationScope: () => [
      { schematic: doc, sheetPath: sheetPath(), sheetName: '', filePath: FILE }
    ],
    createFile: async () => ({ success: true }),
    fileCreated: () => {},
    reloadHierarchy: async () => {},
    capture: async () => null,
    ready: async () => {},
    settle: async () => {}
  }
  return { ctx, document: () => doc, text: () => text, commands }
}

const asRecord = (value: unknown): Record<string, unknown> => value as Record<string, unknown>

describe('sheet graphics, buses and directive labels', () => {
  type Agent = ReturnType<typeof createSheetAgent>
  const created = (answer: unknown): string[] =>
    asRecord(asRecord(answer).changed).created as string[]
  const read = async (agent: Agent, id: string): Promise<Record<string, unknown>> =>
    asRecord(
      (asRecord(await agent.dispatch({ kind: 'get-items', ids: [id] })).items as unknown[])[0]
    )
  // A 1×1 PNG.
  const PNG =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('a rectangle is drawn styled, read back, resized and deleted, one step each', async () => {
    const sheet = fakeSheet()
    const agent = createSheetAgent(sheet.ctx)
    const [id] = created(
      await agent.dispatch({
        kind: 'create-item',
        itemKind: 'rect',
        box: { x: 101.6, y: 101.6, width: 20.32, height: 10.16 },
        width: 0.3,
        strokeType: 'dash',
        strokeColor: '#ff0000',
        fill: 'color',
        fillColor: '#00ff0080'
      })
    )
    expect(await read(agent, id)).toMatchObject({
      kind: 'rect',
      at: { x: 101.6, y: 101.6 },
      box: { x: 101.6, y: 101.6, width: 20.32, height: 10.16 },
      width: 0.3,
      strokeType: 'dash',
      strokeColor: '#ff0000',
      fill: 'color',
      fillColor: '#00ff0080'
    })
    await agent.dispatch({
      kind: 'update-item',
      id,
      box: { x: 101.6, y: 101.6, width: 30.48, height: 15.24 },
      strokeColor: null
    })
    expect(await read(agent, id)).toMatchObject({
      box: { width: 30.48, height: 15.24 },
      strokeColor: null
    })
    const both = asRecord(
      await agent.dispatch({
        kind: 'update-item',
        id,
        at: { x: 0, y: 0 },
        box: { x: 0, y: 0, width: 1, height: 1 }
      })
    )
    expect(both.error).toBe('invalid-record')
    await agent.dispatch({ kind: 'delete-items', ids: [id] })
    expect(sheet.document().shapes).toHaveLength(0)
    expect(sheet.commands).toEqual([
      'commandLabels.addRectangle',
      'schematicEditor.commands.editGraphic',
      'commandLabels.delete×1'
    ])
  })

  test('a line is one polyline per leg, as the Draw Lines tool writes it, and moves by at', async () => {
    const sheet = fakeSheet()
    const agent = createSheetAgent(sheet.ctx)
    const ids = created(
      await agent.dispatch({
        kind: 'create-item',
        itemKind: 'polyline',
        points: [
          { x: 100, y: 100 },
          { x: 110, y: 100 },
          { x: 110, y: 90 }
        ],
        strokeType: 'dot'
      })
    )
    expect(ids).toHaveLength(2)
    expect(sheet.commands).toEqual(['commandLabels.addLine'])
    const [first] = ids
    expect(await read(agent, first)).toMatchObject({
      kind: 'polyline',
      points: [
        { x: 100, y: 100 },
        { x: 110, y: 100 }
      ],
      strokeType: 'dot'
    })
    await agent.dispatch({ kind: 'update-item', id: first, at: { x: 120, y: 120 } })
    expect((await read(agent, first)).points).toEqual([
      { x: 120, y: 120 },
      { x: 130, y: 120 }
    ])
    expect(sheet.commands.at(-1)).toBe('commandLabels.move×1')
  })

  test("an arc without a middle is the Draw Arcs tool's quarter turn, and stays one when its end moves", async () => {
    const sheet = fakeSheet()
    const agent = createSheetAgent(sheet.ctx)
    const [id] = created(
      await agent.dispatch({
        kind: 'create-item',
        itemKind: 'arc',
        start: { x: 100, y: 100 },
        end: { x: 110, y: 100 }
      })
    )
    const arc = await read(agent, id)
    expect(arc.mid).toEqual({ x: 105, y: 97.929 })
    await agent.dispatch({ kind: 'update-item', id, end: { x: 100, y: 110 } })
    const moved = await read(agent, id)
    expect(moved.end).toEqual({ x: 100, y: 110 })
    expect(moved.mid).not.toEqual(arc.mid)
  })

  test('a circle, a bezier and a rule area are read as written', async () => {
    const agent = createSheetAgent(fakeSheet().ctx)
    const [circle] = created(
      await agent.dispatch({
        kind: 'create-item',
        itemKind: 'circle',
        center: { x: 120, y: 120 },
        radius: 5,
        fill: 'hatch'
      })
    )
    expect(await read(agent, circle)).toMatchObject({
      center: { x: 120, y: 120 },
      radius: 5,
      fill: 'hatch',
      box: { x: 115, y: 115, width: 10, height: 10 }
    })
    await agent.dispatch({ kind: 'update-item', id: circle, radius: 2.5 })
    expect((await read(agent, circle)).radius).toBe(2.5)
    const curve = [
      { x: 0, y: 0 },
      { x: 5, y: -5 },
      { x: 10, y: -5 },
      { x: 15, y: 0 }
    ]
    const [bezier] = created(
      await agent.dispatch({ kind: 'create-item', itemKind: 'bezier', points: curve })
    )
    expect((await read(agent, bezier)).points).toEqual(curve)
    const [area] = created(
      await agent.dispatch({
        kind: 'create-item',
        itemKind: 'rule_area',
        points: curve.slice(0, 3)
      })
    )
    expect(await read(agent, area)).toMatchObject({ kind: 'rule_area', strokeType: 'dash' })
  })

  test('a text box and a text carry their text style', async () => {
    const agent = createSheetAgent(fakeSheet().ctx)
    const [box] = created(
      await agent.dispatch({
        kind: 'create-item',
        itemKind: 'text_box',
        text: 'Power in',
        box: { x: 100, y: 100, width: 30, height: 10 },
        bold: true,
        justify: 'center',
        color: '#0000ff'
      })
    )
    expect(await read(agent, box)).toMatchObject({
      text: 'Power in',
      box: { x: 100, y: 100, width: 30, height: 10 },
      bold: true,
      justify: 'center',
      color: '#0000ff'
    })
    const [text] = created(
      await agent.dispatch({
        kind: 'create-item',
        itemKind: 'text',
        text: 'Note',
        at: { x: 100, y: 120 },
        italic: true,
        size: 2
      })
    )
    expect(await read(agent, text)).toMatchObject({ italic: true, size: 2 })
    await agent.dispatch({
      kind: 'update-item',
      id: text,
      justify: 'right',
      verticalJustify: 'top',
      color: '#123456'
    })
    expect(await read(agent, text)).toMatchObject({
      justify: 'right',
      verticalJustify: 'top',
      color: '#123456'
    })
  })

  test('a table is drawn with its cells, which update in place; a grid of the wrong size is refused', async () => {
    const sheet = fakeSheet()
    const agent = createSheetAgent(sheet.ctx)
    const [id] = created(
      await agent.dispatch({
        kind: 'create-item',
        itemKind: 'table',
        at: { x: 100, y: 100 },
        columnWidths: [10, 20],
        rowHeights: [5, 5],
        cells: [
          ['Net', 'Class'],
          ['VBUS', 'Power']
        ]
      })
    )
    expect(await read(agent, id)).toMatchObject({
      columnWidths: [10, 20],
      rowHeights: [5, 5],
      cells: [
        ['Net', 'Class'],
        ['VBUS', 'Power']
      ],
      box: { x: 100, y: 100, width: 30, height: 10 }
    })
    await agent.dispatch({
      kind: 'update-item',
      id,
      cells: [
        ['Net', 'Class'],
        ['GND', 'Power']
      ],
      borderExternal: false
    })
    expect(await read(agent, id)).toMatchObject({
      cells: [
        ['Net', 'Class'],
        ['GND', 'Power']
      ],
      borderExternal: false
    })
    const wrong = asRecord(await agent.dispatch({ kind: 'update-item', id, cells: [['x']] }))
    expect(wrong.error).toBe('invalid-record')
  })

  test('an image is placed from a picture file and rescaled', async () => {
    vi.stubGlobal('window', {
      api: { readFileBase64: async () => ({ success: true, data: PNG }) }
    })
    const agent = createSheetAgent(fakeSheet().ctx)
    const [id] = created(
      await agent.dispatch({
        kind: 'create-item',
        itemKind: 'image',
        path: 'logo.png',
        at: { x: 120, y: 120 },
        scale: 2
      })
    )
    expect(await read(agent, id)).toMatchObject({
      at: { x: 120, y: 120 },
      scale: 2,
      pixels: { width: 1, height: 1 }
    })
    await agent.dispatch({ kind: 'update-item', id, scale: 3 })
    expect((await read(agent, id)).scale).toBe(3)
  })

  test('an unreadable picture is refused and writes nothing', async () => {
    vi.stubGlobal('window', { api: { readFileBase64: async () => ({ success: false }) } })
    const sheet = fakeSheet()
    const answer = asRecord(
      await createSheetAgent(sheet.ctx).dispatch({
        kind: 'create-item',
        itemKind: 'image',
        path: '/nowhere.png',
        at: { x: 0, y: 0 }
      })
    )
    expect(answer.error).toBe('invalid-record')
    expect(sheet.commands).toEqual([])
  })

  test('a directive label stands on a pin with its net class, which an update changes or adds', async () => {
    const sheet = fakeSheet()
    const agent = createSheetAgent(sheet.ctx)
    const [id] = created(
      await agent.dispatch({
        kind: 'create-item',
        itemKind: 'directive_label',
        pin: 'R1.1',
        netClass: 'Power',
        shape: 'diamond'
      })
    )
    expect(await read(agent, id)).toMatchObject({
      kind: 'directive_label',
      at: { x: 50.8, y: 52.07 },
      shape: 'diamond',
      netClass: 'Power',
      net: '/VBUS'
    })
    await agent.dispatch({ kind: 'update-item', id, netClass: 'HV', shape: 'dot' })
    expect(await read(agent, id)).toMatchObject({ netClass: 'HV', shape: 'dot' })
    const [bare] = created(
      await agent.dispatch({
        kind: 'create-item',
        itemKind: 'directive_label',
        at: { x: 63.5, y: 52.07 }
      })
    )
    expect((await read(agent, bare)).netClass).toBeNull()
    await agent.dispatch({ kind: 'update-item', id: bare, netClass: 'Power' })
    expect((await read(agent, bare)).netClass).toBe('Power')
    const signal = asRecord(await agent.dispatch({ kind: 'update-item', id: bare, shape: 'input' }))
    expect(signal.error).toBe('invalid-record')
  })

  test('a bus is drawn as the bus tool draws it, named by a label, and joined by entries', async () => {
    const sheet = fakeSheet()
    const agent = createSheetAgent(sheet.ctx)
    const drawn = asRecord(
      await agent.dispatch({
        kind: 'draw-wire',
        start: { x: 101.6, y: 101.6 },
        end: { x: 101.6, y: 127 },
        bus: true
      })
    )
    const [bus] = created(drawn)
    expect(sheet.commands).toEqual(['commandLabels.addBus'])
    expect(sheet.document().buses).toHaveLength(1)
    expect(sheet.document().junctions).toHaveLength(0)
    await agent.dispatch({
      kind: 'create-item',
      itemKind: 'label',
      text: 'D[0..7]',
      at: { x: 101.6, y: 110.49 }
    })
    const record = await read(agent, bus)
    expect(record.names).toEqual(['D[0..7]'])
    expect((record.members as string[]).some((member) => member.endsWith('D0'))).toBe(true)
    const [entry] = created(
      await agent.dispatch({
        kind: 'create-item',
        itemKind: 'bus_entry',
        at: { x: 101.6, y: 105.41 }
      })
    )
    expect(await read(agent, entry)).toMatchObject({
      at: { x: 101.6, y: 105.41 },
      end: { x: 104.14, y: 107.95 }
    })
    const offGrid = asRecord(
      await agent.dispatch({ kind: 'create-item', itemKind: 'bus_entry', at: { x: 101.6, y: 105 } })
    )
    expect(offGrid.error).toBe('off-grid')
    const onPin = asRecord(
      await agent.dispatch({
        kind: 'draw-wire',
        start: { pin: 'R1.2' },
        end: { x: 76.2, y: 59.69 },
        bus: true
      })
    )
    expect(onPin.error).toBe('invalid-args')
    const again = asRecord(
      await agent.dispatch({
        kind: 'draw-wire',
        start: { x: 101.6, y: 101.6 },
        end: { x: 101.6, y: 127 },
        bus: true
      })
    )
    expect(again.alreadyDrawn).toBe(true)
    await agent.dispatch({ kind: 'update-item', id: bus, width: 0.5, strokeColor: '#00aa00' })
    expect(await read(agent, bus)).toMatchObject({ width: 0.5, strokeColor: '#00aa00' })
  })

  test("labels take a text style, and a global label's shape changes; a local label has none", async () => {
    const agent = createSheetAgent(fakeSheet().ctx)
    const [global] = created(
      await agent.dispatch({
        kind: 'create-item',
        itemKind: 'label',
        labelKind: 'global',
        text: 'SDA',
        at: { x: 101.6, y: 101.6 },
        italic: true,
        color: '#aa0000'
      })
    )
    expect(await read(agent, global)).toMatchObject({
      shape: 'input',
      italic: true,
      color: '#aa0000'
    })
    await agent.dispatch({ kind: 'update-item', id: global, shape: 'bidirectional', bold: true })
    expect(await read(agent, global)).toMatchObject({ shape: 'bidirectional', bold: true })
    const local = asRecord(
      await agent.dispatch({ kind: 'update-item', id: 'label-uuid', shape: 'output' })
    )
    expect(local.error).toBe('not-applicable')
    const justified = asRecord(
      await agent.dispatch({ kind: 'update-item', id: 'label-uuid', justify: 'center' })
    )
    expect(justified.error).toBe('not-applicable')
  })

  test("a wire's stroke is restyled as the panel's stroke rows do", async () => {
    const agent = createSheetAgent(fakeSheet().ctx)
    await agent.dispatch({ kind: 'update-item', id: 'wire-uuid', strokeType: 'dash' })
    expect(await read(agent, 'wire-uuid')).toMatchObject({ strokeType: 'dash', width: 0 })
  })
})

describe('the BOM', () => {
  const part = (reference: string, value: string, extra = ''): string => `  (symbol
    (lib_id "Device:R")
    (at 76.2 55.88 0)
    (unit 1)
    (in_bom yes)
    (on_board yes)
    (dnp no)
    (uuid "${reference}-uuid")
    (property "Reference" "${reference}" (at 0 0 0) (effects (font (size 1.27 1.27))))
    (property "Value" "${value}" (at 0 0 0) (effects (font (size 1.27 1.27))))
    ${extra}
    (pin "1" (uuid "${reference}-pin-1"))
    (pin "2" (uuid "${reference}-pin-2")))
`
  const BOM_SOURCE = SOURCE.replace(
    '  (sheet_instances',
    `${part('R2', '10k')}${part(
      'R3',
      '4.7k',
      '(property "Footprint" "Resistor_SMD:R_0402_1005Metric" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))'
    )}  (sheet_instances`
  )

  test('bom.get groups the rows asked for and counts them', async () => {
    const sheet = fakeSheet(BOM_SOURCE)
    const answer = asRecord(
      await createSheetAgent(sheet.ctx).dispatch({
        kind: 'get-bom',
        fields: ['Value', 'Footprint', 'QUANTITY'],
        groupBy: ['Value', 'Footprint']
      })
    )
    expect(answer.columns).toEqual(['Reference', 'Value', 'Footprint', '${QUANTITY}'])
    expect(answer.rows).toEqual([
      ['R1-R2', '10k', '', 2],
      ['R3', '4.7k', 'Resistor_SMD:R_0402_1005Metric', 1]
    ])
    expect(answer).toMatchObject({ parts: 3, total: 2 })
  })

  test('bom.get refuses a column the design does not have', async () => {
    const answer = asRecord(
      await createSheetAgent(fakeSheet(BOM_SOURCE).ctx).dispatch({
        kind: 'get-bom',
        where: [{ field: 'Mpn', match: 'empty' }]
      })
    )
    expect(answer.error).toBe('field-not-found')
    expect(answer.candidates).toContain('MPN')
  })

  test('bom.update writes every part a condition matches as one step, naming what it replaced', async () => {
    const sheet = fakeSheet(BOM_SOURCE)
    const answer = asRecord(
      await createSheetAgent(sheet.ctx).dispatch({
        kind: 'update-bom',
        where: [{ field: 'Value', match: 'matches', value: '*k' }],
        expect: 3,
        fields: { Footprint: 'Resistor_SMD:R_0603_1608Metric' },
        dryRun: false
      })
    )
    expect(answer).toMatchObject({
      counts: { matched: 3, parts: 3 },
      changed: { created: [], updated: ['R1', 'R2', 'R3'], deleted: [] },
      overwrote: [{ field: 'Footprint', was: 'Resistor_SMD:R_0402_1005Metric', references: 'R3' }]
    })
    expect(sheet.commands).toEqual(['commandLabels.editComponents×3'])
    expect(
      sheet.document().symbols.map((symbol) => getSymbolProperty(symbol, 'Footprint'))
    ).toEqual(Array(3).fill('Resistor_SMD:R_0603_1608Metric'))
  })

  test('bom.update writes nothing on a count it did not expect, a misspelt field or a dry run', async () => {
    const sheet = fakeSheet(BOM_SOURCE)
    const agent = createSheetAgent(sheet.ctx)
    const miscount = asRecord(
      await agent.dispatch({
        kind: 'update-bom',
        where: [{ field: 'Value', match: 'equals', value: '10k' }],
        expect: 1,
        fields: { MPN: 'RC0402FR-0710KL' },
        dryRun: false
      })
    )
    expect(miscount.error).toBe('count-mismatch')
    expect(miscount.detail).toContain('R1-R2')
    const spelling = asRecord(
      await agent.dispatch({
        kind: 'update-bom',
        references: ['R1'],
        fields: { mpn: 'RC0402FR-0710KL' },
        dryRun: false
      })
    )
    expect(spelling.error).toBe('field-spelling')
    const dry = asRecord(
      await agent.dispatch({
        kind: 'update-bom',
        references: ['R1'],
        fields: { MPN: 'RC0402FR-0710KL' },
        dryRun: true
      })
    )
    expect(dry).toMatchObject({
      counts: { matched: 1, parts: 1 },
      changed: { updated: ['R1'] },
      dryRun: true,
      revision: 0
    })
    expect(sheet.commands).toEqual([])
  })
})

describe('createSheetAgent', () => {
  test('describe reads the sheet and dates it', () => {
    const { ctx } = fakeSheet()
    const answer = asRecord(createSheetAgent(ctx).describe())
    expect(answer.revision).toBe(0)
    expect(asRecord(answer.sheet).path).toBe(FILE)
    expect(JSON.stringify(answer)).toContain('R1')
  })

  test('place numbers the part, writes one command, and answers with a check delta', async () => {
    const sheet = fakeSheet()
    const answer = asRecord(
      await createSheetAgent(sheet.ctx).place({
        kind: 'place-symbol',
        libId: 'Device:R',
        at: { x: 76.2, y: 54.61 },
        checks: true
      })
    )
    expect(asRecord(answer.placed).reference).toBe('R2')
    expect(sheet.commands).toEqual(['commandLabels.addSymbol'])
    expect(sheet.document().symbols).toHaveLength(2)
    expect(answer.checks).toBeDefined()
    expect(answer.revision).toBe(1)
  })

  test('a write runs no checks unless asked', async () => {
    const sheet = fakeSheet()
    const answer = asRecord(
      await createSheetAgent(sheet.ctx).place({
        kind: 'place-symbol',
        libId: 'Device:R',
        at: { x: 76.2, y: 54.61 }
      })
    )
    expect(asRecord(answer.placed).reference).toBe('R2')
    expect(answer).not.toHaveProperty('checks')
    expect(answer.revision).toBe(1)
  })

  test('place by pin computes the origin the same way at every angle', async () => {
    // Device:R has pin 1 at lib (0, 3.81): at 0° it lands 3.81 below the origin
    // in sheet space, so pin 1 at (76.2, 50.8) is the origin (76.2, 54.61) —
    // the same placement the origin test makes.
    const upright = fakeSheet()
    const answer = asRecord(
      await createSheetAgent(upright.ctx).place({
        kind: 'place-symbol',
        libId: 'Device:R',
        pin: '1',
        at: { x: 76.2, y: 50.8 }
      })
    )
    expect(answer.placed).toMatchObject({
      id: 'R2',
      reference: 'R2',
      libId: 'Device:R',
      at: { x: 76.2, y: 54.61 },
      angle: 0,
      unit: 1
    })
    expect(answer.changed).toEqual({ created: ['R2'], updated: [], deleted: [] })
    expect(asRecord(answer.sheet).path).toBe(FILE)
    expect(asRecord(answer.sheet)).toHaveProperty('name')
    // The answer says where both pins landed and which way each is free, so
    // the next wire needs neither a read nor the rotation convention.
    expect(asRecord(answer.placed).pins).toMatchObject([
      { id: 'R2.1', number: '1', at: { x: 76.2, y: 50.8 }, free: 'up' },
      { id: 'R2.2', number: '2', at: { x: 76.2, y: 58.42 }, free: 'down' }
    ])
    expect(upright.document().symbols[1].position).toMatchObject({
      x: mmToNm(76.2),
      y: mmToNm(54.61)
    })

    // Turned 90° CCW the pin swings to the left of the origin.
    const turned = fakeSheet()
    const sideways = asRecord(
      await createSheetAgent(turned.ctx).place({
        kind: 'place-symbol',
        libId: 'Device:R',
        pin: '1',
        at: { x: 76.2, y: 50.8 },
        angle: 90
      })
    )
    expect(sideways.placed).toMatchObject({ at: { x: 80.01, y: 50.8 }, angle: 90 })
    expect(asRecord(sideways.placed).pins).toMatchObject([
      { id: 'R2.1', at: { x: 76.2, y: 50.8 }, free: 'left' },
      { id: 'R2.2', at: { x: 83.82, y: 50.8 }, free: 'right' }
    ])
  })

  test('place by a pin the unit does not have is refused, naming the pins it has', async () => {
    const sheet = fakeSheet()
    const answer = asRecord(
      await createSheetAgent(sheet.ctx).place({
        kind: 'place-symbol',
        libId: 'Device:R',
        pin: '3',
        at: { x: 76.2, y: 50.8 }
      })
    )
    expect(answer.error).toBe('pin-not-found')
    expect(answer.candidates).toEqual(['1', '2'])
    expect(sheet.commands).toEqual([])
  })

  test('place refuses an origin that puts a pin off the grid, writing nothing', async () => {
    const sheet = fakeSheet()
    const answer = asRecord(
      await createSheetAgent(sheet.ctx).place({
        kind: 'place-symbol',
        libId: 'Device:R',
        at: { x: 76.2, y: 55 }
      })
    )
    expect(answer.error).toBe('off-grid')
    expect(sheet.commands).toEqual([])
    expect(sheet.text()).toBe(SOURCE)
  })

  test('a move that would put a pin off the connection grid is refused, writing nothing', async () => {
    const sheet = fakeSheet()
    const answer = asRecord(
      await createSheetAgent(sheet.ctx).dispatch({
        kind: 'update-item',
        id: 'R1',
        at: { x: 76.2, y: 55 }
      })
    )
    expect(answer.error).toBe('off-grid')
    expect(answer.detail).toContain('nearest origin')
    expect(sheet.commands).toEqual([])
    expect(sheet.text()).toBe(SOURCE)
  })

  test('a move to a half-pitch origin goes through, since its pins still meet the grid', async () => {
    // Pins at ±3.81 from an origin at 55.88 land on 59.69 and 52.07: not on
    // the 2.54 mm pin pitch, but on the 1.27 mm grid a wire can meet.
    const sheet = fakeSheet()
    const answer = asRecord(
      await createSheetAgent(sheet.ctx).dispatch({
        kind: 'update-item',
        id: 'R1',
        at: { x: 76.2, y: 55.88 }
      })
    )
    expect(answer.error).toBeUndefined()
    expect(sheet.commands).toEqual(['commandLabels.move×1'])
    expect(sheet.document().symbols[0].position.x / 1e6).toBe(76.2)
  })

  test('a no-connect placed off the connection grid is refused', async () => {
    const sheet = fakeSheet()
    const answer = asRecord(
      await createSheetAgent(sheet.ctx).dispatch({
        kind: 'create-item',
        itemKind: 'no_connect',
        at: { x: 76.2, y: 55 }
      })
    )
    expect(answer.error).toBe('off-grid')
    expect(sheet.commands).toEqual([])
  })

  test('connect labels the pins that are not yet on the net', async () => {
    const sheet = fakeSheet()
    const agent = createSheetAgent(sheet.ctx)
    await agent.place({ kind: 'place-symbol', libId: 'Device:R', at: { x: 76.2, y: 54.61 } })
    const answer = asRecord(
      agent.connect({ kind: 'connect-pins', pins: ['R1.2', 'R2.2'], net: 'NET1' })
    )
    expect(asRecord(answer.connected).labelled).toEqual(['R1.2', 'R2.2'])
    expect(sheet.document().labels.filter((label) => label.text === 'NET1')).toHaveLength(2)
  })

  test('deleting a symbol takes the no-connect on its pin, as one step', async () => {
    const sheet = fakeSheet()
    const answer = asRecord(
      await createSheetAgent(sheet.ctx).dispatch({ kind: 'delete-items', ids: ['R1'] })
    )
    expect(asRecord(answer.changed).deleted).toContain('R1')
    expect(asRecord(answer.changed).deleted).toHaveLength(2)
    expect(answer).not.toHaveProperty('deleted')
    expect(sheet.document().symbols).toHaveLength(0)
    expect(sheet.document().noConnects).toHaveLength(0)
    expect(sheet.commands).toHaveLength(1)
  })

  test('an undo puts a deleted symbol back, names the step, and a redo takes it again', async () => {
    const sheet = fakeSheet()
    const agent = createSheetAgent(sheet.ctx)
    await agent.dispatch({ kind: 'delete-items', ids: ['R1'] })
    const undone = asRecord(await agent.dispatch({ kind: 'undo-sheet', steps: 1 }))
    expect(undone.undone).toEqual([sheet.commands[0]])
    expect(asRecord(undone.changed).created).toContain('R1')
    expect(undone.next).toEqual({ undo: null, redo: sheet.commands[0] })
    expect(sheet.document().symbols).toHaveLength(1)
    const redone = asRecord(await agent.dispatch({ kind: 'undo-sheet', steps: 1, redo: true }))
    expect(asRecord(redone.changed).deleted).toContain('R1')
    expect(sheet.document().symbols).toHaveLength(0)
    const short = asRecord(await agent.dispatch({ kind: 'undo-sheet', steps: 2 }))
    expect(short.error).toBe('nothing-to-undo')
    expect(sheet.document().symbols).toHaveLength(0)
  })

  test('an item update reaches a field through dispatch', async () => {
    const sheet = fakeSheet()
    await createSheetAgent(sheet.ctx).dispatch({
      kind: 'update-item',
      id: 'R1#Value',
      value: '4k7'
    })
    expect(getSymbolProperty(sheet.document().symbols[0], 'Value')).toBe('4k7')
  })

  test('an item update refuses a key the kind does not take, naming the ones it does', async () => {
    const sheet = fakeSheet()
    const answer = asRecord(
      await createSheetAgent(sheet.ctx).dispatch({ kind: 'update-item', id: 'R1#Value', text: 'x' })
    )
    expect(answer.error).toBe('not-applicable')
    expect(answer.detail).toBe('A field does not take text; it takes value, at, angle, hidden.')
    expect(sheet.commands).toEqual([])
  })

  test('an item update answers the ids it touched', async () => {
    const sheet = fakeSheet()
    const answer = asRecord(
      await createSheetAgent(sheet.ctx).dispatch({
        kind: 'update-item',
        id: 'R1',
        value: '22k',
        dnp: true
      })
    )
    expect(answer.changed).toEqual({ created: [], updated: ['R1'], deleted: [] })
    expect(answer).not.toHaveProperty('updated')
    expect(getSymbolProperty(sheet.document().symbols[0], 'Value')).toBe('22k')
  })

  test('moving a field takes the symbol off the autoplacer, as KiCad does', async () => {
    const sheet = fakeSheet(
      SOURCE.replace('(uuid "symbol-uuid")', '(fields_autoplaced yes) (uuid "symbol-uuid")')
    )
    expect(sheet.document().symbols[0].fieldsAutoplaced).toBe(true)
    await createSheetAgent(sheet.ctx).dispatch({
      kind: 'update-item',
      id: 'R1#Value',
      at: { x: 55.88, y: 57.15 }
    })
    expect(sheet.document().symbols[0].fieldsAutoplaced).toBe(false)
    expect(sheet.text()).not.toContain('fields_autoplaced')
  })

  test('a batch that fails rolls back to the text it started from', async () => {
    const sheet = fakeSheet()
    const answer = asRecord(
      await createSheetAgent(sheet.ctx).batch({
        kind: 'batch',
        ops: [
          { kind: 'place-symbol', libId: 'Device:R', at: { x: 76.2, y: 54.61 } },
          { kind: 'place-symbol', libId: 'Device:R', at: { x: 88.9, y: 54.61 }, reference: 'R1' }
        ]
      })
    )
    expect(answer.error).toBe('reference-taken')
    expect(answer.detail).toMatch(/^Operation 1 \(`place-symbol`\): /)
    expect(sheet.text()).toBe(SOURCE)
    expect(sheet.commands).toEqual([])
  })

  test('a dry-run batch answers what it would do and keeps nothing', async () => {
    const sheet = fakeSheet()
    const answer = asRecord(
      await createSheetAgent(sheet.ctx).batch({
        kind: 'batch',
        dryRun: true,
        ops: [{ kind: 'place-symbol', libId: 'Device:R', at: { x: 76.2, y: 54.61 } }]
      })
    )
    expect(answer.dryRun).toBe(true)
    expect(answer.changed).toEqual({ created: ['R2'], updated: [], deleted: [] })
    expect(answer.results).toHaveLength(1)
    expect(answer).toHaveProperty('revision')
    expect(answer).not.toHaveProperty('completed')
    expect(sheet.text()).toBe(SOURCE)
  })

  test('a batch that succeeds is one command', async () => {
    const sheet = fakeSheet()
    const answer = asRecord(
      await createSheetAgent(sheet.ctx).batch({
        kind: 'batch',
        ops: [
          { kind: 'place-symbol', libId: 'Device:R', at: { x: 76.2, y: 54.61 } },
          { kind: 'place-symbol', libId: 'Device:R', at: { x: 88.9, y: 54.61 } }
        ]
      })
    )
    expect(answer.changed).toEqual({ created: ['R2', 'R3'], updated: [], deleted: [] })
    expect(sheet.document().symbols).toHaveLength(3)
    expect(sheet.commands).toEqual(['commandLabels.agentBatch×2'])
  })

  test('check groups findings by rule', () => {
    const answer = asRecord(createSheetAgent(fakeSheet().ctx).check({ kind: 'check-schematic' }))
    expect(Array.isArray(answer.checks)).toBe(true)
    expect(answer).not.toHaveProperty('findings')
    expect(typeof answer.ok).toBe('boolean')
    expect(answer.revision).toBe(0)
    expect(asRecord(answer.counts)).toHaveProperty('error')
    expect(asRecord(answer.counts)).toHaveProperty('warning')
  })

  test('codes narrows the findings, and an unknown code is refused', () => {
    const agent = createSheetAgent(fakeSheet().ctx)
    const all = asRecord(agent.check({ kind: 'check-schematic' }))
    const codes = (all.checks as { code: string }[]).map((row) => row.code)
    expect(codes.length).toBeGreaterThan(0)
    const narrowed = asRecord(agent.check({ kind: 'check-schematic', codes: [codes[0]] }))
    expect((narrowed.checks as { code: string }[]).map((row) => row.code)).toEqual([codes[0]])
    // A code that found nothing answers its row at count 0, in code order.
    const clean = 'off-grid'
    expect(codes).not.toContain(clean)
    const both = asRecord(agent.check({ kind: 'check-schematic', codes: [clean, codes[0]] }))
    expect(both.checks).toEqual(
      [codes[0], clean].sort().map((code) => expect.objectContaining({ code }))
    )
    expect((both.checks as Array<{ code: string }>).find((row) => row.code === clean)).toEqual({
      code: clean,
      count: 0,
      items: [],
      rule: expect.any(String)
    })
    const miss = asRecord(agent.check({ kind: 'check-schematic', codes: ['unconnected-pins'] }))
    expect(miss.error).toBe('unknown-check-code')
    expect(miss.candidates).toContain('unconnected-pin')
  })

  test('render without anything to draw into says so', async () => {
    const answer = asRecord(
      await createSheetAgent(fakeSheet().ctx).render({ kind: 'render-sheet', maxPixels: 512 })
    )
    expect(answer.error).toBe('renderer-failed')
  })
})

describe('wires and the tidy behind them', () => {
  const extra = (items: string): string => SOURCE.replace('  (symbol\n', `${items}\n  (symbol\n`)
  const wireAt = (a: [number, number], b: [number, number], uuid: string): string =>
    `  (wire (pts (xy ${a[0]} ${a[1]}) (xy ${b[0]} ${b[1]})) (stroke (width 0) (type default)) (uuid "${uuid}"))`
  const labelAt = (text: string, x: number, y: number): string =>
    `  (label "${text}" (at ${x} ${y} 0) (effects (font (size 1.27 1.27)) (justify left bottom)) (uuid "l-${text}"))`

  test('a run already on the sheet is not drawn again, in either direction', async () => {
    const sheet = fakeSheet()
    const answer = asRecord(
      await createSheetAgent(sheet.ctx).dispatch({
        kind: 'draw-wire',
        start: { x: 63.5, y: 52.07 },
        end: { pin: 'R1.1' }
      })
    )
    expect(answer.alreadyDrawn).toBe(true)
    expect(sheet.commands).toEqual([])
    expect(sheet.document().wires).toHaveLength(1)
  })

  test("a run along another net's wire is refused", async () => {
    const sheet = fakeSheet(
      extra([wireAt([70, 40], [70, 60], 'other'), labelAt('A', 70, 40)].join('\n'))
    )
    const answer = asRecord(
      await createSheetAgent(sheet.ctx).dispatch({
        kind: 'draw-wire',
        start: { x: 70, y: 35 },
        end: { x: 70, y: 65 }
      })
    )
    expect(answer.error).toBe('would-overlap')
    expect(String(answer.detail)).toContain('A')
    expect(sheet.commands).toEqual([])
  })

  test('joining two named nets is refused until merge is said', async () => {
    const sheet = fakeSheet(
      extra([wireAt([80, 52.07], [90, 52.07], 'b'), labelAt('B', 90, 52.07)].join('\n'))
    )
    const agent = createSheetAgent(sheet.ctx)
    const request = {
      kind: 'draw-wire' as const,
      start: { x: 63.5, y: 52.07 },
      end: { x: 80, y: 52.07 }
    }
    const refused = asRecord(await agent.dispatch(request))
    expect(refused.error).toBe('would-merge')
    expect(refused.candidates).toEqual(['/B', '/VBUS'])
    const drawn = asRecord(await agent.dispatch({ ...request, merge: true }))
    expect(drawn.wired).toBeDefined()
    // The joint at 80 has nothing else on it and merges; the one at 63.5
    // carries the VBUS label and stays a joint.
    expect(asRecord(drawn.cleanup).wiresMerged).toBe(1)
    expect(sheet.document().wires.map((wire) => wire.points.map((p) => p.x / 1e6))).toEqual([
      [50.8, 63.5],
      [63.5, 90]
    ])
  })

  test('cleanup on demand removes a duplicate and the dots it earned', async () => {
    const sheet = fakeSheet(
      extra(
        [
          wireAt([63.5, 52.07], [50.8, 52.07], 'twice'),
          '  (junction (at 50.8 52.07) (diameter 0) (color 0 0 0 0) (uuid "j1"))',
          '  (junction (at 63.5 52.07) (diameter 0) (color 0 0 0 0) (uuid "j2"))'
        ].join('\n')
      )
    )
    const answer = asRecord(
      await createSheetAgent(sheet.ctx).dispatch({ kind: 'cleanup-schematic' })
    )
    expect(answer.cleanup).toEqual({
      wiresRemoved: 1,
      wiresMerged: 0,
      junctionsRemoved: 2,
      junctionsAdded: 0,
      wiresSplit: 0
    })
    expect(sheet.commands).toEqual(['commandLabels.cleanup'])
    expect(sheet.document().wires).toHaveLength(1)
    expect(sheet.document().junctions).toHaveLength(0)
  })
})

describe('Footprint writes warn about the pads', () => {
  const withPads = (pads: Record<string, string[]>): ReturnType<typeof fakeSheet> => {
    const sheet = fakeSheet()
    sheet.ctx.footprintPads = async (libId) => pads[libId] ?? null
    return sheet
  }

  test('bind says nothing when the pads match the pins', async () => {
    const sheet = withPads({ 'R:0402': ['1', '2'] })
    const answer = asRecord(
      await createSheetAgent(sheet.ctx).bind({
        kind: 'bind-part',
        reference: 'R1',
        properties: { Footprint: 'R:0402' }
      })
    )
    expect(answer.warnings).toBeUndefined()
  })

  test('bind warns on a pad count and on numbers that differ, and still writes', async () => {
    const sheet = withPads({ 'SOT:23': ['1', '2', '3'] })
    const answer = asRecord(
      await createSheetAgent(sheet.ctx).bind({
        kind: 'bind-part',
        reference: 'R1',
        properties: { Footprint: 'SOT:23' }
      })
    )
    expect(answer.warnings).toEqual([
      { code: 'pad-count', message: 'SOT:23 has 3 numbered pads and Device:R has 2 pins.' },
      expect.objectContaining({
        code: 'pin-mismatch',
        matched: 2,
        padsWithoutPin: ['3'],
        pinsWithoutPad: []
      })
    ])
    expect(sheet.commands).toEqual(['commandLabels.bindPart'])
  })

  test('place warns the same way, and an unreadable footprint warns nothing', async () => {
    const sheet = withPads({ 'X:ONE': ['1'] })
    const agent = createSheetAgent(sheet.ctx)
    const warned = asRecord(
      await agent.place({
        kind: 'place-symbol',
        libId: 'Device:R',
        at: { x: 76.2, y: 54.61 },
        properties: { Footprint: 'X:ONE' }
      })
    )
    expect((warned.warnings as Array<{ code: string }>).map((w) => w.code)).toEqual([
      'pad-count',
      'pin-mismatch'
    ])
    const quiet = asRecord(
      await agent.place({
        kind: 'place-symbol',
        libId: 'Device:R',
        at: { x: 88.9, y: 54.61 },
        properties: { Footprint: 'X:MISSING' }
      })
    )
    expect(quiet.warnings).toBeUndefined()
  })
})

describe('the next unit of a part', () => {
  const pin = (number: string, x: number, angle: number): string =>
    `(pin passive line (at ${x} 0 ${angle}) (length 2.54)
          (name "~" (effects (font (size 1.27 1.27))))
          (number "${number}" (effects (font (size 1.27 1.27)))))`
  /** A two-unit part, U5, with unit A placed, a footprint and an MPN. */
  const DUAL = SOURCE.replace(
    '  )\n  (no_connect',
    `    (symbol "Amp:Dual"
      (property "Reference" "U" (at 0 0 0))
      (property "Value" "Dual" (at 0 0 0))
      (property "Footprint" "" (at 0 0 0))
      (symbol "Dual_1_1" ${pin('1', -5.08, 0)} ${pin('2', 5.08, 180)})
      (symbol "Dual_2_1" ${pin('3', -5.08, 0)} ${pin('4', 5.08, 180)}))
  )
  (no_connect`
  ).replace(
    '  (sheet_instances',
    `  (symbol
    (lib_id "Amp:Dual")
    (at 101.6 50.8 0)
    (unit 1)
    (in_bom yes)
    (on_board yes)
    (dnp yes)
    (uuid "u5a-uuid")
    (property "Reference" "U5" (at 0 0 0) (effects (font (size 1.27 1.27))))
    (property "Value" "LM358" (at 0 0 0) (effects (font (size 1.27 1.27))))
    (property "Footprint" "Package_SO:SOIC-8" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
    (property "MPN" "LM358DR" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
    (pin "1" (uuid "u5a-1"))
    (pin "2" (uuid "u5a-2"))
    (instances (project "proj" (path "/root-uuid" (reference "U5") (unit 1)))))
  (sheet_instances`
  )
  const dualSheet = (): ReturnType<typeof fakeSheet> => {
    const sheet = fakeSheet(DUAL)
    sheet.ctx.availableSymbols = () => [
      { libId: 'Device:R', sheet: sheet.document() },
      { libId: 'Amp:Dual', sheet: sheet.document() }
    ]
    return sheet
  }
  const placeUnit = async (
    sheet: ReturnType<typeof fakeSheet>,
    extra: Partial<McpPlaceRequest>
  ): Promise<Record<string, unknown>> =>
    asRecord(
      await createSheetAgent(sheet.ctx).place({
        kind: 'place-symbol',
        libId: 'Amp:Dual',
        reference: 'U5',
        at: { x: 127, y: 50.8 },
        ...extra
      })
    )
  const units = (sheet: ReturnType<typeof fakeSheet>): KicadSchematicSymbol[] =>
    sheet.document().symbols.filter((symbol) => getSymbolProperty(symbol, 'Reference') === 'U5')

  test('unit B under U5 is one part with two units, with the part fields and flags', async () => {
    const sheet = dualSheet()
    const answer = await placeUnit(sheet, { unit: 2 })
    expect(answer.error).toBeUndefined()
    const placed = asRecord(answer.placed)
    expect(placed.unit).toBe(2)
    expect((placed.pins as Array<{ number: string }>).map((row) => row.number)).toEqual(['3', '4'])
    const [a, b] = units(sheet)
    expect(b.unit).toBe(2)
    expect(b.instances[0]).toMatchObject({ reference: 'U5', unit: 2 })
    for (const key of ['Value', 'Footprint', 'MPN'])
      expect(getSymbolProperty(b, key)).toBe(getSymbolProperty(a, key))
    expect(b.dnp).toBe(true)
    const records = buildProjectComponentRecords(sheet.ctx.sheetSources())
    const u5 = records.filter((record) => record.reference === 'U5')
    expect(u5).toHaveLength(1)
    expect(u5[0].locations).toHaveLength(2)
  })

  test('a placed unit, another symbol, a missing unit, a bare used reference and other fields are refused', async () => {
    const taken = await placeUnit(dualSheet(), { unit: 1 })
    expect(taken.error).toBe('unit-taken')
    expect(taken.candidates).toEqual(['2 (U5B)'])
    expect(
      (await placeUnit(dualSheet(), { libId: 'Device:R', unit: 2, at: { x: 127, y: 54.61 } })).error
    ).toBe('unit-symbol-mismatch')
    const missing = await placeUnit(dualSheet(), { unit: 3 })
    expect(missing.error).toBe('unit-not-found')
    expect(missing.candidates).toEqual(['2 (U5B)'])
    expect((await placeUnit(dualSheet(), {})).error).toBe('reference-taken')
    expect((await placeUnit(dualSheet(), { unit: 2, value: 'TL072' })).error).toBe('unit-fields')
    const sheet = dualSheet()
    await placeUnit(sheet, { unit: 2, value: 'LM358' })
    expect(units(sheet)).toHaveLength(2)
  })

  test('a field or flag written on one unit is written on every unit', async () => {
    const sheet = dualSheet()
    await placeUnit(sheet, { unit: 2 })
    const agent = createSheetAgent(sheet.ctx)
    await agent.dispatch({ kind: 'update-item', id: 'U5', value: 'TL072', dnp: false })
    expect(units(sheet).map((unit) => [getSymbolProperty(unit, 'Value'), unit.dnp])).toEqual([
      ['TL072', false],
      ['TL072', false]
    ])
    await agent.dispatch({ kind: 'update-item', id: 'U5#MPN', value: 'TL072CDR' })
    expect(units(sheet).map((unit) => getSymbolProperty(unit, 'MPN'))).toEqual([
      'TL072CDR',
      'TL072CDR'
    ])
    await agent.bind({ kind: 'bind-part', reference: 'U5', properties: { LCSC: 'C6961' } })
    expect(units(sheet).map((unit) => getSymbolProperty(unit, 'LCSC'))).toEqual(['C6961', 'C6961'])
  })

  test('the Reference field takes no value', async () => {
    const sheet = dualSheet()
    const answer = asRecord(
      await createSheetAgent(sheet.ctx).dispatch({
        kind: 'update-item',
        id: 'U5#Reference',
        value: 'U9'
      })
    )
    expect(answer.error).toBe('not-applicable')
    expect(answer.detail).toContain('schematic_annotate')
    expect(sheet.commands).toEqual([])
  })
  const idsOf = (rows: unknown): string[] => (rows as Array<{ id: string }>).map((row) => row.id)

  test('each unit answers to its own id, U5A and U5B, and U5 reads as both', async () => {
    const sheet = dualSheet()
    const placed = asRecord((await placeUnit(sheet, { unit: 2 })).placed)
    expect(placed).toMatchObject({ id: 'U5B', reference: 'U5', unit: 2 })
    const agent = createSheetAgent(sheet.ctx)
    expect(idsOf(asRecord(agent.describe()).symbols)).toEqual(['R1', 'U5A', 'U5B'])
    const found = asRecord(await agent.dispatch({ kind: 'query-items', itemKind: 'symbol' }))
    expect(idsOf(found.items).sort()).toEqual(['R1', 'U5A', 'U5B'])
    const read = asRecord(await agent.dispatch({ kind: 'get-items', ids: ['U5'] }))
    const records = read.items as Array<{ id: string; pins: Array<{ id: string }> }>
    expect(records.map((record) => record.id)).toEqual(['U5A', 'U5B'])
    expect(records[1].pins.map((pin) => pin.id)).toEqual(['U5.3', 'U5.4'])
  })

  test('moving U5B moves only it; moving or deleting U5 is refused with its units', async () => {
    const sheet = dualSheet()
    await placeUnit(sheet, { unit: 2 })
    const agent = createSheetAgent(sheet.ctx)
    const moved = asRecord(
      await agent.dispatch({ kind: 'update-item', id: 'U5B', at: { x: 127, y: 76.2 } })
    )
    expect(moved.error).toBeUndefined()
    expect(asRecord(moved.changed).updated).toContain('U5B')
    const [a, b] = units(sheet)
    expect([nmToMm(a.position.x), nmToMm(a.position.y)]).toEqual([101.6, 50.8])
    expect([nmToMm(b.position.x), nmToMm(b.position.y)]).toEqual([127, 76.2])

    const whole = asRecord(await agent.dispatch({ kind: 'update-item', id: 'U5', angle: 90 }))
    expect(whole.error).toBe('unit-required')
    expect(whole.candidates).toEqual(['U5A', 'U5B'])
    const gone = asRecord(await agent.dispatch({ kind: 'delete-items', ids: ['U5'] }))
    expect(gone.error).toBe('unit-required')
    expect(units(sheet)).toHaveLength(2)
  })

  test('with one unit placed, U5 is that unit: it moves and deletes', async () => {
    const sheet = dualSheet()
    const agent = createSheetAgent(sheet.ctx)
    const moved = asRecord(await agent.dispatch({ kind: 'update-item', id: 'U5', angle: 90 }))
    expect(moved.error).toBeUndefined()
    expect(asRecord(moved.changed).updated).toContain('U5A')
    const gone = asRecord(await agent.dispatch({ kind: 'delete-items', ids: ['U5'] }))
    expect(gone.error).toBeUndefined()
    expect(units(sheet)).toHaveLength(0)
  })

  test("the project's separator and numeric first id give U5.1 and U5.2", async () => {
    const sheet = dualSheet()
    sheet.ctx.subpart = () => ({ separator: '.'.charCodeAt(0), firstId: '1'.charCodeAt(0) })
    const placed = asRecord((await placeUnit(sheet, { unit: 2 })).placed)
    expect(placed.id).toBe('U5.2')
    expect(idsOf(asRecord(createSheetAgent(sheet.ctx).describe()).symbols)).toEqual([
      'R1',
      'U5.1',
      'U5.2'
    ])
  })

  test('unit candidates take the ids the units would, by the project and the library', async () => {
    const sheet = dualSheet()
    sheet.ctx.subpart = () => ({ separator: '.'.charCodeAt(0), firstId: '1'.charCodeAt(0) })
    const taken = await placeUnit(sheet, { unit: 1 })
    expect(taken.error).toBe('unit-taken')
    expect(taken.detail).toContain('U5.1 is already placed')
    expect(taken.candidates).toEqual(['2 (U5.2)'])
    expect((await placeUnit(sheet, { unit: 3 })).candidates).toEqual(['2 (U5.2)'])

    const named = fakeSheet(
      DUAL.replace('(symbol "Dual_2_1" ', '(symbol "Dual_2_1" (unit_name "Out") ')
    )
    named.ctx.availableSymbols = () => [{ libId: 'Amp:Dual', sheet: named.document() }]
    named.ctx.subpart = () => ({ separator: '.'.charCodeAt(0), firstId: '1'.charCodeAt(0) })
    expect((await placeUnit(named, { unit: 1 })).candidates).toEqual(['2 (U5.Out)'])
  })

  test("a library's unit name stands for the letter", async () => {
    const sheet = fakeSheet(
      DUAL.replace('(symbol "Dual_1_1" ', '(symbol "Dual_1_1" (unit_name "Amp") ')
    )
    expect(idsOf(asRecord(createSheetAgent(sheet.ctx).describe()).symbols)).toEqual(['R1', 'U5Amp'])
  })
})

describe('wiring the hierarchy', () => {
  const box = (
    uuid: string,
    name: string,
    x: number,
    pin: string,
    pinX: number,
    angle: number
  ): string =>
    `  (sheet (at ${x} 76.2) (size 25.4 20.32) (uuid "${uuid}")
    (property "Sheetname" "${name}" (at ${x} 75 0) (effects (font (size 1.27 1.27))))
    (property "Sheetfile" "${name.toLowerCase()}.kicad_sch" (at ${x} 97 0) (effects (font (size 1.27 1.27))))
    (pin "${pin}" bidirectional (at ${pinX} 81.28 ${angle}) (effects (font (size 1.27 1.27))) (uuid "${uuid}-pin")))
`
  /** A child sheet: one hierarchical label, and an open resistor R7 when `open`. */
  const child = (uuid: string, label: string, open = false): KicadSchematic =>
    parseKicadSchematic(
      SOURCE.replace('(uuid "root-uuid")', `(uuid "${uuid}")`)
        .replace(/ {2}\(no_connect[\s\S]*?\(uuid "label-uuid"\)\)\n/, '')
        .replace('"R1"', '"R7"')
        .replace(
          '  (sheet_instances',
          `  (hierarchical_label "${label}" (shape bidirectional) (at 25.4 25.4 0)
    (effects (font (size 1.27 1.27)) (justify left)) (uuid "${uuid}-hl"))
  (sheet_instances`
        )
        .replace(
          open ? '' : /\(symbol\n {4}\(lib_id "Device:R"\)[\s\S]*?\(pin "2" \(uuid "pin-2"\)\)\)\n/,
          ''
        )
    )

  /** The root with MCU and Power blocks side by side, each child read beside it. */
  const hierarchy = (powerPin = 'USB_DP', open = false): ReturnType<typeof fakeSheet> => {
    const sheet = fakeSheet(
      SOURCE.replace(
        '  (sheet_instances',
        `${box('mcu-uuid', 'MCU', 50.8, 'USB_DP', 76.2, 0)}${box('power-uuid', 'Power', 127, powerPin, 127, 180)}  (sheet_instances`
      )
    )
    const mcu = child('mcu-file', 'USB_DP', open)
    const power = child('power-file', powerPin)
    const inputs = (): SheetConnectivityInput[] => [
      { sheetPath: '/root-uuid', namePath: '/', schematic: sheet.document() },
      { sheetPath: '/root-uuid/mcu-uuid', namePath: '/MCU', schematic: mcu },
      { sheetPath: '/root-uuid/power-uuid', namePath: '/Power', schematic: power }
    ]
    sheet.ctx.connectivityInputs = inputs
    sheet.ctx.connectivity = () => buildConnectivity(inputs())
    sheet.ctx.sheetSources = () =>
      inputs().map((input, index) => ({
        schematic: input.schematic,
        sheetPath: input.sheetPath,
        sheetName: input.namePath,
        filePath: ['/proj/root.kicad_sch', '/proj/mcu.kicad_sch', '/proj/power.kicad_sch'][index]
      }))
    return sheet
  }

  test('a wire joins two sheet pins of one name without merge, and names them by id', async () => {
    const sheet = hierarchy()
    const answer = asRecord(
      await createSheetAgent(sheet.ctx).dispatch({
        kind: 'draw-wire',
        start: { pin: 'mcu-uuid#USB_DP' },
        end: { pin: 'power-uuid#USB_DP' }
      })
    )
    expect(answer.error).toBeUndefined()
    expect(asRecord(answer.wired)).toMatchObject({
      from: 'mcu-uuid#USB_DP',
      to: 'power-uuid#USB_DP',
      points: [
        { x: 76.2, y: 81.28 },
        { x: 127, y: 81.28 }
      ]
    })
  })

  test('two sheet pins of different names still need merge', async () => {
    const answer = asRecord(
      await createSheetAgent(hierarchy('USB_DM').ctx).dispatch({
        kind: 'draw-wire',
        start: { pin: 'mcu-uuid#USB_DP' },
        end: { pin: 'power-uuid#USB_DM' }
      })
    )
    expect(answer.error).toBe('would-merge')
  })

  test('connect labels a sheet pin from its edge outward', async () => {
    const sheet = hierarchy()
    const answer = asRecord(
      await createSheetAgent(sheet.ctx).connect({
        kind: 'connect-pins',
        net: 'D_P',
        pins: ['mcu-uuid#USB_DP'],
        merge: true
      })
    )
    expect(asRecord(answer.connected).labelled).toEqual(['mcu-uuid#USB_DP'])
    const label = sheet.document().labels.find((candidate) => candidate.text === 'D_P')
    expect(label?.position).toMatchObject({ x: mmToNm(76.2), y: mmToNm(81.28), angle: 0 })
  })

  test('check with sheet answers its findings and counts the rest; describe keeps to the sheet', () => {
    const sheet = hierarchy('USB_DP', true)
    const agent = createSheetAgent(sheet.ctx)
    const whole = asRecord(agent.check({ kind: 'check-schematic' }))
    expect(JSON.stringify(whole.checks)).toContain('R7')
    const mine = asRecord(agent.check({ kind: 'check-schematic', sheet: 'root.kicad_sch' }))
    expect(JSON.stringify(mine.checks)).not.toContain('R7')
    const counts = asRecord(mine.counts)
    const wholeCounts = asRecord(whole.counts)
    expect(counts.elsewhere).toBeGreaterThan(0)
    expect(
      (counts.error as number) + (counts.warning as number) + (counts.elsewhere as number)
    ).toBe((wholeCounts.error as number) + (wholeCounts.warning as number))

    const described = asRecord(agent.describe())
    expect(JSON.stringify(described.nets)).not.toContain('R7')
    expect(JSON.stringify(described.unconnected)).not.toContain('R7')
    expect(asRecord(described.counts)).toMatchObject({ unconnectedElsewhere: 2 })
    expect(asRecord(described.counts).netsElsewhere).toBeGreaterThan(0)
  })
})

describe('a sheet box size', () => {
  /** A 25.4 × 20.32 box at (50.8, 76.2): pin L on the left, R on the right with a wire, B on the bottom. */
  const BOXED = SOURCE.replace(
    '  (sheet_instances',
    `  (sheet (at 50.8 76.2) (size 25.4 20.32) (uuid "box-uuid")
    (property "Sheetname" "Power" (at 50.8 75 0) (effects (font (size 1.27 1.27))))
    (property "Sheetfile" "power.kicad_sch" (at 50.8 97.79 0) (effects (font (size 1.27 1.27))))
    (pin "L" input (at 50.8 81.28 180) (effects (font (size 1.27 1.27))) (uuid "pl"))
    (pin "R" output (at 76.2 88.9 0) (effects (font (size 1.27 1.27))) (uuid "pr"))
    (pin "B" passive (at 60.96 96.52 270) (effects (font (size 1.27 1.27))) (uuid "pb")))
  (wire (pts (xy 76.2 88.9) (xy 88.9 88.9)) (stroke (width 0) (type default)) (uuid "w-r"))
  (sheet_instances`
  )
  const resize = async (
    sheet: ReturnType<typeof fakeSheet>,
    size: { width: number; height: number }
  ): Promise<Record<string, unknown>> =>
    asRecord(
      await createSheetAgent(sheet.ctx).dispatch({ kind: 'update-item', id: 'box-uuid', size })
    )
  const pinAt = (sheet: ReturnType<typeof fakeSheet>, name: string): { x: number; y: number } => {
    const pin = sheet.document().sheets[0].pins.find((candidate) => candidate.name === name)
    if (!pin) throw new Error(`no pin ${name}`)
    return { x: nmToMm(pin.position.x), y: nmToMm(pin.position.y) }
  }

  test('a resize keeps each pin on its edge and in its place along it, and reads back', async () => {
    const sheet = fakeSheet(BOXED)
    const answer = await resize(sheet, { width: 38.1, height: 25.4 })
    expect(answer.error).toBeUndefined()
    expect(pinAt(sheet, 'L')).toEqual({ x: 50.8, y: 81.28 })
    expect(pinAt(sheet, 'R')).toEqual({ x: 88.9, y: 88.9 })
    expect(pinAt(sheet, 'B')).toEqual({ x: 60.96, y: 101.6 })
    expect(answer.unwired).toEqual(['box-uuid#R'])
    expect(asRecord(answer.changed).updated).toEqual(['box-uuid', 'box-uuid#R', 'box-uuid#B'])
    const read = asRecord(
      await createSheetAgent(sheet.ctx).dispatch({ kind: 'get-items', ids: ['box-uuid'] })
    )
    expect((read.items as Array<Record<string, unknown>>)[0].size).toEqual({
      width: 38.1,
      height: 25.4
    })
  })

  test('a size that cannot reach past its pins, or puts a moved pin off grid, is refused', async () => {
    const sheet = fakeSheet(BOXED)
    const small = await resize(sheet, { width: 25.4, height: 10.16 })
    expect(small.error).toBe('sheet-too-small')
    expect(small.detail).toContain('11.43 × 13.97 mm')
    expect(small.detail).toContain('R (right)')
    const narrow = await resize(sheet, { width: 7.62, height: 20.32 })
    expect(narrow.error).toBe('sheet-too-small')
    expect(narrow.detail).toContain('B (bottom)')
    const off = await resize(sheet, { width: 26, height: 20.32 })
    expect(off.error).toBe('off-grid')
    expect(off.detail).toContain('width 25.4 mm')
    expect(sheet.commands).toEqual([])
  })
})

describe('updating and changing placed symbols', () => {
  const PIN = (number: string, x: number, y: number, angle: number): string =>
    `(pin passive line (at ${x} ${y} ${angle}) (length 1.27)
          (name "P${number}" (effects (font (size 1.27 1.27))))
          (number "${number}" (effects (font (size 1.27 1.27)))))`

  /**
   * The libraries as they are now: R's pin 1 out at 5.08 mm and its pin 2
   * renumbered 3, a one-pin test point, and a dual part whose second unit's
   * pin moved.
   */
  const LIBRARY = parseKicadSchematic(`(kicad_sch (version 20231120) (uuid "lib")
  (lib_symbols
    (symbol "Device:R"
      (property "Reference" "R" (at 2.032 0 90) (effects (font (size 1.27 1.27))))
      (property "Value" "R" (at 0 0 90) (effects (font (size 1.27 1.27))))
      (symbol "R_1_1"
        ${PIN('1', 0, 5.08, 270)}
        ${PIN('3', 0, -5.08, 90)}))
    (symbol "Device:TP"
      (property "Reference" "TP" (at 0 0 0) (effects (font (size 1.27 1.27))))
      (property "Value" "TP" (at 0 0 0) (effects (font (size 1.27 1.27))))
      (symbol "TP_1_1"
        ${PIN('1', 0, 3.81, 270)}))
    (symbol "Amp:Dual"
      (property "Reference" "U" (at 0 0 0) (effects (font (size 1.27 1.27))))
      (property "Value" "Dual" (at 0 0 0) (effects (font (size 1.27 1.27))))
      (symbol "Dual_1_1"
        ${PIN('1', -5.08, 0, 0)})
      (symbol "Dual_2_1"
        ${PIN('2', -10.16, 0, 0)})))
)`)
  const lookup = (libId: string): KicadLibSymbol | undefined => LIBRARY.libSymbols.get(libId)

  const withLibrary = (source = SOURCE): ReturnType<typeof fakeSheet> => {
    const sheet = fakeSheet(source)
    sheet.ctx.librarySymbolLookup = lookup
    return sheet
  }

  const update = async (
    sheet: ReturnType<typeof fakeSheet>,
    request: Omit<McpUpdateSymbolsSchematicRequest, 'kind'>
  ): Promise<Record<string, unknown>> =>
    asRecord(
      await createSheetAgent(sheet.ctx).dispatch({ kind: 'update-symbols-schematic', ...request })
    )
  const rowsOf = (answer: Record<string, unknown>): Array<Record<string, unknown>> =>
    answer.symbols as Array<Record<string, unknown>>

  /** R1's pin 2 meets R2's pin 1 directly, with no wire between them. */
  const TOUCHING = SOURCE.replace('  (no_connect (at 50.8 59.69) (uuid "nc-uuid"))\n', '').replace(
    '  (sheet_instances',
    `  (symbol
    (lib_id "Device:R")
    (at 50.8 63.5 0)
    (unit 1)
    (in_bom yes)
    (on_board yes)
    (dnp no)
    (uuid "r2-uuid")
    (property "Reference" "R2" (at 0 0 0) (effects (font (size 1.27 1.27))))
    (property "Value" "1k" (at 0 0 0) (effects (font (size 1.27 1.27))))
    (pin "1" (uuid "r2-pin-1"))
    (pin "2" (uuid "r2-pin-2")))
  (sheet_instances`
  )

  test('an update names the pin that moved with its wire and the one that left its net', async () => {
    const sheet = withLibrary(TOUCHING)
    const answer = await update(sheet, { references: ['R1'], checks: true })
    const [row] = rowsOf(answer)
    expect(row).toMatchObject({
      reference: 'R1',
      from: 'Device:R',
      to: 'Device:R',
      units: 1,
      movedPins: [{ id: 'R1.1', from: { x: 50.8, y: 52.07 }, to: { x: 50.8, y: 50.8 } }],
      addedPins: ['R1.3']
    })
    const dropped = row.droppedPins as Array<{ id: string; net?: string }>
    expect(dropped.map((pin) => pin.id)).toEqual(['R1.2'])
    expect(dropped[0].net).toBeTruthy()
    expect(answer.guidance).toContain('droppedPins')
    expect(asRecord(answer.changed).updated).toEqual(['R1'])
    expect(answer.checks).toBeDefined()
    expect(sheet.commands).toEqual(['commandLabels.updateSymbols×1'])
    // The wire on pin 1 followed it; R2 kept the old copy, so R1's new one is filed beside it.
    const wires = sheet.document().wires.map((wire) => wire.points.map((p) => nmToMm(p.y)))
    expect(wires).toContainEqual([50.8, 50.8])
    expect(sheet.document().symbols.map((symbol) => symbol.libName)).toEqual(['R_1', undefined])
  })

  test('a change to another symbol is one undo step under the dialog label', async () => {
    const sheet = withLibrary()
    const answer = await update(sheet, { references: ['R1'], symbol: 'Device:TP' })
    expect(rowsOf(answer)[0]).toMatchObject({ from: 'Device:R', to: 'Device:TP' })
    expect((rowsOf(answer)[0].droppedPins as Array<{ id: string }>)[0].id).toBe('R1.2')
    expect(sheet.commands).toEqual(['commandLabels.changeSymbols×1'])
    const [r1] = sheet.document().symbols
    expect(r1.libId).toBe('Device:TP')
    expect(getSymbolProperty(r1, 'Reference')).toBe('R1')
    expect(sheet.document().libSymbols.has('Device:R')).toBe(false)
  })

  test('options are honored, and a dry run writes nothing', async () => {
    const dry = withLibrary()
    const before = dry.text()
    const preview = await update(dry, { references: ['R1'], dryRun: true })
    expect(preview.dryRun).toBe(true)
    expect(rowsOf(preview)[0].addedPins).toEqual(['R1.3'])
    expect(dry.text()).toBe(before)
    expect(dry.commands).toEqual([])

    const kept = withLibrary()
    await update(kept, { references: ['R1'] })
    expect(getSymbolProperty(kept.document().symbols[0], 'Value')).toBe('10k')
    const taken = withLibrary()
    await update(taken, { references: ['R1'], options: { updateValue: true } })
    expect(getSymbolProperty(taken.document().symbols[0], 'Value')).toBe('R')
  })

  /** U1 shown as both its units, drawn from the old copy of Amp:Dual. */
  const unit = (n: number, x: number): string => `  (symbol
    (lib_id "Amp:Dual")
    (at ${x} 76.2 0)
    (unit ${n})
    (in_bom yes)
    (on_board yes)
    (dnp no)
    (uuid "u1-${n}")
    (property "Reference" "U1" (at 0 0 0) (effects (font (size 1.27 1.27))))
    (property "Value" "Dual" (at 0 0 0) (effects (font (size 1.27 1.27))))
    (pin "${n}" (uuid "u1-pin-${n}"))
    (instances (project "proj" (path "/root-uuid" (reference "U1") (unit ${n})))))
`
  const dual = (units: string): string =>
    SOURCE.replace(
      '  )\n  (no_connect',
      `    (symbol "Amp:Dual"
      (property "Reference" "U" (at 0 0 0) (effects (font (size 1.27 1.27))))
      (property "Value" "Dual" (at 0 0 0) (effects (font (size 1.27 1.27))))
      (symbol "Dual_1_1"
        ${PIN('1', -5.08, 0, 0)})
      (symbol "Dual_2_1"
        ${PIN('2', -7.62, 0, 0)}))
  )
  (no_connect`
    ).replace('  (sheet_instances', `${units}  (sheet_instances`)
  const DUAL = dual(`${unit(1, 101.6)}${unit(2, 127)}`)

  test('a multi-unit part updates every unit, and keeps a unit the new symbol lacks', async () => {
    const sheet = withLibrary(DUAL)
    const answer = await update(sheet, { references: ['U1'] })
    expect(rowsOf(answer)).toEqual([
      {
        reference: 'U1',
        from: 'Amp:Dual',
        to: 'Amp:Dual',
        units: 2,
        movedPins: [{ id: 'U1.2', from: { x: 119.38, y: 76.2 }, to: { x: 116.84, y: 76.2 } }]
      }
    ])
    expect(sheet.commands).toEqual(['commandLabels.updateSymbols×2'])
    const units = sheet.document().symbols.filter((s) => s.libId === 'Amp:Dual')
    expect(units.map((s) => s.libName)).toEqual([undefined, undefined])

    // KiCad's processSymbols: unit A changes, unit B has no counterpart and stays.
    const short = withLibrary(DUAL)
    const changed = await update(short, { match: 'Amp:Dual', symbol: 'Device:TP' })
    expect(rowsOf(changed)).toMatchObject([
      { reference: 'U1', from: 'Amp:Dual', to: 'Device:TP', units: 1 }
    ])
    expect(changed.skipped).toEqual([
      { id: 'U1B', reference: 'U1', libId: 'Device:TP', reason: 'unit-missing' }
    ])
    expect(asRecord(changed.counts).skipped).toBe(1)
    expect(changed.guidance).toContain('stays on its old one')
    expect(short.commands).toEqual(['commandLabels.changeSymbols×1'])
    const after = short.document()
    const shown = after.symbols.filter((s) => s.uuid?.startsWith('u1-'))
    expect(shown.map((s) => [s.unit, s.libId])).toEqual([
      [1, 'Device:TP'],
      [2, 'Amp:Dual']
    ])
    expect(after.libSymbols.has('Amp:Dual')).toBe(true)

    // A part showing only units the new symbol lacks has nothing to write.
    const none = withLibrary(dual(unit(2, 127)))
    const refused = await update(none, { references: ['U1'], symbol: 'Device:TP' })
    expect(refused.error).toBe('too-few-units')
    expect(refused.detail).toContain('Device:TP has no unit for U1B')
    expect(none.commands).toEqual([])
  })

  test('a reference the design lacks is refused with candidates', async () => {
    const answer = await update(withLibrary(), { references: ['R9'] })
    expect(answer.error).toBe('reference-not-found')
    expect(answer.candidates).toEqual(['R1'])
  })
})
