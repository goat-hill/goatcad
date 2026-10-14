import { describe, expect, test, vi } from 'vitest'
import { DocumentStore, documentKindOf, type TextSource } from '../documentStore'
import type { CommandHistory } from '../../history'

const store = (disk: Map<string, string> = new Map()): DocumentStore =>
  new DocumentStore(async (path) => disk.get(path) ?? null)

const push = (history: CommandHistory, before: string, after: string): void =>
  history.push({ label: 'edit', before, after, selectionBefore: [], selectionAfter: [] })

describe('documentKindOf', () => {
  test('names each KiCad file and the virtual footprint tabs', () => {
    expect(documentKindOf('/p/a.kicad_sch')).toBe('schematic')
    expect(documentKindOf('/p/a.KICAD_PCB')).toBe('board')
    expect(documentKindOf('/p/lib.kicad_sym')).toBe('symbol-library')
    expect(documentKindOf('/p/R.pretty/R_0402.kicad_mod')).toBe('footprint')
    expect(documentKindOf('readonly-lib://%2Fp%2FR.pretty%2FR_0402.kicad_mod')).toBe('footprint')
    expect(documentKindOf('/p/notes.md')).toBe('other')
  })
})

describe('text, disk text and revision', () => {
  test('the revision moves on a change to the text and only then', () => {
    const doc = store().open('/p/a.kicad_sch', 'v0')
    expect(doc.revision()).toBe(0)
    doc.setText('v0')
    expect(doc.revision()).toBe(0)
    doc.setText('v1')
    expect(doc.revision()).toBe(1)
    doc.markSaved('v1')
    expect(doc.revision()).toBe(1)
  })

  test('dirty is the text against the disk text', () => {
    const doc = store().open('/p/a.kicad_sch', 'v1', 'v0')
    expect(doc.isDirty()).toBe(true)
    doc.markSaved('v1')
    expect(doc.isDirty()).toBe(false)
    expect(doc.baseline()).toBe('v1')
    doc.setText('v2')
    doc.setText('v1')
    expect(doc.isDirty()).toBe(false)
  })

  test('opening a path twice returns the one document, unchanged', () => {
    const documents = store()
    const first = documents.open('/p/a.kicad_sch', 'v0')
    first.setText('edited')
    expect(documents.open('/p/a.kicad_sch', 'ignored')).toBe(first)
    expect(first.text()).toBe('edited')
  })

  test('a load from disk replaces text and disk text and moves the revision', () => {
    const documents = store()
    const doc = documents.open('/p/a.kicad_sch', 'edited', 'v0')
    documents.load('/p/a.kicad_sch', 'from disk')
    expect(doc.text()).toBe('from disk')
    expect(doc.isDirty()).toBe(false)
    expect(doc.revision()).toBe(1)
  })

  test('listeners hear every change, and nothing when nothing changed', () => {
    const documents = store()
    const heard = vi.fn()
    const stop = documents.subscribe(heard)
    const doc = documents.open('/p/a.kicad_sch', 'v0')
    doc.setText('v0')
    expect(heard).not.toHaveBeenCalled()
    doc.setText('v1')
    expect(heard).toHaveBeenCalledTimes(1)
    stop()
    doc.setText('v2')
    expect(heard).toHaveBeenCalledTimes(1)
  })
})

describe('undo history', () => {
  test('a view opening on the text the history committed keeps it', () => {
    const doc = store().open('/p/a.kicad_sch', 'v0')
    const first = doc.openHistory('v0')
    push(first, 'v0', 'v1')
    doc.commitText('v1')

    const again = doc.openHistory('v1')
    expect(again).toBe(first)
    expect(again.undoLabel).toBe('edit')
  })

  test('opening on text the history did not commit clears it', () => {
    const doc = store().open('/p/a.kicad_sch', 'v0')
    push(doc.openHistory('v0'), 'v0', 'v1')
    doc.commitText('v1')
    expect(doc.openHistory('rewritten elsewhere').canUndo).toBe(false)
  })

  test('the first open never clears, whatever the text', () => {
    const doc = store().open('/p/a.kicad_sch', 'v0')
    const history = doc.openHistory('anything')
    push(history, 'anything', 'next')
    expect(doc.hasHistory()).toBe(true)
  })

  test('files do not share a history', () => {
    const documents = store()
    const a = documents.open('/p/a.kicad_sch', 'a0')
    const b = documents.open('/p/b.kicad_sch', 'b0')
    push(a.history(), 'a0', 'a1')
    expect(b.hasHistory()).toBe(false)
  })
})

