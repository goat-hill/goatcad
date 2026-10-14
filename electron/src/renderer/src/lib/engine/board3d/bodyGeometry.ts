/**
 * The board substrate as geometry: each outline region extruded to the board
 * thickness with every drill bored through it.
 *
 * Handing the whole cap — outline plus thousands of drill contours — to
 * earcut as a single polygon is quadratic-ish in hole count and slow past a
 * few thousand drills. Caps are triangulated from `subtractInPieces`
 * partitions instead, so no single earcut sees more than a handful of bores,
 * and the walls are plain quads along the *original* contours — the
 * partition's internal split edges never grow a wall.
 *
 * The geometry has two groups: group 0 is the caps (the board faces), group 1
 * the walls (outer edge and bore walls — bare laminate).
 */

import * as THREE from 'three'
import type { ClipRegion } from '../../geometry/clip'
import { drainSteps, subtractInPiecesSteps } from '../../geometry/regionClips'
import type { DrillHole } from './boardLayers'
import type { OutlineRegion } from './boardOutline'
import { placedRoundRect, signedArea, triangulateRegions, type Pt } from './flatMesh'

/** A drill as the contour it cuts, or null when degenerate. */
export function drillContour(hole: DrillHole): Pt[] | null {
  const outline = placedRoundRect(hole.x, hole.y, hole.halfW, hole.halfH, hole.cornerR, hole.angle)
  return outline.length >= 3 ? outline : null
}

/**
 * One outline region extruded to `thickness`, centered on Z = 0, with the
 * given drill contours bored through. Returns null when the region has no
 * area at all.
 */
export function buildBodyGeometry(
  region: OutlineRegion,
  drills: readonly Pt[][],
  thickness: number
): THREE.BufferGeometry | null {
  return drainSteps(buildBodyGeometrySteps(region, drills, thickness))
}

/** Cap pieces triangulated per progress yield. */
const CAP_CHUNK = 32

/** Stepwise `buildBodyGeometry`: yields between booleans and cap chunks. */
export function* buildBodyGeometrySteps(
  region: OutlineRegion,
  drills: readonly Pt[][],
  thickness: number
): Generator<void, THREE.BufferGeometry | null> {
  const top = thickness / 2
  const cuts: ClipRegion[] = drills.map((outer) => ({ outer: [...outer], holes: [] }))
  const capPieces: ClipRegion[] = yield* subtractInPiecesSteps(
    { outer: [...region.outer], holes: region.holes.map((h) => [...h]) },
    cuts
  )
  const cap: number[] = []
  for (let i = 0; i < capPieces.length; i++) {
    const tri = triangulateRegions([capPieces[i]])
    for (const v of tri) cap.push(v)
    if ((i + 1) % CAP_CHUNK === 0) yield
  }
  const capFaces = cap.length / 6
  if (capFaces === 0) return null

  // Walls come from the original rings, wound so material sits on the left of
  // travel: outer CCW, every cutout (outline holes and bores) CW. The wall
  // normal is then uniformly the right-hand side of the edge direction.
  const rings: Pt[][] = [
    ccw(region.outer, true),
    ...region.holes.map((h) => ccw(h, false)),
    ...drills.map((d) => ccw(d, false))
  ]
  let wallEdges = 0
  for (const ring of rings) wallEdges += ring.length

  const capVerts = capFaces * 3
  const totalVerts = capVerts * 2 + wallEdges * 6
  const positions = new Float32Array(totalVerts * 3)
  const normals = new Float32Array(totalVerts * 3)

  // Top cap: the CCW 2D triangles face +Z as-is. Bottom cap: reversed, -Z.
  for (let f = 0; f < capFaces; f++) {
    for (let v = 0; v < 3; v++) {
      const from = f * 6 + v * 2
      const toTop = (f * 3 + v) * 3
      positions[toTop] = cap[from]
      positions[toTop + 1] = cap[from + 1]
      positions[toTop + 2] = top
      normals[toTop + 2] = 1
      const source = v === 0 ? 0 : 3 - v
      const fromB = f * 6 + source * 2
      const toBottom = (capVerts + f * 3 + v) * 3
      positions[toBottom] = cap[fromB]
      positions[toBottom + 1] = cap[fromB + 1]
      positions[toBottom + 2] = -top
      normals[toBottom + 2] = -1
    }
  }

  let at = capVerts * 2 * 3
  const emit = (x: number, y: number, z: number, nx: number, ny: number): void => {
    positions[at] = x
    positions[at + 1] = y
    positions[at + 2] = z
    normals[at] = nx
    normals[at + 1] = ny
    at += 3
  }
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]
      const b = ring[(i + 1) % ring.length]
      const dx = b.x - a.x
      const dy = b.y - a.y
      const len = Math.hypot(dx, dy)
      if (len < 1e-9) {
        // Zero-length edges keep their reserved slots rather than forcing a
        // reindex, but collapsed onto the point itself: left at the buffer's
        // zeros they would be invisible triangles sitting at the world origin,
        // and every bounding box over this geometry — the extent gauge, the
        // dimension readout, the 3D fit — would stretch to include it.
        for (let v = 0; v < 6; v++) emit(a.x, a.y, top, 0, 0)
        continue
      }
      const nx = dy / len
      const ny = -dx / len
      emit(a.x, a.y, top, nx, ny)
      emit(a.x, a.y, -top, nx, ny)
      emit(b.x, b.y, -top, nx, ny)
      emit(a.x, a.y, top, nx, ny)
      emit(b.x, b.y, -top, nx, ny)
      emit(b.x, b.y, top, nx, ny)
    }
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
  geometry.addGroup(0, capVerts * 2, 0)
  geometry.addGroup(capVerts * 2, wallEdges * 6, 1)
  return geometry
}

/** The ring wound CCW when `wantCCW`, else CW. */
function ccw(ring: readonly Pt[], wantCCW: boolean): Pt[] {
  const isCCW = signedArea(ring) > 0
  return isCCW === wantCCW ? [...ring] : [...ring].reverse()
}
