import { describe, expect, test } from 'vitest'
import {
  applyRename,
  planDelete,
  planRename,
  previewFiles,
  renamedPath,
  rewriteBufferText,
  verifyRename,
  type RenameIo
} from '../renamePlan'

const sheetDoc = (uuid: string, sheets: Array<{ name: string; file: string }>): string =>
  `(kicad_sch
  (version 20231120)
  (uuid "${uuid}")
${sheets
  .map(
    (sheet, i) => `  (sheet (at 0 0) (size 10 10) (uuid "sheet-${i}")
    (property "Sheetname" "${sheet.name}" (at 0 0 0))
    (property "Sheetfile" "${sheet.file}" (at 0 0 0)))`
  )
  .join('\n')}
)
`

/** In-memory filesystem implementing the full RenameIo, with a rename log. */
const makeIo = (
  files: Record<string, string>
): RenameIo & { files: Record<string, string>; renames: Array<[string, string]> } => {
  const renames: Array<[string, string]> = []
  const io = {
    files,
    renames,
    async readFile(path: string) {
      return path in files ? files[path] : null
    },
    async writeFile(path: string, content: string) {
      files[path] = content
      return { success: true }
    },
    async rename(from: string, to: string) {
      if (!(from in files)) return { success: false, error: 'ENOENT' }
      if (to in files) return { success: false, error: 'EEXIST' }
      files[to] = files[from]
      delete files[from]
      renames.push([from, to])
      return { success: true }
    }
  }
  return io
}

describe('renamedPath', () => {
  test('swaps the basename, keeping the directory', () => {
    expect(renamedPath('/p/power.kicad_sch', 'reg.kicad_sch')).toBe('/p/reg.kicad_sch')
    expect(renamedPath('C:\\p\\power.kicad_sch', 'reg.kicad_sch')).toBe('C:\\p\\reg.kicad_sch')
  })
})

describe('planRename', () => {
  test('finds parents whose Sheetfile resolves to the target', async () => {
    const io = makeIo({
      '/p/main.kicad_sch': sheetDoc('root', [{ name: 'Power', file: 'power.kicad_sch' }]),
      '/p/power.kicad_sch': sheetDoc('pow', [])
    })
    const plan = await planRename('/p/power.kicad_sch', 'reg.kicad_sch', Object.keys(io.files), io)
    expect(plan.newPath).toBe('/p/reg.kicad_sch')
    expect(plan.edits).toHaveLength(1)
    expect(plan.edits[0]).toMatchObject({
      sourceFile: '/p/main.kicad_sch',
      kind: 'sheet.file',
      oldValue: 'power.kicad_sch',
      newValue: 'reg.kicad_sch'
    })
  })

  test('preserves a ../ prefix when rebasing the reference', async () => {
    const io = makeIo({
      '/p/sub/main.kicad_sch': sheetDoc('root', [{ name: 'Power', file: '../power.kicad_sch' }]),
      '/p/power.kicad_sch': sheetDoc('pow', [])
    })
    const plan = await planRename('/p/power.kicad_sch', 'reg.kicad_sch', Object.keys(io.files), io)
    expect(plan.edits[0].newValue).toBe('../reg.kicad_sch')
  })

  test('a rename with no inbound references produces no edits', async () => {
    const io = makeIo({ '/p/lonely.kicad_sch': sheetDoc('x', []) })
    const plan = await planRename('/p/lonely.kicad_sch', 'y.kicad_sch', Object.keys(io.files), io)
    expect(plan.edits).toEqual([])
  })
})

describe('previewFiles', () => {
  test('rolls edits up per file with a count', async () => {
    const io = makeIo({
      '/p/main.kicad_sch': sheetDoc('root', [
        { name: 'A', file: 'shared.kicad_sch' },
        { name: 'B', file: 'shared.kicad_sch' }
      ]),
      '/p/shared.kicad_sch': sheetDoc('sh', [])
    })
    const plan = await planRename('/p/shared.kicad_sch', 'lib.kicad_sch', Object.keys(io.files), io)
    expect(previewFiles(plan)).toEqual([
      { sourceFile: '/p/main.kicad_sch', fileName: 'main.kicad_sch', count: 2 }
    ])
  })
})

