import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  emitProjectChange,
  fileChange,
  fileRenamed,
  installProjectBus,
  onProjectChange,
  projectFileType,
  type ProjectChange,
  type ProjectChangeBatch
} from '../projectBus'

/** The two `window.api` members the bus touches, captured for assertions. */
const notifyProjectChange = vi.fn<(batch: ProjectChangeBatch) => void>()
let remoteListener: ((batch: ProjectChangeBatch) => void) | null = null

beforeEach(() => {
  notifyProjectChange.mockClear()
  remoteListener = null
  vi.stubGlobal('window', {
    api: {
      notifyProjectChange,
      onProjectChanged: (cb: (batch: ProjectChangeBatch) => void) => {
        remoteListener = cb
        return () => {
          remoteListener = null
        }
      }
    }
  })
})

describe('projectFileType', () => {
  it('classifies each design extension, and nothing else', () => {
    expect(projectFileType('/p/main.kicad_sch')).toBe('schematic')
    expect(projectFileType('/p/main.KICAD_PCB')).toBe('board')
    expect(projectFileType('/p/lib.kicad_sym')).toBe('symbol-library')
    expect(projectFileType('/p/R.kicad_mod')).toBe('footprint')
    expect(projectFileType('/p/main.kicad_pro')).toBe('project')
    expect(projectFileType('/p/README.md')).toBe('other')
  })
})

describe('emitProjectChange', () => {
  it('coalesces everything emitted in one tick into a single batch', async () => {
    const seen: ProjectChange[][] = []
    const stop = onProjectChange((changes) => {
      seen.push(changes)
    })

    const a = emitProjectChange('/p', fileChange('file-created', '/p/a.kicad_sch'))
    const b = emitProjectChange('/p', fileChange('file-changed', '/p/b.kicad_sch'))
    await Promise.all([a, b])

    expect(seen).toHaveLength(1)
    expect(seen[0]).toHaveLength(2)
    expect(notifyProjectChange).toHaveBeenCalledTimes(1)
    stop()
  })

  it('settles only after its subscribers have, so a caller can act on the result', async () => {
    const order: string[] = []
    const stop = onProjectChange(async () => {
      await Promise.resolve()
      order.push('subscriber')
    })

    await emitProjectChange('/p', fileRenamed('/p/a.kicad_sch', '/p/b.kicad_sch'))
    order.push('emitter')

    expect(order).toEqual(['subscriber', 'emitter'])
    stop()
  })

  it('keeps notifying the rest when one subscriber throws', async () => {
    const reached = vi.fn()
    const stopBad = onProjectChange(() => {
      throw new Error('git is unhappy')
    })
    const stopGood = onProjectChange(reached)

    await emitProjectChange('/p', fileChange('file-changed', '/p/a.kicad_sch'))

    expect(reached).toHaveBeenCalledOnce()
    stopBad()
    stopGood()
  })

  it('stays local when no workspace root is given', async () => {
    const stop = onProjectChange(() => {})
    await emitProjectChange(null, fileChange('file-created', '/p/a.kicad_sch'))
    expect(notifyProjectChange).not.toHaveBeenCalled()
    stop()
  })
})

describe('installProjectBus', () => {
  it("delivers another window's batch for the workspace this one holds", async () => {
    const seen = vi.fn()
    const stop = onProjectChange(seen)
    const uninstall = installProjectBus(() => '/p')

    remoteListener?.({ root: '/p', changes: [fileChange('file-created', '/p/a.kicad_sch')] })
    await Promise.resolve()

    expect(seen).toHaveBeenCalledOnce()
    uninstall()
    stop()
  })

  it('ignores a batch from a workspace this window is not looking at', async () => {
    const seen = vi.fn()
    const stop = onProjectChange(seen)
    const uninstall = installProjectBus(() => '/p')

    remoteListener?.({
      root: '/other',
      changes: [fileChange('file-created', '/other/a.kicad_sch')]
    })
    await Promise.resolve()

    expect(seen).not.toHaveBeenCalled()
    uninstall()
    stop()
  })

  it('does not rebroadcast what it received, so two windows cannot loop', async () => {
    const stop = onProjectChange(() => {})
    const uninstall = installProjectBus(() => '/p')

    remoteListener?.({ root: '/p', changes: [fileChange('file-changed', '/p/a.kicad_sch')] })
    await Promise.resolve()

    expect(notifyProjectChange).not.toHaveBeenCalled()
    uninstall()
    stop()
  })
})
