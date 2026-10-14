import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { BOARD_3D_FOV, VIEW_FIT_PADDING, fitOrbit, forEachVisibleBox } from './cameraFit'
import { observeDevicePixelSize } from './devicePixelSize'
import { buildExtentGauge, disposeExtentGauge } from './extentGauge'
import { MIDDLE_DOUBLE_CLICK_INTERVAL_MS } from '../hotkeys'
import { gpuPowerPreference } from '../gpuPreference'
import { themeColor } from '../theme'

/**
 * Reusable perspective 3D viewport: orbit/pan/zoom camera, studio-style
 * image-based lighting over the app's dark theme, and the extent gauge from
 * `extentGauge.ts`. It renders whatever `THREE.Object3D` it is handed — the
 * STEP/WRL model viewer, the footprint editor's model pane, and the PCB
 * editor's 3D board all sit on it, and nothing here knows the difference.
 *
 * World convention is ECAD-style: millimeters, Z up.
 *
 * Rendering is on demand — the rAF loop only issues a GPU frame while the
 * controls are moving (damping), a view animation is in flight, or something
 * marked the frame dirty.
 */

export type ViewPreset = 'iso' | 'front' | 'top' | 'right' | 'back' | 'left' | 'bottom'

/** The iso preset is a gentle hero view rather than a true 45° isometric:
 *  nearly top-down, tipped back so the board's top edge falls away, and
 *  turned a few degrees CCW — the layout view with just enough depth to read
 *  part heights. Tune here: more tilt = more perspective, more turn = more
 *  rotation. */
const ISO_TILT = (22 * Math.PI) / 180
const ISO_TURN = (8 * Math.PI) / 180

/** View directions (camera offset from target), Z up. Top/bottom keep a tiny
 * Y component so the orbit controls never hit the exact pole. */
const VIEW_DIRECTIONS: Record<ViewPreset, THREE.Vector3> = {
  // Camera south of the board and high: the top edge leans away. West of
  // due south by ISO_TURN, which reads as the board turned CCW on screen.
  iso: new THREE.Vector3(
    -Math.sin(ISO_TILT) * Math.sin(ISO_TURN),
    -Math.sin(ISO_TILT) * Math.cos(ISO_TURN),
    Math.cos(ISO_TILT)
  ).normalize(),
  front: new THREE.Vector3(0, -1, 0),
  back: new THREE.Vector3(0, 1, 0),
  right: new THREE.Vector3(1, 0, 0),
  left: new THREE.Vector3(-1, 0, 0),
  top: new THREE.Vector3(0, -0.001, 1).normalize(),
  bottom: new THREE.Vector3(0, -0.001, -1).normalize()
}

const FLIGHT_DURATION_MS = 280

/** Pointer travel (screen px) under which a middle press and release is a click, not a drag. */
const MIDDLE_CLICK_SLOP_PX = 4

/** What an off-screen capture clears to: the 3D pane's background, which is a
 *  CSS gradient on screen and so has no color of its own to borrow. */
export const captureBackground = (): THREE.Color =>
  new THREE.Color(themeColor('--vscode-bg-editor', '#151c19'))

export type CaptureLighting = 'studio' | 'soft' | 'flat' | 'dramatic'

export interface ViewCaptureRequest {
  /** From the target toward the camera, Z up. */
  direction: THREE.Vector3
  /** Degrees about the view axis, counterclockwise. */
  roll?: number
  projection: 'orthographic' | 'perspective'
  /** Vertical field of view in degrees, perspective only. */
  fov?: number
  width: number
  height: number
  /** What zoom 1 fits; absent fits everything drawn. */
  focus?: THREE.Box3 | null
  /** The point looked at; absent is the center of what is framed. */
  target?: THREE.Vector3 | null
  zoom: number
  /** Null clears to transparent. */
  background: THREE.Color | null
  /** A preset of this engine's rig, or `custom`: the content brings its own
   *  lights, and this engine's are switched off but for the environment. */
  lighting: CaptureLighting | { custom: { environment: number } }
  exposure?: number
  /** Tone curve for this capture; absent keeps the engine's. */
  toneMapping?: THREE.ToneMapping
  /** Draw the shadows the content's lights cast. */
  shadows?: boolean
}

/** Top and bottom look down the world up-axis, so they need another one. */
const viewUp = (direction: THREE.Vector3): THREE.Vector3 =>
  Math.abs(direction.z) > 0.999 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1)

