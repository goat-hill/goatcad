/**
 * The 3D board: an extruded substrate with its layers stacked on it, drilled
 * through, and populated with the parts that sit on it.
 *
 * Structure is driven by what a view option can change without paying for it
 * again. Geometry that only depends on the board file is built once into named
 * groups; switching a layer off flips `visible`, and switching solder mask off
 * repaints three materials. Only two things force a rebuild — a new board, and
 * the holes option, because a hole is a cut in the substrate rather than
 * something drawn on it.
 *
 * World convention is the app's usual: millimeters, Z up, +Z out of the board's
 * front face, with the substrate centered on Z = 0 so front and back are
 * mirror heights.
 */

import * as THREE from 'three'
import type { KicadBoard } from '../../kicad/board'
import type { Board3DViewState } from '../../../../../preload/board3dTypes'
import { drainSteps } from '../../geometry/regionClips'
import { maskOpenings } from '../../gerber/write'
import { buildBoardLayersSteps, type Board3DLayers } from './boardLayers'
import { buildBodyGeometrySteps, drillContour } from './bodyGeometry'
import { buildBoardOutline, type BoardOutline } from './boardOutline'
import { boardPalette, type BoardPalette, type PaletteOverrides } from './boardPalette'
import { buildLayerClips, type MaskOpenings } from './layerClips'
import { buildMaskRegionsSteps } from './maskLayer'
import { FlatMeshBuilder, pointInPolygon, type Pt, type ShapeClip } from './flatMesh'
import { nmToMm } from '../../kicad/coordinates'

/** KiCad's default when a board carries no `(general (thickness …))`. */
export const DEFAULT_BOARD_THICKNESS_MM = 1.6

/**
 * Heights above the substrate face, in millimeters. Copper is roughly 1oz;
 * the rest are thin enough to be a stacking order rather than a measurement,
 * spaced so a pad always wins over the track under it.
 */
const COPPER_H = 0.035
const PAD_H = 0.045
const PASTE_H = 0.075
/** Above the copper it drapes over, below the silk printed on top of it. */
const MASK_H = 0.06
const SILK_H = 0.09
/** Annotations are not on the board, so they float clear of it. */
const DRAWINGS_H = 0.4
/** How far a plated barrel sits inside its bore, to avoid coplanar surfaces. */
const BARREL_INSET = 0.006

/**
 * Sanity bound on substrate drill cutouts. The partitioned cap triangulation
 * (`bodyGeometry.ts`) is near-linear in drill count, so this is set far past
 * any real board — it only exists so a pathological file cannot pin the build.
 * Past the cap the extra drills are left uncut and `drillsOmitted` says so;
 * the barrels still render, so the holes are visible either way.
 */
const MAX_DRILL_CUTOUTS = 20_000

/**
 * The build stages, in order, with the share of a full rebuild each one takes
 * (measured on a dense 16-layer board). `buildSteps` reports (stage, fraction
 * within stage); a driver maps that onto one overall progress bar with these
 * spans.
 */
export const BOARD3D_STAGE_SPANS = {
  layers: [0, 0.2],
  body: [0.2, 0.4],
  surfaces: [0.4, 0.8],
  mask: [0.8, 0.95],
  barrels: [0.95, 1]
} as const

export type Board3DBuildStage = keyof typeof BOARD3D_STAGE_SPANS

/** One progress report from the stepwise build. */
export interface Board3DBuildTick {
  stage: Board3DBuildStage
  /** 0–1 within the stage. */
  fraction: number
}

export interface Board3DStats {
  /** True when no closed `Edge.Cuts` ring was found and the body is a stand-in. */
  outlineFallback: boolean
  /** `Edge.Cuts` chains that never closed — usually a gap in the outline. */
  openOutlines: number
  /** Drills left uncut because the board has more than the cap. */
  drillsOmitted: number
  /** Stackup thickness in millimeters — this is world space, not board units. */
  thickness: number
}

