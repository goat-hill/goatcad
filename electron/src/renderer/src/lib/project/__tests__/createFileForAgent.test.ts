import { describe, expect, test } from 'vitest'
import {
  createFileForAgent,
  refuseFileName,
  type CreateFileAnswer,
  type CreateFileIo
} from '../createFileForAgent'

const PROJECT = { path: '/p/phone.kicad_pro', dir: '/p' }

const SYM_TABLE = `(sym_lib_table
  (version 7)
  (lib (name "phone")(type "KiCad")(uri "\${KIPRJMOD}/phone.kicad_sym")(options "")(descr ""))
)`

interface Recorded {
  io: CreateFileIo
  files: Map<string, string>
  libraries: string[]
  announced: Array<{ path: string; nickname?: string }>
  opened: string[]
}

const recorder = (
  names: string[] = ['phone.kicad_pro', 'phone.kicad_sch', 'phone.kicad_pcb'],
  tables: Partial<Record<'symbol' | 'footprint', string>> = {}
): Recorded => {
  const recorded: Recorded = {
    files: new Map(),
    libraries: [],
    announced: [],
    opened: [],
    io: {
      listNames: async () => names,
      createFile: async (path, content) => {
        recorded.files.set(path, content)
        return { success: true }
      },
      readTable: async (kind) => tables[kind] ?? null,
      createLibrary: async (kind, name) => {
        const path = `/p/${name}${kind === 'symbol' ? '.kicad_sym' : '.pretty'}`
        recorded.libraries.push(path)
        return path
      },
      announce: async (path, nickname) => {
        recorded.announced.push({ path, ...(nickname ? { nickname } : {}) })
      },
      openBehind: (path) => recorded.opened.push(path)
    }
  }
  return recorded
}

describe('project.create_file', () => {
  test('a board is the blank board file, announced and opened behind', async () => {
    const made = recorder()
    const answer = (await createFileForAgent(
      PROJECT,
      true,
      { fileKind: 'board', name: 'phone-v2' },
      made.io
    )) as CreateFileAnswer
    expect(answer).toMatchObject({
      path: '/p/phone-v2.kicad_pcb',
      kind: 'board',
      changed: { created: ['/p/phone-v2.kicad_pcb'], updated: [], deleted: [] },
      opened: true
    })
    expect(made.files.get('/p/phone-v2.kicad_pcb')).toMatch(/^\(kicad_pcb/)
    expect(made.announced).toEqual([{ path: '/p/phone-v2.kicad_pcb' }])
    expect(made.opened).toEqual(['/p/phone-v2.kicad_pcb'])
  })

  test('a sheet is the blank schematic', async () => {
    const made = recorder()
    await createFileForAgent(PROJECT, true, { fileKind: 'schematic', name: 'power' }, made.io)
    expect(made.files.get('/p/power.kicad_sch')).toMatch(/^\(kicad_sch/)
  })

  test('a symbol library is registered, the table updated when it exists', async () => {
    const made = recorder(undefined, { symbol: SYM_TABLE })
    const answer = (await createFileForAgent(
      PROJECT,
      true,
      { fileKind: 'symbol_library', name: 'radio' },
      made.io
    )) as CreateFileAnswer
    expect(answer).toMatchObject({
      path: '/p/radio.kicad_sym',
      library: 'radio',
      changed: { created: ['/p/radio.kicad_sym'], updated: ['/p/sym-lib-table'] },
      opened: true
    })
    expect(made.announced).toEqual([{ path: '/p/radio.kicad_sym', nickname: 'radio' }])
  })

  test('a footprint library is a registered folder, the table created, and no tab', async () => {
    const made = recorder()
    const answer = (await createFileForAgent(
      PROJECT,
      true,
      { fileKind: 'footprint_library', name: 'phone' },
      made.io
    )) as CreateFileAnswer
    expect(answer).toMatchObject({
      path: '/p/phone.pretty',
      changed: { created: ['/p/phone.pretty', '/p/fp-lib-table'], updated: [] },
      opened: false
    })
    expect(made.opened).toEqual([])
  })

  test('a taken name is refused with the file, and nothing is written', async () => {
    const made = recorder()
    const answer = await createFileForAgent(
      PROJECT,
      true,
      { fileKind: 'board', name: 'Phone' },
      made.io
    )
    expect(answer).toMatchObject({ error: 'name-taken', candidates: ['phone.kicad_pcb'] })
    expect(made.files.size).toBe(0)
  })

  test('a library name the table already has is refused, though no file carries it', async () => {
    const made = recorder(undefined, { symbol: SYM_TABLE })
    const answer = await createFileForAgent(
      PROJECT,
      true,
      { fileKind: 'symbol_library', name: 'PHONE' },
      made.io
    )
    expect(answer).toMatchObject({ error: 'name-taken', candidates: ['phone'] })
    expect(made.libraries).toEqual([])
  })

  test('no active project is refused by what is missing', async () => {
    const made = recorder()
    const request = { fileKind: 'board', name: 'x' } as const
    expect(await createFileForAgent(null, true, request, made.io)).toMatchObject({
      error: 'no-active-project'
    })
    expect(await createFileForAgent(null, false, request, made.io)).toMatchObject({
      error: 'no-project'
    })
  })
})

describe('refuseFileName', () => {
  test('checks each kind as its GUI path does', () => {
    expect(refuseFileName('board', '', [], [])).toMatchObject({ error: 'blank-name' })
    expect(refuseFileName('board', 'a/b', [], [])).toMatchObject({ error: 'bad-name' })
    expect(refuseFileName('schematic', 'con', [], [])).toMatchObject({ error: 'bad-name' })
    expect(refuseFileName('schematic', 'power.kicad_sch', [], [])).toMatchObject({
      error: 'bad-name'
    })
    expect(refuseFileName('footprint_library', 'a:b', [], [])).toMatchObject({ error: 'bad-name' })
    expect(refuseFileName('board', 'phone-v2', ['phone.kicad_pcb'], [])).toBeNull()
  })
})