/**
 * A box's corners in the axes of a camera looking along -`direction` at
 * `target`, relative to the target: x right, y up, z toward the camera. What a
 * fit is measured against, at any distance.
 */
export const boxInView = (
  box: THREE.Box3,
  direction: THREE.Vector3,
  target: THREE.Vector3,
  roll: number
): THREE.Vector3[] => {
  const pose = new THREE.Object3D()
  pose.up.copy(viewUp(direction))
  pose.position.copy(target).add(direction)
  pose.lookAt(target)
  if (roll) pose.rotateZ((roll * Math.PI) / 180)
  pose.updateMatrixWorld(true)
  const toView = pose.matrixWorld.clone().invert()
  const corners: THREE.Vector3[] = []
  for (const x of [box.min.x, box.max.x])
    for (const y of [box.min.y, box.max.y])
      for (const z of [box.min.z, box.max.z]) {
        const corner = new THREE.Vector3(x, y, z).applyMatrix4(toView)
        // The pose stands one unit out from the target.
        corner.z += 1
        corners.push(corner)
      }
  return corners
}

export interface ViewCapture {
  image: ImageData
  /** One scale across the image plane — orthographic only. */
  mmPerPixel: number | null
  camera: THREE.Camera
}

/**
 * Grow `box` to cover everything visible under `object`.
 *
 * `Box3.setFromObject` would be the one-liner, but it measures hidden subtrees
 * too — and a board with its comments layer switched off would then frame and
 * gauge itself around geometry nobody can see.
 */
function expandByVisible(box: THREE.Box3, object: THREE.Object3D): void {
  forEachVisibleBox(object, (measured) => box.union(measured))
}

interface CameraFlight {
  start: number
  fromPos: THREE.Vector3
  toPos: THREE.Vector3
  fromTarget: THREE.Vector3
  toTarget: THREE.Vector3
}

export class Viewport3DEngine {
  private readonly container: HTMLDivElement
  private readonly renderer: THREE.WebGLRenderer
  public readonly scene = new THREE.Scene()
  private readonly camera: THREE.PerspectiveCamera
  private readonly controls: OrbitControls
  private readonly pmrem: THREE.PMREMGenerator
  private readonly envTexture: THREE.Texture
  private readonly keyLight = new THREE.DirectionalLight(0xfff0dc, 1.1)
  private readonly fillLight = new THREE.DirectionalLight(0xbfd2e8, 0.35)
  private readonly ambientLight = new THREE.AmbientLight(0xffffff, 0.25)

  private model: THREE.Object3D | null = null
  private gauge: THREE.Group | null = null
  // Off until asked for. The gauge is a measuring tool, not scenery: it frames
  // the content in rails and labels, which is exactly what you do not want when
  // the point is to look at the thing.
  private gaugeVisible = false
  private readonly bounds = new THREE.Box3()

  private rafId = 0
  private needsRender = true
  private flight: CameraFlight | null = null
  private resizeObserver: ResizeObserver
  private lastMiddleDownTime = 0
  // The second press of a middle double-click; the fit waits for its release,
  // so a press that turns into a drag (the first click was a slip) stays one.
  private pendingMiddleFit: { x: number; y: number } | null = null

