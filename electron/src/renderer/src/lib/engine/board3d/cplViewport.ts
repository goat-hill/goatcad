/**
 * The pick-and-place preview's board (Manufacture ▸ Pick & place): the board
 * as the 3D pane builds it — substrate, copper, mask, silk and parts — seen
 * straight down through an orthographic camera, from the front or from below.
 *
 * Read flat, as a placement map is read: pan and zoom, no orbit. Only the
 * parts on the side being looked at are drawn, faded, and the ones asked for
 * show whole, so "where is C42 and which way does it face" is one glance at
 * the board as it will come off the line.
 *
 * World convention is the 3D board's: millimeters, Z up, the file's y negated.
 * Screen positions for the preview's overlay (pips, labels, the origin) come
 * from `toScreen`, in CSS pixels of the container.
 */

import * as THREE from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import type { KicadBoard } from '../../kicad/board'
import { loadClipper } from '../../geometry/clip'
import { defaultBoard3DViewState } from '../../board3dView'
import { observeDevicePixelSize } from '../devicePixelSize'
import { BoardScene3D } from './BoardScene3D'
import { buildBoardOutline } from './boardOutline'
import { ComponentModelLoader } from './componentModels'
import { BoardModelAssetCache } from './modelAssetCache'
import { gpuPowerPreference } from '../../gpuPreference'

export type CplSideView = 'top' | 'bottom'

/** How much of a part is left when it is not the one asked for. */
const FADED_OPACITY = 0.22

/** Room round the board when the view is fitted, as a share of its size. */
const FIT_MARGIN = 0.08

/**
 * How dark the board is kept under its parts: a sheet laid just over the face
 * being looked at, above its silk and below every part, so the board recedes
 * and the parts read against it.
 */
const BOARD_DIM = 0.55
/** How far over the face the sheet lies, mm: past the silk (0.09), under any part. */
const DIM_LIFT = 0.1

/** Draw order: the board, its dimming sheet, the faded parts, the parts shown whole. */
const RENDER_ORDER = { dimmer: 10, faded: 20, whole: 30 } as const

