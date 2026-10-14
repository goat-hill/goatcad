/**
 * The layout viewport's assembly overlay: component bodies and their contact
 * shadows, drawn over the board as a drawing.
 *
 * This is `BoardScene3D` composited into the 2D editor's own render stack
 * rather than a second viewport. `ViewportEngine.camera2D` is already an
 * orthographic camera in a millimeter world, so the same scene the 3D pane
 * builds lands pixel-registered on the layout at every zoom and pan — the
 * toggle changes what you see without moving anything, which is the whole
 * point of the feature (blink-compare and judge physical placement without
 * leaving the editable layout).
 *
 * The scene is built on first use and then KEPT. Toggling the layer off only
 * detaches the root from the engine; the geometry, the loaded models, and the
 * clip results all survive, so every toggle after the first is immediate. A
 * rebuild is owed only when the board itself changes, and while the layer is
 * off that debt is deferred rather than paid.
 */

import * as THREE from 'three'
import type { KicadBoard } from '../../kicad/board'
import type { Board3DViewState } from '../../../../../preload/board3dTypes'
import { FRAME_BUDGET_MS, yieldControl } from '../../cooperate'
import { loadClipper } from '../../geometry/clip'
import { DIM_ALPHA_FACTOR } from '../../kicad/layers'
import type { NonActiveLayerDisplay } from '../../board/layerPresets'
import { BoardScene3D } from './BoardScene3D'
import { ComponentModelLoader } from './componentModels'
import { BoardModelAssetCache } from './modelAssetCache'
import { applyShadowRoles } from './boardLighting'

export type BoardRenderPresentation = 'assembly' | '3d'

/** What the layer needs from the viewport engine — the seam tests stand on. */
export interface RenderLayerHost {
  setRenderLayer(root: THREE.Object3D | null): void
  /** Near and far halves, and how much of the far one survives (0 hides it). */
  setRenderLayerSides(
    near: THREE.Object3D | null,
    far: THREE.Object3D | null,
    farOpacityScale: number
  ): void
  setRenderLayerOpacity(opacity: number): void
  /** The scene changed but its bounds did not; repaint its cached texture. */
  invalidateRenderLayer(): void
  /** Re-fit the shadow frustum and regenerate the shadow map — after a build. */
  refreshRenderLayer(): void
  render(): void
}

const componentOptionsKey = (sources: BoardRenderLayerSources): string => {
  const o = sources.options
  return [
    sources.filePath,
    sources.projectDir,
    o.models,
    o.modelsThroughHole,
    o.modelsSmd,
    o.modelsUnspecified,
    o.modelsDnp,
    o.modelsNotInPosFiles
  ].join('|')
}

/**
 * A board change that follows another this soon waits for this much quiet
 * before it rebuilds: a lone edit rebuilds at once, a burst (an agent's
 * writes, each with its refill) rebuilds once it settles.
 */
export const REBUILD_SETTLE_MS = 500

export interface BoardRenderLayerSources {
  board: KicadBoard | null
  /** The board file, for resolving `(model …)` links. */
  filePath: string | null
  /** Directory of the `.kicad_pro`, for project-relative model links. */
  projectDir: string | null
  /** View-from-back: the layout mirrors X, so the render turns over to match. */
  flipped: boolean
  /**
   * What the layout does with layers it is not working on. The overlay answers
   * to it too: parts on the far side of the board are context in exactly the
   * sense a non-active layer is, and a board where you cannot tell which side a
   * part is on is worse than one that says so quietly.
   */
  nonActiveDisplay: NonActiveLayerDisplay
  options: Board3DViewState
}

export class BoardRenderLayer {
  private scene: BoardScene3D | null = null
  private loader: ComponentModelLoader | null = null
  private enabled = false
  private disposed = false
  /** A build is owed — the board changed, or nothing has been built yet. */
  private dirty = true
  /** Component sources/filters changed without requiring board geometry. */
  private modelsDirty = true
  /** Bumped to abandon a build a newer board or a disable superseded. */
  private token = 0
  private building = false
  /** Invisible board surface: catches contact shadows and occludes back parts. */
  private readonly shadowCatcher = new THREE.ShadowMaterial({
    color: 0x000000,
    opacity: 0.32,
    transparent: true,
    depthWrite: true
  })
  private readonly bodyMaterials = new WeakMap<THREE.Mesh, THREE.Material | THREE.Material[]>()
  private presentation: BoardRenderPresentation = 'assembly'
  /** Component transforms at the start of the current interactive move. */
  private readonly dragOrigins = new Map<THREE.Object3D, THREE.Vector3>()
  /** The current attach/build, so a caller (or a test) can await quiescence. */
  private inFlight: Promise<void> = Promise.resolve()
  /** When the board last changed, for telling a burst from a lone edit. */
  private boardChangedAt = -Infinity
  /** A burst's rebuild, waiting for the board to settle, and what settles with it. */
  private settleTimer: ReturnType<typeof setTimeout> | null = null
  private settling: { promise: Promise<void>; resolve: () => void } | null = null
  private sources: BoardRenderLayerSources = {
    board: null,
    filePath: null,
    projectDir: null,
    flipped: false,
    nonActiveDisplay: 'show',
    options: {} as Board3DViewState
  }

