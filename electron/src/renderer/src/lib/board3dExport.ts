// The board 3D view's Export image: the sizes it offers, the file it suggests,
// and the pixel math between the pane's buffer and a PNG. The picture itself is
// `ViewportEngine.capture3D`; its background is the pane's (`board3dView.ts`).

import { reactive } from 'vue'
import { rebaseReference } from './kicad/paths'

export interface PixelSize {
  width: number
  height: number
}

/** The fixed sizes, beside the view's own and a custom one. */
export const BOARD3D_EXPORT_PRESETS = [
  { id: 'hd', width: 1920, height: 1080 },
  { id: 'uhd', width: 3840, height: 2160 },
  { id: 'square', width: 2048, height: 2048 }
] as const
export type Board3DExportSizeId = 'view' | (typeof BOARD3D_EXPORT_PRESETS)[number]['id'] | 'custom'

export const BOARD3D_EXPORT_MIN_PIXELS = 16
/** A side. The view draws through multisampled half-float targets of the
 *  picture's size, so the ceiling is the GPU's memory. */
export const BOARD3D_EXPORT_MAX_PIXELS = 4096

/** What the dialog was last set to; held for the session. */
export const board3dExportChoice = reactive<{
  size: Board3DExportSizeId
  custom: PixelSize
  /** Width and height keep their proportion as either is typed. */
  locked: boolean
}>({ size: 'view', custom: { width: 1920, height: 1080 }, locked: true })

export const clampExportPixels = (value: number): number =>
  Number.isFinite(value)
    ? Math.min(BOARD3D_EXPORT_MAX_PIXELS, Math.max(BOARD3D_EXPORT_MIN_PIXELS, Math.round(value)))
    : BOARD3D_EXPORT_MIN_PIXELS

/** `size` scaled down, shape kept, until its longer side fits the ceiling. */
export const fitExportSize = (size: PixelSize): PixelSize => {
  const scale = Math.min(1, BOARD3D_EXPORT_MAX_PIXELS / Math.max(size.width, size.height, 1))
  return {
    width: clampExportPixels(size.width * scale),
    height: clampExportPixels(size.height * scale)
  }
}

/** The pixels a size choice means: `view` is the pane's own, in device pixels. */
export const resolveExportSize = (
  id: Board3DExportSizeId,
  view: PixelSize,
  custom: PixelSize
): PixelSize => {
  if (id === 'view') return fitExportSize(view)
  if (id === 'custom')
    return { width: clampExportPixels(custom.width), height: clampExportPixels(custom.height) }
  const preset = BOARD3D_EXPORT_PRESETS.find((entry) => entry.id === id)
  return preset ? { width: preset.width, height: preset.height } : fitExportSize(view)
}

/**
 * The size of `aspect` (width over height) whose `side` is `value`: what
 * typing one field means while the two are locked. Scaled down whole when the
 * other side would pass the ceiling.
 */
export const sizeAtAspect = (side: keyof PixelSize, value: number, aspect: number): PixelSize => {
  const typed = clampExportPixels(value)
  let width = side === 'width' ? typed : typed * aspect
  let height = side === 'width' ? typed / aspect : typed
  const over = Math.max(width, height) / BOARD3D_EXPORT_MAX_PIXELS
  if (over > 1) {
    width /= over
    height /= over
  }
  return { width: clampExportPixels(width), height: clampExportPixels(height) }
}

/** `size` scaled, shape kept, to the largest that fits a `maxWidth` × `maxHeight` box. */
export const fitWithin = (size: PixelSize, maxWidth: number, maxHeight: number): PixelSize => {
  const scale = Math.min(maxWidth / Math.max(size.width, 1), maxHeight / Math.max(size.height, 1))
  return {
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale))
  }
}

/** Characters no filesystem the app runs on accepts in a file name. */
const UNSAFE_FILENAME = /[\\/:*?"<>|]/g

/**
 * Where the save dialog starts: `<board>-3d.png` beside the board. A board
 * with no file on disk offers the bare name and lets the dialog pick the folder.
 */
export const board3dExportPath = (boardPath: string | null | undefined, name: string): string => {
  const onDisk = boardPath && !boardPath.includes('://') ? boardPath : null
  const base = (onDisk ?? name).split(/[\\/]/).pop() ?? ''
  const stem = base.replace(/\.kicad_pcb$/i, '').replace(UNSAFE_FILENAME, '_') || 'board'
  const file = `${stem}-3d.png`
  return onDisk ? rebaseReference(onDisk, file) : file
}

/**
 * Turn a read-back canvas buffer into PNG pixels, in place. The buffer is
 * premultiplied RGBA; a PNG is straight alpha. `background` (sRGB bytes) is
 * laid under the picture and the result is opaque; null keeps the alpha.
 */
export const compositeCapture = (
  data: Uint8ClampedArray,
  background: readonly [number, number, number] | null
): void => {
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3]
    if (background) {
      if (alpha === 255) continue
      const rest = (255 - alpha) / 255
      data[i] = data[i] + background[0] * rest
      data[i + 1] = data[i + 1] + background[1] * rest
      data[i + 2] = data[i + 2] + background[2] * rest
      data[i + 3] = 255
    } else if (alpha !== 0 && alpha !== 255) {
      data[i] = (data[i] * 255) / alpha
      data[i + 1] = (data[i + 1] * 255) / alpha
      data[i + 2] = (data[i + 2] * 255) / alpha
    }
  }
}
