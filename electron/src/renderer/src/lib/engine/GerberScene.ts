import * as THREE from 'three'
import { PrimitiveBatch } from './PrimitiveBatch'
import type { CompositeLayerSpec } from './ViewportEngine'
import type { GerberImage } from '../gerber/parse'
import type { GerberItem } from '../gerber/shapes'
import { boundsValid } from '../gerber/shapes'

/**
 * Renders a set of parsed Gerber layers through ViewportEngine's composite
 * layer stack. Each Gerber layer gets its own THREE.Scene drawn as monochrome
 * coverage into an offscreen target and composited as one flat tint — so
 * overlapping strokes inside a layer read as a single translucent shade, and
 * clear-polarity (LPC) items erase within their layer without darkening or
 * revealing the layers beneath.
 *
 * Paint order inside a layer is the file's item order, realized as
 * renderOrder "runs": consecutive same-polarity items share one PrimitiveBatch
 * (dark = normal blending, clear = erase blending) plus polygon fill meshes.
 * Within a run, painting is a commutative union, so batch/mesh interleaving
 * doesn't matter; across runs, renderOrder is authoritative. All materials
 * are transparent so three.js keeps them in a single renderOrder-sorted list.
 *
 * Color/opacity/visibility live on the CompositeLayerSpecs — the viewer
 * mutates those and re-renders; scenes are only rebuilt when files change.
 */

export interface GerberSceneLayer {
  /** Unique layer key (also the LayersPanel row name). */
  id: string
  image: GerberImage
  /** Base display color (hex). */
  color: string
  /** Base opacity before active/dim adjustments. */
  opacity: number
}

export type GerberNonActiveDisplay = 'show' | 'dim' | 'hide'

const DIM_FACTOR = 0.18
const ACTIVE_OPACITY = 1.0
const WHITE = new THREE.Color('#ffffff')

interface BuiltLayer {
  id: string
  baseColor: THREE.Color
  baseOpacity: number
  spec: CompositeLayerSpec
  batches: PrimitiveBatch[]
  geometries: THREE.BufferGeometry[]
  visible: boolean
}

export class GerberScene {
  private layers: BuiltLayer[] = []
  private activeLayer: string | null = null
  private nonActiveDisplay: GerberNonActiveDisplay = 'show'
  private bounds = new THREE.Box3()

  private readonly fillMaterial = new THREE.MeshBasicMaterial({
    color: WHITE,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide
  })
  private readonly eraseFillMaterial = (() => {
    const material = new THREE.MeshBasicMaterial({
      color: WHITE,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide
    })
    material.blending = THREE.CustomBlending
    material.blendEquation = THREE.AddEquation
    material.blendSrc = THREE.ZeroFactor
    material.blendDst = THREE.OneMinusSrcAlphaFactor
    material.blendSrcAlpha = THREE.ZeroFactor
    material.blendDstAlpha = THREE.OneMinusSrcAlphaFactor
    return material
  })()

  /** Rebuild all layer scenes. Layers must arrive in stack order (bottom first). */
  public build(sources: GerberSceneLayer[]): void {
    this.disposeLayers()
    this.bounds.makeEmpty()

    for (const source of sources) {
      const scene = new THREE.Scene()
      const built: BuiltLayer = {
        id: source.id,
        baseColor: new THREE.Color(source.color),
        baseOpacity: source.opacity,
        spec: {
          scene,
          color: new THREE.Color(source.color),
          opacity: source.opacity,
          visible: true
        },
        batches: [],
        geometries: [],
        visible: true
      }
      this.buildLayerContent(built, source.image.items)
      this.layers.push(built)

      if (boundsValid(source.image.bounds)) {
        const b = source.image.bounds
        this.bounds.expandByPoint(new THREE.Vector3(b.minX, b.minY, 0))
        this.bounds.expandByPoint(new THREE.Vector3(b.maxX, b.maxY, 0))
      }
    }
    this.applyDisplayState()
  }