  constructor(
    private readonly host: RenderLayerHost,
    /** Told when a build starts and finishes, for the viewport's progress pill. */
    private readonly onBusy: (busy: boolean) => void = () => {},
    private readonly modelCache?: BoardModelAssetCache
  ) {}

  get isBuilding(): boolean {
    return this.building
  }

  /** Resolves once the pending attach and build have finished. */
  settled(): Promise<void> {
    const settling = this.settling
    return settling ? settling.promise.then(() => this.settled()) : this.inFlight
  }

  /**
   * Point the layer at a board. Identity is the test: an edit hands over a
   * remapped facade, and a remap means the geometry moved.
   */
  setSources(next: BoardRenderLayerSources): void {
    const previous = this.sources
    this.sources = next
    let deferred = false
    if (next.board !== previous.board) {
      this.dirty = true
      this.modelsDirty = true
      deferred = this.deferBurst()
    } else if (componentOptionsKey(next) !== componentOptionsKey(previous)) {
      this.modelsDirty = true
    }
    const flipChanged = next.flipped !== previous.flipped
    if (this.scene) this.scene.root.rotation.y = next.flipped ? Math.PI : 0
    const optionsChanged = next.options !== previous.options && !!this.scene && !this.dirty
    if (optionsChanged) {
      this.scene?.setOptions(next.options)
      this.applyPresentation()
    }
    if (this.enabled) {
      if (!deferred) this.track()
    } else if (this.scene) this.host.render()
    // A switch can show or hide what casts (parts) or receives (the board);
    // the kept shadow map has to follow, as it does a flip.
    if ((flipChanged || optionsChanged) && this.enabled && this.scene)
      this.host.refreshRenderLayer()
  }

  /**
   * Whether this board change waits for the burst it belongs to to settle.
   * Only a built, showing scene waits: a first build or a switch-on is owed at once.
   */
  private deferBurst(): boolean {
    const now = performance.now()
    const burst = now - this.boardChangedAt < REBUILD_SETTLE_MS
    this.boardChangedAt = now
    if (!burst && !this.settleTimer) return false
    if (!this.enabled || !this.scene) return false
    if (this.settleTimer) clearTimeout(this.settleTimer)
    if (!this.settling) {
      let resolve = (): void => {}
      const promise = new Promise<void>((done) => (resolve = done))
      this.settling = { promise, resolve }
    }
    this.settleTimer = setTimeout(() => this.endSettle(true), REBUILD_SETTLE_MS)
    return true
  }

  /** The burst is over (or moot): build what it owes when asked to. */
  private endSettle(build: boolean): void {
    if (this.settleTimer) clearTimeout(this.settleTimer)
    this.settleTimer = null
    const settling = this.settling
    this.settling = null
    if (build && this.enabled && !this.disposed) this.track()
    settling?.resolve()
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return
    this.enabled = enabled
    // Switching off drops a burst's wait; its build stays owed.
    if (this.settling) this.endSettle(false)
    if (!enabled) {
      // A partial scene is not a cache entry. It is safe to keep its allocated
      // objects, but the next enable must finish by rebuilding them.
      if (this.building) this.dirty = true
      this.token++
      this.building = false
      this.onBusy(false)
      this.host.setRenderLayer(null)
      return
    }
    this.track()
  }

  setOpacity(opacity: number): void {
    this.host.setRenderLayerOpacity(opacity)
  }

  /**
   * Chain a sync onto the in-flight one, so `settled()` covers both. The chain
   * must end resolved even when a sync throws: every later track() extends
   * this promise, and one uncaught rejection would keep sync from ever
   * running again for the life of the layer.
   */
  private track(): void {
    this.inFlight = this.inFlight
      .then(() => this.sync())
      .catch((error) => {
        console.error('Assembly overlay sync failed', error)
      })
  }

