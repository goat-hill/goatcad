import { describe, expect, it } from 'vitest'
import { dataUrlBase64, symbolExportPath } from '../symbolExport'

describe('symbolExportPath', () => {
  it('names the file after the symbol, beside the library', () => {
    expect(symbolExportPath('/proj/lib/My.kicad_sym', 'R_Small', 'png')).toBe(
      '/proj/lib/R_Small.png'
    )
  })

  it('keeps a Windows library path and its separator', () => {
    expect(symbolExportPath('C:\\proj\\My.kicad_sym', 'R', 'png')).toBe('C:\\proj\\R.png')
  })

  it('offers the bare name for a library with no file on disk', () => {
    expect(symbolExportPath('custom-lib://Device', 'R', 'png')).toBe('R.png')
    expect(symbolExportPath(null, 'R', 'png')).toBe('R.png')
  })

  it('replaces characters a file name cannot hold', () => {
    expect(symbolExportPath(null, 'A/B:C*?', 'png')).toBe('A_B_C__.png')
    expect(symbolExportPath(null, '', 'png')).toBe('symbol.png')
  })
})

describe('dataUrlBase64', () => {
  it('unwraps the payload of a base64 data URL', () => {
    expect(dataUrlBase64('data:image/png;base64,iVBORw0KGgo=')).toBe('iVBORw0KGgo=')
  })

  it('refuses anything else', () => {
    expect(dataUrlBase64('data:text/plain,hello')).toBeNull()
    expect(dataUrlBase64('iVBORw0KGgo=')).toBeNull()
  })
})