export class CplViewport {
  private readonly renderer: THREE.WebGLRenderer
  private readonly scene = new THREE.Scene()
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 2000)
  private readonly pmrem: THREE.PMREMGenerator
  private readonly envTexture: THREE.Texture
  private readonly key = new THREE.DirectionalLight(0xfff0dc, 1.1)
  private readonly resizeObserver: ResizeObserver

  private board3d: BoardScene3D | null = null
  private dimmer: THREE.Mesh | null = null
  private loader: ComponentModelLoader | null = null
  private readonly cache = new BoardModelAssetCache()
  private run = 0

  private side: CplSideView = 'top'
  /** The view's center (world mm) and how many millimeters one CSS pixel spans. */
  private center = new THREE.Vector2()
  private mmPerPixel = 0.1
  private highlighted: ReadonlySet<string> = new Set()
  /** Each part's meshes' own materials, copied so one part can fade alone. */
  private readonly parts = new Map<string, THREE.Object3D[]>()
  /** Each part's extent on the board, world mm, for picking. */
  private boxes: Array<{
    reference: string
    back: boolean
    minX: number
    minY: number
    maxX: number
    maxY: number
  }> = []

  private rafId = 0
  private needsRender = true
  /** Parts are still arriving: each frame fades the new ones before it is drawn. */
  private loading = false
  private readonly viewListeners = new Set<() => void>()
  private drag: { x: number; y: number } | null = null

  constructor(private readonly container: HTMLDivElement) {
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: gpuPowerPreference()
    })
    this.renderer.setPixelRatio(1)
    this.renderer.setClearColor(0x000000, 0)
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.domElement.style.width = '100%'
    this.renderer.domElement.style.height = '100%'
    this.renderer.domElement.style.display = 'block'
    container.appendChild(this.renderer.domElement)

    // The 3D pane's studio light: an environment for the PBR models, and a
    // key light that follows the camera to whichever face is being looked at.
    this.pmrem = new THREE.PMREMGenerator(this.renderer)
    this.envTexture = this.pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    this.scene.environment = this.envTexture
    this.scene.environmentIntensity = 0.55
    this.scene.add(this.key, new THREE.AmbientLight(0xffffff, 0.25))
    this.camera.up.set(0, 1, 0)

    this.resizeObserver = observeDevicePixelSize(this.renderer.domElement, (width, height) => {
      if (width === 0 || height === 0) return
      this.renderer.setSize(width, height, false)
      this.updateCamera()
      this.renderer.render(this.scene, this.camera)
    })

    const canvas = this.renderer.domElement
    canvas.addEventListener('wheel', this.onWheel, { passive: false })
    canvas.addEventListener('pointerdown', this.onPointerDown)
    window.addEventListener('pointermove', this.onPointerMove)
    window.addEventListener('pointerup', this.onPointerUp)
    this.rafId = requestAnimationFrame(this.tick)
  }

  /**
   * Build the board and place its parts. Parts without a model stand in as a
   * body the size of their footprint, so every placement has something to show.
   */
  async setBoard(
    board: KicadBoard | null,
    filePath: string | null,
    projectDir: string | null
  ): Promise<void> {
    const run = ++this.run
    this.clearBoard()
    if (!board) return
    await loadClipper()
    if (run !== this.run) return
    const scene = new BoardScene3D()
    scene.setBoard(board, { ...defaultBoard3DViewState(), models: true })
    this.board3d = scene
    this.scene.add(scene.root)
    this.buildDimmer(scene, board)
    this.fit()
    this.loader = new ComponentModelLoader(scene.components, this.cache)
    this.applySide()
    // Each part fades as it lands, so none shows whole before it is asked for.
    this.loading = true
    try {
      await this.loader.load(
        board,
        filePath,
        projectDir,
        { tht: true, smd: true, unspecified: true, dnp: false, notInPosFiles: false },
        () => {
          if (run === this.run) this.collectParts()
          this.requestRender()
        },
        { standIns: true }
      )
    } finally {
      if (run === this.run) this.loading = false
    }
    if (run !== this.run) return
    this.collectParts()
  }

  /**
   * The sheet that keeps the board dark under its parts, cut to the board's
   * outline — a rectangle would darken the space round it too.
   */
  private buildDimmer(scene: BoardScene3D, board: KicadBoard): void {
    const outline = buildBoardOutline(board)
    if (outline.regions.length === 0) return
    const shapes = outline.regions.map((region) => {
      const shape = new THREE.Shape(region.outer.map((p) => new THREE.Vector2(p.x, p.y)))
      for (const hole of region.holes)
        shape.holes.push(new THREE.Path(hole.map((p) => new THREE.Vector2(p.x, p.y))))
      return shape
    })
    const sheet = new THREE.Mesh(
      new THREE.ShapeGeometry(shapes),
      new THREE.MeshBasicMaterial({
        color: 0x000000,
        transparent: true,
        opacity: BOARD_DIM,
        depthWrite: false,
        side: THREE.DoubleSide
      })
    )
    sheet.userData.surface = scene.thickness / 2 + DIM_LIFT
    // After the board's own translucent layers (mask, silk), which would paint
    // over it; before the parts, which stand above it.
    sheet.renderOrder = RENDER_ORDER.dimmer
    this.dimmer = sheet
    this.scene.add(sheet)
  }

  /** Look at the front, or turn the board over and look at its back. */
  setSide(side: CplSideView): void {
    if (side === this.side) return
    this.side = side
    this.applySide()
    this.updateCamera()
    this.notifyView()
  }

  /** The parts shown whole; every other part on the side fades. Only the parts that change are touched. */
  setHighlight(references: ReadonlySet<string>): void {
    const before = this.highlighted
    this.highlighted = references
    for (const reference of before) if (!references.has(reference)) this.paint(reference)
    for (const reference of references) if (!before.has(reference)) this.paint(reference)
    this.requestRender()
  }

  /** Frame the whole board. */
  fit(): void {
    const bounds = this.board3d?.getBoardBounds()
    const { clientWidth: width, clientHeight: height } = this.container
    if (!bounds || bounds.isEmpty() || !width || !height) return
    const size = bounds.getSize(new THREE.Vector3())
    const center = bounds.getCenter(new THREE.Vector3())
    this.center.set(center.x, center.y)
    this.mmPerPixel = Math.max(size.x / width, size.y / height) * (1 + 2 * FIT_MARGIN) || 0.1
    this.updateCamera()
    this.notifyView()
  }

  /**
   * Where a point of the board file (mm, y down) lands in the container, CSS
   * pixels; the back view is turned over, so its x runs the other way.
   */
  toScreen(x: number, y: number): { x: number; y: number } {
    const { clientWidth: width, clientHeight: height } = this.container
    const dx = (x - this.center.x) / this.mmPerPixel
    const dy = (-y - this.center.y) / this.mmPerPixel
    return { x: width / 2 + (this.side === 'top' ? dx : -dx), y: height / 2 - dy }
  }

  /** The part under a point of the container, by reference, on the side shown. */
  pick(clientX: number, clientY: number): string | null {
    // By each part's box on the board, not its triangles: a model is thousands
    // of them, and this runs on every move of the pointer. The smallest box
    // under the pointer wins, so a part sitting on a larger one is reachable.
    const rect = this.renderer.domElement.getBoundingClientRect()
    const flip = this.side === 'top' ? 1 : -1
    const x = this.center.x + flip * (clientX - rect.left - rect.width / 2) * this.mmPerPixel
    const y = this.center.y - (clientY - rect.top - rect.height / 2) * this.mmPerPixel
    const back = this.side === 'bottom'
    let best: string | null = null
    let bestArea = Infinity
    for (const box of this.boxes) {
      if (box.back !== back || x < box.minX || x > box.maxX || y < box.minY || y > box.maxY)
        continue
      const area = (box.maxX - box.minX) * (box.maxY - box.minY)
      if (area < bestArea) {
        bestArea = area
        best = box.reference
      }
    }
    return best
  }

  /** Called whenever the view moves, so an overlay can follow. */
  onViewChange(listener: () => void): () => void {
    this.viewListeners.add(listener)
    return () => this.viewListeners.delete(listener)
  }

  destroy(): void {
    cancelAnimationFrame(this.rafId)
    this.run++
    this.clearBoard()
    this.cache.dispose()
    const canvas = this.renderer.domElement
    canvas.removeEventListener('wheel', this.onWheel)
    canvas.removeEventListener('pointerdown', this.onPointerDown)
    window.removeEventListener('pointermove', this.onPointerMove)
    window.removeEventListener('pointerup', this.onPointerUp)
    this.resizeObserver.disconnect()
    this.envTexture.dispose()
    this.pmrem.dispose()
    this.renderer.dispose()
    this.renderer.forceContextLoss()
    canvas.remove()
  }

  // -------------------------------------------------------------------------

  private requestRender(): void {
    this.needsRender = true
  }

  private tick = (): void => {
    this.rafId = requestAnimationFrame(this.tick)
    if (this.loading) this.collectParts()
    if (!this.needsRender) return
    this.needsRender = false
    this.renderer.render(this.scene, this.camera)
  }

  private notifyView(): void {
    for (const listener of this.viewListeners) listener()
  }

  private updateCamera(): void {
    const { clientWidth: width, clientHeight: height } = this.container
    if (!width || !height) return
    const halfW = (width * this.mmPerPixel) / 2
    const halfH = (height * this.mmPerPixel) / 2
    this.camera.left = -halfW
    this.camera.right = halfW
    this.camera.top = halfH
    this.camera.bottom = -halfH
    // From above, or from below the board looking up: the back reads turned
    // over, as the board is held to place its underside.
    const height3d = 500
    const z = this.side === 'top' ? height3d : -height3d
    this.camera.position.set(this.center.x, this.center.y, z)
    this.camera.lookAt(this.center.x, this.center.y, 0)
    this.camera.updateProjectionMatrix()
    this.key.position.set(this.center.x + 60, this.center.y - 40, z)
    this.key.target.position.set(this.center.x, this.center.y, 0)
    this.key.target.updateMatrixWorld()
    this.requestRender()
  }

  private clearBoard(): void {
    if (this.dimmer) {
      this.scene.remove(this.dimmer)
      this.dimmer.geometry.dispose()
      ;(this.dimmer.material as THREE.Material).dispose()
      this.dimmer = null
    }
    for (const nodes of this.parts.values())
      for (const node of nodes)
        node.traverse((object) => {
          const mesh = object as THREE.Mesh
          if (!mesh.isMesh) return
          for (const material of materialsOf(mesh)) material.dispose()
        })
    this.parts.clear()
    this.boxes = []
    this.loader?.dispose()
    this.loader = null
    if (this.board3d) {
      this.scene.remove(this.board3d.root)
      this.board3d.dispose()
      this.board3d = null
    }
    this.requestRender()
  }

  /**
   * Gather the placed parts by reference and give each mesh its own copy of
   * its materials: clones of one model share them, and fading one part must
   * not fade its twins.
   */
  private collectParts(): void {
    const groups = this.loader?.sideGroups()
    if (!groups) return
    const added = new Set<string>()
    for (const side of [groups.front, groups.back])
      for (const part of side.children) {
        const reference = referenceOf(part)
        if (!reference || part.userData.cplCollected) continue
        part.userData.cplCollected = true
        added.add(reference)
        part.updateWorldMatrix(true, true)
        const box = new THREE.Box3().setFromObject(part)
        if (!box.isEmpty())
          this.boxes.push({
            reference,
            back: side === groups.back,
            minX: box.min.x,
            minY: box.min.y,
            maxX: box.max.x,
            maxY: box.max.y
          })
        part.traverse((object) => {
          const mesh = object as THREE.Mesh
          if (!mesh.isMesh) return
          const copies = materialsOf(mesh).map((material) => {
            const copy = material.clone()
            copy.userData.opacity = material.opacity
            // A double-sided material drawn transparent (a faded part) is drawn by
            // three twice a frame, back faces then front, with a shader rebuild
            // before each pass; one pass reads the same at a faded part's opacity.
            copy.forceSinglePass = true
            return copy
          })
          mesh.material = Array.isArray(mesh.material) ? copies : copies[0]
        })
        this.parts.set(reference, [...(this.parts.get(reference) ?? []), part])
      }
    for (const reference of added) this.paint(reference)
    if (added.size) this.requestRender()
  }

  /** The side looked at shows its parts; the far side's are not drawn. */
  private applySide(): void {
    const groups = this.loader?.sideGroups()
    if (groups) {
      groups.front.visible = this.side === 'top'
      groups.back.visible = this.side === 'bottom'
    }
    if (this.dimmer) {
      const surface = this.dimmer.userData.surface as number
      this.dimmer.position.z = this.side === 'top' ? surface : -surface
    }
    this.requestRender()
  }

  /** One part as its state says: whole when asked for, else faded. */
  private paint(reference: string): void {
    const nodes = this.parts.get(reference)
    if (!nodes) return
    const whole = this.highlighted.has(reference)
    for (const node of nodes)
      node.traverse((object) => {
        const mesh = object as THREE.Mesh
        if (!mesh.isMesh) return
        for (const material of materialsOf(mesh)) {
          const own = (material.userData.opacity as number | undefined) ?? 1
          material.opacity = whole ? own : own * FADED_OPACITY
          material.transparent = !whole || own < 1
          // A faded part must not hide the board or another part behind it.
          material.depthWrite = whole
        }
        mesh.renderOrder = whole ? RENDER_ORDER.whole : RENDER_ORDER.faded
      })
  }

  private onWheel = (event: WheelEvent): void => {
    event.preventDefault()
    // Zoom about the pointer: the point under it stays under it.
    const rect = this.renderer.domElement.getBoundingClientRect()
    const px = event.clientX - rect.left - rect.width / 2
    const py = event.clientY - rect.top - rect.height / 2
    const flip = this.side === 'top' ? 1 : -1
    const before = {
      x: this.center.x + flip * px * this.mmPerPixel,
      y: this.center.y - py * this.mmPerPixel
    }
    this.mmPerPixel *= Math.exp(event.deltaY * 0.0015)
    this.center.set(before.x - flip * px * this.mmPerPixel, before.y + py * this.mmPerPixel)
    this.updateCamera()
    this.notifyView()
  }

  private onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 && event.button !== 1) return
    this.drag = { x: event.clientX, y: event.clientY }
  }

  private onPointerMove = (event: PointerEvent): void => {
    if (!this.drag) return
    const flip = this.side === 'top' ? 1 : -1
    this.center.x -= flip * (event.clientX - this.drag.x) * this.mmPerPixel
    this.center.y += (event.clientY - this.drag.y) * this.mmPerPixel
    this.drag = { x: event.clientX, y: event.clientY }
    this.updateCamera()
    this.notifyView()
  }

  private onPointerUp = (): void => {
    this.drag = null
  }
}

/** A placed part's reference, from the loader's `component:` or `standin:` group name. */
function referenceOf(node: THREE.Object3D): string | null {
  const match = /^(?:component|standin):(.+)$/.exec(node.name)
  return match ? match[1] : null
}

const materialsOf = (mesh: THREE.Mesh): THREE.Material[] =>
  Array.isArray(mesh.material) ? mesh.material : [mesh.material]
