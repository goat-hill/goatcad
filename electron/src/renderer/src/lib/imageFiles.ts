/**
 * Image file-type support for the image viewer tab: which extensions route to
 * it (EditorArea) and the MIME type its data: URL needs. Kept as a pure module
 * so the mapping is testable and the routing/viewer can't drift apart.
 */

const IMAGE_MIME_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  avif: 'image/avif'
}

const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase()
}

export const isImageFile = (name: string): boolean => extensionOf(name) in IMAGE_MIME_TYPES

/** MIME type for a supported image file name, or null when not one. */
export const imageMimeType = (name: string): string | null =>
  IMAGE_MIME_TYPES[extensionOf(name)] ?? null