export const defaultBoard3DStats = (): Board3DStats => ({
  outlineFallback: false,
  openOutlines: 0,
  drillsOmitted: 0,
  thickness: DEFAULT_BOARD_THICKNESS_MM
})

export class BoardScene3D {
  /** Handed to `Viewport3DEngine` once and mutated in place from then on. */
  readonly root = new THREE.Group()

  readonly components = new THREE.Group()
  private readonly bodyGroup = new THREE.Group()
  private readonly copperGroup = new THREE.Group()
  private readonly padGroup = new THREE.Group()
  private readonly pasteGroup = new THREE.Group()
  private readonly silkGroup = new THREE.Group()
  private readonly maskGroup = new THREE.Group()
  private readonly drawingsGroup = new THREE.Group()
  private readonly barrelGroup = new THREE.Group()
  private axes: THREE.AxesHelper | null = null

  private readonly materials: {
    substrate: THREE.MeshStandardMaterial
    surface: THREE.MeshStandardMaterial
    copper: THREE.MeshStandardMaterial
    pad: THREE.MeshStandardMaterial
    paste: THREE.MeshStandardMaterial
    silk: THREE.MeshStandardMaterial
    backSilk: THREE.MeshStandardMaterial
    mask: THREE.MeshStandardMaterial
    barrel: THREE.MeshStandardMaterial
    drawings: THREE.MeshBasicMaterial
  }

  private board: KicadBoard | null = null
  private layers: Board3DLayers | null = null
  private outline: BoardOutline | null = null
  private palette: BoardPalette = boardPalette(null)
  private options: Board3DViewState | null = null
  private stats: Board3DStats = defaultBoard3DStats()

