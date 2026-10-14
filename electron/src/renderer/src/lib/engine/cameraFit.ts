/**
 * Framing a 3D view: where the camera stands and what it orbits.
 *
 * A box round a whole assembly is a poor thing to frame: seen at a tilt, its
 * empty corners (the far edge at the tallest part's height) project well past
 * anything drawn, and its middle floats above the board. So a fit is measured
 * on each drawn object's own box, projected, and the orbit point is put on a
 * plane the caller names — the board's top face — under the middle of what
 * shows. The camera then turns the board about a point on it, and the view
 * comes out centered.
 */
import * as THREE from 'three'

/** An object that carries geometry (mesh, line, points) — `Object3D` alone doesn't. */
interface GeometryObject extends THREE.Object3D {
  geometry: THREE.BufferGeometry
  /** Instanced/batched meshes carry an instance-aware box of their own. */
  boundingBox?: THREE.Box3 | null
  computeBoundingBox?: () => void
}

export const hasGeometry = (object: THREE.Object3D): object is GeometryObject =>
  (object as Partial<GeometryObject>).geometry instanceof THREE.BufferGeometry

const measureBox = new THREE.Box3()

/**
 * Each visible geometry's own world box under `object`, handed over one at a
 * time — the box is reused between calls. Hidden subtrees are skipped, so a
 * layer switched off does not frame.
 */
export function forEachVisibleBox(object: THREE.Object3D, visit: (box: THREE.Box3) => void): void {
  if (!object.visible) return
  if (hasGeometry(object)) {
    if (object.boundingBox !== undefined) {
      if (object.boundingBox === null) object.computeBoundingBox?.()
      if (object.boundingBox) measureBox.copy(object.boundingBox)
      else measureBox.makeEmpty()
    } else {
      if (object.geometry.boundingBox === null) object.geometry.computeBoundingBox()
      measureBox.copy(object.geometry.boundingBox ?? measureBox.makeEmpty())
    }
    if (!measureBox.isEmpty()) {
      measureBox.applyMatrix4(object.matrixWorld)
      visit(measureBox)
    }
  }
  for (const child of object.children) forEachVisibleBox(child, visit)
}

/** Every visible geometry's world box under `root`, copied. */
export const visibleBoxes = (root: THREE.Object3D): THREE.Box3[] => {
  root.updateMatrixWorld(true)
  const boxes: THREE.Box3[] = []
  forEachVisibleBox(root, (box) => boxes.push(box.clone()))
  return boxes
}

export interface OrbitFit {
  position: THREE.Vector3
  target: THREE.Vector3
}

/** The 3D board view's lens, vertical degrees — the PCB editor's 3D mode and
 *  the agent's render alike (`render_board_3d` states it as its default). */
export const BOARD_3D_FOV = 45

/**
 * Room a fit leaves around the content, as a factor on its extent — the 2D
 * canvas's `zoomToFit`, the 3D view's `fitOrbit` and the agent's render
 * (`Viewport3DEngine.captureView`) alike, so switching between
 * them keeps the board the same size on screen.
 */
export const VIEW_FIT_PADDING = 1.3

const ITERATIONS = 12

/**
 * Stand a perspective camera looking along -`direction` so `boxes` fill the
 * view and sit in its middle, orbiting a point on the plane z = `pivotZ`.
 *
 * Solved by a few rounds of the same step: project the boxes, pan the target
 * so their middle is the view's middle, slide it along the view axis back
 * onto the plane (which does not move it on screen), and scale the distance
 * by how much of the view they fill. Perspective makes each step approximate;
 * it settles in a handful.
 */
