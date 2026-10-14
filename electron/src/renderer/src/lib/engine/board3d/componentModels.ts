// Parts follow KiCad's source, named below: Copyright The KiCad Developers, GPL-3.0-or-later.
/**
 * Placed components: each footprint's linked `(model …)`, resolved, loaded and
 * put where the part sits on the board.
 *
 * Two things make this more than "load a file per footprint". First, models
 * arrive from disk over IPC and a dense board links hundreds of them, so
 * loading is pooled, deduplicated by resolved path (fifty identical 0402s are
 * one parse and fifty clones), cancellable, and yields between placements so
 * the viewport keeps drawing while parts appear. Second, the placement math is
 * KiCad's, not ours: the model frame is the 3D world frame, `(offset …)` and
 * `(rotate …)` are expressed in the board's y-down frame and so invert, and a
 * back-side part is turned over — a half-turn about X — rather than mirrored,
 * because a real part on the underside is the same part, not its reflection.
 */

import * as THREE from 'three'
import type { KicadBoard, KicadBoardFootprint } from '../../kicad/board'
import { nmToMm } from '../../kicad/coordinates'
import { DEFAULT_BOARD_THICKNESS_MM } from './BoardScene3D'
import { buildStandInBody } from './placementBodies'
import { BoardModelAssetCache } from './modelAssetCache'

/** How a footprint declares what kind of part it is (`(attr …)`). */
export type ComponentClass = 'tht' | 'smd' | 'unspecified'

/** Which classes of part the view is currently showing. */
export interface ComponentFilter {
  tht: boolean
  smd: boolean
  unspecified: boolean
  /** Parts marked "do not populate" — off by default; they are not fitted. */
  dnp: boolean
  /**
   * Footprints the pick-and-place file skips (`exclude_from_pos_files`) — off
   * by default, because the attribute's whole meaning is that no part is placed
   * there. Mounting holes, fiducials, logos and board outlines carry it; the
   * jetson demo board has 115 of them, and every one used to arrive as a body.
   */
  notInPosFiles: boolean
}

export interface ComponentModelProgress {
  /** Footprints with a linked model that passed the filter. */
  total: number
  /** Models placed in the scene so far. */
  placed: number
  /** Footprints whose model could not be found or read. */
  missing: number
  /**
   * The distinct links that failed, so the viewport can say *which* model is
   * missing rather than only how many. A count alone is not actionable: the
   * causes look identical and are not (an uninstalled PCM package, a
   * user-defined `${VAR}` we cannot expand, a path from someone else's machine).
   * Capped — the list is a diagnosis, not a log.
   */
  missingLinks: string[]
}

/** Distinct unresolved links kept for reporting. */
const MAX_REPORTED_MISSING = 12

export interface ComponentLoadOptions {
  /**
   * Draw a footprint-shaped body for every part that ends up without a mesh —
   * no link, or a link that would not resolve. See `placementBodies.ts`.
   */
  standIns?: boolean
}

export function componentClass(bfp: KicadBoardFootprint): ComponentClass {
  const attributes = bfp.footprint.attributes
  if (attributes.includes('smd')) return 'smd'
  if (attributes.includes('through_hole')) return 'tht'
  return 'unspecified'
}

export const isDoNotPopulate = (bfp: KicadBoardFootprint): boolean =>
  bfp.footprint.attributes.includes('dnp')

/**
 * Nothing is placed here by the assembler. KiCad's own name for the flag, and
 * the most reliable "this is not a part" signal the format has — better than
 * guessing from pads or reference designators, because it is what the fab
 * actually reads.
 */
export const isNotInPosFiles = (bfp: KicadBoardFootprint): boolean =>
  bfp.footprint.attributes.includes('exclude_from_pos_files')

/**
 * KiCad's rule, in KiCad's order (`board_adapter.cpp`): the two exclusions are
 * gates applied before the class, not classes of their own — a DNP resistor is
 * hidden by the DNP switch even though SMD parts are shown.
 */
export function passesComponentFilter(bfp: KicadBoardFootprint, filter: ComponentFilter): boolean {
  if (isNotInPosFiles(bfp) && !filter.notInPosFiles) return false
  if (isDoNotPopulate(bfp) && !filter.dnp) return false
  switch (componentClass(bfp)) {
    case 'smd':
      return filter.smd
    case 'tht':
      return filter.tht
    default:
      return filter.unspecified
  }
}

