// Parts follow KiCad's source, named below: Copyright The KiCad Developers, GPL-3.0-or-later.
import * as THREE from 'three'
import { OVERLAY_ORDER } from '../kicad/paintOrder'
import type { ScreenScaled } from './ViewportEngine'

/** One finding's marker: the spot its pin stands on, in engine world (mm, y up). */
export interface FindingMarker {
  key: string
  x: number
  y: number
  severity: 'error' | 'warning'
  /** The finding the drawer or a click last picked: drawn over every other. */
  selected?: boolean
}

/**
 * Sized as KiCad sizes its markers (`pcb_marker.cpp`, `sch_marker.cpp`): a
 * base unit in millimeters, scaled by 1/√zoom, where zoom 1 shows the design
 * at its real size on a 96 dpi screen. The pin is PIN_UNITS of it tall, so it
 * grows as the view zooms in, but slower than the design.
 */
export const MARKER_UNIT_MM = { board: 0.1625, schematic: 0.15 } as const
const REAL_SIZE_PX_PER_MM = 96 / 25.4
const PIN_UNITS = 13
/** The pin's on-screen height is kept within these, so it stays a target and never a blot. */
const MIN_PIXELS = 14
const MAX_PIXELS = 48

/**
 * A map pin in its own units: its point on the spot (the origin), its round
 * head above (y up), the sides tangent to the head. Convex, so the body is a
 * fan from the head's center.
 */
const HEAD_RADIUS = 4.5
const HEAD_Y = PIN_UNITS - HEAD_RADIUS
const ARC_STEPS = 20
const PIN_OUTLINE: ReadonlyArray<readonly [number, number]> = (() => {
  // Where the sides meet the head: cos α = r / d from the head's center.
  const a = Math.acos(HEAD_RADIUS / HEAD_Y)
  const from = -Math.PI / 2 + a
  const to = (3 * Math.PI) / 2 - a
  const arc = Array.from({ length: ARC_STEPS + 1 }, (_, i) => {
    const t = from + ((to - from) * i) / ARC_STEPS
    return [HEAD_RADIUS * Math.cos(t), HEAD_Y + HEAD_RADIUS * Math.sin(t)] as const
  })
  return [[0, 0] as const, ...arc]
})()
const PIN_FILL: ReadonlyArray<readonly [number, number]> = PIN_OUTLINE.flatMap((p, i) => {
  const q = PIN_OUTLINE[(i + 1) % PIN_OUTLINE.length]
  return [[0, HEAD_Y] as const, p, q]
})

const rect = (x0: number, y0: number, x1: number, y1: number): Array<readonly [number, number]> => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y0],
  [x1, y1],
  [x0, y1]
]
type Tone = 'fill' | 'glyph'
type Shape = { tone: Tone; points: ReadonlyArray<readonly [number, number]> }

/** `!`, its bar and dot, centered on x = 0 between `bottom` and `top`. */
const bang = (half: number, bottom: number, top: number): Array<readonly [number, number]> => {
  const dot = (top - bottom) * 0.2
  const gap = (top - bottom) * 0.14
  return [...rect(-half, bottom + dot + gap, half, top), ...rect(-half, bottom, half, bottom + dot)]
}

/**
 * The severity in the head, so it reads without its hue: an error's `!`, and
 * a warning's sign — a triangle with the `!` cut into it.
 */
const GLYPH: Record<FindingMarker['severity'], readonly Shape[]> = {
  error: [{ tone: 'glyph', points: bang(0.75, HEAD_Y - 2.7, HEAD_Y + 2.9) }],
  warning: [
    {
      tone: 'glyph',
      points: [
        [-3.1, HEAD_Y - 2.4],
        [3.1, HEAD_Y - 2.4],
        [0, HEAD_Y + 3.0]
      ]
    },
    { tone: 'fill', points: bang(0.42, HEAD_Y - 1.75, HEAD_Y + 1.35) }
  ]
}

/** The edge round each pin, px: a darker pin under it, as one with it, so a pin over another covers it whole. */
const EDGE_PX = 1.25

/** Drawn last, so on top: warnings, then errors, then the picked finding. */
const rank = (m: FindingMarker): number => (m.selected ? 2 : m.severity === 'error' ? 1 : 0)

/**
 * Every finding's marker on a canvas, at a size set by the zoom
 * (`ViewportEngine.registerScreenScaled`): a pin in its severity's color with
 * a contrasting edge, its glyph inside, over the document and its chrome.
 * Clicks are the viewport's: `hit` names the marker under a world point.
 */
