import { describe, expect, test } from 'vitest'
import { adjacentSheet, createSheetHistory, type SheetVisit } from '../sheetNavigation'
import { datasheetUrl } from '../datasheet'

const at = (sheetPath: string, filePath = '/p/a.kicad_sch'): SheetVisit => ({ filePath, sheetPath })

describe('the sheet history (KiCad back / forward)', () => {
  test('steps back and forward through the sheets shown', () => {
    const history = createSheetHistory()
    history.visit(at('/r'))
    history.visit(at('/r/a'))
    history.visit(at('/r/b'))
    expect(history.canForward()).toBe(false)
    expect(history.back()).toEqual(at('/r/a'))
    expect(history.back()).toEqual(at('/r'))
    expect(history.back()).toBeNull()
    expect(history.canBack()).toBe(false)
    expect(history.forward()).toEqual(at('/r/a'))
    expect(history.canForward()).toBe(true)
  })

  test('showing the entry just stepped to is not a new visit', () => {
    const history = createSheetHistory()
    history.visit(at('/r'))
    history.visit(at('/r/a'))
    const back = history.back()
    if (back) history.visit(back)
    expect(history.forward()).toEqual(at('/r/a'))
  })

  test('a new visit drops what lay ahead', () => {
    const history = createSheetHistory()
    history.visit(at('/r'))
    history.visit(at('/r/a'))
    history.back()
    history.visit(at('/r/b'))
    expect(history.canForward()).toBe(false)
    expect(history.back()).toEqual(at('/r'))
  })

  test('skips entries the design no longer has, and keeps a bounded list', () => {
    const history = createSheetHistory(3)
    for (const path of ['/r', '/r/gone', '/r/a', '/r/b']) history.visit(at(path))
    expect(history.back((visit) => visit.sheetPath !== '/r/gone')).toEqual(at('/r/a'))
    expect(history.back((visit) => visit.sheetPath !== '/r/gone')).toBeNull()
  })

  test('a file is the same file however its path is spelled', () => {
    const history = createSheetHistory()
    history.visit(at('/r', 'C:\\p\\A.kicad_sch'))
    history.visit(at('/r', 'c:/p/a.kicad_sch'))
    expect(history.canBack()).toBe(false)
  })
})

describe('previous / next sheet', () => {
  const pages = [at('/r'), at('/r/a'), at('/r/b')]

  test('walks page order and stops at either end', () => {
    expect(adjacentSheet(pages, '/r/a', 1)).toEqual(at('/r/b'))
    expect(adjacentSheet(pages, '/r/a', -1)).toEqual(at('/r'))
    expect(adjacentSheet(pages, '/r/b', 1)).toBeNull()
    expect(adjacentSheet(pages, '/r', -1)).toBeNull()
    expect(adjacentSheet(pages, '/elsewhere', 1)).toBeNull()
  })
})

describe('datasheetUrl', () => {
  test('opens a web address, giving a bare host its scheme', () => {
    expect(datasheetUrl('https://example.com/a.pdf')).toBe('https://example.com/a.pdf')
    expect(datasheetUrl(' http://example.com/b ')).toBe('http://example.com/b')
    expect(datasheetUrl('www.ti.com/lit/ds/x.pdf')).toBe('https://www.ti.com/lit/ds/x.pdf')
  })

  test("KiCad's none, a local path and anything but the web are not links", () => {
    expect(datasheetUrl('~')).toBeNull()
    expect(datasheetUrl('')).toBeNull()
    expect(datasheetUrl(undefined)).toBeNull()
    expect(datasheetUrl('${KICAD9_SYMBOL_DIR}/x.pdf')).toBeNull()
    expect(datasheetUrl('file:///etc/passwd')).toBeNull()
    expect(datasheetUrl('javascript:alert(1)')).toBeNull()
  })
})
