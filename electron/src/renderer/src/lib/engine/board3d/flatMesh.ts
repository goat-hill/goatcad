/**
 * Accumulates the flat (single-Z) geometry of one board layer into a single
 * `BufferGeometry`.
 *
 * Every copper, silkscreen, paste and drawing layer in the 3D board view is a
 * plane of filled 2D shapes at a fixed height, so each one is a single mesh —
 * one draw call for every track on `F.Cu` rather than one per track. The
 * builder takes the same primitive vocabulary the 2D scene draws with (capsule,
 * round-rect, ring, three-point arc, polygon) and emits triangles for it.
 *
 * Primitives are kept as filled *regions* (an outer ring plus holes) and only
 * triangulated at `build()`. That deferral is what makes clipping possible:
 * `build()` can hand each region to a `ShapeClip` — subtract the drill bores,
 * intersect with the board outline — and triangulate whatever survives.
 * Regions that no clip touches take a fast path, so a layer with no clipping
 * costs what the eager version did.
 *
 * Winding is normalized to CCW as triangles are emitted, so `build()` can hand
 * the whole mesh one facing and use single-sided materials: a layer under the
 * board is built facing `-1`, which reverses every triangle and points the
 * normal at the viewer looking up from below.
 */

import * as THREE from 'three'
import type { ClipRegion } from '../../geometry/clip'
import { applyShapeClipsSteps, drainSteps, type ShapeClip } from '../../geometry/regionClips'
import { arcPolyline, type Point2 } from '../arcGeometry'

export type Pt = Point2
export type { ShapeClip }

/** Segments in a tessellated full circle — pad and via curvature at board scale. */
const CIRCLE_SEGMENTS = 32
/** Coarser: a stroke cap is at most half a circle, at track widths. */
const CAP_SEGMENTS = 12
/** Segments per 90° of a round-rect corner. */
const CORNER_SEGMENTS = 5

/** A region plus how it may be triangulated: convex regions fan from a vertex. */
interface Shape extends ClipRegion {
  convex: boolean
}

export class FlatMeshBuilder {
  private readonly shapes: Shape[] = []
  /** Unclipped triangulation, filled lazily — x,y pairs, three per face. */
  private cache: number[] | null = null

  get isEmpty(): boolean {
    return this.triangleCount === 0
  }

  /** Accumulated region count — the unit the stepwise build reports progress in. */
  get shapeCount(): number {
    return this.shapes.length
  }

  get triangleCount(): number {
    return this.triangulated().length / 6
  }

  addTriangle(a: Pt, b: Pt, c: Pt): void {
    const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
    if (!Number.isFinite(cross) || cross === 0) return
    this.push({ outer: [a, b, c], holes: [], convex: true })
  }

  addQuad(a: Pt, b: Pt, c: Pt, d: Pt): void {
    this.addTriangle(a, b, c)
    this.addTriangle(a, c, d)
  }

  /** A simple or holed polygon, triangulated with three's earcut. */
  addPolygon(outer: readonly Pt[], holes: readonly (readonly Pt[])[] = []): void {
    if (outer.length < 3) return
    this.push({
      outer: [...outer],
      holes: holes.filter((h) => h.length >= 3).map((h) => [...h]),
      convex: false
    })
  }

  addCircle(cx: number, cy: number, r: number, segments = CIRCLE_SEGMENTS): void {
    if (!(r > 0)) return
    this.push({ outer: circleRing(cx, cy, r, segments), holes: [], convex: true })
  }

  /** An annulus of stroke width `2 * halfStroke` centered on radius `r`. */
  addRing(cx: number, cy: number, r: number, halfStroke: number, segments = CIRCLE_SEGMENTS): void {
    const outer = r + halfStroke
    const inner = Math.max(0, r - halfStroke)
    if (!(outer > 0)) return
    if (inner === 0) {
      this.addCircle(cx, cy, outer, segments)
      return
    }
    this.push({
      outer: circleRing(cx, cy, outer, segments),
      holes: [circleRing(cx, cy, inner, segments)],
      convex: false
    })
  }

  /** A stroked segment: a capsule — the rectangular body with round end caps. */
  addSegment(x0: number, y0: number, x1: number, y1: number, halfWidth: number): void {
    if (!(halfWidth > 0)) return
    const dx = x1 - x0
    const dy = y1 - y0
    const length = Math.hypot(dx, dy)
    if (length < 1e-9) {
      this.addCircle(x0, y0, halfWidth, CAP_SEGMENTS)
      return
    }
    const angle = Math.atan2(dy, dx)
    const outline: Pt[] = []
    // Half circle around each end; the straight sides close the loop, CCW.
    for (let i = 0; i <= CAP_SEGMENTS; i++) {
      const theta = angle - Math.PI / 2 + (i / CAP_SEGMENTS) * Math.PI
      outline.push({ x: x1 + halfWidth * Math.cos(theta), y: y1 + halfWidth * Math.sin(theta) })
    }
    for (let i = 0; i <= CAP_SEGMENTS; i++) {
      const theta = angle + Math.PI / 2 + (i / CAP_SEGMENTS) * Math.PI
      outline.push({ x: x0 + halfWidth * Math.cos(theta), y: y0 + halfWidth * Math.sin(theta) })
    }
    this.push({ outer: outline, holes: [], convex: true })
  }