  /** Attach what exists now, and build what is owed. */
  private async sync(): Promise<void> {
    if (this.disposed || !this.enabled) return
    if (!this.sources.board) {
      this.host.setRenderLayer(null)
      return
    }
    if (!this.scene) {
      this.scene = new BoardScene3D()
      this.scene.root.rotation.y = this.sources.flipped ? Math.PI : 0
      this.loader = new ComponentModelLoader(this.scene.components, this.modelCache)
    }
    this.host.setRenderLayer(this.scene.root)
    if (this.dirty) await this.build()
    else if (this.modelsDirty) await this.reloadModels()
  }

  private async build(): Promise<void> {
    const scene = this.scene
    const board = this.sources.board
    if (!scene || !board) return
    const token = ++this.token
    this.dirty = false
    // BoardScene3D lands substrate and surface groups progressively. Those are
    // useful in 3D Preview but would flash a complete PCB here before the
    // assembly-only visibility policy is applied. Reveal the root only once
    // its invisible shadow catcher is in place.
    scene.root.visible = false
    this.host.invalidateRenderLayer()
    this.building = true
    this.onBusy(true)
    try {
      // On failure the board still builds, just with unclipped layers.
      await loadClipper()
      if (this.stale(token)) return

      // The same cooperative drain the 3D pane uses: the layout stays
      // interactive while a dense board assembles behind it.
      const steps = scene.buildSteps(board, this.sources.options)
      let sliceStart = performance.now()
      let step = steps.next()
      while (!step.done) {
        if (performance.now() - sliceStart > FRAME_BUDGET_MS) {
          this.host.invalidateRenderLayer()
          await yieldControl()
          if (this.stale(token)) return
          sliceStart = performance.now()
        }
        step = steps.next()
      }
      this.applyPresentation()
      applyShadowRoles(scene.root)
      scene.root.visible = true
      this.host.refreshRenderLayer()
      await this.loadModels(token)
    } finally {
      if (token === this.token) {
        this.building = false
        this.onBusy(false)
      }
    }
  }

  private async loadModels(token: number): Promise<void> {
    const loader = this.loader
    const board = this.sources.board
    if (!loader || !board) return
    const options = this.sources.options
    this.modelsDirty = false
    if (!options.models) {
      loader.clear()
      this.applyPresentation()
      // The shadow map is kept, not redrawn per frame: without a refresh the
      // parts just cleared would go on shadowing the board.
      this.host.refreshRenderLayer()
      return
    }
    await loader.load(
      board,
      this.sources.filePath,
      this.sources.projectDir,
      {
        tht: options.modelsThroughHole,
        smd: options.modelsSmd,
        unspecified: options.modelsUnspecified,
        dnp: options.modelsDnp,
        notInPosFiles: options.modelsNotInPosFiles
      },
      () => {
        // Parts stream in one at a time; regenerating the shadow map per
        // placement would cost a full shadow pass each. They land unshadowed
        // and the single refresh below catches them all.
        if (!this.stale(token)) this.host.invalidateRenderLayer()
      },
      // Placement review is the job here, so a part with no installed model
      // still has to occupy its space (`placementBodies.ts`).
      { standIns: true }
    )
    if (this.stale(token) || !this.scene) return
    this.applyPresentation()
    applyShadowRoles(this.scene.root)
    this.host.refreshRenderLayer()
  }

  /** Reload only placed bodies when a component filter/source changes. */
  private async reloadModels(): Promise<void> {
    if (!this.scene || !this.sources.board) return
    const token = ++this.token
    this.building = true
    this.onBusy(true)
    try {
      await this.loadModels(token)
    } finally {
      if (token === this.token) {
        this.building = false
        this.onBusy(false)
      }
    }
  }

  /**
   * The layout already draws the board better than a translucent physical
   * duplicate can. Keep only parts and their contact shadows here; the hidden
   * body still writes depth so components on the far face stay occluded.
   */
  setPresentation(presentation: BoardRenderPresentation): void {
    if (this.presentation === presentation) return
    this.presentation = presentation
    this.applyPresentation()
    this.host.refreshRenderLayer()
  }

  getBounds(): THREE.Box3 | null {
    if (!this.scene || !this.scene.root.visible) return null
    this.scene.root.updateMatrixWorld(true)
    const bounds = new THREE.Box3().setFromObject(this.scene.root)
    return bounds.isEmpty() ? null : bounds
  }

