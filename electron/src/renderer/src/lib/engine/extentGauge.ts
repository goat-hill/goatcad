import * as THREE from 'three'
import { themeColor } from '../theme'

/**
 * Extent gauge: the subtle dimension graphic surrounding a 3D model. A faint
 * bounding-box wireframe plus three ruler rails (X/Y/Z) with millimeter ticks
 * and a per-axis overall dimension label, drawn in dimension-drawing style at
 * the corner facing the default isometric camera. Built once per model from
 * its bounds; generic over any content, so the future PCB 3D view can reuse it.
 */

/** Muted axis colors, read from the theme when a gauge is built. */
const axisColor = (axis: Axis): string =>
  themeColor(`--vscode-gauge-${axis}`, { x: '#cf6672', y: '#7fb07a', z: '#6a92cf' }[axis])

type Axis = 'x' | 'y' | 'z'

/** A 1/2/5 · 10ⁿ step giving roughly 4–8 tick divisions over the span. */
export function niceTickStep(span: number): number {
  if (!(span > 0) || !Number.isFinite(span)) return 1
  const target = span / 6
  const pow = Math.pow(10, Math.floor(Math.log10(target)))
  const frac = target / pow
  const mult = frac < 1.5 ? 1 : frac < 3.5 ? 2 : frac < 7.5 ? 5 : 10
  return pow * mult
}

/** Millimeter value for display: at most two decimals, no trailing zeros. */
export function formatMm(value: number): string {
  return `${Math.round(value * 100) / 100}`
}

const makeLabelSprite = (text: string, color: string, maxDim: number): THREE.Sprite => {
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 64
  const ctx = canvas.getContext('2d')!
  ctx.font = '600 34px system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  // A halo in the deepest ground keeps the label readable over model faces.
  ctx.globalAlpha = 0.9
  ctx.strokeStyle = themeColor('--vscode-source-bg', '#0b0f0d')
  ctx.lineWidth = 8
  ctx.strokeText(text, 128, 32)
  ctx.globalAlpha = 1
  ctx.fillStyle = color
  ctx.fillText(text, 128, 32)

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: texture, transparent: true, opacity: 0.9 })
  )
  sprite.scale.set(maxDim * 0.3, maxDim * 0.075, 1)
  return sprite
}

interface RailSpec {
  axis: Axis
  /** Rail start corner. */
  origin: THREE.Vector3
  /** Unit vector along the measured axis. */
  along: THREE.Vector3
  /** Unit vector pointing away from the box (tick direction). */
  outward: THREE.Vector3
  span: number
}

const buildRail = (spec: RailSpec, tickLength: number): THREE.LineSegments => {
  const points: THREE.Vector3[] = []
  const end = spec.origin.clone().addScaledVector(spec.along, spec.span)
  points.push(spec.origin.clone(), end)

  // End caps, dimension-drawing style: slightly longer than the ticks.
  for (const at of [spec.origin, end]) {
    points.push(
      at.clone().addScaledVector(spec.outward, -tickLength * 0.2),
      at.clone().addScaledVector(spec.outward, tickLength * 1.4)
    )
  }

  const step = niceTickStep(spec.span)
  for (let d = step; d < spec.span - step * 0.25; d += step) {
    const at = spec.origin.clone().addScaledVector(spec.along, d)
    points.push(at.clone(), at.clone().addScaledVector(spec.outward, tickLength))
  }

  const geometry = new THREE.BufferGeometry().setFromPoints(points)
  const material = new THREE.LineBasicMaterial({
    color: new THREE.Color(axisColor(spec.axis)),
    transparent: true,
    opacity: 0.6,
    depthWrite: false
  })
  return new THREE.LineSegments(geometry, material)
}

/**
 * Builds the gauge group for the given bounds. Rails meet near the
 * (max x, min y, min z) corner, all three visible from the default iso view.
 */
export function buildExtentGauge(bounds: THREE.Box3): THREE.Group {
  const group = new THREE.Group()
  group.name = 'extent-gauge'
  if (bounds.isEmpty()) return group

  const size = bounds.getSize(new THREE.Vector3())
  const maxDim = Math.max(size.x, size.y, size.z, 1e-6)
  const pad = maxDim * 0.07
  const tickLength = pad * 0.45
  const { min, max } = bounds

  const boxHelper = new THREE.Box3Helper(
    bounds,
    new THREE.Color(themeColor('--vscode-gauge-box', '#54685e'))
  )
  const boxMaterial = boxHelper.material as THREE.LineBasicMaterial
  boxMaterial.transparent = true
  boxMaterial.opacity = 0.3
  boxMaterial.depthWrite = false
  group.add(boxHelper)

  const rails: RailSpec[] = [
    {
      axis: 'x',
      origin: new THREE.Vector3(min.x, min.y - pad, min.z),
      along: new THREE.Vector3(1, 0, 0),
      outward: new THREE.Vector3(0, -1, 0),
      span: size.x
    },
    {
      axis: 'y',
      origin: new THREE.Vector3(max.x + pad, min.y, min.z),
      along: new THREE.Vector3(0, 1, 0),
      outward: new THREE.Vector3(1, 0, 0),
      span: size.y
    },
    {
      axis: 'z',
      origin: new THREE.Vector3(max.x + pad, min.y - pad, min.z),
      along: new THREE.Vector3(0, 0, 1),
      outward: new THREE.Vector3(1, -1, 0).normalize(),
      span: size.z
    }
  ]

  for (const spec of rails) {
    if (!(spec.span > 1e-9)) continue
    group.add(buildRail(spec, tickLength))
    const label = makeLabelSprite(
      `${spec.axis.toUpperCase()} ${formatMm(spec.span)} mm`,
      axisColor(spec.axis),
      maxDim
    )
    label.position
      .copy(spec.origin)
      .addScaledVector(spec.along, spec.span / 2)
      .addScaledVector(spec.outward, pad * 1.6)
    group.add(label)
  }

  return group
}

/** Frees the gauge's GPU resources (geometries, materials, label textures). */
export function disposeExtentGauge(group: THREE.Group): void {
  group.traverse((obj) => {
    if (obj instanceof THREE.LineSegments || obj instanceof THREE.Line) {
      obj.geometry.dispose()
      ;(obj.material as THREE.Material).dispose()
    } else if (obj instanceof THREE.Sprite) {
      obj.material.map?.dispose()
      obj.material.dispose()
    }
  })
}