  /** A stroked polyline — each leg a capsule, so joints stay filled. */
  addPolyline(points: readonly Pt[], halfWidth: number, close = false): void {
    for (let i = 0; i + 1 < points.length; i++) {
      this.addSegment(points[i].x, points[i].y, points[i + 1].x, points[i + 1].y, halfWidth)
    }
    if (close && points.length > 2) {
      const a = points[points.length - 1]
      const b = points[0]
      this.addSegment(a.x, a.y, b.x, b.y, halfWidth)
    }
  }

  /** A stroked KiCad arc, given as start / mid / end. */
  addArc(start: Pt, mid: Pt, end: Pt, halfWidth: number): void {
    this.addPolyline(arcPolyline(start, mid, end, CIRCLE_SEGMENTS * 2), halfWidth)
  }

  /**
   * The one shape every pad is: a rectangle with corner radius `cornerR`,
   * rotated by `rotation` radians about its center. Rect, roundrect, oval and
   * circle pads are all this with different radii — exactly how the 2D scene
   * resolves them, so the two views agree on pad outlines.
   */
  addRoundRect(
    cx: number,
    cy: number,
    halfW: number,
    halfH: number,
    cornerR: number,
    rotation: number,
    /** Inner contour to leave open — a drilled pad is an annulus, not a disc. */
    hole?: readonly Pt[]
  ): void {
    const outline = placedRoundRect(cx, cy, halfW, halfH, cornerR, rotation)
    if (outline.length < 3) return
    this.push({
      outer: outline,
      holes: hole && hole.length >= 3 ? [[...hole]] : [],
      convex: false
    })
  }

  /**
   * The accumulated regions as a mesh at height `z`.
   *
   * `facing` is which way the layer is looked at: `1` for anything on top of
   * the board, `-1` for the back side, which reverses the winding so the
   * single-sided material still faces a viewer underneath.
   *
   * `clips` are applied to every region in order, each stage consuming the
   * previous stage's output.
   */
  build(z: number, facing: 1 | -1 = 1, clips?: readonly ShapeClip[]): THREE.BufferGeometry | null {
    return drainSteps(this.buildSteps(z, facing, clips))
  }

  /**
   * Stepwise `build`: yields its progress through the shapes (0–1) between
   * chunks, so a cooperative driver can keep the thread responsive through a
   * layer with tens of thousands of shapes. The clip stack's own yields pass
   * through, which is what bounds the worst single step — a plane-sized zone
   * being cut by thousands of drills.
   */
  *buildSteps(
    z: number,
    facing: 1 | -1 = 1,
    clips?: readonly ShapeClip[]
  ): Generator<number, THREE.BufferGeometry | null> {
    const verts = yield* this.triangulatedSteps(clips)
    const triangles = verts.length / 6
    if (triangles === 0) return null
    const positions = new Float32Array(triangles * 9)
    const normals = new Float32Array(triangles * 9)
    for (let t = 0; t < triangles; t++) {
      for (let v = 0; v < 3; v++) {
        // A reversed layer emits v0, v2, v1 so the front face points at -Z.
        const source = facing === 1 ? v : v === 0 ? 0 : 3 - v
        const from = t * 6 + source * 2
        const to = t * 9 + v * 3
        positions[to] = verts[from]
        positions[to + 1] = verts[from + 1]
        positions[to + 2] = z
        normals[to + 2] = facing
      }
    }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
    return geometry
  }

  private push(shape: Shape): void {
    this.shapes.push(shape)
    this.cache = null
  }

  private triangulated(clips?: readonly ShapeClip[]): number[] {
    return drainSteps(this.triangulatedSteps(clips))
  }

  /** Shapes per progress yield: unclipped triangulation is microseconds each. */
  private static readonly PLAIN_CHUNK = 4000
  /** Clipped shapes carry a grid query each, so chunks are smaller. */
  private static readonly CLIPPED_CHUNK = 500

  private *triangulatedSteps(clips?: readonly ShapeClip[]): Generator<number, number[]> {
    if (!clips || clips.length === 0) {
      if (!this.cache) {
        const cache: number[] = []
        let done = 0
        for (const shape of this.shapes) {
          triangulateInto(cache, shape)
          if (++done % FlatMeshBuilder.PLAIN_CHUNK === 0) yield done / this.shapes.length
        }
        this.cache = cache
      }
      return this.cache
    }
    const verts: number[] = []
    let done = 0
    for (const shape of this.shapes) {
      // Forward the clip stack's internal yields as the current fraction.
      const clipping = applyShapeClipsSteps(shape, clips)
      let step = clipping.next()
      while (!step.done) {
        yield done / this.shapes.length
        step = clipping.next()
      }
      const replaced = step.value
      if (replaced === null) {
        triangulateInto(verts, shape)
      } else {
        // A clipped region is no longer known-convex, whatever the source was.
        for (const region of replaced) {
          triangulateInto(verts, { outer: region.outer, holes: region.holes, convex: false })
        }
      }
      if (++done % FlatMeshBuilder.CLIPPED_CHUNK === 0) yield done / this.shapes.length
    }
    return verts
  }
}

