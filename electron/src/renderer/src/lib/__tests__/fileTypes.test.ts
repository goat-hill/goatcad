import { describe, expect, test } from 'vitest'
import { isOpenableFile, isTextFile } from '../fileTypes'

describe('isTextFile', () => {
  test('accepts common text and config formats', () => {
    expect(isTextFile('notes.txt')).toBe(true)
    expect(isTextFile('README.md')).toBe(true)
    expect(isTextFile('data.JSON')).toBe(true)
    expect(isTextFile('config.yaml')).toBe(true)
    expect(isTextFile('.gitignore')).toBe(true)
  })

  test('accepts ECAD text formats', () => {
    expect(isTextFile('board.kicad_pro')).toBe(true)
    expect(isTextFile('rules.kicad_dru')).toBe(true)
    expect(isTextFile('holes.drl')).toBe(true)
    expect(isTextFile('netlist.net')).toBe(true)
  })

  test('accepts well-known extension-less basenames', () => {
    expect(isTextFile('README')).toBe(true)
    expect(isTextFile('Makefile')).toBe(true)
    expect(isTextFile('fp-lib-table')).toBe(true)
    expect(isTextFile('sym-lib-table')).toBe(true)
  })

  test('rejects binaries and unknown extensions', () => {
    expect(isTextFile('archive.zip')).toBe(false)
    expect(isTextFile('doc.pdf')).toBe(false)
    expect(isTextFile('firmware.bin')).toBe(false)
    expect(isTextFile('mystery.xyz')).toBe(false)
    expect(isTextFile('UNKNOWNNAME')).toBe(false)
  })

  test('files with dedicated editors or viewers are not text', () => {
    expect(isTextFile('board.kicad_pcb')).toBe(false)
    expect(isTextFile('model.step')).toBe(false)
    expect(isTextFile('logo.png')).toBe(false)
    // Gerbers route to the Gerber viewer now, not the text editor
    expect(isTextFile('out.gbr')).toBe(false)
    // html renders in the HTML viewer; its source toggle is the text editor.
    expect(isTextFile('report.html')).toBe(false)
    expect(isTextFile('legacy.htm')).toBe(false)
  })
})

describe('isOpenableFile', () => {
  test('everything with an editor, viewer, or text route is openable', () => {
    expect(isOpenableFile('board.kicad_pcb')).toBe(true)
    expect(isOpenableFile('symbols.kicad_sym')).toBe(true)
    expect(isOpenableFile('model.STEP')).toBe(true)
    expect(isOpenableFile('logo.png')).toBe(true)
    expect(isOpenableFile('notes.txt')).toBe(true)
    expect(isOpenableFile('README')).toBe(true)
    expect(isOpenableFile('out.gbr')).toBe(true)
    expect(isOpenableFile('board.GTL')).toBe(true)
    expect(isOpenableFile('datasheet.pdf')).toBe(true)
    expect(isOpenableFile('report.html')).toBe(true)
  })

  test('unknown and binary types are not openable', () => {
    expect(isOpenableFile('archive.zip')).toBe(false)
    expect(isOpenableFile('app.exe')).toBe(false)
    expect(isOpenableFile('data.sqlite')).toBe(false)
  })
})