describe('a session that owes the text an edit', () => {
  const source = (state: { pending: boolean; text: string }): TextSource => ({
    pending: () => state.pending,
    flush: () => {
      state.pending = false
      return state.text
    }
  })

  test('makes the document dirty, and writes out on the first read of the text', () => {
    const doc = store().open('/p/a.kicad_pcb', 'v0')
    push(doc.openHistory('v0'), 'v0', 'v1')
    const state = { pending: true, text: 'v1' }
    doc.attachTextSource(source(state))

    expect(doc.isDirty()).toBe(true)
    expect(doc.storedText()).toBe('v0')
    expect(doc.text()).toBe('v1')
    expect(doc.revision()).toBe(1)
    expect(state.pending).toBe(false)
    // The session's text is what the history last committed, so undo holds.
    expect(doc.openHistory('v1').canUndo).toBe(true)
  })

  test('is asked once per pending edit, and not at all when it owes nothing', () => {
    const doc = store().open('/p/a.kicad_pcb', 'v0')
    let flushes = 0
    const state = { pending: true, text: 'v1' }
    doc.attachTextSource({
      pending: () => state.pending,
      flush: () => {
        flushes += 1
        state.pending = false
        return state.text
      }
    })
    expect(doc.text()).toBe('v1')
    expect(doc.text()).toBe('v1')
    expect(flushes).toBe(1)
  })

  test('detaching leaves the text as it stands', () => {
    const doc = store().open('/p/a.kicad_pcb', 'v0')
    const detach = doc.attachTextSource(source({ pending: true, text: 'v1' }))
    detach()
    expect(doc.text()).toBe('v0')
    expect(doc.isDirty()).toBe(false)
  })
})

describe('freeing a document', () => {
  test('pins, activity and the size estimate are kept', () => {
    const doc = store().open('/p/a.kicad_pcb', 'x'.repeat(100))
    const release = doc.pin('view')
    doc.touch('viewed', 42)
    expect(doc.pins()).toEqual(['view'])
    expect(doc.lastActive('viewed')).toBe(42)
    expect(doc.lastActive('agent')).toBeNull()
    const textOnly = doc.estimatedBytes()
    doc.attachTextSource({ pending: () => false, flush: () => doc.storedText() })
    expect(doc.estimatedBytes()).toBeGreaterThan(textOnly)
    release()
    release()
    expect(doc.pins()).toEqual([])
  })

  test('is refused while dirty, pinned, or holding undo history', () => {
    const documents = store()
    const dirty = documents.open('/p/dirty.kicad_sch', 'edited', 'disk')
    expect(dirty.discard()).toBe(false)

    const pinned = documents.open('/p/pinned.kicad_sch', 'v0')
    const release = pinned.pin('agent')
    expect(pinned.discard()).toBe(false)
    release()
    expect(pinned.discard()).toBe(true)

    const undoable = documents.open('/p/undo.kicad_sch', 'v0')
    push(undoable.history(), 'v0', 'v1')
    expect(undoable.discard()).toBe(false)
  })

  test('a clean document reads back from disk, with a revision that has moved on', async () => {
    const disk = new Map([['/p/a.kicad_sch', 'on disk']])
    const documents = store(disk)
    const doc = documents.open('/p/a.kicad_sch', 'on disk')
    doc.setText('edited')
    doc.markSaved('on disk')
    const before = doc.revision()

    expect(doc.discard()).toBe(true)
    expect(doc.state()).toBe('discarded')
    expect(doc.estimatedBytes()).toBe(0)
    expect(doc.isDirty()).toBe(false)
    expect(() => doc.text()).toThrow(/ready/)

    await Promise.all([doc.ready(), doc.ready()])
    expect(doc.state()).toBe('loaded')
    expect(doc.text()).toBe('on disk')
    expect(doc.revision()).toBeGreaterThan(before)
  })

  test('a file that cannot be read back leaves the document discarded', async () => {
    const doc = store().open('/p/gone.kicad_sch', 'v0')
    expect(doc.discard()).toBe(true)
    await expect(doc.ready()).rejects.toThrow(/could not be read back/)
    expect(doc.state()).toBe('discarded')
  })
})
