import { describe, expect, it, vi } from 'vitest'

// updater.ts wires electron and electron-updater at import time; only the pure
// availability rule is under test here.
vi.mock('electron', () => ({ app: {}, dialog: {}, BrowserWindow: {} }))
vi.mock('electron-updater', () => ({ autoUpdater: {} }))

import { updaterAvailability } from '../updater'

describe('updaterAvailability', () => {
  it('never runs in an unpackaged app', () => {
    expect(updaterAvailability({ platform: 'darwin', env: {}, isPackaged: false })).toEqual({
      ok: false,
      reason: 'unpackaged'
    })
  })

  it('runs for the dmg and nsis installs', () => {
    expect(updaterAvailability({ platform: 'darwin', env: {}, isPackaged: true })).toEqual({
      ok: true
    })
    expect(updaterAvailability({ platform: 'win32', env: {}, isPackaged: true })).toEqual({
      ok: true
    })
  })

  it('runs for an AppImage but not a package-manager install on Linux', () => {
    expect(
      updaterAvailability({
        platform: 'linux',
        env: { APPIMAGE: '/home/user/GoatCAD.AppImage' },
        isPackaged: true
      })
    ).toEqual({ ok: true })
    expect(updaterAvailability({ platform: 'linux', env: {}, isPackaged: true })).toEqual({
      ok: false,
      reason: 'package-manager'
    })
  })
})
