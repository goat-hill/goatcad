import { describe, expect, it, vi } from 'vitest'

// feedback.ts wires electron at import time; only the pure rules are under test.
vi.mock('electron', () => ({
  app: {},
  clipboard: {},
  ClipboardItem: class {},
  ipcMain: {},
  screen: {},
  shell: {}
}))

import {
  buildChannel,
  installKind,
  isFeedbackIssueUrl,
  osLabel,
  pngWithin,
  prettyNameFromOsRelease
} from '../feedback'

describe('isFeedbackIssueUrl', () => {
  it('opens the repo new-issue page with any query', () => {
    expect(isFeedbackIssueUrl('https://github.com/goat-hill/goatcad/issues/new')).toBe(true)
    expect(
      isFeedbackIssueUrl('https://github.com/goat-hill/goatcad/issues/new?template=bug.yml&title=x')
    ).toBe(true)
  })

  it('refuses anything else', () => {
    for (const url of [
      'http://github.com/goat-hill/goatcad/issues/new',
      'https://github.com/someone/goatcad/issues/new',
      'https://github.com/goat-hill/goatcad/issues/new/../../evil',
      'https://github.com.evil.example/goat-hill/goatcad/issues/new',
      'file:///etc/passwd',
      'not a url',
      42
    ]) {
      expect(isFeedbackIssueUrl(url)).toBe(false)
    }
  })
})

describe('buildChannel', () => {
  it('names a run, a release and anyone else’s build', () => {
    expect(buildChannel({ isPackaged: false, official: true })).toBe('dev')
    expect(buildChannel({ isPackaged: true, official: true })).toBe('release')
    expect(buildChannel({ isPackaged: true, official: false })).toBe('source')
  })
})

describe('installKind', () => {
  it('names the installer per platform', () => {
    expect(installKind({ platform: 'darwin', isPackaged: true, env: {} })).toBe('dmg')
    expect(installKind({ platform: 'win32', isPackaged: true, env: {} })).toBe('nsis')
    expect(installKind({ platform: 'linux', isPackaged: true, env: { APPIMAGE: '/a' } })).toBe(
      'AppImage'
    )
    expect(installKind({ platform: 'linux', isPackaged: true, env: {} })).toBe('deb')
    expect(installKind({ platform: 'linux', isPackaged: false, env: {} })).toBe('unpackaged')
  })
})

describe('prettyNameFromOsRelease', () => {
  it('reads PRETTY_NAME, quoted or not', () => {
    expect(prettyNameFromOsRelease('NAME="Ubuntu"\nPRETTY_NAME="Ubuntu 24.04.1 LTS"\n')).toBe(
      'Ubuntu 24.04.1 LTS'
    )
    expect(prettyNameFromOsRelease('PRETTY_NAME=Arch Linux')).toBe('Arch Linux')
    expect(prettyNameFromOsRelease('NAME=Foo')).toBeNull()
  })
})

describe('osLabel', () => {
  it('leads with the distribution on Linux', () => {
    expect(
      osLabel({ platform: 'linux', systemVersion: '', kernel: '6.8.0', distribution: 'Fedora 41' })
    ).toBe('Fedora 41 (Linux 6.8.0)')
    expect(
      osLabel({ platform: 'linux', systemVersion: '', kernel: '6.8.0', distribution: null })
    ).toBe('Linux 6.8.0')
  })

  it('quotes the system version on macOS and Windows', () => {
    expect(
      osLabel({ platform: 'darwin', systemVersion: '15.3.0', kernel: '', distribution: null })
    ).toBe('macOS 15.3.0')
    expect(
      osLabel({ platform: 'win32', systemVersion: '10.0.22631', kernel: '', distribution: null })
    ).toBe('Windows 10.0.22631')
  })
})

describe('pngWithin', () => {
  // A stand-in whose PNG size is its pixel area, as a real one roughly is.
  type Fake = {
    getSize: () => { width: number; height: number }
    toPNG: () => Buffer
    resize: (o: { width: number }) => Fake
  }
  const fakeImage = (width: number, height: number): Fake => ({
    getSize: () => ({ width, height }),
    toPNG: () => Buffer.alloc(width * height),
    resize: ({ width: w }) => fakeImage(w, Math.round((height * w) / width))
  })

  it('keeps an image that already fits at full size', () => {
    expect(pngWithin(fakeImage(100, 50), 10_000)?.length).toBe(5_000)
  })

  it('scales a too-large image down until it fits', () => {
    const png = pngWithin(fakeImage(3840, 2160), 2_000_000)
    expect(png).not.toBeNull()
    expect(png!.length).toBeLessThanOrEqual(2_000_000)
    expect(png!.length).toBeGreaterThan(1_000_000)
  })

  it('gives up when nothing fits', () => {
    expect(pngWithin(fakeImage(100, 100), 0)).toBeNull()
  })
})