/**
 * Triangulate filled regions to raw 2D triangles — x,y pairs, three per face,
 * each face CCW. The substrate builder uses this for the board's caps, where
 * the triangles are combined with extruded walls into one geometry.
 */
export function triangulateRegions(regions: readonly ClipRegion[]): number[] {
  const verts: number[] = []
  for (const region of regions) {
    triangulateInto(verts, { outer: region.outer, holes: region.holes, convex: false })
  }
  return verts
}

/** Triangulate one region into `verts`, normalizing each face to CCW. */
function triangulateInto(verts: number[], shape: Shape): void {
  const outer = shape.outer
  if (outer.length < 3) return
  if (shape.convex && shape.holes.length === 0) {
    for (let i = 1; i + 1 < outer.length; i++) {
      emitTriangle(verts, outer[0], outer[i], outer[i + 1])
    }
    return
  }
  const contour = outer.map((p) => new THREE.Vector2(p.x, p.y))
  const holeContours = shape.holes.map((h) => h.map((p) => new THREE.Vector2(p.x, p.y)))
  // triangulateShape drops duplicate end points from its inputs in place, so
  // the combined vertex list its face indices address only exists afterwards.
  const faces = THREE.ShapeUtils.triangulateShape(contour, holeContours)
  const all = contour.concat(...holeContours)
  for (const face of faces) {
    const a = all[face[0]]
    const b = all[face[1]]
    const c = all[face[2]]
    if (a && b && c) emitTriangle(verts, a, b, c)
  }
}

function emitTriangle(verts: number[], a: Pt, b: Pt, c: Pt): void {
  const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
  if (!Number.isFinite(cross) || cross === 0) return
  if (cross > 0) verts.push(a.x, a.y, b.x, b.y, c.x, c.y)
  else verts.push(a.x, a.y, c.x, c.y, b.x, b.y)
}

/** A circle as a CCW ring. */
function circleRing(cx: number, cy: number, r: number, segments: number): Pt[] {
  const ring: Pt[] = []
  for (let i = 0; i < segments; i++) {
    const angle = (i / segments) * Math.PI * 2
    ring.push({ x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) })
  }
  return ring
}

/** A corner-rounded rectangle placed in world space: centered on `cx, cy` and
 *  turned by `rotation` radians. The shape every pad and every drill is. */
export function placedRoundRect(
  cx: number,
  cy: number,
  halfW: number,
  halfH: number,
  cornerR: number,
  rotation: number
): Pt[] {
  const outline = roundRectOutline(halfW, halfH, cornerR)
  const cos = Math.cos(rotation)
  const sin = Math.sin(rotation)
  return outline.map((p) => ({ x: cx + p.x * cos - p.y * sin, y: cy + p.x * sin + p.y * cos }))
}

/** Corner-rounded rectangle outline centered on the origin, CCW. */
export function roundRectOutline(halfW: number, halfH: number, cornerR: number): Pt[] {
  if (!(halfW > 0) || !(halfH > 0)) return []
  const r = Math.max(0, Math.min(cornerR, halfW, halfH))
  if (r <= 1e-9) {
    return [
      { x: -halfW, y: -halfH },
      { x: halfW, y: -halfH },
      { x: halfW, y: halfH },
      { x: -halfW, y: halfH }
    ]
  }
  const ix = halfW - r
  const iy = halfH - r
  const centers: Pt[] = [
    { x: ix, y: -iy },
    { x: ix, y: iy },
    { x: -ix, y: iy },
    { x: -ix, y: -iy }
  ]
  const points: Pt[] = []
  for (let corner = 0; corner < 4; corner++) {
    const start = (corner * Math.PI) / 2 - Math.PI / 2
    for (let i = 0; i <= CORNER_SEGMENTS; i++) {
      const angle = start + (i / CORNER_SEGMENTS) * (Math.PI / 2)
      points.push({
        x: centers[corner].x + r * Math.cos(angle),
        y: centers[corner].y + r * Math.sin(angle)
      })
    }
  }
  return points
}

/** Signed area of a closed ring; positive when the points wind CCW. */
export function signedArea(points: readonly Pt[]): number {
  let sum = 0
  for (let i = 0; i < points.length; i++) {
    const a = points[i]
    const b = points[(i + 1) % points.length]
    sum += a.x * b.y - b.x * a.y
  }
  return sum / 2
}

export { pointInPolygon } from '../../geometry/regionClips'