describe('applyRename', () => {
  test('renames the file and forwards the reference, verifiably', async () => {
    const io = makeIo({
      '/p/main.kicad_sch': sheetDoc('root', [{ name: 'Power', file: 'power.kicad_sch' }]),
      '/p/power.kicad_sch': sheetDoc('pow', [])
    })
    const files = Object.keys(io.files)
    const plan = await planRename('/p/power.kicad_sch', 'reg.kicad_sch', files, io)

    const result = await applyRename(plan, io)
    expect(result.ok).toBe(true)
    expect(io.files['/p/power.kicad_sch']).toBeUndefined()
    expect(io.files['/p/reg.kicad_sch']).toBeDefined()
    expect(io.files['/p/main.kicad_sch']).toContain('"reg.kicad_sch"')

    const { dangling } = await verifyRename(plan, files, io)
    expect(dangling).toEqual([])
  })

  test('a failed reference write rolls back the rename and the writes', async () => {
    const io = makeIo({
      '/p/main.kicad_sch': sheetDoc('root', [{ name: 'Power', file: 'power.kicad_sch' }]),
      '/p/power.kicad_sch': sheetDoc('pow', [])
    })
    const before = { ...io.files }
    const plan = await planRename('/p/power.kicad_sch', 'reg.kicad_sch', Object.keys(before), io)

    // Make the reference write fail.
    io.writeFile = async () => ({ success: false, error: 'EACCES' })
    const result = await applyRename(plan, io)

    expect(result.ok).toBe(false)
    // The rename was reversed: original file back, new name gone.
    expect(io.files['/p/power.kicad_sch']).toBe(before['/p/power.kicad_sch'])
    expect(io.files['/p/reg.kicad_sch']).toBeUndefined()
  })

  test('an EEXIST rename aborts before any reference is written', async () => {
    const io = makeIo({
      '/p/main.kicad_sch': sheetDoc('root', [{ name: 'Power', file: 'power.kicad_sch' }]),
      '/p/power.kicad_sch': sheetDoc('pow', []),
      '/p/reg.kicad_sch': sheetDoc('other', [])
    })
    const plan = await planRename('/p/power.kicad_sch', 'reg.kicad_sch', Object.keys(io.files), io)
    const result = await applyRename(plan, io)
    expect(result.ok).toBe(false)
    expect(result.error).toBe('EEXIST')
    // main.kicad_sch untouched.
    expect(io.files['/p/main.kicad_sch']).toContain('"power.kicad_sch"')
  })

  test('skipDiskFiles leaves an open dirty referencing file for the caller', async () => {
    const io = makeIo({
      '/p/main.kicad_sch': sheetDoc('root', [{ name: 'Power', file: 'power.kicad_sch' }]),
      '/p/power.kicad_sch': sheetDoc('pow', [])
    })
    const plan = await planRename('/p/power.kicad_sch', 'reg.kicad_sch', Object.keys(io.files), io)
    const result = await applyRename(plan, io, { skipDiskFiles: ['/p/main.kicad_sch'] })
    expect(result.ok).toBe(true)
    expect(result.written.size).toBe(0)
    // Disk copy of main is untouched; the buffer edit is the caller's job.
    expect(io.files['/p/main.kicad_sch']).toContain('"power.kicad_sch"')
  })
})

describe('rewriteBufferText', () => {
  test('re-finds the reference in an edited buffer (disk spans do not apply)', () => {
    // A buffer with an unsaved edit ahead of the reference shifts every offset.
    const disk = sheetDoc('root', [{ name: 'Power', file: 'power.kicad_sch' }])
    const buffer = disk.replace('(version 20231120)', '(version 20231120)\n  (unsaved-edit "x")')
    const out = rewriteBufferText(
      '/p/main.kicad_sch',
      buffer,
      '/p/power.kicad_sch',
      'reg.kicad_sch'
    )
    expect(out).toContain('"reg.kicad_sch"')
    expect(out).toContain('(unsaved-edit "x")')
    expect(out).not.toContain('"power.kicad_sch"')
  })

  test('returns the text unchanged when nothing points at the target', () => {
    const buffer = sheetDoc('root', [{ name: 'USB', file: 'usb.kicad_sch' }])
    expect(
      rewriteBufferText('/p/main.kicad_sch', buffer, '/p/power.kicad_sch', 'reg.kicad_sch')
    ).toBe(buffer)
  })
})

describe('planDelete', () => {
  test('lists files that reference the doomed file, with counts', async () => {
    const io = makeIo({
      '/p/main.kicad_sch': sheetDoc('root', [{ name: 'Power', file: 'power.kicad_sch' }]),
      '/p/alt.kicad_sch': sheetDoc('alt', [{ name: 'Power', file: 'power.kicad_sch' }]),
      '/p/power.kicad_sch': sheetDoc('pow', [])
    })
    const { referrers } = await planDelete('/p/power.kicad_sch', Object.keys(io.files), io)
    expect(referrers.map((r) => r.fileName).sort()).toEqual(['alt.kicad_sch', 'main.kicad_sch'])
    expect(referrers.every((r) => r.count === 1)).toBe(true)
  })

  test('no referrers for an unreferenced file', async () => {
    const io = makeIo({ '/p/lonely.kicad_sch': sheetDoc('x', []) })
    const { referrers } = await planDelete('/p/lonely.kicad_sch', Object.keys(io.files), io)
    expect(referrers).toEqual([])
  })
})