  private buildLayerContent(layer: BuiltLayer, items: GerberItem[]): void {
    let runPolarity: 'dark' | 'clear' | null = null
    let runOrder = 0
    let batch: PrimitiveBatch | null = null

    const startRun = (polarity: 'dark' | 'clear'): void => {
      runPolarity = polarity
      runOrder++
      batch = null
    }

    const runBatch = (): PrimitiveBatch => {
      if (!batch) {
        batch = new PrimitiveBatch(1024, {
          minStrokePixels: 1,
          blendMode: runPolarity === 'clear' ? 'erase' : 'normal'
        })
        batch.mesh.renderOrder = runOrder
        layer.batches.push(batch)
        layer.spec.scene.add(batch.mesh)
      }
      return batch
    }

    let key = 0
    for (const item of items) {
      if (item.polarity !== runPolarity) startRun(item.polarity)
      const shape = item.shape
      const k = `g:${key++}`
      switch (shape.kind) {
        case 'capsule':
          runBatch().addCapsule(
            k,
            shape.x0,
            shape.y0,
            shape.x1,
            shape.y1,
            shape.halfWidth,
            WHITE,
            1,
            0
          )
          break
        case 'rect':
          runBatch().addRoundRect(
            k,
            shape.cx,
            shape.cy,
            shape.halfW,
            shape.halfH,
            0,
            shape.rotation,
            WHITE,
            1,
            0
          )
          break
        case 'circle':
          // A circle is a rounded rect whose corner radius equals its half-size
          runBatch().addRoundRect(k, shape.cx, shape.cy, shape.r, shape.r, shape.r, 0, WHITE, 1, 0)
          break
        case 'ring':
          runBatch().addRing(k, shape.cx, shape.cy, shape.radius, shape.halfStroke, WHITE, 1, 0)
          break
        case 'arc': {
          const bisector = shape.startAngle + shape.sweep / 2
          const aperture = Math.abs(shape.sweep) / 2
          runBatch().addArc(
            k,
            shape.cx,
            shape.cy,
            shape.radius,
            shape.halfWidth,
            bisector,
            aperture,
            WHITE,
            1,
            0
          )
          break
        }
        case 'poly': {
          if (shape.outline.length < 3) break
          const path = new THREE.Shape(shape.outline.map((p) => new THREE.Vector2(p.x, p.y)))
          for (const hole of shape.holes) {
            if (hole.length >= 3) {
              path.holes.push(new THREE.Path(hole.map((p) => new THREE.Vector2(p.x, p.y))))
            }
          }
          const geometry = new THREE.ShapeGeometry(path)
          const mesh = new THREE.Mesh(
            geometry,
            item.polarity === 'clear' ? this.eraseFillMaterial : this.fillMaterial
          )
          mesh.renderOrder = runOrder
          mesh.frustumCulled = false
          layer.geometries.push(geometry)
          layer.spec.scene.add(mesh)
          break
        }
      }
    }
  }

  public setLayerVisibility(id: string, visible: boolean): void {
    const layer = this.layers.find((l) => l.id === id)
    if (!layer) return
    layer.visible = visible
    this.applyDisplayState()
  }

  public setVisibilityMap(visibility: Record<string, boolean>): void {
    for (const layer of this.layers) {
      layer.visible = visibility[layer.id] ?? true
    }
    this.applyDisplayState()
  }

  public setActiveLayer(id: string | null): void {
    this.activeLayer = id
    this.applyDisplayState()
  }

  public setNonActiveDisplay(mode: GerberNonActiveDisplay): void {
    this.nonActiveDisplay = mode
    this.applyDisplayState()
  }

  private applyDisplayState(): void {
    for (const layer of this.layers) {
      const isActive = this.activeLayer === null || layer.id === this.activeLayer
      let opacity = isActive
        ? Math.max(layer.baseOpacity, ACTIVE_OPACITY * 0.85)
        : layer.baseOpacity
      let visible = layer.visible
      if (!isActive) {
        if (this.nonActiveDisplay === 'dim') opacity *= DIM_FACTOR
        else if (this.nonActiveDisplay === 'hide') visible = false
      }
      layer.spec.opacity = opacity
      layer.spec.visible = visible
      layer.spec.color.copy(layer.baseColor)
    }
  }

  /**
   * Ordered specs for ViewportEngine.setCompositeLayers: build order (bottom
   * first) with the active layer lifted to the top, KiCad-gerbview style.
   */
  public getSpecs(): CompositeLayerSpec[] {
    const specs = this.layers.map((l) => l.spec)
    if (this.activeLayer !== null) {
      const idx = this.layers.findIndex((l) => l.id === this.activeLayer)
      if (idx >= 0) {
        const [active] = specs.splice(idx, 1)
        specs.push(active)
      }
    }
    return specs
  }

  public getBounds(): THREE.Box3 {
    return this.bounds.clone()
  }

  private disposeLayers(): void {
    for (const layer of this.layers) {
      for (const batch of layer.batches) batch.dispose()
      for (const geometry of layer.geometries) geometry.dispose()
    }
    this.layers = []
  }

  public dispose(): void {
    this.disposeLayers()
    this.fillMaterial.dispose()
    this.eraseFillMaterial.dispose()
  }
}