  /**
   * Hand the engine the two halves and say how much of the far one survives.
   *
   * Which half is far follows the LAYOUT's flip, not the active layer: the
   * overlay is registered pixel-for-pixel on the layout beneath it, so it has to
   * agree with it about which way the board is facing. The fade is the layout's
   * own non-active setting, so one control governs "this is context" everywhere
   * — dim leaves the far side legible for clearance, hide takes it away, show
   * keeps both at full strength as before.
   *
   * 3D preview gets none of this: there the board is a real opaque object and
   * occlusion is physical, so a policy would only fight it.
   */
  private applySides(): void {
    const groups = this.loader?.sideGroups()
    if (!groups) return
    if (this.presentation === '3d') {
      this.host.setRenderLayerSides(null, null, 1)
      return
    }
    const flipped = this.sources.flipped
    const near = flipped ? groups.back : groups.front
    const far = flipped ? groups.front : groups.back
    const scale =
      this.sources.nonActiveDisplay === 'hide'
        ? 0
        : this.sources.nonActiveDisplay === 'dim'
          ? DIM_ALPHA_FACTOR
          : 1
    this.host.setRenderLayerSides(near, far, scale)
  }

  private applyPresentation(): void {
    const root = this.scene?.root
    if (!root) return
    // `setOptions` restores the physical view's intended group visibility.
    this.scene?.setOptions(this.sources.options)
    this.applySides()
    for (const group of root.children) {
      if (this.presentation === 'assembly') {
        group.visible =
          group.name === 'body' || (group.name === 'components' && this.sources.options.models)
      }
      if (group.name !== 'body') continue
      group.traverse((object) => {
        const mesh = object as THREE.Mesh
        if (!mesh.isMesh) return
        const original = this.bodyMaterials.get(mesh)
        if (this.presentation === '3d') {
          if (original) mesh.material = original
        } else {
          if (!original) this.bodyMaterials.set(mesh, mesh.material)
          mesh.material = this.shadowCatcher
        }
      })
    }
  }

  /** Snapshot rendered footprints before the 2D drag starts. */
  beginComponentDrag(items: ReadonlyArray<{ type: string; index: number }>): void {
    this.dragOrigins.clear()
    const board = this.sources.board
    const components = this.scene?.components
    if (!board || !components) return
    for (const item of items) {
      if (item.type !== 'footprint') continue
      const fp = board.footprints[item.index]
      if (!fp) continue
      const suffix = fp.reference ?? fp.libId
      // Placements sit one level down now, under their side's group.
      for (const side of components.children) {
        for (const child of side.children) {
          if (child.name === `component:${suffix}` || child.name === `standin:${suffix}`) {
            this.dragOrigins.set(child, child.position.clone())
          }
        }
      }
    }
    // Do not drag yesterday's contact shadow around behind the body, and do
    // not regenerate a 2048px shadow map on every mousemove. Clear it once;
    // the final position gets a fresh shadow in clearComponentDrag().
    if (this.dragOrigins.size > 0) {
      for (const component of this.dragOrigins.keys()) {
        component.traverse((object) => (object.castShadow = false))
      }
      this.host.refreshRenderLayer()
    }
  }

  /** Apply the same data-space delta as the 2D footprint preview. */
  translateComponentDrag(delta: { x: number; y: number }): void {
    if (this.dragOrigins.size === 0) return
    for (const [component, origin] of this.dragOrigins) {
      component.position.set(origin.x + delta.x, origin.y + delta.y, origin.z)
    }
    this.host.invalidateRenderLayer()
  }

  clearComponentDrag(): void {
    if (this.dragOrigins.size > 0) {
      for (const component of this.dragOrigins.keys()) {
        component.traverse((object) => (object.castShadow = true))
      }
      this.host.refreshRenderLayer()
    }
    this.dragOrigins.clear()
  }

  private stale(token: number): boolean {
    return this.disposed || token !== this.token || !this.enabled
  }

  dispose(): void {
    this.endSettle(false)
    this.disposed = true
    this.token++
    this.host.setRenderLayer(null)
    // The engine never owned this root (unlike the 3D pane's, which its
    // engine clears on destroy), so the scene disposes its own geometry here.
    this.loader?.dispose()
    this.loader = null
    this.scene?.dispose()
    this.scene = null
    this.shadowCatcher.dispose()
    this.dragOrigins.clear()
  }
}