  constructor(container: HTMLDivElement) {
    this.container = container

    // Transparent clear: the theme's radial-gradient background is CSS on the
    // container, which keeps it crisp at any resolution for free.
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: gpuPowerPreference()
    })
    // As the 2D engine's (ViewportEngine.ts): no stall on each new program.
    this.renderer.debug.checkShaderErrors = import.meta.env.DEV
    // Sized in device pixels, exactly — see observeDevicePixelSize. This first
    // size is a guess the observer corrects before anything is painted.
    this.renderer.setPixelRatio(1)
    const ratio = window.devicePixelRatio
    this.renderer.setSize(
      Math.round(container.clientWidth * ratio) || 1,
      Math.round(container.clientHeight * ratio) || 1,
      false
    )
    this.renderer.domElement.style.width = '100%'
    this.renderer.domElement.style.height = '100%'
    this.renderer.setClearColor(0x000000, 0)
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.domElement.style.display = 'block'
    container.appendChild(this.renderer.domElement)

    const aspect = (container.clientWidth || 1) / (container.clientHeight || 1)
    this.camera = new THREE.PerspectiveCamera(40, aspect, 0.1, 5000)
    this.camera.up.set(0, 0, 1)
    this.camera.position.set(60, -60, 45)

    // Studio-style lighting: a neutral generated environment map carries the
    // PBR reflections (STEP materials), while the directional pair gives
    // Phong-lit VRML models shape. Intensities stay low to sit naturally on
    // the dark theme without washing out face colors.
    this.pmrem = new THREE.PMREMGenerator(this.renderer)
    const room = new RoomEnvironment()
    this.envTexture = this.pmrem.fromScene(room, 0.04).texture
    this.scene.environment = this.envTexture
    this.scene.environmentIntensity = 0.55

    this.keyLight.position.set(1, -0.6, 1.4)
    this.fillLight.position.set(-1, 0.8, -0.4)
    this.scene.add(this.keyLight, this.fillLight, this.ambientLight)

    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.12
    // Wheel zoom applies inside the controls' own update() during the wheel
    // event, so the tick's update() sees no movement afterwards — the change
    // event is the only reliable dirty signal for it.
    this.controls.addEventListener('change', () => this.requestRender())

    // Middle-button double-click fits the view, same gesture as the 2D
    // viewports (ViewportEngine); dblclick events only fire for the primary
    // button, so detect manually.
    this.renderer.domElement.addEventListener('pointerdown', this.onPointerDown)
    this.renderer.domElement.addEventListener('pointerup', this.onPointerUp)

    this.resizeObserver = observeDevicePixelSize(this.renderer.domElement, (width, height) =>
      this.resize(width, height)
    )

    this.rafId = requestAnimationFrame(this.tick)
  }

  private onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 1) return
    const now = performance.now()
    if (now - this.lastMiddleDownTime < MIDDLE_DOUBLE_CLICK_INTERVAL_MS) {
      this.lastMiddleDownTime = 0
      this.pendingMiddleFit = { x: e.clientX, y: e.clientY }
    } else {
      this.lastMiddleDownTime = now
      this.pendingMiddleFit = null
    }
  }

  private onPointerUp = (e: PointerEvent): void => {
    if (e.button !== 1 || !this.pendingMiddleFit) return
    const from = this.pendingMiddleFit
    this.pendingMiddleFit = null
    if (Math.hypot(e.clientX - from.x, e.clientY - from.y) < MIDDLE_CLICK_SLOP_PX) this.fitView()
  }

  private tick = (): void => {
    this.rafId = requestAnimationFrame(this.tick)
    const flying = this.updateFlight()
    const moved = this.controls.update()
    if (flying || moved || this.needsRender) {
      this.needsRender = false
      this.renderer.render(this.scene, this.camera)
    }
  }

  /** `bufferWidth` × `bufferHeight` is the canvas in device pixels. */
  private resize(bufferWidth: number, bufferHeight: number): void {
    const width = this.container.clientWidth
    const height = this.container.clientHeight
    if (width === 0 || height === 0 || bufferWidth === 0 || bufferHeight === 0) return
    this.renderer.setSize(bufferWidth, bufferHeight, false)
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
    // setSize clears the (transparent) drawing buffer. ResizeObserver fires
    // after this frame's rAF tick, so a deferred render would present one blank
    // frame — during a continuous drag that reads as the model vanishing.
    // Draw synchronously into the just-sized buffer instead.
    this.renderer.render(this.scene, this.camera)
  }

  public requestRender(): void {
    this.needsRender = true
  }

  /** Replaces the displayed content, rebuilds the gauge, and fits the view. */
  public setModel(model: THREE.Object3D | null, frame = true): void {
    if (this.model) {
      this.scene.remove(this.model)
      disposeObjectTree(this.model)
      this.model = null
    }
    this.bounds.makeEmpty()
    if (model) {
      this.model = model
      this.scene.add(model)
    }
    this.refreshBounds()
    if (model && frame) this.setView('iso', false)
    this.requestRender()
  }

  /**
   * Re-measure the current content and rebuild the gauge around it, leaving the
   * camera where it is.
   *
   * A caller that owns a long-lived group and mutates it — the 3D board view
   * rebuilds layers and streams in component models under one root — cannot go
   * back through `setModel`, which would dispose the very geometry it is
   * keeping and re-frame the camera mid-edit.
   */
  public refreshBounds(): void {
    if (this.gauge) {
      this.scene.remove(this.gauge)
      disposeExtentGauge(this.gauge)
      this.gauge = null
    }
    this.bounds.makeEmpty()
    if (!this.model) {
      this.requestRender()
      return
    }
    this.model.updateWorldMatrix(false, true)
    expandByVisible(this.bounds, this.model)
    if (!this.bounds.isEmpty()) {
      this.gauge = buildExtentGauge(this.bounds)
      this.gauge.visible = this.gaugeVisible
      this.scene.add(this.gauge)
    }
    this.requestRender()
  }

  /** Model size in mm, or null when nothing is loaded. */
  public getDimensions(): { x: number; y: number; z: number } | null {
    if (this.bounds.isEmpty()) return null
    const size = this.bounds.getSize(new THREE.Vector3())
    return { x: size.x, y: size.y, z: size.z }
  }

  public setGaugeVisible(visible: boolean): void {
    this.gaugeVisible = visible
    if (this.gauge) this.gauge.visible = visible
    this.requestRender()
  }

  /** Distance at which the fitted bounds fill the view with some padding. */
  private fitDistance(radius: number): number {
    const vFov = THREE.MathUtils.degToRad(this.camera.fov) / 2
    const hFov = Math.atan(Math.tan(vFov) * this.camera.aspect)
    return (radius / Math.sin(Math.min(vFov, hFov))) * 1.15
  }

  private boundsSphere(): THREE.Sphere {
    const sphere = new THREE.Sphere()
    if (this.bounds.isEmpty()) {
      sphere.set(new THREE.Vector3(), 50)
    } else {
      this.bounds.getBoundingSphere(sphere)
      // Leave room for the gauge rails and labels outside the box.
      sphere.radius *= 1.18
    }
    return sphere
  }

  private applyCameraRange(radius: number, distance: number): void {
    this.camera.near = Math.max(distance / 1000, radius / 1000)
    this.camera.far = distance + radius * 40
    this.camera.updateProjectionMatrix()
    this.controls.minDistance = radius * 0.05
    this.controls.maxDistance = distance * 12
  }

  /** Re-frames the content, keeping the current viewing direction. */
  public fitView(animate = true): void {
    const sphere = this.boundsSphere()
    const distance = this.fitDistance(sphere.radius)
    const direction = this.camera.position.clone().sub(this.controls.target).normalize()
    if (direction.lengthSq() < 0.5) direction.copy(VIEW_DIRECTIONS.iso)
    this.applyCameraRange(sphere.radius, distance)
    this.flyTo(sphere.center.clone().addScaledVector(direction, distance), sphere.center, animate)
  }

  /**
   * Straight down on `boxes`, framed as the 2D canvas frames the same extent
   * (`fitOrbit`, `VIEW_FIT_PADDING`) — so a part's 3D preview opens the size
   * and place its 2D preview shows it. Falls back to the top preset when there
   * is nothing to measure.
   */
  public frameTop(boxes: readonly THREE.Box3[], animate = false): void {
    const union = new THREE.Box3()
    for (const box of boxes) union.union(box)
    const fit = union.isEmpty()
      ? null
      : fitOrbit(
          boxes,
          VIEW_DIRECTIONS.top,
          this.camera.fov,
          this.camera.aspect,
          union.max.z,
          this.camera.up
        )
    if (!fit) {
      this.setView('top', animate)
      return
    }
    const radius = Math.max(0.5, union.getSize(new THREE.Vector3()).length() / 2)
    this.applyCameraRange(radius, fit.position.distanceTo(fit.target))
    this.flyTo(fit.position, fit.target, animate)
  }

  /** Moves the camera to a standard view, framing the whole model. */
  public setView(preset: ViewPreset, animate = true): void {
    const sphere = this.boundsSphere()
    const distance = this.fitDistance(sphere.radius)
    this.applyCameraRange(sphere.radius, distance)
    const position = sphere.center.clone().addScaledVector(VIEW_DIRECTIONS[preset], distance)
    this.flyTo(position, sphere.center, animate)
  }

  private flyTo(position: THREE.Vector3, target: THREE.Vector3, animate: boolean): void {
    if (!animate) {
      this.flight = null
      this.camera.position.copy(position)
      this.controls.target.copy(target)
      this.controls.update()
      this.requestRender()
      return
    }
    this.flight = {
      start: performance.now(),
      fromPos: this.camera.position.clone(),
      toPos: position,
      fromTarget: this.controls.target.clone(),
      toTarget: target
    }
  }

  /** Advances the view animation; returns whether one is still running. */
  private updateFlight(): boolean {
    if (!this.flight) return false
    const t = Math.min(1, (performance.now() - this.flight.start) / FLIGHT_DURATION_MS)
    const eased = 1 - Math.pow(1 - t, 3)
    this.camera.position.lerpVectors(this.flight.fromPos, this.flight.toPos, eased)
    this.controls.target.lerpVectors(this.flight.fromTarget, this.flight.toTarget, eased)
    if (t >= 1) this.flight = null
    return true
  }

  /**
   * One off-screen orthographic view of the current content, for the agent's
   * four-view picture.
   *
   * Orthographic rather than the pane's perspective camera: the picture is
   * measured against a scale bar, and a part read at an angle under
   * perspective is a part whose size cannot be read off it. The on-screen
   * camera is untouched — a capture borrows the renderer, not the view.
   *
   * `mmPerPixel` is the caller's, so every tile of a grid can be drawn at one
   * scale and share a single bar.
   */
  public captureOrthoView(
    preset: ViewPreset,
    pixels: number,
    mmPerPixel: number,
    focus?: THREE.Box3 | null
  ): ImageData | null {
    // What to FRAME and what to DRAW are different questions: a footprint's
    // model is drawn standing on a preview board, and framing that board would
    // shrink the part — the thing being inspected — to a third of the tile.
    const framed = focus && !focus.isEmpty() ? focus : this.bounds
    if (framed.isEmpty()) return null
    const center = framed.getCenter(new THREE.Vector3())
    const radius = this.bounds.getBoundingSphere(new THREE.Sphere()).radius || 1
    const direction = VIEW_DIRECTIONS[preset]
    const half = (pixels * mmPerPixel) / 2
    const camera = new THREE.OrthographicCamera(-half, half, half, -half, 0.01, radius * 8)
    // Top and bottom look down the world up-axis, so they need another one.
    camera.up.set(
      0,
      preset === 'top' || preset === 'bottom' ? 1 : 0,
      preset === 'top' || preset === 'bottom' ? 0 : 1
    )
    camera.position.copy(center).addScaledVector(direction, radius * 3)
    camera.lookAt(center)
    camera.updateMatrixWorld(true)
    camera.updateProjectionMatrix()

    return this.renderPixels(camera, pixels, pixels, captureBackground())
  }

  /**
   * One off-screen picture of the current content from any direction, for a
   * caller that owns the camera: the agent's board render. Zoom 1 fits `focus`
   * (else everything drawn) to the frame; the on-screen camera is untouched.
   */
  public captureView(request: ViewCaptureRequest): ViewCapture | null {
    const framed = request.focus && !request.focus.isEmpty() ? request.focus : this.bounds
    if (framed.isEmpty()) return null
    const { width, height } = request
    const aspect = width / height
    const direction = request.direction.clone().normalize()
    const target = request.target ?? framed.getCenter(new THREE.Vector3())
    const radius = this.bounds.getBoundingSphere(new THREE.Sphere()).radius || 1

    const up = viewUp(direction)
    const corners = boxInView(framed, direction, target, request.roll ?? 0)

    const zoom = request.zoom > 0 ? request.zoom : 1
    // First a symmetric camera about the target that holds every corner; the
    // window is then fitted to where the corners actually land (below).
    let camera: THREE.OrthographicCamera | THREE.PerspectiveCamera
    if (request.projection === 'perspective') {
      const fov = request.fov ?? BOARD_3D_FOV
      const tanV = Math.tan((fov * Math.PI) / 360)
      const tanH = tanV * aspect
      let fit = 0
      for (const c of corners) {
        fit = Math.max(fit, c.z + Math.abs(c.x) / tanH, c.z + Math.abs(c.y) / tanV)
      }
      const distance = Math.max(fit, radius * 0.01, 0.1)
      const perspective = new THREE.PerspectiveCamera(
        fov,
        aspect,
        distance / 1000,
        distance + radius * 4
      )
      perspective.position.copy(target).addScaledVector(direction, distance)
      camera = perspective
    } else {
      let halfX = 0
      let halfY = 0
      for (const c of corners) {
        halfX = Math.max(halfX, Math.abs(c.x))
        halfY = Math.max(halfY, Math.abs(c.y))
      }
      const half = Math.max(halfY, halfX / aspect, 0.05)
      const ortho = new THREE.OrthographicCamera(
        -half * aspect,
        half * aspect,
        half,
        -half,
        0.01,
        radius * 8
      )
      ortho.position.copy(target).addScaledVector(direction, radius * 3)
      camera = ortho
    }
    camera.up.copy(up)
    camera.lookAt(target)
    if (request.roll) camera.rotateZ((request.roll * Math.PI) / 180)
    camera.updateMatrixWorld(true)
    camera.updateProjectionMatrix()

    // Fit the frustum to where the content actually lands — off-axis, the
    // viewpoint unchanged — centered on it, or on the target when the caller
    // named one. Zoom narrows that window. Measured per object: one box round
    // a tilted board has empty corners (the far edge at the tallest part's
    // height) that project well past anything drawn, and under perspective
    // its middle is not the picture's middle either.
    let x0 = Infinity
    let x1 = -Infinity
    let y0 = Infinity
    let y1 = -Infinity
    const corner = new THREE.Vector3()
    const include = (box: THREE.Box3): void => {
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
    if (request.focus && !request.focus.isEmpty()) include(framed)
    else if (this.model) {
      this.model.updateMatrixWorld(true)
      forEachVisibleBox(this.model, include)
    }
    if (!Number.isFinite(x0)) include(framed)
    const cx = request.target ? 0 : (x0 + x1) / 2
    const cy = request.target ? 0 : (y0 + y1) / 2
    // Equal NDC half-extents keep pixels square: NDC is already stretched to
    // the picture's aspect on each axis.
    const half =
      (Math.max(Math.abs(x0 - cx), Math.abs(x1 - cx), Math.abs(y0 - cy), Math.abs(y1 - cy), 1e-3) *
        VIEW_FIT_PADDING) /
      zoom
    let mmPerPixel: number | null = null
    if (camera instanceof THREE.PerspectiveCamera) {
      const top = camera.near * Math.tan((camera.fov * Math.PI) / 360)
      const right = top * aspect
      camera.projectionMatrix.makePerspective(
        (cx - half) * right,
        (cx + half) * right,
        (cy + half) * top,
        (cy - half) * top,
        camera.near,
        camera.far
      )
      camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert()
    } else {
      const top = camera.top
      const right = camera.right
      camera.left = (cx - half) * right
      camera.right = (cx + half) * right
      camera.top = (cy + half) * top
      camera.bottom = (cy - half) * top
      camera.updateProjectionMatrix()
      mmPerPixel = (camera.top - camera.bottom) / height
    }

    const lights = this.applyCaptureLighting(request.lighting, request.exposure ?? 1)
    const savedTone = this.renderer.toneMapping
    const savedShadows = this.renderer.shadowMap.enabled
    try {
      if (request.toneMapping !== undefined) this.renderer.toneMapping = request.toneMapping
      if (request.shadows) {
        this.renderer.shadowMap.enabled = true
        this.renderer.shadowMap.type = THREE.PCFShadowMap
      }
      const image = this.renderPixels(camera, width, height, request.background)
      return image ? { image, mmPerPixel, camera } : null
    } finally {
      this.renderer.toneMapping = savedTone
      this.renderer.shadowMap.enabled = savedShadows
      lights()
    }
  }

  /**
   * Draw one frame through the on-screen path — the canvas's own buffer, not a
   * render target — and read it back. Three applies tone mapping and the sRGB
   * transfer only when drawing to the canvas, so this is the one way a capture
   * looks like the pane. The buffer is borrowed at the capture's size and
   * handed back; the next frame repaints the pane's view.
   */
  private renderPixels(
    camera: THREE.Camera,
    width: number,
    height: number,
    background: THREE.Color | null
  ): ImageData | null {
    const gl = this.renderer.getContext()
    const saved = this.renderer.getSize(new THREE.Vector2())
    const savedRatio = this.renderer.getPixelRatio()
    try {
      this.renderer.setPixelRatio(1)
      this.renderer.setSize(width, height, false)
      if (background) this.renderer.setClearColor(background, 1)
      else this.renderer.setClearColor(0x000000, 0)
      this.renderer.clear(true, true, true)
      this.renderer.render(this.scene, camera)
      // Same task as the draw, so the buffer is still there without
      // preserveDrawingBuffer.
      const raw = new Uint8Array(width * height * 4)
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, raw)
      const image = new ImageData(width, height)
      const stride = width * 4
      for (let y = 0; y < height; y++) {
        const from = (height - 1 - y) * stride
        image.data.set(raw.subarray(from, from + stride), y * stride)
      }
      // The canvas is premultiplied; a PNG is not. Only a transparent
      // background leaves partial alpha to undo.
      if (!background) {
        const data = image.data
        for (let i = 0; i < data.length; i += 4) {
          const alpha = data[i + 3]
          if (alpha === 0 || alpha === 255) continue
          data[i] = Math.min(255, Math.round((data[i] * 255) / alpha))
          data[i + 1] = Math.min(255, Math.round((data[i + 1] * 255) / alpha))
          data[i + 2] = Math.min(255, Math.round((data[i + 2] * 255) / alpha))
        }
      }
      return image
    } finally {
      this.renderer.setPixelRatio(savedRatio)
      this.renderer.setSize(saved.x, saved.y, false)
      this.renderer.setClearColor(0x000000, 0)
      this.requestRender()
    }
  }

  /** The largest picture this GPU can draw, in pixels a side. */
  public maxCaptureSize(): number {
    const gl = this.renderer.getContext()
    const viewport = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array
    return Math.min(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number, viewport[0], viewport[1])
  }

  /**
   * Switch the rig for one capture; the returned function puts it back.
   * Exposure scales the whole rig rather than the tone curve, so the pane's
   * exposure is never borrowed and left changed.
   */
  private applyCaptureLighting(
    lighting: ViewCaptureRequest['lighting'],
    exposure: number
  ): () => void {
    const saved = {
      env: this.scene.environmentIntensity,
      key: this.keyLight.intensity,
      fill: this.fillLight.intensity,
      ambient: this.ambientLight.intensity
    }
    const restore = (): void => {
      this.scene.environmentIntensity = saved.env
      this.keyLight.intensity = saved.key
      this.fillLight.intensity = saved.fill
      this.ambientLight.intensity = saved.ambient
    }
    if (typeof lighting === 'object') {
      this.scene.environmentIntensity = lighting.custom.environment * exposure
      this.keyLight.intensity = 0
      this.fillLight.intensity = 0
      this.ambientLight.intensity = 0
      return restore
    }
    switch (lighting) {
      case 'soft':
        // Reflections alone: no hard key, so no one face goes pale.
        this.scene.environmentIntensity = 0.9
        this.keyLight.intensity = 0
        this.fillLight.intensity = 0
        this.ambientLight.intensity = 0.45
        break
      case 'flat':
        // Every face the same brightness: color as the palette names it.
        this.scene.environmentIntensity = 0
        this.keyLight.intensity = 0
        this.fillLight.intensity = 0
        this.ambientLight.intensity = 2.2
        break
      case 'dramatic':
        this.scene.environmentIntensity = 0.2
        this.keyLight.intensity = 2.2
        this.fillLight.intensity = 0.1
        this.ambientLight.intensity = 0.05
        break
      default:
        break
    }
    this.scene.environmentIntensity *= exposure
    this.keyLight.intensity *= exposure
    this.fillLight.intensity *= exposure
    this.ambientLight.intensity *= exposure
    return restore
  }

  /** The content's size in millimeters, for a caller choosing a common scale. */
  public contentBounds(): THREE.Box3 | null {
    return this.bounds.isEmpty() ? null : this.bounds.clone()
  }

  public destroy(): void {
    cancelAnimationFrame(this.rafId)
    this.renderer.domElement.removeEventListener('pointerdown', this.onPointerDown)
    this.renderer.domElement.removeEventListener('pointerup', this.onPointerUp)
    this.resizeObserver.disconnect()
    this.setModel(null)
    this.controls.dispose()
    this.envTexture.dispose()
    this.pmrem.dispose()
    this.renderer.dispose()
    // Release the WebGL context now instead of when the canvas is GC'd
    this.renderer.forceContextLoss()
    if (this.renderer.domElement.parentNode === this.container) {
      this.container.removeChild(this.renderer.domElement)
    }
  }
}

/** Disposes every geometry/material/texture below the given root. */
export function disposeObjectTree(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const mesh = obj as Partial<THREE.Mesh> & THREE.Object3D
    if (mesh.geometry) mesh.geometry.dispose()
    const material = mesh.material
    const materials = Array.isArray(material) ? material : material ? [material] : []
    for (const mat of materials) {
      const mapped = mat as THREE.Material & { map?: THREE.Texture | null }
      mapped.map?.dispose()
      mat.dispose()
    }
  })
}
