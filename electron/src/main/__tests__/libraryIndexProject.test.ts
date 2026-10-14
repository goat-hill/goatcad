import { describe, it, expect } from 'vitest'
import {
  buildProjectIndex,
  projectManifest,
  manifestEquals,
  parseSymLibTableLite,
  resolveKiprjmod,
  type ProjectDeps
} from '../libraryIndexProject'
import type { SymbolRecord } from '../libraryIndexTypes'

const SYM_LIB_TABLE = `(sym_lib_table
  (version 7)
  (lib (name "MyParts")(type "KiCad")(uri "\${KIPRJMOD}/MyParts.kicad_sym")(options "")(descr ""))
)`

const MY_PARTS = `(kicad_symbol_lib (version 20211014)
  (symbol "LED_RGB" (property "Value" "LED") (property "Footprint" ""))
)`

const SCH = `(kicad_sch (version 20231120)
  (lib_symbols
    (symbol "Device:R" (property "Value" "R") (property "Footprint" ""))
  )
  (symbol (lib_id "Device:R") (at 10 10 0)
    (property "Footprint" "Resistor_SMD:R_0402_1005Metric")
  )
)`

const files: Record<string, string> = {
  '/proj/sym-lib-table': SYM_LIB_TABLE,
  '/proj/MyParts.kicad_sym': MY_PARTS,
  '/proj/main.kicad_sch': SCH
}
const mtimes: Record<string, number> = {
  '/proj/sym-lib-table': 1,
  '/proj/MyParts.kicad_sym': 2,
  '/proj/main.kicad_sch': 3
}

const deps: ProjectDeps = {
  readFile: (p) => files[p] ?? null,
  listDir: (dir) =>
    Object.keys(files)
      .filter((p) => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes('/'))
      .map((p) => p.slice(dir.length + 1)),
  mtimeMs: (p) => mtimes[p] ?? 0
}

describe('resolveKiprjmod / parseSymLibTableLite', () => {
  it('expands ${KIPRJMOD} and zips name↔uri', () => {
    expect(resolveKiprjmod('${KIPRJMOD}/x.kicad_sym', '/proj')).toBe('/proj/x.kicad_sym')
    expect(parseSymLibTableLite(SYM_LIB_TABLE)).toEqual([
      { name: 'MyParts', uri: '${KIPRJMOD}/MyParts.kicad_sym' }
    ])
  })
})

describe('buildProjectIndex', () => {
  const idx = buildProjectIndex('/proj', deps)

  it('indexes project-tier libraries and embedded symbols at project scope', () => {
    const syms = idx.records.filter((r): r is SymbolRecord => r.type === 'symbol')
    expect(syms.every((s) => s.scope === 'project')).toBe(true)
    expect(syms.map((s) => s.id).sort()).toEqual(['Device:R', 'MyParts:LED_RGB'])
  })

  it('collects deduped placed footprint assignments', () => {
    expect(idx.assignments).toEqual([
      { symbol: 'Device:R', footprint: 'Resistor_SMD:R_0402_1005Metric' }
    ])
  })

  it('lists registered libraries with their resolved paths', () => {
    expect(idx.libraries).toEqual([
      {
        name: 'MyParts',
        file: '/proj/MyParts.kicad_sym',
        type: 'symbol',
        scope: 'project',
        readable: true
      }
    ])
  })

  it('lists an empty registered library even when it holds no parts', () => {
    // A just-created (or emptied) library: registered in the table, file present
    // but with no symbols. It must still surface so the Project view can show it.
    const emptyFiles: Record<string, string> = {
      '/p/sym-lib-table': `(sym_lib_table
        (lib (name "Fresh")(type "KiCad")(uri "\${KIPRJMOD}/Fresh.kicad_sym")(options "")(descr ""))
      )`,
      '/p/Fresh.kicad_sym': '(kicad_symbol_lib (version 20211014))'
    }
    const emptyDeps: ProjectDeps = {
      ...deps,
      readFile: (p) => emptyFiles[p] ?? null,
      mtimeMs: (p) => (p in emptyFiles ? 1 : 0)
    }
    const built = buildProjectIndex('/p', emptyDeps)
    expect(built.records.filter((r) => r.type === 'symbol')).toEqual([])
    expect(built.libraries).toEqual([
      {
        name: 'Fresh',
        file: '/p/Fresh.kicad_sym',
        type: 'symbol',
        scope: 'project',
        readable: true
      }
    ])
  })

  it('marks a registered library its table points at nothing for', () => {
    const goneFiles: Record<string, string> = {
      '/p/sym-lib-table': `(sym_lib_table
        (lib (name "Gone")(type "KiCad")(uri "\${KIPRJMOD}/Gone.kicad_sym")(options "")(descr ""))
      )`
    }
    const goneDeps: ProjectDeps = { ...deps, readFile: (p) => goneFiles[p] ?? null }
    expect(buildProjectIndex('/p', goneDeps).libraries).toEqual([
      { name: 'Gone', file: '/p/Gone.kicad_sym', type: 'symbol', scope: 'project', readable: false }
    ])
  })

  it('reports a manifest of every input file for the memo', () => {
    expect(idx.manifest).toEqual({
      '/proj/sym-lib-table': 1,
      '/proj/MyParts.kicad_sym': 2,
      '/proj/main.kicad_sch': 3
    })
    expect(manifestEquals(idx.manifest, projectManifest('/proj', deps))).toBe(true)
    expect(manifestEquals(idx.manifest, { '/proj/sym-lib-table': 9 })).toBe(false)
  })
})

