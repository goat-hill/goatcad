/**
 * The board's 3D view as a PNG, for a person's Export image: the pane's own
 * camera, projection, scene and light, on the pane's background, at the size they chose
 * (`lib/board3dExport.ts`). The agent's render is `boardCapture3D.ts`, which
 * builds its own scene and owns its camera.
 */
import * as THREE from 'three'
import type { PixelSize } from '../../board3dExport'
import type { Board3DBackground } from '../../board3dView'
import type { ViewportEngine } from '../ViewportEngine'
import { captureBackground } from '../Viewport3DEngine'

const SOLID = { white: '#ffffff', black: '#000000' } as const

/** The picture on a canvas, or null when the view is not in 3D or cannot draw the size. */
export const exportBoard3DView = (
  engine: ViewportEngine,
  size: PixelSize,
  background: Board3DBackground
): HTMLCanvasElement | null => {
  const ground =
    background === 'transparent'
      ? null
      : background === 'theme'
        ? captureBackground()
        : new THREE.Color(SOLID[background])
  const image = engine.capture3D(size.width, size.height, ground)
  if (!image) return null
  const canvas = document.createElement('canvas')
  canvas.width = image.width
  canvas.height = image.height
  const context = canvas.getContext('2d')
  if (!context) return null
  context.putImageData(image, 0, 0)
  return canvas
}

/** The canvas as PNG bytes in base64, as `writeFileBase64` takes them. */
export const canvasPngBase64 = (canvas: HTMLCanvasElement): string =>
  canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, '')

/** Put the canvas on the system clipboard as a PNG; false when it is refused. */
export const copyCanvasPng = async (canvas: HTMLCanvasElement): Promise<boolean> => {
  try {
    // The blob is handed over as a promise so `write` itself runs inside the
    // click that asked for it.
    const png = new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('no PNG'))), 'image/png')
    )
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
    return true
  } catch {
    return false
  }
}
