import { describe, expect, test, vi } from 'vitest'

// mediaProtocol imports { protocol } from electron at module scope; outside a
// real electron process that import has nothing to offer the pure helpers
// under test.
vi.mock('electron', () => ({
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() }
}))

import { pathForMediaUrl, parseByteRange, mediaMimeType } from '../mediaProtocol'
// Relative rather than the vitest-only @renderer alias: tsconfig.node.json has
// no paths mapping, and this cross-boundary import is exactly the point — the
// renderer's URL encoder and main's decoder must round-trip.
import { mediaUrlForPath } from '../../renderer/src/lib/documentFiles'

describe('pathForMediaUrl', () => {
  test('decodes POSIX paths', () => {
    expect(pathForMediaUrl('goatcad-media://local/home/user/doc.pdf')).toBe('/home/user/doc.pdf')
  })

  test('decodes Windows drive paths without a leading slash', () => {
    expect(pathForMediaUrl('goatcad-media://local/C%3A/Users/x/doc.pdf')).toBe('C:/Users/x/doc.pdf')
  })

  test('decodes percent-encoded segments', () => {
    expect(pathForMediaUrl('goatcad-media://local/docs/data%20sheet%20%231.pdf')).toBe(
      '/docs/data sheet #1.pdf'
    )
  })

  test('rejects other schemes, hosts, and malformed URLs', () => {
    expect(pathForMediaUrl('file:///home/user/doc.pdf')).toBeNull()
    expect(pathForMediaUrl('goatcad-media://remote/home/doc.pdf')).toBeNull()
    expect(pathForMediaUrl('goatcad-media://local/')).toBeNull()
    expect(pathForMediaUrl('not a url')).toBeNull()
  })

  test('dot segments are resolved by URL parsing before decoding', () => {
    // WHATWG URL normalization collapses `..` (even percent-encoded) at parse
    // time, so the decoded path is always fully resolved — a request can name
    // any absolute path, but never smuggle unresolved traversal past the
    // extension allowlist. The decoder's own dot-segment guard is a second
    // fence for inputs that skip URL normalization.
    expect(pathForMediaUrl('goatcad-media://local/home/user/../doc.pdf')).toBe('/home/doc.pdf')
    expect(pathForMediaUrl('goatcad-media://local/home/%2E%2E/etc/passwd')).toBe('/etc/passwd')
  })

  test('round-trips the renderer encoder', () => {
    for (const path of [
      '/home/user/project/datasheets/ATmega328P.pdf',
      '/home/user/with space/ünïcode döc.html',
      'C:/Users/ada/Documents/kicad/board/docs/regulator.pdf'
    ]) {
      expect(pathForMediaUrl(mediaUrlForPath(path))).toBe(path)
    }
  })

  test('round-trips Windows backslash paths as forward-slash paths', () => {
    expect(pathForMediaUrl(mediaUrlForPath('C:\\Users\\x\\doc.pdf'))).toBe('C:/Users/x/doc.pdf')
  })
})

describe('parseByteRange', () => {
  test('no header serves the whole body', () => {
    expect(parseByteRange(null, 100)).toBeNull()
  })

  test('parses bounded, open-ended, and suffix ranges', () => {
    expect(parseByteRange('bytes=0-49', 100)).toEqual({ start: 0, end: 49 })
    expect(parseByteRange('bytes=50-', 100)).toEqual({ start: 50, end: 99 })
    expect(parseByteRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 })
  })

  test('clamps an end past the body to the last byte', () => {
    expect(parseByteRange('bytes=90-200', 100)).toEqual({ start: 90, end: 99 })
    expect(parseByteRange('bytes=-500', 100)).toEqual({ start: 0, end: 99 })
  })

  test('flags unsatisfiable ranges', () => {
    expect(parseByteRange('bytes=100-', 100)).toBe('unsatisfiable')
    expect(parseByteRange('bytes=80-20', 100)).toBe('unsatisfiable')
    expect(parseByteRange('bytes=-0', 100)).toBe('unsatisfiable')
  })

  test('ignores forms it does not support (200 is spec-legal)', () => {
    expect(parseByteRange('bytes=0-10,20-30', 100)).toBeNull()
    expect(parseByteRange('items=0-10', 100)).toBeNull()
    expect(parseByteRange('bytes=-', 100)).toBeNull()
  })
})

describe('mediaMimeType', () => {
  test('serves documents and static HTML subresources', () => {
    expect(mediaMimeType('/a/doc.pdf')).toBe('application/pdf')
    expect(mediaMimeType('/a/page.HTML')).toBe('text/html')
    expect(mediaMimeType('/a/style.css')).toBe('text/css')
    expect(mediaMimeType('/a/fig.png')).toBe('image/png')
    expect(mediaMimeType('/a/font.woff2')).toBe('font/woff2')
  })

  test('refuses scripts and everything else', () => {
    expect(mediaMimeType('/a/app.js')).toBeNull()
    expect(mediaMimeType('/a/board.kicad_pcb')).toBeNull()
    expect(mediaMimeType('/a/noext')).toBeNull()
  })
})
