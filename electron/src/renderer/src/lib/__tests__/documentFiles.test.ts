import { describe, expect, test } from 'vitest'
import { isPdfFile, isHtmlFile, mediaUrlForPath } from '../documentFiles'

describe('document file routing', () => {
  test('pdf routes to the PDF viewer, case-insensitively', () => {
    expect(isPdfFile('datasheet.pdf')).toBe(true)
    expect(isPdfFile('DATASHEET.PDF')).toBe(true)
    expect(isPdfFile('page.html')).toBe(false)
    expect(isPdfFile('pdf')).toBe(false)
  })

  test('html/htm route to the HTML viewer', () => {
    expect(isHtmlFile('report.html')).toBe(true)
    expect(isHtmlFile('legacy.HTM')).toBe(true)
    expect(isHtmlFile('doc.pdf')).toBe(false)
    expect(isHtmlFile('html')).toBe(false)
  })
})

describe('mediaUrlForPath', () => {
  test('mirrors the filesystem structure segment by segment', () => {
    expect(mediaUrlForPath('/home/user/docs/sheet.pdf')).toBe(
      'goatcad-media://local/home/user/docs/sheet.pdf'
    )
  })

  test('percent-encodes within segments but never the separators', () => {
    expect(mediaUrlForPath('/docs/data sheet #1.pdf')).toBe(
      'goatcad-media://local/docs/data%20sheet%20%231.pdf'
    )
  })

  test('normalizes Windows separators and keeps the drive as first segment', () => {
    expect(mediaUrlForPath('C:\\Users\\x\\doc.pdf')).toBe(
      'goatcad-media://local/C%3A/Users/x/doc.pdf'
    )
  })
})
