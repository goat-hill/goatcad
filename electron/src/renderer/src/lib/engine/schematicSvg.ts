/**
 * A schematic scene written out as SVG — the vector twin of `captureFramed`.
 *
 * No second renderer: this walks what `SchematicScene` already built for the
 * GPU and writes each piece as the SVG element that draws the same shape. The
 * primitive batch holds four analytic shapes (a capsule is a round-capped
 * line, a round-rect a `<rect>`, a ring a stroked `<circle>`, an arc a stroked
 * `<path>`), and KiCad's stroke font lands there too, so every line and every
 * glyph of default-font text comes through as vector. Polygon fills are meshes
 * whose position buffer is the outline in order, so each is one `<polygon>`.
 * Draw order is the scene's z, the same order the depth test gives the picture.
 *
 * Not drawn (counted in `skipped`, so a caller can say so): TrueType text,
 * which the scene draws as canvas sprites, and embedded bitmaps. Both could be
 * written as `<image>` later; neither is on a typical sheet.
 *
 * Coordinates stay in the scene's millimetres. The scene is y-up (KiCad's y is
 * negated on the way in), so the content sits in one `scale(1 -1)` group and
 * the viewBox is the frame with y turned back down — the picture reads the way
 * the editor shows it, and one SVG unit is one millimetre on the sheet.
 */
import * as THREE from 'three'
import type { PrimitiveBatch } from './PrimitiveBatch'

export interface SchematicSvgInput {
  primitives: PrimitiveBatch
  /** The fill meshes: polygons (position buffer = outline) and image planes. */
  fills: THREE.Mesh[]
  /** Typeface sprites on the sheet — counted, not drawn. */
  sprites: number
  /** Scene-space frame to show. */
  frame: THREE.Box3
  /** Page color; omitted for a transparent background. */
  background?: string
}

export interface SchematicSvg {
  svg: string
  /** The frame the viewBox shows, in scene millimetres (y-up). */
  frame: { minX: number; minY: number; maxX: number; maxY: number }
  skipped: { typefaceText: number; images: number }
}

/** The thinnest line written. The GPU holds strokes to a pixel on screen; a
 *  vector has no pixel, so a zero-width stroke would simply vanish. */
const MIN_STROKE_MM = 0.02

const num = (value: number): string => {
  const rounded = Math.round(value * 1000) / 1000
  return Object.is(rounded, -0) ? '0' : String(rounded)
}

const hex = (r: number, g: number, b: number): string =>
  `#${new THREE.Color(r, g, b).getHexString()}`

const alphaAttr = (alpha: number): string => (alpha < 0.999 ? ` opacity="${num(alpha)}"` : '')