/**
 * Position a loaded model on the board.
 *
 * The nesting is the transform order, outermost first: board placement, the
 * back-side turn-over, then the footprint's own `(model …)` transform. Euler
 * order `ZYX` is what makes the last one apply Z, then Y, then X — KiCad's
 * order, and the reason a connector with `(rotate (xyz 0 0 -90))` faces the
 * same way here as it does there.
 */
export function placeComponentModel(
  content: THREE.Object3D,
  bfp: KicadBoardFootprint,
  boardThickness: number
): THREE.Group | null {
  const model = bfp.footprint.model
  if (!model) return null

  const flipped = bfp.layer === 'B.Cu'
  const surface = boardThickness / 2

  const placement = new THREE.Group()
  placement.name = `component:${bfp.reference ?? bfp.libId}`
  placement.position.set(
    nmToMm(bfp.position.x),
    -nmToMm(bfp.position.y),
    flipped ? -surface : surface
  )
  placement.rotation.z = THREE.MathUtils.degToRad(bfp.position.angle ?? 0)

  const side = new THREE.Group()
  if (flipped) side.rotation.x = Math.PI
  placement.add(side)

  const offsetNm = model.offset
  const offset = offsetNm
    ? { x: nmToMm(offsetNm.x), y: nmToMm(offsetNm.y), z: nmToMm(offsetNm.z) }
    : { x: 0, y: 0, z: 0 }
  const rotate = model.rotate ?? { x: 0, y: 0, z: 0 }
  const scale = model.scale ?? { x: 1, y: 1, z: 1 }

  const local = new THREE.Group()
  local.position.set(offset.x, -offset.y, offset.z)
  local.rotation.set(
    THREE.MathUtils.degToRad(-rotate.x),
    THREE.MathUtils.degToRad(-rotate.y),
    THREE.MathUtils.degToRad(-rotate.z),
    'ZYX'
  )
  local.scale.set(scale.x || 1, scale.y || 1, scale.z || 1)
  local.add(content)
  side.add(local)

  return placement
}

/** Models parsed at once. STEP tessellation is a main-process worker away, but
 *  VRML parses here, so the pool is small enough to stay off the frame budget. */
const LOAD_CONCURRENCY = 3

const bridge = (): typeof window.api | null =>
  typeof window !== 'undefined' && window.api ? window.api : null

/**
 * Loads and places the models for one board into a host group.
 *
 * A loader may share a board-scoped cache with another presentation. Clones
 * share template geometry, so Layout assembly and full 3D can reuse one decode
 * and one renderer upload without making the cache process-global.
 */
export class ComponentModelLoader {
  /** Bumped by every `load`/`cancel`; a stale run drops its results. */
  private run = 0
  private standIn: THREE.MeshStandardMaterial | null = null
  private readonly cache: BoardModelAssetCache
  private readonly ownsCache: boolean

  /**
   * Parts are parented by the side of the board they sit on, not all together:
   * a top-down assembly view has to be able to treat the far side differently
   * from the near one, and after placement a part's side is no longer legible
   * from its transform alone.
   */
  private readonly front = new THREE.Group()
  private readonly back = new THREE.Group()

  constructor(
    private readonly host: THREE.Group,
    cache?: BoardModelAssetCache
  ) {
    this.cache = cache ?? new BoardModelAssetCache()
    this.ownsCache = !cache
    this.front.name = 'components:front'
    this.back.name = 'components:back'
    this.host.add(this.front, this.back)
  }

  /** The two side groups, for a caller that fades or hides one of them. */
  sideGroups(): { front: THREE.Group; back: THREE.Group } {
    return { front: this.front, back: this.back }
  }

  private hostFor(bfp: KicadBoardFootprint): THREE.Group {
    return bfp.layer === 'B.Cu' ? this.back : this.front
  }

  cancel(): void {
    this.run++
  }