export class FindingMarkers implements ScreenScaled {
  readonly object = new THREE.Group()
  private readonly mesh: THREE.Mesh
  // Transparent so they sort in the queue the ratsnest, labels and strokes
  // draw in: three.js draws every opaque object before any transparent one.
  private readonly material = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    depthTest: false,
    depthWrite: false
  })
  private markers: readonly FindingMarker[] = []
  private worldPerPixel = 1
  private unit = 1
  private readonly colors = {
    error: new THREE.Color('#ff3fb4'),
    warning: new THREE.Color('#ffb020'),
    edge: new THREE.Color('#0b0f0d')
  }
  /** Each glyph against its severity's fill in either theme: white on magenta, near-black on amber. */
  private readonly glyphColors = {
    error: new THREE.Color('#ffffff'),
    warning: new THREE.Color('#0b0f0d')
  }

  constructor(
    z: number,
    private readonly baseUnit: number
  ) {
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material)
    // Over the document and the selection chrome, under nothing but the cursor.
    this.mesh.renderOrder = OVERLAY_ORDER.findingMarkers
    this.mesh.frustumCulled = false
    this.object.add(this.mesh)
    this.object.position.z = z
  }

  setWorldPerPixel(worldPerPixel: number): void {
    this.worldPerPixel = worldPerPixel
    this.rebuild()
  }

  setColors(error: string, warning: string, edge: string): void {
    this.colors.error.set(error)
    this.colors.warning.set(warning)
    this.colors.edge.set(edge)
    this.rebuild()
  }

  setMarkers(markers: readonly FindingMarker[]): void {
    // Stable, so markers of one rank keep the findings' order.
    this.markers = [...markers].sort((a, b) => rank(a) - rank(b))
    this.rebuild()
  }

  /** The marker under a world point, the one drawn on top first; null where there is none. */
  hit(x: number, y: number): FindingMarker | null {
    const half = HEAD_RADIUS * this.unit
    const height = PIN_UNITS * this.unit
    for (let i = this.markers.length - 1; i >= 0; i--) {
      const m = this.markers[i]
      if (x >= m.x - half && x <= m.x + half && y >= m.y && y <= m.y + height) return m
    }
    return null
  }

  private rebuild(): void {
    const zoom = 1 / this.worldPerPixel / REAL_SIZE_PX_PER_MM
    const kicad = this.baseUnit / Math.sqrt(zoom)
    const min = (MIN_PIXELS * this.worldPerPixel) / PIN_UNITS
    const max = (MAX_PIXELS * this.worldPerPixel) / PIN_UNITS
    this.unit = Math.min(max, Math.max(min, kicad))
    const u = this.unit
    // The pin is a cone on a circle, so growing it about the head's center
    // offsets every side alike: by the edge, in units.
    const grow = 1 + (EDGE_PX * this.worldPerPixel) / u / HEAD_RADIUS
    const glyphs = this.markers.reduce(
      (n, m) => n + GLYPH[m.severity].reduce((k, shape) => k + shape.points.length, 0),
      0
    )
    const position = new Float32Array((this.markers.length * PIN_FILL.length * 2 + glyphs) * 3)
    const color = new Float32Array(position.length)
    let f = 0
    const put = (
      m: FindingMarker,
      points: ReadonlyArray<readonly [number, number]>,
      c: THREE.Color,
      scale = 1
    ): void => {
      for (const [px, py] of points) {
        const y = HEAD_Y + (py - HEAD_Y) * scale
        position.set([m.x + px * scale * u, m.y + y * u, 0], f)
        color.set([c.r, c.g, c.b], f)
        f += 3
      }
    }
    // Each marker whole, edge then body then glyph, before the next: one mesh
    // draws its triangles in order, so a later pin covers an earlier one.
    for (const m of this.markers) {
      const fill = this.colors[m.severity]
      put(m, PIN_FILL, this.colors.edge, grow)
      put(m, PIN_FILL, fill)
      for (const shape of GLYPH[m.severity])
        put(m, shape.points, shape.tone === 'glyph' ? this.glyphColors[m.severity] : fill)
    }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(position, 3))
    geometry.setAttribute('color', new THREE.BufferAttribute(color, 3))
    this.mesh.geometry.dispose()
    this.mesh.geometry = geometry
    this.object.visible = this.markers.length > 0
  }

  dispose(): void {
    this.mesh.geometry.dispose()
    this.material.dispose()
  }
}