  constructor() {
    this.root.name = 'board-3d'
    this.components.name = 'components'
    this.bodyGroup.name = 'body'
    this.copperGroup.name = 'copper'
    this.padGroup.name = 'pads'
    this.pasteGroup.name = 'paste'
    this.silkGroup.name = 'silk'
    this.maskGroup.name = 'mask'
    this.drawingsGroup.name = 'drawings'
    this.barrelGroup.name = 'barrels'

    this.materials = {
      substrate: new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0.02 }),
      surface: new THREE.MeshStandardMaterial({ roughness: 0.58, metalness: 0.04 }),
      copper: new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0.3 }),
      pad: new THREE.MeshStandardMaterial({ roughness: 0.28, metalness: 0.8 }),
      paste: new THREE.MeshStandardMaterial({ roughness: 0.45, metalness: 0.5 }),
      silk: new THREE.MeshStandardMaterial({ roughness: 0.88, metalness: 0 }),
      backSilk: new THREE.MeshStandardMaterial({ roughness: 0.88, metalness: 0 }),
      // Translucent so the copper under it reads as tinted ridges, the way a
      // real mask over bare copper does. Physical rather than standard for the
      // specularIntensity knob: a large flat plane under the key light
      // otherwise wears its whole specular lobe as a pale sheen.
      mask: new THREE.MeshPhysicalMaterial({
        roughness: 0.42,
        metalness: 0,
        specularIntensity: 0.25,
        transparent: true,
        // Real mask is translucent up close, but the board must still read as
        // the finish named by its stackup. A low alpha over tan FR4 turns the
        // default green into brown in an ordinary whole-board view.
        opacity: 0.9
      }),
      barrel: new THREE.MeshStandardMaterial({
        roughness: 0.42,
        metalness: 0.7,
        side: THREE.DoubleSide
      }),
      // Annotations are not lit: a comment layer should read the same from any
      // angle, the way it does in the 2D view.
      drawings: new THREE.MeshBasicMaterial({ toneMapped: false })
    }

    this.root.add(
      this.bodyGroup,
      this.barrelGroup,
      this.copperGroup,
      this.padGroup,
      this.pasteGroup,
      this.silkGroup,
      this.maskGroup,
      this.drawingsGroup,
      this.components
    )
  }

  getStats(): Board3DStats {
    return { ...this.stats }
  }

  getPalette(): BoardPalette {
    return this.palette
  }

  get thickness(): number {
    return this.stats.thickness
  }

  /** Rebuild everything from a new board (or clear the scene for `null`). */
  setBoard(board: KicadBoard | null, options: Board3DViewState): void {
    drainSteps(this.buildSteps(board, options))
  }

  /**
   * The stepwise rebuild: the same work `setBoard` does, yielded in small
   * chunks so a driver can keep the thread responsive, report progress, and
   * render the board as it appears — substrate first, then the surfaces on
   * it. Geometry lands in the scene groups as each stage completes, and
   * materials/visibility are applied up front so partial results are already
   * correct on screen.
   */
  *buildSteps(
    board: KicadBoard | null,
    options: Board3DViewState,
    finishes?: PaletteOverrides
  ): Generator<Board3DBuildTick, void> {
    this.board = board
    this.options = options
    this.palette = boardPalette(board, finishes)
    this.stats = defaultBoard3DStats()

    this.clearGeometry()
    this.applyMaterials(options)
    this.applyVisibility(options)
    if (!board) return

    this.stats.thickness =
      board.thickness !== undefined ? nmToMm(board.thickness) : DEFAULT_BOARD_THICKNESS_MM
    this.outline = buildBoardOutline(board)
    this.stats.outlineFallback = this.outline.fallback
    this.stats.openOutlines = this.outline.openCount

    const layerSteps = buildBoardLayersSteps(board)
    let layerStep = layerSteps.next()
    while (!layerStep.done) {
      yield { stage: 'layers', fraction: layerStep.value }
      layerStep = layerSteps.next()
    }
    this.layers = layerStep.value

    // One openings computation feeds both the silk clip and the mask mesh —
    // and it is the same one the Gerber writer plots, so all three agree.
    const openings: MaskOpenings = {
      front: maskOpenings(board, 'F.Mask'),
      back: maskOpenings(board, 'B.Mask')
    }
    yield* this.buildBodySteps(options)
    yield* this.buildLayerMeshSteps(board, openings)
    yield* this.buildMaskMeshSteps(openings)
    this.buildBarrels()
    yield { stage: 'barrels', fraction: 1 }
    this.buildAxes(options)
  }

  /**
   * Apply a change of view options. Cheap unless the holes option moved, which
   * is the one switch that changes the substrate rather than what is drawn on
   * it.
   */
  setOptions(options: Board3DViewState): void {
    const previous = this.options
    this.options = options
    if (this.board && previous && previous.holes !== options.holes) this.buildBody(options)
    this.applyMaterials(options)
    this.applyVisibility(options)
    this.buildAxes(options)
  }

  /** World-space extent of the board itself, ignoring placed parts. */
  getBoardBounds(): THREE.Box3 {
    const bounds = new THREE.Box3()
    bounds.setFromObject(this.bodyGroup)
    if (bounds.isEmpty()) bounds.setFromObject(this.copperGroup)
    return bounds
  }

  dispose(): void {
    this.clearGeometry()
    for (const material of Object.values(this.materials)) material.dispose()
  }

  private buildBody(options: Board3DViewState): void {
    drainSteps(this.buildBodySteps(options))
  }

  private *buildBodySteps(options: Board3DViewState): Generator<Board3DBuildTick, void> {
    disposeChildren(this.bodyGroup)
    const outline = this.outline
    if (!outline || outline.regions.length === 0) return

    const thickness = this.stats.thickness
    const holes = options.holes ? (this.layers?.holes ?? []) : []
    this.stats.drillsOmitted = Math.max(0, holes.length - MAX_DRILL_CUTOUTS)
    const cutouts = holes.slice(0, MAX_DRILL_CUTOUTS)

    let done = 0
    for (const region of outline.regions) {
      const drills: Pt[][] = []
      for (const drill of cutouts) {
        // Only holes that are actually in this piece of board. Cutting against
        // a contour that lies outside the region wastes booleans, and two
        // things put one there: a panelized board with several disjoint
        // outlines, and a footprint parked off-board.
        if (!pointInPolygon(drill, region.outer)) continue
        const contour = drillContour(drill)
        if (contour) drills.push(contour)
      }

      const steps = buildBodyGeometrySteps(region, drills, thickness)
      let step = steps.next()
      while (!step.done) {
        yield { stage: 'body', fraction: done / outline.regions.length }
        step = steps.next()
      }
      done++
      const geometry = step.value
      if (!geometry) continue
      // Group 0 is the caps and group 1 the walls (see bodyGeometry.ts) —
      // exactly the split that matters here: the faces carry solder mask,
      // the routed edge is bare laminate.
      const mesh = new THREE.Mesh(geometry, [this.materials.surface, this.materials.substrate])
      mesh.name = 'board-body'
      this.bodyGroup.add(mesh)
      yield { stage: 'body', fraction: done / outline.regions.length }
    }
  }

  private buildBarrels(): void {
    disposeChildren(this.barrelGroup)
    const plated = (this.layers?.holes ?? []).filter(
      (hole) => hole.plated && Math.abs(hole.halfW - hole.halfH) < 1e-6
    )
    if (plated.length === 0) return

    const thickness = this.stats.thickness
    // Tall enough to reach the pad annulus on each face, so the plating reads as
    // one continuous barrel instead of a tube with a gap at either end.
    const height = thickness + 2 * PAD_H
    // One open cylinder instanced per hole — a board's drill count is exactly
    // the case instancing exists for.
    const geometry = new THREE.CylinderGeometry(1, 1, height, 16, 1, true)
    // Cylinders are Y-aligned; the board is Z-up.
    geometry.rotateX(Math.PI / 2)
    const mesh = new THREE.InstancedMesh(geometry, this.materials.barrel, plated.length)
    mesh.name = 'plated-barrels'
    const matrix = new THREE.Matrix4()
    plated.forEach((hole, index) => {
      // Just inside the bore. Exactly on it would put two coincident cylinders
      // at the same depth, and the wall would flicker between copper and
      // laminate as the camera moves.
      const radius = Math.max(hole.halfW - BARREL_INSET, hole.halfW * 0.9)
      matrix.makeScale(radius, radius, 1)
      matrix.setPosition(hole.x, hole.y, 0)
      mesh.setMatrixAt(index, matrix)
    })
    mesh.instanceMatrix.needsUpdate = true
    this.barrelGroup.add(mesh)
  }

  /**
   * The mask as geometry: board face minus openings minus bores, one plane
   * per face. When the boolean cannot run (engine missing, no trusted
   * outline) there is no film, and the face `applyMaterials` paints in the
   * mask color carries the finish alone.
   */
  private *buildMaskMeshSteps(openings: MaskOpenings): Generator<Board3DBuildTick, void> {
    disposeChildren(this.maskGroup)
    const outline = this.outline
    if (!outline || outline.fallback || outline.openCount > 0) return
    const holes = this.layers?.holes ?? []
    const thickness = this.stats.thickness

    const sides = ['front', 'back'] as const
    for (let i = 0; i < sides.length; i++) {
      const side = sides[i]
      const fraction = i / sides.length
      const regionSteps = buildMaskRegionsSteps(outline.regions, openings[side], holes)
      let regionStep = regionSteps.next()
      while (!regionStep.done) {
        yield { stage: 'mask', fraction }
        regionStep = regionSteps.next()
      }
      const regions = regionStep.value
      if (!regions) {
        // All or nothing: one green face and one bare face would read as a
        // defect, not a fallback.
        disposeChildren(this.maskGroup)
        return
      }
      const builder = new FlatMeshBuilder()
      for (const region of regions) builder.addPolygon(region.outer, region.holes)
      const z = (thickness / 2 + MASK_H) * (side === 'front' ? 1 : -1)
      const buildSteps = builder.buildSteps(z, side === 'front' ? 1 : -1)
      let buildStep = buildSteps.next()
      while (!buildStep.done) {
        yield { stage: 'mask', fraction: fraction + buildStep.value / sides.length }
        buildStep = buildSteps.next()
      }
      const geometry = buildStep.value
      if (!geometry) continue
      const mesh = new THREE.Mesh(geometry, this.materials.mask)
      mesh.name = `mask:${side}`
      this.maskGroup.add(mesh)
    }
  }

  private *buildLayerMeshSteps(
    board: KicadBoard,
    openings: MaskOpenings
  ): Generator<Board3DBuildTick, void> {
    const layers = this.layers
    if (!layers) return
    const thickness = this.stats.thickness
    const copperOrder = board.layers.filter((l) => l.name.endsWith('.Cu')).map((l) => l.name)
    const clips = buildLayerClips(layers.holes, this.outline, openings)

    interface Job {
      group: THREE.Group
      builder: FlatMeshBuilder
      material: THREE.Material
      z: number
      name: string
      clip?: readonly ShapeClip[]
    }
    const jobs: Job[] = []
    // Outer faces first: the board reads as itself as soon as F/B land, and
    // the inner layers (hidden inside the substrate anyway) fill in after.
    const outerFirst = (layer: string): number =>
      layer.startsWith('F.') ? 0 : layer.startsWith('B.') ? 1 : 2
    const byOuter = (a: [string, FlatMeshBuilder], b: [string, FlatMeshBuilder]): number =>
      outerFirst(a[0]) - outerFirst(b[0])
    for (const [layer, builder] of [...layers.pads].sort(byOuter)) {
      jobs.push({
        group: this.padGroup,
        builder,
        material: this.materials.pad,
        z: copperZ(layer, copperOrder, thickness, PAD_H),
        name: `pads:${layer}`,
        clip: clips.drilled
      })
    }
    for (const [layer, builder] of [...layers.copper].sort(byOuter)) {
      jobs.push({
        group: this.copperGroup,
        builder,
        material: this.materials.copper,
        z: copperZ(layer, copperOrder, thickness, COPPER_H),
        name: `copper:${layer}`,
        clip: clips.drilled
      })
    }
    for (const [layer, builder] of layers.silk) {
      jobs.push({
        group: this.silkGroup,
        builder,
        material: layer.startsWith('B.') ? this.materials.backSilk : this.materials.silk,
        z: surfaceZ(layer, thickness, SILK_H),
        name: `silk:${layer}`,
        clip: clips.silkFor(layer)
      })
    }
    for (const [layer, builder] of layers.paste) {
      jobs.push({
        group: this.pasteGroup,
        builder,
        material: this.materials.paste,
        z: surfaceZ(layer, thickness, PASTE_H),
        name: `paste:${layer}`,
        clip: clips.drilled
      })
    }
    jobs.push({
      group: this.drawingsGroup,
      builder: layers.drawings,
      material: this.materials.drawings,
      z: thickness / 2 + DRAWINGS_H,
      name: 'drawings'
    })

    const totalShapes = jobs.reduce((n, job) => n + job.builder.shapeCount, 0)
    let doneShapes = 0
    for (const job of jobs) {
      const steps = job.builder.buildSteps(job.z, job.z >= 0 ? 1 : -1, job.clip)
      let step = steps.next()
      while (!step.done) {
        yield {
          stage: 'surfaces',
          fraction:
            totalShapes === 0 ? 1 : (doneShapes + step.value * job.builder.shapeCount) / totalShapes
        }
        step = steps.next()
      }
      doneShapes += job.builder.shapeCount
      const geometry = step.value
      if (geometry) {
        const mesh = new THREE.Mesh(geometry, job.material)
        mesh.name = job.name
        job.group.add(mesh)
      }
      yield { stage: 'surfaces', fraction: totalShapes === 0 ? 1 : doneShapes / totalShapes }
    }
  }

  private buildAxes(options: Board3DViewState): void {
    if (this.axes) {
      this.root.remove(this.axes)
      this.axes.dispose()
      this.axes = null
    }
    if (!options.axes) return
    const bounds = this.getBoardBounds()
    if (bounds.isEmpty()) return
    const size = bounds.getSize(new THREE.Vector3())
    // Anchored at the board's near corner rather than the page origin, which on
    // a KiCad sheet can be far enough away to be off screen.
    const axes = new THREE.AxesHelper(Math.max(size.x, size.y) * 0.2)
    axes.position.set(bounds.min.x, bounds.min.y, bounds.min.z)
    this.axes = axes
    this.root.add(axes)
  }

  private applyMaterials(options: Board3DViewState): void {
    const palette = this.palette
    this.materials.substrate.color.set(palette.substrate)
    // Under mask, the face and the copper are painted as the mask shows them,
    // mesh or not: cured mask hides the laminate, so whatever the film lets
    // through must already be mask-colored. Tan FR4 under it bleeds through the
    // film's translucency and turns black mask bronze and green mask olive.
    this.materials.surface.color.set(options.solderMask ? palette.mask : palette.substrate)
    // The mask plane is a lit surface alpha-blended over surfaces that are
    // already lit, so at face value the two contributions sum and the lit
    // side tone-maps toward pale. Darkening the film's own color makes the
    // blended result land near the palette color instead of washing out.
    this.materials.mask.color.set(palette.mask).multiplyScalar(0.88)
    this.materials.copper.color.set(options.solderMask ? palette.maskedCopper : palette.bareCopper)
    this.materials.pad.color.set(palette.padFinish)
    this.materials.paste.color.set(palette.paste)
    this.materials.silk.color.set(palette.silk)
    this.materials.backSilk.color.set(palette.backSilk)
    this.materials.barrel.color.set(palette.holeWall)
    this.materials.drawings.color.set(palette.drawings)
  }

  private applyVisibility(options: Board3DViewState): void {
    this.bodyGroup.visible = options.boardBody
    this.copperGroup.visible = options.copper
    this.padGroup.visible = options.copper
    this.barrelGroup.visible = options.copper && options.holes
    this.pasteGroup.visible = options.solderPaste
    this.silkGroup.visible = options.silkscreen
    this.maskGroup.visible = options.solderMask
    this.drawingsGroup.visible = options.drawings
    this.components.visible = options.models
  }

  private clearGeometry(): void {
    disposeChildren(this.bodyGroup)
    disposeChildren(this.copperGroup)
    disposeChildren(this.padGroup)
    disposeChildren(this.pasteGroup)
    disposeChildren(this.silkGroup)
    disposeChildren(this.maskGroup)
    disposeChildren(this.drawingsGroup)
    disposeChildren(this.barrelGroup)
    if (this.axes) {
      this.root.remove(this.axes)
      this.axes.dispose()
      this.axes = null
    }
    this.layers = null
    this.outline = null
  }
}

/** Height of a copper layer: outer layers ride on the face, inner ones sit
 *  inside the laminate at their stackup position. */
function copperZ(
  layer: string,
  order: readonly string[],
  thickness: number,
  above: number
): number {
  const surface = thickness / 2
  if (layer === 'F.Cu') return surface + above
  if (layer === 'B.Cu') return -(surface + above)
  const index = order.indexOf(layer)
  if (index <= 0 || order.length < 2) return surface + above
  return surface - (index / (order.length - 1)) * thickness
}

/** Height of a non-copper layer, from the `F.`/`B.` prefix on its name. */
function surfaceZ(layer: string, thickness: number, above: number): number {
  const surface = thickness / 2 + above
  return layer.startsWith('B.') ? -surface : surface
}

function disposeChildren(group: THREE.Group): void {
  for (const child of [...group.children]) {
    group.remove(child)
    const mesh = child as Partial<THREE.Mesh> & THREE.Object3D
    mesh.geometry?.dispose()
  }
}
