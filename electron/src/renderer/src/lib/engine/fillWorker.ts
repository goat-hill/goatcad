/**
 * Zone-fill triangulation worker. Earcutting a dense board's copper fills
 * costs seconds of CPU (a single 500k-point zone can exceed 2 s), and on the
 * main thread that starves input events — the board would render but drags
 * and clicks stall until every fill lands. Here the cost only delays the
 * fill's own appearance; the board stays interactive throughout.
 *
 * Protocol: one request per contour, coordinates as a transferable
 * Float64Array [x0, y0, x1, y1, ...]; the response transfers the triangle
 * index list back. Triangulation matches BoardScene.earcutContour
 * (THREE.ShapeUtils.triangulateShape with no holes).
 */
import { ShapeUtils, Vector2 } from 'three'

export interface FillWorkRequest {
  id: number
  coords: Float64Array
}

export interface FillWorkResponse {
  id: number
  index: Uint32Array
}

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<FillWorkRequest>) => void) | null
  postMessage: (message: FillWorkResponse, transfer: Transferable[]) => void
}

scope.onmessage = (e: MessageEvent<FillWorkRequest>): void => {
  const { id, coords } = e.data
  // Always answer, even for a degenerate contour that fails to triangulate —
  // an unanswered id would leak its dispatch entry and never resolve the fill
  let index: Uint32Array
  try {
    const contour: Vector2[] = new Array(coords.length / 2)
    for (let i = 0; i < contour.length; i++) {
      contour[i] = new Vector2(coords[i * 2], coords[i * 2 + 1])
    }
    const faces = ShapeUtils.triangulateShape(contour, [])
    index = new Uint32Array(faces.length * 3)
    for (let i = 0; i < faces.length; i++) {
      index[i * 3] = faces[i][0]
      index[i * 3 + 1] = faces[i][1]
      index[i * 3 + 2] = faces[i][2]
    }
  } catch {
    index = new Uint32Array(0)
  }
  scope.postMessage({ id, index }, [index.buffer])
}
