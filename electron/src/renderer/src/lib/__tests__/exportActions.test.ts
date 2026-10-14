import { describe, expect, test, vi } from 'vitest'
import { buildExportMenu, runExportAction, type ExportAction } from '../exportActions'

const action = (over: Partial<ExportAction> = {}): ExportAction => ({
  id: 'export-board-3d-image',
  label: '3D image…',
  enabled: true,
  run: vi.fn(),
  ...over
})

describe('buildExportMenu', () => {
  test('keeps an unavailable export listed, grayed, with why', () => {
    expect(
      buildExportMenu([action({ enabled: false, disabledReason: 'Switch to the 3D view' })])
    ).toEqual([
      {
        id: 'export-board-3d-image',
        label: '3D image…',
        disabled: true,
        disabledReason: 'Switch to the 3D view'
      }
    ])
    expect(buildExportMenu([action()])).toEqual([
      { id: 'export-board-3d-image', label: '3D image…' }
    ])
  })
})

describe('runExportAction', () => {
  test('runs the export the menu named', () => {
    const published = [action()]
    expect(runExportAction(published, 'export-board-3d-image')).toBe(true)
    expect(published[0].run).toHaveBeenCalledOnce()
  })

  test('leaves other menu ids and grayed exports alone', () => {
    const published = [action({ enabled: false })]
    expect(runExportAction(published, 'export-netlist')).toBe(false)
    expect(runExportAction(published, 'export-board-3d-image')).toBe(false)
    expect(published[0].run).not.toHaveBeenCalled()
  })
})