export const schematicToSvg = (input: SchematicSvgInput): SchematicSvg => {
  /** A drawn element, or a line segment waiting to be merged with its neighbours. */
  type Item = {
    z: number
    order: number
    markup?: string
    line?: { style: string; x0: number; y0: number; x1: number; y1: number }
  }
  const items: Item[] = []
  let order = 0
  const push = (z: number, markup: string): void => {
    items.push({ z, order: order++, markup })
  }
  // A framed export carries only what reaches the frame: without this, the
  // four parts asked for arrive with the other two megabytes of the sheet.
  const { min: fmin, max: fmax } = input.frame
  const outside = (minX: number, minY: number, maxX: number, maxY: number): boolean =>
    maxX < fmin.x || minX > fmax.x || maxY < fmin.y || minY > fmax.y

  input.primitives.forEachInstance((shape, d0, d1, rgba) => {
    const color = hex(rgba[0], rgba[1], rgba[2])
    const opacity = alphaAttr(rgba[3])
    const z = d1[2]
    switch (shape) {
      case 'capsule': {
        const [x0, y0, x1, y1] = d0
        const width = Math.max(d1[0] * 2, MIN_STROKE_MM)
        const w = width / 2
        if (
          outside(
            Math.min(x0, x1) - w,
            Math.min(y0, y1) - w,
            Math.max(x0, x1) + w,
            Math.max(y0, y1) + w
          )
        )
          break
        if (x0 === x1 && y0 === y1) {
          push(
            z,
            `<circle cx="${num(x0)}" cy="${num(y0)}" r="${num(width / 2)}" fill="${color}"${opacity}/>`
          )
        } else {
          items.push({
            z,
            order: order++,
            line: {
              style: `stroke="${color}" stroke-width="${num(width)}"${opacity}`,
              x0,
              y0,
              x1,
              y1
            }
          })
        }
        break
      }
      case 'rrect': {
        const [cx, cy, halfW, halfH] = d0
        const [radius, rotation] = d1
        const reach = Math.hypot(halfW, halfH)
        if (outside(cx - reach, cy - reach, cx + reach, cy + reach)) break
        const turn = rotation
          ? ` transform="rotate(${num((rotation * 180) / Math.PI)} ${num(cx)} ${num(cy)})"`
          : ''
        const rx = radius > 0 ? ` rx="${num(radius)}"` : ''
        push(
          z,
          `<rect x="${num(cx - halfW)}" y="${num(cy - halfH)}" width="${num(halfW * 2)}" height="${num(halfH * 2)}"${rx}${turn} fill="${color}"${opacity}/>`
        )
        break
      }
      case 'ring': {
        const [cx, cy, radius, halfStroke] = d0
        const reach = radius + halfStroke
        if (outside(cx - reach, cy - reach, cx + reach, cy + reach)) break
        // A ring whose stroke reaches its center is a filled disc.
        if (halfStroke >= radius) {
          push(
            z,
            `<circle cx="${num(cx)}" cy="${num(cy)}" r="${num(radius + halfStroke)}" fill="${color}"${opacity}/>`
          )
        } else {
          push(
            z,
            `<circle cx="${num(cx)}" cy="${num(cy)}" r="${num(radius)}" fill="none" stroke="${color}" stroke-width="${num(Math.max(halfStroke * 2, MIN_STROKE_MM))}"${opacity}/>`
          )
        }
        break
      }
      case 'arc': {
        const [cx, cy, radius, halfStroke] = d0
        const reach = radius + halfStroke
        if (outside(cx - reach, cy - reach, cx + reach, cy + reach)) break
        const [bisector, aperture] = d1
        const a0 = bisector - aperture
        const a1 = bisector + aperture
        const x0 = cx + radius * Math.cos(a0)
        const y0 = cy + radius * Math.sin(a0)
        const x1 = cx + radius * Math.cos(a1)
        const y1 = cy + radius * Math.sin(a1)
        const large = aperture * 2 > Math.PI ? 1 : 0
        // Angles increase counter-clockwise in the scene's y-up space, which is
        // sweep-flag 1 in the (unflipped) coordinates the path is written in.
        push(
          z,
          `<path d="M${num(x0)} ${num(y0)}A${num(radius)} ${num(radius)} 0 ${large} 1 ${num(x1)} ${num(y1)}" fill="none" stroke="${color}" stroke-width="${num(Math.max(halfStroke * 2, MIN_STROKE_MM))}" stroke-linecap="round"${opacity}/>`
        )
        break
      }
    }
  })

  let images = 0
  for (const mesh of input.fills) {
    const material = mesh.material as THREE.MeshBasicMaterial
    if (!mesh.visible) continue
    if (material.map) {
      images++
      continue
    }
    const position = mesh.geometry.getAttribute('position')
    if (!position || position.count < 3) continue
    mesh.geometry.computeBoundingBox()
    const box = mesh.geometry.boundingBox
    if (
      box &&
      outside(
        box.min.x + mesh.position.x,
        box.min.y + mesh.position.y,
        box.max.x + mesh.position.x,
        box.max.y + mesh.position.y
      )
    )
      continue
    const points: string[] = []
    for (let i = 0; i < position.count; i++) {
      points.push(
        `${num(position.getX(i) + mesh.position.x)},${num(position.getY(i) + mesh.position.y)}`
      )
    }
    const color = material.color
    push(
      mesh.position.z,
      `<polygon points="${points.join(' ')}" fill="${hex(color.r, color.g, color.b)}"${alphaAttr(material.opacity)}/>`
    )
  }

  // Stable by z: equal depths keep the order they were built in.
  items.sort((a, b) => a.z - b.z || a.order - b.order)

  // Runs of line segments with one style become one <path>: stroke-font text
  // alone is thousands of segments, and a <line> each is most of the file. A
  // segment that starts where the last ended continues the subpath, so glyph
  // strokes and polylines join rather than restart.
  const emit = (sorted: Item[]): string => {
    const out: string[] = []
    let style: string | null = null
    let d = ''
    let endX = NaN
    let endY = NaN
    const flush = (): void => {
      if (style !== null)
        out.push(
          `<path d="${d}" fill="none" ${style} stroke-linecap="round" stroke-linejoin="round"/>`
        )
      style = null
      d = ''
    }
    for (const item of sorted) {
      if (!item.line) {
        flush()
        out.push(item.markup ?? '')
        continue
      }
      const { x0, y0, x1, y1 } = item.line
      if (item.line.style !== style) {
        flush()
        style = item.line.style
      }
      if (x0 === endX && y0 === endY) d += `L${num(x1)} ${num(y1)}`
      else d += `M${num(x0)} ${num(y0)}L${num(x1)} ${num(y1)}`
      endX = x1
      endY = y1
    }
    flush()
    return out.join('')
  }

  const { min, max } = input.frame
  const width = max.x - min.x
  const height = max.y - min.y
  const page = input.background
    ? `<rect x="${num(min.x)}" y="${num(-max.y)}" width="${num(width)}" height="${num(height)}" fill="${input.background}"/>`
    : ''
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${num(min.x)} ${num(-max.y)} ${num(width)} ${num(height)}" width="${num(width)}mm" height="${num(height)}mm">` +
    page +
    `<g transform="scale(1 -1)">${emit(items)}</g>` +
    `</svg>`

  return {
    svg,
    frame: { minX: min.x, minY: min.y, maxX: max.x, maxY: max.y },
    skipped: { typefaceText: input.sprites, images }
  }
}