export function fitOrbit(
  boxes: readonly THREE.Box3[],
  direction: THREE.Vector3,
  fovDegrees: number,
  aspect: number,
  pivotZ: number,
  up = new THREE.Vector3(0, 0, 1)
): OrbitFit | null {
  const union = new THREE.Box3()
  for (const box of boxes) union.union(box)
  if (union.isEmpty()) return null
  const dir = direction.clone().normalize()
  const size = union.getSize(new THREE.Vector3())
  const radius = Math.max(0.5, size.length() / 2)
  const tanV = Math.tan(THREE.MathUtils.degToRad(fovDegrees) / 2)
  const tanH = tanV * aspect

  const target = union.getCenter(new THREE.Vector3())
  target.z = pivotZ
  let distance = radius / Math.min(tanV, tanH)

  const camera = new THREE.PerspectiveCamera(fovDegrees, aspect, 0.01, 1)
  camera.up.copy(up)
  const corner = new THREE.Vector3()
  const right = new THREE.Vector3()
  const screenUp = new THREE.Vector3()
  for (let i = 0; i < ITERATIONS; i++) {
    camera.near = distance / 1000
    camera.far = distance + radius * 8
    camera.position.copy(target).addScaledVector(dir, distance)
    camera.lookAt(target)
    camera.updateMatrixWorld(true)
    camera.updateProjectionMatrix()

    let x0 = Infinity
    let x1 = -Infinity
    let y0 = Infinity
    let y1 = -Infinity
    for (const box of boxes) {
      for (const x of [box.min.x, box.max.x])
        for (const y of [box.min.y, box.max.y])
          for (const z of [box.min.z, box.max.z]) {
            corner.set(x, y, z).project(camera)
            x0 = Math.min(x0, corner.x)
            x1 = Math.max(x1, corner.x)
            y0 = Math.min(y0, corner.y)
            y1 = Math.max(y1, corner.y)
          }
    }
    const cx = (x0 + x1) / 2
    const cy = (y0 + y1) / 2
    // NDC is stretched to the view's aspect on each axis, so equal halves are
    // equal fill.
    const fill = Math.max((x1 - x0) / 2, (y1 - y0) / 2) * VIEW_FIT_PADDING

    // Pan in the view plane, at the target's depth, to bring the middle over.
    right.setFromMatrixColumn(camera.matrixWorld, 0)
    screenUp.setFromMatrixColumn(camera.matrixWorld, 1)
    target
      .addScaledVector(right, cx * distance * tanH)
      .addScaledVector(screenUp, cy * distance * tanV)
    // Along the view axis nothing moves on screen: back onto the plane. An
    // edge-on view never reaches it and keeps the height it has.
    if (Math.abs(dir.z) > 0.05) target.addScaledVector(dir, (pivotZ - target.z) / dir.z)
    distance = Math.max(radius * 0.02, distance * fill)
  }
  return { position: target.clone().addScaledVector(dir, distance), target }
}

const forward = new THREE.Vector3()
const toContent = new THREE.Vector3()

/**
 * Pose `ortho` to draw in parallel what a perspective `lens` orbiting `target`
 * shows: the same direction, through a window the size the lens shows at the
 * target. Switching projection then keeps the board's size, and the lens's
 * own dolly zooms both.
 *
 * A parallel view has no eye to stand in front of, so the camera backs off
 * along the view axis until all of `content` is ahead of it, however close the
 * orbit is; its depth range is then exactly the content's.
 */
export function poseOrthoFromLens(
  ortho: THREE.OrthographicCamera,
  lens: THREE.PerspectiveCamera,
  target: THREE.Vector3,
  content: THREE.Sphere | null
): void {
  const distance = lens.position.distanceTo(target)
  const half = Math.max(distance * Math.tan(THREE.MathUtils.degToRad(lens.fov) / 2), 1e-6)
  ortho.top = half
  ortho.bottom = -half
  ortho.right = half * lens.aspect
  ortho.left = -half * lens.aspect

  forward.set(0, 0, -1).applyQuaternion(lens.quaternion)
  const measured = !!content && content.radius > 0
  const radius = measured ? content.radius * 1.05 : Math.max(distance, 1)
  const ahead = measured ? forward.dot(toContent.copy(content.center).sub(lens.position)) : distance
  const back = Math.max(0, radius - ahead) + 1
  ortho.position.copy(lens.position).addScaledVector(forward, -back)
  ortho.quaternion.copy(lens.quaternion)
  ortho.near = ahead + back - radius
  ortho.far = ahead + back + radius
  ortho.updateProjectionMatrix()
  ortho.updateMatrixWorld(true)
}
