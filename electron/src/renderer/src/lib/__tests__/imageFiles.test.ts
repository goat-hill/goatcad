import { describe, expect, test } from 'vitest'
import { imageMimeType, isImageFile } from '../imageFiles'

describe('isImageFile', () => {
  test('recognizes supported extensions case-insensitively', () => {
    expect(isImageFile('logo.png')).toBe(true)
    expect(isImageFile('photo.JPG')).toBe(true)
    expect(isImageFile('art.jpeg')).toBe(true)
    expect(isImageFile('icon.SVG')).toBe(true)
    expect(isImageFile('anim.gif')).toBe(true)
    expect(isImageFile('shot.webp')).toBe(true)
  })

  test('rejects other files and extension-less names', () => {
    expect(isImageFile('board.kicad_pcb')).toBe(false)
    expect(isImageFile('README')).toBe(false)
    expect(isImageFile('model.step')).toBe(false)
    expect(isImageFile('notes.txt')).toBe(false)
    // The extension is the part after the LAST dot.
    expect(isImageFile('archive.png.bak')).toBe(false)
  })
})

describe('imageMimeType', () => {
  test('maps extensions to MIME types', () => {
    expect(imageMimeType('logo.png')).toBe('image/png')
    expect(imageMimeType('photo.jpg')).toBe('image/jpeg')
    expect(imageMimeType('photo.jpeg')).toBe('image/jpeg')
    expect(imageMimeType('icon.svg')).toBe('image/svg+xml')
    expect(imageMimeType('favicon.ico')).toBe('image/x-icon')
  })

  test('returns null for unsupported names', () => {
    expect(imageMimeType('board.kicad_pcb')).toBeNull()
    expect(imageMimeType('README')).toBeNull()
  })
})