  /**
   * Remove placed models without touching the cached templates they clone.
   * Stand-in boxes are the exception: each owns its geometry (nothing else
   * references it), and load() rebuilds them from scratch, so an undisposed
   * box is a GPU buffer leaked once per edit.
   */
  clear(): void {
    this.cancel()
    for (const side of [this.front, this.back]) {
      for (const child of side.children) {
        if (!child.name.startsWith('standin:')) continue
        child.traverse((object) => {
          const mesh = object as THREE.Mesh
          if (mesh.isMesh) mesh.geometry.dispose()
        })
      }
      side.clear()
    }
  }

  async load(
    board: KicadBoard,
    boardPath: string | null,
    projectDir: string | null,
    filter: ComponentFilter,
    onProgress: (progress: ComponentModelProgress) => void,
    options: ComponentLoadOptions = {}
  ): Promise<void> {
    this.clear()
    const run = this.run
    const api = bridge()

    const placeable = board.footprints.filter((bfp) => passesComponentFilter(bfp, filter))
    const queue = placeable.filter((bfp) => bfp.footprint.model?.path.trim())
    const missingLinks = new Set<string>()
    const progress: ComponentModelProgress = {
      total: queue.length,
      placed: 0,
      missing: 0,
      missingLinks: []
    }
    const report = (): void => onProgress({ ...progress, missingLinks: [...missingLinks] })
    report()

    const thickness =
      board.thickness !== undefined ? nmToMm(board.thickness) : DEFAULT_BOARD_THICKNESS_MM

    const standIn = (bfp: KicadBoardFootprint): void => {
      if (!options.standIns) return
      // A stand-in is a GUESS that a part is there, made because its library is
      // not installed. For a footprint the assembler skips, or one marked do-
      // not-populate, that guess is known to be wrong — a mounting hole is not
      // an unresolved component. Unconditional, and separate from the filters
      // above: those decide whether to SHOW what the board claims, this decides
      // whether we are entitled to invent something it never claimed.
      if (isNotInPosFiles(bfp) || isDoNotPopulate(bfp)) return
      const body = buildStandInBody(bfp, thickness, componentClass(bfp), this.standInMaterial())
      if (body) this.hostFor(bfp).add(body)
    }

    // A part that never claimed a model is not missing one — it gets its body
    // up front, without waiting on the loaders.
    for (const bfp of placeable) {
      if (!bfp.footprint.model?.path.trim()) standIn(bfp)
    }
    if (!api || queue.length === 0) return

    let next = 0

    const worker = async (): Promise<void> => {
      for (;;) {
        if (run !== this.run) return
        const index = next++
        if (index >= queue.length) return
        const bfp = queue[index]
        const template = await this.cache.template(
          bfp.footprint.model?.path.trim() ?? '',
          boardPath,
          projectDir
        )
        if (run !== this.run) return
        if (!template) {
          progress.missing++
          const link = bfp.footprint.model?.path.trim()
          if (link && missingLinks.size < MAX_REPORTED_MISSING) missingLinks.add(link)
          standIn(bfp)
        } else {
          const placed = placeComponentModel(template.clone(), bfp, thickness)
          if (placed) {
            this.hostFor(bfp).add(placed)
            progress.placed++
          }
        }
        report()
        // Hand the frame back: a board of hundreds of parts must not lock the
        // viewport while they stream in (RULES.md §8).
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(LOAD_CONCURRENCY, queue.length) }, () => worker())
    )
  }

  /**
   * One material behind every stand-in, built on first use. Its cool,
   * translucent gray is deliberately unlike a real plastic body: a courtyard
   * box is a clearance envelope, and must never imply that we know the part's
   * actual shape. It remains solid enough to show sides and cast a height cue.
   */
  private standInMaterial(): THREE.MeshStandardMaterial {
    if (!this.standIn) {
      this.standIn = new THREE.MeshStandardMaterial({
        color: 0x78948e,
        roughness: 0.8,
        metalness: 0.05,
        transparent: true,
        opacity: 0.68,
        depthWrite: true
      })
    }
    return this.standIn
  }

  /** Release the cached templates. Clones in the scene share these buffers, so
   *  this runs only when the whole scene is going away. */
  dispose(): void {
    this.clear()
    this.standIn?.dispose()
    this.standIn = null
    if (this.ownsCache) this.cache.dispose()
  }
}