describe('degrades on a project with no libraries', () => {
  it('returns empty, not a throw', () => {
    const empty: ProjectDeps = { readFile: () => null, listDir: () => [], mtimeMs: () => 0 }
    expect(buildProjectIndex('/nope', empty)).toEqual({
      records: [],
      assignments: [],
      libraries: [],
      manifest: {}
    })
  })
})

// --- project-tier footprint libraries (fp-lib-table) -------------------------

const FP_LIB_TABLE = `(fp_lib_table
  (version 7)
  (lib (name "Footprints")(type "KiCad")(uri "\${KIPRJMOD}/footprints.pretty")(options "")(descr ""))
)`

const MOD_R = `(footprint "R_0402" (layer "F.Cu")
  (descr "resistor 0402")
  (tags "resistor")
  (pad "1" smd rect (at -0.5 0) (size 0.5 0.6) (layers "F.Cu"))
  (pad "2" smd rect (at 0.5 0) (size 0.5 0.6) (layers "F.Cu"))
)`

const fpFiles: Record<string, string> = {
  ...files,
  '/proj/fp-lib-table': FP_LIB_TABLE,
  '/proj/footprints.pretty/R_0402.kicad_mod': MOD_R,
  // Not a footprint; must be skipped rather than parsed.
  '/proj/footprints.pretty/README.md': 'notes'
}
const fpMtimes: Record<string, number> = {
  ...mtimes,
  '/proj/fp-lib-table': 4,
  '/proj/footprints.pretty': 5,
  '/proj/footprints.pretty/R_0402.kicad_mod': 6
}

const fpDeps: ProjectDeps = {
  readFile: (p) => fpFiles[p] ?? null,
  listDir: (dir) =>
    Object.keys(fpFiles)
      .filter((p) => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes('/'))
      .map((p) => p.slice(dir.length + 1)),
  mtimeMs: (p) => fpMtimes[p] ?? 0
}

describe('project footprint libraries', () => {
  const idx = buildProjectIndex('/proj', fpDeps)
  const footprints = idx.records.filter((r) => r.type === 'footprint')

  it('indexes the .kicad_mod files inside a registered .pretty', () => {
    expect(footprints).toHaveLength(1)
    expect(footprints[0]).toMatchObject({
      type: 'footprint',
      name: 'R_0402',
      // The nickname from the table, not the directory name — the nickname is
      // the part's identity in a lib_id.
      library: 'Footprints',
      scope: 'project'
    })
  })

  it('lists the registered .pretty as a footprint library', () => {
    expect(idx.libraries).toContainEqual({
      name: 'Footprints',
      file: '/proj/footprints.pretty',
      type: 'footprint',
      scope: 'project',
      readable: true
    })
  })

  it('names a footprint by its file, whatever its own token says, as KiCad does', () => {
    const renamedFiles = {
      ...fpFiles,
      '/proj/footprints.pretty/R_0402.kicad_mod': MOD_R.replace('"R_0402"', '"Vendor:R-0402"')
    }
    const renamed = buildProjectIndex('/proj', {
      ...fpDeps,
      readFile: (p) => renamedFiles[p] ?? null
    }).records.find((r) => r.type === 'footprint')
    expect(renamed).toMatchObject({ id: 'Footprints:R_0402', name: 'R_0402' })
  })

  it('ignores non-footprint files sitting in the library directory', () => {
    expect(footprints.some((r) => r.file.endsWith('README.md'))).toBe(false)
  })

  it('yields nothing when no fp-lib-table registers a library', () => {
    // A `.pretty` present in the folder but unregistered is not a project
    // library — registration is what membership means here.
    expect(buildProjectIndex('/proj', deps).records.some((r) => r.type === 'footprint')).toBe(false)
  })

  it('tracks the table and each library directory for invalidation', () => {
    const manifest = projectManifest('/proj', fpDeps)
    expect(manifest['/proj/fp-lib-table']).toBe(4)
    // The directory, not each `.kicad_mod`: one stat per library, since a
    // registered .pretty can hold thousands of files.
    expect(manifest['/proj/footprints.pretty']).toBe(5)
    expect(manifest['/proj/footprints.pretty/R_0402.kicad_mod']).toBeUndefined()
  })

  it('invalidates when a footprint is added to the library', () => {
    const before = projectManifest('/proj', fpDeps)
    fpMtimes['/proj/footprints.pretty'] = 99
    const after = projectManifest('/proj', fpDeps)
    fpMtimes['/proj/footprints.pretty'] = 5
    expect(manifestEquals(before, after)).toBe(false)
  })
})
