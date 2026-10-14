/**
 * A picked picture as the PNG a schematic `(image …)` stores. KiCad reads any
 * format wxWidgets decodes and saves it as PNG (`BITMAP_BASE::SaveImageData`);
 * a PNG is kept byte for byte, so its own pixel density still sets its size,
 * and anything else is decoded by the browser and re-encoded.
 */
import { imageMimeType } from '../imageFiles'
import { pngInfo } from './sheetGraphics'

/** The picker's filter: what the browser can decode into a canvas. */
export const IMAGE_IMPORT_EXTENSIONS = ['png', 'jpg', 'jpeg', 'bmp', 'gif', 'webp']

/** The file's base64 as a PNG, or null when it cannot be read or decoded. */
export async function pngFromImageFile(path: string): Promise<string | null> {
  const read = await window.api.readFileBase64(path)
  if (!read.success || !read.data) return null
  if (pngInfo(read.data)) return read.data
  const image = new Image()
  image.src = `data:${imageMimeType(path) ?? 'image/png'};base64,${read.data}`
  try {
    await image.decode()
  } catch {
    return null
  }
  if (!image.naturalWidth || !image.naturalHeight) return null
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  canvas.getContext('2d')?.drawImage(image, 0, 0)
  const url = canvas.toDataURL('image/png')
  const data = url.slice(url.indexOf(',') + 1)
  return pngInfo(data) ? data : null
}
